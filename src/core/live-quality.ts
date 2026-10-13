import type { SourceSelectionMode } from './types';

// 直播源统一质量模型：分类、格式、评分与稳定排序。
// 该模块仅依赖类型定义，供 CF 分离清单、Render 频道合并、管理端与
// 根链接/鉴权码下发策略共用，避免不同运行时各用一套排序口径。

export type LiveSourceKind = 'aggregated' | 'manual';
export type LiveSourceFormat = 'm3u' | 'txt' | 'native' | 'unknown';
export type LiveSourceHealth = 'healthy' | 'unhealthy';

export type LiveCategory = 'cctv' | 'satellite' | 'local' | 'variety' | 'special' | 'ipv6' | 'other';

export const LIVE_CATEGORIES: readonly LiveCategory[] = [
  'cctv',
  'satellite',
  'local',
  'variety',
  'special',
  'ipv6',
  'other',
];

export const LIVE_CATEGORY_LABELS: Readonly<Record<LiveCategory, string>> = {
  cctv: '央视',
  satellite: '卫视',
  local: '地方',
  variety: '轮播/娱乐',
  special: '4K/特色',
  ipv6: 'IPv6',
  other: '其他',
};

export const LIVE_FORMAT_LABELS: Readonly<Record<LiveSourceFormat, string>> = {
  m3u: 'M3U',
  txt: 'TXT',
  native: 'Native',
  unknown: '未知',
};

export const LIVE_KIND_LABELS: Readonly<Record<LiveSourceKind, string>> = {
  aggregated: '上游配置',
  manual: '手动添加',
};

export function liveCategoryOrder(category: LiveCategory | undefined): number {
  const index = LIVE_CATEGORIES.indexOf((category || 'other') as LiveCategory);
  return index < 0 ? LIVE_CATEGORIES.length : index;
}

export function normalizeLiveCategory(value: unknown): LiveCategory {
  return typeof value === 'string' && (LIVE_CATEGORIES as readonly string[]).includes(value)
    ? (value as LiveCategory)
    : 'other';
}

export function normalizeLiveSourceFormat(value: unknown): LiveSourceFormat {
  return value === 'm3u' || value === 'txt' || value === 'native' ? value : 'unknown';
}

/** 依据源 URL 后缀判断直播文件格式（仅用于展示与排序，不参与门禁）。 */
export function liveSourceFormatFromUrl(url: string): LiveSourceFormat {
  const value = (url || '').trim().toLowerCase();
  const path = value.split(/[?#]/)[0];
  if (path.endsWith('.m3u') || path.endsWith('.m3u8')) return 'm3u';
  if (path.endsWith('.txt')) return 'txt';
  if (path.endsWith('.json')) return 'native';
  return 'unknown';
}

const IPV6_HINT = /ipv6|v6[._-]/i;
const SPECIAL_HINT = /4k|8k|超高清|蓝光|杜比|hdr/i;
const VARIETY_HINT = /轮播|一起看|娱乐|电影|电视剧|综艺|动漫|音乐|戏曲|咪视界|春晚|少儿|纪录|体育|游戏|虎牙|斗鱼|yy/i;
const SATELLITE_HINT = /卫视|凤凰|翡翠|明珠|澳视|星空|discovery|nhk|hbo|cnn|bbc/i;
const LOCAL_HINT = /地方|城市|省|市|县|区|浙江|江苏|广东|山东|河南|河北|湖南|湖北|四川|福建|安徽|江西|辽宁|吉林|黑龙江|山西|陕西|甘肃|青海|云南|贵州|广西|海南|内蒙|新疆|西藏|宁夏|北京|上海|天津|重庆|深圳|杭州|南京|广州|成都|武汉|西安|苏州|青岛|大连|厦门/i;
const CCTV_HINT = /cctv|中央|央视/i;

/**
 * 依据一个直播源解析出的分组名，判定该源的主要分类。
 * 采用“出现次数最多的分类桶”策略；央视/卫视等强类型桶给更高优先级，
 * 避免一个源里偶发的“地方”分组把央视源整体判错。
 */
export function classifyLiveCategory(groups: readonly string[]): LiveCategory {
  let ipv6 = 0;
  let special = 0;
  let cctv = 0;
  let satellite = 0;
  let variety = 0;
  let local = 0;
  for (const raw of groups) {
    const group = (raw || '').trim();
    if (!group) continue;
    if (IPV6_HINT.test(group)) { ipv6++; continue; }
    if (SPECIAL_HINT.test(group)) { special++; continue; }
    if (CCTV_HINT.test(group)) { cctv++; continue; }
    if (SATELLITE_HINT.test(group)) { satellite++; continue; }
    if (VARIETY_HINT.test(group)) { variety++; continue; }
    if (LOCAL_HINT.test(group)) { local++; continue; }
  }
  const ranked: Array<[LiveCategory, number]> = [
    ['cctv', cctv],
    ['satellite', satellite],
    ['variety', variety],
    ['local', local],
    ['special', special],
    ['ipv6', ipv6],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : 'other';
}

/** 单个直播源的质量度量。缺省字段按中性处理，避免未测量的源被误判为差。 */
export interface LiveSourceMetrics {
  health?: LiveSourceHealth;
  /** 是否曾经成功过（有成功历史才允许临时失败作为后备） */
  everSucceeded?: boolean;
  channelCount?: number;
  totalEntries?: number;
  usableEntries?: number;
  /** 已知测速线路中的可用比例 0..1；未知时按中性处理 */
  playableRatio?: number | null;
  /** 广告/状态条目占比 0..1 */
  adRatio?: number | null;
  /** 整源下载耗时（毫秒） */
  downloadMs?: number | null;
  /** 最近一次成功时间（ISO） */
  successfulAt?: string | null;
  lastFailure?: 'transient' | 'invalid';
  now?: number;
}

const NEUTRAL_PLAYABLE_RATIO = 0.7;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function healthComponent(metrics: LiveSourceMetrics): number {
  if (metrics.health === 'healthy') return 30;
  if (metrics.lastFailure === 'invalid') return 0;
  if (metrics.everSucceeded) return 12;
  return 0;
}

function coverageComponent(channels: number): number {
  if (!Number.isFinite(channels) || channels <= 0) return 0;
  // 40 个以上频道视为覆盖满分，少量源按线性折算。
  return Math.min(25, (channels / 40) * 25);
}

function playableComponent(ratio: number | null | undefined): number {
  const value = ratio == null ? NEUTRAL_PLAYABLE_RATIO : clamp01(ratio);
  return value * 25;
}

function speedComponent(downloadMs: number | null | undefined): number {
  if (downloadMs == null || !Number.isFinite(downloadMs) || downloadMs <= 0) return 7;
  if (downloadMs <= 500) return 12;
  if (downloadMs <= 1000) return 10;
  if (downloadMs <= 2000) return 7;
  if (downloadMs <= 4000) return 3;
  return 0;
}

function freshnessComponent(successfulAt: string | null | undefined, now: number): number {
  if (!successfulAt) return 0;
  const at = Date.parse(successfulAt);
  if (!Number.isFinite(at)) return 0;
  const ageMs = Math.max(0, now - at);
  const day = 24 * 60 * 60 * 1000;
  if (ageMs <= day) return 8;
  if (ageMs <= 3 * day) return 6;
  if (ageMs <= 7 * day) return 3;
  return 0;
}

/**
 * 计算 0-100 的直播源质量分：健康度、频道覆盖、可播比例、
 * 下载速度、新鲜度五项加权，再按广告占比扣分。
 * 分数取整以保证排序稳定（微小的浮点抖动不会改变名次）。
 */
export function computeLiveSourceQualityScore(metrics: LiveSourceMetrics): number {
  const now = metrics.now ?? Date.now();
  const health = healthComponent(metrics);
  const coverage = coverageComponent(metrics.channelCount ?? 0);
  const playable = playableComponent(metrics.playableRatio);
  const speed = speedComponent(metrics.downloadMs);
  const freshness = freshnessComponent(metrics.successfulAt, now);
  const adPenalty = clamp01(metrics.adRatio ?? 0) * 20;
  const score = health + coverage + playable + speed + freshness - adPenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 是否具备下发资格：未验证和临时失败均可进入质量池，明确失效才排除。 */
export function isLiveSourceDistributable(metrics: LiveSourceMetrics): boolean {
  if (metrics.lastFailure === 'invalid') return false;
  return true;
}

/**
 * 把某一轮逐源度量按结果分流为 valid / transient / invalid 三组 URL。
 * 关键点：明确 invalid（解析失败、内容不是直播）绝不能混入 transient，
 * 否则清单合并会把 invalid 覆盖成 transient，明确失效源永远无法被淘汰。
 */
export function partitionMergeSourceMetrics(
  metricsByUrl: Record<string, LiveSourceMetrics>,
): { validUrls: string[]; transientUrls: string[]; invalidUrls: string[] } {
  const validUrls: string[] = [];
  const transientUrls: string[] = [];
  const invalidUrls: string[] = [];
  for (const url of Object.keys(metricsByUrl)) {
    const metrics = metricsByUrl[url];
    if (metrics?.health === 'healthy') {
      validUrls.push(url);
    } else if (metrics?.lastFailure === 'invalid') {
      invalidUrls.push(url);
    } else {
      // 未验证或临时失败：保留下发资格并排在健康源之后，不能当成明确失效删除。
      transientUrls.push(url);
    }
  }
  return { validUrls, transientUrls, invalidUrls };
}
/** 排序用的归一化视图，供清单条目与质量池条目共用。 */
export interface LiveRankView {
  health?: LiveSourceHealth;
  everSucceeded?: boolean;
  lastFailure?: 'transient' | 'invalid';
  qualityScore?: number;
  channelCount?: number;
  playableRatio?: number | null;
  adRatio?: number | null;
  downloadMs?: number | null;
  successfulAt?: string | null;
  category?: LiveCategory;
  key?: string;
  url?: string;
}

/**
 * 分发排序的第一优先级：本轮健康 > 历史成功后备 > 从未验证。
 * 质量分仍决定每个等级内部的优劣，但不能让历史高分遮蔽当前不可用源。
 */
function liveAvailabilityTier(entry: LiveRankView): number {
  if (entry.lastFailure === 'invalid') return -1;
  if (entry.health === 'healthy') return 2;
  if (entry.everSucceeded || entry.successfulAt) return 1;
  return 0;
}

function finite(value: number | null | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

/**
 * 稳定的直播源质量排序。分数相同的源再按覆盖、可播率、速度、
 * 分类与 key 依次比较，保证同一批源在任何运行时都得到一致顺序。
 */
export function compareLiveRank(a: LiveRankView, b: LiveRankView): number {
  const aDist = isLiveSourceDistributable(a) ? 1 : 0;
  const bDist = isLiveSourceDistributable(b) ? 1 : 0;
  if (aDist !== bDist) return bDist - aDist;

  // 先保证当前健康源优先，再比质量分；历史后备与未验证源仍保留在质量池。
  const aTier = liveAvailabilityTier(a);
  const bTier = liveAvailabilityTier(b);
  if (aTier !== bTier) return bTier - aTier;

  const aScore = finite(a.qualityScore, 0);
  const bScore = finite(b.qualityScore, 0);
  if (aScore !== bScore) return bScore - aScore;

  const aChannels = finite(a.channelCount, 0);
  const bChannels = finite(b.channelCount, 0);
  if (aChannels !== bChannels) return bChannels - aChannels;

  const aPlayable = finite(a.playableRatio, NEUTRAL_PLAYABLE_RATIO);
  const bPlayable = finite(b.playableRatio, NEUTRAL_PLAYABLE_RATIO);
  if (aPlayable !== bPlayable) return bPlayable - aPlayable;

  const aAd = finite(a.adRatio, 0);
  const bAd = finite(b.adRatio, 0);
  if (aAd !== bAd) return aAd - bAd;

  const aSpeed = finite(a.downloadMs, Number.POSITIVE_INFINITY);
  const bSpeed = finite(b.downloadMs, Number.POSITIVE_INFINITY);
  if (aSpeed !== bSpeed) return aSpeed - bSpeed;

  const aSuccess = Date.parse(a.successfulAt || '') || 0;
  const bSuccess = Date.parse(b.successfulAt || '') || 0;
  if (aSuccess !== bSuccess) return bSuccess - aSuccess;

  const aCat = liveCategoryOrder(a.category);
  const bCat = liveCategoryOrder(b.category);
  if (aCat !== bCat) return aCat - bCat;

  return (a.key || a.url || '').localeCompare(b.key || b.url || '');
}


/**
 * 直播源下发选择策略（与点播源分离，独立持久化）。
 * 三层语义：
 *   候选池 = 去重/屏蔽过滤后的全部上游直播入口
 *   质量池 = 通过下载解析门禁，或历史成功且未确认失效的入口
 *   下发池 = 质量排序 + 简单/分类/置顶选择后的最终入口
 */
export interface LiveDistributionPolicy {
  selectionMode: SourceSelectionMode;
  /** 简单模式下发数量上限：-1=质量池全部；0=不下发；正数=质量排序 Top N */
  maxSources: number;
  /** 分类模式各分类上限；未配置=不限制该分类；0=不选；-1=全部；正数=该分类 Top N */
  bucketLimits?: Partial<Record<LiveCategory, number>>;
  /** 置顶 key：仅调整顺序，不绕过质量/分类/数量门禁 */
  pinnedKeys?: readonly string[];
  /** 管理端主动屏蔽的 key：直接排除在下发池之外（不参与排序，也不因置顶恢复） */
  blockedKeys?: readonly string[];
}

export const DEFAULT_LIVE_DISTRIBUTION_POLICY: LiveDistributionPolicy = {
  selectionMode: 'simple',
  maxSources: -1,
  pinnedKeys: [],
  blockedKeys: [],
};

function parseThreeState(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return fallback;
  if (number === -1 || number >= 0) return number;
  return fallback;
}

/** 规范化任意来源的直播下发策略，容忍缺省与历史脏数据。 */
export function normalizeLiveDistributionPolicy(raw: unknown): LiveDistributionPolicy {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const selectionMode: SourceSelectionMode = source.selectionMode === 'category' ? 'category' : 'simple';
  const maxSources = parseThreeState(source.maxSources, -1);
  const pinnedKeys = Array.isArray(source.pinnedKeys)
    ? [...new Set(source.pinnedKeys.filter((key): key is string => typeof key === 'string').map((key) => key.trim()).filter(Boolean))]
    : [];
  const blockedKeys = Array.isArray(source.blockedKeys)
    ? [...new Set(source.blockedKeys.filter((key): key is string => typeof key === 'string').map((key) => key.trim()).filter(Boolean))]
    : [];
  let bucketLimits: Partial<Record<LiveCategory, number>> | undefined;
  const rawBuckets = source.bucketLimits;
  if (rawBuckets && typeof rawBuckets === 'object' && !Array.isArray(rawBuckets)) {
    const buckets = rawBuckets as Record<string, unknown>;
    const next: Partial<Record<LiveCategory, number>> = {};
    for (const category of LIVE_CATEGORIES) {
      if (!Object.prototype.hasOwnProperty.call(buckets, category)) continue;
      next[category] = parseThreeState(buckets[category], -1);
    }
    if (Object.keys(next).length > 0) bucketLimits = next;
  }
  return {
    selectionMode,
    maxSources,
    ...(bucketLimits ? { bucketLimits } : {}),
    pinnedKeys,
    blockedKeys,
  };
}

/**
 * 从质量池（已按 compareLiveRank 排序）按策略选出下发池。
 *
 * 关键原则：
 * - 简单模式取统一质量排名 Top-N；全选(-1)即整个质量池，绝不隐式截断。
 * - 分类模式对每个分类在其自身的质量池内独立取 Top-N，保证“该分类最优”。
 * - 未在 bucketLimits 中出现的分类默认不限制（全部下发）。
 * - 置顶仅把已入选的源前移；不会把未入选/被否决的源带入下发池。
 * - 全流程保持质量排序稳定，重复调用结果一致。
 */
export function selectLiveDistribution<T extends LiveRankView>(
  rankedPool: readonly T[],
  policy: LiveDistributionPolicy,
): T[] {
  const normalized = normalizeLiveDistributionPolicy(policy);
  const blocked = new Set(normalized.blockedKeys || []);
  const allowed = rankedPool.filter((entry) => {
    if (!isLiveSourceDistributable(entry)) return false;
    const key = entry.key || entry.url || '';
    return key === '' || !blocked.has(key);
  });
  let selected: T[];

  if (normalized.selectionMode === 'simple') {
    selected = normalized.maxSources < 0
      ? [...allowed]
      : allowed.slice(0, normalized.maxSources);
  } else {
    const limits = normalized.bucketLimits;
    const perCategoryCount = new Map<LiveCategory, number>();
    selected = [];
    for (const entry of allowed) {
      const category = normalizeLiveCategory(entry.category);
      if (limits) {
        if (Object.prototype.hasOwnProperty.call(limits, category)) {
          const limit = limits[category] as number;
          if (limit === 0) continue;
          if (limit > 0) {
            const used = perCategoryCount.get(category) ?? 0;
            if (used >= limit) continue;
            perCategoryCount.set(category, used + 1);
          }
        }
      }
      selected.push(entry);
    }
  }

  // 置顶：仅在已入选集合内前移，保持各自相对顺序。
  const pinnedOrder = new Map(
    (normalized.pinnedKeys || []).map((key, index) => [key, index] as const),
  );
  if (pinnedOrder.size === 0) return selected;
  const pinned = selected
    .filter((entry) => pinnedOrder.has(entry.key || entry.url || ''))
    .sort((a, b) => (pinnedOrder.get(a.key || a.url || '') as number) - (pinnedOrder.get(b.key || b.url || '') as number));
  const pinnedSet = new Set(pinned.map((entry) => entry.key || entry.url || ''));
  return [
    ...pinned,
    ...selected.filter((entry) => !pinnedSet.has(entry.key || entry.url || '')),
  ];
}
