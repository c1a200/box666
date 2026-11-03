import type { Storage } from '../storage/interface';
import type {
  ChannelProbeEvaluationMode,
  ChannelProbeTrigger,
  ChannelSpeedMap,
} from './types';
import {
  KV_CHANNEL_QUALITY_SNAPSHOT,
  KV_CHANNEL_PROBE_WORKING_MAP,
  KV_CHANNEL_SPEED_MAP,
  CHANNEL_SPEED_TTL_MS,
} from './config';

export const CHANNEL_FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;
// Increment whenever the probe evidence rules change. A version bump makes
// every line earn fresh playback proof instead of inheriting a false-negative
// from an older, shallower detector.
export const CHANNEL_PROBE_RESULT_VERSION = 4;
export const CHANNEL_QUALITY_SNAPSHOT_VERSION = 1;
export const CHANNEL_PROBE_WORKING_VERSION = 1;

export interface ChannelQualitySnapshotStats {
  trigger: ChannelProbeTrigger;
  evaluationMode: ChannelProbeEvaluationMode;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  probed: number;
  success: number;
  failed: number;
  totalChannels: number;
}

export interface ChannelQualitySnapshot {
  version: number;
  publishedAt: string;
  /** Latest complete/full evaluation that produced this published ranking. */
  lastFullPublishedAt?: string;
  map: ChannelSpeedMap;
  stats: ChannelQualitySnapshotStats;
}

export interface PublishedSpeedSnapshotSummary {
  version: number;
  publishedAt: string;
  lastFullPublishedAt?: string;
  urls: number;
  stats: ChannelQualitySnapshotStats;
}

export interface ChannelProbeWorkingState {
  version: number;
  runStartedAt: string;
  trigger: ChannelProbeTrigger;
  evaluationMode: ChannelProbeEvaluationMode;
  completed?: boolean;
  map: ChannelSpeedMap;
}

function parseMap(raw: string | null): ChannelSpeedMap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ChannelSpeedMap
      : null;
  } catch {
    return null;
  }
}

/** Legacy probe cache. Kept for bounded Cloudflare probing and migration. */
export async function loadSpeedMap(storage: Storage): Promise<ChannelSpeedMap> {
  return parseMap(await storage.get(KV_CHANNEL_SPEED_MAP)) || {};
}

/** Legacy writer used only by the bounded Cloudflare probe path. */
export async function saveSpeedMap(storage: Storage, map: ChannelSpeedMap): Promise<void> {
  const next = JSON.stringify(map);
  const previous = await storage.get(KV_CHANNEL_SPEED_MAP);
  if (previous === next) return;
  await storage.put(KV_CHANNEL_SPEED_MAP, next);
}

/** Load the last atomically published ranking, falling back to the legacy cache. */
export async function loadPublishedSpeedSnapshot(storage: Storage): Promise<ChannelQualitySnapshot | null> {
  const raw = await storage.get(KV_CHANNEL_QUALITY_SNAPSHOT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChannelQualitySnapshot>;
    if (parsed.version !== CHANNEL_QUALITY_SNAPSHOT_VERSION
      || typeof parsed.publishedAt !== 'string'
      || !parsed.map
      || typeof parsed.map !== 'object'
      || Array.isArray(parsed.map)
      || !parsed.stats) {
      return null;
    }
    return parsed as ChannelQualitySnapshot;
  } catch {
    return null;
  }
}

export async function loadPublishedSpeedMap(storage: Storage): Promise<ChannelSpeedMap> {
  const snapshot = await loadPublishedSpeedSnapshot(storage);
  return snapshot ? snapshot.map : loadSpeedMap(storage);
}

export async function loadPublishedSpeedSnapshotSummary(storage: Storage): Promise<PublishedSpeedSnapshotSummary | null> {
  const snapshot = await loadPublishedSpeedSnapshot(storage);
  if (!snapshot) return null;
  return {
    version: snapshot.version,
    publishedAt: snapshot.publishedAt,
    ...(snapshot.lastFullPublishedAt ? { lastFullPublishedAt: snapshot.lastFullPublishedAt } : {}),
    urls: Object.keys(snapshot.map).length,
    stats: snapshot.stats,
  };
}

export async function hasPublishedSpeedSnapshot(storage: Storage): Promise<boolean> {
  return (await loadPublishedSpeedSnapshot(storage)) !== null;
}

/** A full run resumes from this local working state; outputs never read this key. */
export async function loadWorkingSpeedState(storage: Storage): Promise<ChannelProbeWorkingState | null> {
  const raw = await storage.get(KV_CHANNEL_PROBE_WORKING_MAP);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChannelProbeWorkingState>;
    if (parsed.version === CHANNEL_PROBE_WORKING_VERSION
      && typeof parsed.runStartedAt === 'string'
      && (parsed.evaluationMode === 'full' || parsed.evaluationMode === 'incremental')
      && (parsed.completed === undefined || typeof parsed.completed === 'boolean')
      && parsed.map
      && typeof parsed.map === 'object'
      && !Array.isArray(parsed.map)) {
      return parsed as ChannelProbeWorkingState;
    }
  } catch {
    // Legacy working caches were a bare ChannelSpeedMap. They are intentionally
    // ignored because they have no run cutoff and cannot be resumed safely.
  }
  return null;
}

export async function loadWorkingSpeedMap(storage: Storage): Promise<ChannelSpeedMap> {
  const working = await loadWorkingSpeedState(storage);
  return working ? working.map : loadPublishedSpeedMap(storage);
}

export async function saveWorkingSpeedState(
  storage: Storage,
  state: Omit<ChannelProbeWorkingState, 'version'>,
): Promise<void> {
  const next = JSON.stringify({ version: CHANNEL_PROBE_WORKING_VERSION, ...state });
  const previous = await storage.get(KV_CHANNEL_PROBE_WORKING_MAP);
  if (previous === next) return;
  await storage.put(KV_CHANNEL_PROBE_WORKING_MAP, next);
}

/**
 * Publish one complete map in a single snapshot write. The snapshot is written
 * before the legacy cache, so an interrupted migration can never expose a
 * partially updated ranking to output readers.
 */
export async function publishSpeedSnapshot(
  storage: Storage,
  map: ChannelSpeedMap,
  stats: ChannelQualitySnapshotStats,
): Promise<ChannelQualitySnapshot> {
  const previous = await loadPublishedSpeedSnapshot(storage);
  const publishedAt = new Date().toISOString();
  const previousFullPublishedAt = previous?.lastFullPublishedAt
    || (previous?.stats.evaluationMode === 'full' ? previous.publishedAt : undefined);
  const lastFullPublishedAt = stats.evaluationMode === 'full'
    ? publishedAt
    : previousFullPublishedAt;
  const snapshot: ChannelQualitySnapshot = {
    version: CHANNEL_QUALITY_SNAPSHOT_VERSION,
    publishedAt,
    ...(lastFullPublishedAt ? { lastFullPublishedAt } : {}),
    map,
    stats,
  };
  await storage.put(KV_CHANNEL_QUALITY_SNAPSHOT, JSON.stringify(snapshot));
  try {
    await saveSpeedMap(storage, map);
  } catch (err) {
    console.warn('[channel-probe] Snapshot published but legacy cache sync failed:', err);
  }
  return snapshot;
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

/**
 * Return URLs due for the current run. `force` is used by the daily full run:
 * every unique candidate is rechecked regardless of cache age or prior success.
 */
export function selectProbeCandidates(
  allUrls: string[],
  speedMap: ChannelSpeedMap,
  now = Date.now(),
  maxUrls = Number.POSITIVE_INFINITY,
  options: { force?: boolean; forceBefore?: number } = {},
): Array<{ url: string; priority: number; probedAt: number }> {
  return allUrls
    .map((url) => {
      const entry = speedMap[url];
      const probedAt = entry ? Date.parse(entry.probedAt) : NaN;
      const age = Number.isFinite(probedAt) ? now - probedAt : Number.POSITIVE_INFINITY;
      const isFresh = Number.isFinite(probedAt) && age >= 0 && age < CHANNEL_SPEED_TTL_MS;
      // Results from an old shallow probe are rechecked once without waiting
      // for the seven-day TTL. After that the stored version is normal cached data.
      const needsVersionUpgrade = !entry || entry.probeVersion !== CHANNEL_PROBE_RESULT_VERSION;
      const forceBefore = options.forceBefore;
      const forceDue = options.force
        && (!Number.isFinite(forceBefore) || !Number.isFinite(probedAt) || probedAt < (forceBefore as number));
      const due = forceDue
        || needsVersionUpgrade
        || !isFresh
        || (entry.kind === 'fail' && age >= CHANNEL_FAILURE_RETRY_MS);
      if (!due) return null;
      const priority = options.force
        ? !entry ? 0 : entry.kind === 'fail' ? 2 : 1
        : !entry
          ? 0
          : entry.kind === 'fail'
            ? 1
            : needsVersionUpgrade
              ? 0
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
