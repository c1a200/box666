// Cookie 注入引擎

import type { TVBoxSite, CloudPlatform, CloudCredential, CredentialPolicyConfig } from './types';
import { assessSourceRisk, type RiskLevel } from './credential-risk';

// ─── 注入规则 ────────────────────────────────────────────

export interface InjectionRule {
  apiPattern: string | RegExp;
  platforms: CloudPlatform[];
  inject: (ext: any, credentials: Map<CloudPlatform, CloudCredential>, baseUrl?: string) => any;
}

/**
 * 解析 ext：string → 尝试 JSON.parse → 返回 object
 * 保留原始格式标记以便注入后恢复
 */
function parseExt(ext: any): { obj: Record<string, any>; wasString: boolean; wasJson: boolean } {
  if (typeof ext !== 'string') {
    return { obj: ext || {}, wasString: false, wasJson: false };
  }

  // 尝试 JSON.parse
  try {
    const parsed = JSON.parse(ext);
    if (typeof parsed === 'object' && parsed !== null) {
      return { obj: parsed, wasString: true, wasJson: true };
    }
  } catch {
    // 不是 JSON
  }

  // 无法解析为 object，返回空对象（调用方应直接操作 string）
  return { obj: {}, wasString: true, wasJson: false };
}

/** 恢复 ext 原始格式 */
function restoreExt(obj: Record<string, any>, wasString: boolean, wasJson: boolean): any {
  if (!wasString) return obj;
  if (wasJson) return JSON.stringify(obj);
  return obj;
}

function getCredValue(creds: Map<CloudPlatform, CloudCredential>, platform: CloudPlatform, field: string): string {
  return creds.get(platform)?.credential[field] || '';
}

const TOKEN_JSON_URL_RE = /(?:(?:https?|clan|sub):\/\/[^$\s"']*)?[^$\s"']*token[_.]?json[^$\s"']*/gi;

const PLATFORM_FIELD_MAP: Array<{ field: string; platform: CloudPlatform; credField: string }> = [
  { field: 'cookie', platform: 'quark', credField: 'cookie' },
  { field: 'quark_cookie', platform: 'quark', credField: 'cookie' },
  { field: 'quarkCookie', platform: 'quark', credField: 'cookie' },
  { field: 'uccookie', platform: 'uc', credField: 'cookie' },
  { field: 'uc_cookie', platform: 'uc', credField: 'cookie' },
  { field: 'tyitoken', platform: 'tianyi', credField: 'cookie' },
  { field: 'tianyi_cookie', platform: 'tianyi', credField: 'cookie' },
  { field: 'dutoken', platform: 'baidu', credField: 'cookie' },
  { field: 'baidu_cookie', platform: 'baidu', credField: 'cookie' },
  { field: 'p123token', platform: 'pan123', credField: 'token' },
  { field: '123_token', platform: 'pan123', credField: 'token' },
  { field: 'tuctoken', platform: 'thunder', credField: 'token' },
  { field: 'bili_cookie', platform: 'bilibili', credField: 'cookie' },
  { field: 'token', platform: 'aliyun', credField: 'refresh_token' },
  { field: 'refresh_token', platform: 'aliyun', credField: 'refresh_token' },
  { field: 'open_token', platform: 'aliyun', credField: 'open_token' },
  { field: 'ali_token', platform: 'aliyun', credField: 'refresh_token' },
  { field: '115_cookie', platform: 'pan115', credField: 'cookie' },
];

const MOGG_DEFAULT_FIELDS = [
  'cookie',
  'token',
  'uccookie',
  'tyitoken',
  'dutoken',
  'p123token',
  'tuctoken',
];

function hasCredentialForPlatforms(
  creds: Map<CloudPlatform, CloudCredential>,
  platforms: CloudPlatform[],
): boolean {
  return platforms.some((platform) => creds.has(platform));
}

function replaceTokenJsonUrl(ext: any, baseUrl: string = '__BASE_URL__'): { ext: any; changed: boolean } {
  if (!ext) {
    return { ext, changed: false };
  }

  if (typeof ext === 'string') {
    // 尝试解析 JSON 字符串以支持某些把 ext 配置写成 JSON 字符串的情况
    try {
      const parsed = JSON.parse(ext);
      if (typeof parsed === 'object' && parsed !== null) {
        const res = replaceTokenJsonUrl(parsed, baseUrl);
        return { ext: res.changed ? JSON.stringify(res.ext) : ext, changed: res.changed };
      }
    } catch {
      // 忽略，按普通字符串处理
    }

    if (TOKEN_JSON_URL_RE.test(ext)) {
      TOKEN_JSON_URL_RE.lastIndex = 0;
      const match = ext.match(TOKEN_JSON_URL_RE);
      if (match && match[0]) {
        const matchedUrl = match[0];
        const lowerUrl = matchedUrl.toLowerCase();
        if (lowerUrl.includes('clan://localhost') || 
            lowerUrl.includes('127.0.0.1:5678') || 
            lowerUrl.includes('localhost:5678')) {
          // 已经是本地 token.json 路径，不进行替换，以便让客户端通过内置的本地代理服务加载（配合 root-level 的 "token" 字段）
          TOKEN_JSON_URL_RE.lastIndex = 0;
          return { ext, changed: false };
        } else {
          // 如果是第三方的远程 token.json 链接，将其替换为本地路径，确保客户端拉取我们自托管的 token.json
          const next = ext.replace(TOKEN_JSON_URL_RE, 'clan://localhost/token.json');
          TOKEN_JSON_URL_RE.lastIndex = 0;
          return { ext: next, changed: next !== ext };
        }
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
        const res = replaceTokenJsonUrl(val, baseUrl);
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

function injectPlatformFields(
  ext: any,
  creds: Map<CloudPlatform, CloudCredential>,
  platforms: CloudPlatform[],
  addFields: string[] = [],
): { ext: any; changed: boolean } {
  const { obj, wasString, wasJson } = parseExt(ext);
  const allowed = new Set(platforms);
  let changed = false;

  for (const item of PLATFORM_FIELD_MAP) {
    if (!allowed.has(item.platform)) continue;
    const value = getCredValue(creds, item.platform, item.credField);
    if (!value) continue;

    if (Object.prototype.hasOwnProperty.call(obj, item.field) || addFields.includes(item.field)) {
      if (obj[item.field] !== value) {
        obj[item.field] = value;
        changed = true;
      }
    }
  }

  return { ext: changed ? restoreExt(obj, wasString, wasJson) : ext, changed };
}

// ─── 内置注入规则表 ─────────────────────────────────────

const BUILTIN_RULES: InjectionRule[] = [
  // csp_Bili / csp_BiliR: ext.cookie = bilibili cookie
  {
    apiPattern: /^csp_Bili/,
    platforms: ['bilibili'],
    inject: (ext, creds) => {
      const { obj, wasString, wasJson } = parseExt(ext);
      obj.cookie = getCredValue(creds, 'bilibili', 'cookie');
      return restoreExt(obj, wasString, wasJson);
    },
  },

  // csp_Wobg / csp_Wogg (token.json 派): 替换 token.json URL
  {
    apiPattern: /^csp_Wo[bg]g$/,
    platforms: ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak'],
    inject: (ext, creds, baseUrl?: string) => {
      return replaceTokenJsonUrl(ext, baseUrl || undefined).ext;
    },
  },

  // csp_Mogg: 多字段注入
  {
    apiPattern: 'csp_Mogg',
    platforms: ['quark', 'aliyun', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder'],
    inject: (ext, creds) => {
      return injectPlatformFields(ext, creds, ['quark', 'aliyun', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder'], MOGG_DEFAULT_FIELDS).ext;
    },
  },

  // csp_Pan115: ext.cookie = 115 cookie
  {
    apiPattern: 'csp_Pan115',
    platforms: ['pan115'],
    inject: (ext, creds) => {
      const { obj, wasString, wasJson } = parseExt(ext);
      obj.cookie = getCredValue(creds, 'pan115', 'cookie');
      return restoreExt(obj, wasString, wasJson);
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

    // 查找匹配的注入规则
    const rule = findMatchingRule(site);
    const platforms = rule?.platforms || risk.neededPlatforms;

    // 检查是否有该源需要的凭证
    const hasAnyCredential = hasCredentialForPlatforms(credentials, platforms);
    if (!hasAnyCredential) {
      report.skippedNoCredential++;
      return site;
    }

    // 先处理通用 token.json 派，再执行已知规则，最后兜底注入常见字段。
    let nextExt = site.ext;
    let changed = false;

    const tokenResult = replaceTokenJsonUrl(nextExt, baseUrl || undefined);
    nextExt = tokenResult.ext;
    changed = changed || tokenResult.changed;

    if (rule) {
      const ruleExt = rule.inject(nextExt, credentials, baseUrl);
      changed = changed || ruleExt !== nextExt;
      nextExt = ruleExt;
    }

    const fieldResult = injectPlatformFields(nextExt, credentials, platforms);
    nextExt = fieldResult.ext;
    changed = changed || fieldResult.changed;

    if (!changed) {
      report.skippedNoRule++;
      return site;
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
    if (!cred) continue;

    switch (platform) {
      case 'aliyun':
        if (cred.credential.refresh_token) {
          token.refresh_token = cred.credential.refresh_token;
          token.token = cred.credential.refresh_token;
          token.ali_token = cred.credential.refresh_token;
        }
        if (cred.credential.open_token) token.open_token = cred.credential.open_token;
        break;
      case 'quark':
        if (cred.credential.cookie) {
          token.quark_cookie = cred.credential.cookie;
          token.quarkCookie = cred.credential.cookie;
          token.cookie = cred.credential.cookie;
        }
        break;
      case 'uc':
        if (cred.credential.cookie) {
          token.uc_cookie = cred.credential.cookie;
          token.ucCookie = cred.credential.cookie;
          token.uccookie = cred.credential.cookie;
        }
        break;
      case 'pan115':
        if (cred.credential.cookie) {
          token['115_cookie'] = cred.credential.cookie;
          token['115Cookie'] = cred.credential.cookie;
        }
        break;
      case 'thunder':
        if (cred.credential.username) {
          token.thunder_username = cred.credential.username;
          token.thunder_password = cred.credential.password;
        }
        break;
      case 'pikpak':
        if (cred.credential.username) {
          token.pikpak_username = cred.credential.username;
          token.pikpak_password = cred.credential.password;
        }
        break;
      case 'bilibili':
        if (cred.credential.cookie) {
          token.bili_cookie = cred.credential.cookie;
          token.bilibili_cookie = cred.credential.cookie;
        }
        break;
      case 'tianyi':
        if (cred.credential.cookie) {
          token.tianyi_cookie = cred.credential.cookie;
          token.tianyiCookie = cred.credential.cookie;
          token.tyitoken = cred.credential.cookie;
        }
        break;
      case 'baidu':
        if (cred.credential.cookie) {
          token.baidu_cookie = cred.credential.cookie;
          token.baiduCookie = cred.credential.cookie;
          token.dutoken = cred.credential.cookie;
        }
        break;
      case 'pan123':
        if (cred.credential.token) {
          token['123_token'] = cred.credential.token;
          token['123token'] = cred.credential.token;
          token.p123token = cred.credential.token;
        }
        break;
    }
  }

  return token;
}
