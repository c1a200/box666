import type { TVBoxConfig, CloudPlatform, CloudCredential, TVBoxSite } from './types';
import { resolveCredentialProtocol } from './credential-protocol';
import { extractJarMd5 } from './site-contract';

/**
 * 已确认会被 Pan.init/搜索协议消费的上游“抢占登录入口”。
 * 这些键的值通常是远端登录脚本，JAR 若先看到它们就不会走项目凭证。
 *
 * 注意：quark/uc/baidu/... 既是平台名，也是合法初始化 URL 的字段名，
 * 绝不能按字段名删除；只删除协议已识别且本次确实可能抢占的入口。
 */
const UPSTREAM_CREDENTIAL_CONFLICT_FIELDS = new Set<string>([
  'cloud-drive',
  'clouddrive',
  'ali-drive',
  'alidrive',
]);
function isProjectCredentialUrl(value: unknown, baseUrl: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) return false;
    const path = parsed.pathname.replace(/\/+$/, '');
    return /^(?:\/auth\/[^/]+)?\/(?:credential\/[A-Za-z0-9_.-]+|token\.json|tvfan\/config)$/.test(path);
  } catch {
    return false;
  }
}

function isAListProxyUrl(value: unknown, baseUrl: string): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) return null;
    if (!parsed.pathname.replace(/\/+$/, '').endsWith('/credential/alist')) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function collectCredentialSecrets(
  credentials: Map<CloudPlatform, CloudCredential>,
): Set<string> {
  const secrets = new Set<string>();
  for (const credential of credentials.values()) {
    for (const value of Object.values(credential.credential || {})) {
      if (typeof value === 'string' && value.trim()) secrets.add(value.trim());
    }
  }
  return secrets;
}

function cleanStringValue(
  value: string,
  baseUrl: string,
  secrets: Set<string>,
  allowedSecrets: Set<string>,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return value;

  const alist = isAListProxyUrl(trimmed, baseUrl);
  if (alist) {
    const source = alist.searchParams.get('src');
    if (source) return source;
  }

  if (isProjectCredentialUrl(trimmed, baseUrl)) return null;
  // 只删除可确认由本项目生成/注入的精确值。字段名不能作为删除依据：
  // 上游自带 cookie、quark、uc、baidu、Cloud-drive 等也必须原样保留。
  if (secrets.has(trimmed) && !allowedSecrets.has(trimmed)) return null;
  return value;
}

function cleanCredentialNode(
  node: any,
  baseUrl: string,
  secrets: Set<string>,
  allowedSecrets: Set<string>,
  parentKey = '',
): { value: any; changed: boolean } {
  if (Array.isArray(node)) {
    let changed = false;
    const values = node.map((item) => {
      const result = cleanCredentialNode(item, baseUrl, secrets, allowedSecrets, parentKey);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: changed ? values : node, changed };
  }

  if (!node || typeof node !== 'object') {
    if (typeof node === 'string') {
      const cleaned = cleanStringValue(node, baseUrl, secrets, allowedSecrets);
      if (cleaned !== node) return { value: cleaned, changed: true };
    }
    return { value: node, changed: false };
  }

  const next: Record<string, any> = { ...node };
  let changed = false;

  for (const [key, rawValue] of Object.entries(node)) {
    const lowerKey = key.toLowerCase();

    if (typeof rawValue === 'string') {
      const isProjectUrl = isProjectCredentialUrl(rawValue, baseUrl) || !!isAListProxyUrl(rawValue, baseUrl);
      // 无论字段名是什么，只处理字符串值本身。字段名不能决定是否删除，
      // 否则上游自带 quark/uc/baidu/cookie 会被 none 误删。
      if (isProjectUrl || secrets.size > 0 || lowerKey === 'ext' || lowerKey === 'extend') {
        const cleaned = cleanStringValue(rawValue, baseUrl, secrets, allowedSecrets);
        if (cleaned === null) {
          delete next[key];
          changed = true;
          continue;
        }
        if (cleaned !== rawValue) {
          next[key] = cleaned;
          changed = true;
        }
        if (lowerKey === 'ext' || lowerKey === 'extend') {
          const parsedText = rawValue.trim();
          if (parsedText.startsWith('{') || parsedText.startsWith('[')) {
            try {
              const parsed = JSON.parse(parsedText);
              const result = cleanCredentialNode(parsed, baseUrl, secrets, allowedSecrets, lowerKey);
              if (result.changed) {
                next[key] = JSON.stringify(result.value);
                changed = true;
              }
            } catch {
              // Keep non-JSON strings untouched.
            }
          }
        }
      }
      continue;
    }

    const result = cleanCredentialNode(rawValue, baseUrl, secrets, allowedSecrets, key);
    if (result.changed) {
      next[key] = result.value;
      changed = true;
    }
  }

  return { value: changed ? next : node, changed };
}

function parseExtRecord(ext: unknown): Record<string, any> | null {
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    return ext as Record<string, any>;
  }
  if (typeof ext !== 'string' || !ext.trim()) return null;
  try {
    const parsed = JSON.parse(ext);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

function normalizeCredentialConflictKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function stripKnownConflictFieldsFromExt(ext: unknown): unknown {
  const parsed = parseExtRecord(ext);
  if (!parsed) return ext;
  let changed = false;
  const next = { ...parsed };
  for (const key of Object.keys(next)) {
    if (UPSTREAM_CREDENTIAL_CONFLICT_FIELDS.has(normalizeCredentialConflictKey(key))) {
      delete next[key];
      changed = true;
    }
  }
  return changed
    ? (typeof ext === 'string' ? JSON.stringify(next) : next)
    : ext;
}

/**
 * 移除“已识别凭证协议”的上游抢占登录入口。
 *
 * 只处理能确认会消费凭证的站点；unknown/none 协议一律原样保留，避免
 * 误删 quark/uc/baidu 等同时可能是上游初始化 URL 的合法字段。
 */
export function stripUpstreamCredentialEntries(
  config: TVBoxConfig | any,
  effectiveJar?: string,
  force = false,
): any {
  if (!config || typeof config !== 'object') return config;

  const cleanSite = (site: any): any => {
    if (!site || typeof site !== 'object' || Array.isArray(site)) return site;
    const siteJar = typeof site.jar === 'string' ? site.jar : undefined;
    const jar = extractJarMd5(siteJar) ? siteJar : effectiveJar;
    const protocol = resolveCredentialProtocol(site as TVBoxSite, { effectiveJar: jar });
    // force 用于 none 策略：Cloud-drive/Ali-drive 是明确的远端登录入口，
    // 即使当前 JAR 尚未归入已知协议族，也必须阻断，不能依赖协议识别。
    if (!force && (!protocol.credentialRequired || !protocol.canInject)) return site;
    const ext = stripKnownConflictFieldsFromExt(site.ext);
    return ext === site.ext ? site : { ...site, ext };
  };

  const walk = (node: any): any => {
    if (Array.isArray(node)) {
      let changed = false;
      const values = node.map((item) => {
        const cleaned = walk(item);
        if (cleaned !== item) changed = true;
        return cleaned;
      });
      return changed ? values : node;
    }
    if (!node || typeof node !== 'object') return node;

    // sites 是 TVBox 配置中唯一的站点集合；不要递归进任意对象，
    // 以免把 JAR/AList 配置里的同名字段当作源 ext 处理。
    if (Array.isArray(node.sites)) {
      const sites = node.sites.map(cleanSite);
      return sites.some((site: any, index: number) => site !== node.sites[index])
        ? { ...node, sites }
        : node;
    }
    return node;
  };

  return walk(config);
}
export function stripInjectedCredentialsFromConfig(
  config: TVBoxConfig | any,
  baseUrl: string,
  allCredentials: Map<CloudPlatform, CloudCredential> = new Map(),
  allowedSecrets: Set<string> = new Set(),
): any {
  if (!config || typeof config !== 'object') return config;
  const secrets = collectCredentialSecrets(allCredentials);
  return cleanCredentialNode(config, baseUrl, secrets, allowedSecrets).value;
}
