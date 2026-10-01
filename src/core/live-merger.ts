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
function formatLiveGroupsAsTxtInternal(
  groups: TVBoxLiveGroup[],
  canonicalizeChannels: boolean,
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

    lines.push(`${groupName},#genre#`);
    for (const channel of outputChannels) {
      lines.push(`${channel.name},${channel.urls.join('#')}`);
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
  const base = sanitizeTxtLabel(raw, '未命名').trim();
  if (!/^(?:CCTV|中央|央视)/i.test(base)) return base;
  const cleaned = base
    .replace(/\s*(?:高清|超清|蓝光|4k|1080p?|720p?)$/i, '')
    .replace(/[-_\s]*(?:咪咕|移动)$/i, '')
    .trim();
  const match = cleaned.match(
    /^(?:CCTV|中央|央视)[-_\s]*0*(\d{1,2})(\+)?(?:[-_\s]+\d+)?(?:[-_\s]*(综合|财经|中文国际|体育|电影|军事|电视剧|纪录|科教|戏曲|社会与法|新闻|少儿|音乐|奥林匹克|农业农村))?$/i,
  );
  if (!match) return cleaned;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 1 || number > 17) return cleaned;
  return `CCTV-${number}${match[2] ? '+' : ''}`;
}

/**
 * 对聚合后的频道做有限的内容纠偏。
 *
 * 上游存在把地方综合台塞进“纪录频道”、把港剧塞进“电影频道”、
 * 把地方频道塞进“卫视/央视”等情况。这里只识别语义非常明确的频道名，
 * 且把地方/省/市/县频道组整体保留在“地方”，避免把普通地方新闻、综合、
 * 生活台拆散成多个只有几个台的小分类。
 */
function normalizeAggregateChannelGroup(
  rawGroup: string,
  rawChannelName: string,
): string {
  const group = normalizeAggregateGroupName(rawGroup);
  const name = sanitizeTxtLabel(rawChannelName, '未命名');
  const rawGroupCompact = sanitizeTxtLabel(rawGroup, '').replace(/\s+/g, '').toLowerCase();
  const compact = name.replace(/\s+/g, '').toLowerCase();
  if (!compact) return group;

  // 主播/一起看、风景直播分组里频道名常是主播昵称，整组保留。
  if (group === '一起看' || group === '风景直播') return group;

  // 语义唯一、不会被地方台重名的频道，先于地方/卫视兜底归位。
  if (/^(?:cctv)?(?:第一剧场|怀旧剧场|文化精品|风云剧场|兵器科技|电视指南|发现之旅|老故事)$/.test(compact)) return '影视';
  if (/第一财经/.test(compact)) return '新闻财经';
  if (/教育|学习/.test(compact)) return '教育';
  if (/之江纪录|cgtn纪录|cgtn记录|飞碟之谜|航拍中国|中国村庄/.test(compact)) return '纪录';
  if (/卫视/.test(compact)) return '卫视';
  if (/^[\u4e00-\u9fa5]{1,8}(?:4k|8k)$/.test(compact.replace(/(?:频道)?超?$/, ''))) return '4K/8K';

  // 地方频道组整体保留，避免把普通地方新闻/综合/生活台拆散。
  const explicitLocalGroup = /地方频道|省频道|市频道|县频道/.test(rawGroupCompact);
  if (explicitLocalGroup) return '地方';
  const fromLocalGroup = group === '地方' || /地方频道|省频道|市频道|县频道|浙江频道|广州电信/.test(rawGroupCompact);
  if (group === '少儿' || group === '体育' || group === '音乐' || group === '电视剧' || group === '春晚') return group;
  if (fromLocalGroup && !/少儿|儿童|卡通|动漫|动画|体育|足球|篮球|网球|赛事|运动|音乐|歌曲|演唱会|港乐|dj|串烧/.test(compact)) return group;

  const explicitProvinceOrCity = /北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|广州|深圳|杭州|南京|苏州|东阳|武汉|成都|西安|哈尔滨|长春|沈阳|济南|郑州|长沙|合肥|福州|南昌|昆明|贵阳|南宁|海口|太原|石家庄|兰州|西宁|银川|乌鲁木齐|拉萨|呼和浩特/.test(compact);

  if (/第一财经|财经|新闻|资讯/.test(compact)) {
    if (group === '地方' && !/第一财经|财经|新闻|资讯/.test(rawGroupCompact)) return group;
    return '新闻财经';
  }
  if (/教育|学习/.test(compact)) return '教育';
  if (/生活|民生|都市/.test(compact)) return '地方';
  if (/体育|足球|篮球|网球|赛事|运动/.test(compact)) return '体育';
  if (/少儿|儿童|卡通|动漫|动画|猫和老鼠|七龙珠|中华小当家/.test(compact)) return '少儿';
  if (/音乐|歌曲|演唱会|港乐|dj|串烧|风云音乐|音乐现场/.test(compact)) return '音乐';
  if (/电视剧|连续剧|剧集|港剧|美剧|韩剧|短剧|经典剧|射雕英雄传|倚天屠龙记|笑傲江湖|寻秦记|创世纪|大时代|楚汉骄雄|大唐双龙传|法政先锋|鉴证实录|妙手仁心|陀枪师姐|洗冤录|刑事侦缉档案|金枝欲孽|活佛济公|西游记|封神榜|倩女幽魂|龙门飞甲|甄嬛传|还珠格格|亮剑|流星花园|大地恩情|凡人修仙|粤经典/.test(compact)) return '电视剧';
  const localComprehensiveChannel = /东丰|敦化一套|桦甸|靖宇|九台|柳河|龙井|磐石|双辽|通化县|汪清|白山公共|舒兰新闻|辉南新闻|珲春新闻/.test(compact);
  if (localComprehensiveChannel) return '地方';
  if (/纪录|纪实|探索|地理|人文|自然|飞碟之谜|航拍中国|中国村庄|之江纪录|cgtn纪录/.test(compact)) return '纪录';
  if (explicitProvinceOrCity && /综合|公共|都市|生活|影视|新闻|经济|科教|文化|导视|频道|电视/.test(compact)) return '地方';
  if (/综合|公共/.test(compact) && /白山|东丰|敦化|桦甸|辉南|珲春|靖宇|九台|柳河|龙井|磐石|舒兰|双辽|通化|汪清|德惠|昌黎|朝天|定襄|汾西|古县|固镇|灌阳|广安|广元|甘南|海宁|邯郸|河源|衡水|衡阳|湖州|怀仁|黄山|嘉兴|嘉峪关|剑阁|津南|晋江|缙云|荆门|井研|靖江|句容|开化|可克达拉|来宾|兰溪|六安|龙泉|龙游/.test(compact)) return '地方';

  return group;
}

/**
 * 聚合直播专用分组归一。上游源各自维护 group 名，常出现“央视/央视频道/
 * 📺央视频道”、地方省台拆成单频道分类、电影和电视剧混在一起等情况。
 * 这里只处理最终聚合输出，不影响 /live/<key> 的单源代理内容。
 *
 * 原则：
 * - 明确且内容量足够大的专题分类保留，避免把几百个频道硬塞进“其他”；
 * - 同义分类合并，极小且无明确归属的分类归入“其他”；
 * - 空分类不输出，频道线路仍按 URL 去重并保留多线路。
 */
function normalizeAggregateGroupName(raw: string): string {
  const label = sanitizeTxtLabel(raw, '其他')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[·•・]/g, '')
    .trim();
  const compact = label.replace(/\s+/g, '').toLowerCase();
  if (!compact) return '其他';

  if (/cctv|央视|中央电视|央卫|咪咕|cg?tn/.test(compact)) {
    if (/cctv第一剧场|cctv怀旧剧场|cctv文化精品|风云剧场|兵器科技|电视指南|发现之旅|老故事/.test(compact)) return '影视';
    return '央视';
  }
  if (/卫视/.test(compact)) return '卫视';
  if (/港澳台|港·澳·台|港台/.test(compact)) return '港澳台';
  const provinceOrCity = /北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|广州|深圳|杭州|南京|苏州|武汉|成都|西安|哈尔滨|长春|沈阳|济南|郑州|长沙|合肥|福州|南昌|昆明|贵阳|南宁|海口|太原|石家庄|兰州|西宁|银川|乌鲁木齐|拉萨|呼和浩特/.test(compact);
  if ((/地方|省频道|市频道|县频道|频道/.test(compact) && provinceOrCity)
    || /广州电信|电信频道/.test(compact)) {
    return '地方';
  }
  if (/少儿|儿童|卡通|动漫|动画/.test(compact)) return '少儿';
  if (/体育|足球|篮球|网球|赛事|运动/.test(compact)) return '体育';
  if (/纪录|纪实|探索|地理|人文/.test(compact)) return '纪录';
  if (/新闻|资讯|财经/.test(compact)) return '新闻财经';
  if (/音乐|歌曲|演唱会|港乐|dj|串烧|欣赏港乐|欣赏音乐/.test(compact)) return '音乐';
  if (/电影|影院|影视|剧场|大片|动作|喜剧|科幻|恐怖|战争|武侠|视觉效果/.test(compact)) return '影视';
  if (/电视剧|连续剧|剧集|港剧|美剧|韩剧|短剧|经典剧|甄嬛传|还珠格格|亮剑|流星花园|大地恩情|大时代|凡人修仙|粤经典/.test(compact)) return '电视剧';
  if (/春晚|春节/.test(compact)) return '春晚';
  if (/直播中国|风景|景区|航拍/.test(compact)) return '风景直播';
  if (/一起看|虎牙|斗鱼|b站|原创|zonghe|综合直播/.test(compact)) return '一起看';
  if (/^(?:4k8k频道|4k频道|8k频道|超高清|高清频道)$/.test(compact)) return '4K/8K';
  if (/教育|学习/.test(compact)) return '教育';
  if (/生活|民生|都市/.test(compact)) return '生活';
  if (/欣赏频道/.test(compact)) return '其他';
  if (/解说|数字|car|测试|备用/.test(compact)) return '其他';

  // 内容明确但名称不规范的专题分类保留原名称，避免破坏有效分类。
  if (compact.length >= 3) return label;
  return '其他';
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
      const targetGroup = normalizeAggregateChannelGroup(group.group || '', channel.name || '');
      const list = byGroup.get(targetGroup) || [];
      list.push(channel);
      byGroup.set(targetGroup, list);
    }
    for (const [targetGroup, channels] of byGroup) {
      normalized.push({ group: targetGroup, channels });
    }
  }
  return formatLiveGroupsAsTxtInternal(normalized, true);
}

/** 自动识别 m3u 还是 txt */
export function parseLiveContent(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  if (content.includes('#EXTM3U') || content.includes('#EXTINF')) {
    return parseM3U(content, source, sourceSpeedMs);
  }
  return parseTxt(content, source, sourceSpeedMs);
}

// ─── 下载 m3u/txt ──────────────────────────────────────

async function readLimitedText(resp: Response, maxBytes = LIVE_SOURCE_MAX_DOWNLOAD_BYTES): Promise<string> {
  const body = resp.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
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
  const now = Date.now();
  const cacheFresh = !!cached && now - cached.cachedAt < LIVE_SOURCE_CACHE_TTL_MS;

  if (cacheFresh && cached) {
    cached.lastAccess = now;
    stats.cacheHits++;
    return { content: cached.content, cacheHit: true, revalidated: false, staleFallback: false };
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
      clearTimeout(timer);

      if (resp.status === 304 && cached) {
        cached.cachedAt = now;
        cached.lastAccess = now;
        stats.cacheHits++;
        stats.revalidated++;
        return { content: cached.content, cacheHit: true, revalidated: true, staleFallback: false };
      }

      if (!resp.ok) {
        // 429/5xx/网络类状态是上游暂时不可用，不能据此永久删除入口。
        lastFailure = failureFromHttpStatus(resp.status);
        lastReason = `HTTP ${resp.status}`;
        continue;
      }

      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      const text = await readLimitedText(resp);
      if (looksLikeLivePayload(text, contentType)) {
        const entry: CachedLiveSource = {
          content: text,
          cachedAt: now,
          lastAccess: now,
          etag: resp.headers.get('etag') || undefined,
          lastModified: resp.headers.get('last-modified') || undefined,
        };
        liveSourceMemoryCache.set(key, entry);
        return { content: text, cacheHit: false, revalidated: false, staleFallback: false };
      }

      // 2xx 但不是直播内容（HTML 错误页、JSON、空响应等）确认无效。
      lastFailure = 'invalid';
      lastReason = text ? 'unexpected content' : 'empty content';
    } catch (error: unknown) {
      clearTimeout(timer);
      // 超时、DNS、连接中断和 Worker fetch 异常都视为暂时失败。
      lastFailure = 'transient';
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (cached) {
    cached.lastAccess = now;
    stats.staleFallbacks++;
    return { content: cached.content, cacheHit: true, revalidated: false, staleFallback: true };
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
  cacheHits: number;
  cacheMisses: number;
  revalidated: number;
  staleFallbacks: number;
  /** 分离模式下按原始源 URL 预构建的过滤后 TXT（仅 CF 使用） */
  sourceTexts?: Record<string, string>;
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
      groups: [],
      totalChannels: 0,
      totalUrls: 0,
      sourcesDownloaded: 0,
      sourcesFailed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      revalidated: 0,
      staleFallbacks: 0,
    };
  }

  console.log(`[live-merger] Downloading ${sources.length} live source files...`);

  // 分批并发下载，限制内存占用（防止免费容器 OOM 崩溃）
  const { results: downloadResults, stats: downloadStats } = await downloadLiveBatched(sources, fetchTimeoutMs, 3, storage);

  let sourcesDownloaded = 0;
  let sourcesFailed = 0;
  const allEntries: ChannelEntry[] = [];

  for (const r of downloadResults) {
    if (r.status === 'fulfilled' && r.value.outcome.content) {
      sourcesDownloaded++;
      try {
        const sourceName = sanitizeTxtLabel(r.value.input.name || 'source', 'source');
        const entries = parseLiveContent(r.value.outcome.content, sourceName, r.value.input.speedMs);
        const prepared = prepareSourceChannels(entries, channelSpeedMap, {
          maxUrlsPerChannel: options.preserveAllUrls ? Math.max(1, options.candidatePoolMaxUrlsPerChannel ?? 64) : SEPARATED_MAX_URLS_PER_CHANNEL,
          maxSpeedMs: options.preserveAllUrls ? 0 : LIVE_KNOWN_MAX_SPEED_MS,
        });
        const quality = evaluateSourceQuality(prepared, {
          minChannelsPerSource: SEPARATED_MIN_CHANNELS_PER_SOURCE,
          maxAdRatio: SEPARATED_MAX_AD_RATIO,
          minPlayableRatio: SEPARATED_MIN_PLAYABLE_RATIO,
        });
        if (quality.discard) {
          console.log(`[live-merger] Discarded live source ${sourceName}: ${quality.reason}`);
          continue;
        }

        // 复用已验证的频道条目，避免同一源在合并阶段再次解析。
        for (const { group, channel } of prepared.channels) {
          for (const url of channel.urls) {
            allEntries.push({
              group,
              name: channel.name,
              url,
              source: sourceName,
              sourceSpeedMs: r.value.input.speedMs,
            });
          }
        }
      } catch (err) {
        console.warn(`[live-merger] Parse failed for ${r.value.input.name}: ${err}`);
      }
    } else {
      sourcesFailed++;
    }
  }

  console.log(
    `[live-merger] Downloaded ${sourcesDownloaded}/${sources.length} sources, ` +
    `parsed ${allEntries.length} channel entries`,
  );

  // 按频道名（规范化）+ group 合并 urls
  // key: normalizedName → { group, rawName, logo, urls: Map<url, ChannelEntry> }
  interface AggChannel {
    group: string;        // 使用第一次出现的 group 名
    rawName: string;      // 使用第一次出现的 raw name（最常用的）
    logo?: string;
    urls: Map<string, ChannelEntry>; // url → entry（含源名、速度）
  }
  const channelMap = new Map<string, AggChannel>();

  for (const e of allEntries) {
    const normName = normalizeChannelName(e.name);
    if (!normName) continue;

    let agg = channelMap.get(normName);
    if (!agg) {
      agg = {
        group: e.group || '其他',
        rawName: e.name,
        logo: e.logo,
        urls: new Map(),
      };
      channelMap.set(normName, agg);
    }
    if (!agg.urls.has(e.url)) {
      agg.urls.set(e.url, e);
    }
    if (!agg.logo && e.logo) agg.logo = e.logo;
  }

  // 按 group 组织
  const groupMap = new Map<string, TVBoxLiveChannel[]>();
  let totalUrls = 0;

  for (const [, agg] of channelMap) {
    // 对 urls 排序且过滤失效链接
    const urlList = Array.from(agg.urls.values()).filter((e) => {
      if (options.preserveAllUrls) return true;
      const s = channelSpeedMap?.[e.url];
      return s?.kind !== 'fail';
    });
    if (urlList.length === 0) continue;

    urlList.sort((a, b) => {
      // 优先用 URL 级测速缓存
      const sa = channelSpeedMap?.[a.url];
      const sb = channelSpeedMap?.[b.url];
      const fa = sa && sa.kind !== 'fail' ? sa.speedMs : undefined;
      const fb = sb && sb.kind !== 'fail' ? sb.speedMs : undefined;

      if (fa != null && fb != null) return fa - fb;
      if (fa != null) return -1;
      if (fb != null) return 1;

      // 失败的 URL 排到末尾
      const failA = sa?.kind === 'fail';
      const failB = sb?.kind === 'fail';
      if (failA && !failB) return 1;
      if (!failA && failB) return -1;

      // 降级：源级 speedMs
      const ssA = a.sourceSpeedMs ?? Infinity;
      const ssB = b.sourceSpeedMs ?? Infinity;
      return ssA - ssB;
    });

    // Render 聚合模式每个频道最多保留 9 条线路，避免客户端加载过慢。
    const limitedUrlList = options.preserveAllUrls
      ? urlList.slice(0, Math.max(1, options.candidatePoolMaxUrlsPerChannel ?? 64))
      : urlList.slice(0, AGGREGATED_MAX_URLS_PER_CHANNEL);

    // 拼 $ 源名（URL 预防性 encode 避免 type 泄漏）
    const urlStrs = limitedUrlList.map((e) => `${scrubUrlType(e.url)}$${scrubTypeLiteral(e.source)}`);
    totalUrls += urlStrs.length;

    const channel: TVBoxLiveChannel = {
      name: scrubTypeLiteral(agg.rawName),
      urls: urlStrs,
    };
    // TVBoxLiveChannel 定义只有 name/urls，logo 不加（避免意外引入 type 风险字段）

    const groupKey = scrubTypeLiteral(agg.group || '其他');
    let list = groupMap.get(groupKey);
    if (!list) {
      list = [];
      groupMap.set(groupKey, list);
    }
    list.push(channel);
  }

  // 组装 groups
  const groups: TVBoxLiveGroup[] = [];
  for (const [group, channels] of groupMap) {
    groups.push({ group, channels: [...channels].sort((a, b) => compareLiveChannelNames(a.name, b.name)) });
  }

  // 最终安全校验（双保险第二道）：
  //   1) 先移除 "type" 字段名（若意外进入）
  //   2) 再扫描 value 内 type 子串，统一 URL-encode 替换为 %74ype
  let finalJson = JSON.stringify(groups);
  let cleanedGroups: TVBoxLiveGroup[] = groups;

  if (/"type"\s*:/i.test(finalJson)) {
    console.warn('[live-merger] WARNING: "type" field leaked into output, stripping...');
    finalJson = finalJson
      .replace(/,\s*"type"\s*:\s*("[^"]*"|[\d.]+|null|true|false)/gi, '')
      .replace(/"type"\s*:\s*("[^"]*"|[\d.]+|null|true|false)\s*,?/gi, '');
    cleanedGroups = JSON.parse(finalJson);
  }

  // value 内 type 子串兜底：排除字段名（"xxx":）位置，其他全部 encode
  if (/type/i.test(finalJson)) {
    console.warn('[live-merger] WARNING: "type" substring in value, encoding to %74ype...');
    finalJson = finalJson.replace(/type/gi, (m) => {
      const hex = m.charCodeAt(0).toString(16).toUpperCase();
      return '%' + hex + m.slice(1);
    });
    cleanedGroups = JSON.parse(finalJson);
    return {
      groups: cleanedGroups,
      totalChannels: channelMap.size,
      totalUrls,
      sourcesDownloaded,
      sourcesFailed,
      cacheHits: downloadStats.cacheHits,
      cacheMisses: downloadStats.cacheMisses,
      revalidated: downloadStats.revalidated,
      staleFallbacks: downloadStats.staleFallbacks,
    };
  }

  if (cleanedGroups !== groups) {
    return {
      groups: cleanedGroups,
      totalChannels: channelMap.size,
      totalUrls,
      sourcesDownloaded,
      sourcesFailed,
      cacheHits: downloadStats.cacheHits,
      cacheMisses: downloadStats.cacheMisses,
      revalidated: downloadStats.revalidated,
      staleFallbacks: downloadStats.staleFallbacks,
    };
  }

  console.log(
    `[live-merger] Merged ${channelMap.size} channels / ${totalUrls} URLs across ${groups.length} groups`,
  );

  return {
    groups,
    totalChannels: channelMap.size,
    totalUrls,
    sourcesDownloaded,
    sourcesFailed,
    cacheHits: downloadStats.cacheHits,
    cacheMisses: downloadStats.cacheMisses,
    revalidated: downloadStats.revalidated,
    staleFallbacks: downloadStats.staleFallbacks,
  };
}

/**
 * 按源分类模式：每个源独立解析，保留上游 group 名，不做跨源去重
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
      groups: [],
      totalChannels: 0,
      totalUrls: 0,
      sourcesDownloaded: 0,
      sourcesFailed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      revalidated: 0,
      staleFallbacks: 0,
    };
  }

  console.log(`[live-merger] Separated mode: downloading ${sources.length} live source files...`);

  // 分批并发下载，限制内存占用（防止免费容器 OOM 崩溃）
  const { results: downloadResults, stats: downloadStats } = await downloadLiveBatched(sources, fetchTimeoutMs, 3, storage);

  let sourcesDownloaded = 0;
  let sourcesFailed = 0;
  const allGroups: TVBoxLiveGroup[] = [];
  let totalChannels = 0;
  let totalUrls = 0;
  const sourceTexts: Record<string, string> = {};

  for (const r of downloadResults) {
    if (r.status !== 'fulfilled' || !r.value.outcome.content) {
      sourcesFailed++;
      continue;
    }
    sourcesDownloaded++;
    const { input } = r.value;
    const content = r.value.outcome.content;
    const sourceName = sanitizeTxtLabel(input.name || 'source', 'source');

    try {
      const entries = parseLiveContent(content, sourceName, input.speedMs);

      // 若为聚合而来的源，频道数量极少（少于 5 个）则直接丢弃该源
      if (input.isAggregated && entries.length < 5) {
        console.log(`[live-merger] Discarded aggregated live source ${sourceName} due to too few channels: ${entries.length}`);
        continue;
      }

      const prepared = prepareSourceChannels(entries, channelSpeedMap, {
        maxUrlsPerChannel: options.preserveAllUrls ? Math.max(1, options.candidatePoolMaxUrlsPerChannel ?? 64) : SEPARATED_MAX_URLS_PER_CHANNEL,
        maxSpeedMs: options.preserveAllUrls ? 0 : LIVE_KNOWN_MAX_SPEED_MS,
      });
      const quality = evaluateSourceQuality(prepared, {});
      if (quality.discard) {
        console.log('[live-merger] Discarded live source ' + sourceName + ': ' + quality.reason);
        continue;
      }

      const byGroup = new Map<string, TVBoxLiveChannel[]>();
      for (const { group, channel } of prepared.channels) {
        if (!byGroup.has(group)) byGroup.set(group, []);
        byGroup.get(group)!.push(channel);
      }

      // 保留上游 group 名，频道线路仍带 $源名 后缀。
      // 同时为 CF 分离模式预生成该源的过滤后 TXT，/live/<key> 首次请求直接命中。
      const sourceGroups: TVBoxLiveGroup[] = [];
      for (const [group, channels] of byGroup) {
        if (totalChannels >= SEPARATED_MAX_CHANNELS) break;
        const remaining = SEPARATED_MAX_CHANNELS - totalChannels;
        const limited = channels.slice(0, remaining);
        if (limited.length === 0) continue;

        const groupValue = { group: scrubTypeLiteral(group), channels: limited };
        allGroups.push(groupValue);
        sourceGroups.push(groupValue);
        totalChannels += limited.length;
        for (const channel of limited) totalUrls += channel.urls.length;
      }
      const sourceText = formatLiveGroupsAsTxt(sourceGroups);
      if (sourceText.trim() && sourceText.includes('#genre#')) {
        sourceTexts[input.url] = sourceText;
      }
    } catch (err) {
      console.warn(`[live-merger] Separated parse failed for ${sourceName}: ${err}`);
    }
  }

  console.log(`[live-merger] Separated done: ${sourcesDownloaded}/${sources.length} sources, ${allGroups.length} groups, ${totalChannels} channels`);

  return {
    groups: allGroups,
    totalChannels,
    totalUrls,
    sourcesDownloaded,
    sourcesFailed,
    cacheHits: downloadStats.cacheHits,
    cacheMisses: downloadStats.cacheMisses,
    revalidated: downloadStats.revalidated,
    staleFallbacks: downloadStats.staleFallbacks,
    sourceTexts,
  };
}

/**
 * 从合并后的 groups 提取所有 (url, sourceSpeedMs) 对供 channel-probe 测速
 * URL 是 `$源名` 剥离后的裸 URL
 */
function bareLiveUrl(url: string): string {
  const trimmed = url.trim();
  const idx = trimmed.lastIndexOf('$');
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
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
 * 将频道级测速结果应用到已合并的频道树。
 * 已知失败或超过延迟上限的线路会移除；未知线路保留，已知线路按速度排序。
 */
export function applyChannelSpeedToGroups(
  groups: TVBoxLiveGroup[],
  speedMap: ChannelSpeedMap,
  maxSpeedMs = LIVE_KNOWN_MAX_SPEED_MS,
  maxUrlsPerChannel = SEPARATED_MAX_URLS_PER_CHANNEL,
): TVBoxLiveGroup[] {
  const speedLimit = Math.max(0, maxSpeedMs);
  const output: TVBoxLiveGroup[] = [];

  for (const group of groups) {
    const channels: TVBoxLiveChannel[] = [];
    for (const channel of group.channels || []) {
      const seen = new Set<string>();
      const ranked: Array<{ url: string; speed?: number; index: number }> = [];

      for (const [index, rawUrl] of (channel.urls || []).entries()) {
        const url = rawUrl.trim();
        if (!url) continue;
        const bare = bareLiveUrl(url);
        if (!bare || seen.has(bare)) continue;
        seen.add(bare);

        const speed = speedMap[url] ?? speedMap[bare];
        if (speed?.kind === 'fail') continue;
        const knownSpeed = speed && Number.isFinite(speed.speedMs) ? speed.speedMs : undefined;
        if (speedLimit > 0 && knownSpeed != null && knownSpeed > speedLimit) continue;
        ranked.push({ url, speed: knownSpeed, index });
      }

      ranked.sort((a, b) => {
        if (a.speed != null && b.speed != null && a.speed !== b.speed) return a.speed - b.speed;
        if (a.speed != null && b.speed == null) return -1;
        if (a.speed == null && b.speed != null) return 1;
        return a.index - b.index;
      });

      const urls = ranked.slice(0, Math.max(1, maxUrlsPerChannel)).map((item) => item.url);
      if (urls.length > 0) channels.push({ ...channel, urls });
    }
    if (channels.length > 0) output.push({ ...group, channels });
  }

  return output;
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
        const text = await readLimitedText(resp);
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
  const sa = knownLiveSpeed(a, channelSpeedMap);
  const sb = knownLiveSpeed(b, channelSpeedMap);
  if (sa != null && sb != null && sa !== sb) return sa - sb;
  if (sa != null && sb == null) return -1;
  if (sa == null && sb != null) return 1;

  const sourceA = a.sourceSpeedMs ?? Number.POSITIVE_INFINITY;
  const sourceB = b.sourceSpeedMs ?? Number.POSITIVE_INFINITY;
  return sourceA - sourceB;
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
  if (sources.length === 0) return { valid: [], invalid: [], transient: [], texts: {} };

  const blocked = sources.filter(isBlockedLiveSource);
  const candidates = blocked.length > 0 ? sources.filter((source) => !isBlockedLiveSource(source)) : sources;
  if (blocked.length > 0) {
    console.log('[live-merger] Blocked live sources: ' + blocked.map((source) => sanitizeTxtLabel(source.name || 'source', 'source')).join(', '));
  }
  if (candidates.length === 0) return { valid: [], invalid: blocked, transient: [], texts: {} };

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

  for (let i = 0; i < batched.results.length; i++) {
    const result = batched.results[i];
    if (result.status !== 'fulfilled') {
      transient.push(candidates[i]);
      continue;
    }
    const { input, outcome } = result.value;
    const content = outcome.content;
    if (!content) {
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
    if (quality.discard) {
      invalid.push(input);
      console.log('[live-merger] Discarded live source ' + sourceName + ': ' + quality.reason);
      continue;
    }
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
    }
    valid.push(input);
  }

  console.log(`[live-merger] Validated ${valid.length}/${sources.length} live sources (invalid=${invalid.length + blocked.length}, transient=${transient.length})`);
  return { valid, invalid: [...invalid, ...blocked], transient, texts };
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
          const text = await readLimitedText(resp);
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
