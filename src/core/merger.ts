// 站点级合并引擎

import type { TVBoxConfig, TVBoxSite, SourcedConfig } from './types';
import { normalizeConfig, extractSpiderJarUrl } from './parser';
import { isClientCredentialSite } from './credential-risk';
import { credentialSiteInstanceId, credentialSiteInstanceKey } from './site-contract';
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

export function mergeConfigs(sourcedConfigs: SourcedConfig[]): MergeResult {
  // Step 1: 规范化所有配置
  const normalized = sourcedConfigs.map(normalizeConfig);
  const siteSourceMap = new Map<string, string>();
  const siteUpstreamMap = new Map<string, string[]>();
  const parseSourceMap = new Map<string, string>();
  const liveSourceMap = new Map<string, string>();

  // Step 2: 确定全局 spider（按完整 spider 指纹投票，包含 JAR URL 与 MD5）
  const globalSpiderFull = selectGlobalSpider(normalized);
  const globalSpider = globalSpiderFull ? extractSpiderJarUrl(globalSpiderFull) : null;

  // Step 3: 收集站点并记录每个实例实际生效的 JAR。站点自身 JAR 优先，
  // 其次是非全局的顶层 spider，最后才是合并配置的全局 spider。
  const allSites: TVBoxSite[] = [];
  const siteUpstreamsByObject = new WeakMap<TVBoxSite, Set<string>>();
  const sourceBySiteObject = new WeakMap<TVBoxSite, string>();
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
    const upstreams = sourced.upstreamNames?.length ? sourced.upstreamNames : [sourced.sourceName];
    const upstreamList = [...new Set(upstreams)].filter(Boolean).sort();

    // Sites: 给 type:3 站点分配 jar 字段
    if (config.sites) {
      for (const site of config.sites) {
        const siteCopy = { ...site };

        // 非全局 spider 必须固化到站点，否则合并后会错误地改用另一个总源的全局 JAR。
        if (
          site.type === 3
          && !site.jar
          && sourceSpider
          && sourceSpider !== globalSpiderFull
        ) {
          siteCopy.jar = sourceSpider;
        }

        const effectiveJar =
          siteCopy.jar
          || sourceSpider
          || globalSpiderFull
          || globalSpider
          || undefined;

        siteUpstreamsByObject.set(siteCopy, new Set(upstreamList));
        sourceBySiteObject.set(siteCopy, sourced.sourceName);
        effectiveJarByObject.set(siteCopy, effectiveJar);
        siteCopy.__upstreamNames = upstreamList;
        allSites.push(siteCopy);
      }
    }

    if (config.parses) {
      for (const p of config.parses) {
        if (p.url && !parseSourceMap.has(p.url)) {
          parseSourceMap.set(p.url, sourced.sourceName);
        }
      }
      allParses.push(...config.parses);
    }
    if (config.lives) {
      for (const l of config.lives) {
        const liveId = l.url || l.api || '';
        if (liveId && !liveSourceMap.has(liveId)) {
          liveSourceMap.set(liveId, sourced.sourceName);
        }
      }
      allLives.push(...config.lives);
    }
    if (config.hosts) allHosts.push(...config.hosts);
    if (config.rules) allRules.push(...config.rules);
    if (config.doh) allDoh.push(...config.doh);
    if (config.ads) allAds.push(...config.ads);
    if (config.flags) allFlags.push(...config.flags);
  }

  // Step 4: 按稳定顺序去重，同时保留“最终对象 -> 实例信息来源”的显式映射。
  // 凭证源属于某个总源下的实例，不能让不同总源的完全同构源共用一个去重键。
  const seenDedupKeys = new Map<string, TVBoxSite>();
  const siteInstanceIdByObject = new WeakMap<TVBoxSite, string>();
  const upstreamsByInstanceId = new Map<string, Set<string>>();
  const sourceByInstanceId = new Map<string, string>();
  for (const site of allSites) {
    const upstreamList = [...(siteUpstreamsByObject.get(site) || [])].filter(Boolean).sort();
    const effectiveJar = effectiveJarByObject.get(site);
    const isCredential = isClientCredentialSite(site, effectiveJar);
    const boundary = upstreamList[0] || sourceBySiteObject.get(site) || '';
    const dk = isCredential
      ? 'cred:' + boundary + ':' + credentialSiteInstanceId(site, effectiveJar)
      : site.key + '|' + site.api;
    const existing = seenDedupKeys.get(dk);
    if (existing) {
      const instanceId = siteInstanceIdByObject.get(existing) || dk;
      const mergedUpstreams = upstreamsByInstanceId.get(instanceId) || new Set<string>();
      for (const upstream of upstreamList) mergedUpstreams.add(upstream);
      upstreamsByInstanceId.set(instanceId, mergedUpstreams);
      if (mergedUpstreams.size > 0) existing.__upstreamNames = [...mergedUpstreams].sort();
      continue;
    }
    seenDedupKeys.set(dk, site);
    siteInstanceIdByObject.set(site, dk);
    upstreamsByInstanceId.set(dk, new Set(upstreamList));
    sourceByInstanceId.set(dk, sourceBySiteObject.get(site) || '');
    if (upstreamList.length > 0) site.__upstreamNames = upstreamList;
  }

  const collectedSites = [...seenDedupKeys.values()];
  const credentialSites = collectedSites.filter((site) =>
    isClientCredentialSite(site, effectiveJarByObject.get(site)),
  );
  const ordinarySites = collectedSites.filter((site) =>
    !isClientCredentialSite(site, effectiveJarByObject.get(site)),
  );
  const dedupedOrdinarySites = deduplicateSites(ordinarySites);

  // deduplicateSites 可能改写普通站点 key；对象身份和实例映射不受影响。
  for (const site of dedupedOrdinarySites) {
    const instanceId = siteInstanceIdByObject.get(site) || site.key + '|' + site.api;
    siteInstanceIdByObject.set(site, instanceId);
  }

  const dedupedSites = [...dedupedOrdinarySites, ...credentialSites];

  // 最终 key 必须全局唯一，否则契约表会覆盖、响应期会错投凭证。
  // 保留第一个实例的原 key，只给后续冲突实例加稳定后缀，减少客户端历史抖动。
  const keyTotals = new Map<string, number>();
  for (const site of dedupedSites) keyTotals.set(site.key, (keyTotals.get(site.key) || 0) + 1);
  const keyOccurrences = new Map<string, number>();
  const usedKeys = new Set<string>();
  for (const site of dedupedSites) {
    const baseKey = site.key;
    const occurrence = (keyOccurrences.get(baseKey) || 0) + 1;
    keyOccurrences.set(baseKey, occurrence);

    if ((keyTotals.get(baseKey) || 0) > 1 && occurrence > 1) {
      const newKey = credentialSiteInstanceKey(
        { ...site, key: baseKey },
        effectiveJarByObject.get(site) || globalSpiderFull || globalSpider || undefined,
      );
      if (newKey !== baseKey) site.key = newKey;
      if (site.name && newKey.startsWith(baseKey + '__')) {
        const suffix = newKey.slice(baseKey.length + 2);
        if (suffix && !site.name.includes('(' + suffix + ')')) site.name = site.name + '(' + suffix + ')';
      }
    }

    let candidate = site.key;
    let n = 2;
    while (usedKeys.has(candidate)) candidate = site.key + '_' + n++;
    site.key = candidate;
    usedKeys.add(site.key);
  }

  // 用最终对象的内部实例 ID 构建来源/上游映射。
  for (const site of dedupedSites) {
    const instanceId = siteInstanceIdByObject.get(site);
    const upstreamList = [...(instanceId ? upstreamsByInstanceId.get(instanceId) || [] : site.__upstreamNames || [])]
      .filter(Boolean)
      .sort();
    const source = instanceId ? sourceByInstanceId.get(instanceId) : undefined;
    if (source) siteSourceMap.set(site.key, source);
    if (upstreamList.length > 0) {
      siteUpstreamMap.set(site.key, upstreamList);
      site.__upstreamNames = upstreamList;
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

  // 设置全局 spider
  if (globalSpider) {
    merged.spider = globalSpiderFull || globalSpider;
  }

  console.log(
    `[merger] Merged: ${merged.sites?.length} sites, ` +
      `${merged.parses?.length} parses, ${merged.lives?.length} lives`,
  );

  return { config: merged, siteSourceMap, siteUpstreamMap, parseSourceMap, liveSourceMap };
}

/**
 * 选择全局 spider 指纹。
 * 按完整 spider 字符串投票，避免同一 URL 的不同 md5 被错误合并。
 */
function selectGlobalSpider(configs: SourcedConfig[]): string | null {
  const spiderCounts = new Map<string, number>();

  for (const sourced of configs) {
    const spider = sourced.config.spider;
    if (!spider) continue;

    const type3Count = (sourced.config.sites || []).filter((s) => s.type === 3 && !s.jar).length;
    if (type3Count > 0) {
      spiderCounts.set(spider, (spiderCounts.get(spider) || 0) + type3Count);
    }
  }

  if (spiderCounts.size === 0) return null;

  let maxSpider: string | null = null;
  let maxCount = 0;
  for (const [spider, count] of spiderCounts) {
    if (count > maxCount) {
      maxCount = count;
      maxSpider = spider;
    }
  }

  return maxSpider;
}


/**
 * 清洗空数据条目
 * 过滤掉关键字段为空的 sites/parses/lives/doh
 */
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

  const removed =
    (before.sites - sites.length) +
    (before.parses - parses.length) +
    (before.lives - lives.length) +
    (before.doh - doh.length);

  if (removed > 0) {
    console.log(
      `[cleaner] Removed ${removed} empty entries: ` +
      `${before.sites - sites.length} sites, ${before.parses - parses.length} parses, ` +
      `${before.lives - lives.length} lives, ${before.doh - doh.length} doh`,
    );
  }

  return { ...config, sites, parses, lives, doh };
}

/**
 * 清洗本地引用（127.0.0.1 / localhost）
 * 这些地址依赖用户本地 TVBox 代理服务，聚合后对其他用户是死链
 */
export function cleanLocalRefs(config: TVBoxConfig): TVBoxConfig {
  const isLocal = (url: string) =>
    url.includes('127.0.0.1') || url.includes('localhost');

  const sites = (config.sites || []).filter((site) => {
    // 过滤 api 包含本地地址的站点
    if (site.api && isLocal(site.api)) {
      console.log(`[cleaner] Removed site ${site.key}: local api ${site.api}`);
      return false;
    }
    // 过滤 ext 字符串包含本地地址的站点，但保留可以直接注入凭据的网盘源或使用 token.json 的源
    if (typeof site.ext === 'string' && isLocal(site.ext)) {
      const isNetdisk = isClientCredentialSite(site);
      const isTokenJson = site.ext.includes('token.json') || site.ext.includes('token_json');
      if (isNetdisk || isTokenJson) {
        return true; // 保留，因为聚合器会注入凭据或重写为云端 token.json
      }
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
  if (removedSites > 0 || removedLives > 0) {
    console.log(`[cleaner] Removed ${removedSites} sites, ${removedLives} lives with local refs`);
  }

  return { ...config, sites, lives };
}
