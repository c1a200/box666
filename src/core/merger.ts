// 站点级合并引擎

import type { TVBoxConfig, TVBoxSite, SourcedConfig } from './types';
import { normalizeConfig, extractSpiderJarUrl } from './parser';
import {
  deduplicateSites,
  deduplicateParses,
  deduplicateLives,
  deduplicateDoh,
  mergeRules,
  deduplicateHosts,
  deduplicateStrings,
} from './dedup';

/**
 * 将多个 TVBox 配置合并成一个
 * 核心逻辑：
 * 1. 规范化所有配置（相对路径转绝对、默认值填充）
 * 2. Spider JAR 智能分配（全局 + per-site）
 * 3. 各字段去重合并
 */
export interface MergeResult {
  config: TVBoxConfig;
  siteSourceMap: Map<string, string>;   // site.key → sourceName
  siteUpstreamMap: Map<string, string[]>; // site.key → 顶层总源名（可能多个）
  parseSourceMap: Map<string, string>;  // parse.url → sourceName
  liveSourceMap: Map<string, string>;   // (live.url || live.api) → sourceName
}

function stableExtKey(ext: TVBoxSite['ext']): string {
  if (ext == null) return '';
  if (typeof ext !== 'object') return JSON.stringify(ext);
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sort(child)]),
    );
  };
  return JSON.stringify(sort(ext));
}

function siteMergeKey(site: TVBoxSite, effectiveJar?: string): string {
  return [
    site.key,
    site.type,
    site.api,
    effectiveJar || site.jar || '',
    stableExtKey(site.ext),
    site.pan || '',
  ].join('|');
}

export function mergeConfigs(sourcedConfigs: SourcedConfig[]): MergeResult {
  // Step 1: 规范化所有配置
  const normalized = sourcedConfigs.map(normalizeConfig);
  const siteSourceMap = new Map<string, string>();
  const siteUpstreamMap = new Map<string, string[]>();
  const parseSourceMap = new Map<string, string>();
  const liveSourceMap = new Map<string, string>();

  // Step 2: 确定全局 spider（投票制：选引用最多 type:3 站点的 JAR）
  const globalSpider = selectGlobalSpider(normalized);
  const globalSpiderFull = globalSpider ? findFullSpiderString(normalized, globalSpider) : null;

  // Step 3: 收集站点并记录每个实例实际生效的 JAR。
  const allSites: TVBoxSite[] = [];
  const effectiveJarByObject = new WeakMap<TVBoxSite, string | undefined>();
  const allParses: TVBoxConfig['parses'] = [];
  const allLives: TVBoxConfig['lives'] = [];
  const allHosts: string[] = [];
  const allRules: TVBoxConfig['rules'] = [];
  const allDoh: TVBoxConfig['doh'] = [];
  const allAds: string[] = [];
  const allFlags: string[] = [];

  for (const sourced of normalized) {
    const config = sourced.config;
    const sourceSpider = config.spider;
    const sourceSpiderJar = extractSpiderJarUrl(sourceSpider);
    const upstreams = sourced.upstreamNames?.length ? sourced.upstreamNames : [sourced.sourceName];
    const upstreamList = [...new Set(upstreams)].filter(Boolean).sort();

    if (config.sites) {
      for (const site of config.sites) {
        const siteCopy = { ...site };
        if (
          site.type === 3
          && !site.jar
          && sourceSpiderJar
          && sourceSpiderJar !== globalSpider
        ) {
          siteCopy.jar = sourceSpider;
        }

        const effectiveJar = siteCopy.jar || sourceSpider || globalSpiderFull || globalSpider || undefined;
        siteCopy.__upstreamNames = upstreamList;
        effectiveJarByObject.set(siteCopy, effectiveJar);
        allSites.push(siteCopy);
      }
    }

    if (config.parses) {
      for (const p of config.parses) {
        if (p.url && !parseSourceMap.has(p.url)) parseSourceMap.set(p.url, sourced.sourceName);
      }
      allParses.push(...config.parses);
    }
    if (config.lives) {
      for (const l of config.lives) {
        const liveId = l.url || l.api || '';
        if (liveId && !liveSourceMap.has(liveId)) liveSourceMap.set(liveId, sourced.sourceName);
      }
      allLives.push(...config.lives);
    }
    if (config.hosts) allHosts.push(...config.hosts);
    if (config.rules) allRules.push(...config.rules);
    if (config.doh) allDoh.push(...config.doh);
    if (config.ads) allAds.push(...config.ads);
    if (config.flags) allFlags.push(...config.flags);
  }

  // Step 4: 相同子源跨上游只保留一份；接口/JAR/ext/pan 任一不同都保留。
  const mergedByKey = new Map<string, TVBoxSite>();
  const upstreamsByMergeKey = new Map<string, Set<string>>();
  const sourceByMergeKey = new Map<string, string>();
  for (const site of allSites) {
    const key = siteMergeKey(site, effectiveJarByObject.get(site));
    const upstreams = new Set(site.__upstreamNames || []);
    const existing = mergedByKey.get(key);
    if (existing) {
      const merged = upstreamsByMergeKey.get(key) || new Set<string>();
      for (const upstream of upstreams) merged.add(upstream);
      upstreamsByMergeKey.set(key, merged);
      existing.__upstreamNames = [...merged].sort();
      continue;
    }
    mergedByKey.set(key, site);
    upstreamsByMergeKey.set(key, upstreams);
    sourceByMergeKey.set(key, site.__upstreamNames?.[0] || '');
  }

  const collectedSites = [...mergedByKey.entries()].map(([key, site]) => {
    const upstreams = [...(upstreamsByMergeKey.get(key) || [])].filter(Boolean).sort();
    if (upstreams.length > 0) site.__upstreamNames = upstreams;
    return site;
  });

  // deduplicateSites 仅处理 key 冲突，不改变上面的实例边界。
  const dedupedSites = deduplicateSites(collectedSites, (site) => siteMergeKey(site, effectiveJarByObject.get(site)));
  for (const site of dedupedSites) {
    const key = [...mergedByKey.entries()].find(([, value]) => value === site)?.[0];
    const upstreams = key ? [...(upstreamsByMergeKey.get(key) || [])].filter(Boolean).sort() : site.__upstreamNames || [];
    const source = key ? sourceByMergeKey.get(key) : undefined;
    if (source) siteSourceMap.set(site.key, source);
    if (upstreams.length > 0) {
      siteUpstreamMap.set(site.key, upstreams);
      site.__upstreamNames = upstreams;
    }
  }

  const merged: TVBoxConfig = {
    sites: dedupedSites,
    parses: deduplicateParses(allParses || []),
    lives: deduplicateLives(allLives || []),
    hosts: deduplicateHosts(allHosts),
    rules: mergeRules(allRules || []),
    doh: deduplicateDoh(allDoh || []),
    ads: deduplicateStrings(allAds),
    flags: deduplicateStrings(allFlags),
  };

  if (globalSpider) merged.spider = globalSpiderFull || globalSpider;

  console.log(
    `[merger] Merged: ${merged.sites?.length} sites, ` +
      `${merged.parses?.length} parses, ${merged.lives?.length} lives`,
  );

  return { config: merged, siteSourceMap, siteUpstreamMap, parseSourceMap, liveSourceMap };
}

/**
 * 选择全局 spider JAR
 * 统计每个 JAR URL 被多少个 type:3 站点引用，选引用最多的
 */
function selectGlobalSpider(configs: SourcedConfig[]): string | null {
  const jarCounts = new Map<string, number>();
  for (const sourced of configs) {
    const spiderJar = extractSpiderJarUrl(sourced.config.spider);
    if (!spiderJar) continue;
    const type3Count = (sourced.config.sites || []).filter((s) => s.type === 3 && !s.jar).length;
    if (type3Count > 0) jarCounts.set(spiderJar, (jarCounts.get(spiderJar) || 0) + type3Count);
  }
  if (jarCounts.size === 0) return null;
  let maxJar: string | null = null;
  let maxCount = 0;
  for (const [jar, count] of jarCounts) {
    if (count > maxCount) { maxCount = count; maxJar = jar; }
  }
  return maxJar;
}

function findFullSpiderString(configs: SourcedConfig[], jarUrl: string): string | null {
  for (const sourced of configs) {
    const extracted = extractSpiderJarUrl(sourced.config.spider);
    if (extracted === jarUrl && sourced.config.spider) return sourced.config.spider;
  }
  return null;
}

export function cleanEmptyEntries(config: TVBoxConfig): TVBoxConfig {
  const before = {
    sites: config.sites?.length || 0,
    parses: config.parses?.length || 0,
    lives: config.lives?.length || 0,
    doh: config.doh?.length || 0,
  };
  const sites = (config.sites || []).filter(s => s.key && s.api);
  const parses = (config.parses || []).filter(p => p.name && p.url);
  const lives = (config.lives || []).filter(l => (l.url || l.api));
  const doh = (config.doh || []).filter(d => d.name && d.url);
  const removed = (before.sites - sites.length) + (before.parses - parses.length)
    + (before.lives - lives.length) + (before.doh - doh.length);
  if (removed > 0) {
    console.log(`[cleaner] Removed ${removed} empty entries: ${before.sites - sites.length} sites, ${before.parses - parses.length} parses, ${before.lives - lives.length} lives, ${before.doh - doh.length} doh`);
  }
  return { ...config, sites, parses, lives, doh };
}

export function cleanLocalRefs(config: TVBoxConfig): TVBoxConfig {
  const isLocal = (url: string) => url.includes('127.0.0.1') || url.includes('localhost');
  const sites = (config.sites || []).filter((site) => {
    if (site.api && isLocal(site.api)) {
      console.log(`[cleaner] Removed site ${site.key}: local api ${site.api}`);
      return false;
    }
    if (typeof site.ext === 'string' && isLocal(site.ext)) {
      console.log(`[cleaner] Removed site ${site.key}: local ext`);
      return false;
    }
    return true;
  });
  const lives = (config.lives || []).filter((live) => {
    if (live.url && isLocal(live.url)) {
      console.log(`[cleaner] Removed live ${live.name || 'unnamed'}: local url ${live.url}`);
      return false;
    }
    return true;
  });
  const removedSites = (config.sites?.length || 0) - sites.length;
  const removedLives = (config.lives?.length || 0) - lives.length;
  if (removedSites > 0 || removedLives > 0) console.log(`[cleaner] Removed ${removedSites} sites, ${removedLives} lives with local refs`);
  return { ...config, sites, lives };
}
