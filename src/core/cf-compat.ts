import type { TVBoxConfig, TVBoxSite } from './types';

const DEPRECATED_WOGG_GUARD_JAR_MD5 = '2cc088afa757ba8bafffcfbab4b73ccc';
const WOGG_API = 'csp_Wogg';
const WOGG_JAR_URL =
  'https://ncstatic.clewm.net/rsrc/2026/0508/10/56d0b667615145949789418bff9f22a5.png;md5;B63A0EB8852BB7AB06500C424CCC3DAE';

type ExtRecord = Record<string, unknown>;

function parseExt(ext: TVBoxSite['ext']): { value: ExtRecord; wasString: boolean } | null {
  if (ext === undefined || ext === null) return { value: {}, wasString: false };
  if (typeof ext === 'string') {
    try {
      const parsed = JSON.parse(ext);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { value: parsed as ExtRecord, wasString: true };
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof ext === 'object' && !Array.isArray(ext)) {
    return { value: ext as ExtRecord, wasString: false };
  }
  return null;
}

function getExtSite(site: TVBoxSite): string | null {
  const parsed = parseExt(site.ext);
  if (!parsed) return null;
  const value = parsed.value.site;
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasDeprecatedJar(site: TVBoxSite): boolean {
  return typeof site.jar === 'string' && site.jar.includes(DEPRECATED_WOGG_GUARD_JAR_MD5);
}

/**
 * Cloudflare-only compatibility migration.
 *
 * The upstream `csp_WoGGGuard` spider at the old JAR hash does not implement the
 * project's Pan.init credential protocol, so clients still show a QR login for
 * Quark.  The sibling `csp_Wogg` spider uses the same upstream and does honor
 * `ext.quark` / `ext.uc` / `ext.baidu`.  Keep this migration in the CF path
 * only; Render deployments have their own independently configured sources.
 */
export function applyCloudflareCompatibility(config: TVBoxConfig): boolean {
  const sites = config.sites;
  if (!Array.isArray(sites)) return false;

  const target = sites.find(
    (site) =>
      site.key === '玩偶' &&
      site.api === 'csp_WoGGGuard' &&
      hasDeprecatedJar(site),
  );
  if (!target) return false;

  const woggDonor =
    sites.find((site) => site.key === 'wogg' && site.api === WOGG_API && getExtSite(site)) ??
    sites.find((site) => site.api === WOGG_API && getExtSite(site));
  if (!woggDonor) return false;

  const donorSite = getExtSite(woggDonor);
  const targetExt = parseExt(target.ext);
  if (!donorSite || !targetExt) return false;

  const nextExt: ExtRecord = { ...targetExt.value };
  if (typeof nextExt.site !== 'string' || !nextExt.site.trim()) {
    nextExt.site = donorSite;
  }

  target.api = WOGG_API;
  target.jar = WOGG_JAR_URL;
  target.ext = targetExt.wasString ? JSON.stringify(nextExt) : nextExt;
  return true;
}
