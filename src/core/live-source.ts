import type { LiveSourceEntry, TVBoxLive } from './types';
import type { Storage } from '../storage/interface';
import { KV_LIVE_TEXT_PREFIX, LIVE_PROXY_TTL } from './config';
import { isBlockedLiveSource } from './live-policy';
import {
  classifyLiveCategory,
  compareLiveRank,
  computeLiveSourceQualityScore,
  isLiveSourceDistributable,
  liveSourceFormatFromUrl,
  normalizeLiveCategory,
  normalizeLiveSourceFormat,
  type LiveCategory,
  type LiveRankView,
  type LiveSourceFormat,
  type LiveSourceHealth,
  type LiveSourceMetrics,
} from './live-quality';

const KV_LIVE_PREFIX = 'live:';
export const KV_LIVE_PROXY_MANIFEST = 'live_proxy_manifest';
const LIVE_PROXY_MANIFEST_VERSION = 3;
const LIVE_PROXY_MANIFEST_MAX_ENTRIES = 4096;
const LIVE_PROXY_INVALID_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const LIVE_PROXY_UNHEALTHY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_PROXY_INVALID_DELETE_THRESHOLD = 3;

export type LiveProxyHealth = LiveSourceHealth;

async function urlToKey(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface LiveTestResult {
  name: string;
  url: string;
  reachable: boolean;
  speedMs: number;
}

export interface LiveProxySource {
  name?: string;
  url: string;
  ua?: string;
  header?: Record<string, string>;
}

export interface LiveProxyEntryHint {
  /** manual=管理端手动添加；aggregated=来自第三方订阅/上游配置。 */
  kind?: 'aggregated' | 'manual';
  /** 该源解析出的主要分类（按分组名判定）。 */
  category?: LiveCategory;
}

export interface LiveProxyManifestEntry extends LiveProxySource {
  key: string;
  health: LiveProxyHealth;
  consecutiveFailures: number;
  checkedAt: string;
  successfulAt?: string;
  lastFailure?: 'transient' | 'invalid';
  kind?: 'aggregated' | 'manual';
  format?: LiveSourceFormat;
  category?: LiveCategory;
  qualityScore?: number;
  rank?: number;
  channelCount?: number;
  totalEntries?: number;
  usableEntries?: number;
  playableRatio?: number | null;
  adRatio?: number | null;
  downloadMs?: number | null;
  everSucceeded?: boolean;
  /** 最近一次在完整聚合快照中被看到的时刻；用于淘汰上游已删除的幽灵源。 */
  lastSeenAt?: string;
}

export interface LiveProxyManifest {
  version: number;
  signature: string;
  entries: LiveProxyManifestEntry[];
}

export interface LiveProxyValidationUpdate {
  entries: LiveSourceEntry[];
  validUrls: readonly string[];
  transientUrls?: readonly string[];
  invalidUrls?: readonly string[];
  checkedAt?: string;
  metrics?: Readonly<Record<string, LiveSourceMetrics>>;
  /** 逐源来源与分类提示，聚合阶段解析后回填，避免清单分类一律为“其他”。 */
  hints?: Readonly<Record<string, LiveProxyEntryHint>>;
  texts?: Record<string, string>;
  /** 本轮是完整聚合快照：可对上轮未出现的旧入口执行宽限期淘汰。 */
  fullSnapshot?: boolean;
}

export async function liveProxyKey(url: string): Promise<string> {
  return urlToKey(url);
}

function parseLiveProxySource(raw: string): LiveProxySource | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LiveProxySource>;
    if (typeof parsed.url === 'string' && parsed.url) {
      return {
        url: parsed.url,
        ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
        ...(typeof parsed.ua === 'string' ? { ua: parsed.ua } : {}),
        ...(parsed.header && typeof parsed.header === 'object' ? { header: parsed.header } : {}),
      };
    }
  } catch { /* legacy raw URL */ }
  return { url: raw };
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeManifestEntry(
  record: Record<string, unknown>,
  checkedAt: string,
  legacyVerified = false,
): LiveProxyManifestEntry | null {
  if (typeof record.key !== 'string' || !record.key || typeof record.url !== 'string' || !record.url) return null;
  const rawFailures = typeof record.consecutiveFailures === 'number' && Number.isFinite(record.consecutiveFailures)
    ? Math.floor(record.consecutiveFailures)
    : 0;
  const health: LiveProxyHealth = record.health === 'unhealthy' ? 'unhealthy' : 'healthy';
  const lastFailure = record.lastFailure === 'transient' || record.lastFailure === 'invalid' ? record.lastFailure : undefined;
  const successfulAt = stringValue(record, 'successfulAt') || (legacyVerified && health === 'healthy' ? checkedAt : undefined);
  const url = record.url;
  return {
    key: record.key,
    url,
    health,
    consecutiveFailures: Math.max(0, rawFailures),
    checkedAt: stringValue(record, 'checkedAt') || checkedAt,
    ...(successfulAt ? { successfulAt } : {}),
    ...(lastFailure ? { lastFailure } : {}),
    ...(stringValue(record, 'name') ? { name: record.name as string } : {}),
    ...(stringValue(record, 'ua') ? { ua: record.ua as string } : {}),
    ...(record.header && typeof record.header === 'object' ? { header: record.header as Record<string, string> } : {}),
    ...(record.kind === 'aggregated' || record.kind === 'manual' ? { kind: record.kind } : {}),
    format: normalizeLiveSourceFormat(record.format ?? liveSourceFormatFromUrl(url)),
    category: normalizeLiveCategory(record.category),
    ...(numberValue(record, 'qualityScore') != null ? { qualityScore: numberValue(record, 'qualityScore') } : {}),
    ...(numberValue(record, 'rank') != null ? { rank: numberValue(record, 'rank') } : {}),
    ...(numberValue(record, 'channelCount') != null ? { channelCount: numberValue(record, 'channelCount') } : {}),
    ...(numberValue(record, 'totalEntries') != null ? { totalEntries: numberValue(record, 'totalEntries') } : {}),
    ...(numberValue(record, 'usableEntries') != null ? { usableEntries: numberValue(record, 'usableEntries') } : {}),
    ...(numberValue(record, 'playableRatio') != null ? { playableRatio: numberValue(record, 'playableRatio') } : {}),
    ...(numberValue(record, 'adRatio') != null ? { adRatio: numberValue(record, 'adRatio') } : {}),
    ...(numberValue(record, 'downloadMs') != null ? { downloadMs: numberValue(record, 'downloadMs') } : {}),
    ...(typeof record.everSucceeded === 'boolean' ? { everSucceeded: record.everSucceeded } : {}),
    ...(stringValue(record, 'lastSeenAt') ? { lastSeenAt: record.lastSeenAt as string } : {}),
  };
}

function parseLiveProxyManifest(raw: string | null): LiveProxyManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LiveProxyManifest>;
    const supported = parsed.version === 1 || parsed.version === 2 || parsed.version === LIVE_PROXY_MANIFEST_VERSION;
    if (!supported || !Array.isArray(parsed.entries)) return null;
    const checkedAt = new Date().toISOString();
    const entries: LiveProxyManifestEntry[] = [];
    for (const entry of parsed.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const normalized = normalizeManifestEntry(entry as unknown as Record<string, unknown>, checkedAt, parsed.version === 1);
      if (normalized) entries.push(normalized);
    }
    return {
      version: LIVE_PROXY_MANIFEST_VERSION,
      signature: typeof parsed.signature === 'string' ? parsed.signature : manifestSignature(entries),
      entries: sortManifestEntries(entries),
    };
  } catch {
    return null;
  }
}

function manifestSignature(entries: LiveProxyManifestEntry[]): string {
  return JSON.stringify(entries);
}

function scoreEntry(entry: LiveProxyManifestEntry): number {
  return computeLiveSourceQualityScore({
    health: entry.health,
    everSucceeded: entry.everSucceeded ?? !!entry.successfulAt,
    lastFailure: entry.lastFailure,
    channelCount: entry.channelCount,
    totalEntries: entry.totalEntries,
    usableEntries: entry.usableEntries,
    playableRatio: entry.playableRatio,
    adRatio: entry.adRatio,
    downloadMs: entry.downloadMs,
    successfulAt: entry.successfulAt,
    now: Date.now(),
  });
}

function rankManifestEntries(entries: LiveProxyManifestEntry[]): LiveProxyManifestEntry[] {
  const scored = entries.map((entry) => ({ ...entry, qualityScore: scoreEntry(entry) }));
  scored.sort(compareLiveRank);
  return scored.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function sortManifestEntries(entries: LiveProxyManifestEntry[]): LiveProxyManifestEntry[] {
  return rankManifestEntries(entries);
}

export function prepareManifestEntries(
  entries: LiveSourceEntry[],
  hints?: Record<string, LiveProxyEntryHint>,
): LiveProxyManifestEntry[] {
  const checkedAt = new Date().toISOString();
  const prepared: LiveProxyManifestEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const url = entry.url.trim();
    if (!url || seen.has(url) || isBlockedLiveSource({ name: entry.name, url })) continue;
    seen.add(url);
    const hint = hints?.[url];
    const metrics: LiveSourceMetrics = {};
    prepared.push({
      key: '',
      url,
      health: 'unhealthy',
      consecutiveFailures: 0,
      checkedAt,
      kind: hint?.kind ?? 'aggregated',
      format: liveSourceFormatFromUrl(url),
      // 分类来自本轮聚合解析出的分组；缺省才退回“其他”，不再一律判成其他。
      category: hint?.category ?? classifyLiveCategory([]),
      qualityScore: computeLiveSourceQualityScore(metrics),
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.ua ? { ua: entry.ua } : {}),
      ...(entry.header ? { header: entry.header } : {}),
    });
  }
  return prepared;
}

export function mergeLiveProxyManifest(
  previous: LiveProxyManifest | null,
  currentEntries: LiveProxyManifestEntry[],
  update: Omit<LiveProxyValidationUpdate, 'entries'>,
): LiveProxyManifest {
  const checkedAt = update.checkedAt || new Date().toISOString();
  const byKey = new Map<string, LiveProxyManifestEntry>();
  if (previous?.entries) for (const entry of previous.entries) byKey.set(entry.key, entry);
  const valid = new Set(update.validUrls);
  const transient = new Set(update.transientUrls || []);
  const invalid = new Set(update.invalidUrls || []);
  const observed = new Set<string>([...valid, ...transient, ...invalid]);

  for (const current of currentEntries) {
    const previousEntry = byKey.get(current.key);
    const metrics = update.metrics?.[current.url] || update.metrics?.[current.key] || {};
    const merged: LiveProxyManifestEntry = {
      ...previousEntry,
      ...current,
      key: current.key,
      url: current.url,
      health: previousEntry?.health || current.health,
      consecutiveFailures: previousEntry?.consecutiveFailures ?? current.consecutiveFailures,
      checkedAt,
      ...(previousEntry?.successfulAt ? { successfulAt: previousEntry.successfulAt } : {}),
      ...(previousEntry?.lastFailure ? { lastFailure: previousEntry.lastFailure } : {}),
      everSucceeded: previousEntry?.everSucceeded ?? !!previousEntry?.successfulAt,
      lastSeenAt: checkedAt,
    };
    for (const key of [
      'channelCount', 'totalEntries', 'usableEntries', 'playableRatio', 'adRatio', 'downloadMs',
    ] as const) {
      const value = metrics[key];
      if (value != null) (merged as unknown as Record<string, unknown>)[key] = value;
    }
    if (metrics.lastFailure === 'invalid' || metrics.lastFailure === 'transient') merged.lastFailure = metrics.lastFailure;
    if (valid.has(current.url)) {
      merged.health = 'healthy';
      merged.consecutiveFailures = 0;
      merged.successfulAt = checkedAt;
      merged.everSucceeded = true;
      delete merged.lastFailure;
    } else if (transient.has(current.url)) {
      merged.health = 'unhealthy';
      merged.consecutiveFailures = (previousEntry?.consecutiveFailures ?? 0) + 1;
      merged.lastFailure = 'transient';
    } else if (invalid.has(current.url)) {
      merged.health = 'unhealthy';
      merged.consecutiveFailures = (previousEntry?.consecutiveFailures ?? 0) + 1;
      merged.lastFailure = 'invalid';
    }
    byKey.set(current.key, merged);
  }

  const now = Date.parse(checkedAt) || Date.now();
  // 完整聚合快照语义：本轮 currentEntries 覆盖全部上游入口。
  // 若某旧入口本轮未再出现，说明已被上游删除，保留一个宽限期后清理，
  // 避免签名/URL 变更后永久残留幽灵源；局部验证调用不传该标记。
  const fullSnapshotObserved = !!update.fullSnapshot;
  const currentKeys = new Set(currentEntries.map((item) => item.key));
  for (const [key, entry] of byKey) {
    const isObserved = observed.has(entry.url);
    const invalidRepeated = isObserved && entry.lastFailure === 'invalid'
      && entry.consecutiveFailures >= LIVE_PROXY_INVALID_DELETE_THRESHOLD;
    let expired = false;
    if (isObserved && entry.lastFailure) {
      const lastActive = Date.parse(entry.successfulAt || '') || Date.parse(entry.checkedAt || '') || now;
      const staleForMs = Math.max(0, now - lastActive);
      expired = entry.lastFailure === 'invalid'
        ? staleForMs >= LIVE_PROXY_INVALID_RETENTION_MS
        : staleForMs >= LIVE_PROXY_UNHEALTHY_RETENTION_MS;
    }
    if (fullSnapshotObserved && !currentKeys.has(key)) {
      const lastSeen = Date.parse(entry.lastSeenAt || '') || Date.parse(entry.checkedAt || '') || 0;
      if (lastSeen > 0 && now - lastSeen >= LIVE_PROXY_UNHEALTHY_RETENTION_MS) byKey.delete(key);
      continue;
    }
    if (invalidRepeated || expired) byKey.delete(key);
  }

  const entries = sortManifestEntries([...byKey.values()]).slice(0, LIVE_PROXY_MANIFEST_MAX_ENTRIES);
  return { version: LIVE_PROXY_MANIFEST_VERSION, signature: manifestSignature(entries), entries };
}

export function isLiveProxyEntryDistributable(entry: LiveProxyManifestEntry): boolean {
  return !isBlockedLiveSource(entry) && isLiveSourceDistributable({
    ...entry,
    everSucceeded: entry.everSucceeded ?? !!entry.successfulAt,
  });
}

export async function recordLiveProxyValidation(
  key: string,
  result: 'valid' | 'invalid' | 'transient',
  storage: Storage,
): Promise<LiveProxyManifestEntry | null> {
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  if (!manifest) return null;
  const entry = manifest.entries.find((item) => item.key === key);
  if (!entry) return null;
  const checkedAt = new Date().toISOString();
  const nextEntry: LiveProxyManifestEntry = { ...entry, checkedAt };
  if (result === 'valid') {
    nextEntry.health = 'healthy';
    nextEntry.consecutiveFailures = 0;
    nextEntry.successfulAt = checkedAt;
    nextEntry.everSucceeded = true;
    delete nextEntry.lastFailure;
  } else {
    nextEntry.health = 'unhealthy';
    nextEntry.consecutiveFailures = entry.consecutiveFailures + 1;
    nextEntry.lastFailure = result;
  }
  const entries = manifest.entries.map((item) => (item.key === key ? nextEntry : item));
  const nextEntries = sortManifestEntries(entries);
  await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify({
    version: LIVE_PROXY_MANIFEST_VERSION,
    signature: manifestSignature(nextEntries),
    entries: nextEntries,
  }));
  return nextEntry;
}

async function testLiveSource(entry: LiveSourceEntry, timeoutMs: number): Promise<LiveTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const start = Date.now();
    const resp = await fetch(entry.url, { signal: controller.signal, headers: { 'User-Agent': 'okhttp/3.12.0' } });
    const speedMs = Date.now() - start;
    if (!resp.ok) return { name: entry.name, url: entry.url, reachable: false, speedMs };
    const reader = resp.body?.getReader();
    if (reader) {
      try {
        const { value } = await reader.read();
        if (value) new TextDecoder().decode(value.slice(0, 1024));
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    return { name: entry.name, url: entry.url, reachable: true, speedMs };
  } catch {
    return { name: entry.name, url: entry.url, reachable: false, speedMs: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function batchTestLiveSources(
  entries: LiveSourceEntry[],
  timeoutMs: number,
): Promise<{ passed: LiveSourceEntry[]; speedMap: Map<string, number> }> {
  if (entries.length === 0) return { passed: [], speedMap: new Map() };
  const results = await Promise.allSettled(entries.map((entry) => testLiveSource(entry, timeoutMs)));
  const passed: LiveSourceEntry[] = [];
  const speedMap = new Map<string, number>();
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.reachable) {
      passed.push({ name: result.value.name, url: result.value.url });
      speedMap.set(result.value.url, result.value.speedMs);
    }
  }
  return { passed, speedMap };
}

/**
 * 把聚合阶段已经算出的逐源质量结果写入持久清单。
 * Render 与 Cloudflare 共用同一份清单，因此下发策略在两种运行模式
 * 下使用完全一致的质量池排序、分类、屏蔽与置顶规则。
 */
export async function updateLiveProxyManifest(
  entries: LiveSourceEntry[],
  storage: Storage,
  validationUpdate: Omit<LiveProxyValidationUpdate, 'entries'>,
): Promise<LiveProxyManifest> {
  const proxyEntries = prepareManifestEntries(entries, validationUpdate.hints);
  for (const entry of proxyEntries) entry.key = await urlToKey(entry.url);
  for (const entry of proxyEntries) {
    const metrics = validationUpdate.metrics?.[entry.url];
    if (!metrics) continue;
    entry.health = metrics.health === 'healthy' ? 'healthy' : 'unhealthy';
    entry.everSucceeded = metrics.everSucceeded ?? entry.everSucceeded;
    if (metrics.lastFailure) entry.lastFailure = metrics.lastFailure;
    if (metrics.channelCount != null) entry.channelCount = metrics.channelCount;
    if (metrics.totalEntries != null) entry.totalEntries = metrics.totalEntries;
    if (metrics.usableEntries != null) entry.usableEntries = metrics.usableEntries;
    if (metrics.playableRatio != null) entry.playableRatio = metrics.playableRatio;
    if (metrics.adRatio != null) entry.adRatio = metrics.adRatio;
    if (metrics.downloadMs != null) entry.downloadMs = metrics.downloadMs;
    if (metrics.successfulAt) entry.successfulAt = metrics.successfulAt;
    entry.qualityScore = computeLiveSourceQualityScore(metrics);
  }
  const previous = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  // 历史成功时间必须继承；否则本轮临时失败会把成熟后备源错误降级。
  for (const entry of proxyEntries) {
    const prior = previous?.entries.find((item) => item.key === entry.key);
    if (!prior) continue;
    if (!entry.successfulAt && prior.successfulAt) entry.successfulAt = prior.successfulAt;
    if (entry.everSucceeded == null && prior.everSucceeded != null) entry.everSucceeded = prior.everSucceeded;
  }
  const manifest = mergeLiveProxyManifest(previous, proxyEntries, validationUpdate);
  if (!previous || previous.signature !== manifest.signature) {
    await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify(manifest));
  }
  return manifest;
}
export async function liveSourcesToTVBoxLives(
  entries: LiveSourceEntry[],
  workerBaseUrl: string | undefined,
  storage: Storage,
  speedMap?: Map<string, number>,
  prebuiltTexts?: Record<string, string>,
  validationUpdate?: Omit<LiveProxyValidationUpdate, 'entries'>,
): Promise<TVBoxLive[]> {
  const lives: TVBoxLive[] = [];
  if (workerBaseUrl) {
    const proxyEntries = prepareManifestEntries(entries, validationUpdate?.hints);
    const manifest = await updateLiveProxyManifest(entries, storage, validationUpdate || {
      validUrls: proxyEntries.map((entry) => entry.url),
    });
    const distributableEntries = manifest.entries.filter(isLiveProxyEntryDistributable);
    for (const entry of distributableEntries) {
      const prebuilt = prebuiltTexts?.[entry.url];
      if (prebuilt && prebuilt.trim() && prebuilt.includes('#genre#')) {
        await storage.put(`${KV_LIVE_TEXT_PREFIX}${entry.key}`, prebuilt);
      }
      lives.push({ name: entry.name || '直播源', type: 0, url: `${workerBaseUrl.replace(/\/$/, '')}/live/${entry.key}` });
    }
    return lives;
  }

  for (const entry of entries) {
    let name = entry.name;
    const ms = speedMap?.get(entry.url);
    if (ms != null) name = `${name} [${(ms / 1000).toFixed(1)}s]`;
    lives.push({ name, type: 0, url: entry.url });
  }
  return lives;
}

export async function listLiveProxyEntries(storage: Storage): Promise<LiveProxyManifestEntry[]> {
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  return rankManifestEntries(manifest?.entries ?? []).filter(isLiveProxyEntryDistributable);
}

export async function listAllLiveProxyEntries(storage: Storage): Promise<LiveProxyManifestEntry[]> {
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  return rankManifestEntries(manifest?.entries ?? []);
}

export async function removeLiveProxyEntry(key: string, storage: Storage): Promise<boolean> {
  const raw = await storage.get(KV_LIVE_PROXY_MANIFEST);
  const manifest = parseLiveProxyManifest(raw);
  if (!manifest) return false;
  const entries = manifest.entries.filter((entry) => entry.key !== key);
  if (entries.length === manifest.entries.length) return false;
  const next = sortManifestEntries(entries);
  await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify({ version: LIVE_PROXY_MANIFEST_VERSION, signature: manifestSignature(next), entries: next }));
  await storage.put(`${KV_LIVE_PREFIX}${key}`, '');
  return true;
}

export async function lookupLiveSource(key: string, storage: Storage): Promise<LiveProxySource | null> {
  const raw = await storage.get(`${KV_LIVE_PREFIX}${key}`);
  if (raw) return parseLiveProxySource(raw);
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  const entry = manifest?.entries.find((item) => item.key === key);
  if (!entry) return null;
  return {
    url: entry.url,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.ua ? { ua: entry.ua } : {}),
    ...(entry.header ? { header: entry.header } : {}),
  };
}

export async function lookupLiveUrl(key: string, storage: Storage): Promise<string | null> {
  return (await lookupLiveSource(key, storage))?.url ?? null;
}

export { LIVE_PROXY_TTL };
