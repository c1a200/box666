export interface SourceListEntry {
  name: string;
  url: string;
  configKey?: string;
  line: number;
  explicitName?: boolean;
}

export interface SourceListInvalid {
  line: number;
  text: string;
  reason: string;
}

export interface SourceListParseResult {
  entries: SourceListEntry[];
  invalid: SourceListInvalid[];
  duplicates: number;
}

const URL_TOKEN_RE = /https?:\/\/[^\s|]+/i;

export function autoNameFromUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.hostname.includes('githubusercontent.com') || parsed.hostname.includes('github.com')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return parts[0];
    }

    const pathname = parsed.pathname;
    const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
    const dotIdx = filename.lastIndexOf('.');
    const nameWithoutExt = dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
    if (nameWithoutExt && !/^\d+$/.test(nameWithoutExt)) return nameWithoutExt;
    return parsed.hostname || 'Imported';
  } catch {
    return 'Imported';
  }
}

export function splitPkUrl(input: string, explicitKey?: string): { url: string; configKey: string } {
  let url = input.trim();
  let configKey = explicitKey?.trim() || '';
  const pkIndex = url.indexOf(';pk;');
  if (pkIndex !== -1) {
    const key = url.slice(pkIndex + 4).trim();
    configKey = configKey || key;
    url = url.slice(0, pkIndex).trim();
  }
  return { url, configKey };
}

function trimUrlToken(value: string): string {
  return value
    .trim()
    .replace(/^[<(\["']+/, '')
    .replace(/[>)\]"']+$/, '')
    .replace(/[，。；、,]+$/, '');
}

function trimSideText(value: string): string {
  return value
    .trim()
    .replace(/^[-*•]\s*/, '')
    .replace(/^[|,，:：;；\t-]+/, '')
    .replace(/[|,，:：;；\t-]+$/, '')
    .trim();
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parse a compact source list. Each non-comment line may use one of:
 *   名称 URL
 *   URL 名称
 *   URL
 *
 * The URL may include the existing TVBox `;pk;<key>` suffix. Duplicate URLs
 * are reported and only the first occurrence is returned.
 */
export function parseSourceList(input: string): SourceListParseResult {
  const entries: SourceListEntry[] = [];
  const invalid: SourceListInvalid[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith('#')) continue;

    const match = raw.match(URL_TOKEN_RE);
    if (!match || match.index === undefined) {
      invalid.push({ line: index + 1, text: raw, reason: 'missing URL' });
      continue;
    }

    const rawUrl = trimUrlToken(match[0]);
    const start = match.index;
    const end = start + match[0].length;
    const prefix = trimSideText(raw.slice(0, start));
    const suffix = trimSideText(raw.slice(end));

    if (prefix && suffix) {
      invalid.push({ line: index + 1, text: raw, reason: 'ambiguous name position' });
      continue;
    }

    const split = splitPkUrl(rawUrl);
    if (!isHttpUrl(split.url)) {
      invalid.push({ line: index + 1, text: raw, reason: 'invalid URL' });
      continue;
    }

    if (seen.has(split.url)) {
      duplicates++;
      continue;
    }
    seen.add(split.url);

    const explicitName = !!(prefix || suffix);
    const entry: SourceListEntry = {
      name: prefix || suffix || autoNameFromUrl(split.url),
      url: split.url,
      line: index + 1,
      explicitName,
    };
    if (split.configKey) entry.configKey = split.configKey;
    entries.push(entry);
  }

  return { entries, invalid, duplicates };
}
export type SourceBackupKind = 'tvbox-sources' | 'maccms-sources' | 'live-sources';

export interface SourceBackup<T = unknown> {
  version: 1;
  type: SourceBackupKind;
  exportedAt: string;
  items: T[];
}

export function createSourceBackup<T>(type: SourceBackupKind, items: T[]): SourceBackup<T> {
  return {
    version: 1,
    type,
    exportedAt: new Date().toISOString(),
    items,
  };
}

/**
 * Accept both the current versioned backup and legacy raw arrays. For live
 * sources, a TVBox config containing a `lives` array is also accepted.
 */
const SOURCE_BACKUP_KINDS: ReadonlyArray<SourceBackupKind> = ['tvbox-sources', 'maccms-sources', 'live-sources'];

/**
 * Returns a human-readable mismatch message when the payload explicitly
 * declares a different known backup type, otherwise null.
 */
export function backupTypeMismatch(parsed: unknown, type: SourceBackupKind): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const declared = (parsed as { type?: unknown }).type;
  if (typeof declared !== 'string') return null;
  if (!SOURCE_BACKUP_KINDS.includes(declared as SourceBackupKind)) return null;
  if (declared === type) return null;
  return declared;
}
export function extractBackupItems(parsed: unknown, type: SourceBackupKind): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    if (typeof record.type === 'string' && record.type !== type) return null;
    return record.items;
  }
  if (type === 'live-sources' && Array.isArray(record.lives)) return record.lives;
  return null;
}
