import type { SiteContract, TVBoxConfig, TVBoxSite } from './types';
import type { CredentialProtocol } from './credential-protocol';
import { resolveCredentialProtocol } from './credential-protocol';
import type { Storage } from '../storage/interface';
import { KV_SITE_CONTRACT_MAP } from './config';

/** 本项目会按 ext 字段名注入，响应期历史清理可能移除这些字段。 */
const RESPONSE_INJECTABLE_EXT_KEYS = new Set([
  'cookie', 'quark_cookie', 'quarkCookie', 'uc_cookie', 'ucCookie', 'uccookie',
  '115_cookie', '115Cookie', 'tyitoken', 'tianyi_cookie', 'tianyiCookie',
  'dutoken', 'baidu_cookie', 'baiduCookie', 'p123token', '123_token', '123token',
  'tuctoken', 'thunder_token', 'bili_cookie', 'bilibili_cookie',
  'refresh_token', 'open_token', 'ali_token', 'token',
  'p123', 'xunlei', 'quark', 'uc', 'tianyi', 'baidu',
]);

/** 上游抢占字段：响应期被项目协议清理后允许从契约字段集合中消失。 */
const RESPONSE_REMOVABLE_CONFLICT_EXT_KEYS = new Set([
  'cloud-drive', 'clouddrive', 'ali-drive', 'alidrive',
]);

function normalizeCredentialConflictKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

/** 从改写前后的 JAR URL 中提取 JAR 内容 MD5。 */
export function extractJarMd5(jar?: string): string | undefined {
  if (!jar) return undefined;
  const match = jar.match(/;md5;([a-fA-F0-9]{32})(?:;|$)/);
  return match ? match[1].toLowerCase() : undefined;
}

function extShape(ext: TVBoxSite['ext']): SiteContract['extShape'] {
  if (ext === null) return 'null';
  if (ext === undefined) return 'undefined';
  if (typeof ext === 'string') return 'string';
  if (Array.isArray(ext)) return 'array';
  if (typeof ext === 'object') return 'object';
  return 'other';
}

function extPanValue(ext: TVBoxSite['ext']): string | undefined {
  let parsed: unknown = ext;
  if (typeof ext === 'string') {
    try { parsed = JSON.parse(ext); } catch { return undefined; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = (parsed as Record<string, unknown>).pan;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

/** 提取站点的稳定契约指纹。只描述协议输入形态，不做任何猜测。 */
export function buildSiteContract(
  site: Pick<TVBoxSite, 'api' | 'jar' | 'ext' | 'pan'>,
  /** 站点自身 jar 为空时的实际生效 JAR（通常是顶层 spider）。 */
  fallbackJar?: string,
): SiteContract {
  // JSON.stringify 会把对象里值为 undefined 的 ext 丢掉；同一站点从聚合对象
  // 变成下发 JSON 时，undefined 会自然变成 null。两者都没有可注入的 ext 内容，
  // 因此必须视为同一契约，否则合法站点会被误判为契约漂移。
  const shape = site.ext == null ? 'null' : extShape(site.ext);
  const contract: SiteContract = { api: site.api, extShape: shape };
  const jarMd5 = extractJarMd5(site.jar) ? extractJarMd5(site.jar) : extractJarMd5(fallbackJar);
  if (jarMd5) contract.jarMd5 = jarMd5;
  if (shape === 'object') {
    contract.extKeys = Object.keys(site.ext as Record<string, unknown>).sort();
    // 记录可能由本项目注入的字段；响应期允许这些字段被历史清理移除。
    const removable = contract.extKeys.filter((key) =>
      RESPONSE_INJECTABLE_EXT_KEYS.has(key) || RESPONSE_REMOVABLE_CONFLICT_EXT_KEYS.has(normalizeCredentialConflictKey(key)),
    );
    if (removable.length > 0) contract.injectableExtKeys = removable;
  }
  if (typeof site.pan === 'string' && site.pan.trim()) contract.pan = site.pan.trim();
  const extPan = extPanValue(site.ext);
  if (extPan) contract.extPan = extPan;
  contract.contractHash = contractId(contract);
  return contract;
}

/** 将已验证的凭证绑定写入基础契约；binding 不参与 contractId 的 ext 语义计算。 */
export function withCredentialBinding(
  contract: SiteContract,
  protocol: Pick<CredentialProtocol, 'mechanism' | 'platforms'>,
): SiteContract {
  const platforms = [...new Set(protocol.platforms)].filter(Boolean);
  return {
    ...contract,
    credentialMechanism: protocol.mechanism,
    credentialPlatforms:
      protocol.mechanism === 'none' || protocol.mechanism === 'unknown' || platforms.length === 0
        ? []
        : platforms,
    contractHash: contractId(contract),
  };
}
/**
 * 凭证源实例身份。
 *
 * 身份同时包含总源边界、JAR/API、ext 基础契约和凭证绑定。不同总源贡献的
 * 同名/同接口源必须保留为独立实例；否则响应期只能按 key 命中其中一条契约，
 * 会出现“一个源能播、另一个仍要扫码”的串用问题。
 */
export function credentialSiteInstanceId(
  site: Pick<TVBoxSite, 'key' | 'api' | 'jar' | 'ext' | 'pan'> & {
    __upstreamNames?: string[];
    credentialMechanism?: string;
    credentialPlatforms?: string[];
  },
  fallbackJar?: string,
): string {
  const contract = buildSiteContract(site, fallbackJar);
  const upstreams = [...new Set(site.__upstreamNames || [])].filter(Boolean).sort();
  return [
    `key:${site.key}`,
    `up:${upstreams.join(',')}`,
    contractId(contract),
    `mech:${site.credentialMechanism || ''}`,
    `platforms:${[...new Set(site.credentialPlatforms || [])].sort().join(',')}`,
  ].join('|');
}

/** 为凭证源生成稳定、可读且不会和现有 key 冲突的实例 key。 */
export function credentialSiteInstanceKey(
  site: Pick<TVBoxSite, 'key' | 'api' | 'jar' | 'ext' | 'pan'> & {
    __upstreamNames?: string[];
    credentialMechanism?: string;
    credentialPlatforms?: string[];
  },
  fallbackJar?: string,
): string {
  return `${site.key}__${stableHash(credentialSiteInstanceId(site, fallbackJar))}`;
}

/**
 * 用最终配置的站点集合和顶层 spider 构建实例契约表。
 * 聚合质量分级、预检、响应下发必须共用这一个构造入口。
 */
export function buildSiteContractMap(
  sites: TVBoxSite[],
  globalSpider?: string,
  upstreamsByKey?: Map<string, string[]>,
): Record<string, SiteContract> {
  const contracts: Record<string, SiteContract> = {};
  for (const site of sites) {
    if (!site?.key) continue;
    const contract = buildSiteContract(site, globalSpider);
    contract.siteKey = site.key;
    const upstreams = upstreamsByKey?.get(site.key) || site.__upstreamNames || [];
    contract.upstreamNames = [...new Set(upstreams)].filter(Boolean).sort();
    contracts[site.key] = withCredentialBinding(
      contract,
      resolveCredentialProtocol(site, { effectiveJar: globalSpider }),
    );
  }
  return contracts;
}

/** 读取聚合阶段保存的源实例契约；损坏或缺失时返回空 Map，让严格模式拒绝注入。 */
export async function loadSiteContractMap(storage: Storage): Promise<Map<string, SiteContract>> {
  const raw = await storage.get(KV_SITE_CONTRACT_MAP);
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as { sites?: Record<string, SiteContract> };
    if (!parsed || typeof parsed !== 'object' || !parsed.sites || typeof parsed.sites !== 'object') return new Map();
    return new Map(Object.entries(parsed.sites).filter(([, value]) => !!value && typeof value === 'object'));
  } catch {
    return new Map();
  }
}

export function contractId(contract: SiteContract): string {
  return [
    contract.jarMd5 || 'jar:none',
    contract.api,
    contract.extShape,
    contract.extKeys?.join(',') || '',
    contract.pan || '',
    contract.extPan || '',
  ].join('|');
}


/** 删除只应在聚合进程内存在的字段；不会改动原始对象。 */
export function stripInternalSiteMarkers<T extends TVBoxConfig>(config: T): T {
  const clone = JSON.parse(JSON.stringify(config)) as T;
  for (const site of clone.sites || []) {
    delete site.__upstreamNames;
  }
  return clone;
}
