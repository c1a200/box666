import type { Storage } from '../storage/interface';
import { KV_LIVE_PREPARE_STATE, KV_LIVE_TEXT_PREFIX, KV_CHANNEL_MERGED_TREE, KV_CHANNEL_CANDIDATE_URLS, KV_LIVE_MERGE_REPORT, KV_LIVE_MERGE_MODE } from './config';
import type { LiveSourceInput } from './live-merger';
import {
  applyChannelSpeedToGroups,
  filterLiveSourcesDetailed,
  formatLiveGroupsAsTxt,
  mergeLiveCandidateTreeSources,
} from './live-merger';
import { listLiveProxyEntries, pruneLiveProxyManifestToUrls, updateLiveProxyManifest, type LiveProxyEntryHint, type LiveProxyManifestEntry } from './live-source';
import { loadLivePrepareInputs, livePrepareInputSignature, type LivePrepareInputSet } from './live-inputs';
import { loadPublishedSpeedMap } from './live-speed-store';
import { rebuildLiveOutput } from './live-output';
import type { TVBoxLiveGroup } from './types';
import { parseLiveCandidatePool, parseLiveGroupsFromTxt, serializeLiveCandidatePool } from './live-merger';
import type { LiveCategory } from './live-quality';
import type { ChannelSpeedMap } from './types';

export interface LivePrepareState {
  cursor: number;
  sourceSignature: string;
  inputUpdatedAt: string;
  updatedAt: string;
  processed: number;
  total: number;
  ready: number;
  failed: number;
  complete: boolean;
}

function parseState(raw: string | null): LivePrepareState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LivePrepareState>;
    if (typeof parsed.cursor !== 'number' || typeof parsed.sourceSignature !== 'string') return null;
    return {
      cursor: Math.max(0, Math.floor(parsed.cursor)),
      sourceSignature: parsed.sourceSignature,
      inputUpdatedAt: typeof parsed.inputUpdatedAt === 'string' ? parsed.inputUpdatedAt : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      processed: Number.isFinite(parsed.processed) ? Math.max(0, Math.floor(parsed.processed as number)) : 0,
      total: Number.isFinite(parsed.total) ? Math.max(0, Math.floor(parsed.total as number)) : 0,
      ready: Number.isFinite(parsed.ready) ? Math.max(0, Math.floor(parsed.ready as number)) : 0,
      failed: Number.isFinite(parsed.failed) ? Math.max(0, Math.floor(parsed.failed as number)) : 0,
      complete: parsed.complete === true,
    };
  } catch {
    return null;
  }
}

function parseGroups(raw: string | null): TVBoxLiveGroup[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as TVBoxLiveGroup[] : [];
  } catch {
    return [];
  }
}

export function livePrepareStateMatchesInputs(
  state: LivePrepareState | null,
  inputSet: LivePrepareInputSet | null,
): boolean {
  return !!state
    && !!inputSet
    && state.sourceSignature === inputSet.signature
    && state.inputUpdatedAt === inputSet.updatedAt;
}

function sourceSignature(sources: readonly LiveSourceInput[]): string {
  // 与 live-inputs 的持久化签名保持完全一致，避免输入未变也开启新一轮。
  return livePrepareInputSignature(sources);
}

/**
 * CF 免费 Worker 不能在单轮内下载全部直播源。按游标每轮只处理一小批，
 * 并把成功结果的文本和源质量持久化；未处理或失败的源保持 textReady=false，
 * 因而不会进入下发池，也不会让应用端在请求路径承担上游超时。
 */
export async function prepareLiveSourcesChunk(
  sources: LiveSourceInput[],
  storage: Storage,
  options: {
    batchSize?: number;
    timeoutMs?: number;
    concurrency?: number;
    channelSpeedMap?: ChannelSpeedMap;
    inputUpdatedAt?: string;
  } = {},
): Promise<LivePrepareState> {
  const total = sources.length;
  const signature = sourceSignature(sources);
  const previous = parseState(await storage.get(KV_LIVE_PREPARE_STATE));
  const sameSourceSet = previous?.sourceSignature === signature
    && (!options.inputUpdatedAt || previous?.inputUpdatedAt === options.inputUpdatedAt);
  const startsNewRound = !sameSourceSet || previous?.complete === true;
  if (startsNewRound) {
    // 新一轮必须先裁剪上一轮已不存在的入口，防止幽灵源借旧 manifest/文本继续下发。
    await pruneLiveProxyManifestToUrls(sources.map((source) => source.url), storage);
  }
  const start = startsNewRound ? 0 : Math.min(previous?.cursor ?? 0, total);
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 8));
  const batch = sources.slice(start, start + batchSize);

  let ready = 0;
  let failed = 0;
  if (batch.length > 0) {
    const validated = await filterLiveSourcesDetailed(
      batch,
      options.timeoutMs ?? 6000,
      undefined,
      {
        storage,
        concurrency: Math.max(1, options.concurrency ?? 3),
        minChannelsPerSource: 5,
        maxAdRatio: 0.5,
        // 不按整源可播率淘汰：单条可播线路也可能承载高频频道，最终由
        // applyChannelSpeedToGroups 的频道级验真/后备逻辑决定是否下发。
        minPlayableRatio: 0,
        maxUrlsPerChannel: -1,
        maxChannels: 12000,
        useCache: true,
      },
    );
    const hints: Record<string, LiveProxyEntryHint> = {};
    for (const source of batch) {
      const category = validated.categories[source.url];
      hints[source.url] = {
        kind: source.isAggregated === false ? 'manual' : 'aggregated',
        ...(category ? { category: category as LiveCategory } : {}),
      };
    }

    // 单源文本也必须经过频道级验真门禁后再落盘。否则“源可下载”会被误当成
    // “线路可播放”，应用端拿到的 /live/<key> 仍会大面积 404/5xx。
    const gatedTexts: Record<string, string> = {};
    const gatedValid: string[] = [];
    const gatedTransient: string[] = [];
    for (const source of validated.valid) {
      const rawText = validated.texts[source.url];
      if (!rawText) {
        gatedTransient.push(source.url);
        continue;
      }
      const gatedGroups = applyChannelSpeedToGroups(
        parseLiveGroupsFromTxt(rawText),
        options.channelSpeedMap || {},
        undefined,
        64,
        { requirePlaybackVerification: false },
      );
      const gatedText = gatedGroups.length > 0 ? formatLiveGroupsAsTxt(gatedGroups) : '';
      if (gatedText.includes('#genre#')) {
        gatedTexts[source.url] = gatedText;
        gatedValid.push(source.url);
      } else {
        // 结构解析成功、但当前测速结果暂时没有可下发线路，只能说明
        // “此刻质量不足”，不能据此撤销成熟正文或把源永久判废。
        gatedTransient.push(source.url);
      }
    }
    await updateLiveProxyManifest(
      batch.map((source) => ({
        name: source.name,
        url: source.url,
        ua: source.ua,
        header: source.header,
      })),
      storage,
      {
        validUrls: gatedValid,
        transientUrls: [
          ...validated.transient.map((source) => source.url),
          ...gatedTransient,
        ],
        invalidUrls: validated.invalid.map((source) => source.url),
        metrics: validated.metrics,
        hints,
        texts: gatedTexts,
        incremental: true,
        checkedAt: new Date().toISOString(),
      },
    );
    ready = gatedValid.length;
    failed = batch.length - ready;
  }

  const nextCursor = Math.min(total, start + batch.length);
  const baseReady = startsNewRound ? 0 : (previous?.ready ?? 0);
  const baseFailed = startsNewRound ? 0 : (previous?.failed ?? 0);
  const next: LivePrepareState = {
    cursor: nextCursor,
    sourceSignature: signature,
    inputUpdatedAt: options.inputUpdatedAt ?? previous?.inputUpdatedAt ?? '',
    updatedAt: new Date().toISOString(),
    processed: nextCursor,
    total,
    ready: baseReady + ready,
    failed: baseFailed + failed,
    complete: total === 0 || nextCursor >= total,
  };
  await storage.put(KV_LIVE_PREPARE_STATE, JSON.stringify(next));
  return next;
}

export async function loadLivePrepareState(storage: Storage): Promise<LivePrepareState | null> {
  return parseState(await storage.get(KV_LIVE_PREPARE_STATE));
}

/**
 * 将已就绪的单源 /live/<key> 文本反序列化为统一候选树。
 * 该函数只读已完成的 KV 文本，不访问上游，因此可安全用于 CF 聚合收尾。
 */
export async function buildPreparedLiveGroups(
  entries: readonly LiveProxyEntryHintSource[],
  storage: Storage,
): Promise<TVBoxLiveGroup[]> {
  const groups: TVBoxLiveGroup[] = [];
  for (const entry of entries) {
    const key = entry.key;
    if (!key) continue;
    const text = await storage.get(`${KV_LIVE_TEXT_PREFIX}${key}`);
    if (!text || !text.includes('#genre#')) continue;
    for (const group of parseLiveGroupsFromTxt(text)) {
      groups.push(group);
    }
  }
  return groups;
}

export interface LiveProxyEntryHintSource {
  key?: string;
  name?: string;
  url?: string;
}

export function serializePreparedLiveGroups(groups: readonly TVBoxLiveGroup[]): string {
  return serializeLiveCandidatePool(groups);
}
export interface LivePrepareChunkResult {
  state: LivePrepareState;
  readyEntries: LiveProxyManifestEntry[];
  preparedGroups: TVBoxLiveGroup[];
  runtimeGroups: TVBoxLiveGroup[];
}

/**
 * 读取持久化输入清单并推进一个分片，然后把本批成功文本立即接入统一
 * 候选树与运行时输出。这个函数不参与聚合主流程，避免下载直播源把
 * 聚合 Worker 长任务拖死。
 */
export async function runLivePrepareChunk(
  storage: Storage,
  options: {
    batchSize?: number;
    timeoutMs?: number;
    concurrency?: number;
    forceNewRound?: boolean;
  } = {},
): Promise<LivePrepareChunkResult> {
  const inputSet = await loadLivePrepareInputs(storage);
  const sources = inputSet?.sources ?? [];
  const previousState = await loadLivePrepareState(storage);
  // 已完成且输入未变时复用结果；避免手动重复调用接口触发新一轮全量下载。
  if (!options.forceNewRound
    && previousState?.complete === true
    && livePrepareStateMatchesInputs(previousState, inputSet)) {
    const readyEntries = await listLiveProxyEntries(storage);
    const preparedGroups = await buildPreparedLiveGroups(readyEntries, storage);
    return { state: previousState, readyEntries, preparedGroups, runtimeGroups: preparedGroups };
  }
  if (sources.length === 0) {
    // 输入清单尚未由一次成功聚合写入，或直播被禁用/过滤为空时，
    // 不得把状态或候选树误推进为空；交由聚合收尾显式处理空输出。
    const state = previousState ?? {
      cursor: 0,
      sourceSignature: '',
      inputUpdatedAt: inputSet?.updatedAt || '',
      updatedAt: new Date().toISOString(),
      processed: 0,
      total: 0,
      ready: 0,
      failed: 0,
      complete: true,
    };
    const readyEntries = await listLiveProxyEntries(storage);
    const preparedGroups = await buildPreparedLiveGroups(readyEntries, storage);
    return { state, readyEntries, preparedGroups, runtimeGroups: preparedGroups };
  }
  if (options.forceNewRound) {
    const state = await loadLivePrepareState(storage);
    if (state) {
      await storage.put(KV_LIVE_PREPARE_STATE, JSON.stringify({ ...state, complete: true }));
    }
  }
  const channelSpeedMap = await loadPublishedSpeedMap(storage);
  const state = await prepareLiveSourcesChunk(sources, storage, {
    batchSize: options.batchSize,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    channelSpeedMap,
    inputUpdatedAt: inputSet?.updatedAt || '',
  });
  const readyEntries = await listLiveProxyEntries(storage);
  const preparedGroups = await buildPreparedLiveGroups(readyEntries, storage);
  const [existingMergedRaw, existingCandidateRaw] = await Promise.all([
    storage.get(KV_CHANNEL_MERGED_TREE),
    storage.get(KV_CHANNEL_CANDIDATE_URLS),
  ]);
  const existingCandidate = parseLiveCandidatePool(existingCandidateRaw);
  const mergedCandidateGroups = mergeLiveCandidateTreeSources([
    parseGroups(existingMergedRaw),
    existingCandidate.source === 'structured' ? existingCandidate.groups : [],
    preparedGroups,
  ]);
  await storage.put(KV_CHANNEL_MERGED_TREE, JSON.stringify(mergedCandidateGroups));
  await storage.put(KV_CHANNEL_CANDIDATE_URLS, serializePreparedLiveGroups(mergedCandidateGroups));
  const rebuilt = await rebuildLiveOutput(storage);
  await storage.put(KV_LIVE_MERGE_REPORT, JSON.stringify({
    updatedAt: new Date().toISOString(),
    mode: (await storage.get(KV_LIVE_MERGE_MODE)) === 'merged' ? 'merged' : 'separated',
    platform: 'cloudflare',
    sources: sources.length,
    prepare: state,
    textReady: readyEntries.length,
    distributable: readyEntries.length,
    preparedGroups: mergedCandidateGroups.length,
    runtimeGroups: rebuilt.groups.length,
  }));
  return {
    state,
    readyEntries,
    preparedGroups: mergedCandidateGroups,
    runtimeGroups: rebuilt.groups,
  };
}
