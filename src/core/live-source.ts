// 直播源处理：连通性测试 + CF 代理 URL 改写

import type { LiveSourceEntry, TVBoxLive } from './types';
import type { Storage } from '../storage/interface';
import { KV_LIVE_TEXT_PREFIX, LIVE_PROXY_TTL } from './config';
import { isBlockedLiveSource } from './live-policy';

const KV_LIVE_PREFIX = 'live:';
export const KV_LIVE_PROXY_MANIFEST = 'live_proxy_manifest';
const LIVE_PROXY_MANIFEST_VERSION = 2;
const LIVE_PROXY_MANIFEST_MAX_ENTRIES = 256;
const LIVE_PROXY_INVALID_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const LIVE_PROXY_UNHEALTHY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_PROXY_INVALID_DELETE_THRESHOLD = 3;

export type LiveProxyHealth = 'healthy' | 'unhealthy';

/**
 * 为 URL 生成短 key：SHA-256 取前 16 位 hex
 */
async function urlToKey(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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

export interface LiveProxyManifestEntry extends LiveProxySource {
  key: string;
  health: LiveProxyHealth;
  consecutiveFailures: number;
  checkedAt: string;
  successfulAt?: string;
  lastFailure?: 'transient' | 'invalid';
}

interface LiveProxyManifest {
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
}

/** 计算直播源在代理路由中的稳定 key。 */
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
  } catch {
    // 旧格式：值就是原始 URL
  }

  return { url: raw };
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeManifestEntry(
  record: Record<string, unknown>,
  checkedAt: string,
  legacyVerified = false,
): LiveProxyManifestEntry | null {
  if (typeof record.key !== 'string' || !record.key || typeof record.url !== 'string' || !record.url) {
    return null;
  }
  const rawFailures = typeof record.consecutiveFailures === 'number' && Number.isFinite(record.consecutiveFailures)
    ? Math.floor(record.consecutiveFailures)
    : 0;
  const health: LiveProxyHealth = record.health === 'unhealthy' ? 'unhealthy' : 'healthy';
  const lastFailure = record.lastFailure === 'transient' || record.lastFailure === 'invalid'
    ? record.lastFailure
    : undefined;
  const successfulAt = stringValue(record, 'successfulAt')
    || (legacyVerified && health === 'healthy' ? checkedAt : undefined);

  return {
    key: record.key,
    url: record.url,
    health,
    consecutiveFailures: Math.max(0, rawFailures),
    checkedAt: stringValue(record, 'checkedAt') || checkedAt,
    ...(successfulAt ? { successfulAt } : {}),
    ...(lastFailure ? { lastFailure } : {}),
    ...(stringValue(record, 'name') ? { name: record.name as string } : {}),
    ...(stringValue(record, 'ua') ? { ua: record.ua as string } : {}),
    ...(record.header && typeof record.header === 'object' ? { header: record.header as Record<string, string> } : {}),
  };
}

function parseLiveProxyManifest(raw: string | null): LiveProxyManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LiveProxyManifest>;
    if ((parsed.version !== 1 && parsed.version !== LIVE_PROXY_MANIFEST_VERSION) || !Array.isArray(parsed.entries)) {
      return null;
    }
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
      entries,
    };
  } catch {
    return null;
  }
}

function manifestSignature(entries: LiveProxyManifestEntry[]): string {
  return JSON.stringify(entries);
}

function sortManifestEntries(entries: LiveProxyManifestEntry[]): LiveProxyManifestEntry[] {
  return entries.sort((a, b) => {
    if (a.health !== b.health) return a.health === 'healthy' ? -1 : 1;
    const aSuccess = Date.parse(a.successfulAt || '') || 0;
    const bSuccess = Date.parse(b.successfulAt || '') || 0;
    if (aSuccess !== bSuccess) return bSuccess - aSuccess;
    return a.key.localeCompare(b.key);
  });
}

async function prepareManifestEntries(entries: LiveSourceEntry[]): Promise<LiveProxyManifestEntry[]> {
  const checkedAt = new Date().toISOString();
  const prepared: LiveProxyManifestEntry[] = [];
  for (const entry of entries) {
    const url = entry.url.trim();
    if (!url || isBlockedLiveSource({ name: entry.name, url })) continue;
    prepared.push({
      key: await urlToKey(url),
      url,
      health: 'unhealthy',
      consecutiveFailures: 0,
      checkedAt,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.ua ? { ua: entry.ua } : {}),
      ...(entry.header ? { header: entry.header } : {}),
    });
  }
  return prepared;
}

/**
 * 把本轮校验结果合并进持久清单。
 *
 * 只有新一轮成功才会恢复 healthy；临时失败保留为后备，连续失败达标才淘汰。
 * 这样上游抖动不会把已稳定入口直接清空，旧入口也不会越过本轮健康源。
 */
export function mergeLiveProxyManifest(
  previous: LiveProxyManifest | null,
  currentEntries: LiveProxyManifestEntry[],
  update: Omit<LiveProxyValidationUpdate, 'entries'>,
): LiveProxyManifest {
  const checkedAt = update.checkedAt || new Date().toISOString();
  const byKey = new Map<string, LiveProxyManifestEntry>();
  if (previous && Array.isArray(previous.entries)) {
    for (const entry of previous.entries) byKey.set(entry.key, entry);
  }

  const valid = new Set(update.validUrls);
  const transient = new Set(update.transientUrls || []);
  const invalid = new Set(update.invalidUrls || []);
  const observed = new Set<string>([...valid, ...transient, ...invalid]);

  for (const current of currentEntries) {
    const previousEntry = byKey.get(current.key);
    const merged: LiveProxyManifestEntry = {
      ...previousEntry,
      ...current,
      key: current.key,
      url: current.url,
      health: current.health,
      consecutiveFailures: previousEntry?.consecutiveFailures ?? current.consecutiveFailures,
      checkedAt,
      ...(previousEntry?.successfulAt ? { successfulAt: previousEntry.successfulAt } : {}),
    };

    if (valid.has(current.url)) {
      merged.health = 'healthy';
      merged.consecutiveFailures = 0;
      merged.successfulAt = checkedAt;
      delete merged.lastFailure;
    } else if (transient.has(current.url)) {
      merged.health = 'unhealthy';
      merged.consecutiveFailures = (previousEntry?.consecutiveFailures ?? 0) + 1;
      merged.lastFailure = 'transient';
    } else if (invalid.has(current.url)) {
      merged.health = 'unhealthy';
      merged.consecutiveFailures = (previousEntry?.consecutiveFailures ?? 0) + 1;
      merged.lastFailure = 'invalid';
    } else {
      merged.health = previousEntry?.health || current.health;
      merged.consecutiveFailures = previousEntry?.consecutiveFailures ?? current.consecutiveFailures;
      if (previousEntry?.lastFailure) merged.lastFailure = previousEntry.lastFailure;
    }
    byKey.set(current.key, merged);
  }

  // 只在明确失败后开始计算保留期。上游本轮未返回的旧入口仍保留，
  // 避免因为上游配置短暂波动而把已稳定入口直接清空。
  const now = Date.parse(checkedAt) || Date.now();
  for (const [key, entry] of byKey) {
    const observedUrl = observed.has(entry.url);
    const invalidRepeated = observedUrl && entry.lastFailure === 'invalid'
      && entry.consecutiveFailures >= LIVE_PROXY_INVALID_DELETE_THRESHOLD;
    let expired = false;
    if (observedUrl && entry.lastFailure) {
      const lastActive = Date.parse(entry.successfulAt || '')
        || Date.parse(entry.checkedAt || '')
        || now;
      const staleForMs = Math.max(0, now - lastActive);
      expired = entry.lastFailure === 'invalid'
        ? staleForMs >= LIVE_PROXY_INVALID_RETENTION_MS
        : staleForMs >= LIVE_PROXY_UNHEALTHY_RETENTION_MS;
    }
    if (invalidRepeated || expired) byKey.delete(key);
  }

  const entries = sortManifestEntries([...byKey.values()])
    .slice(0, LIVE_PROXY_MANIFEST_MAX_ENTRIES);
  return {
    version: LIVE_PROXY_MANIFEST_VERSION,
    signature: manifestSignature(entries),
    entries,
  };
}

/**
 * 某个入口是否可以作为应用端下发候选。
 * 已知历史上成功的临时失败入口可作为后备；未成功过的新入口只观察不下发。
 */
export function isLiveProxyEntryDistributable(entry: LiveProxyManifestEntry): boolean {
  if (isBlockedLiveSource(entry)) return false;
  if (entry.health === 'healthy') return true;
  return !!entry.successfulAt
    && entry.lastFailure === 'transient'
    && entry.consecutiveFailures <= LIVE_PROXY_INVALID_DELETE_THRESHOLD - 1;
}

/**
 * 记录 /live/<key> 运行时校验结果。
 * 运行时抽查只更新健康状态；入口是否淘汰由完整聚合门禁决定。
 */
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
  const nextEntry: LiveProxyManifestEntry = {
    ...entry,
    checkedAt,
  };

  if (result === 'valid') {
    nextEntry.health = 'healthy';
    nextEntry.consecutiveFailures = 0;
    nextEntry.successfulAt = checkedAt;
    delete nextEntry.lastFailure;
  } else {
    nextEntry.health = 'unhealthy';
    nextEntry.consecutiveFailures = entry.consecutiveFailures + 1;
    nextEntry.lastFailure = result;
  }

  const entries = manifest.entries.map((item) => (item.key === key ? nextEntry : item));
  const nextEntries = sortManifestEntries(entries);
  const next: LiveProxyManifest = {
    version: LIVE_PROXY_MANIFEST_VERSION,
    signature: manifestSignature(nextEntries),
    entries: nextEntries,
  };
  await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify(next));
  if (result === 'invalid') {
    console.log(`[live-source] Live proxy ${key} failed runtime validation (${nextEntry.consecutiveFailures})`);
  }
  return nextEntry;
}

/**
 * 对单个直播源 URL 做连通性测试
 * GET + 读取前 1KB 嗅探内容
 */
async function testLiveSource(
  entry: LiveSourceEntry,
  timeoutMs: number,
): Promise<LiveTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const start = Date.now();
    const resp = await fetch(entry.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'okhttp/3.12.0' },
    });
    const speedMs = Date.now() - start;

    if (!resp.ok) {
      return { name: entry.name, url: entry.url, reachable: false, speedMs };
    }

    // 读取前 1KB 嗅探内容格式
    const reader = resp.body?.getReader();
    if (reader) {
      try {
        const { value } = await reader.read();
        if (value) {
          const text = new TextDecoder().decode(value.slice(0, 1024));
          // 基本格式嗅探：包含 #EXTM3U 或 ,http 或频道名模式则认为有效
          const looksValid =
            text.includes('#EXTM3U') ||
            text.includes(',http') ||
            text.includes('CCTV') ||
            text.includes('#EXTINF') ||
            /^.+,https?:\/\//m.test(text);

          if (!looksValid) {
            console.log(`[live-source] ${entry.name}: content doesn't look like m3u/txt, keeping anyway`);
          }
        }
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

/**
 * 批量连通性测试（并发）
 * 返回测试通过的条目和延迟映射
 */
export async function batchTestLiveSources(
  entries: LiveSourceEntry[],
  timeoutMs: number,
): Promise<{ passed: LiveSourceEntry[]; speedMap: Map<string, number> }> {
  if (entries.length === 0) return { passed: [], speedMap: new Map() };

  console.log(`[live-source] Testing ${entries.length} live sources concurrently...`);

  const results = await Promise.allSettled(
    entries.map((entry) => testLiveSource(entry, timeoutMs)),
  );

  const passed: LiveSourceEntry[] = [];
  const speedMap = new Map<string, number>();

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.reachable) {
      passed.push({ name: result.value.name, url: result.value.url });
      speedMap.set(result.value.url, result.value.speedMs);
    } else if (result.status === 'fulfilled') {
      console.log(`[live-source] Dropped: ${result.value.name} (unreachable)`);
    }
  }

  console.log(`[live-source] ${passed.length}/${entries.length} live sources reachable`);
  return { passed, speedMap };
}

/**
 * 将直播源条目转为 TVBoxLive 数组
 *
 * CF 模式：URL 改写为 /live/:key 代理路由，写入一个紧凑清单
 * 本地模式：保持原始 URL，name 追加延迟
 */
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
    const proxyEntries = await prepareManifestEntries(entries);
    const previousRaw = await storage.get(KV_LIVE_PROXY_MANIFEST);
    const previous = parseLiveProxyManifest(previousRaw);
    const update: Omit<LiveProxyValidationUpdate, 'entries'> = validationUpdate || {
      validUrls: proxyEntries.map((entry) => entry.url),
    };
    const manifest = mergeLiveProxyManifest(previous, proxyEntries, update);
    if (!previous || previous.signature !== manifest.signature) {
      await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify(manifest));
    }

    const distributableEntries = manifest.entries.filter(isLiveProxyEntryDistributable);
    for (const entry of distributableEntries) {
      const prebuilt = prebuiltTexts?.[entry.url];
      if (prebuilt && prebuilt.trim() && prebuilt.includes('#genre#')) {
        await storage.put(`${KV_LIVE_TEXT_PREFIX}${entry.key}`, prebuilt);
      }
      lives.push({
        name: entry.name || '直播源',
        type: 0,
        url: `${workerBaseUrl.replace(/\/$/, '')}/live/${entry.key}`,
      });
    }
    console.log(
      `[live-source] Prepared ${lives.length}/${manifest.entries.length} distributable live proxy entries`,
    );
    return lives;
  }

  for (const entry of entries) {
    let url = entry.url;
    let name = entry.name;

    if (speedMap) {
      // 本地模式：追加延迟到 name
      const ms = speedMap.get(entry.url);
      if (ms != null) {
        name = `${name} [${(ms / 1000).toFixed(1)}s]`;
      }
    }

    lives.push({
      name,
      type: 0,
      url,
    });
  }

  return lives;
}

/**
 * 读取当前可下发的直播代理清单。
 * 该清单是 CF 分离模式的唯一入口来源，避免从旧的原始源清单恢复已删除的空源。
 */
export async function listLiveProxyEntries(storage: Storage): Promise<LiveProxyManifestEntry[]> {
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  return (manifest?.entries ?? []).filter(isLiveProxyEntryDistributable);
}

/**
 * 从代理清单删除一个已经确认无效的直播入口。
 * 即使删除后为空也显式写回空清单，防止修复逻辑再次恢复旧入口。
 */
export async function removeLiveProxyEntry(key: string, storage: Storage): Promise<boolean> {
  const raw = await storage.get(KV_LIVE_PROXY_MANIFEST);
  const manifest = parseLiveProxyManifest(raw);
  if (!manifest) return false;
  const entries = manifest.entries.filter((entry) => entry.key !== key && !isBlockedLiveSource(entry));
  if (entries.length === manifest.entries.length) return false;
  const next: LiveProxyManifest = {
    version: LIVE_PROXY_MANIFEST_VERSION,
    signature: manifestSignature(entries),
    entries,
  };
  await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify(next));
  await storage.put(`${KV_LIVE_PREFIX}${key}`, '');
  console.log(`[live-source] Removed invalid live proxy entry ${key}`);
  return true;
}

/**
 * 从 KV 查询直播源 key 对应的代理元数据。
 * 兼容旧版本只存原始 URL 字符串的映射。
 */
export async function lookupLiveSource(key: string, storage: Storage): Promise<LiveProxySource | null> {
  const raw = await storage.get(`${KV_LIVE_PREFIX}${key}`);
  if (raw) {
    return parseLiveProxySource(raw);
  }

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

/**
 * 从 KV 查询直播源 key 对应的原始 URL
 */
export async function lookupLiveUrl(key: string, storage: Storage): Promise<string | null> {
  return (await lookupLiveSource(key, storage))?.url ?? null;
}

/**
 * 直播源代理 TTL（秒）
 */
export { LIVE_PROXY_TTL };