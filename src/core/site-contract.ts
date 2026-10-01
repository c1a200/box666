import type { SiteContract, TVBoxConfig, TVBoxSite } from './types';

/** 本项目会按 ext 字段名注入，响应期历史清理可能移除这些字段。 */
const RESPONSE_INJECTABLE_EXT_KEYS = new Set([
  'cookie', 'quark_cookie', 'quarkCookie', 'uc_cookie', 'ucCookie', 'uccookie',
  '115_cookie', '115Cookie', 'tyitoken', 'tianyi_cookie', 'tianyiCookie',
  'dutoken', 'baidu_cookie', 'baiduCookie', 'p123token', '123_token', '123token',
  'tuctoken', 'thunder_token', 'bili_cookie', 'bilibili_cookie',
  'refresh_token', 'open_token', 'ali_token', 'token',
  'p123', 'xunlei', 'quark', 'uc', 'tianyi', 'baidu',
]);


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
export function buildSiteContract(site: Pick<TVBoxSite, 'api' | 'jar' | 'ext' | 'pan'>): SiteContract {
  const shape = extShape(site.ext);
  const contract: SiteContract = { api: site.api, extShape: shape };
  const jarMd5 = extractJarMd5(site.jar);
  if (jarMd5) contract.jarMd5 = jarMd5;
  if (shape === 'object') {
    contract.extKeys = Object.keys(site.ext as Record<string, unknown>).sort();
    // 记录可能由本项目注入的字段；响应期允许这些字段被历史清理移除。
    const injectable = contract.extKeys.filter((key) => RESPONSE_INJECTABLE_EXT_KEYS.has(key));
    if (injectable.length > 0) contract.injectableExtKeys = injectable;
  }
  if (typeof site.pan === 'string' && site.pan.trim()) contract.pan = site.pan.trim();
  const extPan = extPanValue(site.ext);
  if (extPan) contract.extPan = extPan;
  contract.contractHash = contractId(contract);
  return contract;
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

