// 搜索配额控制（复用站点测速结果）

import type { TVBoxParse, TVBoxSite, SearchQuotaConfig, SearchQuotaReport } from './types';
import type { Storage } from '../storage/interface';
import { KV_SEARCH_QUOTA } from './config';
const QUOTA_SCHEMA_VERSION = 3;

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.env.PORT;
}

function defaultSearchLimit(): number {
  // Render/Node 的并发资源高于免费 Worker；有 PORT 即视为 Render/Docker。
  return isNodeRuntime() ? 50 : 40;
}

function defaultQuickSearchLimit(): number {
  // 快速搜索只保留少量健康度最高的源，减少影视仓/TVBox 启动与首屏等待。
  return isNodeRuntime() ? 24 : 15;
}

function defaultParseLimit(): number {
  // 客户端启动时会逐个初始化解析器；只保留响应最快的健康项。
  return isNodeRuntime() ? 10 : 7;
}

function createDefaultSearchQuota(): SearchQuotaConfig {
  return {
    maxSearchable: defaultSearchLimit(),
    maxQuickSearch: defaultQuickSearchLimit(),
    maxParses: defaultParseLimit(),
    autoLimit: true,
    pinnedKeys: [],
    sortBySpeed: true,
    leanStartup: true,
    pruneDeadParses: true,
    quotaSchemaVersion: QUOTA_SCHEMA_VERSION,
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
      const isLegacyQuota = !hasNewLimitFields || (parsed.quotaSchemaVersion ?? 1) < QUOTA_SCHEMA_VERSION;
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
        maxParses: autoLimit
          ? (normalizeLimit(parsed.maxParses) || fallback.maxParses)
          : normalizeLimit(parsed.maxParses),
        autoLimit,
        pinnedKeys: Array.isArray(parsed.pinnedKeys)
          ? parsed.pinnedKeys.filter((key): key is string => typeof key === 'string')
          : [],
        // 旧配置没有 sortBySpeed 字段时默认开启，已有明确设置仍原样保留。
        sortBySpeed: parsed.sortBySpeed !== false,
        // 旧配置没有该字段时默认开启轻量启动；用户明确关闭后保留关闭状态。
        leanStartup: parsed.leanStartup !== false,
        pruneDeadParses: parsed.pruneDeadParses !== false,
        quotaSchemaVersion: QUOTA_SCHEMA_VERSION,
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
    maxParses: normalizeLimit(config.maxParses),
    autoLimit,
    pinnedKeys: Array.isArray(config.pinnedKeys) ? config.pinnedKeys : [],
    sortBySpeed: config.sortBySpeed === true,
    leanStartup: config.leanStartup !== false,
    pruneDeadParses: config.pruneDeadParses !== false,
    quotaSchemaVersion: QUOTA_SCHEMA_VERSION,
  }));
}

function hasRemoteJarOrExt(site: TVBoxSite): boolean {
  return (
    (typeof site.jar === 'string' && /^https?:\/\//i.test(site.jar))
    || (typeof site.ext === 'string' && /^https?:\/\//i.test(site.ext))
  );
}

/**
 * 判断站点是否可以在轻量启动模式下剔除。
 *
 * 只处理“不可搜索的 type=3 远程扩展站点”：这些站点仍会触发客户端下载/
 * 初始化远程 JAR 或扩展，却不参与搜索，是 TVBox/影视仓启动慢的主要来源。
 * type=0/1/4、可搜索站点和置顶站点都不会被此函数命中。
 */
export function isLeanStartupRemovableSite(site: TVBoxSite): boolean {
  return site.searchable !== 1 && hasRemoteJarOrExt(site);
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
    // 不可搜索源不能保留 quickSearch=1，否则部分客户端仍会在启动阶段初始化。
    if (next.searchable !== 1 && next.quickSearch !== 0) {
      next = { ...next, quickSearch: 0 };
    }
    if (next.searchable === 1 && next.quickSearch !== 0 && !allowedQuickKeys.has(next.key)) {
      next = { ...next, quickSearch: 0 };
      quickTruncated++;
    }
    return next;
  });

  const beforeLean = sites.length;
  if (config.leanStartup !== false) {
    sites = sites.filter(site => pinnedKeySet.has(site.key) || !isLeanStartupRemovableSite(site));
  }
  const leanRemoved = beforeLean - sites.length;

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
      leanRemoved,
    },
  };
}
export interface ParseHealthReport {
  probed: number;
  removed: number;
  timeouts: number;
  httpErrors: number;
  networkErrors: number;
  failedProbe?: boolean;
  kept: number;
  removedNames: string[];
  parseLimit?: number;
  parseTruncated?: number;
  parseKept?: number;
}

interface ParseProbeResult {
  parse: TVBoxParse;
  ms: number;
  keep: boolean;
}

function isProbeableParse(parse: TVBoxParse): boolean {
  return typeof parse.url === 'string' && /^https?:\/\//i.test(parse.url);
}

/**
 * 探测解析器入口，剔除明确失效项，并按响应时间排序后限制发布数量。
 *
 * 客户端会逐个初始化 parses；一个 8 秒超时就会直接拖慢首屏。这里主动探测并
 * 移除超时、网络错误和明确的 4xx/5xx，保留 401/403/429，避免把临时受限的
 * 解析器永久删掉。无法探测的非 HTTP 项仍会保留，排在健康项之后。
 */
export async function probeAndPruneParses(
  parses: TVBoxParse[],
  timeoutMs = 3500,
  concurrency = 12,
  maxParses = 0,
  pruneDeadParses = true,
): Promise<{ parses: TVBoxParse[]; report: ParseHealthReport }> {
  const candidates = parses.filter(isProbeableParse);
  const results: ParseProbeResult[] = parses
    .filter((parse) => !isProbeableParse(parse))
    .map((parse) => ({ parse, ms: Number.POSITIVE_INFINITY, keep: true }));
  let timeouts = 0;
  let httpErrors = 0;
  let networkErrors = 0;
  let cursor = 0;

  // Cloudflare Worker 的子请求在批量探测时可能整体失败（DNS/出口/WAF 等）。
  // 这时无法把“网络异常”等同于“源已失效”，否则一次部署就可能把全部
  // parses 清空。只有出现足够多的明确响应时，才信任本轮失败结论；否则
  // 回退为按配置上限截断原始候选，保证客户端仍可用。
  const minTrustedResponses = candidates.length >= 4
    ? Math.max(2, Math.ceil(candidates.length * 0.1))
    : 1;
  let definitiveResponses = 0;

  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const parse = candidates[cursor++];
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let keep = false;
      try {
        const response = await fetch(parse.url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'User-Agent': 'okhttp/3.12.13' },
        });
        await response.body?.cancel();
        const status = response.status;
        definitiveResponses++;
        keep = (status >= 200 && status < 400) || status === 401 || status === 403 || status === 429;
        // 401/403/429 可能是地区限制、鉴权或临时限流，不能据此永久删除。
        if (!keep) httpErrors++;
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          timeouts++;
        } else {
          networkErrors++;
        }
      } finally {
        clearTimeout(timer);
        results.push({ parse, ms: Date.now() - startedAt, keep });
      }
    }
  });

  await Promise.all(workers);

  const failedProbe = pruneDeadParses
    && candidates.length > 0
    && definitiveResponses < minTrustedResponses;
  results.sort((a, b) => {
    if (a.keep !== b.keep) return a.keep ? -1 : 1;
    return a.ms - b.ms;
  });

  const dead = results.filter((result) => !result.keep);
  let next = pruneDeadParses && !failedProbe
    ? results.filter((result) => result.keep).map((result) => result.parse)
    : results.map((result) => result.parse);
  const parseTruncated = maxParses > 0 ? Math.max(0, next.length - maxParses) : 0;
  if (parseTruncated > 0) next = next.slice(0, maxParses);

  return {
    parses: next,
    report: {
      probed: candidates.length,
      removed: pruneDeadParses ? dead.length : 0,
      timeouts,
      httpErrors,
      networkErrors,
      failedProbe,
      kept: next.length,
      removedNames: failedProbe ? [] : dead.map((result) => result.parse.name).filter(Boolean),
      parseLimit: maxParses,
      parseTruncated,
      parseKept: next.length,
    },
  };
}
