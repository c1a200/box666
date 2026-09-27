// 直播源处理：连通性测试 + CF 代理 URL 改写

import type { LiveSourceEntry, TVBoxLive } from './types';
import type { Storage } from '../storage/interface';
import { LIVE_PROXY_TTL } from './config';

const KV_LIVE_PREFIX = 'live:';

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
 * CF 模式：URL 改写为 /live/:key 代理路由，写 KV 映射
 * 本地模式：保持原始 URL，name 追加延迟
 */
export async function liveSourcesToTVBoxLives(
  entries: LiveSourceEntry[],
  workerBaseUrl: string | undefined,
  storage: Storage,
  speedMap?: Map<string, number>,
): Promise<TVBoxLive[]> {
  const lives: TVBoxLive[] = [];

  for (const entry of entries) {
    let url = entry.url;
    let name = entry.name;

    if (workerBaseUrl) {
      // CF 模式：改写 URL + 写 KV 代理映射
      const key = await urlToKey(entry.url);
      const proxySource: LiveProxySource = { url: entry.url };
      if (entry.name) proxySource.name = entry.name;
      if (entry.ua) proxySource.ua = entry.ua;
      if (entry.header) proxySource.header = entry.header;
      await storage.put(`${KV_LIVE_PREFIX}${key}`, JSON.stringify(proxySource));
      url = `${workerBaseUrl.replace(/\/$/, '')}/live/${key}`;
    } else if (speedMap) {
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

  if (workerBaseUrl) {
    console.log(`[live-source] Wrote ${entries.length} KV proxy mappings`);
  }

  return lives;
}

/**
 * 从 KV 查询直播源 key 对应的代理元数据。
 * 兼容旧版本只存原始 URL 字符串的映射。
 */
export async function lookupLiveSource(key: string, storage: Storage): Promise<LiveProxySource | null> {
  const raw = await storage.get(`${KV_LIVE_PREFIX}${key}`);
  if (!raw) return null;

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
