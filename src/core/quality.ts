// 搜索源质量分级与定时调度
//
// 设计目标：
// 1. 质量分级独立于聚合运行，可对完整可搜索池分批执行并持久化。
// 2. 根配置只读取已经排好序的快照池，按前端配置的 maxSearchable 取前 N，不临时测速。
// 3. Render/CF 使用各自 KV；CF 通过 cursor 分片续跑，避免一次 cron 超时。
// 4. 日常只重测候选池；候选池为空或到达全量周期时，再自动回退/执行全量分级。
import type {
  CloudCredential,
  CloudPlatform,
  SearchQualityEntry,
  SiteContract,
  SearchQualityRunMode,
  SearchQualitySchedule,
  SearchQualitySnapshot,
  SearchQualityStatus,
  SiteHealthMap,
  TVBoxSite,
  SiteQualityGrade,
  SiteQualityGrades,
  SourcePreflightResult,
} from './types';
import type { Storage } from '../storage/interface';
import { isCredentialDistributable, isPanInitCredentialDistributable, loadCredentials } from './credential-store';
import { batchSiteSpeedTest, isSiteProbeable, type SiteProbeResult } from './speedtest';
import { canDistributeCredentialsToSite } from './credential-injector';
import { stripInternalSiteMarkers, loadSiteContractMap } from './site-contract';
import { preflightSourcesBatch } from './source-preflight';
import {
  KV_MERGED_CONFIG,
  DEFAULT_QUALITY_PROBE_CHUNK_SIZE,
  DEFAULT_QUALITY_PROBE_CONCURRENCY,
  DEFAULT_QUALITY_PROBE_TIMEOUT_MS,
  DEFAULT_QUALITY_PROBE_YIELD_MS,
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
const CANDIDATE_GRADES = new Set<SiteQualityGrade>(['excellent', 'good', 'usable', 'credential-ready', 'untestable']);
const SERVER_PROBE_GRADES = new Set<SiteQualityGrade>(['excellent', 'good', 'usable']);

// 仅这些平台的凭证可以安全地映射为 HTTP Cookie；token 型平台没有可靠的通用探测接口，
// 继续保留 credential-ready，等客户端真实播放验证。
const HTTP_COOKIE_PLATFORMS = new Set<CloudPlatform>(['quark', 'uc', 'baidu', 'bilibili', 'tianyi', 'pan115']);
const CREDENTIAL_PROBE_TIMEOUT_MS = 4000;

// 服务端预检（模拟客户端读取配置 / 请求接口 / 下载 JAR）只跑在后台分级里，
// 绝不在根配置热路径执行。超时与预算都比常规 HTTP 测速更宽松，但整体受控。
const QUALITY_PREFLIGHT_TIMEOUT_MS = 4500;
const QUALITY_PREFLIGHT_CONCURRENCY = 8;
const QUALITY_PREFLIGHT_BUDGET_MS = 25000;
// 候选池日常刷新时，已通过预检的源在 TTL 内直接复用结果，避免每天重复下载 JAR。
const QUALITY_PREFLIGHT_TTL_MS = 20 * 60 * 60 * 1000;

export interface QualityCredentialContext {
  contractsBySiteKey: Map<string, SiteContract>;
  globalSpider?: string;
}

async function loadQualityCredentialContext(storage: Storage, globalSpider?: string): Promise<QualityCredentialContext> {
  let spider = globalSpider;
  if (!spider) {
    try {
      const raw = await storage.get(KV_MERGED_CONFIG);
      const parsed = raw ? JSON.parse(raw) as { spider?: unknown } : null;
      spider = parsed && typeof parsed.spider === 'string' ? parsed.spider : undefined;
    } catch {
      spider = undefined;
    }
  }
  return { contractsBySiteKey: await loadSiteContractMap(storage), globalSpider: spider };
}

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.env.PORT;
}

export function defaultQualityConfig(now = new Date(), timezone = QUALITY_TIMEZONE): SearchQualitySchedule {
  const config: SearchQualitySchedule = {
    enabled: true,
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

/** 计算下一次候选池重排时间（基于固定时区，按天/每 N 天）。 */
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
  }
  await storage.put(KV_SEARCH_QUALITY_SCHEDULE, JSON.stringify(schedule));
  return schedule;
}

function createEmptyGrades(): SiteQualityGrades {
  return {
    excellent: { count: 0, cumulative: 0 },
    good: { count: 0, cumulative: 0 },
    usable: { count: 0, cumulative: 0 },
    credentialReady: { count: 0, cumulative: 0 },
    untestable: { count: 0, cumulative: 0 },
    timeout: { count: 0, cumulative: 0 },
    unusable: { count: 0, cumulative: 0 },
    poolTotal: 0,
  };
}

function normalizeGrade(value: unknown): SiteQualityGrade {
  if (value === 'unknown') return 'timeout';
  if (value === 'excellent' || value === 'good' || value === 'usable' || value === 'credential-ready' || value === 'untestable' || value === 'timeout' || value === 'unusable') return value;
  return 'timeout';
}

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

function compareGrade(a: SiteQualityGrade, b: SiteQualityGrade): number {
  const rank: Record<SiteQualityGrade, number> = {
    excellent: 0,
    good: 1,
    usable: 2,
    'credential-ready': 3,
    untestable: 4,
    timeout: 5,
    unusable: 6,
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
    const grade = normalizeGrade(entry.grade);
    if (grade === 'credential-ready') grades.credentialReady.count++;
    else grades[grade].count++;
    if (CANDIDATE_GRADES.has(grade)) grades.poolTotal++;
  }
  let cumulative = 0;
  for (const bucket of ['excellent', 'good', 'usable', 'credentialReady', 'untestable', 'timeout'] as const) {
    cumulative += grades[bucket].count;
    grades[bucket].cumulative = cumulative;
  }
  grades.unusable.cumulative = grades.unusable.count;
  return grades;
}

export function recommendedSearchLimit(grades: SiteQualityGrades): number {
  // 推荐值直接来自实际可下发候选池，不额外发明固定阈值。
  return Math.max(0, grades.poolTotal);
}

function normalizeSnapshot(raw: unknown): SearchQualitySnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Record<string, any>;
  if (!Array.isArray(parsed.entries)) return null;
  const entries = parsed.entries.map((entry: any) => ({
    ...entry,
    grade: normalizeGrade(entry.grade),
    speedMs: typeof entry.speedMs === 'number' ? entry.speedMs : null,
    result: entry.result === 'ok' || entry.result === 'empty' || entry.result === 'error' || entry.result === 'timeout' || entry.result === 'not_probed'
      ? entry.result
      : 'not_probed',
    consecutiveFailures: typeof entry.consecutiveFailures === 'number' ? entry.consecutiveFailures : 0,
    credentialPlatforms: Array.isArray(entry.credentialPlatforms)
      ? entry.credentialPlatforms.filter((platform: unknown): platform is CloudPlatform => typeof platform === 'string')
      : [],
    credentialStatus: entry.credentialStatus === 'ready'
      || entry.credentialStatus === 'partial'
      || entry.credentialStatus === 'missing'
      || entry.credentialStatus === 'invalid'
      ? entry.credentialStatus
      : 'not-required',
    probeKind: entry.probeKind === 'client-jar' || entry.probeKind === 'credential-http' || entry.probeKind === 'http'
      ? entry.probeKind
      : 'http',
    preflight: entry.preflight && typeof entry.preflight === 'object' && typeof entry.preflight.status === 'string'
      ? {
          ...entry.preflight,
          status: PREFLIGHT_SETTLED_STATUSES.has(entry.preflight.status)
            || entry.preflight.status === 'client-jar-unverified'
            || entry.preflight.status === 'credential-invalid'
            || entry.preflight.status === 'timeout'
            || entry.preflight.status === 'failed'
            ? entry.preflight.status
            : 'failed',
          checkedAt: typeof entry.preflight.checkedAt === 'string' ? entry.preflight.checkedAt : new Date().toISOString(),
        } as SourcePreflightResult
      : undefined,
  })) as SearchQualitySnapshot['entries'];
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
      credentialReady: typeof coverageRaw.credentialReady === 'number'
        ? coverageRaw.credentialReady
        : sorted.filter((entry) => entry.credentialStatus === 'ready').length,
      credentialPartial: typeof coverageRaw.credentialPartial === 'number'
        ? coverageRaw.credentialPartial
        : sorted.filter((entry) => entry.credentialStatus === 'partial' || entry.credentialStatus === 'invalid').length,
      credentialMissing: typeof coverageRaw.credentialMissing === 'number'
        ? coverageRaw.credentialMissing
        : sorted.filter((entry) => entry.credentialStatus === 'missing').length,
      preflightVerified: typeof coverageRaw.preflightVerified === 'number'
        ? coverageRaw.preflightVerified
        : sorted.filter((entry) => entry.preflight?.status === 'verified').length,
      preflightCredentialReady: typeof coverageRaw.preflightCredentialReady === 'number'
        ? coverageRaw.preflightCredentialReady
        : sorted.filter((entry) => entry.preflight?.status === 'credential-ready').length,
      preflightAListVerified: typeof coverageRaw.preflightAListVerified === 'number'
        ? coverageRaw.preflightAListVerified
        : sorted.filter((entry) => entry.preflight?.status === 'alist-verified').length,
      preflightJarVerified: typeof coverageRaw.preflightJarVerified === 'number'
        ? coverageRaw.preflightJarVerified
        : sorted.filter((entry) => entry.preflight?.status === 'client-jar-verified').length,
      clientFinalOnly: typeof coverageRaw.clientFinalOnly === 'number'
        ? coverageRaw.clientFinalOnly
        : sorted.filter((entry) => !preflightProvesServerCapability(entry.preflight)
          && entry.grade === 'untestable').length,
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
  // search_quality_pool is the canonical persisted snapshot. Keep a fallback
  // for old deployments that only wrote the legacy snapshot key.
  for (const key of [KV_SEARCH_QUALITY_POOL, KV_SEARCH_QUALITY_SNAPSHOT]) {
    const raw = await storage.get(key);
    if (!raw) continue;
    try {
      return normalizeSnapshot(JSON.parse(raw));
    } catch {
      // try the next compatible key
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
 * 不可探测的 type=3 客户端扩展会先接受服务端配置/接口/凭证/AList/JAR 结构预检；
 * 只有仍需客户端执行 Java 或最终播放验证的源才归入 untestable，且不会进入 HTTP 测速预算。
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

export function candidateKeysFromPool(pool: SearchQualitySnapshot | null): Set<string> {
  const keys = new Set<string>();
  if (!pool || !Array.isArray(pool.entries)) return keys;
  for (const entry of pool.entries) {
    const grade = normalizeGrade(entry.grade);
    if (SERVER_PROBE_GRADES.has(grade)) keys.add(entry.key);
    // credential-ready 中，HTTP 与已通过服务端预检的 client-jar 源都要进入日常候选轮换；
    // 前者重测凭证 HTTP，后者在 TTL 到期后重跑配置/凭证/AList/JAR 结构预检。
    else if (grade === 'credential-ready' && (entry.probeKind === 'credential-http' || entry.probeKind === 'client-jar')) {
      keys.add(entry.key);
    }
    // 尚未通过预检的非 HTTP 源也必须进入候选池，下一轮继续由服务端模拟客户端分析。
    else if (grade === 'untestable') keys.add(entry.key);
  }
  return keys;
}

function probeHeadersForSite(
  site: TVBoxSite,
  credentials: Map<CloudPlatform, CloudCredential>,
  context: QualityCredentialContext,
): Record<string, string> | null {
  const contract = context.contractsBySiteKey.get(site.key);
  if (!contract || contract.credentialMechanism === 'none' || contract.credentialMechanism === 'unknown') return null;
  const platforms = [...new Set(contract.credentialPlatforms || [])];
  if (platforms.length === 0) return null;
  // 多平台源只要求任意一个平台可用即可；用户已登录夸克时，不应因为
  // 同时声明 UC/天翼等未登录平台而完全放弃服务端真实探测。
  const usablePlatforms = platforms.filter((platform) =>
    HTTP_COOKIE_PLATFORMS.has(platform) && isCredentialDistributable(platform, credentials.get(platform))
  );
  if (usablePlatforms.length === 0) return null;
  // 一次探测只能使用一个平台的 Cookie。混拼不同网盘的 Cookie 会让上游
  // 把请求视为无有效会话，既不能证明凭证可用，也可能污染探测结果。
  const selected = usablePlatforms[0];
  const cookie = credentials.get(selected)?.credential.cookie || '';
  if (!cookie) return null;
  const headers: Record<string, string> = { Cookie: cookie };
  try {
    headers.Referer = site.api;
    headers.Origin = new URL(site.api).origin;
  } catch {
    // 保留 Cookie，非标准 URL 仍可尝试请求。
  }
  return headers;
}

export async function batchCredentialAwareSpeedTest(
  sites: TVBoxSite[],
  credentials: Map<CloudPlatform, CloudCredential>,
  timeoutMs = CREDENTIAL_PROBE_TIMEOUT_MS,
  concurrency = DEFAULT_QUALITY_PROBE_CONCURRENCY,
  budgetMs = 25000,
  context: QualityCredentialContext = { contractsBySiteKey: new Map() },
): Promise<Map<string, SiteProbeResult>> {
  const headers = new Map<string, Record<string, string>>();
  for (const site of sites) {
    if (!isSiteProbeable(site)) continue;
    const h = probeHeadersForSite(site, credentials, context);
    if (h) headers.set(site.key, h);
  }
  return batchSiteSpeedTest(sites, timeoutMs, false, concurrency, budgetMs, headers);
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
 * candidate 模式刷新当前优/良/可用候选池，并对凭证源和客户端扩展重跑服务端预检；
 * full 模式重测全部 searchable。timeout/unusable 保留历史统计但不进入候选池。
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
    markRun?: boolean;
    timezone?: string;
    onProgress?: (processed: number, total: number) => Promise<void> | void;
    credentialContext?: QualityCredentialContext;
  } = {},
): Promise<SearchQualitySnapshot> {
  const credentialContext = options.credentialContext ?? await loadQualityCredentialContext(storage);
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

  const healthMap = options.healthMap ?? await loadHealthMap(storage);
  const credentials = await loadCredentials(storage);
  let probeMap = options.probeMap;
  if (!probeMap) {
    const batchSize = Math.max(1, Math.floor(options.batchSize || DEFAULT_BATCH_SIZE));
    const collected = new Map<string, SiteProbeResult>();
    for (let offset = 0; offset < target.length; offset += batchSize) {
      const batch = target.slice(offset, offset + batchSize);
      const partial = await batchCredentialAwareSpeedTest(
        batch,
        credentials,
        options.timeoutMs ?? DEFAULT_QUALITY_PROBE_TIMEOUT_MS,
        options.concurrency ?? DEFAULT_QUALITY_PROBE_CONCURRENCY,
        options.budgetMs ?? 25000,
        credentialContext,
      );
      for (const [key, value] of partial) collected.set(key, value);
      if (options.onProgress) await options.onProgress(collected.size, target.length);
    }
    probeMap = collected;
  }

  const preflightMap = await collectPreflightResults(target, credentials, previousEntries, mode, credentialContext);
  const entries = buildQualityEntries(allSearchable, probeMap, previousEntries, healthMap, credentials, preflightMap, credentialContext);
  const snapshot = buildSnapshot(allSearchable.length, entries, allSearchable);
  await persistQualitySnapshot(storage, snapshot);
  await persistQualityCandidates(storage, allSearchable);
  if (options.markRun !== false) await markQualityRun(storage, new Date(), mode, options.timezone);
  return snapshot;
}

function hasNonEmptyCredentialValue(credential: CloudCredential | undefined): boolean {
  if (!credential?.credential) return false;
  return Object.values(credential.credential).some((value) => typeof value === 'string' && value.trim().length > 0);
}



function credentialStatusForSite(
  site: TVBoxSite,
  platforms: CloudPlatform[],
  credentials: Map<CloudPlatform, CloudCredential>,
  context: QualityCredentialContext,
): SearchQualityEntry['credentialStatus'] {
  const contract = context.contractsBySiteKey.get(site.key);
  if (!contract) return 'invalid';
  if (platforms.length === 0) return 'not-required';
  const configured = platforms.filter((platform) => hasNonEmptyCredentialValue(credentials.get(platform)));
  const valid = platforms.filter((platform) => (
    isCredentialDistributable(platform, credentials.get(platform))
    && (platform === 'pan123' || platform === 'thunder' || platform === 'tianyi' || platform === 'quark' || platform === 'uc' || platform === 'baidu'
      ? isPanInitCredentialDistributable(platform, credentials.get(platform))
      : true)
  ));
  if (configured.length === 0) return 'missing';
  // 只有真实注入路径会让 ext 发生变化时才算 ready；仅保存了凭证但源不支持该平台
  // 不能伪装成可下发。多平台源只需一个平台能注入。
  if (valid.length > 0 && canDistributeCredentialsToSite(
    site,
    credentials,
    'https://credential.invalid',
    context.globalSpider,
    contract,
  )) return 'ready';
  if (configured.length === platforms.length) return 'invalid';
  return 'partial';
}

const PREFLIGHT_SETTLED_STATUSES = new Set<SourcePreflightResult['status']>([
  'verified',
  'credential-ready',
  'alist-verified',
  'client-jar-verified',
]);

/** 预检是否在服务端拿到了真实、可确认的结果（而不是仍需客户端执行）。 */
function preflightProvesServerCapability(preflight: SourcePreflightResult | undefined): boolean {
  return !!preflight && PREFLIGHT_SETTLED_STATUSES.has(preflight.status);
}

function isFreshPreflight(preflight: SourcePreflightResult | undefined, now: number): boolean {
  if (!preflightProvesServerCapability(preflight)) return false;
  const checked = Date.parse(preflight?.checkedAt || '');
  return Number.isFinite(checked) && now - checked <= QUALITY_PREFLIGHT_TTL_MS;
}

/**
 * 由服务端预检结果推导质量分级。
 * 服务端已经真实请求成功的源提升到 credential-ready（候选池靠前），
 * 只有确实无法在服务端模拟、必须交给客户端最终执行/播放的才留在 untestable。
 */
function gradeFromPreflight(
  preflight: SourcePreflightResult | undefined,
  credentialStatus: SearchQualityEntry['credentialStatus'],
): SiteQualityGrade {
  if (preflightProvesServerCapability(preflight)) return 'credential-ready';
  return credentialStatus === 'ready' ? 'credential-ready' : 'untestable';
}

/**
 * 对不可 HTTP 测速的源执行服务端预检。candidate 模式下 TTL 内复用上一轮结果，
 * full 模式总是重跑；整体受一个时间预算约束，超预算时保留上一轮结果。
 */
async function collectPreflightResults(
  sites: TVBoxSite[],
  credentials: Map<CloudPlatform, CloudCredential>,
  previousEntries: Map<string, SearchQualityEntry>,
  mode: SearchQualityRunMode,
  context: QualityCredentialContext,
): Promise<Map<string, SourcePreflightResult>> {
  const out = new Map<string, SourcePreflightResult>();
  const pending: TVBoxSite[] = [];
  const now = Date.now();
  for (const site of sites) {
    if (isSiteProbeable(site)) continue;
    const previous = previousEntries.get(site.key)?.preflight;
    if (mode !== 'full' && isFreshPreflight(previous, now)) {
      out.set(site.key, previous as SourcePreflightResult);
      continue;
    }
    pending.push(site);
  }
  if (pending.length === 0) return out;

  const fallback = (site: TVBoxSite): SourcePreflightResult =>
    previousEntries.get(site.key)?.preflight ?? {
      status: 'timeout',
      reason: 'preflight-budget-exhausted',
      message: '服务端预检超出本轮时间预算，下一轮继续',
      checkedAt: new Date().toISOString(),
    };

  // 批次内部设置真实截止时间并 AbortController 中止在途请求；
  // 超预算后不再启动新源，也不会让后台任务与下一轮分级重叠。
  const settled = await preflightSourcesBatch(pending, credentials, {
    timeoutMs: QUALITY_PREFLIGHT_TIMEOUT_MS,
    concurrency: QUALITY_PREFLIGHT_CONCURRENCY,
    budgetMs: QUALITY_PREFLIGHT_BUDGET_MS,
    contractsBySiteKey: context.contractsBySiteKey,
    globalSpider: context.globalSpider,
  });
  for (const [key, value] of settled) out.set(key, value);
  for (const site of pending) {
    if (!out.has(site.key)) out.set(site.key, fallback(site));
  }
  return out;
}

function buildQualityEntries(
  searchable: TVBoxSite[],
  probeMap: Map<string, SiteProbeResult>,
  previousEntries: Map<string, SearchQualitySnapshot['entries'][number]>,
  healthMap: SiteHealthMap,
  credentials: Map<CloudPlatform, CloudCredential>,
  preflightMap: Map<string, SourcePreflightResult> = new Map(),
  context: QualityCredentialContext = { contractsBySiteKey: new Map() },
): SearchQualitySnapshot['entries'] {
  const now = new Date().toISOString();
  return searchable.map((site) => {
    const contract = context.contractsBySiteKey.get(site.key);
    const credentialPlatforms = [...new Set(contract?.credentialPlatforms || [])];
    const credentialStatus = credentialStatusForSite(site, credentialPlatforms, credentials, context);
    if (!isSiteProbeable(site)) {
      // 先模拟客户端行为做服务端预检，再决定分级；不再无条件判为“客户端登录/JAR”。
      const previousEntry = previousEntries.get(site.key);
      const preflight = preflightMap.get(site.key) ?? previousEntry?.preflight;
      return {
        key: site.key,
        name: site.name || site.key,
        grade: gradeFromPreflight(preflight, credentialStatus),
        speedMs: null,
        result: 'not_probed',
        probedAt: preflight?.checkedAt || previousEntry?.probedAt,
        consecutiveFailures: 0,
        credentialPlatforms,
        credentialStatus,
        probeKind: 'client-jar',
        preflight,
      };
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
    const hasCredentialProbe = !!probeHeadersForSite(site, credentials, context);
    let grade: SiteQualityGrade;
    let entryProbe: SiteProbeResult | undefined;
    if (credentialPlatforms.length > 0 && !hasCredentialProbe) {
      // 需要的平台无法全部映射为 HTTP Cookie（token-only、部分凭证或 JAR 专用）时，
      // 绝不能使用未带凭证的普通 HTTP 结果提升为优/良/可用。
      grade = credentialStatus === 'ready' ? 'credential-ready' : 'untestable';
      entryProbe = undefined;
    } else if (hasCredentialProbe && credentialStatus === 'ready') {
      entryProbe = effectiveProbe;
      if (!freshProbe && previousEntry) {
        // 分块运行只探测当前批次。未覆盖的凭证源必须保留上一轮已测得等级，
        // 否则每处理一个分片都会把其他源错误降级。
        grade = previousEntry.grade;
      } else if (freshProbe && probe!.result === 'ok') {
        grade = gradeForProbe(probe, consecutiveFailures);
      } else {
        // 凭证探测失败不能永久把源判死：凭证过期、上游风控或服务端 IP
        // 限制都会造成一次失败。回退到“凭证就绪”，由客户端最终播放验证。
        grade = 'credential-ready';
      }
    } else {
      entryProbe = effectiveProbe;
      grade = gradeForProbe(effectiveProbe, consecutiveFailures);
    }
    return {
      key: site.key,
      name: site.name || site.key,
      grade,
      speedMs: entryProbe?.speedMs ?? null,
      result: entryProbe?.result ?? 'not_probed',
      probedAt: entryProbe ? (freshProbe ? now : previousEntry?.probedAt) : undefined,
      consecutiveFailures,
      credentialPlatforms,
      credentialStatus,
      probeKind: hasCredentialProbe ? 'credential-http' : (credentialPlatforms.length > 0 ? 'client-jar' : 'http'),
    };
  });
}

function buildCoverage(sites: TVBoxSite[], entries: SearchQualitySnapshot['entries']) {
  let testable = 0;
  let untestable = 0;
  const probeableKeys = new Set<string>();
  for (const site of sites) {
    if (isSiteProbeable(site)) {
      testable++;
      probeableKeys.add(site.key);
    } else {
      untestable++;
    }
  }
  const probed = entries.filter((entry) => entry.result !== 'not_probed').length;
  return {
    testable,
    probed,
    notProbed: Math.max(0, testable - probed),
    untestable,
    credentialReady: entries.filter((entry) => entry.credentialStatus === 'ready').length,
    credentialPartial: entries.filter((entry) => entry.credentialStatus === 'partial' || entry.credentialStatus === 'invalid').length,
    credentialMissing: entries.filter((entry) => entry.credentialStatus === 'missing').length,
    preflightVerified: entries.filter((entry) => entry.preflight?.status === 'verified').length,
    preflightCredentialReady: entries.filter((entry) => entry.preflight?.status === 'credential-ready').length,
    preflightAListVerified: entries.filter((entry) => entry.preflight?.status === 'alist-verified').length,
    preflightJarVerified: entries.filter((entry) => entry.preflight?.status === 'client-jar-verified').length,
    clientFinalOnly: entries.filter((entry) => !probeableKeys.has(entry.key)
      && !preflightProvesServerCapability(entry.preflight)).length,
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
  // Pool is the canonical key consumed by scheduling and downloads. Avoid
  // writing the same potentially large payload to a second legacy key.
  await storage.put(KV_SEARCH_QUALITY_POOL, JSON.stringify(snapshot));
}

export async function persistQualityCandidates(storage: Storage, sites: TVBoxSite[]): Promise<void> {
  const searchable = collectSearchableSites(sites);
  await storage.put(KV_SEARCH_QUALITY_CANDIDATES, JSON.stringify({
    updatedAt: new Date().toISOString(),
    sites: stripInternalSiteMarkers({ sites: searchable }).sites,
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
  credentialContext?: QualityCredentialContext,
): Promise<{ done: boolean; cursor: number; processed: number; targetTotal: number; mode: SearchQualityRunMode; snapshot?: SearchQualitySnapshot }> {
  const context = credentialContext ?? await loadQualityCredentialContext(storage);
  const allSearchable = collectSearchableSites(sites);
  const previous = await loadQualityPool(storage);
  const previousEntries = new Map((previous?.entries || []).map((entry) => [entry.key, entry]));
  const credentials = await loadCredentials(storage);
  let mode = requestedMode;
  let target = qualityTargetSites(allSearchable, previous, requestedMode);
  if (target.length === 0) {
    mode = 'full';
    target = allSearchable;
  }
  const start = Math.max(0, Math.floor(cursor));
  if (start >= target.length) {
    const entries = buildQualityEntries(allSearchable, new Map(), previousEntries, await loadHealthMap(storage), credentials, new Map(), context);
    const snapshot = buildSnapshot(allSearchable.length, entries, allSearchable);
    await persistQualitySnapshot(storage, snapshot);
    await persistQualityCandidates(storage, allSearchable);
    await markQualityRun(storage, new Date(), mode, timezone);
    return { done: true, cursor: target.length, processed: 0, targetTotal: target.length, mode, snapshot };
  }

  const batch = target.slice(start, start + Math.max(1, batchSize));
  const probeMap = await batchCredentialAwareSpeedTest(
    batch,
    credentials,
    DEFAULT_QUALITY_PROBE_TIMEOUT_MS,
    DEFAULT_QUALITY_PROBE_CONCURRENCY,
    Math.max(10000, DEFAULT_QUALITY_PROBE_TIMEOUT_MS * DEFAULT_QUALITY_PROBE_CONCURRENCY),
    context,
  );
  const healthMap = await loadHealthMap(storage);
  const preflightMap = await collectPreflightResults(batch, credentials, previousEntries, mode, context);
  const entries = buildQualityEntries(allSearchable, probeMap, previousEntries, healthMap, credentials, preflightMap, context);
  const snapshot = buildSnapshot(allSearchable.length, entries, allSearchable);
  await persistQualitySnapshot(storage, snapshot);
  const done = start + batch.length >= target.length;
  // Candidate payloads are static during a chunked run. Persist them at the
  // start or finish instead of rewriting the full list on every chunk.
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

/** 不进入下发候选池的 key 集合（超时 + 不可用）。 */
export function excludedQualityKeys(pool: SearchQualitySnapshot | null): Set<string> {
  const keys = new Set<string>();
  if (!pool || !Array.isArray(pool.entries)) return keys;
  for (const entry of pool.entries) {
    const grade = normalizeGrade(entry.grade);
    if (grade === 'timeout' || grade === 'unusable') keys.add(entry.key);
  }
  return keys;
}
