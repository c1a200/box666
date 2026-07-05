const VERBOSE_TRUE = new Set(['1', 'true', 'yes', 'on']);

export type LogFields = Record<string, unknown>;
export type LogLevel = 'info' | 'warn' | 'error' | 'security' | 'debug';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
}

type LogSink = (entry: LogEntry) => void;
const sinks = new Set<LogSink>();

export function subscribeLogSink(fn: LogSink): () => void {
  sinks.add(fn);
  return () => { sinks.delete(fn); };
}

function emitSink(entry: LogEntry): void {
  for (const fn of sinks) {
    try {
      fn(entry);
    } catch {
      // Never log from sink dispatch; that can recurse back into logger.
    }
  }
}

export function isVerbose(): boolean {
  try {
    return VERBOSE_TRUE.has(String(process.env.VERBOSE || '').trim().toLowerCase());
  } catch {
    return false;
  }
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const raw = formatValue(value).replace(/\s+/g, ' ').trim();
      if (!raw) return `${key}=""`;
      if (/^[A-Za-z0-9_./:@?&=%+\-[\],]+$/.test(raw)) return `${key}=${raw}`;
      return `${key}=${JSON.stringify(raw)}`;
    })
    .join(' ');
}

function formatTimestamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

function formatLine(ts: string, level: string, scope: string, message: string): string {
  const label = level.padEnd(8);
  if (isVerbose()) return `${ts} ${label} [${scope}] ${message}`;
  return `${ts} ${label} ${message}`;
}

export const logger = {
  info(scope: string, message: string): void {
    const ts = formatTimestamp();
    emitSink({ ts, level: 'info', scope, message });
    console.log(formatLine(ts, 'INFO', scope, message));
  },

  infoFields(scope: string, event: string, fields: LogFields): void {
    this.info(scope, `${event} ${formatFields(fields)}`.trim());
  },

  debug(scope: string, message: string): void {
    if (!isVerbose()) return;
    const ts = formatTimestamp();
    emitSink({ ts, level: 'debug', scope, message });
    console.log(formatLine(ts, 'DEBUG', scope, message));
  },

  debugFields(scope: string, event: string, fields: LogFields): void {
    this.debug(scope, `${event} ${formatFields(fields)}`.trim());
  },

  warn(scope: string, message: string): void {
    const ts = formatTimestamp();
    emitSink({ ts, level: 'warn', scope, message });
    console.warn(formatLine(ts, 'WARN', scope, message));
  },

  warnFields(scope: string, event: string, fields: LogFields): void {
    this.warn(scope, `${event} ${formatFields(fields)}`.trim());
  },

  error(scope: string, message: string): void {
    const ts = formatTimestamp();
    emitSink({ ts, level: 'error', scope, message });
    console.error(formatLine(ts, 'ERROR', scope, message));
  },

  errorFields(scope: string, event: string, fields: LogFields): void {
    this.error(scope, `${event} ${formatFields(fields)}`.trim());
  },

  security(event: string, fields: LogFields): void {
    const ts = formatTimestamp();
    const message = `${event} ${formatFields(fields)}`.trim();
    emitSink({ ts, level: 'security', scope: 'security', message });
    console.warn(formatLine(ts, 'SECURITY', 'security', message));
  },
};
