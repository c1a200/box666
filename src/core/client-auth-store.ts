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

function normalizeSourceMode(value: unknown): SourceDistributionMode {
  return typeof value === 'string' && SOURCE_MODES.has(value as SourceDistributionMode)
    ? value as SourceDistributionMode
    : 'all';
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

  return {
    id,
    label,
    code,
    enabled: entry.enabled !== false,
    sourceMode: normalizeSourceMode(entry.sourceMode),
    maxSites: parseThreeStateInteger(entry.maxSites, -1),
    maxSearchable: parseThreeStateInteger(entry.maxSearchable, -1),
    bucketLimits: normalizeBucketLimits(entry.bucketLimits),
    includeGrades: normalizeGrades(entry.includeGrades),
    siteTypes: normalizeSiteTypes(entry.siteTypes),
    selectedKeys: normalizeStringArray(entry.selectedKeys, 2000),
    pinnedKeys: normalizeStringArray(entry.pinnedKeys, 2000),
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
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomAuthId(),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : 'Auth code',
    code,
    enabled: raw.enabled !== false,
    sourceMode: normalizeSourceMode(raw.sourceMode),
    maxSites: parseThreeStateInteger(raw.maxSites, -1),
    maxSearchable: parseThreeStateInteger(raw.maxSearchable, -1),
    bucketLimits: normalizeBucketLimits(raw.bucketLimits),
    includeGrades: normalizeGrades(raw.includeGrades),
    siteTypes: normalizeSiteTypes(raw.siteTypes),
    selectedKeys: normalizeStringArray(raw.selectedKeys, 2000),
    pinnedKeys: normalizeStringArray(raw.pinnedKeys, 2000),
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
