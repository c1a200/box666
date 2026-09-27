// 搜索配额控制（复用站点测速结果）

import type { TVBoxSite, SearchQuotaConfig, SearchQuotaReport } from './types';
import type { Storage } from '../storage/interface';
import { KV_SEARCH_QUOTA } from './config';

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.env.PORT;
}

function defaultSearchLimit(): number {
  // Render/Node 的并发资源高于免费 Worker；有 PORT 即视为 Render/Docker。
  return isNodeRuntime() ? 80 : 60;
}

function defaultQuickSearchLimit(): number {
  // 快速搜索只保留少量健康度最高的源，减少影视仓/TVBox 启动与首屏等待。
  return isNodeRuntime() ? 40 : 30;
}

function createDefaultSearchQuota(): SearchQuotaConfig {
  return {
    maxSearchable: defaultSearchLimit(),
    maxQuickSearch: defaultQuickSearchLimit(),
    autoLimit: true,
    pinnedKeys: [],
    sortBySpeed: true,
  };
}

function normalizeLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** 从 KV 加载搜索配额配置，并兼容旧版本缺少字段的数据。 */
export async function loadSearchQuota(storage: Storage): Promise<SearchQuotaConfig> {
  const raw = await storage.get(KV_SEARCH_QUOTA);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SearchQuotaConfig>;
      const maxSearchable = normalizeLimit(parsed.maxSearchable);
      const fallback = createDefaultSearchQuota();
      const hasNewLimitFields = typeof parsed.autoLimit === 'boolean' || typeof parsed.maxQuickSearch === 'number';
      const isLegacyQuota = !hasNewLimitFields;
      // 旧版配置一律迁移到安全上限；只有用户在新版后台明确关闭后，才保留 0 = 不限制。
      const autoLimit = isLegacyQuota ? true : parsed.autoLimit === true;
      const effectiveMaxSearchable = isLegacyQuota
        ? fallback.maxSearchable
        : (autoLimit && maxSearchable === 0 ? fallback.maxSearchable : maxSearchable);
      return {
        maxSearchable: effectiveMaxSearchable,
        maxQuickSearch: autoLimit
          ? (normalizeLimit(parsed.maxQuickSearch) || fallback.maxQuickSearch)
          : normalizeLimit(parsed.maxQuickSearch),
        autoLimit,
        pinnedKeys: Array.isArray(parsed.pinnedKeys)
          ? parsed.pinnedKeys.filter((key): key is string => typeof key === 'string')
          : [],
        // 旧配置没有 sortBySpeed 字段时默认开启，已有明确设置仍原样保留。
        sortBySpeed: parsed.sortBySpeed !== false,
      };
    } catch {}
  }
  return createDefaultSearchQuota();
}

/** 保存搜索配额配置。 */
export async function saveSearchQuota(storage: Storage, config: SearchQuotaConfig): Promise<void> {
  const maxSearchable = normalizeLimit(config.maxSearchable);
  const autoLimit = config.autoLimit === true;
  await storage.put(KV_SEARCH_QUOTA, JSON.stringify({
    maxSearchable,
    maxQuickSearch: normalizeLimit(config.maxQuickSearch),
    autoLimit,
    pinnedKeys: Array.isArray(config.pinnedKeys) ? config.pinnedKeys : [],
    sortBySpeed: config.sortBySpeed === true,
  }));
}
/**
 * 提前排除 type=3 + HTTP URL 的 JS 源。
 * 这些源不应参与站点测速，也不应进入搜索配额候选。
 */
export function excludeJsUrlSites(sites: TVBoxSite[]): { sites: TVBoxSite[]; jsExcluded: number } {
  let jsExcluded = 0;
  const next = sites.map(site => {
    if (site.type === 3 && site.searchable === 1 && /^https?:\/\//.test(site.api)) {
      jsExcluded++;
      return { ...site, searchable: 0 };
    }
    return site;
  });
  return { sites: next, jsExcluded };
}

export interface SearchQuotaApplyOptions {
  speedMap?: Map<string, number | null>;
  jsExcluded?: number;
  totalSites?: number;
}

/**
 * 搜索配额控制。
 *
 * 1. 置顶源优先排到 sites 最前。
 * 2. 复用站点测速结果，把较快的可搜索源排在前面。
 * 3. maxSearchable > 0 时限制全局搜索源；maxQuickSearch > 0 时额外限制快速搜索源。
 * 4. 置顶源永远不被截断；若置顶源数量本身超过上限，则保留全部置顶源。
 * 5. 名称标识只加给最终仍可搜索的源。
 */
export function applySearchQuota(
  sites: TVBoxSite[],
  config: SearchQuotaConfig,
  siteSourceMap: Map<string, string>,
  options: SearchQuotaApplyOptions = {},
): { sites: TVBoxSite[]; quotaReport: SearchQuotaReport } {
  const limit = normalizeLimit(config.maxSearchable);
  const quickLimit = normalizeLimit(config.maxQuickSearch);
  const speedMap = options.speedMap;
  const totalSites = options.totalSites ?? sites.length;

  // 置顶源按 pinnedKeys 顺序排到最前，重复 key 只保留一次。
  const siteByKey = new Map(sites.map(site => [site.key, site]));
  const pinned: TVBoxSite[] = [];
  const pinnedKeySet = new Set<string>();
  for (const key of config.pinnedKeys || []) {
    const site = siteByKey.get(key);
    if (site && !pinnedKeySet.has(key)) {
      pinned.push(site);
      pinnedKeySet.add(key);
    }
  }

  const pinnedSearchable = pinned.filter(site => site.searchable === 1);
  let candidates = sites.filter(site => site.searchable === 1 && !pinnedKeySet.has(site.key));

  // 复用已有测速结果排序；没有测速数据的源排在最后，并保持原有相对顺序。
  let speedSorted = false;
  if (config.sortBySpeed && speedMap && speedMap.size > 0) {
    candidates = [...candidates].sort((a, b) => {
      const aSpeed = speedMap.get(a.key);
      const bSpeed = speedMap.get(b.key);
      const aValid = typeof aSpeed === 'number' && Number.isFinite(aSpeed);
      const bValid = typeof bSpeed === 'number' && Number.isFinite(bSpeed);
      if (aValid && bValid) return (aSpeed as number) - (bSpeed as number);
      if (aValid) return -1;
      if (bValid) return 1;
      return 0;
    });
    speedSorted = candidates.some(site => typeof speedMap.get(site.key) === 'number');
  }

  // 先确定普通搜索保留集合；置顶源不受截断影响。
  let keptCandidates = candidates;
  let truncated = 0;
  if (limit > 0) {
    const effectiveLimit = Math.max(limit, pinnedSearchable.length);
    const keepCount = Math.max(0, effectiveLimit - pinnedSearchable.length);
    keptCandidates = candidates.slice(0, keepCount);

    const keptKeys = new Set(keptCandidates.map(site => site.key));
    truncated = new Set(
      candidates
        .filter(site => !keptKeys.has(site.key))
        .map(site => site.key),
    ).size;
  }

  const keptCandidateKeys = new Set(keptCandidates.map(site => site.key));
  const allowedSearchableKeys = new Set<string>([...pinnedKeySet, ...keptCandidateKeys]);

  // 快速搜索独立限制：不会删除站点，只把 quickSearch 置 0。
  // Render 默认 40、CF 默认 30，足以覆盖常用源并显著缩短首屏等待。
  const quickCandidates = [
    ...pinned.filter(site => site.searchable === 1 && site.quickSearch !== 0),
    ...keptCandidates.filter(site => site.searchable === 1 && site.quickSearch !== 0),
  ];
  const allowedQuickKeys = new Set(
    quickLimit > 0
      ? quickCandidates.slice(0, quickLimit).map(site => site.key)
      : quickCandidates.map(site => site.key),
  );

  // 先完成排序，再按最终顺序一次性应用所有配额，避免旧数组对象把已截断的
  // quickSearch 状态重新带回来。
  let orderedSites: TVBoxSite[];
  if (config.sortBySpeed && speedSorted) {
    const ordered = [...pinned, ...keptCandidates];
    const orderedKeys = new Set(ordered.map(site => site.key));
    const rest = sites.filter(site => !orderedKeys.has(site.key));
    orderedSites = [...ordered, ...rest];
  } else {
    const rest = sites.filter(site => !pinnedKeySet.has(site.key));
    orderedSites = [...pinned, ...rest];
  }

  let quickTruncated = 0;
  sites = orderedSites.map(site => {
    let next = site;
    if (site.searchable === 1 && !allowedSearchableKeys.has(site.key)) {
      next = { ...next, searchable: 0 };
    }
    if (next.searchable === 1 && next.quickSearch !== 0 && !allowedQuickKeys.has(next.key)) {
      next = { ...next, quickSearch: 0 };
      quickTruncated++;
    }
    return next;
  });

  // 来源标识：只给最终仍可搜索的源加标识。
  sites = sites.map(site => {
    if (site.searchable !== 1) return site;
    const sourceName = siteSourceMap.get(site.key);
    if (sourceName && site.name && !site.name.includes('「')) {
      const label = sourceName.length > 6 ? sourceName.substring(0, 6) : sourceName;
      return { ...site, name: `${site.name} 「${label}」` };
    }
    return site;
  });

  const searchable = sites.filter(site => site.searchable === 1).length;
  const quickSearchable = sites.filter(site => site.searchable === 1 && site.quickSearch !== 0).length;
  const pinnedCount = pinnedSearchable.length;

  return {
    sites,
    quotaReport: {
      totalSites,
      jsExcluded: options.jsExcluded ?? 0,
      searchable,
      quickSearchable,
      maxSearchable: limit,
      maxQuickSearch: quickLimit,
      autoLimit: config.autoLimit === true,
      pinnedCount,
      truncated,
      quickTruncated,
      speedSorted,
    },
  };
}
