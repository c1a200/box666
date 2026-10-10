// TVBox JSON 配置完整类型定义

export interface TVBoxSite {
  key: string;
  name?: string;
  __upstreamNames?: string[]; // 聚合内部来源标记；写 KV 前移除
  type: number; // 0=XML, 1=JSON, 3=JAR, 4=Remote
  api: string;
  searchable?: number; // 0|1
  quickSearch?: number; // 0|1
  filterable?: number; // 0|1
  playUrl?: string;
  playerType?: number; // -1|0|1|2|10
  jar?: string; // per-site JAR override
  pan?: string; // 部分网盘聚合源的平台标识
  ext?: string | Record<string, unknown>;
  categories?: string[];
  click?: string;
  style?: string;
  changeable?: number; // 0|1
}

// 直播源文件缓存条目（按源 URL 保存最近一次成功下载内容）
export interface LiveSourceCacheEntry {
  content: string;
  cachedAt: string;
  etag?: string;
  lastModified?: string;
}

export type LiveSourceCache = Record<string, LiveSourceCacheEntry>;

// 单次直播聚合统计报告
export interface LiveMergeReport {
  updatedAt: string;
  mode: 'separated' | 'merged';
  sources: number;
  sourcesDownloaded: number;
  sourcesFailed: number;
  cacheHits: number;
  cacheMisses: number;
  revalidated: number;
  staleFallbacks: number;
  groups: number;
  channels: number;
  urls: number;
}

export interface TVBoxParse {
  name: string;
  url: string;
  type?: number; // 0=sniffer, 1=JSON, 2=JSON extended, 3=aggregated, 4=super
  ext?: string | Record<string, unknown>;
}

export interface TVBoxLiveChannel {
  name: string;
  urls: string[];
}

export interface TVBoxLiveGroup {
  group: string;
  channels: TVBoxLiveChannel[];
}

export interface TVBoxLive {
  name?: string;
  type?: number; // 0=M3U/TXT, 3=JAR/Python
  url?: string;
  api?: string;
  jar?: string;
  epg?: string;
  ua?: string;
  header?: Record<string, string>;
  playerType?: number;
  ext?: string | Record<string, unknown>;
  // Native 格式（live-merger 产物）— 与 FongMi 共用同一数组元素类型
  group?: string;
  channels?: TVBoxLiveChannel[];
}

export interface TVBoxRule {
  host?: string;
  hosts?: string[];
  rule?: string[];
  filter?: string[];
  regex?: string[];
  script?: string[];
}

export interface TVBoxDoh {
  name: string;
  url: string;
}

export interface TVBoxConfig {
  spider?: string;
  jarCache?: boolean | string;
  wallpaper?: string;
  pic?: string; // 图片代理前缀，TVBox 客户端加载图片时自动拼接
  sites?: TVBoxSite[];
  parses?: TVBoxParse[];
  // lives 兼容两种 TVBox 格式（同一数组类型，字段可选）：
  //   FongMi 格式（含 type/url）— 来自各源 config 的原始 lives
  //   Native 格式（含 group/channels）— live-merger 合并后产物
  lives?: TVBoxLive[];
  hosts?: string[];
  rules?: TVBoxRule[];
  doh?: TVBoxDoh[];
  ads?: string[];
  flags?: string[];
  token?: string; // 上游全局接口/token 字段
}

// MacCMS 源条目
export interface MacCMSSourceEntry {
  key: string;    // TVBox site key，如 "hongniuzy"
  name: string;   // 显示名，如 "红牛资源站"
  api: string;    // 原始 API，如 "https://www.hongniuzy2.com/api.php/provide/vod/from/hnm3u8/at/json/"
  disabled?: boolean;
}

// 直播源条目
export interface LiveSourceEntry {
  name: string;
  url: string;
  disabled?: boolean;
  ua?: string;
  header?: Record<string, string>;
}

// 源条目
export interface SourceEntry {
  name: string;
  url: string;
  configKey?: string; // AES ECB 解密密钥（来自 URL 的 ;pk; 后缀）
  disabled?: boolean;
  upstreamNames?: string[]; // 内部多仓展开用：保留顶层总源身份
}

// 内部处理用：带来源标记的配置
export interface SourcedConfig {
  sourceUrl: string;
  sourceName: string;
  config: TVBoxConfig;
  speedMs?: number; // 配置 URL 响应时间
  /**
   * 顶层总源名称。多仓展开后仍保留最初配置的启用总源，
   * 保留总源边界信息，供运行时分发与追踪来源使用。
   */
  upstreamNames?: string[];
}

// 名称定制配置
export interface NameTransformConfig {
  prefix?: string;
  suffix?: string;
  promoReplacement?: string;
  extraCleanPatterns?: string[];
}

// JSON 导入结果
export interface ImportResult {
  type: 'multi' | 'single';
  added: number;
  duplicates: number;
  sources: string[];
}

// 单次 fetch 结果（内部传递，不持久化）
export type SourceFetchStatus = 'ok' | 'http_error' | 'decode_error' | 'parse_error' | 'timeout' | 'network_error';

export interface SourceFetchResult {
  url: string;
  name: string;
  status: SourceFetchStatus;
  errorMessage?: string;
  speedMs?: number;
}

// 持久化的源健康记录
export interface SourceHealthRecord {
  url: string;
  name: string;
  latestStatus: SourceFetchStatus;
  consecutiveFailures: number;
  lastSuccessTime?: string;
  lastFailTime?: string;
  lastFailReason?: string;
  lastSpeedMs?: number;
}

// 平台无关的应用配置
export interface AppConfig {
  adminToken?: string;
  refreshToken?: string;
  speedTimeoutMs: number;
  siteTimeoutMs: number;
  fetchTimeoutMs: number;
  speedTestConcurrency?: number;
  speedTestBudgetMs?: number;
  cronSchedule?: string;
  qualityTimezone?: string; // 质量分级调度时区（IANA 名称，默认 Asia/Shanghai）
  workerBaseUrl?: string;  // CF 版设置，如 "https://tvbox.example.com"；本地不设置
  localBaseUrl?: string;   // Node.js 版设置，如 "http://192.168.1.100:5678"；用于 JAR 代理
  dockerMissingBaseUrl?: boolean;  // Docker 环境未配置 BASE_URL 时为 true
  // 自动抓取配置（环境变量驱动，未配置则不启用）
  scrapeSourceUrl?: string;
  scrapeSourceReferer?: string;
  maccmsApiUrl?: string;
  maccmsAesKey?: string;
  maccmsAesIv?: string;
}

// 边缘函数代理配置
export interface EdgeProxyConfig {
  cf?: string;      // CF Worker URL，如 "https://tvbox.rio.edu.kg"
  vercel?: string;  // Vercel 代理 URL，如 "https://fetch.riowang.win"
}

// 源分发策略：all=全部候选源，search=仅可搜索源，selected=仅质量池精选源，custom=自定义筛选
export type SourceDistributionMode = 'all' | 'search' | 'selected' | 'custom';

// 源类型只描述接口机制，与 excellent/good/usable/untestable 质量等级无关。
export type SourceCategory = 'xml' | 'json' | 'jar' | 'js' | 'remote' | 'other';

export const SOURCE_CATEGORIES: readonly SourceCategory[] = [
  'xml',
  'json',
  'jar',
  'js',
  'remote',
  'other',
];

// 源分发分桶上限。
// 未配置=不额外限制；0=该分类一个都不下发；-1=该分类全部下发；正数=按最终顺序保留前 N 个。
export interface SiteBucketLimits {
  quality?: Partial<Record<'excellent' | 'good' | 'usable' | 'untestable', number>>;
  type?: Partial<Record<SourceCategory, number>>;
}

// 单个客户端鉴权码（不同码可下发不同的源种类和数量）
export interface ClientAuthCode {
  id: string;
  label: string;
  code: string;
  enabled: boolean;
  sourceMode: SourceDistributionMode;
  maxSites: number;
  maxSearchable: number;
  bucketLimits?: SiteBucketLimits;
  includeGrades: SiteQualityGrade[];
  // 新配置使用 xml/json/jar/js/remote/other；旧数字类型仍会在读取时迁移。
  siteTypes: SourceCategory[];
  selectedKeys: string[];
  pinnedKeys: string[];
  createdAt: string;
  updatedAt: string;
}

// 客户端源分发与鉴权配置
export interface ClientDistributionConfig {
  requireAuth: boolean;
  authCodes: ClientAuthCode[];
}

// 搜索配额配置（持久化到 KV）
export interface SearchQuotaConfig {
  maxSearchable: number;        // 可搜索源上限，0 = 不限制
  maxQuickSearch?: number;      // 快速搜索源上限，0 = 不限制
  maxStartupQuickSearch?: number; // 根配置启动阶段快速搜索源上限，0 = 不额外裁剪
  startupSiteLimit?: number;      // 根配置启动源数量；0 = 使用启动快速源上限
  autoLimit?: boolean;          // 是否使用按部署形态自动选择的默认上限
  pinnedKeys: string[];         // 置顶源 key 列表（排到 sites 最前面）
  sortBySpeed: boolean;         // 是否复用站点测速结果，将较快的可搜索源排在前面
  leanStartup?: boolean;        // 轻量启动：剔除不参与搜索的远程 JAR/扩展站点
  startupMode?: 'lean' | 'full';// 客户端根配置模式：lean=快速启动，full=完整功能
  pruneDeadParses?: boolean;    // 聚合时探测并剔除确认失效的解析器
  maxParses?: number;           // 健康解析器上限，0 = 不限制
  bucketLimits?: SiteBucketLimits; // 根链接按质量等级/站点类型的数量上限
  blockedKeys?: string[];            // 显式屏蔽的源 key：优先于置顶/质量分级，仍保留在后台列表中以便恢复
  quotaSchemaVersion?: number;  // 自动配额迁移版本
}
// 搜索配额报告
export interface SearchQuotaReport {
  totalSites: number;           // 站点总数
  jsExcluded: number;           // JS 源排除数
  searchable: number;           // 最终可搜索数
  quickSearchable: number;      // 最终快速搜索数
  maxSearchable: number;        // 当前配置的搜索源上限，0 = 不限制
  maxQuickSearch: number;       // 当前配置的快速搜索源上限，0 = 不限制
  autoLimit: boolean;           // 是否使用自动安全上限
  pinnedCount: number;          // 置顶源命中数
  blockedCount?: number;        // 显式屏蔽源数量
  truncated: number;            // 被截断数（maxSearchable > 0 时）
  quickTruncated: number;       // 快速搜索被截断数
  speedSorted: boolean;         // 是否实际按测速结果排序
  leanRemoved: number;          // 轻量启动剔除的远程扩展站点数
  qualityGrades?: SiteQualityGrades; // 未截断候选池的质量分级统计
  parseProbed?: number;         // 解析器探测数
  parseRemoved?: number;        // 解析器剔除数
  parseTimeouts?: number;       // 解析器超时数
  parseHttpErrors?: number;     // 解析器 HTTP 错误数
  parseNetworkErrors?: number;  // 解析器网络错误数
  parseLimit?: number;          // 当前解析器上限，0 = 不限制
  parseTruncated?: number;      // 因解析器上限被截断数
  parseKept?: number;           // 最终保留的解析器数
  parseProbeFailed?: boolean;   // 探测整体失败，已降级为保守保留
}

// 站点质量分级（基于聚合阶段已有验活/测速结果，不额外发起请求）
// 候选池下发 excellent / good / usable / untestable；timeout 与 unusable 永不进入客户端搜索源。
export type SiteQualityGrade = 'excellent' | 'good' | 'usable' | 'untestable' | 'timeout' | 'unusable';

export interface SiteQualityGradeBucket {
  count: number;
  cumulative: number;
}

export interface SiteQualityGrades {
  excellent: SiteQualityGradeBucket; // 优：<=1000ms
  good: SiteQualityGradeBucket;      // 良：1001-3000ms
  usable: SiteQualityGradeBucket;    // 可用：3001-6000ms
  untestable: SiteQualityGradeBucket; // 无法由服务端直接探测（如客户端 JAR/网盘登录源）
  timeout: SiteQualityGradeBucket;   // 超时：>6000ms、无结果或未完成探测
  unusable: SiteQualityGradeBucket;  // 不可用：连续失败/明确错误
  poolTotal: number;                 // 可下发候选池总数（优/良/可用/不可测试）
}
// 搜索源质量分级快照
export interface SearchQualityEntry {
  key: string;
  name: string;
  grade: SiteQualityGrade;
  speedMs: number | null;
  result: 'ok' | 'empty' | 'error' | 'timeout' | 'not_probed';
  probedAt?: string;
  consecutiveFailures: number;
  // JAR/远程扩展的服务端元数据预检。失败是软降级，不等于客户端执行失败。
  jarProbeResult?: 'ok' | 'error' | 'timeout' | 'not_probed';
  jarSpeedMs?: number | null;
  jarHttpStatus?: number;
  jarBytes?: number;
  jarMd5Verified?: boolean;
  jarZipValid?: boolean;
  jarCached?: boolean;
}

export interface SearchQualityThresholds {
  excellentMaxMs: number;
  goodMaxMs: number;
  usableMaxMs: number;
}

export interface SearchQualityCoverage {
  testable: number;      // 具备 HTTP 探测条件的源
  probed: number;        // 已有有效探测结果的源（成功或失败）
  notProbed: number;     // 具备条件但尚未探测/预算耗尽
  untestable: number;    // 服务端无法直接探测、需由客户端登录/JAR 执行的源
}

export interface SearchQualitySnapshot {
  updatedAt: string;
  total: number;
  graded: number;
  coverage: SearchQualityCoverage;
  entries: SearchQualityEntry[];
  grades: SiteQualityGrades;
  recommendedMaxSearchable: number;
  recommendedMaxParses: number;
  thresholds: SearchQualityThresholds;
}

export type SearchQualityRunMode = 'candidate' | 'full';

export interface SearchQualitySchedule {
  enabled: boolean;
  times: string[];
  repeatDays: number;
  fullRepeatDays: number;       // 每隔多少天做一次全量分级，默认 7 天
  timezone: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastFullRunAt?: string;
  nextFullRunAt?: string;
}

export interface SearchQualityStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  mode?: SearchQualityRunMode;
  startedAt?: string;
  finishedAt?: string;
  processed?: number;
  total?: number;
  cursor?: number;
  batchSize?: number;
  error?: string;
}
// ═══ 聚合日志 ══════════════════════════════════════════

export interface AggLogFailedSource {
  url: string;
  name: string;
  status: SourceFetchStatus;
  errorMessage?: string;
}

export interface AggLogSiteChange {
  key: string;
  name?: string;
}

export interface AggregationLog {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  totalSources: number;
  okSources: number;
  failedSources: AggLogFailedSource[];
  addedSites: AggLogSiteChange[];
  removedSites: AggLogSiteChange[];
  finalSiteCount: number;
  finalParseCount: number;
  finalLiveCount: number;
  blacklistRemovedSites: number;
  blacklistRemovedParses: number;
  blacklistRemovedLives: number;
}

// ═══ 直播频道级测速（方案 D+）══════════════════════════

// URL → 延迟 ms 的映射（持久化到 KV_CHANNEL_SPEED_MAP）
export interface ChannelSpeedEntry {
  speedMs: number;          // TTFB 或连通耗时
  probedAt: string;         // ISO 时间
  kind: 'm3u8' | 'ts' | 'tcp' | 'fail';
}
export type ChannelSpeedMap = Record<string, ChannelSpeedEntry>;

// 站点验活健康记录
export interface SiteHealthRecord {
  key: string;
  consecutiveFailures: number;
  lastProbeTime: string;
  lastProbeResult: 'ok' | 'empty' | 'error' | 'timeout' | 'not_probed';
  lastSuccessTime?: string;
}
export type SiteHealthMap = Record<string, SiteHealthRecord>;

// 正则黑名单规则
export interface RegexRule {
  id: string;
  pattern: string;
  field: 'name' | 'api' | 'key';
  enabled: boolean;
  createdAt: string;
}

// 频道测速任务状态
export type ChannelProbeState = 'idle' | 'running' | 'done' | 'error';

export interface ChannelProbeStatus {
  state: ChannelProbeState;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  totalUrls: number;
  probed: number;            // 当前已测完数
  success: number;           // 成功
  failed: number;            // 超时/失败
  totalChannels: number;     // 合并后频道数
  coverage: number;          // 覆盖率（success/totalUrls，百分比）
  error?: string;
}
