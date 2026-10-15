// 直播源频道级合并（方案 D+）
// 流程：下载各源 m3u/txt → 解析为频道条目 → 规范化频道名 → 按频道合并 urls → 排序 → 组装 TVBoxLiveGroup[]

import type {
  TVBoxLiveGroup,
  TVBoxLiveChannel,
  ChannelSpeedMap,
  LiveSourceCacheEntry,
} from './types';
import type { Storage } from '../storage/interface';
import { TVBOX_UA, BROWSER_UA, KV_LIVE_SOURCE_CACHE } from './config';
import { isBlockedLiveSource, isBlockedLiveUrl } from './live-policy';
import { classifyLiveCategory, compareLiveRank, computeLiveSourceQualityScore, type LiveCategory, type LiveSourceMetrics } from './live-quality';

// ─── 输入条目 ──────────────────────────────────────────

export interface LiveSourceInput {
  name: string;     // 源显示名
  url: string;      // m3u/txt 文件地址
  ua?: string;
  header?: Record<string, string>;
  speedMs?: number; // 源级速度（用于粗粒度排序）
  isAggregated?: boolean; // 是否为来自第三方配置源合并来的直播源
}

// ─── 下载缓存 ──────────────────────────────────────────

const LIVE_SOURCE_CACHE_TTL_MS = 30 * 60 * 1000;
const LIVE_SOURCE_CACHE_MAX_CONTENT = 512 * 1024;
const LIVE_SOURCE_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const LIVE_SOURCE_CACHE_MAX_TOTAL = 2 * 1024 * 1024;

interface CachedLiveSource {
  content: string;
  cachedAt: number;
  lastAccess: number;
  etag?: string;
  lastModified?: string;
  downloadMs?: number;
}

export type LiveDownloadFailure = 'transient' | 'invalid';

function failureFromHttpStatus(status: number): LiveDownloadFailure {
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? 'transient'
    : 'invalid';
}

function looksLikeHtmlError(content: string): boolean {
  const head = content.slice(0, 2048);
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|cloudflare|attention required|error\s+5\d\d/i.test(head);
}

function looksLikeLivePayload(content: string, contentType: string): boolean {
  if (!content || content.length <= 20 || looksLikeHtmlError(content)) return false;
  if (/#EXTM3U|#EXTINF|#genre#/i.test(content)) return true;
  return contentType.includes('mpegurl') || contentType.includes('text/plain');
}

interface DownloadOutcome {
  content: string | null;
  failure?: LiveDownloadFailure;
  reason?: string;
  cacheHit: boolean;
  revalidated: boolean;
  staleFallback: boolean;
  /** 整源下载耗时（毫秒）。缓存命中沿用首次下载耗时；失败为 undefined。 */
  downloadMs?: number;
}

export interface LiveDownloadStats {
  cacheHits: number;
  cacheMisses: number;
  revalidated: number;
  staleFallbacks: number;
  sourceTexts?: Record<string, string>;
}

const liveSourceMemoryCache = new Map<string, CachedLiveSource>();
let liveSourceCacheLoad: Promise<void> | null = null;
let liveSourceCacheSaveQueue: Promise<void> = Promise.resolve();

function liveCacheKey(input: LiveSourceInput, browserFallback = true): string {
  const header = input.header ? JSON.stringify(input.header) : '';
  return input.url + '\n' + (input.ua || '') + '\n' + header + '\n' + (browserFallback ? 'browser' : 'player');
}

function compactLiveSourceCache(): void {
  const entries = Array.from(liveSourceMemoryCache.entries())
    .filter(([, entry]) => entry.content.length <= LIVE_SOURCE_CACHE_MAX_CONTENT)
    .sort((a, b) => b[1].lastAccess - a[1].lastAccess);
  const pruned = new Map<string, CachedLiveSource>();
  let total = 0;
  for (const [key, entry] of entries) {
    if (total + entry.content.length > LIVE_SOURCE_CACHE_MAX_TOTAL) continue;
    pruned.set(key, entry);
    total += entry.content.length;
  }
  liveSourceMemoryCache.clear();
  for (const [key, entry] of pruned) liveSourceMemoryCache.set(key, entry);
}

async function loadPersistentLiveSourceCache(storage?: Storage): Promise<void> {
  if (!storage) return;
  if (liveSourceCacheLoad) return liveSourceCacheLoad;
  const task = (async () => {
    try {
      const raw = await storage.get(KV_LIVE_SOURCE_CACHE);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, LiveSourceCacheEntry>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry.content !== 'string' || entry.content.length <= 20) continue;
        const cachedAt = Date.parse(entry.cachedAt || '') || now;
        const existing = liveSourceMemoryCache.get(key);
        if (existing && existing.cachedAt >= cachedAt) continue;
        liveSourceMemoryCache.set(key, {
          content: entry.content,
          cachedAt,
          lastAccess: now,
          etag: entry.etag,
          lastModified: entry.lastModified,
        });
      }
    } catch {
      // 缓存损坏不影响正常聚合
    }
  })();
  liveSourceCacheLoad = task.finally(() => {
    liveSourceCacheLoad = null;
  });
  return liveSourceCacheLoad;
}

async function persistLiveSourceCache(storage: Storage): Promise<void> {
  compactLiveSourceCache();
  const payload: Record<string, LiveSourceCacheEntry> = {};
  for (const [key, entry] of liveSourceMemoryCache) {
    payload[key] = {
      content: entry.content,
      cachedAt: new Date(entry.cachedAt).toISOString(),
      etag: entry.etag,
      lastModified: entry.lastModified,
    };
  }
  const serialized = JSON.stringify(payload);
  try {
    const existing = await storage.get(KV_LIVE_SOURCE_CACHE);
    if (existing !== serialized) await storage.put(KV_LIVE_SOURCE_CACHE, serialized);
  } catch {
    // 缓存持久化失败不影响聚合
  }
}

async function savePersistentLiveSourceCache(storage?: Storage): Promise<void> {
  if (!storage) return;
  // 串行排队并读取调用时的最新内存缓存，避免保存期间新产生的数据被漏写。
  const task = liveSourceCacheSaveQueue.then(() => persistLiveSourceCache(storage));
  liveSourceCacheSaveQueue = task.catch(() => undefined);
  return task;
}
// ─── 解析后的频道条目 ──────────────────────────────────

interface ChannelEntry {
  group: string;
  name: string;
  logo?: string;
  url: string;
  source: string;       // 源 name，用作 $ 后缀
  sourceSpeedMs?: number;
  /** 本线路所属源的质量分，用于同频道线路统一排序。 */
  sourceQuality?: number;
  /** 本线路所属源在质量池中的排名，数字越小越优。 */
  sourceRank?: number;
  /** 本线路所属源的下载耗时，作为源级测速之外的稳定降级依据。 */
  sourceDownloadMs?: number;
}

// ─── 广告过滤关键字 ────────────────────────────────────
const AD_KEYWORDS = /广告|购物|福利|加微|微\s*信|群|客\s*服|优惠|测试|测\s*试|防走失|专属|添加|关注|订阅|赞助/i;

const SEPARATED_MAX_URLS_PER_CHANNEL = 6;
export const AGGREGATED_MAX_URLS_PER_CHANNEL = 9;
const SEPARATED_MAX_CHANNELS = 12000;
const LIVE_KNOWN_MAX_SPEED_MS = 5000;
const SEPARATED_MIN_CHANNELS_PER_SOURCE = 5;
const SEPARATED_MAX_AD_RATIO = 0.5;
const SEPARATED_MIN_PLAYABLE_RATIO = 0.2;

// ─── 频道名规范化 ──────────────────────────────────────

const TRAD_SIMP_MAP: Record<string, string> = {
  '電': '电', '視': '视', '臺': '台', '頻': '频', '道': '道',
  '綜': '综', '藝': '艺', '體': '体', '育': '育', '劇': '剧',
  '經': '经', '華': '华', '東': '东', '西': '西', '國': '国',
  '際': '际', '亞': '亚', '歐': '欧', '財': '财', '鳳': '凤',
};

const SUFFIX_PATTERNS = [
  /\s*\[?hd\]?$/i,
  /\s*\[?uhd\]?$/i,
  /\s*\[?fhd\]?$/i,
  /\s*高清$/,
  /\s*超清$/,
  /\s*蓝光$/,
  /\s*藍光$/,
  /\s*4k$/i,
  /\s*1080p?$/i,
  /\s*720p?$/i,
];

function normalizeChannelName(raw: string): string {
  let s = raw.trim();
  // 繁→简
  let out = '';
  for (const ch of s) out += TRAD_SIMP_MAP[ch] || ch;
  s = out;
  // 去后缀
  for (const p of SUFFIX_PATTERNS) s = s.replace(p, '');
  // 压空白
  s = s.replace(/\s+/g, '').trim();
  return s || raw.trim(); // 规范化空则退回原名
}

// ─── m3u/txt 解析 ──────────────────────────────────────

/**
 * 解析 m3u 格式
 *   #EXTM3U
 *   #EXTINF:-1 tvg-name="..." tvg-logo="..." group-title="央视",CCTV-1
 *   http://...
 */
function parseM3U(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  const lines = content.split(/\r?\n/);
  const out: ChannelEntry[] = [];
  let currentName = '';
  let currentGroup = '其他';
  let currentLogo: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      // 解析属性
      const grpM = line.match(/group-title="([^"]+)"/i);
      currentGroup = grpM ? grpM[1] : '其他';
      const logoM = line.match(/tvg-logo="([^"]+)"/i);
      currentLogo = logoM ? logoM[1] : undefined;
      const commaIdx = line.lastIndexOf(',');
      currentName = commaIdx > 0 ? line.slice(commaIdx + 1).trim() : '';
    } else if (line.startsWith('#')) {
      continue; // 其他指令忽略
    } else if (currentName && /^https?:\/\//i.test(line)) {
      out.push({
        group: currentGroup,
        name: currentName,
        logo: currentLogo,
        url: line,
        source,
        sourceSpeedMs,
      });
      currentName = '';
      currentLogo = undefined;
    }
  }
  return out;
}

/**
 * 解析 DIYP/txt 格式
 *   央视,#genre#
 *   CCTV-1,http://url1#http://url2
 *   CCTV-2,http://...
 */
function parseTxt(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  const lines = content.split(/\r?\n/);
  const out: ChannelEntry[] = [];
  let currentGroup = '其他';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const idx = line.indexOf(',');
    if (idx <= 0) continue;
    const left = line.slice(0, idx).trim();
    const right = line.slice(idx + 1).trim();

    if (right === '#genre#') {
      currentGroup = left || '其他';
      continue;
    }

    // 右侧可能包含多个 URL，用 # 分隔
    const urls = right.split('#').filter((u) => /^https?:\/\//i.test(u.trim()));
    for (const u of urls) {
      out.push({
        group: currentGroup,
        name: left,
        url: u.trim(),
        source,
        sourceSpeedMs,
      });
    }
  }
  return out;
}

async function shortSourceHash(url: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(url);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    return Array.from(bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '00000000';
  }
}

async function uniqueSourceLabel(rawName: string, url: string, used: Set<string>): Promise<string> {
  const base = sanitizeTxtLabel(rawName || 'source', 'source');
  const candidate = base + '#' + (await shortSourceHash(url));
  if (!used.has(candidate)) { used.add(candidate); return candidate; }
  let index = 2;
  while (used.has(candidate + '-' + index)) index += 1;
  const fallback = candidate + '-' + index;
  used.add(fallback);
  return fallback;
}

function sanitizeTxtLabel(label: string, fallback: string): string {
  const cleaned = label.replace(/[\r\n]+/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

/**
 * 频道自然排序：央视主频道按 CCTV 数字顺序排列，5+ 紧跟在 5 后，
 * 其他频道再用中文数字感知比较，避免上游顺序导致 CCTV1/2/3 乱序。
 */
function cctvChannelRank(name: string): number | null {
  const match = name.match(/(?:CCTV|中央|央视)[-_\s]*0*(\d{1,2})(\+)?/i);
  if (!match) return null;
  return Number(match[1]) * 10 + (match[2] ? 1 : 0);
}

export function compareLiveChannelNames(a: string, b: string): number {
  const rankA = cctvChannelRank(a);
  const rankB = cctvChannelRank(b);
  if (rankA != null && rankB != null && rankA !== rankB) return rankA - rankB;
  if (rankA != null && rankB == null) return -1;
  if (rankA == null && rankB != null) return 1;
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

/** 仅按频道名稳定排序，保留调用方原有的直播源分组顺序。 */
export function sortLiveGroupsForOutput(groups: TVBoxLiveGroup[]): TVBoxLiveGroup[] {
  return groups.map((group) => ({
    ...group,
    channels: [...(group.channels || [])].sort((a, b) => compareLiveChannelNames(a.name, b.name)),
  }));
}
/**
 * 将 TVBox Native live groups 转为 DIYP/txt 格式：
 *   央视,#genre#
 *   CCTV-1,http://url1$源A#http://url2$源B
 *
 * 单源代理输出必须尽量保持上游分组和频道名原样，因此这里只做换行/逗号
 * 安全清洗、同名分组头合并和同频道重复 URL 清理，不做跨名称归一。
 * 全局聚合的额外归一只在 formatAggregatedLiveGroupsAsTxt 中执行。
 */
const MAX_AGGREGATE_CHANNELS_PER_GROUP = 180;

function formatLiveGroupsAsTxtInternal(
  groups: TVBoxLiveGroup[],
  canonicalizeChannels: boolean,
  maxChannelsPerGroup?: number,
): string {
  interface OutputChannel {
    name: string;
    urls: string[];
    seenUrls: Set<string>;
  }

  const groupChannels = new Map<string, Map<string, OutputChannel>>();

  for (const group of sortLiveGroupsForOutput(groups)) {
    const groupName = sanitizeTxtLabel(group.group || '', '其他');
    let channels = groupChannels.get(groupName);
    if (!channels) {
      channels = new Map<string, OutputChannel>();
      groupChannels.set(groupName, channels);
    }

    for (const channel of group.channels || []) {
      const urls = (channel.urls || []).map((url) => url.trim()).filter(Boolean);
      if (urls.length === 0) continue;

      const rawChannelName = sanitizeTxtLabel(channel.name || '', '未命名');
      const channelName = canonicalizeChannels
        ? canonicalAggregateChannelName(rawChannelName)
        : rawChannelName;
      const channelKey = channelName.toLocaleLowerCase('zh-CN');
      let output = channels.get(channelKey);
      if (!output) {
        output = { name: channelName, urls: [], seenUrls: new Set<string>() };
        channels.set(channelKey, output);
      }

      for (const url of urls) {
        const dedupeKey = bareLiveUrl(url) || url;
        if (output.seenUrls.has(dedupeKey)) continue;
        output.seenUrls.add(dedupeKey);
        output.urls.push(url);
      }
    }
  }

  const lines: string[] = [];
  for (const [groupName, channels] of groupChannels) {
    const outputChannels = [...channels.values()]
      .filter((channel) => channel.urls.length > 0)
      .sort((a, b) => compareLiveChannelNames(a.name, b.name));
    if (outputChannels.length === 0) continue;

    // 客户端没有真正的三级目录能力，超大分类按稳定排序后的频道分页为
    // “一级·二级01/02”，既不丢频道，也能避免单个目录过长。
    // 地方目录已经按省市拆分，即使省份频道较多也应保持“地方·省份”
    // 完整可读；只对跨节目主题的超大分类做容量分页。
    const allowPaging = maxChannelsPerGroup && maxChannelsPerGroup > 0
      && !/^地方·/.test(groupName);
    const pageSize = allowPaging ? maxChannelsPerGroup : outputChannels.length;
    const pageCount = Math.max(1, Math.ceil(outputChannels.length / pageSize));
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const start = pageIndex * pageSize;
      const pageChannels = outputChannels.slice(start, start + pageSize);
      const pageGroupName = pageCount > 1
        ? groupName + String(pageIndex + 1).padStart(2, '0')
        : groupName;
      lines.push(`${pageGroupName},#genre#`);
      for (const channel of pageChannels) {
        lines.push(`${channel.name},${channel.urls.join('#')}`);
      }
    }
  }

  return lines.join('\n');
}

export function formatLiveGroupsAsTxt(groups: TVBoxLiveGroup[]): string {
  return formatLiveGroupsAsTxtInternal(groups, false);
}

/**
 * 聚合 TXT 输出使用的央视主频道别名归一。
 *
 * 上游常见写法包括 CCTV1、CCTV-1、CCTV1-1综合、CCTV-2财经 等。
 * 这些应视为同一频道；但 CCTV-5+、CCTV-5+咪咕、CCTV第一剧场 等
 * 有独立语义的名称不能被合并。这里只归一主频道，频道线路仍由
 * formatAggregatedLiveGroupsAsTxt 按 URL 去重合并。
 *
 * 画质后缀只对 CCTV/中央/央视 前缀的名称剥离，避免把“苏州4K”
 * “东方卫视4K”“变形金刚_4K”这类本身带 4K 的普通频道名改掉。
 */
function canonicalAggregateChannelName(raw: string): string {
  // 聚合输出中上游常用 [BD]/[HD]/[SD]/[VGA] 标画质。它们是同一频道的
  // 不同线路，不应当因前缀不同而拆成多个频道名；单源 /live/<key> 输出
  // 不经过这里，仍保留上游原始名称。
  const base = sanitizeTxtLabel(raw, '未命名')
    .replace(/^\s*\[(?:BD|HD|SD|VGA|UHD|FHD)\]\s*/i, '')
    .replace(/^\s*[（(]\s*(?:BD|HD|SD|VGA|UHD|FHD)\s*[）)]\s*/i, '')
    .trim();
  if (!/^(?:CCTV|中央|央视)/i.test(base)) return base;
  const cleaned = base
    .replace(/\s*(?:高清|超清|蓝光|1080p?|720p?)$/i, '')
    .replace(/[-_\s]*(?:咪咕|移动)$/i, '')
    .replace(/[（(]\s*[）)]\s*$/g, '')
    .trim();
  // CCTV4K/CCTV8K 等超高清频道是独立频道，不参与普通 CCTV 数字频道归一。
  const ultraHd = base.match(/^(?:CCTV|中央|央视)[-_\s]*(4k|8k)(?:\s*超(?:高清)?)?$/i);
  if (ultraHd) return `CCTV-${ultraHd[1].toUpperCase()}`;
  // CCTV5 plus / CCTV5plus体育赛事 先归一为 CCTV-5+，避免落入普通 5 频道。
  if (/^(?:CCTV|中央|央视)[-_\s]*0*5(?:\s*plus|\s*plus\s*5)/i.test(cleaned)) return 'CCTV-5+';
  // 兼容 CCTV-01广州、CCTV-13FYtv、CCTV-5+体育赛事、CCTV-7国防军事 等后缀。
  const match = cleaned.match(
    /^(?:CCTV|中央|央视)[-_\s]*(?:0*(\d{1,2}))(\+)?(?:[-_\s]*(\d+(?:[A-Za-z]*|[\u4e00-\u9fa5]{1,8})?|[A-Za-z][A-Za-z0-9]*|[\u4e00-\u9fa5]{1,8}))?$/i,
  );
  if (!match) return cleaned;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 1 || number > 17) return cleaned;
  // 兼容 CCTV5 plus / CCTV5plus体育赛事 这类上游写法。
  if (number === 5 && /(?:5\s*plus|plus\s*5)/i.test(cleaned)) return 'CCTV-5+';
  return `CCTV-${number}${match[2] ? '+' : ''}`;
}

/** 地方目录按全国行政区划顺序排列，避免上游顺序造成目录跳动。 */
const LOCAL_REGION_ORDER = [
  '北京',
  '天津',
  '河北',
  '山西',
  '内蒙古',
  '辽宁',
  '吉林',
  '黑龙江',
  '上海',
  '江苏',
  '浙江',
  '安徽',
  '福建',
  '江西',
  '山东',
  '河南',
  '湖北',
  '湖南',
  '广东',
  '广西',
  '海南',
  '重庆',
  '四川',
  '贵州',
  '云南',
  '西藏',
  '陕西',
  '甘肃',
  '青海',
  '宁夏',
  '新疆',
  '其他',
] as const;

const INTERNATIONAL_SUBGROUP_ORDER = [
  '国际·新闻',
  '国际·影视',
  '国际·体育',
  '国际·少儿',
  '国际·纪录',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `国际·英语${letter}`),
  '国际·俄语',
  '国际·亚洲',
  '国际·其他',
] as const;

const FILM_SUBGROUP_ORDER = [
  '影视·电影',
  '影视·剧场',
  '影视·综合',
] as const;

const MUSIC_SUBGROUP_ORDER = [
  '音乐·歌曲',
  '音乐·DJ',
  '音乐·现场',
  '音乐·戏曲',
  '音乐·综合',
] as const;

const DOCUMENTARY_SUBGROUP_ORDER = [
  '纪录·自然',
  '纪录·人文',
  '纪录·探索',
  '纪录·综合',
] as const;

const SCENERY_SUBGROUP_ORDER = [
  '风景·城市',
  '风景·景区',
  '风景·自然',
  '风景·综合',
] as const;

const TOGETHER_SUBGROUP_ORDER = [
  '一起看·虎牙影视',
  '一起看·虎牙游戏',
  '一起看·虎牙音乐',
  '一起看·虎牙生活',
  '一起看·虎牙知识',
  '一起看·虎牙中文A',
  '一起看·虎牙中文B',
  '一起看·虎牙中文C',
  '一起看·虎牙中文D',
  '一起看·虎牙中文E',
  '一起看·虎牙中文F',
  '一起看·虎牙中文G',
  '一起看·虎牙中文H',
  '一起看·虎牙中文J',
  '一起看·虎牙中文K',
  '一起看·虎牙中文L',
  '一起看·虎牙中文M',
  '一起看·虎牙中文N',
  '一起看·虎牙中文P',
  '一起看·虎牙中文Q',
  '一起看·虎牙中文R',
  '一起看·虎牙中文S',
  '一起看·虎牙中文T',
  '一起看·虎牙中文W',
  '一起看·虎牙中文X',
  '一起看·虎牙中文Y',
  '一起看·虎牙中文Z',
  '一起看·虎牙字母数字',
  '一起看·斗鱼影视',
  '一起看·斗鱼游戏',
  '一起看·斗鱼音乐',
  '一起看·斗鱼生活',
  '一起看·斗鱼知识',
  '一起看·斗鱼中文A',
  '一起看·斗鱼中文B',
  '一起看·斗鱼中文C',
  '一起看·斗鱼中文D',
  '一起看·斗鱼中文E',
  '一起看·斗鱼中文F',
  '一起看·斗鱼中文G',
  '一起看·斗鱼中文H',
  '一起看·斗鱼中文J',
  '一起看·斗鱼中文K',
  '一起看·斗鱼中文L',
  '一起看·斗鱼中文M',
  '一起看·斗鱼中文N',
  '一起看·斗鱼中文P',
  '一起看·斗鱼中文Q',
  '一起看·斗鱼中文R',
  '一起看·斗鱼中文S',
  '一起看·斗鱼中文T',
  '一起看·斗鱼中文W',
  '一起看·斗鱼中文X',
  '一起看·斗鱼中文Y',
  '一起看·斗鱼中文Z',
  '一起看·斗鱼字母数字',
  '一起看·YY影视',
  '一起看·YY游戏',
  '一起看·YY音乐',
  '一起看·YY生活',
  '一起看·YY知识',
  '一起看·YY中文A',
  '一起看·YY中文B',
  '一起看·YY中文C',
  '一起看·YY中文D',
  '一起看·YY中文E',
  '一起看·YY中文F',
  '一起看·YY中文G',
  '一起看·YY中文H',
  '一起看·YY中文J',
  '一起看·YY中文K',
  '一起看·YY中文L',
  '一起看·YY中文M',
  '一起看·YY中文N',
  '一起看·YY中文P',
  '一起看·YY中文Q',
  '一起看·YY中文R',
  '一起看·YY中文S',
  '一起看·YY中文T',
  '一起看·YY中文W',
  '一起看·YY中文X',
  '一起看·YY中文Y',
  '一起看·YY中文Z',
  '一起看·YY字母数字',
  '一起看·B站影视',
  '一起看·B站游戏',
  '一起看·B站音乐',
  '一起看·B站生活',
  '一起看·B站知识',
  '一起看·B站其他',
  '一起看·短视频影视',
  '一起看·短视频游戏',
  '一起看·短视频音乐',
  '一起看·短视频生活',
  '一起看·短视频知识',
  '一起看·短视频其他',
  '一起看·其他影视',
  '一起看·其他游戏',
  '一起看·其他音乐',
  '一起看·其他生活',
  '一起看·其他知识',
  '一起看·其他',
] as const;

const OTHER_SUBGROUP_ORDER = [
  '其他·咪咕',
  '其他·NewTV',
  '其他·测试备用',
  '其他·购物生活',
  '其他·生活服务',
  '其他·俄语',
  '其他·音乐',
  '其他·影视',
  '其他·地方',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `其他·字母${letter}`),
  '其他·数字',
  ...'ABCDEFGHJKLMNOPQRSTWXYZ'.split('').map((letter) => `其他·中文${letter}`),
  '其他·中文其他',
  '其他·综合',
] as const;

const AGGREGATE_GROUP_ORDER: readonly string[] = [
  '央视',
  '国际',
  ...INTERNATIONAL_SUBGROUP_ORDER,
  '卫视',
  ...LOCAL_REGION_ORDER.map((region) => `地方·${region}`),
  '港澳台',
  '影视',
  ...FILM_SUBGROUP_ORDER,
  '电视剧',
  '少儿',
  '体育',
  '音乐',
  ...MUSIC_SUBGROUP_ORDER,
  '纪录',
  ...DOCUMENTARY_SUBGROUP_ORDER,
  '新闻财经',
  '教育',
  '春晚',
  '风景直播',
  ...SCENERY_SUBGROUP_ORDER,
  '4K/8K',
  '一起看',
  ...TOGETHER_SUBGROUP_ORDER,
  '其他',
  ...OTHER_SUBGROUP_ORDER,
];

/**
 * 地方频道别名表。省级名称优先，城市别名用于把“大庆公共”“广州综合”
 * 这类频道归入对应省份。只保留辨识度较高的地名，避免把普通节目词误判成地方台。
 */
const LOCAL_REGION_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['北京', ['北京']],
  ['天津', ['天津', '滨海']],
  ['河北', ['河北', '石家庄', '唐山', '秦皇岛', '邯郸', '邢台', '保定', '张家口', '承德', '沧州', '廊坊', '衡水', '昌黎', '滦平', '任丘', '平泉', '清河']],
  ['山西', ['山西', '太原', '大同', '阳泉', '长治', '晋城', '朔州', '晋中', '运城', '忻州', '临汾', '吕梁', '太谷', '灵石', '平遥', '潞城', '怀仁', '汾西', '古县', '定襄', '万荣']],
  ['内蒙古', ['内蒙古', '内蒙', '呼和浩特', '呼市', '包头', '乌海', '赤峰', '通辽', '鄂尔多斯', '呼伦贝尔', '巴彦淖尔', '乌兰察布', '兴安盟', '锡林郭勒', '阿拉善', '满洲里', '二连浩特', '蒙语']],
  ['辽宁', ['辽宁', '沈阳', '大连', '鞍山', '抚顺', '本溪', '丹东', '锦州', '营口', '阜新', '辽阳', '盘锦', '铁岭', '朝阳', '葫芦岛']],
  ['吉林', ['吉林', '长春', '四平', '辽源', '通化', '白山', '松原', '白城', '延边', '延吉', '敦化', '桦甸', '舒兰', '磐石', '双辽', '通化县', '柳河', '辉南', '靖宇', '九台', '龙井', '汪清', '珲春', '东丰', '长白', '长影']],
  ['黑龙江', ['黑龙江', '哈尔滨', '齐齐哈尔', '鸡西', '鹤岗', '双鸭山', '大庆', '伊春', '佳木斯', '七台河', '牡丹江', '黑河', '绥化', '大兴安岭', '甘南县']],
  ['上海', ['上海', '哈哈炫动', 'ics']],
  ['江苏', ['江苏', '南京', '无锡', '徐州', '常州', '苏州', '南通', '连云港', '淮安', '盐城', '扬州', '镇江', '泰州', '宿迁', '江阴', '宜兴', '常熟', '张家港', '昆山', '吴江', '太仓', '溧水', '金湖', '句容', '靖江', '新沂', '溧阳', '高邮', '仪征', '丹阳', '扬中', '兴化', '泰兴', '沭阳', '泗洪', '泗阳']],
  ['浙江', ['浙江', '杭州', '宁波', '温州', '嘉兴', '湖州', '绍兴', '金华', '衢州', '舟山', '台州', '丽水', '余杭', '萧山', '义乌', '诸暨', '上虞', '嵊州', '新昌', '余姚', '慈溪', '象山', '宁海', '奉化', '苍南', '平湖', '海宁', '桐乡', '嘉善', '海盐', '长兴', '德清', '安吉', '兰溪', '东阳', '永康', '武义', '浦江', '磐安', '开化', '龙游', '常山', '江山', '天台', '仙居', '三门', '温岭', '临海', '玉环', '青田', '缙云', '遂昌', '松阳', '云和', '庆元', '龙泉', '景宁', '岱山', '嵊泗', '洞头', '永嘉', '平阳', '文成', '泰顺', '瑞安', '乐清', '中国蓝', 'htv', '普陀']],
  ['安徽', ['安徽', '合肥', '芜湖', '蚌埠', '淮南', '马鞍山', '淮北', '铜陵', '安庆', '黄山', '滁州', '阜阳', '宿州', '六安', '亳州', '池州', '宣城', '广德', '涡阳', '灵璧', '祁门', '固镇']],
  ['福建', ['福建', '福州', '厦门', '莆田', '三明', '泉州', '漳州', '南平', '龙岩', '宁德', '晋江', '石狮', '南安', '惠安', '安溪', '永春', '德化', '龙海', '云霄', '漳浦', '诏安', '东山', '平和', '南靖', '长泰', '华安', '上杭', '武平', '长汀', '连城', '永定', '福清', '长乐']],
  ['江西', ['江西', '南昌', '景德镇', '萍乡', '九江', '新余', '鹰潭', '赣州', '吉安', '宜春', '抚州', '上饶', '瑞金', '井冈山', '丰城', '樟树', '高安', '鄱阳', '婺源']],
  ['山东', ['山东', '济南', '青岛', '淄博', '枣庄', '东营', '烟台', '潍坊', '济宁', '泰安', '威海', '日照', '临沂', '德州', '聊城', '滨州', '菏泽', '莱芜', '章丘', '胶州', '即墨', '平度', '莱西', '滕州', '龙口', '莱阳', '莱州', '招远', '蓬莱', '栖霞', '海阳', '青州', '诸城', '寿光', '安丘', '高密', '昌邑', '曲阜', '邹城', '新泰', '肥城', '荣成', '乳山', '乐陵', '禹城']],
  ['河南', ['河南', '郑州', '开封', '洛阳', '平顶山', '安阳', '鹤壁', '新乡', '焦作', '濮阳', '许昌', '漯河', '三门峡', '南阳', '商丘', '信阳', '周口', '驻马店', '济源', '新野', '荥阳', '永城', '固始', '邓州', '汝州', '长垣', '鹿邑']],
  ['湖北', ['湖北', '武汉', '黄石', '十堰', '宜昌', '襄阳', '鄂州', '荆门', '孝感', '荆州', '黄冈', '咸宁', '随州', '恩施', '仙桃', '潜江', '天门', '神农架', '江夏', '大冶', '宜都', '当阳', '枝江', '老河口', '枣阳', '钟祥', '京山', '沙洋', '汉川', '应城', '安陆', '云梦', '麻城', '武穴', '赤壁', '嘉鱼']],
  ['湖南', ['湖南', '长沙', '株洲', '湘潭', '衡阳', '邵阳', '岳阳', '常德', '张家界', '益阳', '郴州', '永州', '怀化', '娄底', '湘西', '浏阳', '醴陵', '湘乡', '韶山', '耒阳', '常宁', '武冈', '临湘', '汨罗', '津市', '沅江', '资兴', '洪江', '冷水江', '涟源', '吉首']],
  ['广东', ['广东', '广州', '韶关', '深圳', '珠海', '汕头', '佛山', '江门', '湛江', '茂名', '肇庆', '惠州', '梅州', '汕尾', '河源', '阳江', '清远', '东莞', '中山', '潮州', '揭阳', '云浮', '番禺', '南沙', '增城', '从化', '花都', '龙岗', '宝安', '龙华', '光明', '坪山', '斗门', '金湾', '澄海', '潮阳', '潮南', '顺德', '南海', '三水', '高明', '新会', '台山', '开平', '鹤山', '恩平', '遂溪', '廉江', '雷州', '吴川', '高州', '化州', '信宜', '电白', '四会', '高要', '广宁', '怀集', '博罗', '惠东', '龙门', '梅县', '兴宁', '五华', '丰顺', '大埔', '蕉岭', '平远', '陆丰', '海丰', '陆河', '紫金', '龙川', '连平', '和平', '东源', '阳春', '阳西', '英德', '连州', '佛冈', '阳山', '饶平', '揭西', '惠来', '罗定', '新兴', '郁南', '珠江', '南国']],
  ['广西', ['广西', '南宁', '柳州', '桂林', '梧州', '北海', '防城港', '钦州', '贵港', '玉林', '百色', '贺州', '河池', '来宾', '崇左', '灌阳', '宜州', '合山', '凭祥']],
  ['海南', ['海南', '海口', '三亚', '三沙', '儋州', '琼海', '文昌', '万宁', '五指山', '澄迈', '定安', '屯昌', '临高', '白沙', '昌江', '乐东', '陵水', '保亭', '琼中']],
  ['重庆', ['重庆', '江津', '璧山', '垫江', '荣昌', '万州', '涪陵', '黔江', '长寿', '永川', '合川', '南川', '綦江', '大足', '铜梁', '潼南', '开州', '梁平', '武隆', '城口', '丰都', '忠县', '云阳', '奉节', '巫山', '巫溪', '石柱', '秀山', '酉阳', '彭水']],
  ['四川', ['四川', '成都', '自贡', '攀枝花', '泸州', '德阳', '绵阳', '广元', '遂宁', '内江', '乐山', '南充', '眉山', '宜宾', '广安', '达州', '雅安', '巴中', '资阳', '阿坝', '甘孜', '凉山', '泸县', '金川', '青川', '剑阁', '旺苍', '苍溪', '营山', '仁寿', '夹江', '井研', '名山', '荥经', '叙州', '兴文', '长宁', '高县', '珙县', '筠连', '屏山', '天全', '芦山', '宝兴', '松潘', '汶川', '九寨沟', '康定', '西昌', '朝天']],
  ['贵州', ['贵州', '贵阳', '六盘水', '遵义', '安顺', '毕节', '铜仁', '黔西南', '黔东南', '黔南', '仁怀', '赤水', '清镇']],
  ['云南', ['云南', '昆明', '曲靖', '玉溪', '保山', '昭通', '丽江', '普洱', '临沧', '楚雄', '红河', '文山', '西双版纳', '大理', '德宏', '怒江', '迪庆', '易门']],
  ['西藏', ['西藏', '拉萨', '日喀则', '昌都', '林芝', '山南', '那曲', '阿里']],
  ['陕西', ['陕西', '西安', '铜川', '宝鸡', '咸阳', '渭南', '延安', '汉中', '榆林', '安康', '商洛', '杨凌']],
  ['甘肃', ['甘肃', '兰州', '嘉峪关', '金昌', '白银', '天水', '武威', '张掖', '平凉', '酒泉', '庆阳', '定西', '陇南', '临夏', '甘南', '永昌', '天祝', '渭源']],
  ['青海', ['青海', '西宁', '海东', '海北', '黄南', '果洛', '玉树', '海西']],
  ['宁夏', ['宁夏', '银川', '石嘴山', '吴忠', '固原', '中卫']],
  ['新疆', ['新疆', '乌鲁木齐', '克拉玛依', '吐鲁番', '哈密', '昌吉', '博尔塔拉', '巴音郭楞', '阿克苏', '克孜勒苏', '喀什', '和田', '伊犁', '塔城', '阿勒泰', '石河子', '阿拉尔', '图木舒克', '五家渠', '北屯', '铁门关', '可克达拉', '昆玉', '胡杨河', '兵团']],
];

const LOCAL_CHANNEL_SUFFIX_RE = /频道|电视台|广播电视台|新闻|综合|公共|都市|生活|影视|电影|电视剧|经济|经视|科教|教育|文化|旅游|体育|少儿|国际|资讯|导视|党建|农村|乡村|农业|民生|社会|法制|城市|一套|二套|三套|四套|五套|六套|七套|八套|台$/;
const LOCAL_CHANNEL_BRAND_RE = /哈哈炫动|ics|珠江|南国|中国蓝|htv|长影|普陀|蒙语|兵团|可克达拉|石河子|胡杨河/;
const NON_LOCAL_PROGRAM_RE = /电影节|颁奖|典礼|开幕式|闭幕式|晚会|演唱会/;

function compactChannelText(value: string): string {
  return sanitizeTxtLabel(value, '')
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/^【[^】]+】\s*/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[·•・]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/廣/g, '广')
    .replace(/東/g, '东')
    .replace(/內/g, '内')
    .replace(/臺/g, '台')
    .replace(/灣/g, '湾')
    .replace(/衛/g, '卫')
    .replace(/視/g, '视');
}

function detectLocalRegion(rawGroup: string, channelName: string): string | null {
  const raw = compactChannelText(rawGroup);
  const name = compactChannelText(channelName);
  const text = raw + name;
  if (!text) return null;
  if (/香港|澳门|台湾|港台|港澳台|tvb|翡翠|明珠|凤凰|东森|中视|台视|三立|纬来|tvbs|rthk|澳视/.test(text)) return null;
  if (/卫视/.test(name) || /卫视/.test(raw)) return null;
  // “甘南县”属于黑龙江，不能与甘肃“甘南”混淆；“海南州”属于青海。
  if (/甘南县/.test(text)) return '黑龙江';
  if (/海南州|海南藏族/.test(text)) return '青海';
  if (NON_LOCAL_PROGRAM_RE.test(name)) return null;
  for (const [region, aliases] of LOCAL_REGION_ALIASES) {
    if (aliases.some((alias) => text.includes(alias))) return region;
  }
  return null;
}

function shouldUseLocalRegion(rawGroup: string, channelName: string): boolean {
  const raw = compactChannelText(rawGroup);
  const name = compactChannelText(channelName);
  if (NON_LOCAL_PROGRAM_RE.test(name)) return false;
  // 节目名里含“生活”不等于地方台；只有地区+台/频道/新闻/综合等
  // 结构化特征同时存在时才进入地方目录。
  if (/生活技巧|生活时尚|幸福生活|北漂生活|夜魔人|papi酱|朱一旦/.test(name)) return false;
  if (/地方|省频道|市频道|县频道|城市|地方台/.test(raw)) return true;
  return LOCAL_CHANNEL_SUFFIX_RE.test(name) || LOCAL_CHANNEL_BRAND_RE.test(name);
}

function classifyCctvSpecial(compact: string): string | null {
  if (/第一剧场|怀旧剧场|风云剧场|文化精品|兵器科技|电视指南|放映室/.test(compact)) return '影视';
  if (/发现之旅|老故事|世界地理/.test(compact)) return '纪录';
  if (/风云音乐/.test(compact)) return '音乐';
  if (/女性时尚|卫生健康/.test(compact)) return '其他';
  if (/高网|弈坛春秋|黑莓电竞/.test(compact)) return '体育';
  if (/(?:cctv|央视|中央电视)/.test(compact) && /(?:4k|8k)/.test(compact)) return '4K/8K';
  return null;
}

function isCctvMainChannel(compact: string): boolean {
  const match = compact.match(/^(?:cctv|中央电视|中央电视台|央视)[-_\s]*0*(\d{1,2})(\+)?/i);
  if (!match) return false;
  const number = Number(match[1]);
  return Number.isInteger(number) && number >= 1 && number <= 17;
}

function classifyNewTv(compact: string): string {
  if (/爱情喜剧|惊悚悬疑/.test(compact)) return '影视';
  if (/东北热剧/.test(compact)) return '电视剧';
  if (/军事评论/.test(compact)) return '新闻财经';
  if (/武搏世界|中国功夫/.test(compact)) return '体育';
  return '其他';
}

function collectLiveSourceLabels(channel?: TVBoxLiveChannel): string {
  return (channel?.urls || [])
    .join('\n')
    .match(/\$([^#\n]+)#[0-9a-f]{8}/gi)
    ?.map((value) => compactChannelText(value.replace(/^\$/, '').replace(/#[0-9a-f]{8}$/i, '')))
    .join(' ') || '';
}

function classifyTogetherSubgroup(
  rawGroup: string,
  channelName: string,
  channel?: TVBoxLiveChannel,
): string {
  const text = compactChannelText(rawGroup) + compactChannelText(channelName) + collectLiveSourceLabels(channel);
  let platform = '其他';
  if (/虎牙|huya/i.test(text)) platform = '虎牙';
  else if (/斗鱼|douyu/i.test(text)) platform = '斗鱼';
  else if (/yy|歪歪/i.test(text)) platform = 'YY';
  else if (/b站|哔哩|bilibili/i.test(text)) platform = 'B站';
  else if (/抖音|快手|短视频/i.test(text)) platform = '短视频';

  let kind = '';
  if (/游戏|电竞|王者|和平精英|英雄联盟|lol|吃鸡|我的世界|原神|传奇|魔兽|主机|单机|手游|街机|csgo|dota|绝地求生|永劫无间|apex|pubg|比赛|赛事|联赛|开黑|攻略|对战|竞技/i.test(text)) {
    kind = '游戏';
  } else if (/音乐|歌曲|歌|dj|电音|舞曲|慢摇|演唱会|音乐会|音乐节|钢琴|吉他|乐器|戏曲|京剧|越剧|豫剧|黄梅|评剧|昆曲|民乐|唱见|歌姬|歌手|好声音|声生不息/i.test(text)) {
    kind = '音乐';
  } else if (/影视|电影|影院|剧场|电视剧|连续剧|剧集|港剧|美剧|韩剧|短剧|动漫|动画|番剧|国漫|综艺|追剧|看剧|影评|影迷|观影|大片|老片|喜剧|科幻|恐怖|战争|武侠|动作|悬疑|犯罪|爱情|纪录片|纪录|解说/i.test(text)) {
    kind = '影视';
  } else if (/生活|日常|户外|旅行|旅游|赶海|钓鱼|美食|吃播|乡村|农村|宠物|动物|健身|运动|舞蹈|广场舞|手工|绘画|时尚|美妆|汽车|摩托|露营|探险|越野|房车|探店|城市|风景|摄影|萌宠|田园|三农|vlog/i.test(text)) {
    kind = '生活';
  } else if (/科普|科学|历史|法律|军事|财经|商业|教育|学习|讲坛|百家|故事|说书|文学|读书|科技|数码|编程|数学|英语|地理|自然|人文|知识|课堂|考试|演讲|哲学|心理|医学|健康/i.test(text)) {
    kind = '知识';
  }
  if (kind) return '一起看·' + platform + kind;
  if (platform === 'B站' || platform === '短视频' || platform === '其他') return '一起看·' + platform + '其他';
  return '一起看·' + platform + togetherFallbackBucket(platform, channel);
}

function togetherFallbackBucket(platform: string, channel?: TVBoxLiveChannel): string {
  if (platform === 'YY') {
    const name = (channel?.name || '').trim().replace(/^[\s\[【（(]+/, '');
    const first = Array.from(name)[0] || '';
    const initial = 'ABCDEFGHJKLMNOPQRSTWXYZ'.includes(first.toUpperCase()) ? first.toUpperCase() : '';
    if (initial) return '字母数字';
    if (/[0-9a-z]/i.test(first)) return '字母数字';
    if (/[\u4e00-\u9fff]/.test(first)) return '中文' + chineseBucketInitial(name);
    return '其他';
  }
  const idText = (channel?.urls || [])
    .map((url) => url.match(/\/(?:huya|douyu)\/(\d+)/i)?.[1] || '')
    .find(Boolean) || '';
  const id = Number(idText);
  if (!Number.isFinite(id) || id <= 0) return '字母数字';
  // 平台 ID 跨度从万级到千万级且中高号段密集，使用 16 档对数桶控制单桶规模。
  const bucket = Math.floor(Math.log2(id) * 1.5);
  const labels = [
    '中文A', '中文B', '中文C', '中文D',
    '中文E', '中文F', '中文G', '中文H',
    '中文J', '中文K', '中文L', '中文M',
    '中文N', '中文P', '中文Q', '中文R',
  ];
  return labels[Math.min(labels.length - 1, Math.max(0, bucket - 18))];
}

function chineseBucketInitial(name: string): string {
  const first = Array.from(name)[0] || '';
  const ranges = [
    ['A', '啊', '芭'], ['B', '芭', '擦'], ['C', '擦', '搭'], ['D', '搭', '蛾'],
    ['E', '蛾', '发'], ['F', '发', '噶'], ['G', '噶', '哈'], ['H', '哈', '击'],
    ['J', '击', '喀'], ['K', '喀', '垃'], ['L', '垃', '妈'], ['M', '妈', '拿'],
    ['N', '拿', '哦'], ['O', '哦', '啪'], ['P', '啪', '期'], ['Q', '期', '然'],
    ['R', '然', '撒'], ['S', '撒', '塌'], ['T', '塌', '挖'], ['W', '挖', '昔'],
    ['X', '昔', '压'], ['Y', '压', '匝'], ['Z', '匝', '\u9fff'],
  ] as const;
  for (const [initial, start, end] of ranges) {
    if (first >= start && first < end) return initial;
  }
  return '其他';
}

function classifyInternationalSubgroup(
  rawGroup: string,
  channelName: string,
  channel?: TVBoxLiveChannel,
): string | null {
  const raw = compactChannelText(rawGroup);
  const name = compactChannelText(channelName);
  const text = raw + name + collectLiveSourceLabels(channel);
  if (!name) return null;

  if (/^(?:cctv|cetv|newtv|migu|咪咕|中国教育电视台|中央电视|央视)/i.test(name)
    || /卫视|港澳台|香港|澳门|台湾|tvb|翡翠|明珠|凤凰|东森|中视|台视|三立|纬来|tvbs|rthk|澳视/.test(text)
    || /地方频道|省频道|市频道|县频道/.test(text)) return null;
  if (/4k|8k|uhd/i.test(text)) return null;

  const hasExplicitInternationalGroup = /国际|海外|外语|境外/.test(raw);
  const hasInternationalBrand = /cgtn|中国国际电视台|bbc|cnn|abc|nbc|cbs|fox|bloomberg|cnbc|aljazeera|jazeera|euronews|france24|dw|nhk|arirang|kbs|mbc|sbs|tv5|skynews|discovery|animalplanet|natgeo|nationalgeographic|cartoonnetwork|disney|nickelodeon|espn|hbo|cinemax|starmovies|tvbs?|foxnews/i.test(text);
  const latinOnly = /[a-z]{2,}/i.test(name) && !/[\u4e00-\u9fff]/.test(name);
  const hasForeignLanguageHint = /英语|英文|俄语|俄罗斯|俄羅斯|日本|韩国|印度|亚洲|新加坡|马来西亚|泰国|越南|菲律宾/.test(text);
  if (!hasExplicitInternationalGroup && !hasInternationalBrand && !latinOnly) return null;
  if (hasExplicitInternationalGroup && /[\u4e00-\u9fff]/.test(name)
    && !hasInternationalBrand && !hasForeignLanguageHint
    && !/新闻|体育|少儿|纪录|影视|电影/.test(text)) return null;

  if (/news|新闻|资讯|business|财经|bloomberg|cnbc|bbc|cnn|aljazeera|euronews|france24|dw|nhk|arirang|abc|nbc|cbs|foxnews|skynews/i.test(text)) return '国际·新闻';
  if (/sports?|足球|篮球|体育|espn|football|nba|premierleague|tennis/i.test(text)) return '国际·体育';
  if (/cartoon|kids|少儿|儿童|卡通|disney|nickelodeon|nick/i.test(text)) return '国际·少儿';
  if (/discovery|animalplanet|natgeo|nationalgeographic|history|science|documentary|纪录|探索|自然/i.test(text)) return '国际·纪录';
  if (/movie|cinema|film|drama|series|hbo|cinemax|starmovies|影视|电影|剧场/i.test(text)) return '国际·影视';
  if (/俄语|俄罗斯|俄羅斯|russia|russian|русск|россия|перв|тнт|стс|нтв|карусель|ukraine|бел|kazakh|哈萨克/i.test(text)) return '国际·俄语';
  if (/日本|japan|nhk|韩国|korea|kbs|mbc|sbs|arirang|tvn|jtbc|印度|india|asianet|astro|亚洲|asia|singapore|malaysia|thai|vietnam|印尼|泰国|越南|菲律宾/i.test(text)) return '国际·亚洲';
  if (latinOnly) {
    const first = (name.replace(/^[^a-z0-9]+/i, '')[0] || 'A').toUpperCase();
    const bucket = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.includes(first) ? first : 'A';
    return '国际·英语' + bucket;
  }
  return '国际·英语';
}

function classifyFilmSubgroup(compact: string): string {
  if (/剧场|电视剧|连续剧|剧集|港剧|美剧|韩剧|短剧|经典剧|大剧|戏剧|电视轮播|电视轮|电视剧场/.test(compact)) {
    return '影视·剧场';
  }
  if (/电影|影院|大片|动作片|喜剧片|科幻片|恐怖片|战争片|武侠片|港片|周星驰|成龙|林正英|周润发|邵氏|好片|经典怀旧|警匪悬疑|科幻梦工场|速度与激情|视觉/.test(compact)) {
    return '影视·电影';
  }
  return '影视·综合';
}

function classifyMusicSubgroup(compact: string): string {
  if (/戏曲|梨园|京剧|越剧|豫剧|黄梅|评剧|昆曲|曲艺/.test(compact)) return '音乐·戏曲';
  if (/dj|电音|舞曲|慢摇|酒吧/i.test(compact)) return '音乐·DJ';
  if (/演唱会|现场|音乐会|音乐节|live/i.test(compact)) return '音乐·现场';
  if (/歌曲|歌手|港乐|经典|金曲|情歌|串烧|风云音乐|欣赏音乐/.test(compact)) return '音乐·歌曲';
  return '音乐·综合';
}

function classifyDocumentarySubgroup(compact: string): string {
  if (/(?:一套|二套|综合|公共|影综艺|汉语|哈萨克语|蒙古语|藏语|维语)$/.test(compact)
    && !/动物|自然|野生|纪录|纪实|探索|科学/.test(compact)) return '地方·其他';
  if (/动物|自然|野生|丛林|大象|海豚|海鬣蜥|棕熊|潜水|田园|地理|世界地理|风光|生态|狮子|狮|老虎|虎|猎豹|豹|北极熊|熊|狼|鳄鱼|鳄|蟒蛇|蛇|鲸鱼|鲸|鲨鱼|鲨|海獭|水獭|猴子|猴|猩猩|猫科|大猫|角马|斑马|长颈鹿|犀牛|河马|企鹅|雪鸮|鸮|鸟|鹰|鹤|鹿|马|牛|羊|兔|鼠|鱼|龟|昆虫|捕食|捕猎|猎手|生存|进化|家族|幼崽|幼狮|幼虎|幼豹|海洋|深海|海底|河流|河|湖泊|湖|森林|草原|荒野|沙漠|冰川|冰雪|极地|雨林|湿地|山脉|巨兽|宠物|狗|猫/.test(compact)) return '纪录·自然';
  if (/人文|历史|老故事|中国村庄|人物|文化|考古|美食|旅行|地理中国|美丽中国|美丽云南|乘着火车看中国|国家公园|世界遗产|古镇|民俗|非遗/.test(compact)) return '纪录·人文';
  if (/探索|发现|科学|科技|宇宙|军事|兵器|神秘|未解|纪录|纪实|真相|谜|UFO|飞碟|未来|工程|机械|医学/.test(compact)) return '纪录·探索';
  return '纪录·综合';
}

function classifyScenerySubgroup(compact: string): string {
  if (/城市|街景|道路|港口|车站|机场|校园|商圈|步行街|夜景|码头|广场|大厦|立交|高铁|地铁/.test(compact)) return '风景·城市';
  if (/景区|景点|旅游|直播中国|熊猫直播|中央电视塔|航拍|风景|黄山|泰山|华山|长城|古镇|古城|瀑布|峡谷|雪山|温泉|观景台|湿地|动物园|植物园|云海|日出|日落|山|湖|寺|塔|桥|岛|湾/.test(compact)) return '风景·景区';
  if (/森林|草原|海洋|沙漠|冰川|雨林|极地|自然|河流|湖泊|湿地/.test(compact)) return '风景·自然';
  return '风景·综合';
}

function classifyOtherSubgroup(
  rawGroup: string,
  channelName: string,
  channel?: TVBoxLiveChannel,
): string {
  const raw = compactChannelText(rawGroup);
  const name = compactChannelText(channelName);
  const text = raw + name + collectLiveSourceLabels(channel);

  if (/咪咕|咪视界/.test(text)) return '其他·咪咕';
  if (/newtv/i.test(text)) return '其他·NewTV';
  if (/测试|备用|防走失|直播源|接口/.test(text)) return '其他·测试备用';
  if (/购物|商城|电视购物|好物|种草|消费/.test(text)) return '其他·购物生活';
  if (/俄语|俄罗斯|俄羅斯|russia|russian|русск|россия|перв|тнт|стс|нтв|карусель|哈萨克/i.test(text)) return '其他·俄语';
  if (/音乐|歌曲|歌mv|mv|dj|电音|舞曲|慢摇|演唱会|音乐会|音乐节|戏曲|京剧|越剧|豫剧|黄梅|评剧|昆曲|曲艺/i.test(text)) return '其他·音乐';
  if (/影视|电影|影院|剧场|电视剧|连续剧|剧集|港剧|美剧|韩剧|短剧|动漫|动画|番剧|国漫|综艺|大片|老片|喜剧|科幻|恐怖|战争|武侠|动作|悬疑|犯罪|爱情|解说/i.test(text)) return '其他·影视';
  const region = detectLocalRegion(rawGroup, channelName);
  if (region) return '地方·' + region;
  if (/生活|美食|健康|汽车|房产|家居|时尚|美妆|旅游|民生|都市|法治|茶|教育/.test(text)) return '其他·生活服务';
  const first = name.replace(/^[^a-z0-9\u4e00-\u9fff]+/i, '')[0] || '';
  if (/[a-z]/i.test(first)) return '其他·字母' + first.toUpperCase();
  if (/[0-9]/.test(first)) return '其他·数字';
  if (/[\u4e00-\u9fff]/.test(first)) return '其他·中文' + chineseBucketInitial(name);
  return '其他·综合';
}

function aggregateGroupRank(group: string): number {
  const index = AGGREGATE_GROUP_ORDER.indexOf(group);
  if (index >= 0) return index;

  // 聚合输出会把超大分类分页为“基础名称01/02”。分页标签必须紧跟
  // 对应基础分类，不能因为未命中顺序表而被排到所有已知分类之后。
  const pageMatch = group.match(/^(.*?)(\d{2})$/);
  if (pageMatch) {
    const baseRank = aggregateGroupRank(pageMatch[1]);
    if (baseRank < AGGREGATE_GROUP_ORDER.length) {
      return baseRank + Number(pageMatch[2]) / 1000;
    }
  }

  if (group.startsWith('地方·')) return AGGREGATE_GROUP_ORDER.indexOf('地方·其他');
  const parent = group.split('·', 1)[0];
  const parentIndex = AGGREGATE_GROUP_ORDER.indexOf(parent);
  if (parentIndex >= 0) return parentIndex + 0.5;
  return AGGREGATE_GROUP_ORDER.length;
}

/**
 * 对聚合后的频道做有限的内容纠偏。
 *
 * 核心顺序是：港澳台/国际/央视特殊频道 → 卫视 → 明确地方地区 → 内容主题。
 * 这样既能修正上游把地方台塞进央视、把纪录片塞进地方等问题，也能让
 * 带省市信息的本地频道统一进入“地方·省/市”子目录，便于客户端查找。
 */
function normalizeAggregateChannelGroupBase(
  rawGroup: string,
  rawChannelName: string,
): string {
  const group = normalizeAggregateGroupName(rawGroup);
  const name = sanitizeTxtLabel(rawChannelName, '未命名');
  const compact = compactChannelText(name);
  const rawGroupCompact = compactChannelText(rawGroup);
  if (!compact) return group;

  // 实时风景机位名称可能包含“中央”，必须先于央视兜底判断。
  if (/熊猫直播|中央电视塔|直播中国|风景|景区/.test(compact)
    || (/航拍/.test(compact) && !/航拍中国/.test(compact))) return '风景直播';

  // 港澳台先于地方和主题判断，避免“香港/台湾”被地方别名误吸。
  if (/港澳台|港台|香港|澳门|台湾|tvb|翡翠|明珠|凤凰|东森|中视|台视|三立|纬来|tvbs|rthk|澳视/.test(compact)) return '港澳台';

  // 国际、教育及常见数字付费频道品牌先于央视兜底，避免混入央视。
  if (/cgtn|中国国际电视台/.test(compact)) return '国际';
  if (/cetv|中国教育电视台/.test(compact)) return '教育';
  if (/newtv/.test(compact)) return classifyNewTv(compact);
  if (/咪咕视频/.test(compact)) return '其他';
  if (/求索/.test(compact)) return '纪录';
  if (/家庭理财/.test(compact)) return '新闻财经';
  if (/置业频道/.test(compact)) return '其他';
  if (/弈坛春秋|黑莓电竞|央视高网/.test(compact)) return '体育';

  // 央视付费频道和超高清频道先于央视主频道判断。
  const cctvSpecial = classifyCctvSpecial(compact);
  if (cctvSpecial) return cctvSpecial;
  if (isCctvMainChannel(compact)) return '央视';
  if (/卫视/.test(compact)) return '卫视';

  // 地方频道：只要频道名或上游分组能识别出明确地区，就进入对应地方子目录。
  const region = detectLocalRegion(rawGroup, name);
  if (region && shouldUseLocalRegion(rawGroup, name)) return `地方·${region}`;

  const fromLocalGroup = group === '地方'
    || group.startsWith('地方·')
    || /地方频道|省频道|市频道|县频道|浙江频道|广州电信/.test(rawGroupCompact);

  // 内容主题只处理语义非常明确的频道；普通地方综合/公共/新闻台仍留在地方目录。
  if (/第一财经|财富天下/.test(compact)) return '新闻财经';
  if (/新闻综合|综合新闻/.test(compact)) return fromLocalGroup ? '地方·其他' : '新闻财经';
  if (/教育|教科|学习/.test(compact)) return '教育';
  if (/之江纪录|飞碟之谜|航拍中国|中国村庄|动物|自然|野生|丛林|大象|海豚|海鬣蜥|棕熊|潜水|田园|纪录片|探索|地理|人文/.test(compact)) return '纪录';
  if (/^[\u4e00-\u9fa5]{1,8}(?:4k|8k)$/.test(compact.replace(/(?:频道)?超?$/, ''))) return '4K/8K';
  if (/新闻|资讯|财经|商业/.test(compact)) return fromLocalGroup ? '地方·其他' : '新闻财经';
  if (/电视剧|连续剧|剧集|港剧|美剧|韩剧|短剧|经典剧|大剧|戏剧|射雕|神雕|倚天屠龙|笑傲江湖|寻秦记|创世纪|大时代|楚汉骄雄|大唐双龙传|法政先锋|鉴证实录|妙手仁心|陀枪师姐|洗冤录|刑事侦缉档案|金枝欲孽|活佛济公|西游记|封神榜|倩女幽魂|龙门飞甲|甄嬛传|还珠格格|亮剑|雪豹|华山论剑|三国|流星花园|大地恩情|凡人修仙|粤经典|水浒传|天龙八部|鹿鼎记|绝代双娇|神探狄仁|铁齿铜牙|神医喜来|父母爱情|白鹿原|大染坊|炊事班|士兵突击|我的团长|雍正王朝|康熙微服|玫瑰故事|梦华录|星汉灿烂|永夜星河|问心|漫长的季节|爱情公寓|家有儿女|海绵宝宝|蜡笔小新|叮当|龙珠|柯南|圣斗士|四驱兄弟|头文字|足球小将|全职高手|一人之下|一人之上|笑看风云|庆余年|雪中悍刀行|延禧攻略|武林外传|仙剑奇侠传|新白娘子|我爱男保姆|我的前半生|传闻中的芊芊|第一滴血|火蓝刀锋|炮神|渗透|风筝|开端|流金岁月|少寒|如果岁月|电视轮播|电视轮|轮播/.test(compact)) return '电视剧';
  if (/电影|影院|影视|剧场|大片|动作片|喜剧片|科幻片|恐怖片|战争片|武侠片|港片|周星驰|成龙|林正英|周润发|邵氏|陈翔六点半|视觉|重温经典|古装|妖魔|好片|经典怀旧|警匪悬疑|科幻梦工场|速度与激情/.test(compact)) return '影视';
  if (/生活|民生|都市/.test(compact)) {
    // 地方组的综合/民生台保留地方归属；普通节目名不再误判为地方台。
    if (fromLocalGroup && !/生活技巧|生活时尚|幸福生活|北漂生活|夜魔人|papi酱|朱一旦/.test(compact)) return '地方·其他';
    return '其他';
  }
  if (/体育|足球|篮球|网球|台球|斯诺克|赛事|运动|竞技|格斗|全运|spotv|sports?|football/.test(compact)) return '体育';
  if (/少儿|儿童|卡通|动漫|动画|青少|猫和老鼠|七龙珠|中华小当家/.test(compact)) return '少儿';
  if (/音乐|歌曲|演唱会|港乐|dj|串烧|风云音乐|音乐现场/.test(compact)) return '音乐';
  if (/春晚|春节|贺岁/.test(compact)) return '春晚';
  if (/直播中国|风景|景区|航拍/.test(compact)) return '风景直播';
  if (/一起看|虎牙|斗鱼|b站|原创|zonghe|综合直播|抖音|快手/.test(compact)) return '一起看';
  if (/女性时尚|时尚|咪视界|爱奇艺综|脱口秀|颁奖典礼|颁奖礼|红地毯|走红毯|广场舞|梨园|欣赏频道|数字频道|解说频道|car|测试|备用/.test(compact)) return '其他';

  if (fromLocalGroup) return group.startsWith('地方·') ? group : '地方·其他';
  return group === '其他' ? '其他' : group;
}

/**
 * 聚合直播专用分组归一。上游源各自维护 group 名，常出现“央视/央视频道/
 * 📺央视频道”、地方省台拆成单频道分类、电影和电视剧混在一起等情况。
 * 这里只处理最终聚合输出，不影响 /live/<key> 的单源代理内容。
 *
 * 原则：
 * - 只输出固定主分类；地方频道额外输出“地方·省/市”子目录；
 * - 同义分类合并，无法判断内容时归入“其他”；
 * - 空分类不输出，频道线路仍按 URL 去重并保留多线路。
 */
function normalizeAggregateChannelGroup(
  rawGroup: string,
  rawChannelName: string,
  channel?: TVBoxLiveChannel,
): string {
  const group = normalizeAggregateGroupName(rawGroup);
  const name = sanitizeTxtLabel(rawChannelName, '未命名');
  const compact = compactChannelText(name);

  if (/cgtn|中国国际电视台/i.test(compact)) return '国际·新闻';
  if (/newtv/i.test(compact)) return classifyNewTv(compact) === '电视剧' ? '电视剧' : '其他·NewTV';
  if (/咪咕视频|咪视界/.test(compact)) return '其他·咪咕';
  if (/4k|8k|uhd/i.test(compact)) return '4K/8K';

  const international = classifyInternationalSubgroup(rawGroup, name, channel);
  if (international) return international;

  if (group === '一起看' || group.startsWith('一起看·')) return classifyTogetherSubgroup(rawGroup, name, channel);
  if (/一起看|虎牙|斗鱼|b站|原创|zonghe|综合直播|抖音|快手/i.test(compact)) return classifyTogetherSubgroup(rawGroup, name, channel);

  const base = normalizeAggregateChannelGroupBase(rawGroup, rawChannelName);
  if (base === '国际') return classifyInternationalSubgroup(rawGroup, name, channel) || '国际·其他';
  if (base === '影视') return classifyFilmSubgroup(compact);
  if (base === '音乐') return classifyMusicSubgroup(compact);
  if (base === '纪录') return classifyDocumentarySubgroup(compact);
  if (base === '风景直播') return classifyScenerySubgroup(compact);
  if (base === '一起看') return classifyTogetherSubgroup(rawGroup, name, channel);
  if (base === '其他') return classifyOtherSubgroup(rawGroup, name, channel);
  return base;
}
function normalizeAggregateGroupName(raw: string): string {
  const label = sanitizeTxtLabel(raw, '其他')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[·•・]/g, '')
    .trim();
  const compact = compactChannelText(label);
  if (!compact) return '其他';

  // 已经是“地方·XX”的运行时分组必须保持幂等，避免二次归一退化成“地方”。
  for (const region of LOCAL_REGION_ORDER) {
    if (compact === `地方${region}`) return `地方·${region}`;
  }
  if (/^地方(?:频道|台|省频道|市频道|县频道)?$/.test(compact)) return '地方';

  if (compact === '国际' || /cgtn|中国国际电视台/.test(compact)) return '国际';
  if (/cetv|中国教育电视台/.test(compact)) return '教育';
  if (/咪咕/.test(compact)) return '其他';
  if (/求索/.test(compact)) return '纪录';
  if (/卫视/.test(compact)) return '卫视';
  if (/港澳台|港台/.test(compact)) return '港澳台';
  const region = detectLocalRegion(label, '');
  if (region && !/卫视/.test(compact)) return `地方·${region}`;

  if (/cctv|央视|中央电视|央卫/.test(compact)) {
    if (/第一剧场|怀旧剧场|文化精品|风云剧场|兵器科技|电视指南|发现之旅|老故事/.test(compact)) return '影视';
    return '央视';
  }
  if (/少儿|儿童|卡通|动漫|动画|青少|童年/.test(compact)) return '少儿';
  if (/体育|足球|篮球|网球|台球|斯诺克|赛事|运动|竞技|全运/.test(compact)) return '体育';
  if (/纪录|纪实|探索|地理|人文/.test(compact)) return '纪录';
  if (/新闻|资讯|财经|商业/.test(compact)) return '新闻财经';
  if (/音乐|歌曲|演唱会|港乐|dj|串烧|欣赏港乐|欣赏音乐/.test(compact)) return '音乐';
  if (/电影|影院|影视|剧场|大片|动作|喜剧|科幻|恐怖|战争|武侠|视觉效果|轮播/.test(compact)) return '影视';
  if (/电视剧|连续剧|剧集|港剧|美剧|韩剧|短剧|经典剧|雪豹|华山论剑|三国|射雕|神雕|亮剑|流星花园|还珠格格|甄嬛传|大时代|大地恩情|凡人修仙|粤经典/.test(compact)) return '电视剧';
  if (/春晚|春节|贺岁/.test(compact)) return '春晚';
  if (/直播中国|风景|景区|航拍/.test(compact)) return '风景直播';
  if (/一起看|虎牙|斗鱼|b站|原创|zonghe|综合直播|抖音|快手/.test(compact)) return '一起看';
  if (/^(?:4k8k频道|4k频道|8k频道|超高清|高清频道)$/.test(compact)) return '4K/8K';
  if (/教育|学习/.test(compact)) return '教育';
  if (/欣赏频道|咪视界|数字频道|解说频道|car|测试|备用/.test(compact)) return '其他';

  return '其他';
}

/**
 * 聚合输出专用噪声过滤。
 *
 * 不直接放大全局 AD_KEYWORDS，避免误删单源或正常频道；
 * 这里只处理网络直播里明确不是电视频道的推广/状态条目。
 */
function isAggregateNoiseChannel(name: string): boolean {
  const label = sanitizeTxtLabel(name, '').trim();
  const compact = label.replace(/\s+/g, '');
  if (!compact) return true;
  return /^[➡⬆⬇→←⬅↪↩️⭐✅❌❗]+/.test(compact)
    || /支持作者|分享备用|更新时间|白嫖软件|免费观看|分享更新|互相搬助|大街网源|能看就行|不必纠结|爱扒随便/.test(compact)
    || /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[\sT]+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(label);
}
/**
 * 将聚合直播分组转成 TVBox TXT。分类归一和频道线路去重只用于全局
 * /live；单源 /live/<key> 继续调用 formatLiveGroupsAsTxt。
 */
export function formatAggregatedLiveGroupsAsTxt(groups: TVBoxLiveGroup[]): string {
  const normalized: TVBoxLiveGroup[] = [];
  for (const group of groups) {
    const byGroup = new Map<string, TVBoxLiveChannel[]>();
    for (const channel of group.channels || []) {
      if (isAggregateNoiseChannel(channel.name || '')) continue;
      const targetGroup = normalizeAggregateChannelGroup(group.group || '', channel.name || '', channel);
      const list = byGroup.get(targetGroup) || [];
      list.push(channel);
      byGroup.set(targetGroup, list);
    }
    for (const [targetGroup, channels] of byGroup) {
      normalized.push({ group: targetGroup, channels });
    }
  }
  normalized.sort((a, b) => aggregateGroupRank(a.group) - aggregateGroupRank(b.group));
  return formatLiveGroupsAsTxtInternal(normalized, true, MAX_AGGREGATE_CHANNELS_PER_GROUP);
}

/**
 * 将运行时 TXT 恢复为最小频道树。
 *
 * /live 输出中每条线路形如 `URL#源标签`，而 parseLiveContent 的 TXT 分支
 * 会按 URL 拆分并丢弃标签。这里反序列化时重新拼回运行时标签形态，
 * 以保证重启后仍可提取当前下发前沿并继续做频道级测速。
 */
export function parseLiveGroupsFromTxt(content: string): TVBoxLiveGroup[] {
  const groups = new Map<string, TVBoxLiveChannel[]>();
  let currentGroup = '其他';
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(',');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const right = line.slice(idx + 1).trim();
    if (right === '#genre#') {
      currentGroup = name || '其他';
      continue;
    }
    // 运行时 TXT 形如 `URL$源名#短哈希#URL$源名#短哈希`，必须按“下一个 URL”
    // 切分，不能按裸 `#` 切分，否则会丢掉源标签，导致重启后无法按源过滤与匹配测速。
    const urls = right
      .split(/#(?=https?:\/\/)/i)
      .map((value) => value.trim())
      .filter((value) => /^https?:\/\//i.test(value));
    if (!name || urls.length === 0) continue;
    const list = groups.get(currentGroup) || [];
    list.push({ name, urls });
    groups.set(currentGroup, list);
  }
  return Array.from(groups.entries())
    .filter(([, channels]) => channels.length > 0)
    .map(([group, channels]) => ({ group, channels }));
}

/** 自动识别 m3u 还是 txt */
export function parseLiveContent(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  if (content.includes('#EXTM3U') || content.includes('#EXTINF')) {
    return parseM3U(content, source, sourceSpeedMs);
  }
  return parseTxt(content, source, sourceSpeedMs);
}

// ─── 下载 m3u/txt ──────────────────────────────────────

async function readLimitedText(
  resp: Response,
  signal: AbortSignal,
  maxBytes = LIVE_SOURCE_MAX_DOWNLOAD_BYTES,
): Promise<string> {
  const body = resp.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  let removeAbortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => {});
      const error = new Error('Live source response body timed out');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    while (total < maxBytes) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: total < maxBytes });
      if (total >= maxBytes) break;
    }
    if (total < maxBytes) text += decoder.decode();
  } finally {
    removeAbortListener?.();
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return text;
}
async function downloadLive(
  input: LiveSourceInput,
  timeoutMs: number,
  stats: LiveDownloadStats,
  browserFallback = true,
): Promise<DownloadOutcome> {
  // Blocked sources are treated as permanently invalid and never hit the network
  // or a stale cache. This also removes them from regenerated manifests.
  if (isBlockedLiveSource(input)) {
    return {
      content: null,
      failure: 'invalid',
      reason: 'blocked source',
      cacheHit: false,
      revalidated: false,
      staleFallback: false,
    };
  }

  const key = liveCacheKey(input, browserFallback);
  const cached = liveSourceMemoryCache.get(key);
  const networkStartedAt = Date.now();
  const now = Date.now();
  const cacheFresh = !!cached && now - cached.cachedAt < LIVE_SOURCE_CACHE_TTL_MS;

  if (cacheFresh && cached) {
    cached.lastAccess = now;
    stats.cacheHits++;
    return { content: cached.content, cacheHit: true, revalidated: false, staleFallback: false, downloadMs: cached.downloadMs };
  }

  stats.cacheMisses++;
  const uas = browserFallback
    ? [input.ua || TVBOX_UA, BROWSER_UA]
    : [input.ua || TVBOX_UA];
  let lastFailure: LiveDownloadFailure | undefined;
  let lastReason: string | undefined;

  for (const ua of uas) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { 'User-Agent': ua, ...(input.header || {}) };
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

      const resp = await fetch(input.url, { signal: controller.signal, headers });

      if (resp.status === 304 && cached) {
        cached.cachedAt = now;
        cached.lastAccess = now;
        stats.cacheHits++;
        stats.revalidated++;
        return { content: cached.content, cacheHit: true, revalidated: true, staleFallback: false, downloadMs: cached.downloadMs };
      }

      if (!resp.ok) {
        // 429/5xx/网络类状态是上游暂时不可用，不能据此永久删除入口。
        lastFailure = failureFromHttpStatus(resp.status);
        lastReason = `HTTP ${resp.status}`;
        continue;
      }

      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      const text = await readLimitedText(resp, controller.signal);
      if (looksLikeLivePayload(text, contentType)) {
        const entry: CachedLiveSource = {
          content: text,
          cachedAt: now,
          lastAccess: now,
          etag: resp.headers.get('etag') || undefined,
          lastModified: resp.headers.get('last-modified') || undefined,
          downloadMs: Date.now() - networkStartedAt,
        };
        liveSourceMemoryCache.set(key, entry);
        return { content: text, cacheHit: false, revalidated: false, staleFallback: false, downloadMs: Date.now() - networkStartedAt };
      }

      // 2xx 但不是直播内容（HTML 错误页、JSON、空响应等）确认无效。
      lastFailure = 'invalid';
      lastReason = text ? 'unexpected content' : 'empty content';
    } catch (error: unknown) {
      // 超时、DNS、连接中断和 Worker fetch 异常都视为暂时失败。
      lastFailure = 'transient';
      lastReason = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  if (cached) {
    cached.lastAccess = now;
    stats.staleFallbacks++;
    return { content: cached.content, cacheHit: true, revalidated: false, staleFallback: true, downloadMs: cached.downloadMs };
  }

  return {
    content: null,
    failure: lastFailure ?? 'transient',
    reason: lastReason,
    cacheHit: false,
    revalidated: false,
    staleFallback: false,
  };
}

async function downloadLiveBatched(
  sources: LiveSourceInput[],
  fetchTimeoutMs: number,
  concurrencyLimit = 3,
  storage?: Storage,
  browserFallback = true,
): Promise<{
  results: PromiseSettledResult<{ input: LiveSourceInput; outcome: DownloadOutcome }>[];
  stats: LiveDownloadStats;
}> {
  await loadPersistentLiveSourceCache(storage);
  const stats: LiveDownloadStats = { cacheHits: 0, cacheMisses: 0, revalidated: 0, staleFallbacks: 0 };
  const results: PromiseSettledResult<{ input: LiveSourceInput; outcome: DownloadOutcome }>[] = [];
  for (let i = 0; i < sources.length; i += concurrencyLimit) {
    const chunk = sources.slice(i, i + concurrencyLimit);
    const chunkPromises = chunk.map((s) =>
      downloadLive(s, fetchTimeoutMs, stats, browserFallback).then((outcome) => ({ input: s, outcome })),
    );
    const chunkResults = await Promise.allSettled(chunkPromises);
    results.push(...chunkResults);
  }
  await savePersistentLiveSourceCache(storage);
  return { results, stats };
}
// ─── 严格过滤：移除含 "type" 字段/字样的危险值 ────────

/**
 * TVBox 通过 `lives.contains("type")` 字符串匹配判断格式
 * 输出 Native 格式时，任何出现 `"type"` 字面量都会被误判为 FongMi 格式
 * 策略：对 group/name 中出现 "type" 字样做替换；URL 单独走 scrubUrlType
 */
function scrubTypeLiteral(s: string): string {
  return s.replace(/type/gi, 'tp');
}

/**
 * URL 中的 type 子串做 RFC 3986 URL-encode（首字符 t/T → %74/%54），
 * 保留原大小写以兼容 case-sensitive 的查询参数校验
 * 主流 HTTP 服务器会自动 URL-decode 还原为原串，功能不受影响
 * 用于 urls[] 元素，避免 TVBox lives.contains("type") 误判
 */
function scrubUrlType(url: string): string {
  return url.replace(/type/gi, (m) => {
    const hex = m.charCodeAt(0).toString(16).toUpperCase();
    return '%' + hex + m.slice(1);
  });
}

// ─── 主合并流程 ────────────────────────────────────────

export interface MergeLivesResult {
  groups: TVBoxLiveGroup[];
  totalChannels: number;
  totalUrls: number;
  sourcesDownloaded: number;
  sourcesFailed: number;
  /** 通过候选池质量门禁、可参与后续质量排序的源数量。 */
  sourcesAccepted?: number;
  /** 按原始源 URL 记录的逐源质量度量，供代理清单与质量池回写。 */
  sourceMetrics?: Record<string, LiveSourceMetrics>;
  /** 按原始源 URL 记录的主要分类，供代理清单展示与分类下发使用。 */
  sourceCategories?: Record<string, LiveCategory>;
  /** 原始源 URL -> 最终写入 TXT 的 `$源名` 标签（已按合并器规则清洗）。 */
  sourceLabels?: Record<string, string>;
  cacheHits: number;
  cacheMisses: number;
  revalidated: number;
  staleFallbacks: number;
  /** 分离模式下按原始源 URL 预构建的过滤后 TXT（仅 CF 使用） */
  sourceTexts?: Record<string, string>;
}

interface PreparedLiveSource {
  input: LiveSourceInput;
  sourceName: string;
  prepared: PreparedSourceChannels;
  metrics: LiveSourceMetrics;
  qualityScore: number;
  /** 质量池排名，1 为最优；仅在全部源评分后回填。 */
  rank: number;
}

function liveSourceInputView(source: PreparedLiveSource) {
  return {
    key: source.input.url,
    url: source.input.url,
    health: source.metrics.health,
    everSucceeded: source.metrics.everSucceeded,
    lastFailure: source.metrics.lastFailure,
    qualityScore: source.qualityScore,
    channelCount: source.metrics.channelCount,
    playableRatio: source.metrics.playableRatio,
    adRatio: source.metrics.adRatio,
    downloadMs: source.metrics.downloadMs,
    successfulAt: source.metrics.successfulAt,
  };
}

function comparePreparedLiveSources(a: PreparedLiveSource, b: PreparedLiveSource): number {
  return compareLiveRank(liveSourceInputView(a), liveSourceInputView(b));
}

function sourceFailureMetrics(
  failure: LiveDownloadFailure | undefined,
  checkedAt: string,
): LiveSourceMetrics {
  return {
    health: 'unhealthy',
    lastFailure: failure === 'invalid' ? 'invalid' : 'transient',
    everSucceeded: false,
    now: Date.parse(checkedAt),
  };
}

function sourceSuccessMetrics(
  prepared: PreparedSourceChannels,
  quality: SourceQualityDecision,
  downloadMs: number | undefined,
  checkedAt: string,
  staleFallback = false,
): LiveSourceMetrics {
  if (staleFallback && !quality.discard) {
    // 本轮网络失败、仅命中本地陈旧缓存：内容可用于兜底下发，但不能冒充当前健康源，
    // 否则排序会把实际不可达的源排在真正可用的源前面，误导简单/分类 TopN。
    return {
      health: 'unhealthy',
      everSucceeded: true,
      channelCount: prepared.channels.length,
      totalEntries: prepared.totalEntries,
      usableEntries: prepared.usableEntries,
      playableRatio: quality.playableRatio ?? null,
      adRatio: quality.adRatio ?? null,
      downloadMs: downloadMs ?? null,
      successfulAt: checkedAt,
      lastFailure: 'transient',
      now: Date.parse(checkedAt),
    };
  }
  return {
    health: quality.discard ? 'unhealthy' : 'healthy',
    everSucceeded: !quality.discard,
    channelCount: prepared.channels.length,
    totalEntries: prepared.totalEntries,
    usableEntries: prepared.usableEntries,
    playableRatio: quality.playableRatio ?? null,
    adRatio: quality.adRatio ?? null,
    downloadMs: downloadMs ?? null,
    successfulAt: quality.discard ? null : checkedAt,
    ...(quality.discard ? { lastFailure: 'invalid' as const } : {}),
    now: Date.parse(checkedAt),
  };
}

function mergeResultDetails(
  groups: TVBoxLiveGroup[],
  totalUrls: number,
  sourcesDownloaded: number,
  sourcesFailed: number,
  downloadStats: LiveDownloadStats,
  sourceMetrics: Record<string, LiveSourceMetrics>,
  sourcesAccepted: number,
  sourceCategories?: Record<string, LiveCategory>,
  sourceTexts?: Record<string, string>,
  sourceLabels?: Record<string, string>,
): MergeLivesResult {
  const totalChannels = groups.reduce((sum, group) => sum + group.channels.length, 0);
  return {
    groups,
    totalChannels,
    totalUrls,
    sourcesDownloaded,
    sourcesFailed,
    sourcesAccepted,
    sourceMetrics,
    sourceCategories,
    sourceLabels,
    cacheHits: downloadStats.cacheHits,
    cacheMisses: downloadStats.cacheMisses,
    revalidated: downloadStats.revalidated,
    staleFallbacks: downloadStats.staleFallbacks,
    ...(sourceTexts ? { sourceTexts } : {}),
  };
}

export async function mergeLivesToNative(
  sources: LiveSourceInput[],
  fetchTimeoutMs: number,
  channelSpeedMap?: ChannelSpeedMap,
  storage?: Storage,
  options: { preserveAllUrls?: boolean; candidatePoolMaxUrlsPerChannel?: number } = {},
): Promise<MergeLivesResult> {
  if (sources.length === 0) {
    return {
      groups: [], totalChannels: 0, totalUrls: 0,
      sourcesDownloaded: 0, sourcesFailed: 0, sourcesAccepted: 0, sourceMetrics: {}, sourceCategories: {},
      cacheHits: 0, cacheMisses: 0, revalidated: 0, staleFallbacks: 0,
    };
  }

  console.log(`[live-merger] Downloading ${sources.length} live source files...`);

  // 分批并发下载，限制内存占用（防止免费容器 OOM 崩溃）
  const { results: downloadResults, stats: downloadStats } = await downloadLiveBatched(sources, fetchTimeoutMs, 3, storage);

  let sourcesDownloaded = 0;
  let sourcesFailed = 0;
  const checkedAt = new Date().toISOString();
  const sourceMetrics: Record<string, LiveSourceMetrics> = {};
  const sourceCategories: Record<string, LiveCategory> = {};
  const usedSourceLabels = new Set<string>();
  const preparedSources: PreparedLiveSource[] = [];

  // 关键顺序：先逐源解析与评分，再按统一质量排序，最后才合并频道。
  // 禁止边下载边按原始顺序把线路写入频道，否则后续排序无法纠正首源偏置。
  for (let i = 0; i < downloadResults.length; i++) {
    const r = downloadResults[i];
    if (r.status !== 'fulfilled') {
      const input = sources[i];
      if (input) sourceMetrics[input.url] = sourceFailureMetrics('transient', checkedAt);
      sourcesFailed++;
      continue;
    }
    const { input, outcome } = r.value;
    if (!outcome.content) {
      sourceMetrics[input.url] = sourceFailureMetrics(outcome.failure, checkedAt);
      sourcesFailed++;
      continue;
    }
    sourcesDownloaded++;
    try {
      const sourceName = await uniqueSourceLabel(input.name || 'source', input.url, usedSourceLabels);
      const entries = parseLiveContent(outcome.content, sourceName, input.speedMs);
      const prepared = prepareSourceChannels(entries, channelSpeedMap, {
        maxUrlsPerChannel: options.preserveAllUrls ? Math.max(1, options.candidatePoolMaxUrlsPerChannel ?? 64) : SEPARATED_MAX_URLS_PER_CHANNEL,
        maxSpeedMs: options.preserveAllUrls ? 0 : LIVE_KNOWN_MAX_SPEED_MS,
      });
      const quality = evaluateSourceQuality(prepared, {
        minChannelsPerSource: SEPARATED_MIN_CHANNELS_PER_SOURCE,
        maxAdRatio: SEPARATED_MAX_AD_RATIO,
        minPlayableRatio: SEPARATED_MIN_PLAYABLE_RATIO,
      });
      const metrics = sourceSuccessMetrics(prepared, quality, outcome.downloadMs, checkedAt, outcome.staleFallback);
      sourceMetrics[input.url] = metrics;
      if (quality.discard) {
        console.log(`[live-merger] Discarded live source ${sourceName}: ${quality.reason}`);
        continue;
      }
      sourceCategories[input.url] = classifyLiveCategory(prepared.channels.map((item) => item.group));
      preparedSources.push({
        input,
        sourceName,
        prepared,
        metrics,
        qualityScore: computeLiveSourceQualityScore(metrics),
        rank: 0,
      });
    } catch (err) {
      sourceMetrics[input.url] = sourceFailureMetrics('invalid', checkedAt);
      console.warn(`[live-merger] Parse failed for ${input.name}: ${err}`);
    }
  }

  preparedSources.sort(comparePreparedLiveSources);
  preparedSources.forEach((source, index) => { source.rank = index + 1; });

  const allEntries: ChannelEntry[] = [];
  for (const source of preparedSources) {
    for (const { group, channel } of source.prepared.channels) {
      for (const url of channel.urls) {
        allEntries.push({
          group,
          name: channel.name,
          url,
          source: source.sourceName,
          sourceSpeedMs: source.input.speedMs,
          sourceQuality: source.qualityScore,
          sourceRank: source.rank,
          sourceDownloadMs: source.metrics.downloadMs ?? undefined,
        });
      }
    }
  }

  console.log(
    `[live-merger] Downloaded ${sourcesDownloaded}/${sources.length} sources, ` +
    `accepted ${preparedSources.length}, parsed ${allEntries.length} channel entries`,
  );

  interface AggChannel {
    group: string;
    rawName: string;
    logo?: string;
    urls: Map<string, ChannelEntry>;
  }
  const channelMap = new Map<string, AggChannel>();

  // 源已按质量排序，因此首次出现的 group/name/logo 来自当前质量最高的源。
  for (const e of allEntries) {
    const normName = normalizeChannelName(e.name);
    if (!normName) continue;
    let agg = channelMap.get(normName);
    if (!agg) {
      agg = { group: e.group || '其他', rawName: e.name, logo: e.logo, urls: new Map() };
      channelMap.set(normName, agg);
    }
    if (!agg.urls.has(e.url)) agg.urls.set(e.url, e);
    if (!agg.logo && e.logo) agg.logo = e.logo;
  }

  const groupMap = new Map<string, TVBoxLiveChannel[]>();
  let totalUrls = 0;

  for (const [, agg] of channelMap) {
    const urlList = Array.from(agg.urls.values()).filter((e) => {
      if (options.preserveAllUrls) return true;
      return channelSpeedMap?.[e.url]?.kind !== 'fail';
    });
    if (urlList.length === 0) continue;
    urlList.sort((a, b) => compareLiveEntries(a, b, channelSpeedMap));

    const limitedUrlList = options.preserveAllUrls
      ? urlList.slice(0, Math.max(1, options.candidatePoolMaxUrlsPerChannel ?? 64))
      : urlList.slice(0, AGGREGATED_MAX_URLS_PER_CHANNEL);

    const urlStrs = limitedUrlList.map((e) => `${scrubUrlType(e.url)}$${scrubTypeLiteral(e.source)}`);
    totalUrls += urlStrs.length;

    const channel: TVBoxLiveChannel = { name: scrubTypeLiteral(agg.rawName), urls: urlStrs };
    const groupKey = scrubTypeLiteral(agg.group || '其他');
    let list = groupMap.get(groupKey);
    if (!list) { list = []; groupMap.set(groupKey, list); }
    list.push(channel);
  }

  const groups: TVBoxLiveGroup[] = [];
  for (const [group, channels] of groupMap) {
    groups.push({ group, channels: [...channels].sort((a, b) => compareLiveChannelNames(a.name, b.name)) });
  }

  // 最终安全校验（双保险第二道）：先清理字段名，再扫描值内 type 子串。
  let finalJson = JSON.stringify(groups);
  let cleanedGroups: TVBoxLiveGroup[] = groups;
  if (/"type"\s*:/i.test(finalJson)) {
    console.warn('[live-merger] WARNING: "type" field leaked into output, stripping...');
    finalJson = finalJson
      .replace(/,\s*"type"\s*:\s*("[^"]*"|[\d.]+|null|true|false)/gi, '')
      .replace(/"type"\s*:\s*("[^"]*"|[\d.]+|null|true|false)\s*,?/gi, '');
    cleanedGroups = JSON.parse(finalJson);
  }
  if (/type/i.test(finalJson)) {
    console.warn('[live-merger] WARNING: "type" substring in value, encoding to %74ype...');
    finalJson = finalJson.replace(/type/gi, (m) => {
      const hex = m.charCodeAt(0).toString(16).toUpperCase();
      return '%' + hex + m.slice(1);
    });
    cleanedGroups = JSON.parse(finalJson);
  }

  console.log(
    `[live-merger] Merged ${cleanedGroups.reduce((sum, group) => sum + group.channels.length, 0)} channels / ${totalUrls} URLs across ${cleanedGroups.length} groups`,
  );
  const sourceLabels: Record<string, string> = {};
  for (const source of preparedSources) sourceLabels[source.input.url] = source.sourceName;

  // 合并模式同样必须为每个源生成可独立验证/复检的 TXT 正文。
  // /live 返回聚合文本，但清单 textReady 仍按源记录；否则合并模式下
  // 全部条目都会因缺少文本就绪证明而被质量池和下发池排除。
  const sourceTexts: Record<string, string> = {};
  for (const source of preparedSources) {
    const byGroup = new Map<string, TVBoxLiveChannel[]>();
    for (const { group, channel } of source.prepared.channels) {
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group)!.push(channel);
    }
    const sourceGroups: TVBoxLiveGroup[] = [];
    for (const [group, channels] of byGroup) {
      sourceGroups.push({ group: scrubTypeLiteral(group), channels });
    }
    const sourceText = formatLiveGroupsAsTxt(sourceGroups);
    if (sourceText.trim() && sourceText.includes('#genre#')) {
      sourceTexts[source.input.url] = sourceText;
    }
  }

  return mergeResultDetails(
    cleanedGroups,
    totalUrls,
    sourcesDownloaded,
    sourcesFailed,
    downloadStats,
    sourceMetrics,
    preparedSources.length,
    sourceCategories,
    sourceTexts,
    sourceLabels,
  );
}

/**
 * 按源分离模式：每个源独立解析，保留上游 group 名，不做跨源去重。
 * 仍然先完成全部源的下载、解析、质量评分与统一排序，再生成输出；
 * 因此全局频道上限只截断质量靠后的源，不会让先下载的劣质源抢占配额。
 */
export async function separatedMergeLives(
  sources: LiveSourceInput[],
  fetchTimeoutMs: number,
  channelSpeedMap?: ChannelSpeedMap,
  storage?: Storage,
  options: { preserveAllUrls?: boolean; candidatePoolMaxUrlsPerChannel?: number } = {},
): Promise<MergeLivesResult> {
  if (sources.length === 0) {
    return {
      groups: [], totalChannels: 0, totalUrls: 0,
      sourcesDownloaded: 0, sourcesFailed: 0, sourcesAccepted: 0, sourceMetrics: {}, sourceCategories: {}, sourceTexts: {},
      cacheHits: 0, cacheMisses: 0, revalidated: 0, staleFallbacks: 0,
    };
  }

  console.log(`[live-merger] Separated mode: downloading ${sources.length} live source files...`);
  const { results: downloadResults, stats: downloadStats } = await downloadLiveBatched(sources, fetchTimeoutMs, 3, storage);

  let sourcesDownloaded = 0;
  let sourcesFailed = 0;
  const checkedAt = new Date().toISOString();
  const sourceMetrics: Record<string, LiveSourceMetrics> = {};
  const sourceCategories: Record<string, LiveCategory> = {};
  // 同名不同 URL 的源必须使用不同的源标签，否则按源屏蔽/置顶会
  // 同时误伤另一个源，且清单名称与 TXT 标签无法一一对应。
  const usedSourceLabels = new Set<string>();
  const preparedSources: PreparedLiveSource[] = [];

  for (const r of downloadResults) {
    if (r.status !== 'fulfilled') {
      sourcesFailed++;
      continue;
    }
    const { input, outcome } = r.value;
    if (!outcome.content) {
      sourceMetrics[input.url] = sourceFailureMetrics(outcome.failure, checkedAt);
      sourcesFailed++;
      continue;
    }
    sourcesDownloaded++;
    try {
      const sourceName = await uniqueSourceLabel(input.name || 'source', input.url, usedSourceLabels);
      const entries = parseLiveContent(outcome.content, sourceName, input.speedMs);
      const prepared = prepareSourceChannels(entries, channelSpeedMap, {
        maxUrlsPerChannel: options.preserveAllUrls ? Math.max(1, options.candidatePoolMaxUrlsPerChannel ?? 64) : SEPARATED_MAX_URLS_PER_CHANNEL,
        maxSpeedMs: options.preserveAllUrls ? 0 : LIVE_KNOWN_MAX_SPEED_MS,
      });
      const quality = evaluateSourceQuality(prepared, {});
      const metrics = sourceSuccessMetrics(prepared, quality, outcome.downloadMs, checkedAt);
      sourceMetrics[input.url] = metrics;
      if (quality.discard) {
        console.log(`[live-merger] Discarded live source ${sourceName}: ${quality.reason}`);
        continue;
      }
      sourceCategories[input.url] = classifyLiveCategory(prepared.channels.map((item) => item.group));
      preparedSources.push({
        input,
        sourceName,
        prepared,
        metrics,
        qualityScore: computeLiveSourceQualityScore(metrics),
        rank: 0,
      });
    } catch (err) {
      sourceMetrics[input.url] = sourceFailureMetrics('invalid', checkedAt);
      console.warn(`[live-merger] Separated parse failed for ${input.name}: ${err}`);
    }
  }

  preparedSources.sort(comparePreparedLiveSources);
  preparedSources.forEach((source, index) => { source.rank = index + 1; });

  const allGroups: TVBoxLiveGroup[] = [];
  const sourceTexts: Record<string, string> = {};
  let totalChannels = 0;
  let totalUrls = 0;

  for (const source of preparedSources) {
    const byGroup = new Map<string, TVBoxLiveChannel[]>();
    for (const { group, channel } of source.prepared.channels) {
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group)!.push(channel);
    }

    const sourceGroups: TVBoxLiveGroup[] = [];
    for (const [group, channels] of byGroup) {
      const groupValue = { group: scrubTypeLiteral(group), channels };
      sourceGroups.push(groupValue);
    }
    const sourceText = formatLiveGroupsAsTxt(sourceGroups);
    if (sourceText.trim() && sourceText.includes('#genre#')) {
      sourceTexts[source.input.url] = sourceText;
    }

    for (const groupValue of sourceGroups) {
      if (totalChannels >= SEPARATED_MAX_CHANNELS) break;
      const remaining = SEPARATED_MAX_CHANNELS - totalChannels;
      const limited = groupValue.channels.slice(0, remaining);
      if (limited.length === 0) continue;
      allGroups.push({ group: groupValue.group, channels: limited });
      totalChannels += limited.length;
      for (const channel of limited) totalUrls += channel.urls.length;
    }
  }

  console.log(`[live-merger] Separated done: ${sourcesDownloaded}/${sources.length} sources, accepted=${preparedSources.length}, ${allGroups.length} groups, ${totalChannels} channels`);
  const sourceLabels: Record<string, string> = {};
  for (const source of preparedSources) sourceLabels[source.input.url] = source.sourceName;
  return mergeResultDetails(
    allGroups,
    totalUrls,
    sourcesDownloaded,
    sourcesFailed,
    downloadStats,
    sourceMetrics,
    preparedSources.length,
    sourceCategories,
    sourceTexts,
    sourceLabels,
  );
}

/** URL 是否以 `源名#8位以上短哈希` 形态承载源标签。 */
function isLiveSourceLabelToken(value: string): boolean {
  const token = (value || '').trim();
  if (!token) return false;
  // 覆盖合并器的 `源名#短哈希` 与同名冲突时的 `源名#短哈希-2`。
  return /^[^#\s].*#[0-9a-f]{8,64}(?:-\d+)?$/i.test(token);
}

/**
 * 从合并输出中拆分「裸 URL」与「源标签」。
 *
 * 合并树的正式格式是 `URL$源标签`；运行时 TXT 会写成 `URL#源标签`，
 * 因此两种形态都要兼容。`#` 分支只接受 `源名#短哈希` 的严格标签形态，
 * 避免把普通 URL fragment 截成裸 URL。
 */
function splitLiveUrlLabel(url: string): { bare: string; label: string } {
  const trimmed = url.trim();
  const dollar = trimmed.lastIndexOf('$');
  if (dollar > 0 && dollar < trimmed.length - 1) {
    return { bare: trimmed.slice(0, dollar), label: trimmed.slice(dollar + 1) };
  }

  const hash = trimmed.lastIndexOf('#');
  if (hash > 0) {
    const candidate = trimmed.slice(hash + 1);
    if (/^[0-9a-f]{8,64}(?:-\d+)?$/i.test(candidate)) {
      const separator = trimmed.lastIndexOf('#', hash - 1);
      if (separator > 0) {
        const label = trimmed.slice(separator + 1);
        if (isLiveSourceLabelToken(label)) {
          return { bare: trimmed.slice(0, separator), label };
        }
      }
    }
  }
  return { bare: trimmed, label: '' };
}

function bareLiveUrl(url: string): string {
  return splitLiveUrlLabel(url).bare;
}

/** 提取线路所属的裸 URL，供标签过滤与候选索引复用。 */
export function bareLiveSourceUrl(url: string): string {
  return bareLiveUrl(url);
}

export interface LiveCandidatePoolSnapshot {
  version: 1;
  groups: TVBoxLiveGroup[];
}

export interface ParsedLiveCandidatePool {
  groups: TVBoxLiveGroup[];
  urls: string[];
  source: 'structured' | 'legacy-urls' | 'none';
}

function normalizeCandidateGroups(value: unknown): TVBoxLiveGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: TVBoxLiveGroup[] = [];
  for (const rawGroup of value) {
    if (!rawGroup || typeof rawGroup !== 'object') continue;
    const groupValue = rawGroup as Record<string, unknown>;
    const groupName = typeof groupValue.group === 'string' ? groupValue.group.trim() : '';
    if (!groupName || !Array.isArray(groupValue.channels)) continue;
    const channels: TVBoxLiveChannel[] = [];
    for (const rawChannel of groupValue.channels) {
      if (!rawChannel || typeof rawChannel !== 'object') continue;
      const channelValue = rawChannel as Record<string, unknown>;
      const name = typeof channelValue.name === 'string' ? channelValue.name.trim() : '';
      if (!name || !Array.isArray(channelValue.urls)) continue;
      const urls = channelValue.urls
        .filter((url): url is string => typeof url === 'string')
        .map((url) => url.trim())
        .filter(Boolean);
      if (urls.length > 0) channels.push({ name, urls });
    }
    if (channels.length > 0) groups.push({ group: groupName, channels });
  }
  return groups;
}

/** 序列化可持久化的完整候选树；旧版裸 URL 数组仍可被解析函数兼容。 */
export function serializeLiveCandidatePool(groups: readonly TVBoxLiveGroup[]): string {
  const snapshot: LiveCandidatePoolSnapshot = {
    version: 1,
    groups: normalizeCandidateGroups(groups),
  };
  return JSON.stringify(snapshot);
}

/**
 * 解析持久化候选池。
 *
 * 新格式保留分组、频道与 `$源标签`，重启后可完整重建下发输出；旧格式只有裸 URL，
 * 仅能恢复探测面，不能冒充完整频道树。这样可在升级过渡期避免错误下发。
 */
export function parseLiveCandidatePool(raw: string | null): ParsedLiveCandidatePool {
  if (!raw) return { groups: [], urls: [], source: 'none' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const urls = Array.from(new Set(
        parsed
          .filter((url): url is string => typeof url === 'string')
          .map((url) => url.trim())
          .filter(Boolean),
      ));
      const groups = urls.length > 0
        ? [{ group: '候选恢复', channels: [{ name: '全部线路', urls }] }]
        : [];
      return { groups, urls, source: urls.length > 0 ? 'legacy-urls' : 'none' };
    }
    if (!parsed || typeof parsed !== 'object') return { groups: [], urls: [], source: 'none' };
    const snapshot = parsed as Record<string, unknown>;
    if (snapshot.version !== 1) return { groups: [], urls: [], source: 'none' };
    const groups = normalizeCandidateGroups(snapshot.groups);
    if (groups.length === 0) return { groups: [], urls: [], source: 'none' };
    const urls = Array.from(new Set(groups.flatMap((group) =>
      group.channels.flatMap((channel) => channel.urls.map((url) => bareLiveUrl(url).trim()).filter(Boolean)),
    )));
    return { groups, urls, source: 'structured' };
  } catch {
    return { groups: [], urls: [], source: 'none' };
  }
}

export function extractAllUrls(groups: TVBoxLiveGroup[]): string[] {
  const set = new Set<string>();
  for (const g of groups) {
    for (const ch of g.channels) {
      for (const u of ch.urls) {
        const bare = bareLiveUrl(u);
        if (bare) set.add(bare);
      }
    }
  }
  return Array.from(set);
}

/**
 * 将频道级验真结果应用到已合并的频道树。
 *
 * 下发语义：
 * - 已验证成功且未超速的线路按速度优先；
 * - 未知线路保留为后备，但始终排在已验证线路之后；
 * - 单次/两次失败保留为最后备选，连续三次失败才剔除；
 * - 每频道条数限制在分层之后执行，避免坏线路挤掉好线路。
 */
export function applyChannelSpeedToGroups(
  groups: TVBoxLiveGroup[],
  speedMap: ChannelSpeedMap,
  maxSpeedMs = LIVE_KNOWN_MAX_SPEED_MS,
  maxUrlsPerChannel = SEPARATED_MAX_URLS_PER_CHANNEL,
): TVBoxLiveGroup[] {
  const speedLimit = Math.max(0, maxSpeedMs);
  const perChannelLimit = Math.max(1, maxUrlsPerChannel);
  const output: TVBoxLiveGroup[] = [];

  for (const group of groups) {
    const channels: TVBoxLiveChannel[] = [];
    for (const channel of group.channels || []) {
      const seen = new Set<string>();
      const verified: Array<{ url: string; speed: number; index: number }> = [];
      const unknown: Array<{ url: string; index: number }> = [];
      const transient: Array<{ url: string; index: number }> = [];

      for (const [index, rawUrl] of (channel.urls || []).entries()) {
        const url = rawUrl.trim();
        if (!url) continue;
        const bare = bareLiveUrl(url);
        if (!bare || seen.has(bare)) continue;
        seen.add(bare);

        const speed = speedMap[url] ?? speedMap[bare];
        if (speed?.kind === 'fail') {
          // 单次或两次失败仍保留为后备；连续三次失败才剔除，避免网络抖动
          // 让频道直接空掉，同时不让失败线路排在已验证线路之前。
          const failures = speed.consecutiveFailures ?? 1;
          if (failures < 3) transient.push({ url, index });
          continue;
        }
        const knownSpeed = speed && Number.isFinite(speed.speedMs) ? speed.speedMs : undefined;
        if (knownSpeed == null) {
          unknown.push({ url, index });
          continue;
        }
        if (speedLimit > 0 && knownSpeed > speedLimit) continue;
        verified.push({ url, speed: knownSpeed, index });
      }

      verified.sort((a, b) => a.speed - b.speed || a.index - b.index);
      unknown.sort((a, b) => a.index - b.index);
      transient.sort((a, b) => a.index - b.index);
      const selected = [...verified, ...unknown, ...transient];
      const urls = selected.slice(0, perChannelLimit).map((item) => item.url);
      if (urls.length > 0) channels.push({ ...channel, urls });
    }
    if (channels.length > 0) output.push({ ...group, channels });
  }

  return output;
}

/**
 * 从候选树中按频道提取优先探测线路。
 *
 * 目标是先覆盖“当前最可能被下发”的线路，而不是一次性测完整个候选池：
 * - 已成功且速度可用的线路优先，按速度从快到慢；
 * - 未知线路随后保留，保证新源有机会进入前沿；
 * - 已明确失败的线路不进入优先集合；
 * - 每个频道最多取 limit 条，避免单一热门频道吞掉全部预算。
 */
export function extractPreferredLiveUrls(
  groups: readonly TVBoxLiveGroup[],
  speedMap: ChannelSpeedMap = {},
  limitPerChannel = 2,
): string[] {
  const maxPerChannel = Math.max(1, limitPerChannel);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const channel of group.channels || []) {
      const ranked: Array<{ bare: string; speed?: number; index: number }> = [];
      const channelSeen = new Set<string>();
      for (const [index, raw] of (channel.urls || []).entries()) {
        const parsed = splitLiveUrlLabel(raw);
        const bare = parsed.bare.trim();
        if (!bare || channelSeen.has(bare)) continue;
        channelSeen.add(bare);
        const entry = speedMap[raw] ?? speedMap[bare];
        if (entry?.kind === 'fail') continue;
        ranked.push({
          bare,
          speed: entry && Number.isFinite(entry.speedMs) ? entry.speedMs : undefined,
          index,
        });
      }
      ranked.sort((a, b) => {
        if (a.speed != null && b.speed != null && a.speed !== b.speed) return a.speed - b.speed;
        if (a.speed != null && b.speed == null) return -1;
        if (a.speed == null && b.speed != null) return 1;
        return a.index - b.index;
      });
      for (const item of ranked.slice(0, maxPerChannel)) {
        if (seen.has(item.bare)) continue;
        seen.add(item.bare);
        result.push(item.bare);
      }
    }
  }
  return result;
}

export function normalizeSourceLabelKey(value: string): string {
  return scrubTypeLiteral(sanitizeTxtLabel(value, "")).trim().toLowerCase();
}

/** 从合并输出中定位指定上游 URL 实际使用的 $源名 标签。 */
export function liveSourceLabelFromUrl(url: string, groups: readonly TVBoxLiveGroup[]): string {
  const target = (url || "").trim();
  if (!target) return "";
  for (const group of groups) {
    for (const channel of group.channels || []) {
      for (const raw of channel.urls || []) {
        const value = (raw || "").trim();
        const idx = value.lastIndexOf("$");
        if (idx <= 0) continue;
        if (bareLiveUrl(value) === target) return value.slice(idx + 1);
      }
    }
  }
  return "";
}

function channelSourceLabel(url: string): string {
  return splitLiveUrlLabel(url).label;
}

/**
 * 把「源级质量池」映射到「频道/线路输出」。
 *
 * 合并模式输出中每条线路形如 `http://xxx$源名`，`$` 后是写入时经过
 * scrubTypeLiteral 的源名。这里按同样的规范化口径匹配，只保留属于下发池
 * 的源，从而让屏蔽/超时/未入选的源不再出现在 /live、/live.json 与主配置中。
 *
 * 默认 fallbackToAll=false：用户明确选择下发池后，绝不能因一次映射失配回退成全量。
 * 避免因为一次映射失配把应用端直播整体清空；真正的屏蔽仍由上游门禁负责。
 */
export function filterGroupsBySourceLabels(
  groups: TVBoxLiveGroup[],
  selectedLabels: ReadonlySet<string>,
  fallbackToAll = false,
): TVBoxLiveGroup[] {
  if (selectedLabels.size === 0) return fallbackToAll ? groups : [];
  const matchedOutput: TVBoxLiveGroup[] = [];
  for (const group of groups) {
    const channels: TVBoxLiveChannel[] = [];
    for (const channel of group.channels || []) {
      const urls = (channel.urls || []).filter((url) => {
        const label = normalizeSourceLabelKey(channelSourceLabel(url));
        return label !== "" && selectedLabels.has(label);
      });
      if (urls.length > 0) channels.push({ ...channel, urls });
    }
    if (channels.length > 0) matchedOutput.push({ ...group, channels });
  }
  return matchedOutput.length > 0 ? matchedOutput : fallbackToAll ? groups : [];
}

/**
 * 重新按源质量优先级排列频道内线路顺序。
 * 合并阶段已按质量排序，这里主要服务于过滤后再排序、以及旧缓存重建顺序。
 */
export function reorderGroupsBySourcePriority(
  groups: TVBoxLiveGroup[],
  priorityLabels: readonly string[],
): TVBoxLiveGroup[] {
  if (priorityLabels.length === 0) return groups;
  const priority = new Map<string, number>();
  priorityLabels.forEach((label, index) => {
    const key = normalizeSourceLabelKey(label);
    if (!priority.has(key)) priority.set(key, index);
  });
  return groups.map((group) => ({
    ...group,
    channels: (group.channels || []).map((channel) => {
      const urls = [...(channel.urls || [])];
      urls.sort((a, b) => {
        const rankA = priority.get(normalizeSourceLabelKey(channelSourceLabel(a))) ?? Number.MAX_SAFE_INTEGER;
        const rankB = priority.get(normalizeSourceLabelKey(channelSourceLabel(b))) ?? Number.MAX_SAFE_INTEGER;
        return rankA - rankB;
      });
      return { ...channel, urls };
    }),
  }));
}

/**
 * 轻量级实时解析：给定一组 m3u/txt URL，下载并解析为 TVBoxLiveGroup[]
 * 用于 /live 端点在 FongMi 格式下实时转换
 */
export async function fetchAndParseLiveUrls(
  urls: Array<{ name: string; url: string; ua?: string; header?: Record<string, string> }>,
  timeoutMs = 8000,
  channelSpeedMap?: ChannelSpeedMap,
): Promise<TVBoxLiveGroup[]> {
  if (urls.length === 0) return [];

  const results = await Promise.allSettled(
    urls.map(async (input) => {
      if (isBlockedLiveSource(input)) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(input.url, {
          signal: controller.signal,
          headers: { 'User-Agent': input.ua || TVBOX_UA, ...(input.header || {}) },
        });
        if (!resp.ok) return null;
        const text = await readLimitedText(resp, controller.signal);
        if (!text || text.length < 20) return null;
        return { content: text, name: input.name };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const allEntries: Array<{ group: string; name: string; url: string }> = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    let entries = parseLiveContent(r.value.content, r.value.name);
    // 过滤广告频道
    entries = entries.filter(e => !isBlockedLiveUrl(e.url) && !AD_KEYWORDS.test(e.name) && !AD_KEYWORDS.test(e.group));
    allEntries.push(...entries);
  }

  // 按 group + name 合并 urls（过滤不可用链接）
  const groupMap = new Map<string, Map<string, string[]>>();
  for (const e of allEntries) {
    if (channelSpeedMap) {
      const speed = channelSpeedMap[e.url];
      if (speed?.kind === 'fail') continue;
    }

    const grp = e.group || '其他';
    if (!groupMap.has(grp)) groupMap.set(grp, new Map());
    const channels = groupMap.get(grp)!;
    if (!channels.has(e.name)) channels.set(e.name, []);
    const urls = channels.get(e.name)!;
    if (!urls.includes(e.url)) urls.push(e.url);
  }

  const groups: TVBoxLiveGroup[] = [];
  for (const [group, channels] of groupMap) {
    const chs: TVBoxLiveChannel[] = [];
    for (const [name, urls] of channels) {
      if (urls.length === 0) continue;
      chs.push({ name, urls });
    }
    if (chs.length === 0) continue;
    groups.push({ group, channels: [...chs].sort((a, b) => compareLiveChannelNames(a.name, b.name)) });
  }
  return groups;
}
export interface FilteredLiveOptions {
  /** 最少频道数；低于该值的上游源直接丢弃。默认 5。 */
  minChannelsPerSource?: number;
  /** 广告/状态类条目占比超过该值时整源丢弃。默认 0.5。 */
  maxAdRatio?: number;
  /** 已知测速线路中可用线路的最低占比。默认 0.2。 */
  minPlayableRatio?: number;
  /** 每个频道最多保留多少条可用线路 */
  maxUrlsPerChannel?: number;
  /** 最多输出多少个频道，0 表示不限制 */
  maxChannels?: number;
  /** 是否保留源名分组前缀 */
  preserveSourceGroups?: boolean;
  /** 已知线路的延迟上限；超过该值直接丢弃，0 表示不限制 */
  maxSpeedMs?: number;
  /** 启用下载缓存/批处理时使用的存储 */
  storage?: Storage;
  /** 下载并发上限（仅在启用缓存/批处理时生效） */
  concurrency?: number;
  /** 是否启用带缓存、限并发的下载路径 */
  useCache?: boolean;
  /** 是否保留临时失败的上游入口（默认 true，避免一次限流就清空清单） */
  preserveTransientFailures?: boolean;
}

export interface FilteredLiveSourceResult {
  valid: LiveSourceInput[];
  invalid: LiveSourceInput[];
  transient: LiveSourceInput[];
  /** 按原始源 URL 预构建的过滤后 TXT，供 CF /live/<key> 直接复用。 */
  texts: Record<string, string>;
  /** 按原始源 URL 记录的逐源质量度量，供 CF 代理清单回写。 */
  metrics: Record<string, LiveSourceMetrics>;
  /** 按原始源 URL 记录的主要分类，供 CF 代理清单展示与分类下发。 */
  categories: Record<string, LiveCategory>;
}

const BAD_LIVE_URL = /^(?:about:blank|data:|javascript:|file:)/i;
const LIVE_STATUS_LABEL = /^(?:(?:列表)?(?:更新|发布|同步|校验)(?:时间|日期)?|最后更新|源地址|直播源地址|订阅地址|播放地址|备用地址|update(?:d)?(?:\s*time)?|last\s*update)(?:\s*[:：].*)?$/i;

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  // IPv4 literal: reject loopback, unspecified, link-local, private, CGNAT,
  // benchmarking and multicast/reserved ranges that can never be public streams.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number(part));
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  // IPv6 loopback / unspecified / link-local / unique-local / multicast.
  if (host.includes(':')) {
    return (
      host === '::' ||
      host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb') ||
      host.startsWith('fc') || host.startsWith('fd') ||
      host.startsWith('ff')
    );
  }
  return false;
}

function isUsableLiveUrl(raw: string): boolean {
  const url = raw.trim();
  if (!url || BAD_LIVE_URL.test(url) || isBlockedLiveUrl(url)) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (!parsed.hostname || parsed.username || parsed.password) return false;
    if (isPrivateOrLocalHostname(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

interface PreparedSourceChannels {
  channels: Array<{ group: string; channel: TVBoxLiveChannel }>;
  totalUrls: number;
  totalEntries: number;
  usableEntries: number;
  adEntries: number;
  statusEntries: number;
  invalidUrlEntries: number;
  knownSpeedEntries: number;
  knownFailedEntries: number;
  knownTooSlowEntries: number;
}

interface SourceQualityDecision {
  discard: boolean;
  reason?: string;
  adRatio?: number;
  playableRatio?: number;
}

function evaluateSourceQuality(
  prepared: PreparedSourceChannels,
  options: FilteredLiveOptions,
): SourceQualityDecision {
  const minChannels = Math.max(0, options.minChannelsPerSource ?? SEPARATED_MIN_CHANNELS_PER_SOURCE);
  const maxAdRatio = Math.min(1, Math.max(0, options.maxAdRatio ?? SEPARATED_MAX_AD_RATIO));
  const minPlayableRatio = Math.min(1, Math.max(0, options.minPlayableRatio ?? SEPARATED_MIN_PLAYABLE_RATIO));

  if (prepared.totalEntries === 0) {
    return { discard: true, reason: 'empty source' };
  }

  const adLike = prepared.adEntries + prepared.statusEntries;
  const adRatio = adLike / prepared.totalEntries;
  if (adLike >= 5 && adRatio > maxAdRatio) {
    return { discard: true, reason: 'ad ratio ' + (adRatio * 100).toFixed(1) + '%', adRatio };
  }

  if (prepared.channels.length < minChannels) {
    return {
      discard: true,
      reason: 'too few usable channels (' + prepared.channels.length + ' < ' + minChannels + ')',
    };
  }

  const knownUnplayable = prepared.knownFailedEntries + prepared.knownTooSlowEntries;
  const playableRatio = prepared.knownSpeedEntries > 0
    ? (prepared.knownSpeedEntries - knownUnplayable) / prepared.knownSpeedEntries
    : 1;
  if (prepared.knownSpeedEntries >= minChannels && playableRatio < minPlayableRatio) {
    return {
      discard: true,
      reason: 'low playable ratio ' + (playableRatio * 100).toFixed(1) + '%',
      playableRatio,
    };
  }

  return { discard: false, adRatio, playableRatio };
}

function knownLiveSpeed(entry: ChannelEntry, channelSpeedMap?: ChannelSpeedMap): number | undefined {
  const speed = channelSpeedMap?.[entry.url.trim()];
  return speed && speed.kind !== 'fail' ? speed.speedMs : undefined;
}

function compareLiveEntries(a: ChannelEntry, b: ChannelEntry, channelSpeedMap?: ChannelSpeedMap): number {
  // 先使用频道测速库中的真实可播速度；未测速的线路再进入源质量排序。
  const sa = knownLiveSpeed(a, channelSpeedMap);
  const sb = knownLiveSpeed(b, channelSpeedMap);
  if (sa != null && sb != null && sa !== sb) return sa - sb;
  if (sa != null && sb == null) return -1;
  if (sa == null && sb != null) return 1;

  // 速度相同或都未测得时，优先质量分更高的源。
  const qualityA = a.sourceQuality ?? 0;
  const qualityB = b.sourceQuality ?? 0;
  if (qualityA !== qualityB) return qualityB - qualityA;

  const rankA = a.sourceRank ?? Number.POSITIVE_INFINITY;
  const rankB = b.sourceRank ?? Number.POSITIVE_INFINITY;
  if (rankA !== rankB) return rankA - rankB;

  const downloadA = a.sourceDownloadMs ?? Number.POSITIVE_INFINITY;
  const downloadB = b.sourceDownloadMs ?? Number.POSITIVE_INFINITY;
  if (downloadA !== downloadB) return downloadA - downloadB;

  const sourceA = a.sourceSpeedMs ?? Number.POSITIVE_INFINITY;
  const sourceB = b.sourceSpeedMs ?? Number.POSITIVE_INFINITY;
  if (sourceA !== sourceB) return sourceA - sourceB;
  return a.url.localeCompare(b.url);
}

/**
 * 对单个直播源做质量过滤。不同源分别调用，因此这里只做源内去重，
 * 不会把一个源里的线路误当成另一个源的重复线路。
 */
function prepareSourceChannels(
  entries: ChannelEntry[],
  channelSpeedMap: ChannelSpeedMap | undefined,
  options: FilteredLiveOptions,
): PreparedSourceChannels {
  const maxUrlsPerChannel = Math.max(1, options.maxUrlsPerChannel ?? SEPARATED_MAX_URLS_PER_CHANNEL);
  const maxSpeedMs = Math.max(0, options.maxSpeedMs ?? LIVE_KNOWN_MAX_SPEED_MS);
  let adEntries = 0;
  let statusEntries = 0;
  let invalidUrlEntries = 0;
  let knownSpeedEntries = 0;
  let knownFailedEntries = 0;
  let knownTooSlowEntries = 0;

  const filtered = entries.filter((entry) => {
    const name = entry.name.trim();
    const group = (entry.group || '其他').trim();
    if (!name || !isUsableLiveUrl(entry.url)) {
      invalidUrlEntries++;
      return false;
    }
    if (LIVE_STATUS_LABEL.test(name) || LIVE_STATUS_LABEL.test(group)) {
      statusEntries++;
      return false;
    }
    if (AD_KEYWORDS.test(name) || AD_KEYWORDS.test(group)) {
      adEntries++;
      return false;
    }

    const speed = channelSpeedMap?.[entry.url.trim()];
    if (speed) {
      knownSpeedEntries++;
      if (speed.kind === 'fail') {
        knownFailedEntries++;
        return false;
      }
      if (maxSpeedMs > 0 && speed.speedMs > maxSpeedMs) {
        knownTooSlowEntries++;
        return false;
      }
    }
    return true;
  });
  filtered.sort((a, b) => compareLiveEntries(a, b, channelSpeedMap));

  const groupMap = new Map<string, Map<string, string[]>>();
  const seenUrls = new Set<string>();
  let totalUrls = 0;

  for (const entry of filtered) {
    const url = entry.url.trim();
    if (seenUrls.has(url)) continue;

    const group = scrubTypeLiteral((entry.group || '其他').trim());
    const name = scrubTypeLiteral(entry.name.trim());
    if (!groupMap.has(group)) groupMap.set(group, new Map());
    const channels = groupMap.get(group)!;
    if (!channels.has(name)) channels.set(name, []);
    const channelUrls = channels.get(name)!;
    seenUrls.add(url);
    if (channelUrls.length >= maxUrlsPerChannel) continue;

    channelUrls.push(scrubUrlType(url));
    totalUrls++;
  }

  const channels: Array<{ group: string; channel: TVBoxLiveChannel }> = [];
  for (const [group, groupChannels] of groupMap) {
    for (const [name, urls] of groupChannels) {
      if (urls.length > 0) channels.push({ group, channel: { name, urls } });
    }
  }

  return {
    channels,
    totalUrls,
    totalEntries: entries.length,
    usableEntries: filtered.length,
    adEntries,
    statusEntries,
    invalidUrlEntries,
    knownSpeedEntries,
    knownFailedEntries,
    knownTooSlowEntries,
  };
}

/**
 * 对一组上游直播源做完整的源级门禁。只有成功下载、能被解析，
 * 且通过频道数量、广告比例和已知线路可播放比例检查的源才会返回。
 * 返回原始输入对象，便于之后复用其 UA/header 或生成代理清单。
 */
export interface FilteredLiveGroupsResult {
  groups: TVBoxLiveGroup[];
  failure?: LiveDownloadFailure;
  reason?: string;
}

export async function filterLiveSourcesDetailed(
  sources: LiveSourceInput[],
  timeoutMs = 8000,
  channelSpeedMap?: ChannelSpeedMap,
  options: FilteredLiveOptions = {},
): Promise<FilteredLiveSourceResult> {
  if (sources.length === 0) return { valid: [], invalid: [], transient: [], texts: {}, metrics: {}, categories: {} };

  const blocked = sources.filter(isBlockedLiveSource);
  const candidates = blocked.length > 0 ? sources.filter((source) => !isBlockedLiveSource(source)) : sources;
  if (blocked.length > 0) {
    console.log('[live-merger] Blocked live sources: ' + blocked.map((source) => sanitizeTxtLabel(source.name || 'source', 'source')).join(', '));
  }
  if (candidates.length === 0) return { valid: [], invalid: blocked, transient: [], texts: {}, metrics: {}, categories: {} };

  const concurrency = Math.max(1, options.concurrency ?? 3);
  const batched = await downloadLiveBatched(
    candidates,
    timeoutMs,
    concurrency,
    options.storage,
    false,
  );

  const valid: LiveSourceInput[] = [];
  const invalid: LiveSourceInput[] = [];
  const transient: LiveSourceInput[] = [];
  const texts: Record<string, string> = {};
  const metrics: Record<string, LiveSourceMetrics> = {};
  const categories: Record<string, LiveCategory> = {};
  const checkedAt = new Date().toISOString();

  for (let i = 0; i < batched.results.length; i++) {
    const result = batched.results[i];
    if (result.status !== 'fulfilled') {
      const input = candidates[i];
      if (input) metrics[input.url] = sourceFailureMetrics('transient', checkedAt);
      transient.push(input);
      continue;
    }
    const { input, outcome } = result.value;
    const content = outcome.content;
    if (!content) {
      metrics[input.url] = sourceFailureMetrics(outcome.failure, checkedAt);
      if (outcome.failure === 'invalid') {
        invalid.push(input);
        console.log('[live-merger] Invalid live source ' + sanitizeTxtLabel(input.name || 'source', 'source') + ': ' + (outcome.reason || 'download failed'));
      } else {
        transient.push(input);
        console.log('[live-merger] Transient live failure ' + sanitizeTxtLabel(input.name || 'source', 'source') + ': ' + (outcome.reason || 'download failed'));
      }
      continue;
    }

    const sourceName = sanitizeTxtLabel(input.name || 'source', 'source');
    const entries = parseLiveContent(content, sourceName, input.speedMs);
    const prepared = prepareSourceChannels(entries, channelSpeedMap, {
      maxUrlsPerChannel: options.maxUrlsPerChannel ?? SEPARATED_MAX_URLS_PER_CHANNEL,
      maxSpeedMs: options.maxSpeedMs ?? LIVE_KNOWN_MAX_SPEED_MS,
    });
    const quality = evaluateSourceQuality(prepared, options);
    metrics[input.url] = sourceSuccessMetrics(prepared, quality, outcome.downloadMs, checkedAt);
    if (quality.discard) {
      invalid.push(input);
      console.log('[live-merger] Discarded live source ' + sourceName + ': ' + quality.reason);
      continue;
    }
    categories[input.url] = classifyLiveCategory(prepared.channels.map((item) => item.group));
    const sourceGroups: TVBoxLiveGroup[] = [];
    const byGroup = new Map<string, TVBoxLiveChannel[]>();
    for (const { group, channel } of prepared.channels) {
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group)!.push(channel);
    }
    for (const [group, channels] of byGroup) {
      if (channels.length > 0) sourceGroups.push({ group, channels });
    }
    const sourceText = formatLiveGroupsAsTxt(sourceGroups);
    if (sourceText.trim() && sourceText.includes('#genre#')) {
      texts[input.url] = sourceText;
      valid.push(input);
    } else {
      // 下载成功但没有产出可解析正文，不能算 valid；否则清单会继承旧
      // textReady，最终下发一个没有正文的 /live/<key>。
      metrics[input.url] = sourceFailureMetrics('invalid', checkedAt);
      invalid.push(input);
      console.log('[live-merger] Rejected live source without playable text ' + sourceName);
    }
  }

  console.log(`[live-merger] Validated ${valid.length}/${sources.length} live sources (invalid=${invalid.length + blocked.length}, transient=${transient.length})`);
  return { valid, invalid: [...invalid, ...blocked], transient, texts, metrics, categories };
}

/**
 * 兼容旧调用：只返回已确认有效的源。
 * 临时失败的上游由调用方按 preserveTransientFailures 决定是否保留。
 */
export async function filterValidLiveSources(
  sources: LiveSourceInput[],
  timeoutMs = 8000,
  channelSpeedMap?: ChannelSpeedMap,
  options: FilteredLiveOptions = {},
): Promise<LiveSourceInput[]> {
  const result = await filterLiveSourcesDetailed(sources, timeoutMs, channelSpeedMap, options);
  return options.preserveTransientFailures === false
    ? result.valid
    : [...result.valid, ...result.transient];
}
/**
 * 非聚合直播输出：按原始直播源分别解析，只过滤不良频道和线路，不跨源合并频道。
 * 这样应用端仍能区分不同来源，但不会直接拿到上游原始 m3u/txt 中的广告、
 * 失效线路、重复线路以及明显无效地址。
 */
export async function filterLivesBySourceDetailed(
  urls: Array<{ name: string; url: string; ua?: string; header?: Record<string, string> }>,
  timeoutMs = 8000,
  channelSpeedMap?: ChannelSpeedMap,
  options: FilteredLiveOptions = {},
): Promise<FilteredLiveGroupsResult> {
  if (urls.length === 0) return { groups: [] };
  const candidates = urls.filter((input) => !isBlockedLiveSource(input));
  if (candidates.length === 0) {
    return { groups: [], failure: 'invalid', reason: 'blocked source' };
  }

  const maxUrlsPerChannel = Math.max(1, options.maxUrlsPerChannel ?? SEPARATED_MAX_URLS_PER_CHANNEL);
  const maxChannels = Math.max(0, options.maxChannels ?? 0);
  const preserveSourceGroups = options.preserveSourceGroups !== false;
  const maxSpeedMs = Math.max(0, options.maxSpeedMs ?? LIVE_KNOWN_MAX_SPEED_MS);

  let results: PromiseSettledResult<{ content: string; name: string; failure?: LiveDownloadFailure; reason?: string }>[];
  const useBatchedDownloads = options.useCache !== false
    && (options.useCache === true || options.storage !== undefined || options.concurrency !== undefined);
  if (useBatchedDownloads) {
    const batched = await downloadLiveBatched(
      candidates.map((input) => ({
        name: input.name || 'source',
        url: input.url,
        ua: input.ua,
        header: input.header,
      })),
      timeoutMs,
      Math.max(1, options.concurrency ?? 3),
      options.storage,
      false,
    );
    results = batched.results.map((result): PromiseSettledResult<{ content: string; name: string; failure?: LiveDownloadFailure; reason?: string }> => {
      if (result.status !== 'fulfilled') {
        return { status: 'rejected', reason: result.reason };
      }
      const { outcome, input } = result.value;
      return {
        status: 'fulfilled',
        value: outcome.content
          ? { content: outcome.content, name: input.name || 'source' }
          : { content: '', name: input.name || 'source', failure: outcome.failure, reason: outcome.reason },
      };
    });
  } else {
    results = await Promise.allSettled(
      candidates.map(async (input) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(input.url, {
            signal: controller.signal,
            headers: { 'User-Agent': input.ua || TVBOX_UA, ...(input.header || {}) },
          });
          if (!resp.ok) {
            return { content: '', name: input.name || 'source', failure: failureFromHttpStatus(resp.status), reason: `HTTP ${resp.status}` };
          }
          const contentType = (resp.headers.get('content-type') || '').toLowerCase();
          const text = await readLimitedText(resp, controller.signal);
          if (!looksLikeLivePayload(text, contentType)) {
            return { content: '', name: input.name || 'source', failure: 'invalid', reason: text ? 'unexpected content' : 'empty content' };
          }
          return { content: text, name: input.name || 'source' };
        } catch (error: unknown) {
          return { content: '', name: input.name || 'source', failure: 'transient', reason: error instanceof Error ? error.message : String(error) };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }

  const groups: TVBoxLiveGroup[] = [];
  let emittedChannels = 0;

  let hasTransientFailure = false;
  let hasInvalidFailure = false;
  let reason: string | undefined;
  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value) {
      hasTransientFailure = true;
      reason ??= result.status === 'rejected' ? String(result.reason) : undefined;
      continue;
    }
    if (!result.value.content) {
      if (result.value.failure === 'invalid') {
        hasInvalidFailure = true;
      } else {
        hasTransientFailure = true;
      }
      reason ??= result.value.reason;
      continue;
    }
    const sourceName = sanitizeTxtLabel(result.value.name || 'source', 'source');
    const entries = parseLiveContent(result.value.content, sourceName);
    const prepared = prepareSourceChannels(entries, channelSpeedMap, {
      maxUrlsPerChannel,
      maxSpeedMs,
    });

    const quality = evaluateSourceQuality(prepared, options);
    if (quality.discard) {
      hasInvalidFailure = true;
      reason = quality.reason;
      console.log('[live-merger] Discarded live source ' + sourceName + ': ' + quality.reason);
      continue;
    }

    if (preserveSourceGroups) {
      const byGroup = new Map<string, TVBoxLiveChannel[]>();
      for (const { group, channel } of prepared.channels) {
        if (!byGroup.has(group)) byGroup.set(group, []);
        byGroup.get(group)!.push(channel);
      }
      for (const [group, channels] of byGroup) {
        if (maxChannels > 0 && emittedChannels >= maxChannels) break;
        const limited = maxChannels > 0 ? channels.slice(0, maxChannels - emittedChannels) : channels;
        if (limited.length === 0) continue;
        groups.push({ group: scrubTypeLiteral(group), channels: [...limited].sort((a, b) => compareLiveChannelNames(a.name, b.name)) });
        emittedChannels += limited.length;
      }
    } else {
      const remaining = maxChannels > 0 ? Math.max(0, maxChannels - emittedChannels) : prepared.channels.length;
      const limited = prepared.channels.slice(0, remaining);
      if (limited.length === 0) break;
      groups.push({ group: sourceName, channels: limited.map(({ channel }) => channel) });
      emittedChannels += limited.length;
    }

    if (maxChannels > 0 && emittedChannels >= maxChannels) break;
  }

  return {
    groups,
    failure: groups.length > 0
      ? undefined
      : hasTransientFailure
        ? 'transient'
        : hasInvalidFailure
          ? 'invalid'
          : undefined,
    reason: groups.length > 0 ? undefined : reason,
  };
}

/**
 * 兼容旧调用：仅返回已生成的分组。
 */
export async function filterLivesBySource(
  urls: Array<{ name: string; url: string; ua?: string; header?: Record<string, string> }>,
  timeoutMs = 8000,
  channelSpeedMap?: ChannelSpeedMap,
  options: FilteredLiveOptions = {},
): Promise<TVBoxLiveGroup[]> {
  const result = await filterLivesBySourceDetailed(urls, timeoutMs, channelSpeedMap, options);
  return result.groups;
}
/** 从完整频道树中提取属于指定源标签的全部裸 URL。 */
export function extractUrlsForSourceLabels(
  groups: readonly TVBoxLiveGroup[],
  selectedLabels: ReadonlySet<string>,
): string[] {
  if (selectedLabels.size === 0) return [];
  const set = new Set<string>();
  for (const group of groups) {
    for (const channel of group.channels || []) {
      for (const raw of channel.urls || []) {
        const parsed = splitLiveUrlLabel(raw);
        const label = normalizeSourceLabelKey(parsed.label);
        if (!label || !selectedLabels.has(label)) continue;
        if (parsed.bare) set.add(parsed.bare);
      }
    }
  }
  return Array.from(set);
}
