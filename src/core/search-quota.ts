// 搜索配额控制（复用站点测速结果）

import type { TVBoxParse, TVBoxSite, SearchQuotaConfig, SearchQuotaReport, SiteHealthMap, SiteQualityGrade, SiteQualityGrades, SearchQualitySnapshot } from './types';
import { isSiteProbeable, type SiteProbeResult } from './speedtest';
import { isClientCredentialSite } from './credential-risk';
import type { Storage } from '../storage/interface';
import { KV_SEARCH_QUOTA } from './config';
const QUOTA_SCHEMA_VERSION = 11;
const LEGACY_PARSE_LIMIT_SCHEMA_VERSION = 8;
const EXPLICIT_QUICK_LIMIT_SCHEMA_VERSION = 11;

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.env.PORT;
}

function defaultSearchLimit(): number {
  // 默认不限制搜索源数量，避免自动配额把质量良好但本次测速未覆盖的源截断。
  // 用户仍可在后台显式设置上限；schema 8 后 autoLimit 已退役。
  return 0;
}

function defaultQuickSearchLimit(): number {
  // 默认不限制；由可搜索源上限和质量筛选控制下发数量。
  return 0;
}

function defaultStartupQuickSearchLimit(): number {
  // 默认不限制；保留字段用于兼容旧配置和显式回滚。
  return 0;
}

function defaultParseLimit(): number {
  // 客户端启动时会逐个初始化解析器；只保留响应最快的健康项。
  // 启动阶段每个解析器都可能串行等待，10 个会直接放大成十几秒。
  return isNodeRuntime() ? 3 : 3;
}

function createDefaultSearchQuota(): SearchQuotaConfig {
  return {
    maxSearchable: defaultSearchLimit(),
    maxQuickSearch: defaultQuickSearchLimit(),
    maxStartupQuickSearch: defaultStartupQuickSearchLimit(),
    maxParses: defaultParseLimit(),
    retainCredentialSources: false,
    retainCredentialMode: 'off',
    retainedCredentialKeys: [],
    blockedKeys: [],
    autoLimit: false,
    pinnedKeys: [],
    sortBySpeed: true,
    leanStartup: true,
    startupMode: 'lean',
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
      const fallback = createDefaultSearchQuota();
      const quotaVersion = parsed.quotaSchemaVersion ?? 1;
      const legacyParseLimit = quotaVersion < LEGACY_PARSE_LIMIT_SCHEMA_VERSION;
      // schema 10 及以前，quick/startup 上限是代码自动写入的部署常量，
      // 不代表用户配置。升级时清零，否则 maxSearchable=0 仍会被暗截断。
      const quickLimitsAreUserConfigured = quotaVersion >= EXPLICIT_QUICK_LIMIT_SCHEMA_VERSION;
      const retainCredentialMode: 'off' | 'all' | 'selected' =
        parsed.retainCredentialMode === 'all' || parsed.retainCredentialMode === 'selected' || parsed.retainCredentialMode === 'off'
          ? parsed.retainCredentialMode
          : (parsed.retainCredentialSources === true ? 'all' : 'off');

      // User-facing settings: searchable source cap and parser cap.
      // Everything else is an automatic performance guard.
      return {
        maxSearchable: normalizeLimit(parsed.maxSearchable),
        maxQuickSearch: quickLimitsAreUserConfigured ? normalizeLimit(parsed.maxQuickSearch) : 0,
        maxStartupQuickSearch: quickLimitsAreUserConfigured ? normalizeLimit(parsed.maxStartupQuickSearch) : 0,
        // Legacy startup-site values are intentionally ignored after schema 8:
        // the root startup config is always derived from the automatic quick cap.
        startupSiteLimit: 0,
        maxParses: legacyParseLimit
          ? fallback.maxParses
          : normalizeLimit(parsed.maxParses),
        retainCredentialSources: retainCredentialMode !== 'off',
        retainCredentialMode,
        retainedCredentialKeys: Array.isArray(parsed.retainedCredentialKeys)
          ? [...new Set(parsed.retainedCredentialKeys.filter((key): key is string => typeof key === 'string'))]
          : [],
        blockedKeys: Array.isArray(parsed.blockedKeys)
          ? [...new Set(parsed.blockedKeys.filter((key): key is string => typeof key === 'string'))]
          : [],
        autoLimit: false,
        pinnedKeys: Array.isArray(parsed.pinnedKeys)
          ? parsed.pinnedKeys.filter((key): key is string => typeof key === 'string')
          : [],
        sortBySpeed: parsed.sortBySpeed !== false,
        leanStartup: parsed.leanStartup !== false,
        startupMode: parsed.startupMode === 'full' ? 'full' : 'lean',
        pruneDeadParses: parsed.pruneDeadParses !== false,
        quotaSchemaVersion: QUOTA_SCHEMA_VERSION,
      };
    } catch {}
  }
  return createDefaultSearchQuota();
}

/** 保存搜索配额配置。 */
export async function saveSearchQuota(storage: Storage, config: SearchQuotaConfig): Promise<void> {
  const retainCredentialMode: 'off' | 'all' | 'selected' =
    config.retainCredentialMode === 'all' || config.retainCredentialMode === 'selected' || config.retainCredentialMode === 'off'
      ? config.retainCredentialMode
      : (config.retainCredentialSources === true ? 'all' : 'off');
  await storage.put(KV_SEARCH_QUOTA, JSON.stringify({
    maxSearchable: normalizeLimit(config.maxSearchable),
    // 0 表示不限制；显式值由管理接口保存，不能再被部署默认值覆盖。
    maxQuickSearch: normalizeLimit(config.maxQuickSearch),
    maxStartupQuickSearch: normalizeLimit(config.maxStartupQuickSearch),
    startupSiteLimit: 0,
    maxParses: normalizeLimit(config.maxParses),
    retainCredentialSources: retainCredentialMode !== 'off',
    retainCredentialMode,
    retainedCredentialKeys: Array.isArray(config.retainedCredentialKeys)
      ? [...new Set(config.retainedCredentialKeys.filter((key): key is string => typeof key === 'string'))]
      : [],
    blockedKeys: Array.isArray(config.blockedKeys)
      ? [...new Set(config.blockedKeys.filter((key): key is string => typeof key === 'string'))]
      : [],
    autoLimit: false,
    pinnedKeys: Array.isArray(config.pinnedKeys) ? config.pinnedKeys : [],
    sortBySpeed: config.sortBySpeed === true,
    leanStartup: config.leanStartup !== false,
    startupMode: config.startupMode === 'full' ? 'full' : 'lean',
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

function withSourceLabel(site: TVBoxSite, siteSourceMap: Map<string, string>): TVBoxSite {
  if (site.searchable !== 1) return site;
  const sourceName = siteSourceMap.get(site.key);
  if (sourceName && site.name && !site.name.includes('「')) {
    const label = sourceName.length > 6 ? sourceName.substring(0, 6) : sourceName;
    return { ...site, name: site.name + ' 「' + label + '」' };
  }
  return site;
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

const QUALITY_EXCELLENT_MS = 1000;
const QUALITY_GOOD_MS = 3000;
const QUALITY_USABLE_MS = 6000;

function createEmptyQualityGrades(): SiteQualityGrades {
  return {
    excellent: { count: 0, cumulative: 0 },
    good: { count: 0, cumulative: 0 },
    usable: { count: 0, cumulative: 0 },
    credentialReady: { count: 0, cumulative: 0 },
    untestable: { count: 0, cumulative: 0 },
    timeout: { count: 0, cumulative: 0 },
    unusable: { count: 0, cumulative: 0 },
    poolTotal: 0,
  };
}

/**
 * 基于本次验活结果、历史连续失败次数和测速延迟，对“未截断的可搜索候选池”分级。
 * 探测预算耗尽时复用历史健康记录，避免把此前稳定可用的源误归为 unknown。
 * 不额外发请求；不可用源不进入 poolTotal，但会保留在 unusable 统计中。
 */
function getSiteQualityGrade(
  site: TVBoxSite,
  probeMap?: Map<string, SiteProbeResult>,
  healthMap?: SiteHealthMap,
): SiteQualityGrade {
  // 客户端 JAR/扩展或网盘登录型源没有可由服务端直接请求的 URL；
  // 它们不是“超时”，应作为客户端可验证候选保留。
  if (!isSiteProbeable(site)) return 'untestable';
  const probe = probeMap?.get(site.key);
  const health = healthMap?.[site.key];
  const failures = probe?.consecutiveFailures ?? health?.consecutiveFailures ?? 0;
  const hasPriorSuccess = !!health?.lastSuccessTime || !!probe?.lastSuccessTime;
  const historicalHealthy = !!health && failures < 3
    && (health.lastProbeResult === 'ok' || hasPriorSuccess);

  // 本次没有完成探测：优先使用历史健康度，避免预算耗尽导致好源被降级。
  if (!probe || probe.result === 'not_probed') {
    if (failures >= 3) return 'unusable';
    return historicalHealthy ? 'usable' : 'timeout';
  }

  if (probe.result === 'error' || probe.result === 'empty') return 'unusable';
  if (probe.result === 'timeout') return failures >= 3 ? 'unusable' : 'timeout';

  const speed = probe.speedMs;
  if (failures >= 3 || speed == null) return 'timeout';
  if (speed <= QUALITY_EXCELLENT_MS) return 'excellent';
  if (speed <= QUALITY_GOOD_MS) return 'good';
  if (speed <= QUALITY_USABLE_MS) return 'usable';
  return 'timeout';
}

function buildQualityGrades(
  candidateSites: TVBoxSite[],
  probeMap?: Map<string, SiteProbeResult>,
  healthMap?: SiteHealthMap,
): SiteQualityGrades {
  const grades = createEmptyQualityGrades();
  for (const site of candidateSites) {
    const grade = getSiteQualityGrade(site, probeMap, healthMap);
    if (grade === 'credential-ready') grades.credentialReady.count++;
    else grades[grade].count++;
    if (grade !== 'timeout' && grade !== 'unusable') grades.poolTotal++;
  }

  let cumulative = 0;
  for (const bucket of ['excellent', 'good', 'usable', 'credentialReady', 'untestable', 'timeout'] as const) {
    cumulative += grades[bucket].count;
    grades[bucket].cumulative = cumulative;
  }
  grades.unusable.cumulative = grades.unusable.count;
  return grades;
}
export interface SearchQuotaApplyOptions {
  speedMap?: Map<string, number | null>;
  probeMap?: Map<string, SiteProbeResult>;
  healthMap?: SiteHealthMap;
  qualityPool?: SearchQualitySnapshot | null;
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
): { sites: TVBoxSite[]; candidateSites: TVBoxSite[]; quotaReport: SearchQuotaReport } {
  const limit = normalizeLimit(config.maxSearchable);
  const quickLimit = normalizeLimit(config.maxQuickSearch);
  const speedMap = options.speedMap;
  const totalSites = options.totalSites ?? sites.length;
  const qualityPool = options.qualityPool;
  const qualityEntries = new Map<string, SearchQualitySnapshot['entries'][number]>();
  const qualityOrder = new Map<string, number>();
  if (qualityPool && Array.isArray(qualityPool.entries)) {
    qualityPool.entries.forEach((entry, index) => {
      if (!qualityEntries.has(entry.key)) {
        qualityEntries.set(entry.key, entry);
        qualityOrder.set(entry.key, index);
      }
    });
  }
  const gradeForSite = (site: TVBoxSite): SiteQualityGrade => {
    const persisted = qualityEntries.get(site.key);
    if (persisted) return persisted.grade;
    return getSiteQualityGrade(site, options.probeMap, options.healthMap);
  };

  // 显式屏蔽优先于置顶、凭证/JAR 保留和质量顺序。屏蔽项仍保留在
  // 完整后台快照中供管理页取消屏蔽，但不会进入任何客户端出口。
  const blockedKeySet = new Set((config.blockedKeys || []).filter((key): key is string => typeof key === 'string'));

  // 置顶源按 pinnedKeys 顺序排到最前，重复 key 只保留一次。
  const siteByKey = new Map(sites.map(site => [site.key, site]));
  const pinned: TVBoxSite[] = [];
  const pinnedKeySet = new Set<string>();
  for (const key of config.pinnedKeys || []) {
    if (blockedKeySet.has(key)) continue;
    const site = siteByKey.get(key);
    if (site && !pinnedKeySet.has(key)) {
      pinned.push(site);
      pinnedKeySet.add(key);
    }
  }

  // 优/良/可用/客户端不可探测源进入客户端候选池；超时与不可用均不可绕过，置顶也不能例外。
  const isUsableForSearch = (site: TVBoxSite): boolean => {
    const grade = gradeForSite(site);
    return grade === 'excellent' || grade === 'good' || grade === 'usable' || grade === 'credential-ready' || grade === 'untestable';
  };
  const pinnedSearchable = pinned.filter(site => site.searchable === 1 && isUsableForSearch(site));
  let candidates = sites.filter(site => site.searchable === 1 && !pinnedKeySet.has(site.key) && !blockedKeySet.has(site.key) && isUsableForSearch(site));

  // 可选：凭证就绪与客户端登录/JAR 源额外保留，不占用可测速源 maxSearchable 配额。
  // 它们仍需排除 timeout/unusable，也不会绕过置顶规则。
  const retainCredentialMode: 'off' | 'all' | 'selected' =
    config.retainCredentialMode === 'all' || config.retainCredentialMode === 'selected'
      ? config.retainCredentialMode
      : (config.retainCredentialSources === true ? 'all' : 'off');
  const retainedCredentialKeySet = new Set(config.retainedCredentialKeys || []);
  const isExtraCredentialSource = (site: TVBoxSite): boolean => {
    if (blockedKeySet.has(site.key)) return false;
    if (retainCredentialMode === 'off') return false;
    if (retainCredentialMode === 'selected' && !retainedCredentialKeySet.has(site.key)) return false;
    const persisted = qualityEntries.get(site.key);
    // 有持久化分级时严格尊重分级结果：timeout/unusable 不能被额外保留。
    if (persisted) return persisted.grade === 'credential-ready' || persisted.grade === 'untestable';
    // 无分级数据时按源本身判断，避免候选池尚未建立时误把凭证/JAR 源算入可测速上限。
    return isClientCredentialSite(site) || !isSiteProbeable(site);
  };

  // 质量分级始终优先参与保留决策；sortBySpeed 只控制同质量级别内是否按速度排序。
  // 这样即使关闭速度排序，快但连续失败/响应无效的源也不会挤掉稍慢但稳定可用的好源。
  const qualityRank: Record<SiteQualityGrade, number> = {
    excellent: 0,
    good: 1,
    usable: 2,
    'credential-ready': 3,
    untestable: 4,
    timeout: 5,
    unusable: 6,
  };
  const hasPool = qualityEntries.size > 0;
  const hasProbe = !!options.probeMap && options.probeMap.size > 0;
  const hasHealth = !!options.healthMap && Object.keys(options.healthMap).length > 0;
  const hasQualityData = hasPool || hasProbe || hasHealth;
  const hasSpeed = !!speedMap && speedMap.size > 0;
  const compareSpeed = (a: TVBoxSite, b: TVBoxSite): number => {
    if (!config.sortBySpeed || !speedMap) return 0;
    const aSpeed = speedMap.get(a.key);
    const bSpeed = speedMap.get(b.key);
    const aValid = typeof aSpeed === 'number' && Number.isFinite(aSpeed);
    const bValid = typeof bSpeed === 'number' && Number.isFinite(bSpeed);
    if (aValid && bValid) return (aSpeed as number) - (bSpeed as number);
    if (aValid) return -1;
    if (bValid) return 1;
    return 0;
  };

  let speedSorted = false;
  if (hasQualityData) {
    candidates = [...candidates].sort((a, b) => {
      if (hasPool) {
        const aOrder = qualityOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = qualityOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) return aOrder - bOrder;
      }
      const gradeDiff = qualityRank[gradeForSite(a)] - qualityRank[gradeForSite(b)];
      return gradeDiff !== 0 ? gradeDiff : compareSpeed(a, b);
    });
    speedSorted = config.sortBySpeed && hasSpeed
      && candidates.some(site => typeof speedMap!.get(site.key) === 'number');
  } else if (config.sortBySpeed && hasSpeed) {
    // 没有探测结果时保持旧行为：仍可仅按测速结果排序。
    candidates = [...candidates].sort(compareSpeed);
    speedSorted = candidates.some(site => typeof speedMap!.get(site.key) === 'number');
  }

  // 保存未受 maxSearchable / maxQuickSearch 截断影响的启动候选池。
  // 置顶源始终在最前；其余源沿用上面的测速顺序。根地址只从
  // 这个池按后台配置取前 N 个，不会改写最终配置。
  // 候选池只做质量可用性过滤，不再按 type 或 quickSearch 预过滤。
  // 根配置会在读取时按 maxStartupQuickSearch 重新应用策略；否则
  // quickSearch=0 的历史对象一旦被写进候选池，后续永远无法恢复。
  const startupCandidateSites = [
    ...pinnedSearchable,
    ...candidates,
  ];

  // 先确定普通搜索保留集合；置顶源不受截断影响。
  let keptCandidates = candidates;
  let truncated = 0;
  if (limit > 0) {
    const effectiveLimit = Math.max(limit, pinnedSearchable.length);
    const keepCount = Math.max(0, effectiveLimit - pinnedSearchable.length);
    const pooledCandidates = candidates.filter(site => !isExtraCredentialSource(site));
    const retainedCredentialCandidates = candidates.filter(isExtraCredentialSource);
    keptCandidates = [...pooledCandidates.slice(0, keepCount), ...retainedCredentialCandidates];

    const keptKeys = new Set(keptCandidates.map(site => site.key));
    truncated = new Set(
      candidates
        .filter(site => !keptKeys.has(site.key))
        .map(site => site.key),
    ).size;
  }

  const keptCandidateKeys = new Set(keptCandidates.map(site => site.key));
  const allowedSearchableKeys = new Set<string>([...pinnedKeySet, ...keptCandidateKeys]);
  for (const key of blockedKeySet) allowedSearchableKeys.delete(key);

  // 快速搜索独立限制：不会删除站点，只把 quickSearch 置 0。
  // 0 表示不限制，与 maxSearchable=0 的语义保持一致。
  const quickCandidates = [
    ...pinned.filter(site => site.searchable === 1 && site.quickSearch !== 0 && !blockedKeySet.has(site.key)),
    ...keptCandidates.filter(site => site.searchable === 1 && site.quickSearch !== 0 && !blockedKeySet.has(site.key)),
  ];
  const allowedQuickKeys = new Set(
    quickLimit > 0
      ? quickCandidates.slice(0, quickLimit).map(site => site.key)
      : quickCandidates.map(site => site.key),
  );

  // 先完成排序，再按最终顺序一次性应用所有配额，避免旧数组对象把已截断的
  // quickSearch 状态重新带回来。只要本次探测产生了质量数据，就始终按质量顺序
  // 输出；sortBySpeed 只决定同一质量等级内部是否再按速度排序。
  let orderedSites: TVBoxSite[];
  if (hasQualityData || (config.sortBySpeed && speedSorted)) {
    const ordered = [...pinned, ...keptCandidates];
    const orderedKeys = new Set(ordered.map(site => site.key));
    const rest = sites.filter(site => !orderedKeys.has(site.key));
    orderedSites = [...ordered, ...rest];
  } else {
    const rest = sites.filter(site => !pinnedKeySet.has(site.key));
    orderedSites = [...pinned, ...rest];
  }

  let quickTruncated = 0;
  sites = orderedSites.filter(site => !blockedKeySet.has(site.key)).map(site => {
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
  sites = sites.map(site => withSourceLabel(site, siteSourceMap));
  const labeledCandidates = startupCandidateSites
    .filter(site => !blockedKeySet.has(site.key))
    .map(site => withSourceLabel(site, siteSourceMap));
  // 质量统计覆盖完整的未截断可搜索候选池（置顶源 + 普通候选源），
  // 不再只统计根地址启动池，便于前端按实际质量区间配置 maxSearchable。
  const allSearchableCandidates = [...pinnedSearchable, ...candidates];
  const qualityGrades = qualityPool?.grades
    ? qualityPool.grades
    : buildQualityGrades(allSearchableCandidates, options.probeMap, options.healthMap);

  const searchable = sites.filter(site => site.searchable === 1).length;
  const quickSearchable = sites.filter(site => site.searchable === 1 && site.quickSearch !== 0).length;
  const pinnedCount = pinnedSearchable.length;
  const blockedCount = blockedKeySet.size;

  return {
    sites,
    candidateSites: labeledCandidates,
    quotaReport: {
      totalSites,
      jsExcluded: options.jsExcluded ?? 0,
      searchable,
      quickSearchable,
      maxSearchable: limit,
      maxQuickSearch: quickLimit,
      autoLimit: config.autoLimit === true,
      pinnedCount,
      blockedCount,
      truncated,
      quickTruncated,
      speedSorted,
      leanRemoved,
      qualityGrades,
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
        // 其他 4xx/5xx 是已证实的失效入口，保留在 keep=false 分支等待剔除。
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
