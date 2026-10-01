// 网盘凭证加密存储

import type { Storage } from '../storage/interface';
import type { CloudPlatform, CloudCredential, CredentialPolicyConfig, CredentialDistributionConfig, CredentialAuthCode, CredentialDistributionMode } from './types';
import { KV_CLOUD_CREDENTIALS, KV_CREDENTIAL_POLICY, KV_CREDENTIAL_ENCRYPTION_KEY, KV_CREDENTIAL_DISTRIBUTION, KV_CREDENTIAL_DISTRIBUTION_ENABLED } from './config';

// ─── AES-GCM 加密层 ─────────────────────────────────────

async function getOrCreateEncryptionKey(storage: Storage): Promise<CryptoKey> {
  const raw = await storage.get(KV_CREDENTIAL_ENCRYPTION_KEY);

  if (raw) {
    const keyData = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  // 首次使用：生成随机 256-bit key
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as CryptoKey;
  const exported = await crypto.subtle.exportKey('raw', key) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  await storage.put(KV_CREDENTIAL_ENCRYPTION_KEY, b64);

  // 返回不可导出的版本
  return crypto.subtle.importKey('raw', exported, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  // iv (12 bytes) + ciphertext → base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(key: CryptoKey, encrypted: string): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuffer);
}

// ─── 凭证清洗 ──────────────────────────────────────────

/**
 * 只保留非空字符串并去除首尾空白，避免历史 KV、扫码结果或手动输入中的
 * 空白值被当作已配置凭证，进而生成无效 token.json。
 */
export function sanitizeCredentialMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim().length > 0) cleaned[key] = value.trim();
  }
  return cleaned;
}

const ACCOUNT_PASSWORD_PLATFORMS = new Set<CloudPlatform>([
  'pan123',
  'tianyi',
  'thunder',
  'pikpak',
]);

function firstCredentialValue(map: Record<string, string>, fields: string[]): string {
  for (const field of fields) {
    const value = map[field]?.trim();
    if (value) return value;
  }
  return '';
}

/**
 * 把前端手动输入或旧版本 KV 中常见的多种格式统一为客户端 JAR 可识别的字段。
 * - pan123 / tianyi / thunder / pikpak: username + password
 * - 其余平台: 保留 cookie/token 等原字段
 *
 * 支持 user:pass、user=pass、JSON {username,password}、{user,pass}、{account,password}
 * 以及平台常见别名。密码中的冒号不会被截断。
 */
export function normalizeCredentialInput(
  platform: CloudPlatform,
  raw: unknown,
): Record<string, string> {
  const map = sanitizeCredentialMap(raw);
  if (!ACCOUNT_PASSWORD_PLATFORMS.has(platform)) return map;

  let username = firstCredentialValue(map, ['username', 'user', 'account', 'email', 'phone']);
  let password = firstCredentialValue(map, ['password', 'pass', 'pwd']);

  // 兼容旧版本误把整段 user:pass 存进 cookie/token 的情况。
  const packed = firstCredentialValue(map, ['cookie', 'token', 'credential', 'value']);
  if ((!username || !password) && packed) {
    const colon = packed.indexOf(':');
    const equal = packed.indexOf('=');
    let separator = -1;
    if (colon > 0) separator = colon;
    if (equal > 0 && (separator < 0 || equal < separator)) separator = equal;
    if (separator > 0) {
      if (!username) username = packed.slice(0, separator).trim();
      if (!password) password = packed.slice(separator + 1).trim();
    }
  }

  if (!username || !password) return map;

  const normalized: Record<string, string> = { username, password };
  // 保留 JAR/扩展可能同时读取的兼容字段，但不再把用户名密码塞进 cookie。
  const token = firstCredentialValue(map, ['token', 'tuctoken', 'p123token', '123_token']);
  if (token) normalized.token = token;
  return normalized;
}

export function normalizeCloudCredential(credential: CloudCredential): CloudCredential {
  return {
    ...credential,
    credential: normalizeCredentialInput(credential.platform, credential.credential),
  };
}

function credentialValue(credential: CloudCredential | undefined, field: string): string {
  const value = credential?.credential?.[field];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 判断凭证字段是否满足对应客户端 JAR 的最低要求。
 *
 * 这里只检查“字段是否完整”，不检查登录状态或有效期；调用方可继续使用
 * isCredentialDistributable() 做统一下发判定。
 */
export function isCredentialComplete(
  platform: CloudPlatform,
  credential: CloudCredential | undefined,
): boolean {
  if (!credential?.credential) return false;
  switch (platform) {
    case 'quark':
    case 'uc':
    case 'baidu':
    case 'pan115':
    case 'bilibili':
      return !!credentialValue(credential, 'cookie');
    case 'aliyun':
      return !!(credentialValue(credential, 'refresh_token')
        || credentialValue(credential, 'token')
        || credentialValue(credential, 'ali_token')
        || credentialValue(credential, 'open_token'));
    case 'tianyi':
      return !!(credentialValue(credential, 'cookie')
        || (credentialValue(credential, 'username') && credentialValue(credential, 'password')));
    case 'pan123':
    case 'thunder':
      return !!(credentialValue(credential, 'token')
        || (credentialValue(credential, 'username') && credentialValue(credential, 'password')));
    case 'pikpak':
      return !!(credentialValue(credential, 'username') && credentialValue(credential, 'password'));
    default:
      return Object.values(credential.credential).some((value) => typeof value === 'string' && value.trim().length > 0);
  }
}

/**
 * 唯一的下发判定入口。
 *
 * - 字段必须满足平台最低完整性要求。
 * - status=expired 或 expiresAt 已过期时不允许下发。
 * - status=unknown 的历史数据在字段完整且未过期时允许下发，兼容旧 KV。
 */
export function isCredentialDistributable(
  platform: CloudPlatform,
  credential: CloudCredential | undefined,
  now = Date.now(),
): boolean {
  if (!credential || credential.status === 'expired') return false;
  if (!isCredentialComplete(platform, credential)) return false;
  if (!credential.expiresAt) return true;
  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/**
 * Pan.init 接口专用判定。
 *
 * 与 token.json 的下发契约不同：p123/xunlei/tianyi 的 Pan.init 端点固定返回
 * username+password JSON，token/cookie 不能代替；quark/uc/baidu 固定返回 Cookie 文本。
 * 该函数用于避免生成一个客户端可请求但服务端必然返回 404 的初始化地址。
 */
export function isPanInitCredentialDistributable(
  platform: CloudPlatform,
  credential: CloudCredential | undefined,
  now = Date.now(),
): boolean {
  if (!isCredentialDistributable(platform, credential, now)) return false;
  const value = (field: string): string => credentialValue(credential, field);
  switch (platform) {
    case 'pan123':
    case 'thunder':
    case 'tianyi':
      return !!value('username') && !!value('password');
    case 'quark':
      return /(?:^|;\s*)__pus=/i.test(value('cookie'));
    case 'uc':
    case 'baidu':
      return !!value('cookie');
    default:
      return false;
  }
}

/**
 * Build a short, stable, non-secret revision for a credential.
 *
 * Client JARs cache Pan.init responses by URL. If a cookie is refreshed but
 * `obtainedAt` does not change (or two writes land in the same second), the
 * old `?v=` value can keep the client on a stale credential. Hashing the
 * credential content guarantees that any content change yields a new URL
 * without exposing the cookie itself.
 */
export function credentialRevision(credential: CloudCredential | undefined): string {
  if (!credential) return '';
  const payload = JSON.stringify({
    platform: credential.platform,
    credential: credential.credential,
    status: credential.status || '',
    expiresAt: credential.expiresAt || '',
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < payload.length; i++) {
    const code = payload.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + ((h2 << 6) >>> 0) + (h2 >>> 2);
    h2 >>>= 0;
  }
  return h1.toString(36) + h2.toString(36);
}

function sanitizeCloudCredential(credential: CloudCredential): CloudCredential | null {
  const normalized = normalizeCloudCredential(credential);
  if (Object.keys(normalized.credential).length === 0) return null;
  return normalized;
}
function parseCookiePairs(cookie: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (name && value) pairs.set(name, value);
  }
  return pairs;
}

function cookiePairsToString(pairs: Map<string, string>): string {
  return [...pairs.entries()].map(([name, value]) => name + '=' + value).join('; ');
}

function setCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as any).getSetCookie;
  if (typeof getSetCookie === 'function') {
    const values = getSetCookie.call(headers);
    if (Array.isArray(values) && values.length > 0) return values;
  }
  const raw = headers.get('set-cookie') || '';
  return raw ? raw.split(/,(?=\s*[^;,]+=)/g).map((value) => value.trim()).filter(Boolean) : [];
}

/** Normalize a Quark cookie without changing the cookie set. */
export function normalizeQuarkCookie(cookie: string): string {
  return cookiePairsToString(parseCookiePairs(cookie));
}

/** Merge the two session cookies Quark may return on API requests. */
export function mergeQuarkCookie(cookie: string, setCookies: string[]): string {
  const pairs = parseCookiePairs(cookie);
  for (const setCookie of setCookies) {
    const first = setCookie.split(';', 1)[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!/^__(?:pus|puus)$/i.test(name) || !value) continue;
    const existing = [...pairs.keys()].find((key) => key.toLowerCase() === name.toLowerCase());
    pairs.set(existing || name, value);
  }
  return cookiePairsToString(pairs);
}

/**
 * Complete a Quark login cookie.
 *
 * The QR flow normally returns __pus first. Quark adds __puus on the first
 * drive-pc request; some bundled JARs expect it during Pan.init, so fetch and
 * persist it before a credential URL is handed to a client.
 */
export async function prepareQuarkCookie(cookie: string, timeoutMs = 2400): Promise<string> {
  const normalized = normalizeQuarkCookie(cookie);
  // Client JARs require __pus specifically; __puus alone is not a valid login cookie.
  // Refresh whenever either session cookie is missing so downstream Pan.init sees both.
  const hasPus = /(?:^|;\s*)__pus=/i.test(normalized);
  const hasPuus = /(?:^|;\s*)__puus=/i.test(normalized);
  if (hasPus && hasPuus) return normalized;
  if (!normalized) return normalized;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.2.0 Chrome/100.0.4896.160',
        'Referer': 'https://pan.quark.cn/',
        'Accept': 'application/json, text/plain, */*',
        'Cookie': normalized,
      },
      signal: controller.signal,
    });
    if (!response.ok) return normalized;
    return mergeQuarkCookie(normalized, setCookieValues(response.headers));
  } catch {
    // Credential distribution must still work if the refresh is temporarily unavailable.
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}


// ─── 凭证 CRUD ──────────────────────────────────────────

/**
 * Credential responses are fetched once per Pan.init-capable source. The same
 * deployment can receive several identical requests while a client starts up.
 * Keep a short in-process cache of the decrypted map and coalesce concurrent
 * reads so KV + AES-GCM work is not repeated for every source.
 *
 * Save/delete operations invalidate the cache immediately, and the short TTL
 * bounds staleness in the unlikely case another process writes the same KV.
 */
const CREDENTIAL_CACHE_TTL_MS = 30_000;
type CredentialMap = Map<CloudPlatform, CloudCredential>;
const credentialCache = new WeakMap<Storage, { value: CredentialMap; expiresAt: number }>();
const credentialLoads = new WeakMap<Storage, Promise<CredentialMap>>();

function invalidateCredentialCache(storage: Storage): void {
  credentialCache.delete(storage);
  credentialLoads.delete(storage);
}

async function loadCredentialsUncached(storage: Storage): Promise<CredentialMap> {
  const map: CredentialMap = new Map();
  const raw = await storage.get(KV_CLOUD_CREDENTIALS);
  if (!raw) return map;

  try {
    const key = await getOrCreateEncryptionKey(storage);
    const json = await decrypt(key, raw);
    const arr: CloudCredential[] = JSON.parse(json);
    for (const cred of arr) {
      const sanitized = sanitizeCloudCredential(cred);
      if (sanitized) map.set(sanitized.platform, sanitized);
    }
  } catch (err) {
    console.error('[credential-store] Failed to decrypt credentials:', err instanceof Error ? err.message : err);
  }

  return map;
}

export async function loadCredentials(storage: Storage): Promise<CredentialMap> {
  const now = Date.now();
  const cached = credentialCache.get(storage);
  if (cached && cached.expiresAt > now) return cached.value;

  const inFlight = credentialLoads.get(storage);
  if (inFlight) return inFlight;

  const promise = loadCredentialsUncached(storage)
    .then((value) => {
      credentialCache.set(storage, { value, expiresAt: Date.now() + CREDENTIAL_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      if (credentialLoads.get(storage) === promise) credentialLoads.delete(storage);
    });

  credentialLoads.set(storage, promise);
  return promise;
}

export async function saveCredential(storage: Storage, credential: CloudCredential): Promise<void> {
  let nextCredential = credential;
  if (credential.platform === 'quark') {
    const cookie = credential.credential.cookie?.trim();
    if (cookie) {
      const prepared = await prepareQuarkCookie(cookie);
      if (prepared !== cookie) {
        nextCredential = {
          ...credential,
          credential: { ...credential.credential, cookie: prepared },
          obtainedAt: new Date().toISOString(),
        };
      }
    }
  }

  const sanitized = sanitizeCloudCredential(nextCredential);
  if (!sanitized) throw new Error('credential must contain at least one non-empty string');
  const existing = await loadCredentials(storage);
  invalidateCredentialCache(storage);
  const nextCredentials = new Map(existing);
  nextCredentials.set(sanitized.platform, sanitized);

  const key = await getOrCreateEncryptionKey(storage);
  const json = JSON.stringify([...nextCredentials.values()]);
  const encrypted = await encrypt(key, json);
  await storage.put(KV_CLOUD_CREDENTIALS, encrypted);
}

export async function deleteCredential(storage: Storage, platform: CloudPlatform): Promise<void> {
  const existing = await loadCredentials(storage);
  invalidateCredentialCache(storage);
  if (!existing.has(platform)) return;

  const nextCredentials = new Map(existing);
  nextCredentials.delete(platform);
  const key = await getOrCreateEncryptionKey(storage);

  if (nextCredentials.size === 0) {
    await storage.put(KV_CLOUD_CREDENTIALS, '');
    return;
  }

  const json = JSON.stringify([...nextCredentials.values()]);
  const encrypted = await encrypt(key, json);
  await storage.put(KV_CLOUD_CREDENTIALS, encrypted);
}

// ─── 凭证策略 CRUD ──────────────────────────────────────

const DEFAULT_POLICY: CredentialPolicyConfig = {
  allowedHighRiskKeys: [],
  deniedKeys: [],
};

export async function loadCredentialPolicy(storage: Storage): Promise<CredentialPolicyConfig> {
  const raw = await storage.get(KV_CREDENTIAL_POLICY);
  if (!raw) return { ...DEFAULT_POLICY };
  try {
    return JSON.parse(raw);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export async function saveCredentialPolicy(storage: Storage, policy: CredentialPolicyConfig): Promise<void> {
  await storage.put(KV_CREDENTIAL_POLICY, JSON.stringify(policy));
}
// ─── 凭证分发 / 鉴权配置 ────────────────────────────────

export const CLOUD_PLATFORMS: CloudPlatform[] = [
  'aliyun', 'bilibili', 'quark', 'uc', 'pan115',
  'tianyi', 'baidu', 'pan123', 'thunder', 'pikpak',
];

const CREDENTIAL_DISTRIBUTION_MODES = new Set<CredentialDistributionMode>(['none', 'all', 'selected']);
const AUTH_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const DEFAULT_CREDENTIAL_DISTRIBUTION: CredentialDistributionConfig = {
  requireAuth: false,
  defaultCredentialMode: 'all',
  defaultPlatforms: [...CLOUD_PLATFORMS],
  authCodes: [],
};

function isCloudPlatform(value: unknown): value is CloudPlatform {
  return typeof value === 'string' && (CLOUD_PLATFORMS as string[]).includes(value);
}

function normalizePlatforms(value: unknown): CloudPlatform[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<CloudPlatform>();
  for (const item of value) {
    if (isCloudPlatform(item)) unique.add(item);
  }
  return [...unique];
}

function normalizeDistributionMode(value: unknown, fallback: CredentialDistributionMode): CredentialDistributionMode {
  return typeof value === 'string' && CREDENTIAL_DISTRIBUTION_MODES.has(value as CredentialDistributionMode)
    ? value as CredentialDistributionMode
    : fallback;
}

function randomAuthCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((value) => value.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

function randomAuthId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'auth_' + randomAuthCode();
}

export function normalizeCredentialDistributionConfig(raw: unknown): CredentialDistributionConfig {
  const base = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};
  const rawCodes = Array.isArray(base.authCodes) ? base.authCodes : [];
  const seenCodes = new Set<string>();
  const seenIds = new Set<string>();
  const authCodes: CredentialAuthCode[] = [];

  for (const item of rawCodes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const code = typeof entry.code === 'string' ? entry.code.trim() : '';
    if (!AUTH_CODE_RE.test(code) || seenCodes.has(code)) continue;
    seenCodes.add(code);

    let id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : randomAuthId();
    if (seenIds.has(id)) id = randomAuthId();
    seenIds.add(id);

    const mode = normalizeDistributionMode(entry.credentialMode, 'none');
    const now = new Date().toISOString();
    const createdAt = typeof entry.createdAt === 'string' && entry.createdAt ? entry.createdAt : now;
    const updatedAt = typeof entry.updatedAt === 'string' && entry.updatedAt ? entry.updatedAt : createdAt;
    const platforms = normalizePlatforms(entry.platforms);
    authCodes.push({
      id,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 80) : code,
      code,
      enabled: entry.enabled !== false,
      credentialMode: mode,
      platforms,
      createdAt,
      updatedAt,
    });
  }

  const defaultMode = normalizeDistributionMode(base.defaultCredentialMode, 'all');
  const defaultPlatforms = normalizePlatforms(base.defaultPlatforms);
  return {
    requireAuth: base.requireAuth === true,
    defaultCredentialMode: defaultMode,
    defaultPlatforms,
    authCodes,
  };
}

export function createCredentialAuthCode(
  raw: Partial<CredentialAuthCode> = {},
): CredentialAuthCode {
  const now = new Date().toISOString();
  const mode = normalizeDistributionMode(raw.credentialMode, 'none');
  const platforms = normalizePlatforms(raw.platforms);
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomAuthId(),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : 'Auth code',
    code: typeof raw.code === 'string' && AUTH_CODE_RE.test(raw.code.trim()) ? raw.code.trim() : randomAuthCode(),
    enabled: raw.enabled !== false,
    credentialMode: mode,
    platforms,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now,
  };
}

export async function loadCredentialDistribution(storage: Storage): Promise<CredentialDistributionConfig> {
  const raw = await storage.get(KV_CREDENTIAL_DISTRIBUTION);
  if (raw) {
    try {
      return normalizeCredentialDistributionConfig(JSON.parse(raw));
    } catch {
      // fall through to legacy migration
    }
  }
  const legacyEnabled = await storage.get(KV_CREDENTIAL_DISTRIBUTION_ENABLED);
  return normalizeCredentialDistributionConfig({
    requireAuth: false,
    defaultCredentialMode: legacyEnabled === 'false' ? 'none' : 'all',
    defaultPlatforms: [...CLOUD_PLATFORMS],
    authCodes: [],
  });
}

export async function saveCredentialDistribution(
  storage: Storage,
  config: CredentialDistributionConfig,
): Promise<CredentialDistributionConfig> {
  const normalized = normalizeCredentialDistributionConfig(config);
  await storage.put(KV_CREDENTIAL_DISTRIBUTION, JSON.stringify(normalized));
  await storage.put(KV_CREDENTIAL_DISTRIBUTION_ENABLED, normalized.defaultCredentialMode === 'none' ? 'false' : 'true');
  return normalized;
}

export function findCredentialAuthCode(
  config: CredentialDistributionConfig,
  code: string | null | undefined,
): CredentialAuthCode | undefined {
  if (!code) return undefined;
  const normalized = code.trim();
  if (!AUTH_CODE_RE.test(normalized)) return undefined;
  return config.authCodes.find((item) => item.enabled && item.code === normalized);
}

export function maskCredentialCode(code: string): string {
  if (code.length <= 6) return code.slice(0, 1) + '***';
  return code.slice(0, 3) + '***' + code.slice(-2);
}
