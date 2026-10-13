import type { Storage } from '../storage/interface';
import type { TVBoxLiveGroup } from './types';
import {
  KV_CHANNEL_MERGED_TREE,
  KV_CHANNEL_RUNTIME_TREE,
  KV_CHANNEL_SPEED_MAP,
  KV_LIVE_MERGED_TXT,
  KV_LIVE_MERGED_TXT_VERSION,
  KV_LIVE_RUNTIME_TXT_VERSION,
  KV_LIVE_OUTPUT_FINGERPRINT,
  KV_LIVE_MERGE_MODE,
  KV_LIVE_DISABLED,
  KV_IGNORE_AGGREGATED_LIVES,
} from './config';
import { loadLiveDistribution, toLiveDistributionPolicy } from './live-distribution-store';
import { listAllLiveProxyEntries, liveProxyEntryLabel } from './live-source';
import { selectLiveDistribution, type LiveDistributionPolicy } from './live-quality';
import {
  AGGREGATED_MAX_URLS_PER_CHANNEL,
  applyChannelSpeedToGroups,
  formatAggregatedLiveGroupsAsTxt,
  normalizeSourceLabelKey,
  filterGroupsBySourceLabels,
  reorderGroupsBySourcePriority,
} from './live-merger';
import { loadSpeedMap } from './channel-probe';

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

function parseGroups(raw: string | null): TVBoxLiveGroup[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as TVBoxLiveGroup[] : [];
  } catch {
    return [];
  }
}

async function loadCandidateGroups(storage: Storage): Promise<TVBoxLiveGroup[]> {
  return parseGroups(await storage.get(KV_CHANNEL_MERGED_TREE));
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

async function fingerprint(storage: Storage, policy: LiveDistributionPolicy): Promise<string> {
  const [
    manifestRaw,
    candidateRaw,
    speedRaw,
    modeRaw,
    disabledRaw,
    ignoreAggregatedRaw,
  ] = await Promise.all([
    storage.get('live_proxy_manifest'),
    storage.get(KV_CHANNEL_MERGED_TREE),
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
    disabledRaw || 'false',
    ignoreAggregatedRaw || 'false',
    stablePolicyKey(policy),
    manifestRaw || '',
    candidateRaw || '',
    speedRaw || '',
  ].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function buildSnapshot(
  storage: Storage,
  policy: LiveDistributionPolicy,
): Promise<LiveOutputSnapshot> {
  const candidates = await listAllLiveProxyEntries(storage);
  const selected = selectLiveDistribution(candidates, policy);
  const candidateGroups = await loadCandidateGroups(storage);
  const selectedLabels = new Set<string>();
  for (const entry of selected) {
    const label = liveProxyEntryLabel(entry, candidateGroups);
    if (!label) continue;
    selectedLabels.add(normalizeSourceLabelKey(label));
  }
  const labels = selected
    .map((entry) => liveProxyEntryLabel(entry, candidateGroups))
    .filter(Boolean);
  const groups = selectedLabels.size > 0
    ? reorderGroupsBySourcePriority(
        filterGroupsBySourceLabels(candidateGroups, selectedLabels, false),
        labels,
      )
    : [];
  const liveMergeMode = (await storage.get(KV_LIVE_MERGE_MODE)) || 'separated';
  const maxUrlsPerChannel = liveMergeMode === 'merged' ? AGGREGATED_MAX_URLS_PER_CHANNEL : 6;
  const speedMap = await loadSpeedMap(storage);
  const runtimeGroups = groups.length > 0
    ? applyChannelSpeedToGroups(groups, speedMap, undefined, maxUrlsPerChannel)
    : [];
  const txt = runtimeGroups.length > 0 ? formatAggregatedLiveGroupsAsTxt(runtimeGroups) : '';
  const fp = await fingerprint(storage, policy);
  const version = fp;

  const previousTree = await storage.get(KV_CHANNEL_RUNTIME_TREE);
  const previousTxt = await storage.get(KV_LIVE_MERGED_TXT);
  const previousFingerprint = await storage.get(KV_LIVE_OUTPUT_FINGERPRINT);
  const changed = previousFingerprint !== fp || previousTree !== JSON.stringify(runtimeGroups) || previousTxt !== txt;

  if (changed) {
    await Promise.all([
      storage.put(KV_CHANNEL_RUNTIME_TREE, JSON.stringify(runtimeGroups)),
      storage.put(KV_LIVE_MERGED_TXT, txt),
      storage.put(KV_LIVE_MERGED_TXT_VERSION, version),
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
 * 完整候选树 -> 质量清单/下发策略 -> 唯一标签过滤 -> 频道测速 -> runtime tree/TXT。
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
