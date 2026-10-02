// 配置常量

// 默认阈值
export const DEFAULT_SPEED_TIMEOUT_MS = 5000; // 配置 URL 超时（fetch 耗时筛选）
export const DEFAULT_SITE_TIMEOUT_MS = 3000;  // 站点 API 超时
export const DEFAULT_FETCH_TIMEOUT_MS = 5000; // fetch 配置 JSON 超时

// 站点测速批处理调优（可通过环境变量覆盖）
export const DEFAULT_SPEED_TEST_CONCURRENCY = 18;   // 同时探测的站点数
export const DEFAULT_SPEED_TEST_BUDGET_MS = 140000; // 单批测速总预算（约 2.3 分钟）

// 质量分级探测调优：Node/Render 默认更保守，避免长任务影响客户端请求。
export const DEFAULT_QUALITY_PROBE_CONCURRENCY = 6;
export const DEFAULT_QUALITY_PROBE_TIMEOUT_MS = 3000;
export const DEFAULT_QUALITY_PROBE_CHUNK_SIZE = 40;
export const DEFAULT_QUALITY_PROBE_YIELD_MS = 25;

// KV keys
export const KV_MERGED_CONFIG = 'merged_config';
export const KV_MERGED_CONFIG_FULL = 'merged_config_full'; // 黑名单过滤前的完整配置（供配置编辑器使用）
export const KV_STARTUP_SITE_POOL = 'startup_site_pool'; // 根配置动态裁剪用的完整候选池（已按测速排序，不受 maxSearchable 截断）
export const KV_SOURCE_URLS = 'source_urls';
export const KV_LAST_UPDATE = 'last_update';
export const KV_LAST_UPDATE_ERROR = 'last_update_error';
export const KV_AGGREGATION_STATUS = 'aggregation_status'; // 后台聚合状态检查点（running/completed/failed）
export const KV_MANUAL_SOURCES = 'manual_sources';
export const KV_MACCMS_SOURCES = 'maccms_sources';
export const KV_LIVE_SOURCES = 'live_sources';
export const KV_LIVE_SCRAPED = 'live_scraped';
export const KV_LIVE_MERGED_DATA = 'live_merged_data'; // 最终聚合且经过过滤的直播源数据（供 /live.json 使用）
export const KV_LIVE_MERGED_TXT = 'live_merged_txt';  // 预生成的 TVBox 直播 txt（供 /live 直接返回）
export const KV_LIVE_MERGED_TXT_FALLBACK = '__LIVE_TXT_FALLBACK__'; // 标记该部署需要请求时实时解析（CF 非聚合模式）
export const KV_LIVE_RUNTIME_TXT = 'live_runtime_txt'; // CF 非聚合模式实时解析成功后的缓存 txt
export const KV_LIVE_RUNTIME_EMPTY_AT = 'live_runtime_empty_at'; // CF 非聚合模式解析为空后的负缓存时间戳（毫秒）

// 直播源代理缓存 TTL（秒）
export const LIVE_PROXY_TTL = 7200; // 2 小时

// 图片代理缓存 TTL（秒）
export const IMG_PROXY_TTL = 604800; // 7 天

// 黑名单
export const KV_BLACKLIST = 'blacklist';

// JSON 导入：内联配置前缀
export const KV_INLINE_PREFIX = 'inline_config_';

// 名称定制配置
export const KV_NAME_TRANSFORM = 'name_transform';

// 源健康状态
export const KV_SOURCE_HEALTH = 'source_health';
export const KV_SOURCE_URL_BLACKLIST = 'source_url_blacklist';

// 站点测速开关（默认启用）
export const KV_SPEED_TEST_ENABLED = 'speed_test_enabled';

// TVBox 客户端 UA（源服务器按此 UA 返回 JSON 而非 HTML）
export const TVBOX_UA = 'okhttp/3.12.0';
// 浏览器 UA 回退（部分源只接受浏览器 UA）
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.54 Safari/537.36';

// 定时任务间隔（分钟）
export const KV_CRON_INTERVAL = 'cron_interval';
export const DEFAULT_CRON_INTERVAL = 1440; // 默认每天一次

// 边缘函数代理
export const KV_EDGE_PROXIES = 'edge_proxies';

// 网盘凭证
export const KV_CLOUD_CREDENTIALS = 'cloud_credentials';
export const KV_CREDENTIAL_POLICY = 'credential_policy';
export const KV_CREDENTIAL_ENCRYPTION_KEY = 'credential_encryption_key';
export const KV_CREDENTIAL_DISTRIBUTION = 'credential_distribution'; // 凭证分发模式与鉴权码配置
export const KV_CREDENTIAL_DISTRIBUTION_ENABLED = 'credential_distribution_enabled'; // 是否向前端下发已保存的网盘凭证（默认开启）

// 搜索配额
export const KV_SEARCH_QUOTA = 'search_quota';
export const KV_SEARCH_QUALITY_POOL = 'search_quality_pool'; // 全量搜索源质量排序池（根配置动态取前 N）
export const KV_SEARCH_QUALITY_CANDIDATES = 'search_quality_candidates'; // 质量分级候选站点快照（含完整站点对象，供定时重测）
export const KV_SEARCH_QUALITY_SNAPSHOT = 'search_quality_snapshot'; // 最近一次质量分级快照
export const KV_SEARCH_QUALITY_SCHEDULE = 'search_quality_schedule'; // 全量质量分级计划
export const KV_SEARCH_QUALITY_STATUS = 'search_quality_status'; // 质量分级任务状态
export const KV_SEARCH_QUOTA_REPORT = 'search_quota_report';
export const KV_PARSE_HEALTH_REPORT = 'parse_health_report';

// ═══ 直播频道级测速（方案 D+）══════════════════════════
export const KV_CHANNEL_SPEED_MAP = 'channel_speed_map';
export const KV_CHANNEL_PROBE_ENABLED = 'channel_probe_enabled';
export const KV_CHANNEL_PROBE_STATUS = 'channel_probe_status';
export const KV_CHANNEL_MERGED_TREE = 'channel_merged_tree'; // 主聚合产出的完整候选池（probe 只能读，不能被过滤结果覆盖）
export const KV_CHANNEL_RUNTIME_TREE = 'channel_runtime_tree'; // 应用测速/过滤后的运行时频道树（/live 输出与版本使用）
export const KV_LIVE_MERGE_REPORT = 'live_merge_report'; // 最近一次直播聚合统计报告
export const KV_LIVE_SOURCE_CACHE = 'live_source_cache'; // m3u/txt 下载缓存
export const KV_LIVE_MERGED_TXT_VERSION = 'live_merged_txt_version'; // 预生成直播 TXT 内容版本
export const KV_LIVE_RUNTIME_TXT_VERSION = 'live_runtime_txt_version'; // 实时解析直播 TXT 对应版本
// CF 分离模式：每个 /live/<key> 的预构建过滤后 TXT（仅 CF 写入/读取）
export const KV_LIVE_TEXT_PREFIX = 'live_txt:'; // live_txt:<key> -> 过滤后的直播 TXT

// 聚合日志
export const KV_AGG_LOGS = 'agg_logs';
export const AGG_LOGS_MAX = 50;
export const KV_SITE_SNAPSHOT = 'site_snapshot';
export const KV_DIRTY_MARKER = 'dirty_marker';

// 背景设置
export const KV_BG_SETTINGS = 'bg_settings';

// 分组排序
export const KV_GROUP_ORDER = 'group_order';

// 高级去重配置
export const KV_DEDUP_CONFIG = 'dedup_config';

// 直播禁用开关
export const KV_LIVE_DISABLED = 'live_disabled';
// 直播合并模式：'separated'（按源分类）| 'merged'（全部合并）
export const KV_LIVE_MERGE_MODE = 'live_merge_mode';
// 是否忽略第三方配置源自带的直播源
export const KV_IGNORE_AGGREGATED_LIVES = 'ignore_aggregated_lives';

// 智能 Base URL
export const BASE_URL_PLACEHOLDER = '{{BASE_URL}}';
export const KV_SMART_BASE_URL_ENABLED = 'smart_base_url_enabled';

// 站点验活
export const KV_SITE_HEALTH_MAP = 'site_health_map';
export const KV_SITE_PROBE_DEPTH = 'site_probe_depth'; // 'shallow' | 'deep'
export const KV_SITE_AUTO_CLEAN = 'site_auto_clean';   // 'true' | 'false'

// Builder 源追踪
export const KV_SOURCE_MAP = 'builder_source_map'; // { sites: Record, parses: Record, lives: Record }
export const KV_SITE_UPSTREAM_MAP = 'site_upstream_map';
export const KV_SITE_CONTRACT_MAP = 'site_contract_map'; // { sites: Record<siteKey, SiteContract> }

// 频道测速 cron：每 12 小时
export const CHANNEL_PROBE_CRON = '0 */12 * * *';
// 并发与超时
export const CHANNEL_PROBE_CONCURRENCY = 18;
export const CHANNEL_PROBE_TIMEOUT_MS = 5000;
// 缓存过期（7 天）
export const CHANNEL_SPEED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
