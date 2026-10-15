import type { Storage } from '../storage/interface';
import type { TVBoxLiveChannel, TVBoxLiveGroup } from './types';
import {
  KV_CHANNEL_MERGED_TREE,
  KV_CHANNEL_RUNTIME_TREE,
  KV_CHANNEL_CANDIDATE_URLS,
  KV_CHANNEL_SPEED_MAP,
  KV_LIVE_MERGED_TXT,
  KV_LIVE_MERGED_TXT_VERSION,
  KV_LIVE_RUNTIME_TXT_VERSION,
  KV_LIVE_RUNTIME_TXT,
  KV_LIVE_OUTPUT_FINGERPRINT,
  KV_LIVE_MERGE_MODE,
  KV_LIVE_DISABLED,
  KV_IGNORE_AGGREGATED_LIVES,
  KV_LIVE_TEXT_PREFIX,
} from './config';
import { loadLiveDistribution, toLiveDistributionPolicy } from './live-distribution-store';
import {
  isLiveProxyEntryDistributable,
  listAllLiveProxyEntries,
  liveProxyEntryLabel,
  parseLiveProxyManifest,
  type LiveProxyManifestEntry,
} from './live-source';
import { selectLiveDistribution, type LiveDistributionPolicy } from './live-quality';
import {
  AGGREGATED_MAX_URLS_PER_CHANNEL,
  applyChannelSpeedToGroups,
  bareLiveSourceUrl,
  liveUrlSourceLabel,
  formatAggregatedLiveGroupsAsTxt,
  normalizeSourceLabelKey,
  parseLiveCandidatePool,
  parseLiveGroupsFromTxt,
} from './live-merger';
import { loadSpeedMap } from './channel-probe';

/**
 * 直播 TXT 展示格式版本。
 * 分类、目录分页、频道名归一等纯展示逻辑发生变化时必须递增，
 * 否则持久化指纹不变，线上会继续命中旧 runtime TXT。
 */
const LIVE_OUTPUT_FORMAT_VERSION = 3;

export interface RebuildLiveOutputOptions {
  reason?: string;
  policy?: LiveDistributionPolicy;
}

export interface LiveOutputSnapshot {
  groups: TVBoxLiveGroup[];
  txt: string;
  version: string;
  fingerprint: string;
  selectedKeys: string[];
  selectedLabels: string[];
  changed: boolean;
}

export interface SelectedLiveGroups {
  groups: TVBoxLiveGroup[];
  selected: LiveProxyManifestEntry[];
  labels: string[];
}

function parseGroups(raw: string | null): TVBoxLiveGroup[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as TVBoxLiveGroup[] : [];
  } catch {
    return [];
  }
}

/**
 * 输出重建使用的候选结构恢复顺序：
 * 本机完整合并树 -> 持久化结构化候选快照 -> 本机运行时树 -> 运行时 TXT。
 *
 * Render 重启后 `channel_merged_tree` / `channel_runtime_tree` 属于本地缓存，
 * 因此必须优先从 durable 的 `channel_candidate_urls` 恢复完整频道树；这样策略
 * 从小集合扩展到全量时不会丢源。旧版裸 URL 数组不含频道结构，仍禁止用它重建。
 */
async function loadCandidateGroups(storage: Storage): Promise<TVBoxLiveGroup[]> {
  const merged = parseGroups(await storage.get(KV_CHANNEL_MERGED_TREE));
  if (merged.length > 0) return merged;

  const persisted = parseLiveCandidatePool(await storage.get(KV_CHANNEL_CANDIDATE_URLS));
  if (persisted.source === 'structured') {
    // 进程内合并树已丢失时，持久快照比运行时前沿更完整：后者可能只是此前
    // 少量下发策略派生出的子集，若先采用它，后续切换全量仍会永久漏源。
    return persisted.groups;
  }

  const runtime = parseGroups(await storage.get(KV_CHANNEL_RUNTIME_TREE));
  if (runtime.length > 0) return runtime;

  const runtimeTxt = await storage.get(KV_LIVE_MERGED_TXT);
  return runtimeTxt ? parseLiveGroupsFromTxt(runtimeTxt) : [];
}

function stablePolicyKey(policy: LiveDistributionPolicy): string {
  const pinned = [...(policy.pinnedKeys || [])];
  const blocked = [...(policy.blockedKeys || [])];
  const buckets = policy.bucketLimits
    ? Object.fromEntries(Object.entries(policy.bucketLimits).sort(([a], [b]) => a.localeCompare(b)))
    : {};
  return JSON.stringify({
    selectionMode: policy.selectionMode,
    maxSources: policy.maxSources,
    bucketLimits: buckets,
    pinnedKeys: pinned,
    blockedKeys: blocked,
  });
}

export async function computeLiveOutputFingerprint(
  storage: Storage,
  policy?: LiveDistributionPolicy,
): Promise<string> {
  const current = policy || toLiveDistributionPolicy(await loadLiveDistribution(storage));
  return fingerprint(storage, current);
}

async function fingerprint(storage: Storage, policy: LiveDistributionPolicy): Promise<string> {
  const [
    manifestRaw,
    mergedTreeRaw,
    candidatePoolRaw,
    speedRaw,
    modeRaw,
    disabledRaw,
    ignoreAggregatedRaw,
  ] = await Promise.all([
    storage.get('live_proxy_manifest'),
    storage.get(KV_CHANNEL_MERGED_TREE),
    storage.get(KV_CHANNEL_CANDIDATE_URLS),
    storage.get(KV_CHANNEL_SPEED_MAP),
    storage.get(KV_LIVE_MERGE_MODE),
    storage.get(KV_LIVE_DISABLED),
    storage.get(KV_IGNORE_AGGREGATED_LIVES),
  ]);
  const mode = modeRaw || 'separated';
  // 指纹必须覆盖一切会改变最终 runtime TXT 的输入：
  // 候选树、质量清单、测速表、模式、开关与策略。
  const text = [
    mode,
    String(LIVE_OUTPUT_FORMAT_VERSION),
    disabledRaw || 'false',
    ignoreAggregatedRaw || 'false',
    stablePolicyKey(policy),
    parseLiveProxyManifest(manifestRaw)?.signature || manifestRaw || '',
    [mergedTreeRaw || '', candidatePoolRaw || ''].join('\n'),
    speedRaw || '',
  ].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function filterAndOrderGroupsBySource(
  groups: readonly TVBoxLiveGroup[],
  rankByBareUrl: ReadonlyMap<string, number>,
  selectedLabels: ReadonlySet<string>,
): TVBoxLiveGroup[] {
  const output: TVBoxLiveGroup[] = [];
  for (const group of groups) {
    const channels: TVBoxLiveChannel[] = [];
    for (const channel of group.channels || []) {
      const seen = new Set<string>();
      const urls = [...(channel.urls || [])]
        .filter((rawUrl) => {
          const bare = bareLiveSourceUrl(rawUrl);
          const label = normalizeSourceLabelKey(liveUrlSourceLabel(rawUrl));
          const matched = (bare && rankByBareUrl.has(bare)) || (label !== '' && selectedLabels.has(label));
          if (!matched || !bare || seen.has(bare)) return false;
          seen.add(bare);
          return true;
        })
        .sort((a, b) => {
          const bareA = bareLiveSourceUrl(a);
          const bareB = bareLiveSourceUrl(b);
          const rankA = rankByBareUrl.get(bareA);
          const rankB = rankByBareUrl.get(bareB);
          if (rankA != null || rankB != null) {
            return (rankA ?? Number.MAX_SAFE_INTEGER) - (rankB ?? Number.MAX_SAFE_INTEGER);
          }
          return selectedLabelRank(liveUrlSourceLabel(a), selectedLabels) - selectedLabelRank(liveUrlSourceLabel(b), selectedLabels);
        });
      if (urls.length > 0) channels.push({ ...channel, urls });
    }
    if (channels.length > 0) output.push({ ...group, channels });
  }
  return output;
}

function selectedLabelRank(label: string, selectedLabels: ReadonlySet<string>): number {
  const key = normalizeSourceLabelKey(label);
  if (key === '' || !selectedLabels.has(key)) return Number.MAX_SAFE_INTEGER;
  // Set 的插入顺序即选中源的相对顺序，转为稳定索引以保证排序确定。
  let index = 0;
  for (const candidate of selectedLabels) {
    if (candidate === key) return index;
    index++;
  }
  return Number.MAX_SAFE_INTEGER;
}

/**
 * 按当前下发策略选择直播源，并映射回候选频道树。
 *
 * 兼容两种历史数据形态：
 * - 合并树带 `$源标签`：沿用标签精确匹配；
 * - Cloudflare 预构建文本是裸 URL：读取选中单源文本建立 URL 索引，再过滤候选树。
 *
 * 回退只使用“已选中源自己的文本”，绝不会因为一次映射失配而放开全量候选树。
 */
export async function selectLiveGroupsForPolicy(
  storage: Storage,
  candidateGroups: TVBoxLiveGroup[],
  policy: LiveDistributionPolicy,
): Promise<SelectedLiveGroups> {
  const candidates = (await listAllLiveProxyEntries(storage)).filter(isLiveProxyEntryDistributable);
  const selected = selectLiveDistribution(candidates, policy);
  const labels = selected
    .map((entry) => liveProxyEntryLabel(entry, candidateGroups))
    .filter((label): label is string => Boolean(label));
  const selectedLabels = new Set(
    labels.map((label) => normalizeSourceLabelKey(label)).filter(Boolean),
  );

  // CF 的 live_txt:<key> 已是单源、可下发的裸 URL 文本。按选中质量顺序建立
  // URL -> rank；候选树同时存在带标签与裸 URL 两种线路时，两类证据取并集，
  // 避免标签分支提前返回而漏掉已选中的裸 URL 源。
  const rankByBareUrl = new Map<string, number>();
  const selectedSourceGroups: TVBoxLiveGroup[] = [];
  for (const [rank, entry] of selected.entries()) {
    const text = await storage.get(`${KV_LIVE_TEXT_PREFIX}${entry.key}`);
    if (!text || !text.includes('#genre#')) continue;
    const parsed = parseLiveGroupsFromTxt(text);
    if (parsed.length === 0) continue;
    selectedSourceGroups.push(...parsed);
    for (const group of parsed) {
      for (const channel of group.channels || []) {
        for (const rawUrl of channel.urls || []) {
          const bare = bareLiveSourceUrl(rawUrl);
          if (!bare) continue;
          const existing = rankByBareUrl.get(bare);
          if (existing == null || rank < existing) rankByBareUrl.set(bare, rank);
        }
      }
    }
  }

  if (candidateGroups.length > 0 && (rankByBareUrl.size > 0 || selectedLabels.size > 0)) {
    const filtered = filterAndOrderGroupsBySource(candidateGroups, rankByBareUrl, selectedLabels);
    if (filtered.length > 0) return { groups: filtered, selected, labels };
  }

  // 候选树缺失或与单源文本短暂不一致时，直接用已选中源的文本恢复。
  // 这条路径同样只包含 selected 中的源，不会把未选中的候选源带出去。
  if (selectedSourceGroups.length > 0) {
    return {
      groups: filterAndOrderGroupsBySource(selectedSourceGroups, rankByBareUrl, selectedLabels),
      selected,
      labels,
    };
  }

  return { groups: [], selected, labels };
}

async function buildSnapshot(
  storage: Storage,
  policy: LiveDistributionPolicy,
): Promise<LiveOutputSnapshot> {
  const candidateGroups = await loadCandidateGroups(storage);
  const selection = await selectLiveGroupsForPolicy(storage, candidateGroups, policy);
  const selected = selection.selected;
  const labels = selection.labels;
  const liveMergeMode = (await storage.get(KV_LIVE_MERGE_MODE)) || 'separated';
  const maxUrlsPerChannel = liveMergeMode === 'merged' ? AGGREGATED_MAX_URLS_PER_CHANNEL : 6;
  const speedMap = await loadSpeedMap(storage);
  const runtimeGroups = selection.groups.length > 0
    ? applyChannelSpeedToGroups(selection.groups, speedMap, undefined, maxUrlsPerChannel)
    : [];
  const txt = runtimeGroups.length > 0 ? formatAggregatedLiveGroupsAsTxt(runtimeGroups) : '';

  // 选中了源却无法生成任何频道，说明候选树映射或正文恢复失败。此时必须
  // 保留上一份有效缓存，不能把空结果和空指纹写回去。
  if (selected.length > 0 && runtimeGroups.length === 0) {
    throw new Error('Live output rebuild produced no groups for a non-empty selection');
  }
  if (runtimeGroups.length > 0 && (!txt.trim() || !txt.includes('#genre#'))) {
    throw new Error('Live output rebuild produced invalid TXT');
  }

  const fp = await fingerprint(storage, policy);
  const version = `${liveMergeMode}:${fp}`;

  const previousTree = await storage.get(KV_CHANNEL_RUNTIME_TREE);
  const previousTxt = await storage.get(KV_LIVE_MERGED_TXT);
  const previousRuntimeTxt = await storage.get(KV_LIVE_RUNTIME_TXT);
  const previousFingerprint = await storage.get(KV_LIVE_OUTPUT_FINGERPRINT);
  const changed = previousFingerprint !== fp || previousTree !== JSON.stringify(runtimeGroups) || previousTxt !== txt || previousRuntimeTxt !== txt;

  if (changed) {
    await Promise.all([
      storage.put(KV_CHANNEL_RUNTIME_TREE, JSON.stringify(runtimeGroups)),
      storage.put(KV_LIVE_MERGED_TXT, txt),
      storage.put(KV_LIVE_MERGED_TXT_VERSION, version),
      storage.put(KV_LIVE_RUNTIME_TXT, txt),
      storage.put(KV_LIVE_RUNTIME_TXT_VERSION, version),
      storage.put(KV_LIVE_OUTPUT_FINGERPRINT, fp),
    ]);
  }

  return {
    groups: runtimeGroups,
    txt,
    version,
    fingerprint: fp,
    selectedKeys: selected.map((entry) => entry.key),
    selectedLabels: labels,
    changed,
  };
}

/**
 * 统一重建直播运行时输出。
 *
 * 完整候选树 -> 质量清单/下发策略 -> 标签或裸 URL 映射 -> 频道测速 -> runtime tree/TXT。
 * 任何会改变下发集合的入口都必须调用本函数，禁止直接写 runtime 输出。
 */
export async function rebuildLiveOutput(
  storage: Storage,
  options: RebuildLiveOutputOptions = {},
): Promise<LiveOutputSnapshot> {
  const config = await loadLiveDistribution(storage);
  const policy = options.policy || toLiveDistributionPolicy(config);
  return buildSnapshot(storage, policy);
}

export async function loadLiveOutputSnapshot(
  storage: Storage,
  policy?: LiveDistributionPolicy,
): Promise<LiveOutputSnapshot> {
  return rebuildLiveOutput(storage, { policy });
}
