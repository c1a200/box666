// Cookie 注入引擎

import type { TVBoxSite, CloudPlatform, CloudCredential, CredentialPolicyConfig } from './types';
import { assessSourceRisk, getDirectPlatformFromApi, isAListSite, ALIST_PLATFORMS } from './credential-risk';
import { isCredentialDistributable, isPanInitCredentialDistributable } from './credential-store';

// ─── 注入规则 ────────────────────────────────────────────

export interface InjectionRule {
  apiPattern: string | RegExp;
  platforms: CloudPlatform[];
  inject: (ext: any, credentials: Map<CloudPlatform, CloudCredential>, baseUrl?: string) => any;
  canInject?: (ext: any, credentials: Map<CloudPlatform, CloudCredential>, baseUrl?: string) => boolean;
  skipTokenJsonReplacement?: boolean;
}

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
const ALIST_PLATFORM_IDENTIFIERS: Record<CloudPlatform, string[]> = {
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

function tokenJsonUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '') + '/token.json';
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
 * Mogg/Wogg 的 Pan.init 会把 ext 中以下键当作 URL 拉取：
 * p123/xunlei/tianyi 返回 username+password JSON，其余返回原始 cookie 文本。
 * 因此不能把 cookie 直接塞进 ext，只能下发项目自托管初始化 URL。
 */
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
      const url = `${normalizedBaseUrl}/credential/${field}`;
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
  return { ext: parsed.wasJson ? JSON.stringify(next) : next, changed: true };
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

// ─── 内置注入规则表 ─────────────────────────────────────

const BUILTIN_RULES: InjectionRule[] = [
  // csp_Bili / csp_BiliR: ext.cookie = bilibili cookie
  {
    apiPattern: /^csp_Bili/,
    platforms: ['bilibili'],
    canInject: (ext, creds) => isCompleteCredential('bilibili', creds.get('bilibili')) && parseExt(ext).injectable,
    inject: (ext, creds) => {
      const cookie = getCredValue(creds, 'bilibili', 'cookie');
      if (!cookie) return ext;
      const parsed = parseExt(ext);
      if (!parsed.injectable) return ext;
      if (parsed.obj.cookie === cookie) return ext;
      parsed.obj.cookie = cookie;
      return restoreExt(parsed.obj, parsed.wasString, parsed.wasJson);
    },
  },

  // csp_Wobg / csp_Wogg: Pan.init 按 URL 读取各平台初始化数据。
  // 不再使用 token.json 字符串；只生成当前真正完整配置的六个平台 URL。
  {
    apiPattern: /^csp_Wo[bg]g(?:Guard)?/i,
    platforms: ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak', 'tianyi', 'baidu', 'pan123'],
    skipTokenJsonReplacement: true,
    canInject: (_ext, creds) => getInjectablePanInitPlatforms(creds).length > 0,
    inject: (ext, creds, baseUrl?: string) => injectPanInitUrls(ext, creds, baseUrl || undefined).ext,
  },

  // csp_PanSearch(Guard): Pan 基类同样从 ext 中的平台键拉取 Pan.init 数据。
  // 线上“夸搜/盘搜”使用此 API；缺失该规则时，前端保存的夸克凭证不会下发。
  {
    apiPattern: /^csp_PanSearch(?:Guard)?/i,
    platforms: ['quark', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder'],
    skipTokenJsonReplacement: true,
    canInject: (ext, creds) => canInjectPanSearchCredential(ext, creds),
    inject: (ext, creds, baseUrl?: string) => injectPanSearchCredential(ext, creds, baseUrl || undefined),
  },

  // csp_Mogg: Pan.init 按 URL 读取各平台初始化数据。
  {
    apiPattern: /^csp_Mogg/i,
    platforms: ['quark', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder'],
    skipTokenJsonReplacement: true,
    canInject: (_ext, creds) => getInjectablePanInitPlatforms(creds).length > 0,
    inject: (ext, creds, baseUrl?: string) => injectPanInitUrls(ext, creds, baseUrl || undefined).ext,
  },

  // csp_Pan115: ext.cookie = 115 cookie
  {
    apiPattern: /^csp_Pan115(?:Guard)?$/i,
    platforms: ['pan115'],
    canInject: (ext, creds) => isCompleteCredential('pan115', creds.get('pan115')) && parseExt(ext).injectable,
    inject: (ext, creds) => {
      const cookie = getCredValue(creds, 'pan115', 'cookie');
      if (!cookie) return ext;
      const parsed = parseExt(ext);
      if (!parsed.injectable) return ext;
      parsed.obj.cookie = cookie;
      return restoreExt(parsed.obj, parsed.wasString, parsed.wasJson);
    },
  },

  // csp_P123：JAR 从 ext JSON 精确读取 username + password。
  {
    apiPattern: /^csp_P123/i,
    platforms: ['pan123'],
    canInject: (ext, creds) => hasPanInitCredential(creds, 'pan123') && parseExt(ext).injectable,
    inject: (ext, creds) => injectAccountPasswordExt(ext, creds, 'pan123').ext,
  },

  // csp_XunLei：JAR 从 ext JSON 精确读取 username + password。
  {
    apiPattern: /^csp_XunLei(?!8)/i,
    platforms: ['thunder'],
    canInject: (ext, creds) => hasPanInitCredential(creds, 'thunder') && parseExt(ext).injectable,
    inject: (ext, creds) => injectAccountPasswordExt(ext, creds, 'thunder').ext,
  },

  // csp_AList：远程 AList JSON 由本服务代理后再合并凭证；对象形式仍按字段注入。
  {
    apiPattern: /^csp_AList/i,
    platforms: ALIST_PLATFORMS,
    canInject: (ext, creds) => canInjectAListCredentials(ext, creds),
    inject: (ext, creds, baseUrl?: string) => {
      const proxied = injectAListProxyUrl(ext, baseUrl);
      if (proxied.changed) return proxied.ext;
      return injectPlatformFields(ext, creds, ALIST_PLATFORMS, ALIST_DEFAULT_FIELDS).ext;
    },
  },

  // csp_AweSomeGuard：仅 sp=AList 时改写远程 json URL；file:// 保持原样。
  {
    apiPattern: /^csp_AweSomeGuard/i,
    platforms: ALIST_PLATFORMS,
    canInject: (ext, creds) => isAListSite({ key: '', type: 3, api: 'csp_AweSomeGuard', ext })
      && canInjectAListCredentials(ext, creds),
    inject: (ext, creds, baseUrl?: string) => {
      if (!isAListSite({ key: '', type: 3, api: 'csp_AweSomeGuard', ext })) return ext;
      const proxied = injectAListProxyUrl(ext, baseUrl);
      if (proxied.changed) return proxied.ext;
      return injectPlatformFields(ext, creds, ALIST_PLATFORMS, ALIST_DEFAULT_FIELDS).ext;
    },
  },
];

// ─── 规则匹配 ────────────────────────────────────────────

function matchRule(api: string, rule: InjectionRule): boolean {
  if (typeof rule.apiPattern === 'string') {
    return api === rule.apiPattern;
  }
  return rule.apiPattern.test(api);
}

export function findMatchingRule(site: TVBoxSite): InjectionRule | null {
  for (const rule of BUILTIN_RULES) {
    if (matchRule(site.api, rule)) return rule;
  }
  return null;
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
}

/**
 * 判断某个源在已保存凭证下是否真的能发生注入。
 * 用占位 base URL 运行与正式下发相同的规则，但不把占位地址返回给调用方。
 */
export function canDistributeCredentialsToSite(
  site: TVBoxSite,
  credentials: Map<CloudPlatform, CloudCredential>,
  baseUrl = 'https://credential.invalid',
): boolean {
  const risk = assessSourceRisk(site);
  if (risk.neededPlatforms.length === 0) return false;

  const rule = findMatchingRule(site);
  if (rule) {
    if (rule.canInject) return rule.canInject(site.ext, credentials, baseUrl);
    return hasCompleteCredentialForPlatforms(credentials, rule.platforms) && parseExt(site.ext).injectable;
  }

  const directPlatform = getDirectPlatformFromApi(site.api);
  return !!directPlatform
    && isCompleteCredential(directPlatform, credentials.get(directPlatform))
    && parseExt(site.ext).injectable;
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
): { sites: TVBoxSite[]; report: InjectionReport } {
  const report: InjectionReport = {
    injected: 0,
    skippedSafe: 0,
    skippedDenied: 0,
    skippedHighRisk: 0,
    skippedUnaudited: 0,
    skippedNoRule: 0,
    skippedNoCredential: 0,
  };

  const deniedSet = new Set(policy.deniedKeys);

  const result = sites.map(site => {
    const risk = assessSourceRisk(site);

    // A类：源不需要凭证
    if (risk.neededPlatforms.length === 0) {
      report.skippedSafe++;
      return site;
    }

    // 用户手动拉黑
    if (deniedSet.has(site.key)) {
      report.skippedDenied++;
      return site;
    }

    const rule = findMatchingRule(site);
    const platforms = rule?.platforms || risk.neededPlatforms;
    const hasAnyCredential = hasCredentialForPlatforms(credentials, platforms);
    if (!hasAnyCredential) {
      report.skippedNoCredential++;
      return site;
    }

    const directPlatform = rule ? null : getDirectPlatformFromApi(site.api);
    const canInject = rule
      ? (rule.canInject
          ? rule.canInject(site.ext, credentials, baseUrl)
          : hasCompleteCredentialForPlatforms(credentials, platforms) && parseExt(site.ext).injectable)
      : !!directPlatform
        && isCompleteCredential(directPlatform, credentials.get(directPlatform))
        && parseExt(site.ext).injectable;

    if (!canInject) {
      report.skippedNoRule++;
      return site;
    }

    // Wogg/Mogg 的 Pan.init 规则必须自己生成平台 URL，不能再把 ext 替换成 token.json。
    let nextExt = site.ext;
    if (!rule?.skipTokenJsonReplacement) {
      const tokenResult = replaceTokenJsonUrl(nextExt, baseUrl || undefined);
      nextExt = tokenResult.ext;
    }

    if (rule) {
      nextExt = rule.inject(nextExt, credentials, baseUrl);
    } else if (directPlatform) {
      // 对于直连的单网盘平台，直接把凭据字段以 JSON 对象形式合并注入到 ext 中，
      // 避免客户端加载不到外部 token.json 的问题。
      const credObj = generateTokenJson(credentials, [directPlatform]);
      if (credObj && Object.keys(credObj).length > 0) {
        const parsed = parseExt(nextExt);
        if (parsed.injectable) {
          nextExt = restoreExt({ ...parsed.obj, ...credObj }, parsed.wasString, parsed.wasJson);
        }
      }
    }

    if (!rule?.skipTokenJsonReplacement) {
      const fieldResult = injectPlatformFields(nextExt, credentials, platforms);
      nextExt = fieldResult.ext;
    }

    report.injected++;
    return { ...site, ext: nextExt };
  });

  return { sites: result, report };
}

/**
 * 生成自托管 token.json 内容
 * 格式与公共 token.json 一致，只填充用户已登录的网盘凭证
 */
export function generateTokenJson(
  credentials: Map<CloudPlatform, CloudCredential>,
  neededPlatforms?: CloudPlatform[],
): Record<string, any> {
  const token: Record<string, any> = {};

  const platforms = neededPlatforms || [...credentials.keys()];

  for (const platform of platforms) {
    const cred = credentials.get(platform);
    if (!isCredentialDistributable(platform, cred)) continue;

    const value = (field: string): string => {
      const raw = cred?.credential[field];
      return typeof raw === 'string' ? raw.trim() : '';
    };

    switch (platform) {
      case 'aliyun': {
        const refreshToken = value('refresh_token');
        if (refreshToken) {
          token.refresh_token = refreshToken;
          token.token = refreshToken;
          token.ali_token = refreshToken;
        }
        const openToken = value('open_token');
        if (openToken) token.open_token = openToken;
        break;
      }
      case 'quark': {
        const cookie = value('cookie');
        if (cookie) {
          token.quark_cookie = cookie;
          token.quarkCookie = cookie;
          token.cookie = cookie;
        }
        break;
      }
      case 'uc': {
        const cookie = value('cookie');
        if (cookie) {
          token.uc_cookie = cookie;
          token.ucCookie = cookie;
          token.uccookie = cookie;
        }
        break;
      }
      case 'pan115': {
        const cookie = value('cookie');
        if (cookie) {
          token['115_cookie'] = cookie;
          token['115Cookie'] = cookie;
        }
        break;
      }
      case 'thunder': {
        const username = value('username');
        const password = value('password');
        if (username && password) {
          token.thunder_username = username;
          token.thunder_password = password;
          token.xunlei_username = username;
          token.xunlei_password = password;
        }
        const thunderToken = value('token') || value('tuctoken');
        if (thunderToken) {
          token.tuctoken = thunderToken;
          token.thunder_token = thunderToken;
        }
        break;
      }
      case 'pikpak': {
        const username = value('username');
        const password = value('password');
        if (username && password) {
          token.pikpak_username = username;
          token.pikpak_password = password;
        }
        break;
      }
      case 'bilibili': {
        const cookie = value('cookie');
        if (cookie) {
          token.bili_cookie = cookie;
          token.bilibili_cookie = cookie;
        }
        break;
      }
      case 'tianyi': {
        const username = value('username');
        const password = value('password');
        // Pan.init 的 tianyi 接口返回 username/password；保留 cookie 别名供旧 JAR 兼容。
        if (username && password) {
          token.tianyi_username = username;
          token.tianyi_password = password;
        }
        const cookie = value('cookie');
        if (cookie) {
          token.tianyi_cookie = cookie;
          token.tianyiCookie = cookie;
          token.tyitoken = cookie;
        }
        break;
      }
      case 'baidu': {
        const cookie = value('cookie');
        if (cookie) {
          token.baidu_cookie = cookie;
          token.baiduCookie = cookie;
          token.dutoken = cookie;
        }
        break;
      }
      case 'pan123': {
        const username = value('username');
        const password = value('password');
        if (username && password) {
          token.p123_username = username;
          token.p123_password = password;
        }
        const pan123Token = value('token');
        if (pan123Token) {
          token['123_token'] = pan123Token;
          token['123token'] = pan123Token;
          token.p123token = pan123Token;
        }
        break;
      }
    }
  }

  return token;
}
