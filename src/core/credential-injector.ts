// Cookie 注入引擎

import type { TVBoxSite, CloudPlatform, CloudCredential, CredentialPolicyConfig, SiteContract } from './types';
import { buildSiteContract, extractJarMd5 } from './site-contract';
import { ALIST_PLATFORMS } from './credential-risk';
import { resolveCredentialProtocol, getPanSearchPlatform } from './credential-protocol';
import type { CredentialProtocol } from './credential-protocol';
import { isCredentialDistributable, isPanInitCredentialDistributable, credentialRevision } from './credential-store';

// ─── 注入规则 ────────────────────────────────────────────

/**
 * 解析 ext：只有对象或 JSON 对象字符串允许注入。
 * 普通 URL 等非 JSON 字符串必须原样保留，不能转换成对象。
 */
function parseExt(ext: any): { obj: Record<string, any>; injectable: boolean; wasString: boolean; wasJson: boolean } {
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    return { obj: ext as Record<string, any>, injectable: true, wasString: false, wasJson: false };
  }

  if (typeof ext === 'string') {
    try {
      const parsed = JSON.parse(ext);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { obj: parsed, injectable: true, wasString: true, wasJson: true };
      }
    } catch {
      // 非 JSON 字符串按原样处理
    }
    return { obj: {}, injectable: false, wasString: true, wasJson: false };
  }

  return { obj: {}, injectable: false, wasString: false, wasJson: false };
}

/** 恢复 ext 原始格式；调用方必须先确认 injectable。 */
function restoreExt(obj: Record<string, any>, wasString: boolean, wasJson: boolean): any {
  return wasString && wasJson ? JSON.stringify(obj) : obj;
}

function getCredValue(creds: Map<CloudPlatform, CloudCredential>, platform: CloudPlatform, field: string): string {
  const value = creds.get(platform)?.credential[field];
  return typeof value === 'string' ? value.trim() : '';
}

const TOKEN_JSON_URL_RE = /(?:(?:https?|clan|sub):\/\/[^$\s"']*)?[^$\s"']*token[_.]?json[^$\s"']*/gi;

const PLATFORM_FIELD_MAP: Array<{ field: string; platform: CloudPlatform; credField: string }> = [
  { field: 'cookie', platform: 'quark', credField: 'cookie' },
  { field: 'quark_cookie', platform: 'quark', credField: 'cookie' },
  { field: 'quarkCookie', platform: 'quark', credField: 'cookie' },
  { field: 'uccookie', platform: 'uc', credField: 'cookie' },
  { field: 'uc_cookie', platform: 'uc', credField: 'cookie' },
  { field: 'ucCookie', platform: 'uc', credField: 'cookie' },
  { field: 'tyitoken', platform: 'tianyi', credField: 'cookie' },
  { field: 'tianyi_cookie', platform: 'tianyi', credField: 'cookie' },
  { field: 'tianyiCookie', platform: 'tianyi', credField: 'cookie' },
  { field: 'dutoken', platform: 'baidu', credField: 'cookie' },
  { field: 'baidu_cookie', platform: 'baidu', credField: 'cookie' },
  { field: 'baiduCookie', platform: 'baidu', credField: 'cookie' },
  { field: 'p123token', platform: 'pan123', credField: 'token' },
  { field: '123_token', platform: 'pan123', credField: 'token' },
  { field: '123token', platform: 'pan123', credField: 'token' },
  { field: 'tuctoken', platform: 'thunder', credField: 'token' },
  { field: 'bili_cookie', platform: 'bilibili', credField: 'cookie' },
  { field: 'bilibili_cookie', platform: 'bilibili', credField: 'cookie' },
  { field: 'token', platform: 'aliyun', credField: 'refresh_token' },
  { field: 'refresh_token', platform: 'aliyun', credField: 'refresh_token' },
  { field: 'open_token', platform: 'aliyun', credField: 'open_token' },
  { field: 'ali_token', platform: 'aliyun', credField: 'refresh_token' },
  { field: '115_cookie', platform: 'pan115', credField: 'cookie' },
  { field: '115Cookie', platform: 'pan115', credField: 'cookie' },
];

const ALIST_DEFAULT_FIELDS = [
  'cookie',
  'quark_cookie',
  'quarkCookie',
  'uc_cookie',
  'ucCookie',
  'uccookie',
  '115_cookie',
  '115Cookie',
  'refresh_token',
  'token',
  'ali_token',
  'open_token',
  'tianyi_cookie',
  'tianyiCookie',
  'tyitoken',
  'baidu_cookie',
  'baiduCookie',
  'dutoken',
  '123_token',
  '123token',
  'p123token',
  'tuctoken',
  'pikpak_username',
  'pikpak_password',
  'xunlei_username',
  'xunlei_password',
];

const ALIST_DRIVE_FIELD_MAP: Array<{ field: string; platform: CloudPlatform; credField: string }> = [
  { field: 'cookie', platform: 'quark', credField: 'cookie' },
  { field: 'quark_cookie', platform: 'quark', credField: 'cookie' },
  { field: 'quarkCookie', platform: 'quark', credField: 'cookie' },
  { field: 'uc_cookie', platform: 'uc', credField: 'cookie' },
  { field: 'ucCookie', platform: 'uc', credField: 'cookie' },
  { field: 'uccookie', platform: 'uc', credField: 'cookie' },
  { field: '115_cookie', platform: 'pan115', credField: 'cookie' },
  { field: '115Cookie', platform: 'pan115', credField: 'cookie' },
  { field: 'refresh_token', platform: 'aliyun', credField: 'refresh_token' },
  { field: 'token', platform: 'aliyun', credField: 'refresh_token' },
  { field: 'ali_token', platform: 'aliyun', credField: 'refresh_token' },
  { field: 'open_token', platform: 'aliyun', credField: 'open_token' },
  { field: 'tianyi_cookie', platform: 'tianyi', credField: 'cookie' },
  { field: 'tianyiCookie', platform: 'tianyi', credField: 'cookie' },
  { field: 'tyitoken', platform: 'tianyi', credField: 'cookie' },
  { field: 'tianyi_username', platform: 'tianyi', credField: 'username' },
  { field: 'tianyi_password', platform: 'tianyi', credField: 'password' },
  { field: 'username', platform: 'tianyi', credField: 'username' },
  { field: 'password', platform: 'tianyi', credField: 'password' },
  { field: 'baidu_cookie', platform: 'baidu', credField: 'cookie' },
  { field: 'baiduCookie', platform: 'baidu', credField: 'cookie' },
  { field: 'dutoken', platform: 'baidu', credField: 'cookie' },
  { field: '123_token', platform: 'pan123', credField: 'token' },
  { field: '123token', platform: 'pan123', credField: 'token' },
  { field: 'p123token', platform: 'pan123', credField: 'token' },
  { field: 'p123_username', platform: 'pan123', credField: 'username' },
  { field: 'p123_password', platform: 'pan123', credField: 'password' },
  { field: 'tuctoken', platform: 'thunder', credField: 'token' },
  { field: 'thunder_username', platform: 'thunder', credField: 'username' },
  { field: 'thunder_password', platform: 'thunder', credField: 'password' },
  { field: 'xunlei_username', platform: 'thunder', credField: 'username' },
  { field: 'xunlei_password', platform: 'thunder', credField: 'password' },
  { field: 'pikpak_username', platform: 'pikpak', credField: 'username' },
  { field: 'pikpak_password', platform: 'pikpak', credField: 'password' },
];

type PlatformFieldRule = { field: string; platform: CloudPlatform; credField: string };

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function alistProxyUrl(baseUrl: string, sourceUrl: string): string {
  return `${baseUrl}/credential/alist?src=${encodeURIComponent(sourceUrl)}`;
}

function isAListProxyUrl(value: unknown, baseUrl?: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    if (!parsed.pathname.replace(/\/+$/, '').endsWith('/credential/alist')) return false;
    if (!baseUrl) return true;
    const base = new URL(baseUrl);
    return parsed.origin === base.origin;
  } catch {
    return false;
  }
}

function injectAListProxyUrl(ext: any, baseUrl?: string): { ext: any; changed: boolean } {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return { ext, changed: false };

  if (typeof ext === 'string') {
    if (isHttpUrl(ext)) {
      if (isAListProxyUrl(ext, normalizedBaseUrl)) return { ext, changed: false };
      const next = alistProxyUrl(normalizedBaseUrl, ext.trim());
      return next === ext ? { ext, changed: false } : { ext: next, changed: true };
    }
    return { ext, changed: false };
  }

  const parsed = parseExt(ext);
  if (!parsed.injectable) return { ext, changed: false };
  const current = parsed.obj.json;
  if (!isHttpUrl(current)) return { ext, changed: false };
  if (isAListProxyUrl(current, normalizedBaseUrl)) return { ext, changed: false };
  const nextUrl = alistProxyUrl(normalizedBaseUrl, current.trim());
  if (current === nextUrl) return { ext, changed: false };
  return { ext: restoreExt({ ...parsed.obj, json: nextUrl }, parsed.wasString, parsed.wasJson), changed: true };
}



/**
 * 将凭证按“字段 -> 平台 -> 凭证字段”的精确映射写入 ext。
 * 只更新 ext 中已经存在的字段，绝不凭平台名猜测新增未知字段。
 */
function injectPlatformFields(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  platforms: CloudPlatform[],
  fields?: string[],
): { ext: any; changed: boolean } {
  const parsed = parseExt(ext);
  if (!parsed.injectable) return { ext, changed: false };

  const allowed = fields ? new Set(fields) : null;
  const platformSet = new Set(platforms);
  let changed = false;
  const next = { ...parsed.obj };

  for (const rule of PLATFORM_FIELD_MAP) {
    if (!platformSet.has(rule.platform)) continue;
    if (allowed && !allowed.has(rule.field)) continue;
    if (!(rule.field in next)) continue;
    const value = getCredValue(creds, rule.platform, rule.credField);
    if (!value || next[rule.field] === value) continue;
    next[rule.field] = value;
    changed = true;
  }

  return changed
    ? { ext: restoreExt(next, parsed.wasString, parsed.wasJson), changed: true }
    : { ext, changed: false };
}
function injectAccountPasswordExt(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  platform: 'pan123' | 'thunder',
): { ext: any; changed: boolean } {
  const username = getCredValue(creds, platform, 'username');
  const password = getCredValue(creds, platform, 'password');
  if (!username || !password) return { ext, changed: false };
  const parsed = parseExt(ext);
  if (!parsed.injectable) return { ext, changed: false };
  const next = { ...parsed.obj };
  let changed = false;
  if (next.username !== username) {
    next.username = username;
    changed = true;
  }
  if (next.password !== password) {
    next.password = password;
    changed = true;
  }
  return changed
    ? { ext: restoreExt(next, parsed.wasString, parsed.wasJson), changed: true }
    : { ext, changed: false };
}

/**
 * AList 的凭证位于 drive 对象内，而不是顶层。按 name/server 匹配后合并，
 * 保留 search、hidden、login、params 等原始字段。
 */
const ALIST_PLATFORM_IDENTIFIERS: Partial<Record<CloudPlatform, string[]>> = {
  aliyun: ['aliyun', 'alipan', 'aliyundrive', '阿里云盘', '阿里'],
  bilibili: ['bilibili', 'b站'],
  quark: ['quark', '夸克'],
  uc: ['uc', 'uc网盘'],
  pan115: ['115'],
  tianyi: ['tianyi', '189', '天翼'],
  baidu: ['baidu', '百度'],
  pan123: ['123pan', '123云盘', '123网盘'],
  thunder: ['thunder', 'xunlei', '迅雷'],
  pikpak: ['pikpak'],
};

function alistDrivePlatform(drive: Record<string, any>): CloudPlatform | null {
  const identity = `${typeof drive.name === 'string' ? drive.name : ''} ${typeof drive.server === 'string' ? drive.server : ''} ${typeof drive.driver === 'string' ? drive.driver : ''}`.toLowerCase();
  for (const [platform, words] of Object.entries(ALIST_PLATFORM_IDENTIFIERS) as Array<[CloudPlatform, string[]]>) {
    if (words.some((word) => identity.includes(word))) return platform;
  }
  return null;
}

export function injectAListDriveCredentials(
  drives: unknown[],
  creds: Map<CloudPlatform, CloudCredential>,
): { drives: unknown[]; changed: boolean; matched: number } {
  let changed = false;
  let matched = 0;
  const nextDrives = drives.map((drive) => {
    if (!drive || typeof drive !== 'object' || Array.isArray(drive)) return drive;
    const current = { ...(drive as Record<string, any>) };
    const platform = alistDrivePlatform(current);
    if (!platform || !isCredentialDistributable(platform, creds.get(platform))) return drive;
    let driveChanged = false;

    for (const rule of ALIST_DRIVE_FIELD_MAP) {
      if (rule.platform !== platform) continue;
      const value = getCredValue(creds, rule.platform, rule.credField);
      if (!value || current[rule.field] === value) continue;
      current[rule.field] = value;
      driveChanged = true;
    }

    if (!driveChanged) return drive;
    changed = true;
    matched++;
    return current;
  });

  return { drives: nextDrives, changed, matched };
}

function hasCredentialForPlatforms(
  creds: Map<CloudPlatform, CloudCredential>,
  platforms: CloudPlatform[],
): boolean {
  return platforms.some((platform) => isCredentialDistributable(platform, creds.get(platform)));
}

function hasCompleteCredentialForPlatforms(
  creds: Map<CloudPlatform, CloudCredential>,
  platforms: CloudPlatform[],
): boolean {
  return platforms.some((platform) => isCredentialDistributable(platform, creds.get(platform)));
}

function isCompleteCredential(platform: CloudPlatform, cred: CloudCredential | undefined): boolean {
  return isCredentialDistributable(platform, cred);
}

function hasInjectablePlatformField(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  platforms: CloudPlatform[],
  fields?: string[],
): boolean {
  const parsed = parseExt(ext);
  if (!parsed.injectable) return false;
  const allowed = fields ? new Set(fields) : null;
  const platformSet = new Set(platforms);
  return PLATFORM_FIELD_MAP.some((rule) => {
    if (!platformSet.has(rule.platform)) return false;
    if (allowed && !allowed.has(rule.field)) return false;
    if (!(rule.field in parsed.obj)) return false;
    return isCompleteCredential(rule.platform, creds.get(rule.platform));
  });
}

function isCredentialFieldUrl(value: unknown, field: string, baseUrl?: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    if (!parsed.pathname.replace(/\/+$/, '').endsWith(`/credential/${field}`)) return false;
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (!normalizedBaseUrl) return false;
    return parsed.origin === new URL(normalizedBaseUrl).origin;
  } catch {
    return false;
  }
}

function tokenJsonUrl(baseUrl: string, revision = ''): string {
  return baseUrl.replace(/\/$/, '') + '/token.json' + (revision ? '?v=' + revision : '');
}

function tvfanConfigUrl(baseUrl: string, revision = ''): string {
  // 2cc Guard reads the shared tvfan token from the `token` query parameter.
  // Keep the revision as a cache-buster only; auth mode is still decided by
  // the /auth/<code>/... path and handleTvfanConfig intentionally ignores query.
  return baseUrl.replace(/\/$/, '') + '/tvfan/config'
    + (revision ? '?token=' + encodeURIComponent(revision) : '');
}


function normalizeBaseUrl(baseUrl?: string): string {
  return typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/$/, '') : '';
}

function replaceTokenJsonUrl(ext: any, baseUrl?: string): { ext: any; changed: boolean } {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!ext || !normalizedBaseUrl) {
    return { ext, changed: false };
  }

  if (typeof ext === 'string') {
    try {
      const parsed = JSON.parse(ext);
      if (typeof parsed === 'object' && parsed !== null) {
        const res = replaceTokenJsonUrl(parsed, normalizedBaseUrl);
        return { ext: res.changed ? JSON.stringify(res.ext) : ext, changed: res.changed };
      }
    } catch {
      // Ignore non-JSON strings and treat them as plain text below.
    }

    if (TOKEN_JSON_URL_RE.test(ext)) {
      TOKEN_JSON_URL_RE.lastIndex = 0;
      const match = ext.match(TOKEN_JSON_URL_RE);
      if (match && match[0]) {
        const matchedUrl = match[0];
        const targetUrl = tokenJsonUrl(normalizedBaseUrl);
        if (matchedUrl === targetUrl) {
          TOKEN_JSON_URL_RE.lastIndex = 0;
          return { ext, changed: false };
        }
        const next = ext.replace(TOKEN_JSON_URL_RE, targetUrl);
        TOKEN_JSON_URL_RE.lastIndex = 0;
        return { ext: next, changed: next !== ext };
      }
    }
    TOKEN_JSON_URL_RE.lastIndex = 0;
    return { ext, changed: false };
  }

  if (typeof ext === 'object') {
    let changed = false;
    const copy = Array.isArray(ext) ? [...ext] : { ...ext };
    for (const key of Object.keys(copy)) {
      const val = copy[key];
      if (typeof val === 'string' || (typeof val === 'object' && val !== null)) {
        const res = replaceTokenJsonUrl(val, normalizedBaseUrl);
        if (res.changed) {
          copy[key] = res.ext;
          changed = true;
        }
      }
    }
    return { ext: copy, changed };
  }

  return { ext, changed: false };
}

type PanInitPlatform = 'pan123' | 'thunder' | 'quark' | 'uc' | 'tianyi' | 'baidu';

const PAN_INIT_FIELDS: Array<{ field: string; platform: PanInitPlatform }> = [
  { field: 'p123', platform: 'pan123' },
  { field: 'xunlei', platform: 'thunder' },
  { field: 'quark', platform: 'quark' },
  { field: 'uc', platform: 'uc' },
  { field: 'tianyi', platform: 'tianyi' },
  { field: 'baidu', platform: 'baidu' },
];

function isPanInitPlatform(value: CloudPlatform): value is PanInitPlatform {
  return value === 'pan123'
    || value === 'thunder'
    || value === 'quark'
    || value === 'uc'
    || value === 'tianyi'
    || value === 'baidu';
}

export function hasPanInitCredential(creds: Map<CloudPlatform, CloudCredential>, platform: PanInitPlatform): boolean {
  return isPanInitCredentialDistributable(platform, creds.get(platform));
}

/**
 * csp_PanSearch 的 ext.pan 指定实际检索的网盘。只注入该平台，
 * 避免把夸克 Cookie 错误下发给 UC/百度等盘搜索源。
 */
function injectPanSearchCredential(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  baseUrl?: string,
): any {
  const parsed = parseExt(ext);
  if (!parsed.injectable) return ext;
  const pan = typeof parsed.obj.pan === 'string' ? parsed.obj.pan.trim().toLowerCase() : '';
  const platformMap: Record<string, PanInitPlatform> = {
    quark: 'quark',
    '夸克': 'quark',
    uc: 'uc',
    tianyi: 'tianyi',
    '天翼': 'tianyi',
    baidu: 'baidu',
    '百度': 'baidu',
    p123: 'pan123',
    pan123: 'pan123',
    '123': 'pan123',
    xunlei: 'thunder',
    thunder: 'thunder',
    '迅雷': 'thunder',
  };
  const platform = platformMap[pan];
  if (!platform) return ext;
  return injectPanInitUrls(ext, creds, baseUrl, [platform]).ext;
}

function canInjectPanSearchCredential(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
): boolean {
  const parsed = parseExt(ext);
  if (!parsed.injectable) return false;
  const pan = typeof parsed.obj.pan === 'string' ? parsed.obj.pan.trim().toLowerCase() : '';
  const platformMap: Record<string, PanInitPlatform> = {
    quark: 'quark',
    '夸克': 'quark',
    uc: 'uc',
    tianyi: 'tianyi',
    '天翼': 'tianyi',
    baidu: 'baidu',
    '百度': 'baidu',
    p123: 'pan123',
    pan123: 'pan123',
    '123': 'pan123',
    xunlei: 'thunder',
    thunder: 'thunder',
    '迅雷': 'thunder',
  };
  const platform = platformMap[pan];
  return !!platform && hasPanInitCredential(creds, platform);
}

/**
 * 2cc/f782 Guard 的 Cloud-drive 入口。端点必须跟 JAR 版本严格对应：
 * - token-json-url: 写 root `/token.json`，返回完整 token schema（下划线别名）。
 * - tvfan-config-url: 写 `/tvfan/config`，返回上游五字段及其兼容别名。
 * 只替换 Cloud-drive 一个字段，保留 siteUrl、from 等同一 ext 的字段。
 */
function injectCloudDriveTokenUrl(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  baseUrl?: string,
  platforms: CloudPlatform[] = [],
  mechanism: 'token-json-url' | 'tvfan-config-url' = 'tvfan-config-url',
): { ext: any; changed: boolean } {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return { ext, changed: false };

  const parsed = parseExt(ext);
  if (!parsed.injectable) return { ext, changed: false };
  const current = parsed.obj['Cloud-drive'];
  if (typeof current !== 'string' || !current.trim()) return { ext, changed: false };
  if (!platforms.some((platform) => isCredentialDistributable(platform, creds.get(platform)))) {
    return { ext, changed: false };
  }

  const revision = platforms.map((platform) => credentialRevision(creds.get(platform))).filter(Boolean).sort().join('.');
  const url = mechanism === 'token-json-url'
    ? tokenJsonUrl(normalizedBaseUrl, revision)
    : tvfanConfigUrl(normalizedBaseUrl, revision);
  if (current === url) return { ext, changed: false };
  const next = { ...parsed.obj, 'Cloud-drive': url };
  return {
    ext: restoreExt(next, parsed.wasString, parsed.wasJson),
    changed: true,
  };
}

/**
 * 3D Pan 派生 Spiders 的 Cloud-drive JSON 契约。
 *
 * WoGG/PanSearch 经 Pan.init 依次初始化 Ali/Quark/Uc；对应 init 在
 * ext.from 包含 tvfan 时读取 ext.Cloud-drive 指向的 JSON。该 JSON 只认：
 * - quarkCookie: 夸克 Cookie
 * - ucCookie: UC Cookie
 * - token: 阿里云盘 refresh token
 *
 * 该契约不是 Pan.init 的 /credential/<field> URL 契约，禁止向 ext 写入
 * quark/uc/baidu 等字段，否则会再次出现跨 JAR 行为漂移。
 */
function d3CloudFieldValues(
  creds: Map<CloudPlatform, CloudCredential>,
  neededPlatforms?: CloudPlatform[],
): Record<string, string> {
  const allowed = neededPlatforms ? new Set(neededPlatforms) : null;
  const canUse = (platform: CloudPlatform): boolean => {
    if (allowed && !allowed.has(platform)) return false;
    // 夸克 Pan.init 只有带 __pus/__puus 的 Cookie 才能直接免扫码；
    // 普通 Cookie 写进 3d.json 会让 JAR 认为初始化已成功，随后仍弹扫码。
    if (platform === 'quark') {
      return isPanInitCredentialDistributable('quark', creds.get('quark'));
    }
    return isCredentialDistributable(platform, creds.get(platform));
  };
  const values: Record<string, string> = {};
  if (canUse('quark')) {
    const cookie = getCredValue(creds, 'quark', 'cookie');
    if (cookie) values.quarkCookie = cookie;
  }
  if (canUse('uc')) {
    const cookie = getCredValue(creds, 'uc', 'cookie');
    if (cookie) values.ucCookie = cookie;
  }
  if (canUse('aliyun')) {
    const token = getCredValue(creds, 'aliyun', 'refresh_token')
      || getCredValue(creds, 'aliyun', 'token')
      || getCredValue(creds, 'aliyun', 'ali_token');
    if (token) values.token = token;
  }
  return values;
}

export function generate3DCloudJson(
  credentials: Map<CloudPlatform, CloudCredential>,
  neededPlatforms?: CloudPlatform[],
): Record<string, string> {
  return d3CloudFieldValues(credentials, neededPlatforms);
}

function inject3DCloudDriveJson(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  baseUrl?: string,
  neededPlatforms?: CloudPlatform[],
): { ext: any; changed: boolean } {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return { ext, changed: false };
  const values = d3CloudFieldValues(creds, neededPlatforms);
  if (Object.keys(values).length === 0) return { ext, changed: false };

  const parsed = parseExt(ext);
  if (!parsed.injectable) return { ext, changed: false };

  const revision = ['aliyun', 'quark', 'uc']
    .filter((platform) => !neededPlatforms || neededPlatforms.includes(platform as CloudPlatform))
    .map((platform) => credentialRevision(creds.get(platform as CloudPlatform)))
    .filter(Boolean)
    .sort()
    .join('.');
  const query = revision ? `?v=${revision}` : '';
  const url = `${normalizedBaseUrl}/credential/3d.json${query}`;
  const next = { ...parsed.obj };
  let changed = false;
  if (next['Cloud-drive'] !== url) {
    next['Cloud-drive'] = url;
    changed = true;
  }

  const from = typeof next.from === 'string' ? next.from : '';
  const fromParts = from.split('|').map((part: string) => part.trim()).filter(Boolean);
  if (!fromParts.some((part: string) => part.toLowerCase() === 'tvfan')) {
    fromParts.push('tvfan');
  }
  const normalizedFrom = fromParts.join('|');
  if (next.from !== normalizedFrom) {
    next.from = normalizedFrom;
    changed = true;
  }

  return changed
    ? { ext: restoreExt(next, parsed.wasString, parsed.wasJson), changed: true }
    : { ext, changed: false };
}

/**
 * 3D YiSo 继承 Ali.init；只有 ext.from 含 tvfan 时，才会把
 * ext.Cloud-drive 指向的 JSON 中的 token 作为阿里云盘初始化凭证。
 */
function injectAliTokenUrl(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  baseUrl?: string,
): { ext: any; changed: boolean } {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return { ext, changed: false };

  const parsed = parseExt(ext);
  if (!parsed.injectable) return { ext, changed: false };
  if (!isCredentialDistributable('aliyun', creds.get('aliyun'))) {
    return { ext, changed: false };
  }

  const revision = credentialRevision(creds.get('aliyun'));
  const query = revision ? `?v=${revision}` : '';
  const url = `${normalizedBaseUrl}/credential/aliyun.json${query}`;
  const next = { ...parsed.obj };
  let changed = false;
  if (next['Cloud-drive'] !== url) {
    next['Cloud-drive'] = url;
    changed = true;
  }
  const from = typeof next.from === 'string' ? next.from : '';
  const fromParts = from.split('|').map((part: string) => part.trim()).filter(Boolean);
  if (!fromParts.some((part: string) => part.toLowerCase() === 'tvfan')) {
    fromParts.push('tvfan');
  }
  const normalizedFrom = fromParts.join('|');
  if (next.from !== normalizedFrom) {
    next.from = normalizedFrom;
    changed = true;
  }

  return changed
    ? { ext: restoreExt(next, parsed.wasString, parsed.wasJson), changed: true }
    : { ext, changed: false };
}

/**
 * Mogg/Wogg 的 Pan.init 会把 ext 中以下键当作 URL 拉取：
 * p123/xunlei/tianyi 返回 username+password JSON，其余返回原始 cookie 文本。
 * 因此不能把 cookie 直接塞进 ext，只能下发项目自托管初始化 URL。
 */
/**
 * B63 Cloud.init 的内联凭证契约。
 *
 * 反汇编确认其字段名和值语义：
 * - cookie       -> 夸克 Cookie 原始值
 * - uccookie     -> UC Cookie 原始值
 * - tianyicookie -> 天翼 Cookie 原始值
 * - token        -> 阿里云盘 refresh token 原始值
 *
 * 该 JAR 不读取 quark/uc/baidu/p123 等 URL 字段；写 URL 会导致客户端
 * 忽略凭证并回退扫码。这里只写入原字段，保留 site 等上游配置。
 */
function injectB63CloudInline(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
): { ext: any; changed: boolean } {
  const parsed = parseExt(ext);
  if (!parsed.injectable) return { ext, changed: false };

  const next = { ...parsed.obj };
  let changed = false;
  const setField = (field: string, value: string) => {
    if (!value || next[field] === value) return;
    next[field] = value;
    changed = true;
  };

  if (isCredentialDistributable('quark', creds.get('quark'))) {
    setField('cookie', getCredValue(creds, 'quark', 'cookie'));
  }
  if (isCredentialDistributable('uc', creds.get('uc'))) {
    setField('uccookie', getCredValue(creds, 'uc', 'cookie'));
  }
  if (isCredentialDistributable('tianyi', creds.get('tianyi'))) {
    setField('tianyicookie', getCredValue(creds, 'tianyi', 'cookie'));
  }
  if (isCredentialDistributable('aliyun', creds.get('aliyun'))) {
    const token = getCredValue(creds, 'aliyun', 'refresh_token')
      || getCredValue(creds, 'aliyun', 'token')
      || getCredValue(creds, 'aliyun', 'ali_token');
    setField('token', token);
  }

  return changed
    ? { ext: restoreExt(next, parsed.wasString, parsed.wasJson), changed: true }
    : { ext, changed: false };
}

function injectPanInitUrls(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  baseUrl?: string,
  allowedPlatforms?: PanInitPlatform[],
): { ext: any; changed: boolean } {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return { ext, changed: false };

  let parsed: { obj: Record<string, any>; wasString: boolean; wasJson: boolean };
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    parsed = { obj: ext as Record<string, any>, wasString: false, wasJson: false };
  } else if (typeof ext === 'string') {
    try {
      const json = JSON.parse(ext);
      parsed = json && typeof json === 'object' && !Array.isArray(json)
        ? { obj: json as Record<string, any>, wasString: true, wasJson: true }
        : { obj: {}, wasString: true, wasJson: false };
    } catch {
      // Wogg/Wobg 常见 ext 是 token.json 地址；这里转换为 Pan.init 平台 URL 对象。
      parsed = { obj: {}, wasString: true, wasJson: false };
    }
  } else if (ext === undefined || ext === null || ext === '') {
    parsed = { obj: {}, wasString: false, wasJson: false };
  } else {
    return { ext, changed: false };
  }

  const next = { ...parsed.obj };
  let changed = false;
  const allowed = allowedPlatforms ? new Set(allowedPlatforms) : null;
  for (const { field, platform } of PAN_INIT_FIELDS) {
    if (allowed && !allowed.has(platform)) continue;
    if (hasPanInitCredential(creds, platform)) {
      const revision = credentialRevision(creds.get(platform));
      const query = revision ? `?v=${revision}` : '';
      const url = `${normalizedBaseUrl}/credential/${field}${query}`;
      if (next[field] !== url) {
        next[field] = url;
        changed = true;
      }
    } else if (isCredentialFieldUrl(next[field], field, normalizedBaseUrl)) {
      // 只清理指向本项目凭证接口的旧 URL，避免把用户自己的第三方初始化地址误删。
      delete next[field];
      changed = true;
    }
  }

  if (!changed) return { ext, changed: false };
  // Pan.init only accepts a JSON object here. If the original ext was a token.json
  // string (common in Wogg/WoGG configs), convert it instead of preserving that string.
  return { ext: next, changed: true };
}

/**
 * 返回某个源真正可以下发的 Pan.init 平台集合。
 * 仅当凭证字段完整时才允许客户端请求对应 /credential/*；部分配置不会生成 404 地址，
 * 避免 JAR 因某个初始化 URL 失败而放弃加载其它已配置平台。
 */
export function getInjectablePanInitPlatforms(
  creds: Map<CloudPlatform, CloudCredential>,
): PanInitPlatform[] {
  return PAN_INIT_FIELDS
    .filter(({ platform }) => hasPanInitCredential(creds, platform))
    .map(({ platform }) => platform);
}

function canInjectAListCredentials(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  platforms: CloudPlatform[] = ALIST_PLATFORMS,
): boolean {
  if (!hasCompleteCredentialForPlatforms(creds, platforms)) return false;
  if (typeof ext === 'string' && isHttpUrl(ext)) return true;

  const parsed = parseExt(ext);
  if (!parsed.injectable) return false;
  if (isHttpUrl(parsed.obj.json)) return true;

  if (Array.isArray(parsed.obj.drives)) {
    return parsed.obj.drives.some((drive) => {
      if (!drive || typeof drive !== 'object' || Array.isArray(drive)) return false;
      const driveObj = drive as Record<string, any>;
      const platform = alistDrivePlatform(driveObj);
      if (!platform || !platforms.includes(platform)) return false;
      if (!isCompleteCredential(platform, creds.get(platform))) return false;
      return ALIST_DRIVE_FIELD_MAP.some((rule) => rule.platform === platform && rule.field in driveObj);
    });
  }

  return hasInjectablePlatformField(ext, creds, platforms, ALIST_DEFAULT_FIELDS);
}

// ─── 协议执行 ────────────────────────────────────────────

function getEffectiveJar(site: TVBoxSite, globalSpider?: string): string {
  return extractJarMd5(site.jar) ? (site.jar || '') : (globalSpider || '');
}

/** 对直连 cookie 字段的协议执行真实 ext 写入。 */
function injectDirectField(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  platform: CloudPlatform,
): { ext: any; changed: boolean } {
  const parsed = parseExt(ext);
  if (!parsed.injectable) return { ext, changed: false };
  const next = { ...parsed.obj };
  let changed = false;

  if (platform === 'bilibili' || platform === 'pan115') {
    const value = getCredValue(creds, platform, 'cookie');
    if (value && next.cookie !== value) {
      next.cookie = value;
      changed = true;
    }
    return changed
      ? { ext: restoreExt(next, parsed.wasString, parsed.wasJson), changed: true }
      : { ext, changed: false };
  }

  if (platform === 'pan123' || platform === 'thunder') {
    const username = getCredValue(creds, platform, 'username');
    const password = getCredValue(creds, platform, 'password');
    if (!username || !password) return { ext, changed: false };
    if (next.username !== username) {
      next.username = username;
      changed = true;
    }
    if (next.password !== password) {
      next.password = password;
      changed = true;
    }
    return changed
      ? { ext: restoreExt(next, parsed.wasString, parsed.wasJson), changed: true }
      : { ext, changed: false };
  }

  return { ext, changed: false };
}

/**
 * 已确认协议的 ext 凭证入口必须互斥。
 *
 * 上游原 ext 里可能同时残留项目此前生成的两套入口。客户端 JAR 读取
 * 字段的顺序不可控，双入口会让“已选机制”被另一套旧机制抢先，表现为
 * 明明写入了凭证却仍然扫码。这里只清理明确指向本项目地址的旧入口，
 * 不删除上游真正自带的第三方初始化地址。
 */
const CLOUD_DRIVE_CONFLICT_FIELDS = new Set([
  'cloud-drive', 'clouddrive', 'ali-drive', 'alidrive',
]);

const PAN_INIT_CONFLICT_FIELDS = new Set([
  'p123', 'xunlei', 'quark', 'uc', 'tianyi', 'baidu',
]);

function normalizeCredentialConflictKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function isProjectUrlOnBase(value: unknown, baseUrl: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const base = baseUrl.replace(/\/+$/, '');
  return value.trim().startsWith(base + '/');
}

function isProjectCredentialUrl(
  value: unknown,
  baseUrl: string,
  mechanism: CredentialProtocol['mechanism'],
): boolean {
  if (!isProjectUrlOnBase(value, baseUrl)) return false;
  const base = baseUrl.replace(/\/+$/, '');
  const path = String(value).trim().slice(base.length).split('?')[0].split('#')[0];
  const authPrefix = '(?:\/auth\/[^/]+)?';

  if (mechanism === 'tvfan-config-url') {
    return new RegExp(`^${authPrefix}\/tvfan\/config$`).test(path);
  }
  if (mechanism === 'token-json-url') {
    return new RegExp(`^${authPrefix}\/token\.json$`).test(path);
  }
  if (mechanism === 'd3-cloud-drive-json') {
    return new RegExp(`^${authPrefix}\/credential\/3d\.json$`).test(path);
  }
  if (mechanism === 'ali-token-url') {
    return new RegExp(`^${authPrefix}\/credential\/aliyun\.json$`).test(path);
  }
  if (mechanism === 'pan-init-url' || mechanism === 'pan-search-fixed-baidu' || mechanism === 'pan-search-ext-pan') {
    const match = path.match(new RegExp(`^${authPrefix}\/credential\/([A-Za-z0-9_.-]+)$`));
    return !!match && PAN_INIT_FIELDS.some(({ field }) => field === match[1]);
  }
  return false;
}

/**
 * 按当前机制清理本项目遗留的旧凭证入口。
 *
 * - Cloud-drive / Ali-drive 类机制：清掉本项目旧的 Pan.init 平台 URL。
 * - Pan.init 类机制：清掉本项目旧的 Cloud-drive/Ali-drive 入口。
 * - B63 inline：清掉本项目两种旧 URL 入口。
 */
function removeCredentialConflictEntries(
  ext: any,
  baseUrl?: string,
  mechanism?: CredentialProtocol['mechanism'],
): { ext: any; changed: boolean } {
  if (!mechanism || mechanism === 'none' || mechanism === 'unknown') {
    return { ext, changed: false };
  }
  const parsed = parseExt(ext);
  if (!parsed.injectable) return { ext, changed: false };
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return { ext, changed: false };

  const next = { ...parsed.obj };
  let changed = false;
  const removeProjectValue = (key: string) => {
    if (!(key in next)) return;
    if (isProjectUrlOnBase(next[key], normalizedBaseUrl)) {
      delete next[key];
      changed = true;
    }
  };

  // Pan.init 与 Cloud-drive 是两套互斥入口。上游常见的相对值
  // `tvfan/Cloud-drive.txt` 同样会被某些 JAR 当作登录入口；切换到
  // Pan.init 时必须移除，否则客户端初始化结果取决于字段读取顺序。
  const removePanSearchCloudDriveEntry = (key: string) => {
    if (!(key in next)) return;
    const raw = next[key];
    if (typeof raw !== 'string') return;
    const value = raw.trim();
    if (!value) return;
    if (
      isProjectUrlOnBase(value, normalizedBaseUrl)
      || /^tvfan\/cloud-drive\.txt(?:[?#].*)?$/i.test(value)
      || /^\/?cloud-drive\.txt(?:[?#].*)?$/i.test(value)
    ) {
      delete next[key];
      changed = true;
    }
  };

  const cloudDriveMechanism = mechanism === 'token-json-url'
    || mechanism === 'tvfan-config-url'
    || mechanism === 'd3-cloud-drive-json'
    || mechanism === 'ali-token-url';

  if (cloudDriveMechanism || mechanism === 'b63-cloud-inline') {
    for (const key of Object.keys(next)) {
      if (!PAN_INIT_CONFLICT_FIELDS.has(normalizeCredentialConflictKey(key))) continue;
      removeProjectValue(key);
    }
  }

  if (mechanism === 'pan-init-url' || mechanism === 'pan-search-fixed-baidu' || mechanism === 'pan-search-ext-pan') {
    for (const key of Object.keys(next)) {
      if (!CLOUD_DRIVE_CONFLICT_FIELDS.has(normalizeCredentialConflictKey(key))) continue;
      removePanSearchCloudDriveEntry(key);
    }
  }

  return changed
    ? { ext: restoreExt(next, parsed.wasString, parsed.wasJson), changed: true }
    : { ext, changed: false };
}

/**
 * 唯一的协议执行入口。风险判断与正式下发都必须经过这里，避免两边规则漂移。
 * 返回 changed=false 时不允许计为已下发。
 */
function hasAppliedCredentialMechanism(
  ext: any,
  baseUrl: string,
  mechanism: CredentialProtocol['mechanism'],
  platforms: CloudPlatform[],
  credentials: Map<CloudPlatform, CloudCredential>,
): boolean {
  const parsed = parseExt(ext);
  if (!parsed.injectable) return false;

  if (
    mechanism === 'token-json-url'
    || mechanism === 'tvfan-config-url'
    || mechanism === 'd3-cloud-drive-json'
    || mechanism === 'ali-token-url'
  ) {
    return isProjectCredentialUrl(parsed.obj['Cloud-drive'], baseUrl, mechanism);
  }

  if (
    mechanism === 'pan-init-url'
    || mechanism === 'pan-search-fixed-baidu'
    || mechanism === 'pan-search-ext-pan'
  ) {
    const allowed = new Set(platforms);
    return PAN_INIT_FIELDS.some(({ field, platform }) => (
      allowed.has(platform)
      && hasPanInitCredential(credentials, platform)
      && isProjectCredentialUrl(parsed.obj[field], baseUrl, mechanism)
    ));
  }

  return false;
}
function applyCredentialProtocol(
  site: TVBoxSite,
  protocol: CredentialProtocol,
  credentials: Map<CloudPlatform, CloudCredential>,
  baseUrl: string,
  globalSpider?: string,
): { ext: any; changed: boolean } {
  if (!protocol.canInject) return { ext: site.ext, changed: false };

  const applied = applyCredentialProtocolRaw(
    site,
    protocol,
    credentials,
    baseUrl,
  );
  // 只有目标机制真正写入（或 ext 已包含本项目的目标 URL）时，才允许清理互斥入口。
  // 否则会在本次未成功下发凭证时误删上游自带的初始化入口。
  const active = applied.changed || hasAppliedCredentialMechanism(
    applied.ext,
    baseUrl,
    protocol.mechanism,
    protocol.platforms,
    credentials,
  );
  if (!active) {
    return { ext: applied.ext, changed: applied.changed };
  }
  const cleaned = removeCredentialConflictEntries(applied.ext, baseUrl, protocol.mechanism);
  return {
    ext: cleaned.ext,
    changed: true,
  };
}

function applyCredentialProtocolRaw(
  site: TVBoxSite,
  protocol: CredentialProtocol,
  credentials: Map<CloudPlatform, CloudCredential>,
  baseUrl: string,
): { ext: any; changed: boolean } {
  switch (protocol.mechanism) {
    case 'ali-token-url':
      return injectAliTokenUrl(site.ext, credentials, baseUrl);

    case 'd3-cloud-drive-json':
      return inject3DCloudDriveJson(site.ext, credentials, baseUrl, protocol.platforms);

    case 'tvfan-config-url':
      return injectCloudDriveTokenUrl(site.ext, credentials, baseUrl, protocol.platforms, 'tvfan-config-url');

    case 'token-json-url':
      return injectCloudDriveTokenUrl(site.ext, credentials, baseUrl, protocol.platforms, 'token-json-url');

    case 'pan-init-url':
      return injectPanInitUrls(site.ext, credentials, baseUrl);

    case 'b63-cloud-inline':
      return injectB63CloudInline(site.ext, credentials);

    case 'pan-search-fixed-baidu':
      return injectPanInitUrls(site.ext, credentials, baseUrl, ['baidu']);

    case 'pan-search-ext-pan': {
      const platform = protocol.fixedPlatform || getPanSearchPlatform(site);
      if (!platform || !isPanInitPlatform(platform)) return { ext: site.ext, changed: false };
      return injectPanInitUrls(site.ext, credentials, baseUrl, [platform]);
    }

    case 'alist': {
      const proxied = injectAListProxyUrl(site.ext, baseUrl);
      if (proxied.changed) return proxied;

      // AList 既可能通过 /credential/alist?src=... 代理远程 JSON，也可能把
      // drives 直接内联在 ext 中。后者必须在这里同步合并，否则响应侧虽然
      // 能识别 AList，配置里的 drive 凭证仍为空。
      const parsed = parseExt(site.ext);
      if (parsed.injectable && Array.isArray(parsed.obj.drives)) {
        const merged = injectAListDriveCredentials(parsed.obj.drives, credentials);
        if (merged.changed) {
          return {
            ext: restoreExt({ ...parsed.obj, drives: merged.drives }, parsed.wasString, parsed.wasJson),
            changed: true,
          };
        }
      }

      return injectPlatformFields(
        site.ext,
        credentials,
        ALIST_PLATFORMS,
        ALIST_DEFAULT_FIELDS,
      );
    }

    case 'direct-ext-field': {
      const platform = protocol.platforms[0];
      if (!platform) return { ext: site.ext, changed: false };
      return injectDirectField(site.ext, credentials, platform);
    }

    default:
      return { ext: site.ext, changed: false };
  }
}

/** 响应期契约预检：API 与 JAR MD5 均为 O(1)/轻量提取，不读取 ext。 */
function matchesContractBaseline(site: TVBoxSite, expected: SiteContract, fallbackJar?: string): boolean {
  if (expected.api !== site.api) return false;
  return (expected.jarMd5 || undefined) === (extractJarMd5(site.jar || fallbackJar) || undefined);
}

/** 完整契约校验只应在确认本次会注入后调用。 */
export function matchesFullContract(site: TVBoxSite, expected: SiteContract, fallbackJar?: string): boolean {
  const actual = buildSiteContract(site, fallbackJar);
  if (actual.api !== expected.api) return false;
  if ((actual.jarMd5 || undefined) !== (expected.jarMd5 || undefined)) return false;
  if (actual.extShape !== expected.extShape) return false;
  if ((actual.pan || undefined) !== (expected.pan || undefined)) return false;
  if ((actual.extPan || undefined) !== (expected.extPan || undefined)) return false;
  if (actual.extShape !== 'object') return true;

  const actualKeys = actual.extKeys || [];
  const expectedKeys = expected.extKeys || [];
  const actualSet = new Set(actualKeys);
  const expectedSet = new Set(expectedKeys);
  // 响应期清洗可能移除历史项目注入字段；其它缺字段、增字段均视为真实漂移。
  if (actualKeys.some((key) => !expectedSet.has(key))) return false;
  const removable = new Set(expected.injectableExtKeys || []);
  return expectedKeys.every((key) => actualSet.has(key) || removable.has(key));
}

// ─── 注入引擎 ────────────────────────────────────────────

export interface InjectionReport {
  injected: number;
  skippedSafe: number;
  skippedDenied: number;
  skippedHighRisk: number;
  skippedUnaudited: number;
  skippedNoRule: number;
  skippedNoCredential: number;
  skippedDisallowedUpstream: number;
  skippedContractMismatch: number;
}

/**
 * 判断某个源在已保存凭证下是否真的能发生注入。
 * 用占位 base URL 运行与正式下发相同的协议执行器，但不把占位地址返回给调用方。
 */
export function canDistributeCredentialsToSite(
  site: TVBoxSite,
  credentials: Map<CloudPlatform, CloudCredential>,
  baseUrl = 'https://credential.invalid',
  globalSpider?: string,
): boolean {
  const protocol = resolveCredentialProtocol(site, {
    effectiveJar: getEffectiveJar(site, globalSpider),
  });
  if (!protocol.credentialRequired || !protocol.canInject) return false;

  return applyCredentialProtocol(
    site,
    protocol,
    credentials,
    baseUrl,
    globalSpider,
  ).changed;
}

/**
 * 对 merged.sites 执行凭证注入
 * 返回注入后的 sites 数组和注入报告
 */
export function injectCredentials(
  sites: TVBoxSite[],
  credentials: Map<CloudPlatform, CloudCredential>,
  policy: CredentialPolicyConfig,
  baseUrl?: string,
  allowedSiteKeys?: Set<string> | null,
  contractsBySiteKey?: Map<string, SiteContract> | null,
  /** 严格模式：来源边界缺失/损坏时拒绝注入，而不是回退到全量注入。 */
  requireSiteBoundary = false,
  /** 严格模式：契约缺失时拒绝注入，避免旧模板跨 JAR/API 误注入。 */
  requireContractMap = false,
  /** 顶层 spider；站点自身 jar 为空时作为实际生效的 JAR 契约。 */
  globalSpider?: string,
): { sites: TVBoxSite[]; report: InjectionReport } {
  const report: InjectionReport = {
    injected: 0,
    skippedSafe: 0,
    skippedDenied: 0,
    skippedHighRisk: 0,
    skippedUnaudited: 0,
    skippedNoRule: 0,
    skippedNoCredential: 0,
    skippedDisallowedUpstream: 0,
    skippedContractMismatch: 0,
  };

  const deniedSet = new Set(policy.deniedKeys);

  // 严格模式只应在聚合已完成、site_upstream_map 已落库的部署上开启。
  // 映射缺失或为空时拒绝所有注入，避免“边界数据不可用”退化为全量下发。
  if (requireSiteBoundary && (!allowedSiteKeys || allowedSiteKeys.size === 0)) {
    report.skippedDisallowedUpstream = sites.length;
    return { sites, report };
  }
  if (requireContractMap && (!contractsBySiteKey || contractsBySiteKey.size === 0)) {
    report.skippedContractMismatch = sites.length;
    return { sites, report };
  }

  const result = sites.map(site => {
    // 总源边界：映射存在时，只允许由实际启用的顶层总源贡献的站点注入。
    // 这必须在协议判断之前执行，确保未知/禁用/残留站点一个凭证字段都不写。
    if (allowedSiteKeys && !allowedSiteKeys.has(site.key)) {
      report.skippedDisallowedUpstream++;
      return site;
    }

    // 用户手动拉黑
    if (deniedSet.has(site.key)) {
      report.skippedDenied++;
      return site;
    }

    const protocol = resolveCredentialProtocol(site, {
      effectiveJar: getEffectiveJar(site, globalSpider),
    });

    // 没有已验证凭证协议，或源本身不需要客户端凭证。
    if (!protocol.credentialRequired) {
      report.skippedSafe++;
      return site;
    }
    if (!protocol.canInject) {
      report.skippedNoRule++;
      return site;
    }

    if (!protocol.platforms.some((platform) => isCredentialDistributable(platform, credentials.get(platform)))) {
      report.skippedNoCredential++;
      return site;
    }

    // 契约安全阀放在“确认协议可注入且存在凭证”之后执行：
    // 不改变拒绝结果，但避免对整库无需注入的站点做 ext 解析/排序。
    const expectedContract = contractsBySiteKey?.get(site.key);
    if (expectedContract && !matchesContractBaseline(site, expectedContract, globalSpider)) {
      report.skippedContractMismatch++;
      return site;
    }

    // 到这里才支付详细契约校验的成本；ext 漂移会被拒绝，防止跨 JAR/形态误注入。
    if (expectedContract && !matchesFullContract(site, expectedContract, globalSpider)) {
      report.skippedContractMismatch++;
      return site;
    }

    const applied = applyCredentialProtocol(
      site,
      protocol,
      credentials,
      baseUrl || '',
      globalSpider,
    );
    if (!applied.changed) {
      // 协议存在但当前 ext 形态没有可写字段（例如未识别的 AList 结构）。
      report.skippedNoCredential++;
      return site;
    }

    report.injected++;
    return { ...site, ext: applied.ext };
  });


  return { sites: result, report };
}

/**
 * 生成上游 Guard 的 `tvfan/config` 响应。
 *
 * 五个正式字段是上游契约本体：
 * - token: 阿里云盘 refresh token
 * - quarkCookie: 夸克 cookie
 * - bdCk: 百度网盘 cookie
 * - ucCookie: UC cookie
 * - ucToken: UC TV token
 *
 * 同时补上旧版 Guard 会读取的下划线/短别名（quark_cookie、uc_cookie、
 * baidu_cookie 等）。只增加别名、不改变正式字段，避免再出现“某几个源能播、
 * 另一些源仍回退扫码”的分裂现象。
 */
export function generateTvfanConfig(
  credentials: Map<CloudPlatform, CloudCredential>,
  neededPlatforms?: CloudPlatform[],
): Record<string, string> {
  const selectedPlatforms = neededPlatforms || [...credentials.keys()];
  const allowed = neededPlatforms ? new Set(neededPlatforms) : null;
  const canUse = (platform: CloudPlatform): boolean => (
    (!allowed || allowed.has(platform))
    && isCredentialDistributable(platform, credentials.get(platform))
  );
  const value = (platform: CloudPlatform, ...fields: string[]): string => {
    for (const field of fields) {
      const raw = credentials.get(platform)?.credential?.[field];
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
    }
    return '';
  };

  const config: Record<string, string> = {};
  if (canUse('aliyun')) {
    const token = value('aliyun', 'refresh_token', 'token', 'ali_token');
    if (token) config.token = token;
  }
  if (canUse('quark')) {
    const cookie = value('quark', 'cookie');
    if (cookie) {
      config.quarkCookie = cookie;
      config.quark_cookie = cookie;
      config.cookie = cookie;
    }
  }
  if (canUse('baidu')) {
    const cookie = value('baidu', 'cookie');
    if (cookie) {
      config.bdCk = cookie;
      config.baidu_cookie = cookie;
    }
  }
  if (canUse('uc')) {
    const cookie = value('uc', 'cookie');
    if (cookie) {
      config.ucCookie = cookie;
      config.uc_cookie = cookie;
    }
  }
  if (canUse('uc_tv')) {
    const token = value('uc_tv', 'token', 'refresh_token', 'ucToken');
    if (token) config.ucToken = token;
  }

  // 只要调用方限定了平台但没有任何正式字段，仍视为不可下发。
  if (selectedPlatforms.length > 0 && Object.keys(config).length === 0) return {};
  return config;
}

/**
 * 生成自托管 token.json 内容
 * 格式与公共 token.json 一致，只填充用户已登录的网盘凭证
 */
export function generateTokenJson(
  credentials: Map<CloudPlatform, CloudCredential>,
  neededPlatforms?: CloudPlatform[],
): Record<string, any> {
  const selectedPlatforms = neededPlatforms || [...credentials.keys()];
  const hasDistributableCredential = selectedPlatforms.some((platform) => (
    isCredentialDistributable(platform, credentials.get(platform))
  ));
  if (!hasDistributableCredential) return {};

  const token: Record<string, any> = {
    // 2cc Guard 会先读取这份完整 schema，再判断服务端凭证是否可用于免扫码播放。
    // 只返回当前用户命中的几个字段，会让 cookie 看起来有效但 Guard 仍回退扫码。
    token: '',
    open_token: '',
    open_api_url: 'postparam|http://api.extscreen.com/aliyundrive/token',
    oauth_client_id: '',
    oauth_client_secret: '',
    oauth_auth_url: '',
    oauth_refresh_url: '',
    is_vip: true,
    vip_thread_limit: 32,
    vip_thread_limit_night: '19-23=10',
    vod_flags: '4kz|auto',
    quark_thread_limit: 32,
    quark_thread_limit_night: '19-23=10',
    quark_is_guest: false,
    quark_vip_thread_limit: 32,
    quark_vip_thread_limit_night: '19-23=10',
    quark_flags: '4kz|auto',
    uc_thread_limit: 0,
    uc_is_vip: false,
    uc_vip_thread_limit: 0,
    uc_flags: '4kz|auto',
    thunder_thread_limit: 2,
    thunder_is_vip: false,
    thunder_vip_thread_limit: 2,
    thunder_flags: '4kz',
    aliproxy: '',
    aliproxy_url: '',
    proxy: '',
    danmu: true,
    quark_danmu: true,
    quark_cookie: '',
    uc_cookie: '',
    thunder_username: '',
    thunder_password: '',
    thunder_captchatoken: '',
    yd_auth: '',
    yd_thread_limit: 4,
    yd_flags: 'auto|4kz',
    yd_danmu: true,
    pikpak_username: '',
    pikpak_password: '',
    pikpak_flags: '4kz',
    pikpak_thread_limit: 2,
    pikpak_vip_thread_limit: 2,
    pikpak_proxy: '',
    pikpak_proxy_onlyapi: false,
    pikpak_danmu: true,
    wgcf_key: '',
    wgcf_key2: '',
    wgcf_ipport: '',
    wgcf_xray_url: './xray.gz',
    wgcf_geoip_url: './geoip.dat.gz',
    wgcf_json_url: './wgcf.json',
    wgcf_vless_id: '',
    wgcf_vless_optname: 'singapore.com:443',
    wgcf_vless_worker: '',
    wgcf_vless_path: '/?ed=2048',
    wgcf_vless_protocol: 'vless',
    wgcf_vless_network: 'ws',
    wgcf_vless_tls: false,
    libxl_url: './libxl_thunder_sdk.so',
    youtube_proxy: '',
    singbox_url: './sing-box.gz',
    singbox_subscribe_url: '',
    singbox_clash2singbox_url: './clash2singbox.gz',
    singbox_template_url: './singbox.json',
    pan115_cookie: '',
    pan115_thread_limit: 0,
    pan115_vip_thread_limit: 0,
    pan115_is_vip: false,
    pan115_flags: '4kz',
    pan115_speed_limit: 0,
    pan115_speed_limit_mobile: 10485760,
    pan115_auto_delete: true,
    pan115_delete_code: '',
    pan_order: 'ali|quark|uc|115|yd|thunder|pikpak',
  };
  const allowed = neededPlatforms ? new Set(neededPlatforms) : null;
  const canUse = (platform: CloudPlatform): boolean => (
    (!allowed || allowed.has(platform)) && isCredentialDistributable(platform, credentials.get(platform))
  );
  const value = (platform: CloudPlatform, field: string): string => {
    const raw = credentials.get(platform)?.credential?.[field];
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const set = (field: string, raw: string | undefined) => {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text) token[field] = text;
  };

  if (canUse('aliyun')) {
    const aliToken = value('aliyun', 'refresh_token')
      || value('aliyun', 'token')
      || value('aliyun', 'ali_token');
    set('refresh_token', aliToken);
    set('token', aliToken);
    set('ali_token', aliToken);
    set('open_token', value('aliyun', 'open_token'));
  }

  if (canUse('quark')) {
    const cookie = value('quark', 'cookie');
    set('quark_cookie', cookie);
    set('quarkCookie', cookie);
    set('cookie', cookie);
  }

  if (canUse('uc')) {
    const cookie = value('uc', 'cookie');
    set('uc_cookie', cookie);
    set('ucCookie', cookie);
    set('uccookie', cookie);
  }

  if (canUse('pan115')) {
    const cookie = value('pan115', 'cookie');
    set('pan115_cookie', cookie);
    // 保留旧客户端/旧 Guard 使用的别名，规范字段始终优先生效。
    set('115_cookie', cookie);
    set('115Cookie', cookie);
  }

  if (canUse('thunder')) {
    const username = value('thunder', 'username');
    const password = value('thunder', 'password');
    if (username && password) {
      set('thunder_username', username);
      set('thunder_password', password);
      set('xunlei_username', username);
      set('xunlei_password', password);
    }
    set('thunder_captchatoken', value('thunder', 'captchatoken') || value('thunder', 'thunder_captchatoken'));
    const thunderToken = value('thunder', 'token') || value('thunder', 'tuctoken');
    set('tuctoken', thunderToken);
    set('thunder_token', thunderToken);
  }

  if (canUse('pikpak')) {
    const username = value('pikpak', 'username');
    const password = value('pikpak', 'password');
    if (username && password) {
      set('pikpak_username', username);
      set('pikpak_password', password);
    }
  }

  if (canUse('bilibili')) {
    const cookie = value('bilibili', 'cookie');
    set('bili_cookie', cookie);
    set('bilibili_cookie', cookie);
  }

  if (canUse('tianyi')) {
    const username = value('tianyi', 'username');
    const password = value('tianyi', 'password');
    const cookie = value('tianyi', 'cookie');
    set('yd_auth', cookie);
    if (username && password) {
      set('tianyi_username', username);
      set('tianyi_password', password);
    }
    set('tianyi_cookie', cookie);
    set('tianyiCookie', cookie);
    set('tyitoken', cookie);
  }

  if (canUse('baidu')) {
    const cookie = value('baidu', 'cookie');
    set('baidu_cookie', cookie);
    set('baiduCookie', cookie);
    set('dutoken', cookie);
  }

  if (canUse('pan123')) {
    const username = value('pan123', 'username');
    const password = value('pan123', 'password');
    if (username && password) {
      set('p123_username', username);
      set('p123_password', password);
    }
    const pan123Token = value('pan123', 'token');
    set('123_token', pan123Token);
    set('123token', pan123Token);
    set('p123token', pan123Token);
  }

  return token;
}
