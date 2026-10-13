// 频道级 URL 测速（方案 D+，仅 Node/Docker 跑）
// 独立模块：不阻塞主聚合，失败不影响聚合产出

import type { Storage } from '../storage/interface';
import type {
  TVBoxLiveGroup,
  ChannelSpeedMap,
  ChannelProbeStatus,
  ChannelProbeTrigger,
} from './types';
import {
  KV_CHANNEL_SPEED_MAP,
  KV_CHANNEL_PROBE_STATUS,
  KV_CHANNEL_PROBE_ENABLED,
  KV_CHANNEL_MERGED_TREE,
  KV_CHANNEL_RUNTIME_TREE,
  KV_CHANNEL_CANDIDATE_URLS,
  KV_LIVE_MERGE_MODE,
  KV_LIVE_MERGED_TXT,
  KV_LIVE_MERGED_TXT_VERSION,
  KV_LIVE_RUNTIME_TXT_VERSION,
  CHANNEL_PROBE_CONCURRENCY,
  CHANNEL_PROBE_TIMEOUT_MS,
  CHANNEL_SPEED_TTL_MS,
  TVBOX_UA,
} from './config';
import {
  bareLiveSourceUrl,
  extractAllUrls,
  extractPreferredLiveUrls,
  extractUrlsForSourceLabels,
  normalizeSourceLabelKey,
  parseLiveCandidatePool,
  parseLiveGroupsFromTxt,
} from './live-merger';
import { rebuildLiveOutput } from './live-output';
import { listAllLiveProxyEntries, liveProxyEntryLabel } from './live-source';
import { loadLiveDistribution, toLiveDistributionPolicy } from './live-distribution-store';
import { selectLiveDistribution } from './live-quality';
import {
  loadSpeedMap,
  saveSpeedMap,
  pruneExpired,
  selectProbeCandidates,
  CHANNEL_FAILURE_RETRY_MS,
} from './live-speed-store';

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

export { loadSpeedMap, saveSpeedMap, pruneExpired, selectProbeCandidates, CHANNEL_FAILURE_RETRY_MS };

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

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
 * 候选池恢复顺序：
 * 1. 本进程/本机仍有完整合并树时优先使用；
 * 2. Render 重启后完整树丢失，优先使用持久化的结构化候选快照，恢复完整树；
 * 3. 仅旧版裸 URL 索引时，与运行时前沿合并后仅供补测，不用于重建输出。
 */
async function loadCandidateTree(storage: Storage): Promise<TVBoxLiveGroup[]> {
  const merged = parseMergedGroups(await storage.get(KV_CHANNEL_MERGED_TREE));
  if (merged.length > 0) return merged;

  const persisted = parseLiveCandidatePool(await storage.get(KV_CHANNEL_CANDIDATE_URLS));
  if (persisted.source === 'structured') return persisted.groups;

  const runtime = parseMergedGroups(await storage.get(KV_CHANNEL_RUNTIME_TREE));
  const runtimeTxt = runtime.length === 0 ? await storage.get(KV_LIVE_MERGED_TXT) : null;
  const recoveredGroups = runtime.length > 0
    ? runtime
    : runtimeTxt
      ? parseLiveGroupsFromTxt(runtimeTxt)
      : [];
  const candidateUrls = persisted.source === 'legacy-urls' ? persisted.urls : [];
  if (candidateUrls.length === 0) return recoveredGroups;
  if (recoveredGroups.length === 0) {
    return [{ group: '候选恢复', channels: [{ name: '全部线路', urls: candidateUrls }] }];
  }

  // 运行时 TXT 只保留当前下发前沿（每频道最多 9 条），候选索引保留完整去重线路。
  // 将前沿未覆盖的 URL 补进“候选恢复”分组，专门供后台补测；输出重建仍使用
  // 带频道结构的运行时树，不会把这两个候选线路误当成正式频道下发。
  const frontierUrls = new Set(extractAllUrls(recoveredGroups));
  const remaining = candidateUrls.filter((url) => !frontierUrls.has(bareLiveSourceUrl(url)));
  if (remaining.length === 0) return recoveredGroups;
  return [...recoveredGroups, { group: '候选恢复', channels: [{ name: '全部线路', urls: remaining }] }];
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

  const groups = await loadCandidateTree(storage);
  const allUrls = extractAllUrls(groups);
  if (allUrls.length === 0) {
    return { candidates: 0, probed: 0, success: 0, failed: 0, skipped: true };
  }

  const speedMap = pruneExpired(await loadSpeedMap(storage));
  const candidates = selectProbeCandidates(allUrls, speedMap, Date.now(), maxUrls);

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

    // 测速只更新中立缓存；运行时输出必须由统一下发策略重建，
    // 避免测速结果绕过分区/屏蔽/数量门禁。
    await rebuildLiveOutput(storage, { reason: 'bounded-probe' });
  }

  console.log(
    `[channel-probe] Bounded CF probe: ${results.length}/${candidates.length} URLs, ` +
    `${success} success, ${failed} failed`,
  );
  return { candidates: candidates.length, probed: results.length, success, failed, skipped: false };
}
// ─── 主入口 ────────────────────────────────────────────

let running = false;

export async function runChannelProbe(
  storage: Storage,
  options: { trigger?: ChannelProbeTrigger } = {},
): Promise<ChannelProbeStatus> {
  const trigger = options.trigger ?? 'manual';
  if (running) {
    console.log('[channel-probe] Already running, skipping');
    return loadStatus(storage);
  }

  if (!(await isProbeEnabled(storage))) {
    console.log('[channel-probe] Disabled by user, skipping');
    return loadStatus(storage);
  }

  const groups = await loadCandidateTree(storage);
  if (groups.length === 0) {
    const status: ChannelProbeStatus = {
      state: 'error',
      trigger,
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

  const urls = extractAllUrls(groups);
  const totalChannels = groups.reduce((n, g) => n + g.channels.length, 0);
  if (urls.length === 0) {
    const status: ChannelProbeStatus = {
      state: 'done',
      trigger,
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

  const allEntries = await listAllLiveProxyEntries(storage);
  const config = await loadLiveDistribution(storage);
  const selected = selectLiveDistribution(allEntries, toLiveDistributionPolicy(config));
  const selectedLabels = new Set<string>();
  for (const entry of selected) {
    const label = liveProxyEntryLabel(entry, groups);
    if (label) selectedLabels.add(normalizeSourceLabelKey(label));
  }

  // 优先集合的用途是“尽快让真正进入下发的频道线路得到速度证据”，
  // 不是“把所选源的全部线路先测一遍”。单线路频道没有线路选择价值，
  // 因此优先阶段只覆盖多线路频道，每频道最多取前 2 条；其余线路均由后台补测。
  const speedMap = pruneExpired(await loadSpeedMap(storage));
  const runtimeTxt = await storage.get(KV_LIVE_MERGED_TXT);
  const currentFrontier = runtimeTxt ? parseLiveGroupsFromTxt(runtimeTxt) : [];
  const priority = new Set<string>();
  const multiLineOnly = (source: readonly TVBoxLiveGroup[]): TVBoxLiveGroup[] =>
    source
      .map((group) => ({
        group: group.group,
        channels: (group.channels || []).filter((channel) => (channel.urls || []).length > 1),
      }))
      .filter((group) => group.channels.length > 0);
  for (const url of extractPreferredLiveUrls(multiLineOnly(currentFrontier), speedMap, 2)) {
    priority.add(url);
  }

  const selectedBareUrls = selectedLabels.size > 0
    ? new Set(extractUrlsForSourceLabels(groups, selectedLabels))
    : new Set<string>();
  if (selectedBareUrls.size > 0) {
    const selectedCandidateGroups: TVBoxLiveGroup[] = groups.map((group) => ({
      group: group.group,
      channels: (group.channels || []).map((channel) => ({
        name: channel.name,
        urls: (channel.urls || []).filter((url) => selectedBareUrls.has(bareLiveSourceUrl(url))),
      })),
    }));
    for (const url of extractPreferredLiveUrls(multiLineOnly(selectedCandidateGroups), speedMap, 2)) {
      priority.add(url);
    }
  }
  const priorityUrls = Array.from(priority);
  const prioritySet = new Set(priorityUrls);

  running = true;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const status: ChannelProbeStatus = {
    state: 'running',
    trigger,
    startedAt,
    totalUrls: urls.length,
    probed: 0,
    priorityUrls: priorityUrls.length,
    priorityProbed: 0,
    backgroundProbed: 0,
    success: 0,
    failed: 0,
    totalChannels,
    coverage: 0,
  };
  await saveStatus(storage, status);

  console.log(
    '[channel-probe] Started: ' + urls.length + ' total URLs, ' +
    priorityUrls.length + ' priority URLs, ' + totalChannels + ' channels, concurrency=' +
    CHANNEL_PROBE_CONCURRENCY + ', trigger=' + trigger,
  );

  try {
    const fresh: ChannelSpeedMap = { ...pruneExpired(await loadSpeedMap(storage)) };
    const probeNow = Date.now();
    const priorityCandidates = selectProbeCandidates(
      priorityUrls,
      fresh,
      probeNow,
      Number.POSITIVE_INFINITY,
    );
    const backgroundCandidates = selectProbeCandidates(
      urls.filter((url) => !prioritySet.has(url)),
      fresh,
      probeNow,
      Number.POSITIVE_INFINITY,
    );
    let priorityProbed = 0;
    let backgroundProbed = 0;
    let lastProgressSave = 0;

    const recalculate = (): void => {
      let successCount = 0;
      let failedCount = 0;
      for (const url of urls) {
        const entry = fresh[url];
        if (!entry) continue;
        if (entry.kind === 'fail') failedCount++;
        else successCount++;
      }
      status.success = successCount;
      status.failed = failedCount;
      status.coverage = urls.length > 0 ? Math.round((successCount / urls.length) * 100) : 0;
    };
    recalculate();

    const makeProgressHandler = (phase: 'priority' | 'background') =>
      (done: number, total: number, result: ProbeResult): void => {
        fresh[result.url] = {
          speedMs: result.speedMs,
          probedAt: new Date().toISOString(),
          kind: result.kind,
        };
        if (phase === 'priority') priorityProbed = done;
        else backgroundProbed = done;
        status.probed = priorityProbed + backgroundProbed;
        status.priorityProbed = priorityProbed;
        status.backgroundProbed = backgroundProbed;
        recalculate();

        const now = Date.now();
        if (now - lastProgressSave >= 250 || done === total) {
          lastProgressSave = now;
          saveStatus(storage, { ...status }).catch(() => {});
        }
        if (done % 200 === 0 || done === total) {
          console.log('[channel-probe] ' + phase + ' progress: ' + done + '/' + total);
        }
      };

    const persist = async (reason: string): Promise<void> => {
      recalculate();
      await saveSpeedMap(storage, fresh);
      await rebuildLiveOutput(storage, { reason });
      await saveStatus(storage, { ...status });
    };

    if (priorityCandidates.length > 0) {
      console.log(
        '[channel-probe] Priority probe: ' + priorityCandidates.length + ' new URLs (' +
        (priorityUrls.length - priorityCandidates.length) + ' cached)',
      );
      await runWithConcurrency(
        priorityCandidates.map((item) => item.url),
        CHANNEL_PROBE_CONCURRENCY,
        (url) => probeSingle(url),
        makeProgressHandler('priority'),
      );
    } else {
      console.log('[channel-probe] Priority probe: all ' + priorityUrls.length + ' URLs cached');
    }
    await persist('channel-probe-priority');

    if (backgroundCandidates.length > 0) {
      console.log('[channel-probe] Background probe: ' + backgroundCandidates.length + ' new URLs');
      await runWithConcurrency(
        backgroundCandidates.map((item) => item.url),
        CHANNEL_PROBE_CONCURRENCY,
        (url) => probeSingle(url),
        makeProgressHandler('background'),
      );
      await persist('channel-probe-background');
    }

    recalculate();
    const durationMs = Date.now() - startMs;
    const finalStatus: ChannelProbeStatus = {
      state: 'done',
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      totalUrls: urls.length,
      probed: priorityProbed + backgroundProbed,
      priorityUrls: priorityUrls.length,
      priorityProbed,
      backgroundProbed,
      success: status.success,
      failed: status.failed,
      totalChannels,
      coverage: status.coverage,
    };
    await saveStatus(storage, finalStatus);
    console.log(
      '[channel-probe] Done in ' + (durationMs / 1000).toFixed(1) + 's: ' +
      priorityProbed + ' priority + ' + backgroundProbed + ' background probed, ' +
      status.success + ' success, ' + status.failed + ' failed',
    );
    return finalStatus;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errStatus: ChannelProbeStatus = {
      state: 'error',
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      totalUrls: urls.length,
      probed: status.probed,
      priorityUrls: priorityUrls.length,
      priorityProbed: status.priorityProbed,
      backgroundProbed: status.backgroundProbed,
      success: status.success,
      failed: status.failed,
      totalChannels,
      coverage: status.coverage,
      error: msg,
    };
    await saveStatus(storage, errStatus);
    console.error('[channel-probe] Error: ' + msg);
    return errStatus;
  } finally {
    running = false;
  }
}

export function isRunning(): boolean {
  return running;
}
