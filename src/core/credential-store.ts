// 网盘凭证加密存储

import type { Storage } from '../storage/interface';
import type { CloudPlatform, CloudCredential, CredentialPolicyConfig } from './types';
import { KV_CLOUD_CREDENTIALS, KV_CREDENTIAL_POLICY, KV_CREDENTIAL_ENCRYPTION_KEY } from './config';

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

export async function loadCredentials(storage: Storage): Promise<Map<CloudPlatform, CloudCredential>> {
  const map = new Map<CloudPlatform, CloudCredential>();
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
  existing.set(sanitized.platform, sanitized);

  const key = await getOrCreateEncryptionKey(storage);
  const json = JSON.stringify([...existing.values()]);
  const encrypted = await encrypt(key, json);
  await storage.put(KV_CLOUD_CREDENTIALS, encrypted);
}

export async function deleteCredential(storage: Storage, platform: CloudPlatform): Promise<void> {
  const existing = await loadCredentials(storage);
  if (!existing.has(platform)) return;

  existing.delete(platform);
  const key = await getOrCreateEncryptionKey(storage);

  if (existing.size === 0) {
    await storage.put(KV_CLOUD_CREDENTIALS, '');
    return;
  }

  const json = JSON.stringify([...existing.values()]);
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
