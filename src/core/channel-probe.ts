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
  KV_CHANNEL_PROBE_INTERVAL,
  KV_CHANNEL_MERGED_TREE,
  KV_CHANNEL_RUNTIME_TREE,
  KV_CHANNEL_CANDIDATE_URLS,
  KV_LIVE_MERGE_MODE,
  KV_LIVE_MERGED_TXT,
  KV_LIVE_MERGED_TXT_VERSION,
  KV_LIVE_RUNTIME_TXT_VERSION,
  CHANNEL_PROBE_CONCURRENCY,
  CHANNEL_PROBE_TIMEOUT_MS,
  CHANNEL_PROBE_BATCH_SIZE,
  DEFAULT_CHANNEL_PROBE_INTERVAL,
  CHANNEL_PROBE_INTERVALS,
  CHANNEL_SPEED_TTL_MS,
  TVBOX_UA,
  dailyCronFromTime,
} from './config';
import {
  bareLiveSourceUrl,
  extractAllUrls,
  extractPreferredLiveUrls,
  extractUrlsForSourceLabels,
  normalizeSourceLabelKey,
  parseLiveCandidatePool,
  parseLiveGroupsFromTxt,
  mergeAggregatedLiveGroups,
} from './live-merger';
import { rebuildLiveOutput } from './live-output';
import { isLiveProxyEntryDistributable, listAllLiveProxyEntries, liveProxyEntryLabel } from './live-source';
import { loadLiveDistribution, toLiveDistributionPolicy } from './live-distribution-store';
import { selectLiveDistribution } from './live-quality';
import {
  loadSpeedMap,
  saveSpeedMap,
  pruneExpired,
  selectProbeCandidates,
  CHANNEL_FAILURE_RETRY_MS,
  CHANNEL_PROBE_RESULT_VERSION,
} from './live-speed-store';

// ─── 开关/状态 ─────────────────────────────────────────

export async function isProbeEnabled(storage: Storage): Promise<boolean> {
  const v = await storage.get(KV_CHANNEL_PROBE_ENABLED);
  return v === 'true';
}

export async function setProbeEnabled(storage: Storage, enabled: boolean): Promise<void> {
  await storage.put(KV_CHANNEL_PROBE_ENABLED, enabled ? 'true' : 'false');
}

export function normalizeProbeInterval(value: unknown): number {
  const minutes = typeof value === 'number' ? value : parseInt(String(value ?? ''));
  return (CHANNEL_PROBE_INTERVALS as readonly number[]).includes(minutes)
    ? minutes
    : DEFAULT_CHANNEL_PROBE_INTERVAL;
}

export function intervalToChannelProbeCron(minutes: number, dailyTime = '05:00'): string {
  switch (normalizeProbeInterval(minutes)) {
    case 360: return '0 */6 * * *';
    case 1440: return dailyCronFromTime(dailyTime);
    default: return '0 */12 * * *';
  }
}

export async function loadProbeInterval(storage: Storage): Promise<number> {
  return normalizeProbeInterval(await storage.get(KV_CHANNEL_PROBE_INTERVAL));
}

export async function setProbeInterval(storage: Storage, minutes: number): Promise<number> {
  const normalized = normalizeProbeInterval(minutes);
  await storage.put(KV_CHANNEL_PROBE_INTERVAL, String(normalized));
  return normalized;
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
          phase: undefined,
          finishedAt: parsed.finishedAt || new Date().toISOString(),
          lastProgressAt: new Date().toISOString(),
          error: parsed.error || 'Previous run was interrupted; saved batches are preserved and a new run will resume from uncached URLs',
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
  verification?: 'manifest' | 'media';
  failureReason?: 'timeout' | 'http' | 'invalid' | 'network';
}

const HLS_MEDIA_CANDIDATE_LIMIT = 16;
const HLS_TIMEOUT_MULTIPLIER = 4;
const UNKNOWN_TIMEOUT_MULTIPLIER = 3;
const PROBE_RETRY_DELAY_MS = 350;

function resolvePlaylistUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).toString();
  } catch {
    return "";
  }
}

function hlsMediaCandidates(playlist: string, base: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const resolved = resolvePlaylistUrl(line, base);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    candidates.push(resolved);
    if (candidates.length >= HLS_MEDIA_CANDIDATE_LIMIT) break;
  }
  return candidates;
}

function isHlsPlaylist(text: string): boolean {
  return /#EXTM3U/i.test(text)
    && /#EXT-X-(?:STREAM-INF|MEDIA-SEQUENCE|TARGETDURATION|EXTINF)/i.test(text);
}

function probeRequestHeaders(referer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': TVBOX_UA,
    Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, video/mp2t, video/*, */*',
    'Accept-Encoding': 'identity',
  };
  if (referer) headers.Referer = referer;
  return headers;
}

async function readResponseHead(resp: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = resp.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const take = Math.min(value.length, maxBytes - total);
      chunks.push(value.subarray(0, take));
      total += take;
      if (take < value.length) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

interface FetchHeadResult {
  url: string;
  bytes: Uint8Array;
  text: string;
  contentType: string;
}

async function fetchHead(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  referer?: string,
): Promise<FetchHeadResult> {
  const resp = await fetch(url, {
    signal,
    headers: probeRequestHeaders(referer),
  });
  if (!resp.ok) throw Object.assign(new Error('http'), { failureReason: 'http' });
  const bytes = await readResponseHead(resp, maxBytes);
  return {
    // Relative segment URIs must be resolved against the final redirect target,
    // not the original URL that redirected to another CDN host.
    url: resp.url || url,
    bytes,
    text: new TextDecoder().decode(bytes),
    contentType: resp.headers.get('content-type') || '',
  };
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 2048)));
  return /<(?:!doctype\s+html|html|head|body)\b|cloudflare|attention required|error\s+5\d\d/i.test(head);
}

function isTsPacketHead(bytes: Uint8Array): boolean {
  if (bytes.length < 188 * 3) return false;
  // One 0x47 byte has a high random false-positive rate. Require three packet
  // sync bytes at the MPEG-TS packet stride, allowing a short transport prefix.
  const limit = Math.min(bytes.length - 188 * 3, 940);
  for (let offset = 0; offset <= limit; offset += 1) {
    if (bytes[offset] === 0x47
      && bytes[offset + 188] === 0x47
      && bytes[offset + 376] === 0x47) {
      return true;
    }
  }
  return false;
}

function looksLikePlayableMedia(bytes: Uint8Array, contentType: string): boolean {
  if (bytes.length < 4 || looksLikeHtml(bytes)) return false;
  if (isTsPacketHead(bytes)) return true;

  // FLV, fragmented MP4, WebM and ADTS/MPEG audio are common live payloads.
  if (bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56) return true;
  for (let offset = 0; offset <= Math.min(28, bytes.length - 8); offset += 4) {
    const box = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (box === 'ftyp' || box === 'styp' || box === 'moof') return true;
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return true;

  // Content-Type alone is weak evidence, but useful for unusual container bytes
  // after HTML/error and empty responses have already been rejected.
  if (/^video\//i.test(contentType)) return bytes.length >= 188;
  return /^audio\//i.test(contentType);
}

type ProbeFailureReason = NonNullable<ProbeResult['failureReason']>;

function failureReasonFromError(err: unknown, signal: AbortSignal): ProbeFailureReason {
  if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return 'timeout';
  if (err && typeof err === 'object' && 'failureReason' in err) {
    const reason = (err as { failureReason?: unknown }).failureReason;
    if (reason === 'timeout' || reason === 'http' || reason === 'invalid' || reason === 'network') {
      return reason;
    }
  }
  return 'network';
}

async function verifyHlsPlaylist(
  url: string,
  startedAt: number,
  signal: AbortSignal,
  depth = 0,
  referer?: string,
): Promise<ProbeResult> {
  const requestedUrl = resolvePlaylistUrl(url, referer || url) || url;
  const playlist = await fetchHead(requestedUrl, 512 * 1024, signal, referer);
  if (!isHlsPlaylist(playlist.text)) {
    return { url: requestedUrl, speedMs: 0, kind: 'fail', failureReason: 'invalid' };
  }

  // A redirected master/media playlist resolves its relative URIs from the
  // final response URL, which can be a different host and path.
  const playlistUrl = playlist.url || requestedUrl;
  const candidates = hlsMediaCandidates(playlist.text, playlistUrl);
  if (candidates.length === 0) {
    return { url: playlistUrl, speedMs: 0, kind: 'fail', failureReason: 'invalid' };
  }

  let validChildManifest = false;
  let sawHttpFailure = false;
  let sawNetworkFailure = false;
  for (const candidate of candidates) {
    try {
      // Segments only need a few TS packets to prove this is real media. Reading
      // 512 KiB from every candidate is slow and can itself cause false timeouts.
      const head = await fetchHead(candidate, 64 * 1024, signal, playlistUrl);
      if (isHlsPlaylist(head.text)) {
        validChildManifest = true;
        if (depth < 2) {
          const nested = await verifyHlsPlaylist(candidate, startedAt, signal, depth + 1, playlistUrl);
          if (nested.kind !== 'fail') return nested;
        }
        continue;
      }
      if (!looksLikePlayableMedia(head.bytes, head.contentType)) continue;

      // One verified media segment is sufficient evidence. Requiring a second
      // segment doubled the critical-path deadline and rejected healthy live
      // playlists while their CDN was temporarily slow.
      return { url: playlistUrl, speedMs: Date.now() - startedAt, kind: 'm3u8', verification: 'media' };
    } catch (err) {
      const reason = failureReasonFromError(err, signal);
      if (reason === 'timeout') {
        return { url: playlistUrl, speedMs: 0, kind: 'fail', failureReason: 'timeout' };
      }
      if (reason === 'http') sawHttpFailure = true;
      if (reason === 'network') sawNetworkFailure = true;
    }
  }
  if (validChildManifest) {
    return { url: playlistUrl, speedMs: Date.now() - startedAt, kind: 'm3u8', verification: 'manifest' };
  }
  return {
    url: playlistUrl,
    speedMs: 0,
    kind: 'fail',
    failureReason: sawNetworkFailure ? 'network' : sawHttpFailure ? 'http' : 'invalid',
  };
}

async function verifyHlsPlayback(url: string, startedAt: number, signal: AbortSignal): Promise<ProbeResult> {
  const result = await verifyHlsPlaylist(url, startedAt, signal);
  return result.url === url ? result : { ...result, url };
}

async function probeOnce(url: string, timeoutMs = CHANNEL_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const isM3U8 = /\.m3u8(?:\?|$)/i.test(url);
  const isDeclaredMedia = /\.(?:ts|flv|mp4)(?:\?|$)/i.test(url);

  const controller = new AbortController();
  const requestedTimeoutMs = Math.max(500, timeoutMs);
  // A playlist may redirect and then expose segments on another host. Give HLS
  // chains enough time to complete instead of treating normal CDN latency as a
  // dead line; unknown URLs may still turn out to be HLS after the first fetch.
  const effectiveTimeoutMs = isDeclaredMedia
    ? requestedTimeoutMs
    : isM3U8
      ? requestedTimeoutMs * HLS_TIMEOUT_MULTIPLIER
      : requestedTimeoutMs * UNKNOWN_TIMEOUT_MULTIPLIER;
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const attempt = async (): Promise<ProbeResult> => {
      if (isM3U8) return verifyHlsPlayback(url, start, controller.signal);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: probeRequestHeaders(),
      });
      const ttfb = Date.now() - start;
      if (!resp.ok) {
        return { url, speedMs: 0, kind: 'fail', failureReason: 'http' };
      }

      const bytes = await readResponseHead(resp, 64 * 1024);
      const contentType = resp.headers.get('content-type') || '';
      if (bytes.length === 0) {
        return { url, speedMs: 0, kind: 'fail', failureReason: 'invalid' };
      }

      const text = new TextDecoder().decode(bytes);
      if (isHlsPlaylist(text)) {
        return verifyHlsPlayback(url, start, controller.signal);
      }
      if (looksLikeHtml(bytes) || /^text\//i.test(contentType)) {
        return { url, speedMs: 0, kind: 'fail', failureReason: 'invalid' };
      }
      if (looksLikePlayableMedia(bytes, contentType)) {
        return { url, speedMs: ttfb, kind: 'ts', verification: 'media' };
      }
      if (isDeclaredMedia) {
        return { url, speedMs: 0, kind: 'fail', failureReason: 'invalid' };
      }
      return { url, speedMs: ttfb, kind: 'tcp' };
    };

    // AbortController normally stops fetch and stream reads. Promise.race is a
    // second, hard deadline for runtimes/transports that fail to settle on abort.
    const deadline = new Promise<ProbeResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ url, speedMs: 0, kind: 'fail', failureReason: 'timeout' });
      }, effectiveTimeoutMs);
    });
    return await Promise.race([attempt(), deadline]);
  } catch (err) {
    return { url, speedMs: 0, kind: 'fail', failureReason: failureReasonFromError(err, controller.signal) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRetryableProbeFailure(result: ProbeResult): boolean {
  return result.kind === 'fail'
    && (result.failureReason === 'timeout' || result.failureReason === 'network');
}

async function probeSingle(
  url: string,
  timeoutMs = CHANNEL_PROBE_TIMEOUT_MS,
  options: { retryTransient?: boolean } = {},
): Promise<ProbeResult> {
  const first = await probeOnce(url, timeoutMs);
  if (!options.retryTransient || !isRetryableProbeFailure(first)) return first;

  await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_DELAY_MS));
  const retried = await probeOnce(url, timeoutMs);
  if (retried.kind !== 'fail') return retried;
  // Preserve a timeout/network cause even when the second attempt classifies a
  // malformed response as invalid; diagnostics should identify the real issue.
  return first.failureReason === 'timeout' || first.failureReason === 'network' ? first : retried;
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

  // 运行时 TXT 只保留当前下发前沿（每频道线路数由下发配置决定），候选索引保留完整去重线路。
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

  const groups = mergeAggregatedLiveGroups(await loadCandidateTree(storage));
  const allUrls = extractAllUrls(groups);
  if (allUrls.length === 0) {
    return { candidates: 0, probed: 0, success: 0, failed: 0, skipped: true };
  }

  const speedMap = pruneExpired(await loadSpeedMap(storage));
  // 优先探测真正进入下发前沿的线路，避免把有限的 CF 子请求预算
  // 消耗在大量永远排不上的后台候选上。
  const allEntries = await listAllLiveProxyEntries(storage);
  const config = await loadLiveDistribution(storage);
  const selected = selectLiveDistribution(
    allEntries.filter(isLiveProxyEntryDistributable),
    toLiveDistributionPolicy(config),
  );
  const selectedLabels = new Set<string>();
  for (const entry of selected) {
    const label = liveProxyEntryLabel(entry, groups);
    if (label) selectedLabels.add(normalizeSourceLabelKey(label));
  }
  const frontierUrls = selectedLabels.size > 0
    ? extractUrlsForSourceLabels(groups, selectedLabels)
    : [];
  const frontierSet = new Set(frontierUrls.map(bareLiveSourceUrl));
  const backgroundUrls = allUrls.filter((url) => !frontierSet.has(bareLiveSourceUrl(url)));
  const now = Date.now();
  const frontierCandidates = selectProbeCandidates(frontierUrls, speedMap, now, maxUrls);
  const backgroundCandidates = selectProbeCandidates(backgroundUrls, speedMap, now, maxUrls);
  const seenCandidate = new Set<string>();
  const candidates = [...frontierCandidates, ...backgroundCandidates]
    .filter((item) => {
      const bare = bareLiveSourceUrl(item.url);
      if (!bare || seenCandidate.has(bare)) return false;
      seenCandidate.add(bare);
      return true;
    })
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
  let stateChanged = false;
  for (const result of results) {
    const previous = speedMap[result.url];
    const isFailed = result.kind === 'fail';
    if (!previous
      || previous.kind !== result.kind
      || previous.verification !== result.verification
      || previous.probeVersion !== CHANNEL_PROBE_RESULT_VERSION) {
      stateChanged = true;
    }
    speedMap[result.url] = {
      speedMs: result.speedMs,
      probedAt,
      kind: result.kind,
      probeVersion: CHANNEL_PROBE_RESULT_VERSION,
      ...(result.verification ? { verification: result.verification } : {}),
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(isFailed ? { consecutiveFailures: (previous?.consecutiveFailures || 0) + 1 } : {}),
    };
    if (result.kind === 'fail') failed++;
    else success++;
  }

  if (results.length > 0) {
    await saveSpeedMap(storage, speedMap);

    // 测速只更新中立缓存；只有成功↔失败状态变化才会改变可下发线路。
    // 纯速度抖动不应重复重建 runtime TXT/版本键，否则每次 cron 都会
    // 写多份 KV，免费额度会在几个小时内被打满。
    if (stateChanged) {
      await rebuildLiveOutput(storage, { reason: 'bounded-probe' });
    }
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

  const groups = mergeAggregatedLiveGroups(await loadCandidateTree(storage));
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
  const selected = selectLiveDistribution(
    allEntries.filter(isLiveProxyEntryDistributable),
    toLiveDistributionPolicy(config),
  );
  const selectedLabels = new Set<string>();
  for (const entry of selected) {
    const label = liveProxyEntryLabel(entry, groups);
    if (label) selectedLabels.add(normalizeSourceLabelKey(label));
  }

  // Cover enough of each multi-line channel that bad/duplicate entries cannot
  // consume every priority slot before a genuinely playable line is tested.
  const speedMap = pruneExpired(await loadSpeedMap(storage));
  const configuredLimit = config.maxUrlsPerChannel;
  const priorityLimit = configuredLimit > 0 ? Math.max(2, configuredLimit * 2) : 18;
  const runtimeTxt = await storage.get(KV_LIVE_MERGED_TXT);
  const currentFrontier = runtimeTxt
    ? mergeAggregatedLiveGroups(parseLiveGroupsFromTxt(runtimeTxt))
    : [];
  const priority = new Set<string>();
  const multiLineOnly = (sourceGroups: readonly TVBoxLiveGroup[]): TVBoxLiveGroup[] =>
    sourceGroups
      .map((group) => ({
        group: group.group,
        channels: (group.channels || []).filter((channel) => (channel.urls || []).length > 1),
      }))
      .filter((group) => group.channels.length > 0);
  for (const url of extractPreferredLiveUrls(multiLineOnly(currentFrontier), speedMap, priorityLimit)) {
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
    for (const url of extractPreferredLiveUrls(multiLineOnly(selectedCandidateGroups), speedMap, priorityLimit)) {
      priority.add(url);
    }
  }
  const priorityUrls = Array.from(priority);
  const prioritySet = new Set(priorityUrls);

  running = true;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const fresh: ChannelSpeedMap = {};
  const status: ChannelProbeStatus = {
    state: 'running',
    trigger,
    phase: 'priority',
    startedAt,
    lastProgressAt: startedAt,
    totalUrls: urls.length,
    probed: 0,
    priorityUrls: priorityUrls.length,
    priorityProbed: 0,
    backgroundProbed: 0,
    success: 0,
    failed: 0,
    totalChannels,
    coverage: 0,
    remaining: urls.length,
  };

  try {
    Object.assign(fresh, pruneExpired(await loadSpeedMap(storage)));
    const probeNow = Date.now();
    const priorityCandidates = selectProbeCandidates(priorityUrls, fresh, probeNow);
    const backgroundCandidates = selectProbeCandidates(
      urls.filter((url) => !prioritySet.has(url)),
      fresh,
      probeNow,
    );

    const recalculate = (): void => {
      let successCount = 0;
      let failedCount = 0;
      let probedCount = 0;
      let priorityCount = 0;
      let backgroundCount = 0;
      for (const url of urls) {
        const entry = fresh[url];
        if (!entry) continue;
        probedCount++;
        if (prioritySet.has(url)) priorityCount++;
        else backgroundCount++;
        if (entry.kind === 'fail') failedCount++;
        else successCount++;
      }
      status.probed = probedCount;
      status.priorityProbed = priorityCount;
      status.backgroundProbed = backgroundCount;
      status.success = successCount;
      status.failed = failedCount;
      status.coverage = urls.length > 0 ? Math.round((successCount / urls.length) * 100) : 0;
      status.remaining = Math.max(0, urls.length - probedCount);
    };
    recalculate();
    await saveStatus(storage, { ...status });

    console.log(
      '[channel-probe] Started: ' + urls.length + ' total URLs, ' +
      priorityUrls.length + ' priority URLs, ' + totalChannels + ' channels, concurrency=' +
      CHANNEL_PROBE_CONCURRENCY + ', batch=' + CHANNEL_PROBE_BATCH_SIZE + ', trigger=' + trigger,
    );

    const persistBatch = async (
      phase: 'priority' | 'background',
      batch: readonly string[],
      results: readonly ProbeResult[],
    ): Promise<void> => {
      const probedAt = new Date().toISOString();
      for (const result of results) {
        const previous = fresh[result.url];
        const failed = result.kind === 'fail';
        fresh[result.url] = {
          speedMs: result.speedMs,
          probedAt,
          kind: result.kind,
          probeVersion: CHANNEL_PROBE_RESULT_VERSION,
          ...(result.verification ? { verification: result.verification } : {}),
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
          ...(failed ? { consecutiveFailures: (previous?.consecutiveFailures || 0) + 1 } : {}),
        };
      }
      await saveSpeedMap(storage, fresh);
      status.phase = phase;
      status.lastProgressAt = new Date().toISOString();
      recalculate();
      await saveStatus(storage, { ...status });
      console.log(
        `[channel-probe] ${phase} progress: ${status.probed}/${urls.length}; ` +
        `${batch.length} URLs in the last saved batch`,
      );
    };

    const runPhase = async (
      phase: 'priority' | 'background',
      candidates: readonly { url: string }[],
    ): Promise<void> => {
      status.phase = phase;
      status.lastProgressAt = new Date().toISOString();
      await saveStatus(storage, { ...status });
      console.log(`[channel-probe] ${phase} probe: ${candidates.length} due URLs`);
      for (let offset = 0; offset < candidates.length; offset += CHANNEL_PROBE_BATCH_SIZE) {
        const batch = candidates
          .slice(offset, offset + CHANNEL_PROBE_BATCH_SIZE)
          .map((item) => item.url);
        const results = await runWithConcurrency(
          batch,
          CHANNEL_PROBE_CONCURRENCY,
          // Priority URLs are the lines most likely to be distributed. Give
          // transient timeouts/network errors one second chance; background
          // candidates stay single-attempt to keep the full scan bounded.
          (url) => probeSingle(url, CHANNEL_PROBE_TIMEOUT_MS, { retryTransient: phase === 'priority' }),
        );
        await persistBatch(phase, batch, results);
      }
    };

    const persistOutput = async (reason: string): Promise<void> => {
      recalculate();
      await saveSpeedMap(storage, fresh);
      await rebuildLiveOutput(storage, { reason });
      status.phase = 'finalizing';
      status.lastProgressAt = new Date().toISOString();
      await saveStatus(storage, { ...status });
    };

    await runPhase('priority', priorityCandidates);
    await persistOutput('channel-probe-priority');
    await runPhase('background', backgroundCandidates);
    await persistOutput('channel-probe-background');

    recalculate();
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    const finalStatus: ChannelProbeStatus = {
      ...status,
      state: 'done',
      phase: undefined,
      finishedAt,
      lastProgressAt: finishedAt,
      durationMs,
      totalUrls: urls.length,
      totalChannels,
    };
    await saveStatus(storage, finalStatus);
    console.log(
      '[channel-probe] Done in ' + (durationMs / 1000).toFixed(1) + 's: ' +
      status.priorityProbed + ' priority + ' + status.backgroundProbed + ' background covered; ' +
      status.success + ' success, ' + status.failed + ' failed, ' + status.remaining + ' remaining',
    );
    return finalStatus;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date().toISOString();
    const errStatus: ChannelProbeStatus = {
      ...status,
      state: 'error',
      phase: undefined,
      finishedAt,
      lastProgressAt: finishedAt,
      durationMs: Date.now() - startMs,
      totalUrls: urls.length,
      totalChannels,
      error: msg,
    };
    try {
      await saveSpeedMap(storage, fresh);
      await saveStatus(storage, errStatus);
    } catch (persistError) {
      console.error('[channel-probe] Failed to persist interrupted status:', persistError);
    }
    console.error('[channel-probe] Error: ' + msg);
    return errStatus;
  } finally {
    running = false;
  }
}

export function isRunning(): boolean {
  return running;
}
