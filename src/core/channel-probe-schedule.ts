import type { ChannelProbeWorkingState } from './live-speed-store';

export const CHANNEL_PROBE_WORKING_RESUME_MS = 24 * 60 * 60 * 1000;

function calendarDateInTimeZone(value: string | Date, timeZone: string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()) || !timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

/** A successful full run is a daily checkpoint, not a rolling 23-hour lease. */
export function hasCompletedFullProbeForCalendarDay(
  fullPublishedAt: string | undefined,
  now: Date,
  timeZone: string,
): boolean {
  if (!fullPublishedAt) return false;
  const publishedMs = Date.parse(fullPublishedAt);
  if (!Number.isFinite(publishedMs) || publishedMs > now.getTime()) return false;
  const publishedDate = calendarDateInTimeZone(fullPublishedAt, timeZone);
  const currentDate = calendarDateInTimeZone(now, timeZone);
  return Boolean(publishedDate && currentDate && publishedDate === currentDate);
}

/** An interrupted full run must win over an older same-day published result. */
export function isResumableFullProbeWorkingState(
  working: ChannelProbeWorkingState | null,
  nowMs = Date.now(),
  maxAgeMs = CHANNEL_PROBE_WORKING_RESUME_MS,
): boolean {
  if (!working || working.evaluationMode !== 'full' || working.completed === true) return false;
  const startedMs = Date.parse(working.runStartedAt);
  const ageMs = nowMs - startedMs;
  return Number.isFinite(startedMs) && ageMs >= 0 && ageMs < maxAgeMs;
}
