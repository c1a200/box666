// 搜索源质量分级与定时调度
//
// 设计目标：
// 1. 质量分级独立于聚合运行，可对完整可搜索池分批执行并持久化。
// 2. 根配置只读取已经排好序的快照池，按前端配置的 maxSearchable 取前 N，不临时测速。
// 3. Render/CF 使用各自 KV；CF 通过 cursor 分片续跑，避免一次 cron 超时。
import type {
  SearchQualitySchedule,
  SearchQualitySnapshot,
  SearchQualityStatus,
  SiteHealthMap,
  TVBoxSite,
  SiteQualityGrade,
  SiteQualityGrades,
} from './types';
import type { Storage } from '../storage/interface';
import { batchSiteSpeedTest, type SiteProbeResult } from './speedtest';
import {
  KV_SEARCH_QUALITY_CANDIDATES,
  KV_SEARCH_QUALITY_POOL,
  KV_SEARCH_QUALITY_SCHEDULE,
  KV_SEARCH_QUALITY_SNAPSHOT,
  KV_SEARCH_QUALITY_STATUS,
  KV_SITE_HEALTH_MAP,
} from './config';

export const QUALITY_THRESHOLDS = {
  excellent: 1000,
  good: 3000,
} as const;

const DEFAULT_BATCH_SIZE = 80;
const MAX_SCHEDULE_TIMES = 12;

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.env.PORT;
}

export function defaultQualityConfig(now = new Date()): SearchQualitySchedule {
  const config: SearchQualitySchedule = {
    enabled: true,
    times: ['04:30'],
    repeatDays: 1,
    timezone: 'Asia/Shanghai',
    lastRunAt: undefined,
    nextRunAt: undefined,
  };
  config.nextRunAt = computeNextQualityRun(config, now);
  return config;
}

function normalizeTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function addDays(parts: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * 将指定时区的本地时间转换为 UTC ISO。
 *
 * 中国标准时间固定 UTC+8，但为了兼容其他时区，先构造候选时间，再根据
 * Intl 输出的偏移迭代校正，避免引入额外依赖。
 */
function zonedLocalToUtcIso(year: number, month: number, day: number, hour: number, minute: number, timezone: string): string {
  const intendedUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = new Date(intendedUtc);
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(guess, timezone);
    const actualUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const delta = intendedUtc - actualUtc;
    if (delta === 0) break;
    guess = new Date(guess.getTime() + delta);
  }
  return guess.toISOString();
}

/** 计算下一次执行时间（基于固定时区，按天/每 N 天）。 */
export function computeNextQualityRun(config: SearchQualitySchedule, now = new Date()): string | undefined {
  const times = (config.times || []).map((time: unknown) => normalizeTime(time)).filter((time): time is string => !!time).sort();
  if (!config.enabled || times.length === 0) return undefined;

  const timezone = config.timezone || 'Asia/Shanghai';
  const repeatDays = Math.max(1, Math.floor(config.repeatDays || 1));
  const local = zonedParts(now, timezone);
  const nowMinute = local.hour * 60 + local.minute;

  // 同一天剩余的时间点优先。
  for (const time of times) {
    const [hour, minute] = time.split(':').map(Number);
    if (hour * 60 + minute > nowMinute) {
      return zonedLocalToUtcIso(local.year, local.month, local.day, hour, minute, timezone);
    }
  }

  // 找到下一个允许执行的日期。repeatDays=1 表示每天；>1 表示从上次执行日
  // 起每 N 天一次，避免跨天边界重复。
  const baseDate = config.lastRunAt ? parseDate(config.lastRunAt) : now;
  const base = baseDate ? zonedParts(baseDate, timezone) : local;
  const daysSinceBase = Math.floor((Date.UTC(local.year, local.month - 1, local.day)
    - Date.UTC(base.year, base.month - 1, base.day)) / 86400000);
  let offset = 1;
  if (repeatDays > 1) {
    const remainder = daysSinceBase % repeatDays;
    offset = remainder === 0 ? repeatDays : repeatDays - remainder;
  }
  const target = addDays(local, offset);
  const [hour, minute] = times[0].split(':').map(Number);
  return zonedLocalToUtcIso(target.year, target.month, target.day, hour, minute, timezone);
}

function normalizeScheduleTimes(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const times = [...new Set(
    value.map((time: unknown) => normalizeTime(time)).filter((time): time is string => !!time),
  )].sort();
  return times.length > 0 ? times.slice(0, MAX_SCHEDULE_TIMES) : fallback;
}

export async function loadQualitySchedule(storage: Storage): Promise<SearchQualitySchedule> {
  const fallback = defaultQualityConfig();
  const raw = await storage.get(KV_SEARCH_QUALITY_SCHEDULE);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<SearchQualitySchedule>;
    const config: SearchQualitySchedule = {
      enabled: parsed.enabled !== false,
      times: normalizeScheduleTimes(parsed.times, fallback.times),
      repeatDays: Math.min(30, Math.max(1, Math.floor(parsed.repeatDays || 1))),
      timezone: typeof parsed.timezone === 'string' && parsed.timezone.trim() ? parsed.timezone.trim() : fallback.timezone,
      lastRunAt: parseDate(parsed.lastRunAt)?.toISOString(),
      nextRunAt: parseDate(parsed.nextRunAt)?.toISOString(),
    };
    // 已保存的 nextRunAt 是权威值；读取时不要重算，否则到期任务会被
    // 自动推到未来，定时入口永远看不到它已经到期。只有缺失时才补算。
    config.nextRunAt = config.nextRunAt || computeNextQualityRun(config);
    return config;
  } catch {
    return fallback;
  }
}

export async function saveQualitySchedule(storage: Storage, input: Partial<SearchQualitySchedule>): Promise<SearchQualitySchedule> {
  const current = await loadQualitySchedule(storage);
  const config: SearchQualitySchedule = {
    enabled: input.enabled !== undefined ? input.enabled === true : current.enabled,
    times: normalizeScheduleTimes(input.times, current.times),
    repeatDays: Math.min(30, Math.max(1, Math.floor(input.repeatDays || current.repeatDays || 1))),
    timezone: typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : current.timezone,
    lastRunAt: current.lastRunAt,
    nextRunAt: undefined,
  };
  config.nextRunAt = computeNextQualityRun(config);
  await storage.put(KV_SEARCH_QUALITY_SCHEDULE, JSON.stringify(config));
  return config;
}

export async function loadQualityStatus(storage: Storage): Promise<SearchQualityStatus> {
  const raw = await storage.get(KV_SEARCH_QUALITY_STATUS);
  if (!raw) return { state: 'idle' };
  try {
    const parsed = JSON.parse(raw) as SearchQualityStatus;
    if (!parsed || typeof parsed !== 'object') return { state: 'idle' };
    return parsed;
  } catch {
    return { state: 'idle' };
  }
}

export async function updateQualityStatus(
  storage: Storage,
  patch: Partial<SearchQualityStatus>,
): Promise<SearchQualityStatus> {
  const current = await loadQualityStatus(storage);
  const next: SearchQualityStatus = { ...current, ...patch };
  await storage.put(KV_SEARCH_QUALITY_STATUS, JSON.stringify(next));
  return next;
}

export async function shouldRunQualityNow(storage: Storage, now = new Date()): Promise<boolean> {
  const schedule = await loadQualitySchedule(storage);
  if (!schedule.enabled || !schedule.nextRunAt) return false;
  const next = new Date(schedule.nextRunAt).getTime();
  if (!Number.isFinite(next)) return false;
  return next <= now.getTime();
}

export async function markQualityRun(storage: Storage, at = new Date()): Promise<SearchQualitySchedule> {
  const schedule = await loadQualitySchedule(storage);
  schedule.lastRunAt = at.toISOString();
  schedule.nextRunAt = computeNextQualityRun(schedule, at);
  await storage.put(KV_SEARCH_QUALITY_SCHEDULE, JSON.stringify(schedule));
  return schedule;
}

function createEmptyGrades(): SiteQualityGrades {
  return {
    excellent: { count: 0, cumulative: 0 },
    good: { count: 0, cumulative: 0 },
    usable: { count: 0, cumulative: 0 },
    unknown: { count: 0, cumulative: 0 },
    unusable: { count: 0, cumulative: 0 },
    poolTotal: 0,
  };
}

export function gradeForProbe(probe: SiteProbeResult | undefined, historicalFailures = 0): SiteQualityGrade {
  if (!probe || probe.result === 'not_probed') {
    return historicalFailures >= 3 ? 'unusable' : 'unknown';
  }
  if (probe.result !== 'ok') {
    return historicalFailures >= 3 ? 'unusable' : 'unknown';
  }
  const speed = probe.speedMs;
  if (speed == null) return 'usable';
  if (speed <= QUALITY_THRESHOLDS.excellent) return 'excellent';
  if (speed <= QUALITY_THRESHOLDS.good) return 'good';
  return 'usable';
}

function compareGrade(a: SiteQualityGrade, b: SiteQualityGrade): number {
  const rank: Record<SiteQualityGrade, number> = {
    excellent: 0,
    good: 1,
    usable: 2,
    unknown: 3,
    unusable: 4,
  };
  return rank[a] - rank[b];
}

function sortQualityEntries(entries: SearchQualitySnapshot['entries']): SearchQualitySnapshot['entries'] {
  return [...entries].sort((a, b) => {
    const gradeDiff = compareGrade(a.grade, b.grade);
    if (gradeDiff !== 0) return gradeDiff;
    const aSpeed = typeof a.speedMs === 'number' ? a.speedMs : Number.POSITIVE_INFINITY;
    const bSpeed = typeof b.speedMs === 'number' ? b.speedMs : Number.POSITIVE_INFINITY;
    if (aSpeed !== bSpeed) return aSpeed - bSpeed;
    return a.key.localeCompare(b.key);
  });
}

function buildGrades(entries: SearchQualitySnapshot['entries']): SiteQualityGrades {
  const grades = createEmptyGrades();
  for (const entry of entries) {
    grades[entry.grade].count++;
    if (entry.grade !== 'unusable') grades.poolTotal++;
  }
  let cumulative = 0;
  for (const grade of ['excellent', 'good', 'usable', 'unknown'] as const) {
    cumulative += grades[grade].count;
    grades[grade].cumulative = cumulative;
  }
  grades.unusable.cumulative = grades.unusable.count;
  return grades;
}

export function recommendedSearchLimit(grades: SiteQualityGrades): number {
  // 推荐值优先覆盖优质和良好源；如果这两级太少，再补足一部分可用源。
  const preferred = grades.excellent.count + grades.good.count;
  if (preferred > 0) return Math.max(20, Math.min(200, preferred));
  return Math.max(10, Math.min(80, grades.usable.count));
}

export async function loadQualitySnapshot(storage: Storage): Promise<SearchQualitySnapshot | null> {
  const raw = await storage.get(KV_SEARCH_QUALITY_SNAPSHOT);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SearchQualitySnapshot;
  } catch {
    return null;
  }
}

export async function loadQualityPool(storage: Storage): Promise<SearchQualitySnapshot | null> {
  const raw = await storage.get(KV_SEARCH_QUALITY_POOL);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SearchQualitySnapshot;
  } catch {
    return null;
  }
}

export async function loadHealthMap(storage: Storage): Promise<SiteHealthMap> {
  const raw = await storage.get(KV_SITE_HEALTH_MAP);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as SiteHealthMap;
  } catch {
    // ignore corrupted health map
  }
  return {};
}

function collectSearchableSites(sites: TVBoxSite[]): TVBoxSite[] {
  const seen = new Set<string>();
  const result: TVBoxSite[] = [];
  for (const site of sites) {
    if (site.searchable !== 1 || site.type === 3) continue;
    if (!site.key || seen.has(site.key)) continue;
    seen.add(site.key);
    result.push(site);
  }
  return result;
}

/**
 * 对完整搜索池执行一次质量分级并持久化。
 * 已完成的旧结果作为兜底；本轮未探测到的源保留上一轮分级，避免瞬时预算耗尽导致降级。
 */
export async function runQualityGrading(
  storage: Storage,
  sites: TVBoxSite[],
  options: {
    batchSize?: number;
    timeoutMs?: number;
    concurrency?: number;
    budgetMs?: number;
    deep?: boolean;
    probeMap?: Map<string, SiteProbeResult>;
    healthMap?: SiteHealthMap;
    markRun?: boolean;
    onProgress?: (processed: number, total: number) => Promise<void> | void;
  } = {},
): Promise<SearchQualitySnapshot> {
  const searchable = collectSearchableSites(sites);
  const previous = await loadQualityPool(storage);
  const previousEntries = new Map((previous?.entries || []).map((entry) => [entry.key, entry]));

  let probeMap = options.probeMap;
  if (!probeMap) {
    // 没有现成探测结果时，分批覆盖整个可搜索池，而不是只测第一批。
    const batchSize = Math.max(1, Math.floor(options.batchSize || DEFAULT_BATCH_SIZE));
    const collected = new Map<string, SiteProbeResult>();
    for (let offset = 0; offset < searchable.length; offset += batchSize) {
      const batch = searchable.slice(offset, offset + batchSize);
      const partial = await batchSiteSpeedTest(
        batch,
        options.timeoutMs ?? 3000,
        options.deep ?? false,
        options.concurrency ?? (isNodeRuntime() ? 16 : 6),
        options.budgetMs ?? (isNodeRuntime() ? 120000 : 25000),
      );
      for (const [key, value] of partial) collected.set(key, value);
      if (options.onProgress) await options.onProgress(collected.size, searchable.length);
    }
    probeMap = collected;
  }

  const healthMap = options.healthMap ?? await loadHealthMap(storage);
  const entries = buildQualityEntries(searchable, probeMap, previousEntries, healthMap);
  const snapshot = buildSnapshot(searchable.length, entries);
  await persistQualitySnapshot(storage, snapshot);
  await persistQualityCandidates(storage, searchable);
  if (options.markRun !== false) await markQualityRun(storage);
  return snapshot;
}

function buildQualityEntries(
  searchable: TVBoxSite[],
  probeMap: Map<string, SiteProbeResult>,
  previousEntries: Map<string, SearchQualitySnapshot['entries'][number]>,
  healthMap: SiteHealthMap,
): SearchQualitySnapshot['entries'] {
  const now = new Date().toISOString();
  return searchable.map((site) => {
    const probe = probeMap.get(site.key);
    const previousEntry = previousEntries.get(site.key);
    const freshProbe = !!probe && probe.result !== 'not_probed';
    // 聚合路径会先调用 updateSiteHealth，并把已经累计后的失败次数写回
    // probe.consecutiveFailures；这里必须优先采用该值，不能再次 +1。
    const probeFailures = typeof probe?.consecutiveFailures === 'number'
      ? probe.consecutiveFailures
      : undefined;
    const previousFailures = probeFailures
      ?? healthMap[site.key]?.consecutiveFailures
      ?? previousEntry?.consecutiveFailures
      ?? 0;
    // 独立定时分级没有预累计字段时，才基于历史值 +1。
    // not_probed 表示预算耗尽，保留历史失败数，不能把它当成一次失败。
    const consecutiveFailures = freshProbe
      ? (probe!.result === 'ok'
          ? 0
          : (probeFailures !== undefined ? probeFailures : previousFailures + 1))
      : previousFailures;
    const effectiveProbe: SiteProbeResult | undefined = freshProbe
      ? probe
      : previousEntry
        ? { key: site.key, speedMs: previousEntry.speedMs, result: previousEntry.result }
        : probe;
    return {
      key: site.key,
      name: site.name || site.key,
      grade: gradeForProbe(effectiveProbe, consecutiveFailures),
      speedMs: effectiveProbe?.speedMs ?? null,
      result: effectiveProbe?.result ?? 'not_probed',
      probedAt: freshProbe ? now : previousEntry?.probedAt,
      consecutiveFailures,
    };
  });
}

function buildSnapshot(
  total: number,
  entries: SearchQualitySnapshot['entries'],
): SearchQualitySnapshot {
  const sorted = sortQualityEntries(entries);
  const grades = buildGrades(sorted);
  return {
    updatedAt: new Date().toISOString(),
    total,
    graded: entries.filter((entry) => entry.grade !== 'unknown').length,
    entries: sorted,
    grades,
    recommendedMaxSearchable: recommendedSearchLimit(grades),
    recommendedMaxParses: 3,
    thresholds: { excellentMaxMs: QUALITY_THRESHOLDS.excellent, goodMaxMs: QUALITY_THRESHOLDS.good },
  };
}

async function persistQualitySnapshot(storage: Storage, snapshot: SearchQualitySnapshot): Promise<void> {
  const serialized = JSON.stringify(snapshot);
  await storage.put(KV_SEARCH_QUALITY_SNAPSHOT, serialized);
  await storage.put(KV_SEARCH_QUALITY_POOL, serialized);
}

/**
 * 保存质量分级候选站点的完整对象快照。质量池本身只存 key/名称/分级，
 * 定时任务重测时需要完整站点（api/type/quickSearch 等），因此单独持久化。
 */
export async function persistQualityCandidates(storage: Storage, sites: TVBoxSite[]): Promise<void> {
  const searchable = collectSearchableSites(sites);
  await storage.put(KV_SEARCH_QUALITY_CANDIDATES, JSON.stringify({
    updatedAt: new Date().toISOString(),
    sites: searchable,
  }));
}

export async function loadQualityCandidates(storage: Storage): Promise<TVBoxSite[]> {
  const raw = await storage.get(KV_SEARCH_QUALITY_CANDIDATES);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { sites?: TVBoxSite[] };
    return Array.isArray(parsed.sites) ? parsed.sites : [];
  } catch {
    return [];
  }
}

/** 开始新一轮质量分级：重置游标并写入 running 状态。 */
export async function beginQualityRun(
  storage: Storage,
  total = 0,
  batchSize = 0,
): Promise<SearchQualityStatus> {
  return updateQualityStatus(storage, {
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    processed: 0,
    total,
    cursor: 0,
    batchSize,
    error: undefined,
  });
}

/** 结束质量分级：写入 done 状态并推进下一次计划时间。 */
export async function finishQualityRun(
  storage: Storage,
  processed: number,
  total: number,
  markRun = true,
): Promise<SearchQualityStatus> {
  const status = await updateQualityStatus(storage, {
    state: 'done',
    finishedAt: new Date().toISOString(),
    processed,
    total,
    cursor: total,
    error: undefined,
  });
  if (markRun) await markQualityRun(storage);
  return status;
}

/**
 * CF 分片运行入口。每次 scheduled 调用只处理一个 batch，并把游标/中间结果
 * 持久化，下一次 cron 继续，避免 Worker CPU/子请求上限。
 */
export async function runQualityGradingChunk(
  storage: Storage,
  sites: TVBoxSite[],
  cursor = 0,
  batchSize = 40,
): Promise<{ done: boolean; cursor: number; processed: number; snapshot?: SearchQualitySnapshot }> {
  const searchable = collectSearchableSites(sites);
  const start = Math.max(0, Math.floor(cursor));
  if (start >= searchable.length) {
    const previous = await loadQualityPool(storage);
    const entries = previous?.entries ?? [];
    const snapshot = previous ?? buildSnapshot(0, entries);
    await markQualityRun(storage);
    return { done: true, cursor: searchable.length, processed: 0, snapshot };
  }

  const batch = searchable.slice(start, start + Math.max(1, batchSize));
  const probeMap = await batchSiteSpeedTest(batch, 3000, false, 6, 25000);
  const previous = await loadQualityPool(storage);
  const previousEntries = new Map((previous?.entries || []).map((entry) => [entry.key, entry]));
  const healthMap = await loadHealthMap(storage);
  const entries = buildQualityEntries(searchable, probeMap, previousEntries, healthMap);
  const snapshot = buildSnapshot(searchable.length, entries);
  await persistQualitySnapshot(storage, snapshot);
  await persistQualityCandidates(storage, searchable);
  const done = start + batch.length >= searchable.length;
  if (done) await markQualityRun(storage);
  return { done, cursor: start + batch.length, processed: batch.length, snapshot };
}

/**
 * 依据持久化质量池顺序重排站点。返回结果保持质量池中出现的顺序，
 * 质量池未覆盖的站点按原顺序追加在后面。
 */
export function orderSitesByQualityPool<T extends { key: string }>(
  sites: T[],
  pool: SearchQualitySnapshot | null,
): T[] {
  if (!pool || !Array.isArray(pool.entries) || pool.entries.length === 0) return sites;
  const rank = new Map<string, number>();
  pool.entries.forEach((entry, index) => {
    if (!rank.has(entry.key)) rank.set(entry.key, index);
  });
  const indexOf = (site: T): number => rank.get(site.key) ?? Number.MAX_SAFE_INTEGER;
  return [...sites].sort((a, b) => {
    const diff = indexOf(a) - indexOf(b);
    return diff !== 0 ? diff : 0;
  });
}

/** 质量池中标记为不可用的 key 集合。 */
export function unusableKeys(pool: SearchQualitySnapshot | null): Set<string> {
  const keys = new Set<string>();
  if (!pool || !Array.isArray(pool.entries)) return keys;
  for (const entry of pool.entries) {
    if (entry.grade === 'unusable') keys.add(entry.key);
  }
  return keys;
}