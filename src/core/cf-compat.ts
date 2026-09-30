import type { TVBoxConfig, TVBoxSite } from './types';

const DEPRECATED_WOGG_GUARD_JAR_MD5 = '2cc088afa757ba8bafffcfbab4b73ccc';
const HARDENED_WOGG_FISHGUARD_JAR_MD5 = '835b242eab0da4d3402724dd4705a9e8';
const WOGG_JAR_MD5 = 'b63a0eb8852bb7ab06500c424ccc3dae';
const WOGG_API = 'csp_Wogg';
const MIGRATED_WOGG_KEY = 'Wogg_FishGuard_v2';
const MIGRATED_WOGG_NAME = '👽️┆玩偶┆4K 「摸鱼儿」';
const WOGG_JAR_URL =
  'https://ncstatic.clewm.net/rsrc/2026/0508/10/56d0b667615145949789418bff9f22a5.png;md5;B63A0EB8852BB7AB06500C424CCC3DAE';

const LEGACY_WOGG_GUARD_API = 'csp_woggguard';
type ExtRecord = Record<string, unknown>;

function parseExt(ext: TVBoxSite['ext']): { value: ExtRecord; wasString: boolean } | null {
  if (ext === undefined || ext === null) return { value: {}, wasString: false };
  if (typeof ext === 'string') {
    const trimmed = ext.trim();
    if (!trimmed) return { value: {}, wasString: false };
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { value: parsed as ExtRecord, wasString: true };
      }
    } catch {
      // Legacy Wogg/WoggGuard entries may point directly at token.json.
      // Preserve the URL while the credential injector replaces it with Pan.init URLs.
      return { value: { token: trimmed }, wasString: false };
    }
    return null;
  }
  if (typeof ext === 'object' && !Array.isArray(ext)) {
    return { value: ext as ExtRecord, wasString: false };
  }
  return null;
}

function normalizeExtSite(value: unknown): string | null {
  if (typeof value === 'string') {
    const site = value.trim();
    return site || null;
  }
  if (!Array.isArray(value)) return null;
  const sites = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return sites.length > 0 ? sites.join(',') : null;
}

function getExtSite(site: TVBoxSite): string | null {
  const parsed = parseExt(site.ext);
  if (!parsed) return null;
  return normalizeExtSite(parsed.value.site);
}

function getJarMd5(site: TVBoxSite): string | null {
  if (typeof site.jar !== 'string') return null;
  const marker = ';md5;';
  const index = site.jar.toLowerCase().indexOf(marker);
  if (index === -1) return null;
  const md5 = site.jar.slice(index + marker.length).split(';', 1)[0].trim().toLowerCase();
  return md5 || null;
}

function hasJarMd5(site: TVBoxSite, expected: string): boolean {
  return getJarMd5(site) === expected;
}

function isLegacyWoggGuard(site: TVBoxSite): boolean {
  if (!site.key.startsWith('玩偶') || !site.api) return false;
  if (site.api.toLowerCase() !== LEGACY_WOGG_GUARD_API) return false;
  const md5 = getJarMd5(site);
  return md5 === DEPRECATED_WOGG_GUARD_JAR_MD5 || !site.jar?.trim();
}

function isHardenedWoggVariant(site: TVBoxSite): boolean {
  return site.key === 'Wogg' && hasJarMd5(site, HARDENED_WOGG_FISHGUARD_JAR_MD5);
}

/**
 * The old `Wogg` key persisted in TVBox clients after its JAR was replaced.
 * Some clients cache the spider by key and keep executing the previous
 * FishGuard JAR, which ignores Pan.init credential URLs. A stable versioned
 * key forces just this source to be loaded as a new entry.
 */
function isCurrentWoggNeedingKeyMigration(site: TVBoxSite): boolean {
  return site.key === 'Wogg'
    && site.name === MIGRATED_WOGG_NAME
    && hasWoggApi(site)
    && (hasJarMd5(site, HARDENED_WOGG_FISHGUARD_JAR_MD5) || hasJarMd5(site, WOGG_JAR_MD5));
}

function hasWoggApi(site: TVBoxSite): boolean {
  return !!site.api && site.api.toLowerCase() === WOGG_API.toLowerCase();
}

/**
 * Migrate legacy WoGGGuard and the hardened FishGuard Wogg variant to the
 * sibling csp_Wogg spider, which implements Pan.init and therefore consumes
 * the project's /credential/* endpoints. The hardened variant is matched by
 * key+JAR fingerprint only, so other sources sharing that JAR are untouched.
 */
export function applyLegacyWoggCompatibility(config: TVBoxConfig): boolean {
  const sites = config.sites;
  if (!Array.isArray(sites)) return false;

  const legacyTargets = sites.filter(isLegacyWoggGuard);
  const hardenedTargets = sites.filter(isHardenedWoggVariant);
  const keyTargets = sites.filter(
    (site) => isCurrentWoggNeedingKeyMigration(site) && !hardenedTargets.includes(site),
  );
  if (legacyTargets.length === 0 && hardenedTargets.length === 0 && keyTargets.length === 0) return false;

  const woggDonor =
    sites.find((site) =>
      site.key === 'wogg' &&
      hasWoggApi(site) &&
      getExtSite(site) &&
      (hasJarMd5(site, WOGG_JAR_MD5) || !site.jar?.trim()),
    ) ??
    sites.find((site) =>
      hasWoggApi(site) &&
      getExtSite(site) &&
      hasJarMd5(site, WOGG_JAR_MD5),
    ) ??
    sites.find((site) => hasWoggApi(site) && getExtSite(site));
  if (!woggDonor) return false;

  const donorSite = getExtSite(woggDonor);
  if (!donorSite) return false;

  const donorJar = hasJarMd5(woggDonor, WOGG_JAR_MD5) ? woggDonor.jar! : WOGG_JAR_URL;
  let changed = false;

  for (const target of [...legacyTargets, ...hardenedTargets, ...keyTargets]) {
    const migrateKey = isCurrentWoggNeedingKeyMigration(target);
    const targetExt = parseExt(target.ext);
    if (!targetExt) continue;

    const nextExt: ExtRecord = { ...targetExt.value };
    const targetSite = normalizeExtSite(nextExt.site);
    if (!targetSite) {
      nextExt.site = donorSite;
    } else if (targetSite !== nextExt.site) {
      nextExt.site = targetSite;
    }

    target.api = WOGG_API;
    target.jar = donorJar;
    target.ext = targetExt.wasString ? JSON.stringify(nextExt) : nextExt;
    if (migrateKey) {
      target.key = MIGRATED_WOGG_KEY;
    }
    changed = true;
  }

  return changed;
}

/** Backward-compatible alias for existing callers. */
export const applyCloudflareCompatibility = applyLegacyWoggCompatibility;
