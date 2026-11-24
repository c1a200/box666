import type { Storage } from '../storage/interface';
import type { TVBoxLiveChannel, TVBoxLiveGroup } from './types';
import {
  KV_CHANNEL_MERGED_TREE,
  KV_CHANNEL_RUNTIME_TREE,
  KV_CHANNEL_CANDIDATE_URLS,
  KV_CHANNEL_SPEED_MAP,
  KV_CHANNEL_QUALITY_SNAPSHOT,
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
import { normalizeLiveDistributionPolicy, selectLiveDistribution, type LiveDistributionPolicy } from './live-quality';
import {
  applyChannelSpeedToGroups,
  bareLiveSourceUrl,
  liveUrlSourceLabel,
  mergeAggregatedLiveGroups,
  mergeLiveCandidateTreeSources,
  formatAggregatedLiveGroupsAsTxt,
  normalizeSourceLabelKey,
  parseLiveCandidatePool,
  parseLiveGroupsFromTxt,
} from './live-merger';
import { loadPublishedSpeedMap } from './live-speed-store';

/**
 * 直播 TXT 展示与下发排序版本。
 * 分类、目录分页、频道名归一、验真/后备选择策略等会改变最终 TXT 的
 * 逻辑发生变化时必须递增，否则持久化指纹不变，线上会继续命中旧 runtime TXT。
 */
const LIVE_OUTPUT_FORMAT_VERSION = 16;

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
 * 输出重建必须合并所有带频道结构的候选来源，不能让任一局部树遮蔽更完整的池。
 *
 * `channel_merged_tree` 可能只是当前分片；`channel_candidate_urls` 是完整结构化
 * 快照；运行时树/TXT 则可能保留上一轮可下发线路。旧版裸 URL 数组不含频道结构，
 * 仅用于后台补测，禁止在正式输出中生成“候选恢复”频道。
 */
async function loadCandidateGroups(storage: Storage): Promise<TVBoxLiveGroup[]> {
  const [mergedRaw, persistedRaw, runtimeRaw, runtimeTxt] = await Promise.all([
    storage.get(KV_CHANNEL_MERGED_TREE),
    storage.get(KV_CHANNEL_CANDIDATE_URLS),
    storage.get(KV_CHANNEL_RUNTIME_TREE),
    storage.get(KV_LIVE_MERGED_TXT),
  ]);
  const persisted = parseLiveCandidatePool(persistedRaw);
  return mergeLiveCandidateTreeSources([
    parseGroups(mergedRaw),
    persisted.source === 'structured' ? persisted.groups : [],
    parseGroups(runtimeRaw),
    runtimeTxt ? parseLiveGroupsFromTxt(runtimeTxt) : [],
  ]);
}

function stablePolicyKey(policy: LiveDistributionPolicy): string {
  const normalized = normalizeLiveDistributionPolicy(policy);
  const pinned = [...(normalized.pinnedKeys || [])];
  const categoryPinned = [...(normalized.categoryPinnedKeys || [])];
  const blocked = [...(normalized.blockedKeys || [])];
  const buckets = normalized.bucketLimits
    ? Object.fromEntries(Object.entries(normalized.bucketLimits).sort(([a], [b]) => a.localeCompare(b)))
    : {};
  return JSON.stringify({
    selectionMode: normalized.selectionMode,
    maxSources: normalized.maxSources,
    maxUrlsPerChannel: normalized.maxUrlsPerChannel,
    bucketLimits: buckets,
    pinnedKeys: pinned,
    categoryPinnedKeys: categoryPinned,
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
    snapshotRaw,
    legacySpeedRaw,
    modeRaw,
    disabledRaw,
    ignoreAggregatedRaw,
  ] = await Promise.all([
    storage.get('live_proxy_manifest'),
    storage.get(KV_CHANNEL_MERGED_TREE),
    storage.get(KV_CHANNEL_CANDIDATE_URLS),
    storage.get(KV_CHANNEL_QUALITY_SNAPSHOT),
    storage.get(KV_CHANNEL_SPEED_MAP),
    storage.get(KV_LIVE_MERGE_MODE),
    storage.get(KV_LIVE_DISABLED),
    storage.get(KV_IGNORE_AGGREGATED_LIVES),
  ]);
  const mode = modeRaw || 'separated';
  // During a full evaluation the working cache changes repeatedly, while the
  // published snapshot remains stable. Fingerprints must follow only the latter.
  const speedRaw = snapshotRaw || legacySpeedRaw || '';
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
    speedRaw,
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
    // 候选树可能是聚合过程中的局部快照：同一源可能在树里只有部分频道，
    // 而 live_txt:<key> 已包含该源完整正文。必须先合并两种证据再过滤，
    // 否则候选树只要命中一条线路就会提前返回，静默丢掉其余频道。
    const mappingGroups = mergeLiveCandidateTreeSources([
      candidateGroups,
      selectedSourceGroups,
    ]);
    const filtered = filterAndOrderGroupsBySource(mappingGroups, rankByBareUrl, selectedLabels);
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
  const normalizedPolicy = normalizeLiveDistributionPolicy(policy);
  const candidateGroups = await loadCandidateGroups(storage);
  const selection = await selectLiveGroupsForPolicy(storage, candidateGroups, normalizedPolicy);
  const selected = selection.selected;
  const labels = selection.labels;
  const liveMergeMode = (await storage.get(KV_LIVE_MERGE_MODE)) || 'separated';
  const channelLimit = normalizedPolicy.maxUrlsPerChannel;
  // 两种模式都必须先跨分组归一频道名，再在完整候选池上测速择优，
  // 最后才执行每频道限额。否则同名频道会各自截断，既不是全局最优，
  // 也会让分离模式继续受历史固定 6 条上限影响。
  const canonicalGroups = mergeAggregatedLiveGroups(selection.groups);
  const speedMap = await loadPublishedSpeedMap(storage);
  const runtimeGroups = canonicalGroups.length > 0
    ? applyChannelSpeedToGroups(
      canonicalGroups,
      speedMap,
      undefined,
      channelLimit,
      {
        requirePlaybackVerification: true,
      },
    )
    : [];
  const txt = runtimeGroups.length > 0
    ? formatAggregatedLiveGroupsAsTxt(runtimeGroups, channelLimit)
    : '';

  // 选中了源却无法生成任何频道，说明候选树映射或正文恢复失败。此时必须
  // 保留上一份有效缓存，不能把空结果和空指纹写回去。
  if (selected.length > 0 && canonicalGroups.length === 0) {
    throw new Error('Live output rebuild could not map a non-empty selection to candidate groups');
  }
  if (runtimeGroups.length > 0 && (!txt.trim() || !txt.includes('#genre#'))) {
    throw new Error('Live output rebuild produced invalid TXT');
  }

  const fp = await fingerprint(storage, normalizedPolicy);
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
