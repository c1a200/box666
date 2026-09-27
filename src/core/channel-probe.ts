// 频道级 URL 测速（方案 D+，仅 Node/Docker 跑）
// 独立模块：不阻塞主聚合，失败不影响聚合产出

import type { Storage } from '../storage/interface';
import type { TVBoxLiveGroup, ChannelSpeedMap, ChannelProbeStatus } from './types';
import {
  KV_CHANNEL_SPEED_MAP,
  KV_CHANNEL_PROBE_STATUS,
  KV_CHANNEL_PROBE_ENABLED,
  KV_CHANNEL_MERGED_TREE,
  KV_LIVE_MERGED_TXT,
  KV_LIVE_MERGED_TXT_VERSION,
  KV_LIVE_RUNTIME_TXT_VERSION,
  CHANNEL_PROBE_CONCURRENCY,
  CHANNEL_PROBE_TIMEOUT_MS,
  CHANNEL_SPEED_TTL_MS,
  TVBOX_UA,
} from './config';
import { applyChannelSpeedToGroups, extractAllUrls, formatLiveGroupsAsTxt } from './live-merger';

// ─── 开关/状态 ─────────────────────────────────────────

export async function isProbeEnabled(storage: Storage): Promise<boolean> {
  const v = await storage.get(KV_CHANNEL_PROBE_ENABLED);
  return v === 'true';
}

export async function setProbeEnabled(storage: Storage, enabled: boolean): Promise<void> {
  await storage.put(KV_CHANNEL_PROBE_ENABLED, enabled ? 'true' : 'false');
}

export async function loadStatus(storage: Storage): Promise<ChannelProbeStatus> {
  const raw = await storage.get(KV_CHANNEL_PROBE_STATUS);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ChannelProbeStatus;
      // 进程重启后内存中的 running 会归零，但持久化状态可能仍为 running。
      // 读取状态时直接纠正，避免管理页一直显示“运行中”并阻止手动重试。
      if (parsed.state === 'running' && !running) {
        const recovered: ChannelProbeStatus = {
          ...parsed,
          state: 'error',
          finishedAt: parsed.finishedAt || new Date().toISOString(),
          error: parsed.error || 'Previous run was interrupted by a service restart',
        };
        await saveStatus(storage, recovered);
        return recovered;
      }
      return parsed;
    } catch {
      /* fallthrough */
    }
  }
  return {
    state: 'idle',
    totalUrls: 0,
    probed: 0,
    success: 0,
    failed: 0,
    totalChannels: 0,
    coverage: 0,
  };
}

async function saveStatus(storage: Storage, status: ChannelProbeStatus): Promise<void> {
  await storage.put(KV_CHANNEL_PROBE_STATUS, JSON.stringify(status));
}

// ─── 测速缓存 ──────────────────────────────────────────

export async function loadSpeedMap(storage: Storage): Promise<ChannelSpeedMap> {
  const raw = await storage.get(KV_CHANNEL_SPEED_MAP);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSpeedMap(storage: Storage, map: ChannelSpeedMap): Promise<void> {
  await storage.put(KV_CHANNEL_SPEED_MAP, JSON.stringify(map));
}

/** 清理 7 天前的测速缓存 */
export function pruneExpired(map: ChannelSpeedMap): ChannelSpeedMap {
  const now = Date.now();
  const out: ChannelSpeedMap = {};
  for (const [url, entry] of Object.entries(map)) {
    const ts = Date.parse(entry.probedAt);
    if (isFinite(ts) && now - ts < CHANNEL_SPEED_TTL_MS) {
      out[url] = entry;
    }
  }
  return out;
}

// ─── 单 URL 测试 ───────────────────────────────────────

interface ProbeResult {
  url: string;
  speedMs: number;
  kind: 'm3u8' | 'ts' | 'tcp' | 'fail';
}

async function probeSingle(url: string, timeoutMs = CHANNEL_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const isM3U8 = /\.m3u8(\?|$)/i.test(url);
  const isTs = /\.(ts|flv|mp4)(\?|$)/i.test(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': TVBOX_UA },
    });
    const ttfb = Date.now() - start;

    if (!resp.ok) {
      clearTimeout(timer);
      return { url, speedMs: 0, kind: 'fail' };
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      clearTimeout(timer);
      return { url, speedMs: ttfb, kind: 'tcp' };
    }

    try {
      const { value } = await reader.read();
      clearTimeout(timer);
      if (!value) {
        return { url, speedMs: ttfb, kind: 'tcp' };
      }

      if (isM3U8) {
        const head = new TextDecoder().decode(value.slice(0, Math.min(1024, value.length)));
        if (head.includes('#EXTM3U')) {
          return { url, speedMs: ttfb, kind: 'm3u8' };
        }
        return { url, speedMs: 0, kind: 'fail' };
      }

      if (isTs) {
        // 检查 sync byte 0x47（4KB 内任何位置）
        const end = Math.min(4096, value.length);
        for (let i = 0; i < end; i += 188) {
          if (value[i] === 0x47) {
            return { url, speedMs: ttfb, kind: 'ts' };
          }
        }
        // 没找到 sync byte 也不一定失败（可能是 HTTP-FLV 等），用 tcp 标记
        return { url, speedMs: ttfb, kind: 'tcp' };
      }

      return { url, speedMs: ttfb, kind: 'tcp' };
    } finally {
      reader.cancel().catch(() => {});
    }
  } catch {
    clearTimeout(timer);
    return { url, speedMs: 0, kind: 'fail' };
  }
}

// ─── 并发池 ────────────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number, result: R) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  let done = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        // 兜底：fn 理论上已内部 try/catch；此路径保险返回显式 fail 对象
        results[i] = { url: String(items[i]), speedMs: 0, kind: 'fail' } as R;
      }
      done++;
      if (onProgress) onProgress(done, items.length, results[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Cloudflare 有界分轮测速 ──────────────────────────

export interface BoundedLiveProbeResult {
  candidates: number;
  probed: number;
  success: number;
  failed: number;
  skipped: boolean;
}

function parseMergedGroups(raw: string | null): TVBoxLiveGroup[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as TVBoxLiveGroup[] : [];
  } catch {
    return [];
  }
}

/**
 * 免费 Worker 专用：每次只测一小批直播 URL，避免子请求数、CPU 和时长超限。
 * 优先测未知、过期或上次失败的 URL；结果合并进现有测速表，不覆盖完整状态。
 */
export async function probeLiveUrlsBounded(
  storage: Storage,
  options: {
    maxUrls?: number;
    timeoutMs?: number;
    concurrency?: number;
    budgetMs?: number;
  } = {},
): Promise<BoundedLiveProbeResult> {
  const maxUrls = Math.max(1, Math.min(64, options.maxUrls ?? 28));
  const timeoutMs = Math.max(500, Math.min(8000, options.timeoutMs ?? 3000));
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 5));
  const budgetMs = Math.max(1000, Math.min(60000, options.budgetMs ?? 25000));
  const startedAt = Date.now();

  const groups = parseMergedGroups(await storage.get(KV_CHANNEL_MERGED_TREE));
  const allUrls = extractAllUrls(groups);
  if (allUrls.length === 0) {
    return { candidates: 0, probed: 0, success: 0, failed: 0, skipped: true };
  }

  const speedMap = pruneExpired(await loadSpeedMap(storage));
  const now = Date.now();
  const candidates = allUrls
    .map((url) => {
      const entry = speedMap[url];
      const probedAt = entry ? Date.parse(entry.probedAt) : NaN;
      const expired = !entry || !isFinite(probedAt) || now - probedAt >= CHANNEL_SPEED_TTL_MS;
      const priority = !entry ? 0 : entry.kind === 'fail' ? 1 : expired ? 2 : 3;
      return { url, priority, probedAt: isFinite(probedAt) ? probedAt : 0 };
    })
    .sort((a, b) => a.priority - b.priority || a.probedAt - b.probedAt)
    .slice(0, maxUrls);

  const results: ProbeResult[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (index < candidates.length && Date.now() - startedAt < budgetMs) {
      const candidate = candidates[index++];
      results.push(await probeSingle(candidate.url, timeoutMs));
    }
  });
  await Promise.all(workers);

  const probedAt = new Date().toISOString();
  let success = 0;
  let failed = 0;
  for (const result of results) {
    speedMap[result.url] = {
      speedMs: result.speedMs,
      probedAt,
      kind: result.kind,
    };
    if (result.kind === 'fail') failed++;
    else success++;
  }

  if (results.length > 0) {
    await saveSpeedMap(storage, speedMap);
    await storage.put(KV_LIVE_RUNTIME_TXT_VERSION, `probe-${Date.now()}`);
  }

  console.log(
    `[channel-probe] Bounded CF probe: ${results.length}/${candidates.length} URLs, ` +
    `${success} success, ${failed} failed`,
  );
  return { candidates: candidates.length, probed: results.length, success, failed, skipped: false };
}
// ─── 主入口 ────────────────────────────────────────────

let running = false;

export async function runChannelProbe(storage: Storage): Promise<ChannelProbeStatus> {
  if (running) {
    console.log('[channel-probe] Already running, skipping');
    return loadStatus(storage);
  }

  // loadStatus 已会把重启遗留的 running 纠正为 error，这里无需再次处理。

  if (!(await isProbeEnabled(storage))) {
    console.log('[channel-probe] Disabled by user, skipping');
    return loadStatus(storage);
  }

  // 读取上次合并的频道树
  const treeRaw = await storage.get(KV_CHANNEL_MERGED_TREE);
  if (!treeRaw) {
    console.log('[channel-probe] No merged tree available, skipping (run main aggregation first)');
    const status: ChannelProbeStatus = {
      state: 'error',
      totalUrls: 0,
      probed: 0,
      success: 0,
      failed: 0,
      totalChannels: 0,
      coverage: 0,
      error: 'No merged channel tree (run main aggregation first)',
    };
    await saveStatus(storage, status);
    return status;
  }

  let groups: TVBoxLiveGroup[];
  try {
    groups = JSON.parse(treeRaw);
  } catch (err) {
    const status: ChannelProbeStatus = {
      state: 'error',
      totalUrls: 0,
      probed: 0,
      success: 0,
      failed: 0,
      totalChannels: 0,
      coverage: 0,
      error: `Parse merged tree failed: ${err}`,
    };
    await saveStatus(storage, status);
    return status;
  }

  const urls = extractAllUrls(groups);
  const totalChannels = groups.reduce((n, g) => n + g.channels.length, 0);

  if (urls.length === 0) {
    const status: ChannelProbeStatus = {
      state: 'done',
      totalUrls: 0,
      probed: 0,
      success: 0,
      failed: 0,
      totalChannels,
      coverage: 0,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
    };
    await saveStatus(storage, status);
    return status;
  }

  running = true;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let success = 0;
  let failed = 0;

  const status: ChannelProbeStatus = {
    state: 'running',
    startedAt,
    totalUrls: urls.length,
    probed: 0,
    success: 0,
    failed: 0,
    totalChannels,
    coverage: 0,
  };
  await saveStatus(storage, status);

  console.log(`[channel-probe] Started: ${urls.length} URLs, ${totalChannels} channels, concurrency=${CHANNEL_PROBE_CONCURRENCY}`);

  try {
    // 先读旧缓存，复用未过期条目（减少重复测试）
    const oldMap = pruneExpired(await loadSpeedMap(storage));
    const fresh: ChannelSpeedMap = { ...oldMap };

    // 只测缓存里没有的 URL
    const toProbe = urls.filter((u) => !fresh[u]);
    console.log(`[channel-probe] ${toProbe.length} new URLs to probe (${urls.length - toProbe.length} cached)`);

    const cachedSuccess = urls.length - toProbe.length;
    success = cachedSuccess;
    status.success = success;
    status.probed = cachedSuccess;
    status.coverage = urls.length > 0 ? Math.round((success / urls.length) * 100) : 0;

    let lastProgressSave = 0;
    const results = await runWithConcurrency(
      toProbe,
      CHANNEL_PROBE_CONCURRENCY,
      (url) => probeSingle(url),
      (done, total, result) => {
        const probeResult = result as ProbeResult;
        if (probeResult.kind === 'fail') failed++;
        else success++;

        status.probed = cachedSuccess + done;
        status.success = success;
        status.failed = failed;
        status.coverage = urls.length > 0 ? Math.round((success / urls.length) * 100) : 0;

        // 状态写入节流：运行中最多每 250ms 写一次，避免 SQLite/KV 写放大。
        const now = Date.now();
        if (now - lastProgressSave >= 250 || done === total) {
          lastProgressSave = now;
          saveStatus(storage, { ...status }).catch(() => {});
        }
        if (done % 200 === 0 || done === total) {
          console.log(`[channel-probe] Progress: ${done}/${total}`);
        }
      },
    );
    const now = new Date().toISOString();
    for (const r of results) {
      fresh[r.url] = {
        speedMs: r.speedMs,
        probedAt: now,
        kind: r.kind,
      };
    }

    await saveSpeedMap(storage, fresh);

    // 测速完成后立即刷新 /live 的预生成内容。若过滤结果为空，保留上一版，
    // 避免一次异常测速把直播频道全部清空。
    const filteredGroups = applyChannelSpeedToGroups(groups, fresh);
    if (filteredGroups.length > 0) {
      const liveVersion = `probe-${Date.now()}`;
      await Promise.all([
        storage.put(KV_CHANNEL_MERGED_TREE, JSON.stringify(filteredGroups)),
        storage.put(KV_LIVE_MERGED_TXT, formatLiveGroupsAsTxt(filteredGroups)),
        storage.put(KV_LIVE_MERGED_TXT_VERSION, liveVersion),
        storage.put(KV_LIVE_RUNTIME_TXT_VERSION, liveVersion),
      ]);
    }

    const durationMs = Date.now() - startMs;
    const coverage = urls.length > 0 ? Math.round((success / urls.length) * 100) : 0;

    const finalStatus: ChannelProbeStatus = {
      state: 'done',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      totalUrls: urls.length,
      probed: urls.length,
      success,
      failed,
      totalChannels,
      coverage,
    };
    await saveStatus(storage, finalStatus);

    console.log(
      `[channel-probe] Done in ${(durationMs / 1000).toFixed(1)}s: ` +
      `${success} success, ${failed} failed, coverage=${coverage}%`,
    );

    return finalStatus;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errStatus: ChannelProbeStatus = {
      state: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      totalUrls: urls.length,
      probed: status.probed,
      success,
      failed,
      totalChannels,
      coverage: urls.length > 0 ? Math.round((success / urls.length) * 100) : 0,
      error: msg,
    };
    await saveStatus(storage, errStatus);
    console.error(`[channel-probe] Error: ${msg}`);
    return errStatus;
  } finally {
    running = false;
  }
}

export function isRunning(): boolean {
  return running;
}
