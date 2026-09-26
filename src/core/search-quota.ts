// 搜索配额控制（复用站点测速结果）

import type { TVBoxSite, SearchQuotaConfig, SearchQuotaReport } from './types';
import type { Storage } from '../storage/interface';
import { KV_SEARCH_QUOTA } from './config';

const DEFAULT_SEARCH_QUOTA: SearchQuotaConfig = {
  maxSearchable: 0,
  pinnedKeys: [],
  sortBySpeed: false,
};

function normalizeLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** 从 KV 加载搜索配额配置，并兼容旧版本缺少 sortBySpeed 的数据。 */
export async function loadSearchQuota(storage: Storage): Promise<SearchQuotaConfig> {
  const raw = await storage.get(KV_SEARCH_QUOTA);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SearchQuotaConfig>;
      return {
        maxSearchable: normalizeLimit(parsed.maxSearchable),
        pinnedKeys: Array.isArray(parsed.pinnedKeys)
          ? parsed.pinnedKeys.filter((key): key is string => typeof key === 'string')
          : [],
        sortBySpeed: parsed.sortBySpeed === true,
      };
    } catch {}
  }
  return { ...DEFAULT_SEARCH_QUOTA };
}

/** 保存搜索配额配置。 */
export async function saveSearchQuota(storage: Storage, config: SearchQuotaConfig): Promise<void> {
  await storage.put(KV_SEARCH_QUOTA, JSON.stringify({
    maxSearchable: normalizeLimit(config.maxSearchable),
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
 * 2. 可选复用站点测速结果，把较快的可搜索源排到前面。
 * 3. maxSearchable > 0 时，超出上限的可搜索源改为 searchable=0。
 * 4. 置顶源永远不被截断；若置顶源数量本身超过上限，则保留全部置顶源。
 * 5. searchable=1 的源名称追加来源标识。
 *
 * 注意：这里只使用聚合流程中已经产生的测速结果，不会额外发起网络请求。
 */
export function applySearchQuota(
  sites: TVBoxSite[],
  config: SearchQuotaConfig,
  siteSourceMap: Map<string, string>,
  options: SearchQuotaApplyOptions = {},
): { sites: TVBoxSite[]; quotaReport: SearchQuotaReport } {
  const limit = normalizeLimit(config.maxSearchable);
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

  // 可选截断：置顶源不占用普通源名额，但置顶源本身超过上限时不会丢弃。
  let keptCandidates = candidates;
  let truncated = 0;
  if (limit > 0) {
    const effectiveLimit = Math.max(limit, pinnedSearchable.length);
    const keepCount = Math.max(0, effectiveLimit - pinnedSearchable.length);
    keptCandidates = candidates.slice(0, keepCount);
    const keptKeys = new Set(keptCandidates.map(site => site.key));
    const droppedKeys = new Set(
      candidates
        .filter(site => !keptKeys.has(site.key))
        .map(site => site.key),
    );
    if (droppedKeys.size > 0) {
      truncated = droppedKeys.size;
      sites = sites.map(site => (
        droppedKeys.has(site.key) ? { ...site, searchable: 0 } : site
      ));
    }
  }

  // 启用测速排序时，置顶源 + 保留的可搜索源排到最前；否则维持原有顺序。
  if (config.sortBySpeed && speedSorted) {
    const ordered = [...pinned, ...keptCandidates];
    const orderedKeys = new Set(ordered.map(site => site.key));
    const rest = sites.filter(site => !orderedKeys.has(site.key));
    sites = [...ordered, ...rest];
  } else {
    const rest = sites.filter(site => !pinnedKeySet.has(site.key));
    sites = [...pinned, ...rest];
  }

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
  const pinnedCount = pinnedSearchable.length;

  return {
    sites,
    quotaReport: {
      totalSites,
      jsExcluded: options.jsExcluded ?? 0,
      searchable,
      pinnedCount,
      truncated,
      speedSorted,
    },
  };
}
