// 搜索源质量分级与定时调度
//
// 设计目标：
// 1. 质量分级独立于聚合运行，可对完整可搜索池分批执行并持久化。
// 2. 根配置读取已排序快照池；可搜索源类型与数量由鉴权码控制，不按全局上限截断。
// 3. Render/CF 使用各自 KV；CF 通过 cursor 分片续跑，避免一次 cron 超时。
// 4. 日常只重测质量池；质量池为空或到达全量周期时，再自动回退/执行全量分级。
import type {
  SearchQualityRunMode,
  SearchQualitySchedule,
  SearchQualitySnapshot,
  SearchQualityStatus,
  SiteHealthMap,
  TVBoxSite,
  SiteQualityGrade,
  SiteQualityGrades,
} from './types';
import type { Storage } from '../storage/interface';
import { batchSiteSpeedTest, isSiteProbeable, type SiteProbeResult } from './speedtest';
import { probeJarHealth, applyJarProbeToEntry, isRemoteJarSite, type JarProbeResult } from './jar-health';
import { classifySearchSource } from './search-quota';
import { calculateQualityScore, compareQualityEntries, normalizeQualityGrade, qualityConfidenceForEntry, qualityScoreForEntry } from './quality-ranking';
import {
  KV_SEARCH_QUALITY_CANDIDATES,
  KV_SEARCH_QUALITY_POOL,
  KV_SEARCH_QUALITY_SCHEDULE,
  KV_SEARCH_QUALITY_SNAPSHOT,
  KV_SEARCH_QUALITY_STATUS,
  KV_SITE_HEALTH_MAP,
} from './config';

export const QUALITY_TIMEZONE = 'Asia/Shanghai';

export function normalizeQualityTimezone(value?: string): string {
  const raw = (value || '').trim();
  if (!raw) return QUALITY_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    return QUALITY_TIMEZONE;
  }
}

export const QUALITY_THRESHOLDS = {
  excellent: 1000,
  good: 3000,
  usable: 6000,
} as const;

const DEFAULT_BATCH_SIZE = 80;
const MAX_SCHEDULE_TIMES = 12;
const DEFAULT_FULL_REPEAT_DAYS = 7;
// Daily grading normally runs once per day. Keep a short fresh window, then
// degrade conservatively instead of silently treating an old snapshot as live.
export const QUALITY_POOL_FRESH_TTL_MS = 36 * 60 * 60 * 1000;
export const QUALITY_POOL_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// JAR/客户端运行时源可以在应用端参与搜索，但服务端无法替它们验活。
// “全部”是默认策略：质量池负责排序，客户端后备源不再被隐式截断。
// 只有管理端明确设置 0/N 时才会排除或限制 untestable；-1 表示全部。
export const DEFAULT_CLIENT_FALLBACK_LIMIT = -1;

export type QualityPoolState = 'fresh' | 'stale' | 'expired' | 'unavailable';

export interface QualityPoolHealth {
  state: QualityPoolState;
  ageMs: number | null;
  ageHours: number | null;
  updatedAt?: string;
}

/**
 * Classify a persisted quality pool by freshness. A missing/invalid timestamp
 * is intentionally unavailable: it must not silently become an authoritative
 * ranking after a restart or KV migration.
 */
export function getQualityPoolHealth(
  pool: SearchQualitySnapshot | null | undefined,
  now = Date.now(),
): QualityPoolHealth {
  if (!pool || !Array.isArray(pool.entries) || pool.entries.length === 0) {
    return { state: 'unavailable', ageMs: null, ageHours: null };
  }
  const updatedAtMs = Date.parse(pool.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return { state: 'unavailable', ageMs: null, ageHours: null, updatedAt: pool.updatedAt };
  }
  const ageMs = Math.max(0, now - updatedAtMs);
  const state = ageMs <= QUALITY_POOL_FRESH_TTL_MS
    ? 'fresh'
    : ageMs <= QUALITY_POOL_STALE_TTL_MS
      ? 'stale'
      : 'expired';
  return {
    state,
    ageMs,
    ageHours: Math.round(ageMs / 360000) / 10,
    updatedAt: pool.updatedAt,
  };
}
// The quality pool contains every source with a positive quality score. The
// distribution policy may still limit `untestable` to a small client fallback
// window, but that is a serving decision rather than pool membership.
const QUALITY_POOL_GRADES = new Set<SiteQualityGrade>(['excellent', 'good', 'usable', 'untestable']);
const SERVER_VERIFIED_GRADES = new Set<SiteQualityGrade>(['excellent', 'good', 'usable']);

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.env.PORT;
}

export function defaultQualityConfig(now = new Date(), timezone = QUALITY_TIMEZONE): SearchQualitySchedule {
  const config: SearchQualitySchedule = {
    enabled: true,
    followAggregation: true,
    times: ['04:30'],
    repeatDays: 1,
    fullRepeatDays: DEFAULT_FULL_REPEAT_DAYS,
    timezone: normalizeQualityTimezone(timezone),
    lastRunAt: undefined,
    nextRunAt: undefined,
    lastFullRunAt: undefined,
    nextFullRunAt: undefined,
  };
  config.nextRunAt = computeNextQualityRun(config, now, config.timezone);
  config.nextFullRunAt = computeNextFullQualityRun(config, now, config.timezone);
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

/** 计算下一次质量池重排时间（基于固定时区，按天/每 N 天）。 */
export function computeNextQualityRun(config: SearchQualitySchedule, now = new Date(), timezone = config.timezone || QUALITY_TIMEZONE): string | undefined {
  const times = (config.times || []).map((time: unknown) => normalizeTime(time)).filter((time): time is string => !!time).sort();
  if (!config.enabled || times.length === 0) return undefined;

  timezone = normalizeQualityTimezone(timezone);
  const repeatDays = Math.max(1, Math.floor(config.repeatDays || 1));
  const local = zonedParts(now, timezone);
  const nowMinute = local.hour * 60 + local.minute;

  for (const time of times) {
    const [hour, minute] = time.split(':').map(Number);
    if (hour * 60 + minute > nowMinute) {
      return zonedLocalToUtcIso(local.year, local.month, local.day, hour, minute, timezone);
    }
  }

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

/** 计算下一次全量分级时间；默认每 7 天一次。 */
export function computeNextFullQualityRun(config: SearchQualitySchedule, now = new Date(), timezone = config.timezone || QUALITY_TIMEZONE): string | undefined {
  const times = (config.times || []).map((time: unknown) => normalizeTime(time)).filter((time): time is string => !!time).sort();
  if (!config.enabled || times.length === 0) return undefined;
  timezone = normalizeQualityTimezone(timezone);
  const fullRepeatDays = Math.max(1, Math.floor(config.fullRepeatDays || DEFAULT_FULL_REPEAT_DAYS));
  const local = zonedParts(now, timezone);
  const nowMinute = local.hour * 60 + local.minute;

  for (const time of times) {
    const [hour, minute] = time.split(':').map(Number);
    if (hour * 60 + minute > nowMinute) {
      return zonedLocalToUtcIso(local.year, local.month, local.day, hour, minute, timezone);
    }
  }

  const baseDate = config.lastFullRunAt ? parseDate(config.lastFullRunAt) : now;
  const base = baseDate ? zonedParts(baseDate, timezone) : local;
  const daysSinceBase = Math.floor((Date.UTC(local.year, local.month - 1, local.day)
    - Date.UTC(base.year, base.month - 1, base.day)) / 86400000);
  const remainder = daysSinceBase % fullRepeatDays;
  const offset = remainder === 0 ? fullRepeatDays : fullRepeatDays - remainder;
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

export async function loadQualitySchedule(storage: Storage, timezone = QUALITY_TIMEZONE): Promise<SearchQualitySchedule> {
  const effectiveTimezone = normalizeQualityTimezone(timezone);
  const fallback = defaultQualityConfig(new Date(), effectiveTimezone);
  const raw = await storage.get(KV_SEARCH_QUALITY_SCHEDULE);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<SearchQualitySchedule>;
    const config: SearchQualitySchedule = {
      enabled: parsed.enabled !== false,
      followAggregation: parsed.followAggregation !== false,
      times: normalizeScheduleTimes(parsed.times, fallback.times),
      repeatDays: Math.min(30, Math.max(1, Math.floor(parsed.repeatDays || 1))),
      fullRepeatDays: Math.min(365, Math.max(1, Math.floor(parsed.fullRepeatDays || DEFAULT_FULL_REPEAT_DAYS))),
      timezone: effectiveTimezone,
      lastRunAt: parseDate(parsed.lastRunAt)?.toISOString(),
      nextRunAt: parseDate(parsed.nextRunAt)?.toISOString(),
      lastFullRunAt: parseDate(parsed.lastFullRunAt)?.toISOString(),
      nextFullRunAt: parseDate(parsed.nextFullRunAt)?.toISOString(),
    };
    const timezoneChanged = typeof parsed.timezone !== 'string' || parsed.timezone.trim() !== effectiveTimezone;
    if (timezoneChanged || !config.nextRunAt) config.nextRunAt = computeNextQualityRun(config, new Date(), effectiveTimezone);
    if (timezoneChanged || !config.nextFullRunAt) config.nextFullRunAt = computeNextFullQualityRun(config, new Date(), effectiveTimezone);
    if (timezoneChanged) await storage.put(KV_SEARCH_QUALITY_SCHEDULE, JSON.stringify(config));
    return config;
  } catch {
    return fallback;
  }
}

export async function saveQualitySchedule(storage: Storage, input: Partial<SearchQualitySchedule>, timezone = QUALITY_TIMEZONE): Promise<SearchQualitySchedule> {
  const effectiveTimezone = normalizeQualityTimezone(timezone);
  const current = await loadQualitySchedule(storage, effectiveTimezone);
  const config: SearchQualitySchedule = {
    enabled: input.enabled !== undefined ? input.enabled === true : current.enabled,
    followAggregation: input.followAggregation !== undefined ? input.followAggregation === true : current.followAggregation,
    times: normalizeScheduleTimes(input.times, current.times),
    repeatDays: Math.min(30, Math.max(1, Math.floor(input.repeatDays || current.repeatDays || 1))),
    fullRepeatDays: Math.min(365, Math.max(1, Math.floor(input.fullRepeatDays || current.fullRepeatDays || DEFAULT_FULL_REPEAT_DAYS))),
    timezone: effectiveTimezone,
    lastRunAt: current.lastRunAt,
    nextRunAt: undefined,
    lastFullRunAt: current.lastFullRunAt,
    nextFullRunAt: undefined,
  };
  config.nextRunAt = computeNextQualityRun(config, new Date(), effectiveTimezone);
  config.nextFullRunAt = computeNextFullQualityRun(config, new Date(), effectiveTimezone);
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

export async function shouldRunQualityNow(storage: Storage, now = new Date(), timezone = QUALITY_TIMEZONE): Promise<boolean> {
  const schedule = await loadQualitySchedule(storage, timezone);
  if (!schedule.enabled || !schedule.nextRunAt) return false;
  const next = new Date(schedule.nextRunAt).getTime();
  if (!Number.isFinite(next)) return false;
  return next <= now.getTime();
}

export async function shouldRunFullQualityNow(storage: Storage, now = new Date(), timezone = QUALITY_TIMEZONE): Promise<boolean> {
  const schedule = await loadQualitySchedule(storage, timezone);
  if (!schedule.enabled || !schedule.nextFullRunAt) return false;
  const next = new Date(schedule.nextFullRunAt).getTime();
  if (!Number.isFinite(next)) return false;
  return next <= now.getTime();
}

/**
 * 解析本次应执行的质量任务。全量任务优先，并占用当天一般更新的首个
 * 时段；全量当天已执行过时，不再额外触发同一天的一般更新。
 */
export async function resolveQualityRunMode(
  storage: Storage,
  now = new Date(),
  timezone = QUALITY_TIMEZONE,
): Promise<SearchQualityRunMode | null> {
  const schedule = await loadQualitySchedule(storage, timezone);
  if (!schedule.enabled) return null;

  const nowMs = now.getTime();
  const fullDue = schedule.nextFullRunAt
    ? new Date(schedule.nextFullRunAt).getTime() <= nowMs
    : false;
  const candidateDue = schedule.nextRunAt
    ? new Date(schedule.nextRunAt).getTime() <= nowMs
    : false;

  if (fullDue) return 'full';
  if (!candidateDue) return null;

  const local = zonedParts(now, normalizeQualityTimezone(timezone));
  const lastFull = schedule.lastFullRunAt ? parseDate(schedule.lastFullRunAt) : null;
  if (lastFull) {
    const fullLocal = zonedParts(lastFull, normalizeQualityTimezone(timezone));
    if (fullLocal.year === local.year && fullLocal.month === local.month && fullLocal.day === local.day) {
      return null;
    }
  }
  return 'candidate';
}

export async function markQualityRun(
  storage: Storage,
  at = new Date(),
  mode: SearchQualityRunMode = 'candidate',
  timezone = QUALITY_TIMEZONE,
): Promise<SearchQualitySchedule> {
  const effectiveTimezone = normalizeQualityTimezone(timezone);
  const schedule = await loadQualitySchedule(storage, effectiveTimezone);
  schedule.lastRunAt = at.toISOString();
  schedule.nextRunAt = computeNextQualityRun(schedule, at, effectiveTimezone);
  if (mode === 'full') {
    schedule.lastFullRunAt = at.toISOString();
    schedule.nextFullRunAt = computeNextFullQualityRun(schedule, at, effectiveTimezone);
    // 全量结果已经覆盖当天一般更新所需的信息；跳过同一天剩余的候选时段，
    // 避免一次全量后紧接着又跑一遍一般分级。
    const local = zonedParts(at, effectiveTimezone);
    const times = (schedule.times || [])
      .map((time: unknown) => normalizeTime(time))
      .filter((time): time is string => !!time)
      .sort();
    const next = times.find((time) => {
      const [hour, minute] = time.split(':').map(Number);
      return hour * 60 + minute > local.hour * 60 + local.minute;
    });
    if (next) {
      const [hour, minute] = next.split(':').map(Number);
      schedule.nextRunAt = zonedLocalToUtcIso(local.year, local.month, local.day, hour, minute, effectiveTimezone);
    } else {
      schedule.nextRunAt = computeNextQualityRun(schedule, at, effectiveTimezone);
    }
  }
  await storage.put(KV_SEARCH_QUALITY_SCHEDULE, JSON.stringify(schedule));
  return schedule;
}

function createEmptyGrades(): SiteQualityGrades {
  return {
    excellent: { count: 0, cumulative: 0 },
    good: { count: 0, cumulative: 0 },
    usable: { count: 0, cumulative: 0 },
    untestable: { count: 0, cumulative: 0 },
    timeout: { count: 0, cumulative: 0 },
    unusable: { count: 0, cumulative: 0 },
    poolTotal: 0,
    serverVerifiedTotal: 0,
    clientFallbackTotal: 0,
  };
}

const normalizeGrade = normalizeQualityGrade;

export function gradeForProbe(probe: SiteProbeResult | undefined, historicalFailures = 0): SiteQualityGrade {
  if (!probe || probe.result === 'not_probed') {
    return historicalFailures >= 3 ? 'unusable' : 'timeout';
  }
  if (probe.result === 'error' || probe.result === 'empty') {
    return 'unusable';
  }
  if (probe.result === 'timeout') {
    return historicalFailures >= 3 ? 'unusable' : 'timeout';
  }
  const speed = probe.speedMs;
  if (speed == null) return 'timeout';
  if (speed <= QUALITY_THRESHOLDS.excellent) return 'excellent';
  if (speed <= QUALITY_THRESHOLDS.good) return 'good';
  if (speed <= QUALITY_THRESHOLDS.usable) return 'usable';
  return 'timeout';
}

export { qualityScoreForEntry, qualityConfidenceForEntry } from './quality-ranking';

function sortQualityEntries(entries: SearchQualitySnapshot['entries']): SearchQualitySnapshot['entries'] {
  return [...entries].sort((a, b) => {
    return compareQualityEntries(a, b);
  });
}

function buildGrades(entries: SearchQualitySnapshot['entries']): SiteQualityGrades {
  const grades = createEmptyGrades();
  for (const entry of entries) {
    const grade = normalizeGrade(entry.grade);
    grades[grade].count++;
    if (grade !== 'timeout' && grade !== 'unusable') {
      grades.poolTotal++;
      if (grade === 'excellent' || grade === 'good' || grade === 'usable') grades.serverVerifiedTotal++;
      else if (grade === 'untestable') grades.clientFallbackTotal++;
    }
  }
  let cumulative = 0;
  for (const grade of ['excellent', 'good', 'usable', 'untestable', 'timeout'] as const) {
    cumulative += grades[grade].count;
    grades[grade].cumulative = cumulative;
  }
  grades.unusable.cumulative = grades.unusable.count;
  return grades;
}

/** @deprecated 全局可搜索源上限已退役，仅保留兼容字段，始终返回 0。 */
export function recommendedSearchLimit(_grades: SiteQualityGrades): number {
  return 0;
}

function normalizeSnapshot(raw: unknown): SearchQualitySnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Record<string, any>;
  if (!Array.isArray(parsed.entries)) return null;
  const entries = parsed.entries.map((entry: any) => {
    const rawGrade = normalizeGrade(entry.grade);
    const jarProbeResult = entry.jarProbeResult === 'ok' || entry.jarProbeResult === 'error'
      || entry.jarProbeResult === 'timeout' || entry.jarProbeResult === 'not_probed'
      ? entry.jarProbeResult
      : undefined;
    // 3.3.4 and earlier classified many client JARs as unusable merely because
    // Render could not validate a placeholder/image URL as a ZIP. Migrate those
    // historical records to untestable immediately; a later quality run can
    // still promote or remove them using the explicit HTTP failure rules.
    const softJarFailure = rawGrade === 'unusable'
      && !!jarProbeResult
      && !isHardJarProbeFailure({
        key: entry.key || '',
        siteKey: entry.key || '',
        result: jarProbeResult,
        speedMs: typeof entry.jarSpeedMs === 'number' ? entry.jarSpeedMs : null,
        httpStatus: typeof entry.jarHttpStatus === 'number' ? entry.jarHttpStatus : undefined,
      });
    const grade = softJarFailure ? 'untestable' : rawGrade;
    return {
      ...entry,
      grade,
      speedMs: typeof entry.speedMs === 'number' ? entry.speedMs : null,
      result: entry.result === 'ok' || entry.result === 'empty' || entry.result === 'error' || entry.result === 'timeout' || entry.result === 'not_probed'
        ? entry.result
        : 'not_probed',
      consecutiveFailures: typeof entry.consecutiveFailures === 'number' ? entry.consecutiveFailures : 0,
      // Recompute the score after a legacy unusable -> untestable migration.
      qualityScore: softJarFailure ? undefined : (typeof entry.qualityScore === 'number' ? entry.qualityScore : undefined),
      qualityConfidence: softJarFailure ? 0.2 : (typeof entry.qualityConfidence === 'number' ? entry.qualityConfidence : undefined),
      jarProbeResult,
      category: typeof entry.category === 'string' ? entry.category : undefined,
    };
  }) as SearchQualitySnapshot['entries'];
  const sorted = sortQualityEntries(entries);
  const grades = buildGrades(sorted);
  const coverageRaw = parsed.coverage && typeof parsed.coverage === 'object' ? parsed.coverage : {};
  return {
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    total: typeof parsed.total === 'number' ? parsed.total : sorted.length,
    graded: sorted.filter((entry) => entry.result !== 'not_probed').length,
    coverage: {
      testable: typeof coverageRaw.testable === 'number' ? coverageRaw.testable : 0,
      probed: typeof coverageRaw.probed === 'number' ? coverageRaw.probed : sorted.filter((entry) => entry.result !== 'not_probed').length,
      notProbed: typeof coverageRaw.notProbed === 'number' ? coverageRaw.notProbed : 0,
      untestable: typeof coverageRaw.untestable === 'number' ? coverageRaw.untestable : 0,
    },
    entries: sorted,
    grades,
    recommendedMaxSearchable: recommendedSearchLimit(grades),
    recommendedMaxParses: typeof parsed.recommendedMaxParses === 'number' ? parsed.recommendedMaxParses : 3,
    thresholds: {
      excellentMaxMs: QUALITY_THRESHOLDS.excellent,
      goodMaxMs: QUALITY_THRESHOLDS.good,
      usableMaxMs: QUALITY_THRESHOLDS.usable,
    },
  };
}

export async function loadQualitySnapshot(storage: Storage): Promise<SearchQualitySnapshot | null> {
  // 池键是当前规范存储；旧部署仅写过 snapshot 键，保留只读兼容。
  for (const key of [KV_SEARCH_QUALITY_POOL, KV_SEARCH_QUALITY_SNAPSHOT]) {
    const raw = await storage.get(key);
    if (!raw) continue;
    try {
      return normalizeSnapshot(JSON.parse(raw));
    } catch {
      // 尝试兼容旧键，避免单个损坏值阻断读取。
    }
  }
  return null;
}

export async function loadQualityPool(storage: Storage): Promise<SearchQualitySnapshot | null> {
  const raw = await storage.get(KV_SEARCH_QUALITY_POOL);
  if (!raw) return null;
  try {
    return normalizeSnapshot(JSON.parse(raw));
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

/**
 * 收集参与搜索配额决策的完整可搜索池。
 *
 * 必须覆盖所有 searchable===1 的站点，包含 type=3 的远程扩展（csp_* 守卫）。
 * 它们同样占用前端配置的 maxSearchable 名额，因此必须计入分级统计与排序；
 * 不可探测的 type=3 客户端扩展不会由服务端发起请求，单独归入 untestable；
 * 它们仍然下发给客户端，由客户端登录/执行，不占用服务端探测预算。
 */
export function collectSearchableSites(sites: TVBoxSite[]): TVBoxSite[] {
  const seen = new Set<string>();
  const result: TVBoxSite[] = [];
  for (const site of sites) {
    if (!site || site.searchable !== 1) continue;
    if (seen.has(site.key)) continue;
    seen.add(site.key);
    result.push(site);
  }
  return result;
}

export function qualityPoolKeysFromPool(pool: SearchQualitySnapshot | null): Set<string> {
  const keys = new Set<string>();
  if (!pool || !Array.isArray(pool.entries)) return keys;
  for (const entry of pool.entries) {
    const grade = normalizeGrade(entry.grade);
    if (QUALITY_POOL_GRADES.has(grade)) keys.add(entry.key);
  }
  return keys;
}

/**
 * Backward-compatible alias for the server-verifiable subset used by the
 * incremental quality recheck. It is not the user-facing quality pool.
 */
export function candidateKeysFromPool(pool: SearchQualitySnapshot | null): Set<string> {
  const keys = new Set<string>();
  if (!pool || !Array.isArray(pool.entries)) return keys;
  for (const entry of pool.entries) {
    const grade = normalizeGrade(entry.grade);
    if (SERVER_VERIFIED_GRADES.has(grade) && qualityScoreForEntry(entry) > 0) keys.add(entry.key);
  }
  return keys;
}

/**
 * Return keys eligible for distribution. Client-verifiable sources remain in
 * the same ordered candidate pool; callers may explicitly set 0/N/-1 for
 * untestable, while the default is -1 (all).
 */
export function distributableKeysFromPool(
  pool: SearchQualitySnapshot | null,
  options: { includeUntestable?: boolean; maxUntestable?: number; eligibleKeys?: Set<string> } = {},
): Set<string> {
  const keys = new Set<string>();
  if (!pool || !Array.isArray(pool.entries)) return keys;
  const maxUntestable = options.maxUntestable ?? -1;
  let untestable = 0;
  for (const entry of pool.entries) {
    if (options.eligibleKeys && !options.eligibleKeys.has(entry.key)) continue;
    const grade = normalizeGrade(entry.grade);
    if (SERVER_VERIFIED_GRADES.has(grade)) {
      keys.add(entry.key);
      continue;
    }
    if (options.includeUntestable && grade === 'untestable'
      && (maxUntestable < 0 || untestable < maxUntestable)) {
      keys.add(entry.key);
      untestable++;
      continue;
    }
  }
  return keys;
}

export function qualityTargetSites(sites: TVBoxSite[], pool: SearchQualitySnapshot | null, mode: SearchQualityRunMode): TVBoxSite[] {
  const all = collectSearchableSites(sites);
  if (mode === 'full') return all;
  const keys = candidateKeysFromPool(pool);
  if (keys.size === 0) return all;
  return all.filter((site) => keys.has(site.key));
}

/**
 * 对可搜索池执行一次质量分级并持久化。
 *
 * candidate 模式只重测当前服务端可验证的质量池子集；full 模式重测全部可服务端探测的 searchable。
 * untestable 由客户端执行，不参与服务端重测；timeout/unusable 保留历史统计但不进入质量池。
 */
export async function runQualityGrading(
  storage: Storage,
  sites: TVBoxSite[],
  options: {
    mode?: SearchQualityRunMode;
    batchSize?: number;
    timeoutMs?: number;
    concurrency?: number;
    budgetMs?: number;
    deep?: boolean;
    probeMap?: Map<string, SiteProbeResult>;
    healthMap?: SiteHealthMap;
    globalSpider?: string;
    markRun?: boolean;
    timezone?: string;
    onProgress?: (processed: number, total: number) => Promise<void> | void;
  } = {},
): Promise<SearchQualitySnapshot> {
  const allSearchable = collectSearchableSites(sites);
  const previous = await loadQualityPool(storage);
  const previousEntries = new Map((previous?.entries || []).map((entry) => [entry.key, entry]));
  const requestedMode = options.mode || 'full';
  let target = qualityTargetSites(allSearchable, previous, requestedMode);
  let mode = requestedMode;
  if (target.length === 0) {
    target = allSearchable;
    mode = 'full';
  }

  let probeMap = options.probeMap;
  if (!probeMap) {
    const batchSize = Math.max(1, Math.floor(options.batchSize || DEFAULT_BATCH_SIZE));
    const collected = new Map<string, SiteProbeResult>();
    for (let offset = 0; offset < target.length; offset += batchSize) {
      const batch = target.slice(offset, offset + batchSize);
      const partial = await batchSiteSpeedTest(
        batch,
        options.timeoutMs ?? 3000,
        options.deep ?? false,
        options.concurrency ?? (isNodeRuntime() ? 16 : 6),
        options.budgetMs ?? (isNodeRuntime() ? 120000 : 25000),
      );
      for (const [key, value] of partial) collected.set(key, value);
      if (options.onProgress) await options.onProgress(collected.size, target.length);
    }
    probeMap = collected;
  }

  const healthMap = options.healthMap ?? await loadHealthMap(storage);
  const jarProbeMap = await probeJarHealth(storage, allSearchable, previousEntries, options.globalSpider);
  const entries = buildQualityEntries(allSearchable, probeMap, previousEntries, healthMap, jarProbeMap, options.globalSpider);
  const snapshot = buildSnapshot(allSearchable.length, entries, allSearchable);
  await persistQualitySnapshot(storage, snapshot);
  await persistQualityCandidates(storage, allSearchable);
  if (options.markRun !== false) await markQualityRun(storage, new Date(), mode, options.timezone);
  return snapshot;
}

export function isHardJarProbeFailure(probe: JarProbeResult): boolean {
  // 客户端运行时才会真正执行 type=3 扩展。Render 侧遇到超时、5xx、
  // 非 ZIP 响应或 MD5 不一致，只能说明本次预检无法证明质量；尤其是
  // 聚合源常用图片/占位地址填充 jar 字段，不能据此把整类源误判为不可用。
  // 只有明确的鉴权拒绝或资源不存在，才足以排除该源。
  return typeof probe.httpStatus === 'number'
    && [401, 403, 404, 410].includes(probe.httpStatus);
}

function buildQualityEntries(
  searchable: TVBoxSite[],
  probeMap: Map<string, SiteProbeResult>,
  previousEntries: Map<string, SearchQualitySnapshot['entries'][number]>,
  healthMap: SiteHealthMap,
  jarProbeMap: Map<string, JarProbeResult> = new Map(),
  globalSpider?: string,
): SearchQualitySnapshot['entries'] {
  const now = new Date().toISOString();
  return searchable.map((site) => {
    if (!isSiteProbeable(site)) {
      const entry: SearchQualitySnapshot['entries'][number] = {
        key: site.key,
        name: site.name || site.key,
        grade: 'untestable',
        speedMs: null,
        result: 'not_probed',
        probedAt: undefined,
        consecutiveFailures: 0,
        qualityScore: undefined,
        qualityConfidence: 0.25,
        category: classifySearchSource(site),
      };
      const jarProbe = jarProbeMap.get(site.key);
      if (jarProbe) {
        entry.jarProbeResult = jarProbe.result;
        if (jarProbe.result === 'ok') {
          entry.qualityConfidence = 0.55;
        } else if (isHardJarProbeFailure(jarProbe)) {
          // 只有明确被上游拒绝或确认不存在的入口才进入 unusable；
          // 其余 JAR 预检失败均保留为 untestable，交给客户端实际执行。
          entry.grade = 'unusable';
          entry.qualityConfidence = 0.75;
        } else {
          entry.qualityConfidence = 0.2;
        }
      }
      const result = applyJarProbeToEntry(entry, jarProbe);
      result.qualityScore = result.grade === 'unusable'
        ? 0
        : calculateQualityScore(result);
      return result;
    }
    const probe = probeMap.get(site.key);
    const previousEntry = previousEntries.get(site.key);
    const freshProbe = !!probe && probe.result !== 'not_probed';
    const probeFailures = typeof probe?.consecutiveFailures === 'number' ? probe.consecutiveFailures : undefined;
    const previousFailures = probeFailures
      ?? healthMap[site.key]?.consecutiveFailures
      ?? previousEntry?.consecutiveFailures
      ?? 0;
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
    const entry: SearchQualitySnapshot['entries'][number] = {
      key: site.key,
      name: site.name || site.key,
      grade: gradeForProbe(effectiveProbe, consecutiveFailures),
      speedMs: effectiveProbe?.speedMs ?? null,
      result: effectiveProbe?.result ?? 'not_probed',
      probedAt: freshProbe ? now : previousEntry?.probedAt,
      consecutiveFailures,
      qualityScore: 0,
      qualityConfidence: 0,
      category: classifySearchSource(site),
    };
    const jarProbe = jarProbeMap.get(site.key);
    if (jarProbe) entry.jarProbeResult = jarProbe.result;
    const result = isRemoteJarSite(site, globalSpider) ? applyJarProbeToEntry(entry, jarProbe) : entry;
    result.qualityConfidence = result.grade === 'unusable' ? 0 : (result.result === 'ok' ? 0.9 : 0.35);
    // JAR 元数据预检是附加证据，不应覆盖 API 本身的搜索质量。
    // 特别是 Render/CF 无法访问 JAR 时，客户端仍可能因网络出口、
    // Header 或缓存不同而正常执行；这里保留原 grade，仅降低置信度。
    if (result.jarProbeResult && result.jarProbeResult !== 'ok') {
      result.qualityConfidence = Math.min(result.qualityConfidence, 0.35);
    }
    result.qualityScore = result.grade === 'unusable' ? 0 : calculateQualityScore(result);
    return result;
  });
}

function buildCoverage(sites: TVBoxSite[], entries: SearchQualitySnapshot['entries']) {
  let testable = 0;
  let untestable = 0;
  for (const site of sites) {
    if (isSiteProbeable(site)) testable++;
    else untestable++;
  }
  const probed = entries.filter((entry) => entry.result !== 'not_probed').length;
  return {
    testable,
    probed,
    notProbed: Math.max(0, testable - probed),
    untestable,
  };
}

function buildSnapshot(
  total: number,
  entries: SearchQualitySnapshot['entries'],
  sites: TVBoxSite[] = [],
): SearchQualitySnapshot {
  const sorted = sortQualityEntries(entries);
  const grades = buildGrades(sorted);
  return {
    updatedAt: new Date().toISOString(),
    total,
    graded: sorted.filter((entry) => entry.result !== 'not_probed').length,
    coverage: buildCoverage(sites, sorted),
    entries: sorted,
    grades,
    recommendedMaxSearchable: recommendedSearchLimit(grades),
    recommendedMaxParses: 3,
    thresholds: {
      excellentMaxMs: QUALITY_THRESHOLDS.excellent,
      goodMaxMs: QUALITY_THRESHOLDS.good,
      usableMaxMs: QUALITY_THRESHOLDS.usable,
    },
  };
}

async function persistQualitySnapshot(storage: Storage, snapshot: SearchQualitySnapshot): Promise<void> {
  // Pool 是调度和下发共用的规范键；同一份大对象不再重复写入旧快照键。
  await storage.put(KV_SEARCH_QUALITY_POOL, JSON.stringify(snapshot));
}

export async function persistQualityCandidates(storage: Storage, sites: TVBoxSite[]): Promise<void> {
  const searchable = collectSearchableSites(sites).map((site) => {
    const { __upstreamNames: _internal, ...publicSite } = site;
    return publicSite;
  });
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

export async function beginQualityRun(
  storage: Storage,
  total = 0,
  batchSize = 0,
  mode: SearchQualityRunMode = 'candidate',
): Promise<SearchQualityStatus> {
  return updateQualityStatus(storage, {
    state: 'running',
    mode,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    processed: 0,
    total,
    cursor: 0,
    batchSize,
    error: undefined,
  });
}

export async function finishQualityRun(
  storage: Storage,
  processed: number,
  total: number,
  markRun = true,
  mode: SearchQualityRunMode = 'candidate',
  timezone = QUALITY_TIMEZONE,
): Promise<SearchQualityStatus> {
  const status = await updateQualityStatus(storage, {
    state: 'done',
    mode,
    finishedAt: new Date().toISOString(),
    processed,
    total,
    cursor: total,
    error: undefined,
  });
  if (markRun) await markQualityRun(storage, new Date(), mode, timezone);
  return status;
}

export async function runQualityGradingChunk(
  storage: Storage,
  sites: TVBoxSite[],
  cursor = 0,
  batchSize = 40,
  requestedMode: SearchQualityRunMode = 'candidate',
  timezone = QUALITY_TIMEZONE,
  globalSpider?: string,
): Promise<{ done: boolean; cursor: number; processed: number; targetTotal: number; mode: SearchQualityRunMode; snapshot?: SearchQualitySnapshot }> {
  const allSearchable = collectSearchableSites(sites);
  const previous = await loadQualityPool(storage);
  const previousEntries = new Map((previous?.entries || []).map((entry) => [entry.key, entry]));
  let mode = requestedMode;
  let target = qualityTargetSites(allSearchable, previous, requestedMode);
  if (target.length === 0) {
    mode = 'full';
    target = allSearchable;
  }
  const start = Math.max(0, Math.floor(cursor));
  if (start >= target.length) {
    const entries = buildQualityEntries(allSearchable, new Map(), previousEntries, await loadHealthMap(storage), await probeJarHealth(storage, allSearchable, previousEntries, globalSpider), globalSpider);
    const snapshot = buildSnapshot(allSearchable.length, entries, allSearchable);
    await persistQualitySnapshot(storage, snapshot);
    await persistQualityCandidates(storage, allSearchable);
    await markQualityRun(storage, new Date(), mode, timezone);
    return { done: true, cursor: target.length, processed: 0, targetTotal: target.length, mode, snapshot };
  }

  const batch = target.slice(start, start + Math.max(1, batchSize));
  const probeMap = await batchSiteSpeedTest(batch, 3000, false, 6, 25000);
  const healthMap = await loadHealthMap(storage);
    const jarProbeMap = await probeJarHealth(storage, allSearchable, previousEntries, globalSpider);
    const entries = buildQualityEntries(allSearchable, probeMap, previousEntries, healthMap, jarProbeMap, globalSpider);
  const snapshot = buildSnapshot(allSearchable.length, entries, allSearchable);
  await persistQualitySnapshot(storage, snapshot);
  const done = start + batch.length >= target.length;
  // 候选快照在同一次分片运行中保持不变，仅在起点或终点落盘，避免重复占用 KV。
  if (start === 0 || done) await persistQualityCandidates(storage, allSearchable);
  if (done) await markQualityRun(storage, new Date(), mode, timezone);
  return { done, cursor: start + batch.length, processed: batch.length, targetTotal: target.length, mode, snapshot };
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
    if (normalizeGrade(entry.grade) === 'unusable') keys.add(entry.key);
  }
  return keys;
}

/** 不进入质量池的 key 集合（超时 + 明确不可用）。 */
export function excludedQualityKeys(pool: SearchQualitySnapshot | null): Set<string> {
  const keys = new Set<string>();
  if (!pool || !Array.isArray(pool.entries)) return keys;
  for (const entry of pool.entries) {
    const grade = normalizeGrade(entry.grade);
    if (grade === 'timeout' || grade === 'unusable') keys.add(entry.key);
  }
  return keys;
}
