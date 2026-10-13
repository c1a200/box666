import type { LiveDistributionConfig } from './types';
import type { Storage } from '../storage/interface';
import { KV_LIVE_DISTRIBUTION } from './config';
import {
  LIVE_CATEGORIES,
  normalizeLiveDistributionPolicy,
  type LiveCategory,
  type LiveDistributionPolicy,
} from './live-quality';

export const DEFAULT_LIVE_DISTRIBUTION: LiveDistributionConfig = {
  selectionMode: 'simple',
  maxSources: -1,
  pinnedKeys: [],
  blockedKeys: [],
  attachToRoot: true,
  attachToAuth: true,
};

function parseThreeState(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return fallback;
  if (number === -1 || number >= 0) return number;
  return fallback;
}

export function normalizeLiveDistributionConfig(raw: unknown): LiveDistributionConfig {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const policy = normalizeLiveDistributionPolicy(source);
  const bucketLimits: Partial<Record<LiveCategory, number>> = {};
  if (source.bucketLimits && typeof source.bucketLimits === 'object' && !Array.isArray(source.bucketLimits)) {
    const rawBuckets = source.bucketLimits as Record<string, unknown>;
    for (const category of LIVE_CATEGORIES) {
      if (!Object.prototype.hasOwnProperty.call(rawBuckets, category)) continue;
      bucketLimits[category] = parseThreeState(rawBuckets[category], -1);
    }
  }
  return {
    selectionMode: policy.selectionMode,
    maxSources: policy.maxSources,
    ...(Object.keys(bucketLimits).length > 0 ? { bucketLimits } : {}),
    pinnedKeys: [...(policy.pinnedKeys || [])],
    blockedKeys: [...(policy.blockedKeys || [])],
    attachToRoot: source.attachToRoot !== false,
    attachToAuth: source.attachToAuth !== false,
    ...(typeof source.updatedAt === 'string' && source.updatedAt ? { updatedAt: source.updatedAt } : {}),
  };
}

export function toLiveDistributionPolicy(config: LiveDistributionConfig): LiveDistributionPolicy {
  return normalizeLiveDistributionPolicy(config);
}

export async function loadLiveDistribution(storage: Storage): Promise<LiveDistributionConfig> {
  const raw = await storage.get(KV_LIVE_DISTRIBUTION);
  if (!raw) return { ...DEFAULT_LIVE_DISTRIBUTION, pinnedKeys: [] };
  try {
    return normalizeLiveDistributionConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LIVE_DISTRIBUTION, pinnedKeys: [] };
  }
}

export async function saveLiveDistribution(storage: Storage, raw: unknown): Promise<LiveDistributionConfig> {
  // 管理页会按用途只更新局部开关（例如仅切换“主配置附带直播”）。
  // 这里必须先读旧配置，再只覆盖请求中明确出现的字段，避免局部保存
  // 把精细分类数量、置顶和屏蔽策略悄悄重置为默认值。
  const current = await loadLiveDistribution(storage);
  const patch = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const merged: Record<string, unknown> = { ...current };
  for (const key of [
    'selectionMode', 'maxSources', 'bucketLimits', 'pinnedKeys', 'blockedKeys',
    'attachToRoot', 'attachToAuth',
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) merged[key] = patch[key];
  }
  const config = normalizeLiveDistributionConfig({
    ...merged,
    updatedAt: new Date().toISOString(),
  });
  await storage.put(KV_LIVE_DISTRIBUTION, JSON.stringify(config));
  return config;
}
