// JAR 代理：CF 模式下将 spider/jar URL 改写为 CF 代理路由

import type { TVBoxConfig, TVBoxSite } from './types';
import type { Storage } from '../storage/interface';

const KV_JAR_PREFIX = 'jar:';
export const KV_JAR_READY_INDEX = 'jar_ready_index';
export const KV_JAR_BIN_PREFIX = 'jar_bin:';
// 启动裁剪只认已完成的预取结果。这个标记与二进制分开保存，便于 Render 用本地文件快速判断。
export const JAR_CACHE_READY_VERSION = 'ready-v1';
const JAR_PREFETCH_CONCURRENCY = 3;
const JAR_PREFETCH_TIMEOUT_MS = 8000;
const JAR_PREFETCH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 解析 spider/jar 字符串
 *
 * 格式：{prefix}{url};md5;{hash}  或  {prefix}{url}
 * prefix 可能是 "img+" 或空
 */
export function parseSpiderString(spider: string): {
  prefix: string;
  url: string;
  md5: string | null;
  raw: string;
} {
  let prefix = '';
  let rest = spider;

  // 提取 img+ 前缀
  if (rest.startsWith('img+')) {
    prefix = 'img+';
    rest = rest.substring(4);
  }

  // 分离 ;md5;hash
  const md5Idx = rest.indexOf(';md5;');
  if (md5Idx !== -1) {
    const url = rest.substring(0, md5Idx);
    const md5 = rest.substring(md5Idx + 5);
    return { prefix, url, md5, raw: spider };
  }

  return { prefix, url: rest, md5: null, raw: spider };
}

/**
 * 为 URL 生成短 key（无 MD5 时使用）
 * 用 Web Crypto 的 SHA-256 取前 16 位 hex
 */
export async function urlToKey(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 根据 spider 串生成改写后的字符串（纯内存，不写 KV）
 */
function buildRewrittenSpider(
  spider: string,
  workerBaseUrl: string,
  urlKeyMap: Map<string, string>,
): string | null {
  if (!spider) return null;

  const parsed = parseSpiderString(spider);
  if (!parsed.url.startsWith('http://') && !parsed.url.startsWith('https://')) {
    return null;
  }

  const key = urlKeyMap.get(parsed.url);
  if (!key) return null;

  const proxyUrl = `${workerBaseUrl.replace(/\/$/, '')}/jar/${key}`;
  if (parsed.md5) {
    return `${parsed.prefix}${proxyUrl};md5;${parsed.md5}`;
  }
  return `${parsed.prefix}${proxyUrl}`;
}

/**
 * 改写合并后配置中的所有 JAR URL（仅 CF 模式调用）
 *
 * 两步走：
 * 1. 收集所有唯一 JAR URL → 生成 key → 批量写 KV（~10 次写入）
 * 2. 纯内存改写 spider/jar 字段（不再触发 KV 写入）
 */
export interface JarEntry {
  key: string;
  url?: string;
}

export async function rewriteJarUrls(
  config: TVBoxConfig,
  workerBaseUrl: string,
  storage: Storage,
  options: { onJarEntries?: (entries: JarEntry[]) => void } = {},
): Promise<TVBoxConfig> {
  // Step 1: 收集所有唯一 JAR URL
  const uniqueJars = new Map<string, { md5: string | null }>(); // url → {md5}

  if (config.spider) {
    const parsed = parseSpiderString(config.spider);
    if (parsed.url.startsWith('http://') || parsed.url.startsWith('https://')) {
      if (!parsed.url.includes('jsdelivr.net') && !parsed.url.includes('gitmirror.com')) {
        uniqueJars.set(parsed.url, { md5: parsed.md5 });
      }
    }
  }

  for (const site of config.sites || []) {
    if (site.jar) {
      const parsed = parseSpiderString(site.jar);
      if (parsed.url.startsWith('http://') || parsed.url.startsWith('https://')) {
        if (parsed.url.includes('jsdelivr.net') || parsed.url.includes('gitmirror.com')) {
          continue;
        }
        if (!uniqueJars.has(parsed.url)) {
          uniqueJars.set(parsed.url, { md5: parsed.md5 });
        }
      }
    }
  }

  if (uniqueJars.size === 0) {
    console.log('[jar-proxy] No JAR URLs to rewrite');
    return config;
  }

  // Step 2: 为每个唯一 URL 生成 key + 批量写 KV
  const urlKeyMap = new Map<string, string>(); // url → key

  for (const [url, { md5 }] of uniqueJars) {
    const key = md5 || (await urlToKey(url));
    urlKeyMap.set(url, key);
    await storage.put(`${KV_JAR_PREFIX}${key}`, url);
    console.log(`[jar-proxy] Mapped ${key} → ${url.substring(0, 60)}...`);
  }

  console.log(`[jar-proxy] Wrote ${urlKeyMap.size} KV mappings`);

  // Step 3: 纯内存改写
  const result = { ...config };

  if (result.spider) {
    const rewritten = buildRewrittenSpider(result.spider, workerBaseUrl, urlKeyMap);
    if (rewritten) result.spider = rewritten;
  }

  if (result.sites) {
    result.sites = result.sites.map((site) => {
      if (!site.jar) return site;
      const rewritten = buildRewrittenSpider(site.jar, workerBaseUrl, urlKeyMap);
      if (rewritten) return { ...site, jar: rewritten };
      return site;
    });
  }

  options.onJarEntries?.(
    [...urlKeyMap.entries()].map(([url, key]) => ({ key, url })),
  );

  console.log(`[jar-proxy] Rewrote ${urlKeyMap.size} unique JAR URLs across config`);
  return result;
}

export function getProxyJarKeyFromSpider(spider: string | undefined): string | null {
  if (!spider) return null;
  const parsed = parseSpiderString(spider);
  const match = parsed.url.match(/\/jar\/([^/?#;]+)/i);
  return match ? normalizeJarRequestKey(decodeURIComponent(match[1])) : null;
}

export function getJarKeyForSite(site: TVBoxSite, globalSpider?: string): string | null {
  // 站点自带 JAR 优先；直连 CDN 返回 null，不能错误回退到全局代理 JAR。
  const ownJar = site.jar?.trim();
  if (ownJar) return getProxyJarKeyFromSpider(ownJar);
  return getProxyJarKeyFromSpider(globalSpider);
}

export function collectJarEntriesForSites(sites: TVBoxSite[], globalSpider?: string): JarEntry[] {
  const entries = new Map<string, JarEntry>();
  for (const site of sites || []) {
    if (site.type !== 3) continue;
    const key = getJarKeyForSite(site, globalSpider);
    if (key && !entries.has(key)) entries.set(key, { key });
  }
  return [...entries.values()];
}

interface JarReadyIndex {
  version: string;
  updatedAt: string;
  keys: string[];
}

function parseReadyIndex(raw: string | null): JarReadyIndex {
  if (!raw) return { version: JAR_CACHE_READY_VERSION, updatedAt: '', keys: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<JarReadyIndex>;
    if (parsed.version !== JAR_CACHE_READY_VERSION || !Array.isArray(parsed.keys)) {
      return { version: JAR_CACHE_READY_VERSION, updatedAt: '', keys: [] };
    }
    return {
      version: JAR_CACHE_READY_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      keys: parsed.keys.filter((key): key is string => typeof key === 'string'),
    };
  } catch {
    return { version: JAR_CACHE_READY_VERSION, updatedAt: '', keys: [] };
  }
}

export async function loadJarReadyKeys(storage: Storage): Promise<Set<string>> {
  return new Set(parseReadyIndex(await storage.get(KV_JAR_READY_INDEX)).keys);
}

let readyIndexWriteQueue: Promise<void> = Promise.resolve();

async function updateReadyIndex(storage: Storage, keys: string[]): Promise<void> {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) return;

  // KV 本身没有原子合并能力。这里用实例内串行队列 + 重新读取合并，
  // 避免同一实例内并发预取/命中请求互相覆盖；跨实例仍保持只增不减。
  const run = readyIndexWriteQueue.catch(() => {}).then(async () => {
    const current = parseReadyIndex(await storage.get(KV_JAR_READY_INDEX));
    const merged = new Set(current.keys);
    let changed = false;
    for (const key of uniqueKeys) {
      if (!merged.has(key)) {
        merged.add(key);
        changed = true;
      }
    }
    if (!changed) return;
    const next: JarReadyIndex = {
      version: JAR_CACHE_READY_VERSION,
      updatedAt: new Date().toISOString(),
      keys: [...merged],
    };
    await storage.put(KV_JAR_READY_INDEX, JSON.stringify(next));
  });
  readyIndexWriteQueue = run.catch(() => {});
  return run;
}

export async function markJarReady(storage: Storage, key: string): Promise<void> {
  if (!key) return;
  await updateReadyIndex(storage, [key]);
}

async function fetchJarBytes(url: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JAR_PREFETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'okhttp/3.12.0' },
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.log(`[jar-proxy] Prefetch skipped ${url.substring(0, 60)}: HTTP ${resp.status}`);
      return null;
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength <= 0 || bytes.byteLength > JAR_PREFETCH_MAX_BYTES) {
      console.log(`[jar-proxy] Prefetch skipped ${url.substring(0, 60)}: size ${bytes.byteLength}`);
      return null;
    }
    return bytes;
  } catch (error: unknown) {
    console.log(`[jar-proxy] Prefetch failed ${url.substring(0, 60)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function prefetchJarBinaries(
  storage: Storage,
  entries: JarEntry[],
  options: {
    writeBinary?: (key: string, bytes: Uint8Array) => Promise<void>;
    concurrency?: number;
  } = {},
): Promise<void> {
  const unique = new Map(entries.map((entry) => [entry.key, entry]));
  const ready = await loadJarReadyKeys(storage);
  const pending = [...unique.values()].filter((entry) => {
    if (!entry.key || ready.has(entry.key)) return false;
    if (entry.url && /\/jar\//i.test(entry.url)) return false;
    return true;
  });
  if (pending.length === 0) {
    console.log('[jar-proxy] Prefetch: all JARs already ready');
    return;
  }

  const concurrency = Math.max(1, options.concurrency || JAR_PREFETCH_CONCURRENCY);
  let cursor = 0;
  const completed: string[] = [];
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const entry = pending[cursor++];
      const url = entry.url || await lookupJarUrl(entry.key, storage);
      if (!url) continue;
      const bytes = await fetchJarBytes(url);
      if (!bytes) continue;
      try {
        if (options.writeBinary) {
          await options.writeBinary(entry.key, bytes);
        } else {
          await storage.put(`${KV_JAR_BIN_PREFIX}${entry.key}`, uint8ArrayToBase64(bytes));
        }
        completed.push(entry.key);
        // 每个 JAR 写完就立即可下发。Worker waitUntil 即使中途结束，
        // 已完成的部分也不会因为最终批量索引失败而白等。
        await updateReadyIndex(storage, [entry.key]);
        console.log(`[jar-proxy] Prefetched ${entry.key} (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
      } catch (error: unknown) {
        console.log(`[jar-proxy] Prefetch store failed ${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));

  console.log(`[jar-proxy] Prefetch complete: ${completed.length}/${pending.length} ready`);
}

/**
 * 从 KV 查询 JAR key 对应的原始 URL
 */
export async function lookupJarUrl(key: string, storage: Storage): Promise<string | null> {
  return storage.get(`${KV_JAR_PREFIX}${key}`);
}

/**
 * 兼容客户端在 JAR 代理地址后追加的 ;md5;... / ;pk;... 元数据。
 * 这些后缀属于 spider 描述，不是 KV 中的 JAR key。
 */
export function normalizeJarRequestKey(rawKey: string): string {
  const suffixIndex = rawKey.search(/;(?:md5|pk);/i);
  return suffixIndex >= 0 ? rawKey.substring(0, suffixIndex) : rawKey;
}

/**
 * 判断 JAR key 是否为 MD5（32 位 hex）
 * 用于决定 Cache TTL：MD5 key → 24h，URL hash key → 6h
 */
export function isMd5Key(key: string): boolean {
  return /^[0-9a-f]{32}$/i.test(key);
}

export function uint8ArrayToBase64(data: Uint8Array): string {
  const chars = new Array<string>(data.length);
  for (let i = 0; i < data.length; i++) {
    chars[i] = String.fromCharCode(data[i]);
  }
  return btoa(chars.join(''));
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
