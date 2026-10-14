import type { Storage } from '../storage/interface';
import type { ChannelSpeedMap } from './types';
import { KV_CHANNEL_SPEED_MAP, CHANNEL_SPEED_TTL_MS } from './config';

export const CHANNEL_FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;

export async function loadSpeedMap(storage: Storage): Promise<ChannelSpeedMap> {
  const raw = await storage.get(KV_CHANNEL_SPEED_MAP);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ChannelSpeedMap;
  } catch {
    return {};
  }
}

export async function saveSpeedMap(storage: Storage, map: ChannelSpeedMap): Promise<void> {
  const next = JSON.stringify(map);
  const previous = await storage.get(KV_CHANNEL_SPEED_MAP);
  if (previous === next) return;
  await storage.put(KV_CHANNEL_SPEED_MAP, next);
}

/** 清理超过 TTL 的测速缓存。 */
export function pruneExpired(map: ChannelSpeedMap, now = Date.now()): ChannelSpeedMap {
  const out: ChannelSpeedMap = {};
  for (const [url, entry] of Object.entries(map)) {
    const ts = Date.parse(entry.probedAt);
    if (Number.isFinite(ts) && now - ts < CHANNEL_SPEED_TTL_MS) {
      out[url] = entry;
    }
  }
  return out;
}

/** 返回下一轮应优先探测的 URL。新鲜成功项不重复测，失败项达到重试间隔后再测。 */
export function selectProbeCandidates(
  allUrls: string[],
  speedMap: ChannelSpeedMap,
  now = Date.now(),
  maxUrls = Number.POSITIVE_INFINITY,
): Array<{ url: string; priority: number; probedAt: number }> {
  return allUrls
    .map((url) => {
      const entry = speedMap[url];
      const probedAt = entry ? Date.parse(entry.probedAt) : NaN;
      const age = Number.isFinite(probedAt) ? now - probedAt : Number.POSITIVE_INFINITY;
      const isFresh = Number.isFinite(probedAt) && age >= 0 && age < CHANNEL_SPEED_TTL_MS;
      const due = !entry
        || !isFresh
        || (entry.kind === 'fail' && age >= CHANNEL_FAILURE_RETRY_MS);
      if (!due) return null;
      const priority = !entry
        ? 0
        : entry.kind === 'fail'
          ? 1
          : !isFresh
            ? 2
            : 3;
      return { url, priority, probedAt: Number.isFinite(probedAt) ? probedAt : 0 };
    })
    .filter((item): item is { url: string; priority: number; probedAt: number } => item !== null)
    .sort((a, b) => a.priority - b.priority || a.probedAt - b.probedAt)
    .slice(0, Math.max(0, maxUrls))
    .map((item) => ({ url: item.url, priority: item.priority, probedAt: item.probedAt }));
}
