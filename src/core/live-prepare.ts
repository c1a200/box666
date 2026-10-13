import type { Storage } from '../storage/interface';
import { KV_LIVE_PREPARE_STATE, KV_LIVE_TEXT_PREFIX } from './config';
import type { LiveSourceInput } from './live-merger';
import { filterLiveSourcesDetailed } from './live-merger';
import { pruneLiveProxyManifestToUrls, updateLiveProxyManifest, type LiveProxyEntryHint } from './live-source';
import type { TVBoxLiveGroup } from './types';
import { parseLiveGroupsFromTxt, serializeLiveCandidatePool } from './live-merger';
import type { LiveCategory } from './live-quality';
import type { ChannelSpeedMap } from './types';

export interface LivePrepareState {
  cursor: number;
  sourceSignature: string;
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

function sourceSignature(sources: readonly LiveSourceInput[]): string {
  return sources.map((source) => source.url).sort().join('\n');
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
  } = {},
): Promise<LivePrepareState> {
  const total = sources.length;
  const signature = sourceSignature(sources);
  const previous = parseState(await storage.get(KV_LIVE_PREPARE_STATE));
  const sameSourceSet = previous?.sourceSignature === signature;
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
      options.channelSpeedMap,
      {
        storage,
        concurrency: Math.max(1, options.concurrency ?? 3),
        minChannelsPerSource: 5,
        maxAdRatio: 0.5,
        minPlayableRatio: 0.2,
        maxUrlsPerChannel: 64,
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
    await updateLiveProxyManifest(
      batch.map((source) => ({
        name: source.name,
        url: source.url,
        ua: source.ua,
        header: source.header,
      })),
      storage,
      {
        validUrls: validated.valid.map((source) => source.url),
        transientUrls: validated.transient.map((source) => source.url),
        invalidUrls: validated.invalid.map((source) => source.url),
        metrics: validated.metrics,
        hints,
        texts: validated.texts,
        incremental: true,
        checkedAt: new Date().toISOString(),
      },
    );
    ready = validated.valid.length;
    failed = batch.length - ready;
  }

  const nextCursor = Math.min(total, start + batch.length);
  const baseReady = startsNewRound ? 0 : (previous?.ready ?? 0);
  const baseFailed = startsNewRound ? 0 : (previous?.failed ?? 0);
  const next: LivePrepareState = {
    cursor: nextCursor,
    sourceSignature: signature,
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