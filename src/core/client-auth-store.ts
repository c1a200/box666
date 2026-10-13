// 客户端鉴权与源分发配置存储。
// 该模块不保存、加密或注入任何网盘凭证；仅管理鉴权码和源下发策略。

import type { Storage } from '../storage/interface';
import type {
  ClientAuthCode,
  ClientDistributionConfig,
  SiteBucketLimits,
  SiteQualityGrade,
  SourceCategory,
  SourceDistributionMode,
  SourceSelectionMode,
} from './types';
import { SOURCE_CATEGORIES } from './types';
import {
  KV_CLIENT_AUTH_DISTRIBUTION,
  KV_CREDENTIAL_DISTRIBUTION,
} from './config';

const AUTH_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCE_MODES = new Set<SourceDistributionMode>(['all', 'search', 'selected', 'custom']);
const QUALITY_GRADES = new Set<SiteQualityGrade>([
  'excellent',
  'good',
  'usable',
  'untestable',
  'timeout',
  'unusable',
]);

export const DEFAULT_CLIENT_DISTRIBUTION: ClientDistributionConfig = {
  requireAuth: false,
  authCodes: [],
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function randomToken(bytes = 8): string {
  const values = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(values);
  } else {
    for (let i = 0; i < values.length; i++) values[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(values, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomAuthId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'auth_' + randomToken(12);
}

function parseThreeStateInteger(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return fallback;
  if (number === -1 || number >= 0) return number;
  return fallback;
}

function normalizeStringArray(value: unknown, max = 500): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  )].slice(0, max);
}

function normalizeGrades(value: unknown): SiteQualityGrade[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter((item): item is SiteQualityGrade => typeof item === 'string' && QUALITY_GRADES.has(item as SiteQualityGrade)),
  )];
}

const LEGACY_SITE_TYPE_MAP: Record<string, SourceCategory[]> = {
  '0': ['xml'],
  '1': ['json'],
  '3': ['jar', 'js'],
  '4': ['remote'],
};

function normalizeSiteTypeValues(value: unknown): SourceCategory[] {
  if (typeof value === 'string' && SOURCE_CATEGORIES.includes(value as SourceCategory)) {
    return [value as SourceCategory];
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return LEGACY_SITE_TYPE_MAP[String(value)] || [];
  }
  return [];
}

function normalizeSiteTypes(value: unknown): SourceCategory[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.flatMap((item) => normalizeSiteTypeValues(item));
  return SOURCE_CATEGORIES.filter((category) => normalized.includes(category));
}

function normalizeNumberMap(value: unknown, allowedKeys?: Set<string>): Partial<Record<string, number>> {
  const source = asRecord(value);
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    const number = parseThreeStateInteger(raw, Number.NaN);
    if (!Number.isFinite(number)) continue;
    // -1 = 全选/不限制；0 = 明确不选；正数 = 保留前 N 个。
    result[key] = number === -1 ? -1 : Math.max(0, number);
  }
  return result;
}

function normalizeBucketLimits(value: unknown): SiteBucketLimits | undefined {
  const source = asRecord(value);
  const quality = normalizeNumberMap(source.quality, new Set(['excellent', 'good', 'usable', 'untestable']));
  const rawType = asRecord(source.type);
  const type: Partial<Record<SourceCategory, number>> = {};
  for (const category of SOURCE_CATEGORIES) {
    const limit = parseThreeStateInteger(rawType[category], Number.NaN);
    if (Number.isFinite(limit)) type[category] = limit === -1 ? -1 : Math.max(0, limit);
  }
  for (const [legacyKey, categories] of Object.entries(LEGACY_SITE_TYPE_MAP)) {
    const legacyLimit = parseThreeStateInteger(rawType[legacyKey], Number.NaN);
    if (!Number.isFinite(legacyLimit)) continue;
    for (const category of categories) {
      if (type[category] === undefined) type[category] = legacyLimit === -1 ? -1 : Math.max(0, legacyLimit);
    }
  }
  const hasQuality = Object.keys(quality).length > 0;
  const hasType = Object.keys(type).length > 0;
  if (!hasQuality && !hasType) return undefined;
  return {
    ...(hasQuality ? { quality: quality as SiteBucketLimits['quality'] } : {}),
    ...(hasType ? { type: type as SiteBucketLimits['type'] } : {}),
  };
}

function hasBucketGroup(limits: SiteBucketLimits | undefined, group: 'quality' | 'type'): boolean {
  return !!limits && !!limits[group] && Object.keys(limits[group] || {}).length > 0;
}

function mergeLegacyClientFilters(
  limits: SiteBucketLimits | undefined,
  legacyGrades: SiteQualityGrade[],
  legacyTypes: SourceCategory[],
): SiteBucketLimits | undefined {
  const quality = { ...(limits?.quality || {}) };
  const type = { ...(limits?.type || {}) };
  if (!hasBucketGroup(limits, 'quality') && legacyGrades.length > 0) {
    for (const grade of ['excellent', 'good', 'usable', 'untestable'] as const) {
      quality[grade] = legacyGrades.includes(grade) ? -1 : 0;
    }
  }
  if (!hasBucketGroup(limits, 'type') && legacyTypes.length > 0) {
    for (const category of SOURCE_CATEGORIES) {
      type[category] = legacyTypes.includes(category) ? -1 : 0;
    }
  }
  if (Object.keys(quality).length === 0 && Object.keys(type).length === 0) return undefined;
  return {
    ...(Object.keys(quality).length ? { quality } : {}),
    ...(Object.keys(type).length ? { type } : {}),
  };
}

function normalizeSourceMode(value: unknown): SourceDistributionMode {
  return typeof value === 'string' && SOURCE_MODES.has(value as SourceDistributionMode)
    ? value as SourceDistributionMode
    : 'all';
}

function normalizeSelectionMode(value: unknown, fallback: SourceSelectionMode): SourceSelectionMode {
  return value === 'category' || value === 'simple' ? value : fallback;
}

function normalizeAuthCode(raw: unknown, usedCodes: Set<string>, usedIds: Set<string>): ClientAuthCode | null {
  const entry = asRecord(raw);
  const code = typeof entry.code === 'string' ? entry.code.trim() : '';
  if (!AUTH_CODE_RE.test(code) || usedCodes.has(code)) return null;
  usedCodes.add(code);

  let id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : randomAuthId();
  if (usedIds.has(id)) id = randomAuthId();
  usedIds.add(id);

  const now = new Date().toISOString();
  const createdAt = typeof entry.createdAt === 'string' && entry.createdAt ? entry.createdAt : now;
  const updatedAt = typeof entry.updatedAt === 'string' && entry.updatedAt ? entry.updatedAt : createdAt;
  const label = typeof entry.label === 'string' && entry.label.trim()
    ? entry.label.trim().slice(0, 80)
    : code;

  const legacyGrades = normalizeGrades(entry.includeGrades);
  const legacyTypes = normalizeSiteTypes(entry.siteTypes);
  const bucketLimits = mergeLegacyClientFilters(
    normalizeBucketLimits(entry.bucketLimits),
    legacyGrades,
    legacyTypes,
  );
  const selectionMode = normalizeSelectionMode(entry.selectionMode, bucketLimits ? 'category' : 'simple');
  // maxSearchable was the old name for the same user-facing quantity.
  const hasMaxSites = Object.prototype.hasOwnProperty.call(entry, 'maxSites');
  const maxSites = hasMaxSites
    ? parseThreeStateInteger(entry.maxSites, -1)
    : parseThreeStateInteger(entry.maxSearchable, -1);

  return {
    id,
    label,
    code,
    enabled: entry.enabled !== false,
    sourceMode: normalizeSourceMode(entry.sourceMode),
    selectionMode,
    maxSites,
    bucketLimits,
    // 旧版过滤字段在读取时迁移到 bucketLimits，并留空，避免隐藏配置二次过滤。
    includeGrades: [],
    siteTypes: [],
    selectedKeys: normalizeStringArray(entry.selectedKeys, 2000),
    pinnedKeys: normalizeStringArray(entry.pinnedKeys, 2000),
    ...(typeof entry.attachLives === 'boolean' ? { attachLives: entry.attachLives } : {}),
    createdAt,
    updatedAt,
  };
}

export function normalizeClientDistributionConfig(raw: unknown): ClientDistributionConfig {
  const base = asRecord(raw);
  const seenCodes = new Set<string>();
  const seenIds = new Set<string>();
  const authCodes: ClientAuthCode[] = [];
  const rawCodes = Array.isArray(base.authCodes) ? base.authCodes : [];

  for (const item of rawCodes) {
    const code = normalizeAuthCode(item, seenCodes, seenIds);
    if (code) authCodes.push(code);
  }

  return {
    requireAuth: base.requireAuth === true,
    authCodes,
  };
}

export function createClientAuthCode(raw: Partial<ClientAuthCode> = {}): ClientAuthCode {
  const now = new Date().toISOString();
  const code = typeof raw.code === 'string' && AUTH_CODE_RE.test(raw.code.trim())
    ? raw.code.trim()
    : randomToken(8);
  const rawRecord = raw as Partial<ClientAuthCode> & { maxSearchable?: unknown };
  const hasMaxSites = Object.prototype.hasOwnProperty.call(rawRecord, 'maxSites');
  const maxSites = hasMaxSites
    ? parseThreeStateInteger(rawRecord.maxSites, -1)
    : parseThreeStateInteger(rawRecord.maxSearchable, -1);
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomAuthId(),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : 'Auth code',
    code,
    enabled: raw.enabled !== false,
    sourceMode: normalizeSourceMode(raw.sourceMode),
    selectionMode: normalizeSelectionMode(raw.selectionMode, raw.bucketLimits ? 'category' : 'simple'),
    maxSites,
    bucketLimits: normalizeBucketLimits(raw.bucketLimits),
    includeGrades: [],
    siteTypes: [],
    selectedKeys: normalizeStringArray(raw.selectedKeys, 2000),
    pinnedKeys: normalizeStringArray(raw.pinnedKeys, 2000),
    ...(typeof raw.attachLives === 'boolean' ? { attachLives: raw.attachLives } : {}),
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now,
  };
}

export async function loadClientDistribution(storage: Storage): Promise<ClientDistributionConfig> {
  const current = await storage.get(KV_CLIENT_AUTH_DISTRIBUTION);
  if (current) {
    try {
      return normalizeClientDistributionConfig(JSON.parse(current));
    } catch {
      // 损坏的新配置不阻塞服务，继续尝试迁移旧配置。
    }
  }

  const legacy = await storage.get(KV_CREDENTIAL_DISTRIBUTION);
  if (!legacy) return { ...DEFAULT_CLIENT_DISTRIBUTION, authCodes: [] };
  try {
    return normalizeClientDistributionConfig(JSON.parse(legacy));
  } catch {
    return { ...DEFAULT_CLIENT_DISTRIBUTION, authCodes: [] };
  }
}

export async function saveClientDistribution(
  storage: Storage,
  config: ClientDistributionConfig,
): Promise<ClientDistributionConfig> {
  const normalized = normalizeClientDistributionConfig(config);
  await storage.put(KV_CLIENT_AUTH_DISTRIBUTION, JSON.stringify(normalized));
  return normalized;
}

export function findClientAuthCode(
  config: ClientDistributionConfig,
  code: string | null | undefined,
): ClientAuthCode | undefined {
  if (!code) return undefined;
  const normalized = code.trim();
  if (!AUTH_CODE_RE.test(normalized)) return undefined;
  return config.authCodes.find((item) => item.enabled && item.code === normalized);
}

export function maskAuthCode(code: string): string {
  if (code.length <= 6) return code.slice(0, 1) + '***';
  return code.slice(0, 3) + '***' + code.slice(-2);
}
