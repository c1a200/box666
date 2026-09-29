// 源风险分级引擎

import type { TVBoxSite, CloudPlatform } from './types';

export type RiskLevel = 'safe' | 'low' | 'high' | 'unaudited';

export interface SourceRiskAssessment {
  siteKey: string;
  api: string;
  riskLevel: RiskLevel;
  reason: string;
  neededPlatforms: CloudPlatform[];
  thirdPartyDomains: string[];
}

// cookie 相关的 ext 字段名（各 Spider 约定）
const COOKIE_FIELD_NAMES = new Set([
  'cookie', 'cookies', 'token', 'refresh_token', 'open_token',
  'quark_cookie', 'quarkcookie', 'uccookie', 'uc_cookie',
  'tyitoken', 'tianyi_cookie', 'tianyicookie',
  'dutoken', 'baidu_cookie', 'baiducookie',
  'p123token', '123_token', '123token',
  'tuctoken', 'thunder_username', 'thunder_password', 'xunlei_username', 'xunlei_password',
  'p123_username', 'p123_password', 'tianyi_username', 'tianyi_password',
  'pikpak_username', 'pikpak_password',
  'bili_cookie', 'bilibili_cookie', 'ali_token',
  '115_cookie', '115cookie',
]);

// 官方网盘域名（B类源直连这些域名视为安全）
const OFFICIAL_DOMAINS = new Set([
  'www.alipan.com', 'api.alipan.com', 'open.alipan.com', 'aliyundrive.com',
  'api.bilibili.com', 'passport.bilibili.com',
  'drive.quark.cn', 'uop.quark.cn',
  'drive-pc.quark.cn', 'pc-api.uc.cn',
  'webapi.115.com', 'proapi.115.com', 'qrcodeapi.115.com',
  'cloud.189.cn', 'api.cloud.189.cn',
  'pan.baidu.com', 'openapi.baidu.com',
  'www.123pan.com', 'open-api.123pan.com',
]);

// 平台检测：从 ext 字段名推断需要哪些网盘平台
const FIELD_TO_PLATFORM: Record<string, CloudPlatform> = {
  'cookie': 'quark',         // 默认 cookie 字段通常是夸克（最常见）
  'quark_cookie': 'quark',
  'quarkcookie': 'quark',
  'uccookie': 'uc',
  'uc_cookie': 'uc',
  'bili_cookie': 'bilibili',
  'bilibili_cookie': 'bilibili',
  'ali_token': 'aliyun',
  'refresh_token': 'aliyun',
  'open_token': 'aliyun',
  'token': 'aliyun',
  'tyitoken': 'tianyi',
  'tianyi_cookie': 'tianyi',
  'tianyicookie': 'tianyi',
  'dutoken': 'baidu',
  'baidu_cookie': 'baidu',
  'baiducookie': 'baidu',
  'p123token': 'pan123',
  '123_token': 'pan123',
  '123token': 'pan123',
  'tuctoken': 'thunder',
  'thunder_username': 'thunder',
  'thunder_password': 'thunder',
  'xunlei_username': 'thunder',
  'xunlei_password': 'thunder',
  'p123_username': 'pan123',
  'p123_password': 'pan123',
  'tianyi_username': 'tianyi',
  'tianyi_password': 'tianyi',
  'pikpak_username': 'pikpak',
  'pikpak_password': 'pikpak',
  '115_cookie': 'pan115',
  '115cookie': 'pan115',
};

// 从 api class 推断需要的平台
const API_TO_PLATFORMS: Record<string, CloudPlatform[]> = {
  'csp_Bili': ['bilibili'],
  'csp_BiliR': ['bilibili'],
  'csp_Wobg': ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak', 'tianyi', 'baidu', 'pan123'],
  'csp_Wogg': ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak', 'tianyi', 'baidu', 'pan123'],
  'csp_Mogg': ['quark', 'aliyun', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder'],
  'csp_Pan115': ['pan115'],
  'csp_P123': ['pan123'],
  'csp_XunLei': ['thunder'],
};

const TOKEN_JSON_PLATFORMS: CloudPlatform[] = [
  'aliyun',
  'quark',
  'uc',
  'pan115',
  'thunder',
  'pikpak',
  'bilibili',
  'tianyi',
  'baidu',
  'pan123',
];

export const ALIST_PLATFORMS: CloudPlatform[] = [
  'aliyun', 'quark', 'uc', 'pan115', 'thunder',
  'pikpak', 'tianyi', 'baidu', 'pan123',
];

const API_PLATFORM_PATTERNS: Array<{ pattern: RegExp; platforms: CloudPlatform[]; tokenJson?: boolean }> = [
  { pattern: /^csp_Bili/i, platforms: ['bilibili'] },
  { pattern: /^csp_Wo[bg]g(?:Guard)?/i, platforms: ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak', 'tianyi', 'baidu', 'pan123'], tokenJson: true },
  { pattern: /^csp_Mogg/i, platforms: ['quark', 'aliyun', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder'] },
  { pattern: /^csp_Pan115/i, platforms: ['pan115'] },
  { pattern: /^csp_AList/i, platforms: ALIST_PLATFORMS },
  { pattern: /^csp_P123/i, platforms: ['pan123'] },
  { pattern: /^csp_XunLei(?!8)/i, platforms: ['thunder'] },
];

function getPlatformsFromApi(api: string): CloudPlatform[] | null {
  // csp_Xunlei8 stores a raw referer/base URL in ext; it does not consume
  // Thunder username/password credentials. Never classify it as a client-login source.
  if (isXunlei8Api(api)) return null;

  const exact = API_TO_PLATFORMS[api];
  if (exact) return exact;

  return API_PLATFORM_PATTERNS.find((item) => item.pattern.test(api))?.platforms || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseExtObject(ext: unknown): Record<string, unknown> | null {
  if (isRecord(ext)) return ext;
  if (typeof ext !== 'string' || !ext.trim()) return null;

  try {
    const parsed = JSON.parse(ext);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** csp_AweSomeGuard 只有在 ext.sp 为 AList 时才按 AList 凭证源处理。 */
export function isAweSomeGuardAList(site: TVBoxSite): boolean {
  if (!/^csp_AweSomeGuard/i.test(site.api)) return false;
  const ext = parseExtObject(site.ext);
  if (!ext) return false;
  return typeof ext.sp === 'string' && ext.sp.toLowerCase() === 'alist';
}

/** 判断源是否为 AList 或 AweSomeGuard(AList) 凭证源。 */
export function isAListSite(site: TVBoxSite): boolean {
  return /^csp_AList/i.test(site.api) || isAweSomeGuardAList(site);
}

/** csp_Xunlei8 的 ext 是 Referer/base URL，不是迅雷账号凭证。 */
export function isXunlei8Api(api: string): boolean {
  return /^csp_Xunlei8/i.test(api);
}

/** 是否为需要客户端登录网盘/执行 JAR 的已知客户端 API。 */
export function isClientCredentialApi(api: string): boolean {
  return getPlatformsFromApi(api) !== null || /^csp_AList/i.test(api);
}

/** 判断源是否需要下发客户端网盘凭证。 */
export function isClientCredentialSite(site: TVBoxSite): boolean {
  return isClientCredentialApi(site.api) || isAListSite(site);
}

/** 返回源所需的网盘平台；不发起任何网络请求。 */
export function getCredentialPlatformsForSite(site: TVBoxSite): CloudPlatform[] {
  return assessSourceRisk(site).neededPlatforms;
}

function isTokenJsonApi(api: string): boolean {
  return API_PLATFORM_PATTERNS.some((item) => item.tokenJson && item.pattern.test(api));
}

export function getDirectPlatformFromApi(api: string): CloudPlatform | null {
  if (/^csp_(AList|AweSomeGuard)/i.test(api)) return null;
  if (isXunlei8Api(api)) return null;

  const name = api.toLowerCase();
  if (name.includes('ali')) return 'aliyun';
  if (name.includes('quark')) return 'quark';
  if (name.includes('uc') || name.startsWith('csp_uc')) return 'uc';
  if (name.includes('pikpak')) return 'pikpak';
  if (name.includes('115')) return 'pan115';
  if (name.includes('baidu')) return 'baidu';
  if (name.includes('tianyi') || name.includes('189')) return 'tianyi';
  if (name.includes('123')) return 'pan123';
  if (name.includes('xunlei') || name.includes('thunder')) return 'thunder';
  return null;
}

/**
 * 分析单个源的风险等级（零网络请求）
 */
export function assessSourceRisk(site: TVBoxSite): SourceRiskAssessment {
  const result: SourceRiskAssessment = {
    siteKey: site.key,
    api: site.api,
    riskLevel: 'safe',
    reason: '',
    neededPlatforms: [],
    thirdPartyDomains: [],
  };

  const apiPlatforms = getPlatformsFromApi(site.api)
    || (isAListSite(site) ? ALIST_PLATFORMS : null);
  if (apiPlatforms) {
    result.neededPlatforms = [...apiPlatforms];
  }

  const ext = site.ext;
  if (!ext) {
    if (apiPlatforms) {
      result.riskLevel = isTokenJsonApi(site.api) ? 'low' : 'safe';
      result.reason = 'A class: known netdisk API with empty ext still needs credential injection';
      return result;
    }
    result.reason = 'A类: 无 ext 字段';
    return result;
  }

  // 检测 ext 中是否有 cookie/token 相关字段
  const { hasCookieFields, cookieFieldNames, thirdPartyDomains, isTokenJsonExt, proxyMode } = analyzeExt(ext, site.api);

  result.thirdPartyDomains = thirdPartyDomains;

  // 从 api class 推断需要的平台
  if (apiPlatforms) {
    result.neededPlatforms = [...apiPlatforms];
  } else {
    const directPlatform = getDirectPlatformFromApi(site.api);
    if (directPlatform) {
      result.neededPlatforms = [directPlatform];
    } else {
      // 从 ext 字段名推断
      const platforms = new Set<CloudPlatform>();
      for (const field of cookieFieldNames) {
        const p = FIELD_TO_PLATFORM[field.toLowerCase()];
        if (p) platforms.add(p);
      }
      result.neededPlatforms = [...platforms];
    }
  }

  // A类: ext 无 cookie 相关字段 → safe
  if (!hasCookieFields && !isTokenJsonExt && result.neededPlatforms.length === 0) {
    result.reason = 'A类: ext 无 cookie 相关字段';
    return result;
  }

  // token.json 派 → 检查 proxy 字段
  if (isTokenJsonExt) {
    if (result.neededPlatforms.length === 0) {
      result.neededPlatforms = [...TOKEN_JSON_PLATFORMS];
    }

    if (proxyMode === 'noproxy' || proxyMode === 'db') {
      result.riskLevel = 'low';
      result.reason = `D类: token.json + ${proxyMode}（不走代理）`;
    } else if (proxyMode === 'proxy') {
      result.riskLevel = 'high';
      result.reason = `D类: token.json + proxy（流量经第三方 ${thirdPartyDomains.join(', ')}）`;
    } else {
      result.riskLevel = 'unaudited';
      result.reason = `D类: token.json + proxy=${proxyMode || 'null'}（未审计）`;
    }
    return result;
  }

  // B类: ext 有 cookie 字段 + 无第三方域名 → safe
  if (hasCookieFields && thirdPartyDomains.length === 0) {
    result.riskLevel = 'safe';
    result.reason = 'B类: 有 cookie 字段，直连官方';
    return result;
  }

  // C类: ext 有 cookie + 有 site URL → low（网站 session）
  if (hasCookieFields && thirdPartyDomains.length > 0) {
    result.riskLevel = 'low';
    result.reason = `C类: 有 cookie + site URL（${thirdPartyDomains.join(', ')}）`;
    return result;
  }

  return result;
}

/**
 * 批量分析所有源
 */
export function assessAllSources(sites: TVBoxSite[]): SourceRiskAssessment[] {
  return sites.map(assessSourceRisk);
}

// ─── ext 字段解析 ────────────────────────────────────────

interface ExtAnalysis {
  hasCookieFields: boolean;
  cookieFieldNames: string[];
  thirdPartyDomains: string[];
  isTokenJsonExt: boolean;
  proxyMode: string | null;
}

function analyzeExt(ext: string | Record<string, unknown>, api: string): ExtAnalysis {
  const result: ExtAnalysis = {
    hasCookieFields: false,
    cookieFieldNames: [],
    thirdPartyDomains: [],
    isTokenJsonExt: false,
    proxyMode: null,
  };

  if (typeof ext === 'string') {
    return analyzeStringExt(ext, api);
  }

  // ext 是 JSON 对象
  for (const key of Object.keys(ext)) {
    const keyLower = key.toLowerCase();
    if (COOKIE_FIELD_NAMES.has(keyLower)) {
      result.hasCookieFields = true;
      result.cookieFieldNames.push(keyLower);
    }
  }

  // 检查对象中的 URL 值是否指向第三方
  for (const value of Object.values(ext)) {
    if (typeof value === 'string') {
      const domains = extractDomains(value);
      for (const d of domains) {
        if (!OFFICIAL_DOMAINS.has(d)) {
          result.thirdPartyDomains.push(d);
        }
      }
    }
  }

  return result;
}

function analyzeStringExt(ext: string, api: string): ExtAnalysis {
  const result: ExtAnalysis = {
    hasCookieFields: false,
    cookieFieldNames: [],
    thirdPartyDomains: [],
    isTokenJsonExt: false,
    proxyMode: null,
  };

  // 检查是否是 token.json $$$ 分隔格式
  // 格式: token.json_url$$$site_url$$$proxy$$$num$$$config
  if (ext.includes('token.json') || ext.includes('token_json')) {
    result.isTokenJsonExt = true;

    const segments = ext.split('$$$');
    // proxy 在第 3 段 (index 2)
    if (segments.length >= 3) {
      result.proxyMode = segments[2]?.trim() || null;
    }

    // site_url 在第 2 段 (index 1)
    if (segments.length >= 2) {
      const siteUrl = segments[1]?.trim();
      if (siteUrl) {
        const domains = extractDomains(siteUrl);
        result.thirdPartyDomains = domains;
      }
    }

    // token.json 派默认需要多个网盘
    result.hasCookieFields = true;
    return result;
  }

  // 尝试 JSON.parse
  try {
    const obj = JSON.parse(ext);
    if (typeof obj === 'object' && obj !== null) {
      return analyzeExt(obj, api);
    }
  } catch {
    // 非 JSON，按纯字符串处理
  }

  // 检查字符串中是否包含 cookie 相关关键词
  const lower = ext.toLowerCase();
  for (const field of COOKIE_FIELD_NAMES) {
    if (lower.includes(field)) {
      result.hasCookieFields = true;
      result.cookieFieldNames.push(field);
    }
  }

  // 提取 URL 中的域名
  const domains = extractDomains(ext);
  for (const d of domains) {
    if (!OFFICIAL_DOMAINS.has(d)) {
      result.thirdPartyDomains.push(d);
    }
  }

  return result;
}

function extractDomains(text: string): string[] {
  const urlRegex = /https?:\/\/([^/\s$]+)/g;
  const domains: string[] = [];
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const host = match[1].split(':')[0]; // 去掉端口
    if (host && !host.includes('localhost') && !host.startsWith('127.') && !host.startsWith('192.168.')) {
      domains.push(host);
    }
  }
  return [...new Set(domains)];
}
