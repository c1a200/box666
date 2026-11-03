import type { Storage } from '../storage/interface';
import type { ChannelProbeSchedule } from './types';
import type { ChannelProbeWorkingState } from './live-speed-store';
import {
  DEFAULT_CHANNEL_PROBE_REPEAT_DAYS,
  DEFAULT_CHANNEL_PROBE_TIME,
  KV_CHANNEL_PROBE_INTERVAL,
  KV_CHANNEL_PROBE_SCHEDULE,
  MAX_CHANNEL_PROBE_REPEAT_DAYS,
  MAX_CHANNEL_PROBE_TIMES,
} from './config';

export const CHANNEL_PROBE_WORKING_RESUME_MS = 24 * 60 * 60 * 1000;
export const CHANNEL_PROBE_TIMEZONE = 'Asia/Shanghai';

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function normalizeChannelProbeTimezone(value?: string): string {
  const raw = (value || '').trim();
  if (!raw) return CHANNEL_PROBE_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    return CHANNEL_PROBE_TIMEZONE;
  }
}

export function normalizeChannelProbeTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeChannelProbeTimes(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback.slice();
  const times = [...new Set(
    value
      .map((item) => normalizeChannelProbeTime(item))
      .filter((item): item is string => Boolean(item)),
  )].sort();
  return times.length > 0 ? times.slice(0, MAX_CHANNEL_PROBE_TIMES) : fallback.slice();
}

export function normalizeChannelProbeRepeatDays(value: unknown, fallback = DEFAULT_CHANNEL_PROBE_REPEAT_DAYS): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_CHANNEL_PROBE_REPEAT_DAYS, Math.max(1, Math.floor(parsed)));
}

function zonedParts(date: Date, timezone: string): LocalDateTimeParts {
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

function addDays(parts: Pick<LocalDateTimeParts, 'year' | 'month' | 'day'>, days: number): LocalDateTimeParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: 0,
    minute: 0,
  };
}

function zonedLocalToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): string {
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

function localDateNumber(parts: Pick<LocalDateTimeParts, 'year' | 'month' | 'day'>): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
}

function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

/**
 * The selected times run on each active day. `repeatDays > 1` means every
 * N days; all configured times on an active day are separate run slots.
 */
export function computeNextChannelProbeRun(
  schedule: ChannelProbeSchedule,
  now = new Date(),
  timezone = schedule.timezone || CHANNEL_PROBE_TIMEZONE,
): string | undefined {
  const times = normalizeChannelProbeTimes(schedule.times, []);
  if (times.length === 0 || !Number.isFinite(now.getTime())) return undefined;

  const effectiveTimezone = normalizeChannelProbeTimezone(timezone);
  const repeatDays = normalizeChannelProbeRepeatDays(schedule.repeatDays);
  const local = zonedParts(now, effectiveTimezone);
  const nowMinute = local.hour * 60 + local.minute;
  const lastRun = parseDate(schedule.lastRunAt);

  if (!lastRun || lastRun.getTime() > now.getTime()) {
    const nextTime = times.find((time) => timeToMinutes(time) > nowMinute);
    if (nextTime) {
      const [hour, minute] = nextTime.split(':').map(Number);
      return zonedLocalToUtcIso(local.year, local.month, local.day, hour, minute, effectiveTimezone);
    }
    const target = addDays(local, 1);
    const [hour, minute] = times[0].split(':').map(Number);
    return zonedLocalToUtcIso(target.year, target.month, target.day, hour, minute, effectiveTimezone);
  }

  const lastLocal = zonedParts(lastRun, effectiveTimezone);
  const daysSinceLastRunDay = Math.floor(
    (localDateNumber(local) - localDateNumber(lastLocal)) / 86400000,
  );
  const isActiveToday = daysSinceLastRunDay >= 0 && daysSinceLastRunDay % repeatDays === 0;

  if (isActiveToday) {
    const nextTime = times.find((time) => timeToMinutes(time) > nowMinute);
    if (nextTime) {
      const [hour, minute] = nextTime.split(':').map(Number);
      return zonedLocalToUtcIso(local.year, local.month, local.day, hour, minute, effectiveTimezone);
    }
  }

  const remainder = daysSinceLastRunDay % repeatDays;
  const offset = isActiveToday
    ? repeatDays
    : (remainder === 0 ? repeatDays : repeatDays - remainder);
  const target = addDays(local, offset);
  const [hour, minute] = times[0].split(':').map(Number);
  return zonedLocalToUtcIso(target.year, target.month, target.day, hour, minute, effectiveTimezone);
}

export function defaultChannelProbeSchedule(
  now = new Date(),
  timezone = CHANNEL_PROBE_TIMEZONE,
  initialTime = DEFAULT_CHANNEL_PROBE_TIME,
): ChannelProbeSchedule {
  const effectiveTimezone = normalizeChannelProbeTimezone(timezone);
  const schedule: ChannelProbeSchedule = {
    times: [normalizeChannelProbeTime(initialTime) || DEFAULT_CHANNEL_PROBE_TIME],
    repeatDays: DEFAULT_CHANNEL_PROBE_REPEAT_DAYS,
    timezone: effectiveTimezone,
  };
  schedule.nextRunAt = computeNextChannelProbeRun(schedule, now, effectiveTimezone);
  return schedule;
}

function legacyProbeTimes(value: string | null, initialTime: string): string[] {
  const minutes = parseInt(value || '', 10);
  if (minutes === 360) return ['00:00', '06:00', '12:00', '18:00'];
  if (minutes === 720) return ['00:00', '12:00'];
  return [normalizeChannelProbeTime(initialTime) || DEFAULT_CHANNEL_PROBE_TIME];
}

export async function loadChannelProbeSchedule(
  storage: Storage,
  timezone = CHANNEL_PROBE_TIMEZONE,
  initialTime = DEFAULT_CHANNEL_PROBE_TIME,
  now = new Date(),
): Promise<ChannelProbeSchedule> {
  const effectiveTimezone = normalizeChannelProbeTimezone(timezone);
  const fallback = defaultChannelProbeSchedule(now, effectiveTimezone, initialTime);
  const raw = await storage.get(KV_CHANNEL_PROBE_SCHEDULE);

  if (!raw) {
    const legacy = await storage.get(KV_CHANNEL_PROBE_INTERVAL);
    fallback.times = legacyProbeTimes(legacy, initialTime);
    fallback.nextRunAt = computeNextChannelProbeRun(fallback, now, effectiveTimezone);
    await storage.put(KV_CHANNEL_PROBE_SCHEDULE, JSON.stringify(fallback));
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ChannelProbeSchedule>;
    const schedule: ChannelProbeSchedule = {
      times: normalizeChannelProbeTimes(parsed.times, fallback.times),
      repeatDays: normalizeChannelProbeRepeatDays(parsed.repeatDays),
      timezone: effectiveTimezone,
      lastRunAt: parseDate(parsed.lastRunAt)?.toISOString(),
      nextRunAt: parseDate(parsed.nextRunAt)?.toISOString(),
    };
    const timezoneChanged = typeof parsed.timezone !== 'string' || parsed.timezone.trim() !== effectiveTimezone;
    if (timezoneChanged || !schedule.nextRunAt) {
      schedule.nextRunAt = computeNextChannelProbeRun(schedule, now, effectiveTimezone);
      await storage.put(KV_CHANNEL_PROBE_SCHEDULE, JSON.stringify(schedule));
    }
    return schedule;
  } catch {
    await storage.put(KV_CHANNEL_PROBE_SCHEDULE, JSON.stringify(fallback));
    return fallback;
  }
}

export async function saveChannelProbeSchedule(
  storage: Storage,
  input: Partial<Pick<ChannelProbeSchedule, 'times' | 'repeatDays'>>,
  timezone = CHANNEL_PROBE_TIMEZONE,
  initialTime = DEFAULT_CHANNEL_PROBE_TIME,
  now = new Date(),
): Promise<ChannelProbeSchedule> {
  const effectiveTimezone = normalizeChannelProbeTimezone(timezone);
  const current = await loadChannelProbeSchedule(storage, effectiveTimezone, initialTime, now);
  const schedule: ChannelProbeSchedule = {
    times: normalizeChannelProbeTimes(input.times, current.times),
    repeatDays: normalizeChannelProbeRepeatDays(input.repeatDays, current.repeatDays),
    timezone: effectiveTimezone,
    lastRunAt: current.lastRunAt,
    nextRunAt: undefined,
  };
  schedule.nextRunAt = computeNextChannelProbeRun(schedule, now, effectiveTimezone);
  await storage.put(KV_CHANNEL_PROBE_SCHEDULE, JSON.stringify(schedule));
  return schedule;
}

export async function markChannelProbeRun(
  storage: Storage,
  at = new Date(),
  timezone = CHANNEL_PROBE_TIMEZONE,
  initialTime = DEFAULT_CHANNEL_PROBE_TIME,
): Promise<ChannelProbeSchedule> {
  const schedule = await loadChannelProbeSchedule(storage, timezone, initialTime, at);
  schedule.lastRunAt = at.toISOString();
  schedule.nextRunAt = computeNextChannelProbeRun(schedule, at, schedule.timezone);
  await storage.put(KV_CHANNEL_PROBE_SCHEDULE, JSON.stringify(schedule));
  return schedule;
}

export async function isChannelProbeScheduleDue(
  storage: Storage,
  now = new Date(),
  timezone = CHANNEL_PROBE_TIMEZONE,
  initialTime = DEFAULT_CHANNEL_PROBE_TIME,
): Promise<boolean> {
  const schedule = await loadChannelProbeSchedule(storage, timezone, initialTime, now);
  if (!schedule.nextRunAt) return false;
  const next = Date.parse(schedule.nextRunAt);
  return Number.isFinite(next) && next <= now.getTime();
}

/** An interrupted full run must win over the stored schedule and resume. */
export function isResumableFullProbeWorkingState(
  working: ChannelProbeWorkingState | null,
  nowMs = Date.now(),
  maxAgeMs = CHANNEL_PROBE_WORKING_RESUME_MS,
): boolean {
  if (!working || working.evaluationMode !== 'full' || working.completed === true) return false;
  const startedMs = Date.parse(working.runStartedAt);
  const ageMs = nowMs - startedMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeMs;
}
