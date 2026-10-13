// 聚合流程编排

import type { Storage } from './storage/interface';
import type { AppConfig, SourceEntry, SourcedConfig, MacCMSSourceEntry, SourceFetchResult, SourceHealthRecord, AggregationLog, AggLogFailedSource, AggLogSiteChange, TVBoxSite, TVBoxLive, SiteHealthMap } from './core/types';
import { fetchConfigs } from './core/fetcher';
import { mergeConfigs, cleanLocalRefs, cleanEmptyEntries } from './core/merger';
import { batchSiteSpeedTest, appendSpeedToName, filterUnreachableSites, type SiteProbeResult } from './core/speedtest';
import { macCMSToTVBoxSites, processMacCMSForLocal } from './core/maccms';
import { rewriteJarUrls, prefetchJarBinaries, type JarEntry } from './core/jar-proxy';
import { mergeLivesToNative, separatedMergeLives, formatLiveGroupsAsTxt, filterLiveSourcesDetailed, serializeLiveCandidatePool, type LiveSourceInput, type MergeLivesResult } from './core/live-merger';
import { partitionMergeSourceMetrics, type LiveCategory } from './core/live-quality';
import { listLiveProxyEntries, pruneLiveProxyManifestToUrls, updateLiveProxyManifest } from './core/live-source';
import { rebuildLiveOutput } from './core/live-output';
import { isBlockedLiveSource, partitionBlockedLiveSources } from './core/live-policy';
import { persistCollectedLivePrepareInputs } from './core/live-inputs';
import { KV_MERGED_CONFIG, KV_MERGED_CONFIG_FULL, KV_STARTUP_SITE_POOL, KV_SOURCE_URLS, KV_LAST_UPDATE, KV_LAST_UPDATE_ERROR, KV_MANUAL_SOURCES, KV_MACCMS_SOURCES, KV_LIVE_SOURCES, KV_LIVE_MERGED_DATA, KV_LIVE_MERGED_TXT, KV_LIVE_MERGE_REPORT, KV_LIVE_RUNTIME_EMPTY_AT, KV_BLACKLIST, KV_INLINE_PREFIX, KV_NAME_TRANSFORM, KV_SOURCE_HEALTH, KV_SPEED_TEST_ENABLED, KV_EDGE_PROXIES, KV_SEARCH_QUOTA_REPORT, KV_PARSE_HEALTH_REPORT, KV_CHANNEL_MERGED_TREE, KV_CHANNEL_RUNTIME_TREE, KV_CHANNEL_CANDIDATE_URLS, KV_AGG_LOGS, AGG_LOGS_MAX, KV_SITE_SNAPSHOT, KV_DEDUP_CONFIG, KV_LIVE_DISABLED, KV_LIVE_MERGE_MODE, KV_IGNORE_AGGREGATED_LIVES, BASE_URL_PLACEHOLDER, KV_SITE_HEALTH_MAP, KV_SITE_PROBE_DEPTH, KV_SITE_AUTO_CLEAN, KV_SOURCE_MAP, KV_SITE_UPSTREAM_MAP, KV_SOURCE_URL_BLACKLIST } from './core/config';
import { loadBlacklist, applyBlacklist, pruneBlacklist, saveBlacklist, siteFingerprint } from './core/blacklist';
import { transformSiteNames } from './core/cleaner';
import { parseConfigJson, type FetchProxyConfig } from './core/fetcher';
import { stableJsonEqual } from './core/stable-json';
import { scrapeSourceList, scrapeMacCMSSources, type ScrapeSourceConfig, type ScrapeMacCMSConfig } from './core/source-scraper';
import { loadSearchQuota, applySearchQuota, probeAndPruneParses } from './core/search-quota';
import { loadGroupOrder, applyGroupOrder } from './core/group-order';
import { deduplicateSimilarNames } from './core/dedup';
import { logger } from './core/logger';
import { clearDirtyMarker } from './core/dirty-marker';
import { loadQualityPool, runQualityGrading } from './core/quality';
import type { NameTransformConfig, EdgeProxyConfig } from './core/types';

function publicSites<T extends { __upstreamNames?: string[] }>(sites: T[]): T[] {
  return sites.map((site) => {
    const { __upstreamNames: _ignored, ...rest } = site as T & { __upstreamNames?: string[] };
    return rest as T;
  });
}

function publicConfig<T extends { sites?: Array<{ __upstreamNames?: string[] }> }>(config: T): T {
  const clone = JSON.parse(JSON.stringify(config)) as T;
  if (clone.sites) clone.sites = publicSites(clone.sites);
  return clone;
}

export interface AggregationRunOptions {
  waitUntil?: (task: Promise<void>) => void;
  writeBinary?: (key: string, bytes: Uint8Array) => Promise<void>;
}

export async function runAggregation(
  storage: Storage,
  config: AppConfig,
  options: AggregationRunOptions = {},
): Promise<void> {
  const startTime = Date.now();
  logger.info('aggregation', 'Starting...');

  try {
    await _runAggregation(storage, config, startTime, options);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : '';
    logger.error('aggregation', `FATAL ERROR: ${msg}`);
    logger.error('aggregation', `Stack: ${stack}`);
    // 不要污染最后成功更新时间；失败原因单独记录，且不得覆盖同 key 的旧错误。
    const lastError = `ERROR @ ${new Date().toISOString()}: ${msg}`;
    try {
      await storage.put(KV_LAST_UPDATE_ERROR, lastError);
    } catch {
      // /status-data 仍可从日志和旧值中读取失败原因。
    }

    await appendAggLog(storage, {
      id: new Date(startTime).toISOString(),
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      success: false,
      errorMessage: msg,
      totalSources: 0,
      okSources: 0,
      failedSources: [],
      addedSites: [],
      removedSites: [],
      finalSiteCount: 0,
      finalParseCount: 0,
      finalLiveCount: 0,
      blacklistRemovedSites: 0,
      blacklistRemovedParses: 0,
      blacklistRemovedLives: 0,
    });
    throw error;
  }
}

async function _runAggregation(storage: Storage, config: AppConfig, startTime: number, options: AggregationRunOptions): Promise<void> {

  // ── 日志收集用局部变量 ──
  let logFetchResults: SourceFetchResult[] = [];
  let logBlacklistRemovedSites = 0;
  let logBlacklistRemovedParses = 0;
  let logBlacklistRemovedLives = 0;

  // 读取上次站点快照（用于计算 diff）
  const snapshotRaw = await storage.get(KV_SITE_SNAPSHOT);
  const prevSiteKeys: Set<string> = snapshotRaw ? new Set(JSON.parse(snapshotRaw)) : new Set();

  // Step 0: 自动抓取源（需配置 SCRAPE_SOURCE_URL 环境变量，referer 可选）
  if (config.scrapeSourceUrl) {
    logger.info('aggregation', 'Step 0: Auto-scraping sources...');
    try {
      const scrapeCfg: ScrapeSourceConfig = { url: config.scrapeSourceUrl, referer: config.scrapeSourceReferer || '' };
      const scraped = await scrapeSourceList(scrapeCfg);
      if (scraped.length > 0) {
        const existingRaw = await storage.get(KV_MANUAL_SOURCES);
        const existingSources: SourceEntry[] = existingRaw ? JSON.parse(existingRaw) : [];
        const existingUrls = new Set(existingSources.map(s => s.url));

        let added = 0;
        for (const source of scraped) {
          if (!existingUrls.has(source.url)) {
            existingSources.push(source);
            existingUrls.add(source.url);
            added++;
          }
        }

        if (added > 0) {
          await storage.put(KV_MANUAL_SOURCES, JSON.stringify(existingSources));
          logger.infoFields('aggregation', 'auto-scrape-added', { added, total: existingSources.length });
        } else {
          logger.infoFields('aggregation', 'auto-scrape-none-new', { scraped: scraped.length });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('aggregation', `Auto-scrape failed (non-blocking): ${msg}`);
    }
  }

  // Step 0.5: MacCMS 资源站自动抓取（需配置 MACCMS_API_URL 环境变量）
  if (config.maccmsApiUrl && config.maccmsAesKey && config.maccmsAesIv) {
    logger.info('aggregation', 'Step 0.5: Auto-scraping MacCMS sources...');
    try {
      const maccmsCfg: ScrapeMacCMSConfig = { apiUrl: config.maccmsApiUrl, aesKey: config.maccmsAesKey, aesIv: config.maccmsAesIv };
      const scraped = await scrapeMacCMSSources(maccmsCfg);
      if (scraped.length > 0) {
        await storage.put(KV_MACCMS_SOURCES, JSON.stringify(scraped));
        logger.infoFields('aggregation', 'maccms-auto-scraped', { count: scraped.length });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('aggregation', `MacCMS auto-scrape failed (non-blocking): ${msg}`);
    }
  }

  // Step 1: 读取手动配置的源（含自动抓取合并后的）
  logger.info('aggregation', 'Step 1: Loading sources...');
  const raw = await storage.get(KV_MANUAL_SOURCES);
  const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

  // 检查是否有 MacCMS 源（即使没有 config 源也可以继续）
  const macCMSRaw = await storage.get(KV_MACCMS_SOURCES);
  const hasMacCMS = macCMSRaw ? JSON.parse(macCMSRaw).length > 0 : false;

  if (sources.length === 0 && !hasMacCMS) {
    logger.warn('aggregation', 'No sources configured, nothing to do');
    return;
  }

  const activeSources = sources.filter(s => !s.disabled);
  logger.infoFields('aggregation', 'sources-loaded', { total: sources.length, active: activeSources.length });
  await storage.put(KV_SOURCE_URLS, JSON.stringify(sources));

  // Step 1.5: 处理 MacCMS 源
  logger.info('aggregation', 'Step 1.5: Processing MacCMS sources...');
  const macCMSConfigs = await processMacCMSSources(storage, config);

  // Step 1.6: 直播源频道级合并移至 Step 6.5（方案 D+）

  // Step 1.8: 分离 inline:// 源，从 KV 直接加载
  const remoteSources = activeSources.filter(s => !s.url.startsWith('inline://'));
  const inlineSources = activeSources.filter(s => s.url.startsWith('inline://'));
  const inlineConfigs: SourcedConfig[] = [];

  for (const src of inlineSources) {
    const kvKey = src.url.replace('inline://', '');
    const raw = await storage.get(kvKey);
    if (raw) {
      const parsed = parseConfigJson(raw);
      if (parsed) {
        inlineConfigs.push({ sourceUrl: src.url, sourceName: src.name || 'Inline', config: parsed });
        logger.info('aggregation', `Loaded inline config: ${kvKey}`);
      } else {
        logger.warn('aggregation', `Failed to parse inline config: ${kvKey}`);
      }
    } else {
      logger.warn('aggregation', `Inline config not found in KV: ${kvKey}`);
    }
  }

  // Step 2: 批量 fetch 配置 JSON（本地模式可通过边缘代理回退）
  logger.info('aggregation', 'Step 2: Fetching configs...');
  const sourceUrlBlacklistRaw = await storage.get(KV_SOURCE_URL_BLACKLIST);
  const sourceUrlBlacklist = new Set<string>(
    sourceUrlBlacklistRaw ? JSON.parse(sourceUrlBlacklistRaw) : [],
  );
  if (sourceUrlBlacklist.size > 0) {
    logger.info('aggregation', `Source URL blacklist: ${sourceUrlBlacklist.size} entries`);
  }
  let proxyConfig: FetchProxyConfig | undefined;
  if (!config.workerBaseUrl) {
    // 本地模式：读取边缘代理配置
    const edgeRaw = await storage.get(KV_EDGE_PROXIES);
    if (edgeRaw) {
      const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
      const urls: string[] = [];
      if (edge.cf) urls.push(`${edge.cf}/fetch-proxy`);
      if (edge.vercel) urls.push(`${edge.vercel}/api/proxy`);
      if (urls.length > 0) {
        proxyConfig = { urls, token: config.adminToken };
        logger.info('aggregation', `Edge proxies configured: ${urls.join(', ')}`);
      }
    }
  }
  const { configs: sourcedConfigs, fetchResults } = await fetchConfigs(remoteSources, config.fetchTimeoutMs, proxyConfig, sourceUrlBlacklist);
  logFetchResults = fetchResults;

  // 更新源健康状态
  await updateSourceHealth(storage, fetchResults);

  if (sourcedConfigs.length === 0 && inlineConfigs.length === 0 && macCMSConfigs.length === 0) {
    logger.warn('aggregation', 'No valid configs fetched and no MacCMS/inline sources, keeping previous cache');
    return;
  }

  // Step 3: 用 fetch 耗时筛选配置源
  let filteredConfigs: SourcedConfig[] = sourcedConfigs;

  const configsWithSpeed = sourcedConfigs.filter((c) => c.speedMs != null);
  if (configsWithSpeed.length > 0) {
    logger.info('aggregation', 'Step 3: Filtering configs by fetch speed...');
    filteredConfigs = sourcedConfigs.filter((c) => {
      if (c.speedMs == null) return true; // 没有测速数据的保留
      if (c.speedMs <= config.speedTimeoutMs) return true;
      logger.infoFields('aggregation', 'speed-filter-removed', { url: c.sourceUrl, speedMs: c.speedMs, threshold: config.speedTimeoutMs });
      return false;
    });

    if (filteredConfigs.length === 0) {
      logger.warn('aggregation', 'All configs failed speed filter, using all fetched configs');
      filteredConfigs = sourcedConfigs;
    } else {
      logger.infoFields('aggregation', 'speed-filter-passed', { passed: filteredConfigs.length, total: sourcedConfigs.length });
    }
  } else {
    logger.info('aggregation', 'Step 3: No speed data available, skipping filter');
  }

  // Step 4: 合并（包含 MacCMS 源，投票制 spider 分配）
  logger.info('aggregation', 'Step 4: Merging configs...');
  const allConfigs = [...filteredConfigs, ...inlineConfigs, ...macCMSConfigs];
  const mergeResult = mergeConfigs(allConfigs);
  let merged = mergeResult.config;
  const { siteSourceMap, siteUpstreamMap, parseSourceMap, liveSourceMap } = mergeResult;


  // Step 4.5: 黑名单过滤
  logger.info('aggregation', 'Step 4.5: Applying blacklist...');
  const blacklist = await loadBlacklist(storage);
  const hasBlacklist = blacklist.sites.length > 0 || blacklist.parses.length > 0 || blacklist.lives.length > 0 || blacklist.regexRules.some(r => r.enabled);

  // 保存过滤前的完整上游配置（供配置编辑器显示已屏蔽项）。
  const fullConfigSnapshot = JSON.parse(JSON.stringify(merged)) as typeof merged;

  await storage.put(KV_SOURCE_MAP, JSON.stringify({
    sites: Object.fromEntries(siteSourceMap),
    parses: Object.fromEntries(parseSourceMap),
    lives: Object.fromEntries(liveSourceMap),
  }));

  if (hasBlacklist) {
    // 自动清理黑名单中已不存在的条目（必须在过滤前比对，否则被屏蔽的条目会被误判为"过时"而清掉）
    const pruned = await pruneBlacklist(blacklist, merged);
    if (JSON.stringify(pruned) !== JSON.stringify(blacklist)) {
      await saveBlacklist(storage, pruned);
    }

    const { config: filtered, removedSites, removedParses, removedLives, removedByRegex } = await applyBlacklist(merged, pruned);
    merged = filtered;
    logBlacklistRemovedSites = removedSites;
    logBlacklistRemovedParses = removedParses;
    logBlacklistRemovedLives = removedLives;
    logger.infoFields('aggregation', 'blacklist-removed', { sites: removedSites, parses: removedParses, lives: removedLives, regex: removedByRegex });
  } else {
    logger.info('aggregation', 'Step 4.5: No blacklist entries, skipping');
  }

  // Step 4.6: 清洗无效数据（空条目 + 本地引用）— 必须在搜索配额前，避免配额分给随后被清理的站点
  logger.info('aggregation', 'Step 4.6: Cleaning invalid entries...');
  merged = cleanEmptyEntries(merged);
  merged = cleanLocalRefs(merged);

  // JS HTTP 入口不再提前排除：它们可复用站点 HTTP 探针做质量排序，
  // 最终脚本执行仍由客户端完成。

  // Step 5.5: 名称定制（清洗推广文字 + 前缀后缀）
  const ntRaw = await storage.get(KV_NAME_TRANSFORM);
  const nameTransform: NameTransformConfig = ntRaw ? JSON.parse(ntRaw) : {};
  const hasTransform = nameTransform.prefix || nameTransform.suffix || nameTransform.promoReplacement || nameTransform.extraCleanPatterns?.length;
  if (hasTransform) {
    logger.info('aggregation', 'Step 5.5: Applying name transform...');
    merged = transformSiteNames(merged, nameTransform);
  } else {
    // 即使没有自定义配置，默认清洗推广文字也要执行
    logger.info('aggregation', 'Step 5.5: Cleaning promo text from site names...');
    merged = transformSiteNames(merged, {});
  }

  // 上游源配置保持原样，不做服务端修改。

  // Step 6: 站点验活 + 不可达过滤 + name 标记（CF 和 Node.js 统一）
  const speedTestRaw = await storage.get(KV_SPEED_TEST_ENABLED);
  const speedTestEnabled = speedTestRaw !== 'false';
  const probeDepthRaw = await storage.get(KV_SITE_PROBE_DEPTH);
  const probeDeep = probeDepthRaw !== 'shallow' && !config.workerBaseUrl; // CF Worker 强制 shallow
  let siteProbeMap: Map<string, SiteProbeResult> = new Map();
  let siteSpeedMap: Map<string, number | null> = new Map();

  // 质量分级必须覆盖“过滤不可达之前”的完整可搜索池，否则一次探测失败
  // 的源会直接消失，既无法进入 unusable 统计，也无法参与后续重排。
  const preProbeSites: TVBoxSite[] = merged.sites ? [...merged.sites] : [];

  if (!speedTestEnabled) {
    logger.info('aggregation', 'Step 6: Speed test disabled, skipping');
  } else if (merged.sites && merged.sites.length > 0) {
    logger.infoFields('aggregation', 'Step 6: site probe', { depth: probeDeep ? 'deep' : 'shallow' });
    siteProbeMap = await batchSiteSpeedTest(merged.sites, config.siteTimeoutMs, probeDeep, config.speedTestConcurrency, config.speedTestBudgetMs);

    // 提取纯 speedMs map 供后续 dedup 使用
    for (const [key, probe] of siteProbeMap) {
      siteSpeedMap.set(key, probe.speedMs);
    }

    if (siteProbeMap.size > 0) {
      const { sites: filteredSites, filtered } = filterUnreachableSites(merged.sites, siteProbeMap);
      merged.sites = filteredSites;

      if (!config.workerBaseUrl) {
        merged.sites = appendSpeedToName(merged.sites, siteProbeMap);
      }
    }

    // 更新站点健康状态 & 自动标记/屏蔽；同时把历史健康信息回填到本次探测结果，
    // 供质量分级使用，避免仅凭单次波动误判。
    // 必须把过滤前的完整站点列表交给健康更新，否则本轮失败后被过滤掉的源
    // 永远无法累计 consecutiveFailures，也就无法在后续轮次进入 unusable。
    await updateSiteHealth(storage, siteProbeMap, preProbeSites, merged);

  } else {
    logger.info('aggregation', 'Step 6: No sites to test');
  }

  // Step 6.2: 相似名称去重（保留响应速度最快的站点）
  const dedupRaw = await storage.get(KV_DEDUP_CONFIG);
  let similarDedupEnabled = true;
  let similarDedupThreshold = 0.85;
  if (dedupRaw) {
    try {
      const dedupCfg = JSON.parse(dedupRaw);
      similarDedupEnabled = dedupCfg.similarDedup !== false;
      similarDedupThreshold = typeof dedupCfg.similarDedupThreshold === 'number'
        ? dedupCfg.similarDedupThreshold
        : 0.85;
    } catch { /* ignore */ }
  }

  if (similarDedupEnabled && merged.sites && merged.sites.length > 0) {
    logger.infoFields('aggregation', 'Step 6.2: similar-name-dedup', { threshold: similarDedupThreshold });
    merged.sites = deduplicateSimilarNames(merged.sites, siteSpeedMap, similarDedupThreshold);
    logger.infoFields('aggregation', 'similar-dedup-done', { sites: merged.sites.length });
  } else {
    logger.info('aggregation', 'Step 6.2: Similar-name dedup disabled, skipping');
  }

  // Build the persisted quality pool after deduplication so its key set is a
  // subset of the configuration that will actually be published. Health is
  // still updated from preProbeSites above, so removed entries retain failure
  // history without leaking back into distribution.
  if (merged.sites && merged.sites.length > 0) {
    try {
      const healthMap = await loadSiteHealthMap(storage);
      const snapshot = await runQualityGrading(storage, merged.sites, {
        probeMap: siteProbeMap,
        healthMap,
        globalSpider: merged.spider,
        markRun: false,
        timezone: config.qualityTimezone,
      });
      logger.infoFields('aggregation', 'quality-grading', {
        total: snapshot.total,
        graded: snapshot.graded,
        excellent: snapshot.grades.excellent.count,
        good: snapshot.grades.good.count,
        usable: snapshot.grades.usable.count,
        untestable: snapshot.grades.untestable.count,
        timeout: snapshot.grades.timeout.count,
        unusable: snapshot.grades.unusable.count,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('aggregation', 'Quality grading failed (non-fatal): ' + msg);
    }
  }


  // Step 6.5: 直播源频道级合并（方案 D+）
  // 收集所有 m3u/txt URL（配置源合来的 FongMi 格式 lives + admin 手动源）
  // → 下载 → 解析 → 按频道名合并 urls → 输出 TVBoxLiveGroup[]
  // CF 采用分片预热：每轮只下载少量源，成功文本落 KV，未就绪源绝不下发。
  // 这样既避开 Worker 子请求上限，又能让质量池随轮次持续恢复。
  // 直播禁用开关
  const liveDisabledRaw = await storage.get(KV_LIVE_DISABLED);
  const liveDisabled = liveDisabledRaw === 'true';

  const previousLiveConfigRaw = await storage.get(KV_MERGED_CONFIG);
  let previousLiveLives: TVBoxLive[] = [];
  try {
    const previousLiveConfig = previousLiveConfigRaw ? JSON.parse(previousLiveConfigRaw) : {};
    previousLiveLives = Array.isArray(previousLiveConfig.lives) ? previousLiveConfig.lives : [];
    previousLiveLives = previousLiveLives.filter((live) => !isBlockedLiveSource({
      name: live.name,
      url: live.url || live.api || '',
    }));
  } catch {
    // 旧配置损坏时不影响本轮聚合
  }
  let liveMergeFailed = false;

  if (liveDisabled) {
    logger.info('aggregation', 'Step 6.5: Live disabled, skipping');
    merged.lives = [];
  } else if (config.workerBaseUrl) {
    // CF 只收集并持久化直播输入，下载/解析/文本预构建由独立分片任务推进。
    // 聚合主任务不会因直播上游超时被截断，也不会下发尚未生成正文的入口。
    const ignoreAggregatedLivesRaw = await storage.get(KV_IGNORE_AGGREGATED_LIVES);
    const ignoreAggregatedLives = ignoreAggregatedLivesRaw === 'true';
    const manualRaw = await storage.get(KV_LIVE_SOURCES);
    const inputSet = await persistCollectedLivePrepareInputs(
      merged.lives || [],
      manualRaw,
      storage,
      { ignoreAggregated: ignoreAggregatedLives },
    );
    // 输入一变就裁剪权威清单，防止上一轮不在本批次的幽灵源在分片完成前继续进入管理端或下发策略。
    // 只压缩清单，不批量写空 KV 正文；路由仍按 textReady 复核，旧文本不会复活。
    await pruneLiveProxyManifestToUrls(inputSet.sources.map((source) => source.url), storage);
    logger.infoFields('aggregation', 'live-prepare-inputs-persisted', {
      sources: inputSet.sourceCount,
      ignoredAggregated: ignoreAggregatedLives,
    });

    await storage.put(KV_LIVE_MERGE_REPORT, JSON.stringify({
      updatedAt: new Date().toISOString(),
      mode: (await storage.get(KV_LIVE_MERGE_MODE)) === 'merged' ? 'merged' : 'separated',
      platform: 'cloudflare',
      sources: inputSet.sourceCount,
      prepareInputs: inputSet.sourceCount,
      textReady: (await listLiveProxyEntries(storage)).length,
      distributable: (await listLiveProxyEntries(storage)).length,
    }));
  } else {
    logger.info('aggregation', 'Step 6.5: Channel-level live merging...');
    {
      const liveInputs: LiveSourceInput[] = [];

      const ignoreAggregatedLivesRaw = await storage.get(KV_IGNORE_AGGREGATED_LIVES);
      const ignoreAggregatedLives = ignoreAggregatedLivesRaw === 'true';

      // 配置源合并来的 lives（FongMi 格式）
      if (!ignoreAggregatedLives) {
        for (const l of (merged.lives || []) as Array<{ name?: string; url?: string; api?: string; ua?: string; header?: Record<string, string>; group?: string }>) {
          // 跳过已经是 Native 格式的（含 group 字段无 url）
          if (l.group && !l.url && !l.api) continue;
          const u = l.url || l.api;
          if (!u || !/^https?:\/\//i.test(u)) continue;
          if (u.includes('127.0.0.1') || u.includes('localhost')) continue;
          liveInputs.push({
            name: l.name || 'source',
            url: u,
            ua: l.ua,
            header: l.header,
            isAggregated: true,
          });
        }
      }

    // admin 手动源
    const liveRaw = await storage.get(KV_LIVE_SOURCES);
    if (liveRaw) {
      try {
        const manual: Array<{ name: string; url: string; disabled?: boolean }> = JSON.parse(liveRaw);
        for (const m of manual) {
          if (m.disabled) continue;
          if (!m.url || !/^https?:\/\//i.test(m.url)) continue;
          if (m.url.includes('127.0.0.1') || m.url.includes('localhost')) continue;
          liveInputs.push({
            name: m.name || 'manual',
            url: m.url,
            isAggregated: false,
          });
        }
      } catch {
        /* ignore */
      }
    }

    // 共享屏蔽策略必须先于聚合/分离处理执行，避免坏源进入下载、缓存、
    // 测速或任何后续输出。
    const policy = partitionBlockedLiveSources(liveInputs);
    if (policy.blocked.length > 0) {
      logger.infoFields('aggregation', 'Step 6.5: blocked-live-sources', { count: policy.blocked.length });
    }

    // URL 去重
    const seen = new Set<string>();
    const uniqueInputs = policy.allowed.filter((i) => {
      const core = getCoreLiveUrl(i.url);
      if (seen.has(core)) return false;
      seen.add(core);
      return true;
    });

    if (uniqueInputs.length === 0) {
      logger.info('aggregation', 'Step 6.5: No live sources to merge');
      merged.lives = [];
    } else {
      const liveMergeMode = (await storage.get(KV_LIVE_MERGE_MODE)) || 'separated';
      logger.infoFields('aggregation', 'Step 6.5: live-sources', { unique: uniqueInputs.length, mode: liveMergeMode });

      // 第一步：不带测速过滤生成完整候选池。失败/超慢线路也必须进入池中，
      // 否则 probe 下一轮只能看到“当前可用”的子集，无法重试和恢复线路。
      const candidateOptions = { preserveAllUrls: true, candidatePoolMaxUrlsPerChannel: 64 };
      let mergeResult;
      if (liveMergeMode === 'separated') {
        mergeResult = await separatedMergeLives(uniqueInputs, config.fetchTimeoutMs, undefined, storage, candidateOptions);
      } else {
        mergeResult = await mergeLivesToNative(uniqueInputs, config.fetchTimeoutMs, undefined, storage, candidateOptions);
      }

      if (mergeResult.groups.length === 0 && previousLiveLives.length > 0) {
        // 上游临时超时/解析失败时保留上一版可用直播，避免把 /live 清空。
        liveMergeFailed = true;
        merged.lives = previousLiveLives;
        logger.warn('aggregation', 'Step 6.5: Live merge produced no groups, keeping previous live output');
      } else {
        merged.lives = mergeResult.groups;

        // 完整候选池只由主聚合维护；代理清单承载逐源质量与分类，
        // 运行时输出统一从“质量池 + 下发策略”派生，避免其他入口各自截断。
        if (mergeResult.groups.length > 0) {
          await storage.put(KV_CHANNEL_MERGED_TREE, JSON.stringify(mergeResult.groups));
          // 完整候选树是 local-only，Render 重启后会丢失。这里同步一份带分组、
          // 频道和源标签的完整候选快照到 durable 存储，使重启后既能继续补测，
          // 也能在策略从少量下发扩展为全量时重建完整质量池，而不是卡在旧前沿。
          await storage.put(KV_CHANNEL_CANDIDATE_URLS, serializeLiveCandidatePool(mergeResult.groups));
          const hints: Record<string, { kind?: 'aggregated' | 'manual'; category?: LiveCategory }> = {};
          for (const input of uniqueInputs) {
            const category = mergeResult.sourceCategories?.[input.url];
            hints[input.url] = {
              kind: input.isAggregated ? 'aggregated' : 'manual',
              ...(category ? { category } : {}),
            };
          }
          // 明确 invalid（解析失败/内容非直播）与 transient（超时等）必须分开传递：
          // 若把两者都塞进 transientUrls，manifest 会把 invalid 覆盖成 transient，
          // 导致明确失效的源无法按 invalid 阈值淘汰，污染质量池可信度。
          const { validUrls: successfulUrls, transientUrls, invalidUrls } =
            partitionMergeSourceMetrics(mergeResult.sourceMetrics || {});
          await updateLiveProxyManifest(
            uniqueInputs.map((input) => ({ name: input.name, url: input.url, ua: input.ua, header: input.header })),
            storage,
            {
              validUrls: successfulUrls,
              transientUrls,
              invalidUrls,
              metrics: mergeResult.sourceMetrics,
              hints,
              labels: mergeResult.sourceLabels,
              texts: mergeResult.sourceTexts,
              fullSnapshot: true,
            },
          );
          const rebuilt = await rebuildLiveOutput(storage);
          merged.lives = rebuilt.groups.length > 0
            ? rebuilt.groups
            : previousLiveLives.length > 0
              ? previousLiveLives
              : mergeResult.groups;
          if (rebuilt.groups.length === 0) {
            logger.warn('aggregation', 'Step 6.5: Runtime tree empty after unified rebuild, keeping previous output');
          }
        }
      }

      // 记录本轮直播聚合统计，便于后续排查缓存命中与上游失败情况。
      await storage.put(KV_LIVE_MERGE_REPORT, JSON.stringify({
        updatedAt: new Date().toISOString(),
        mode: liveMergeMode === 'separated' ? 'separated' : 'merged',
        sources: uniqueInputs.length,
        sourcesDownloaded: mergeResult.sourcesDownloaded,
        sourcesFailed: mergeResult.sourcesFailed,
        cacheHits: mergeResult.cacheHits,
        cacheMisses: mergeResult.cacheMisses,
        revalidated: mergeResult.revalidated,
        staleFallbacks: mergeResult.staleFallbacks,
        groups: mergeResult.groups.length,
        channels: mergeResult.totalChannels,
        urls: mergeResult.totalUrls,
      }));

      logger.infoFields('aggregation', 'live-merge-done', {
        downloaded: mergeResult.sourcesDownloaded, total: uniqueInputs.length,
        cacheHits: mergeResult.cacheHits, cacheMisses: mergeResult.cacheMisses,
        revalidated: mergeResult.revalidated, staleFallbacks: mergeResult.staleFallbacks,
        groups: mergeResult.groups.length, channels: mergeResult.totalChannels, urls: mergeResult.totalUrls,
      });
    }
  }
  }

  // Step 6.8: 自定义分组排序
  const groupOrderCfg = await loadGroupOrder(storage);
  if (groupOrderCfg.enabled && merged.sites && merged.sites.length > 0) {
    logger.info('aggregation', 'Step 6.8: Applying custom group order...');
    merged.sites = applyGroupOrder(merged.sites, groupOrderCfg);
  } else {
    logger.info('aggregation', 'Step 6.8: Group order disabled or no rules, skipping');
  }

  // Step 6.9: 统一配置中心入口（移除所有原有的配置中心）
  if (merged.sites && merged.sites.length > 0) {
    const before = merged.sites.length;
    merged.sites = normalizeConfigCenterSites(merged.sites);
    const removed = before - merged.sites.length;
    if (removed > 0) {
      logger.info('aggregation', `Step 6.9: Unified config center, removed ${removed} duplicate entries`);
    }
  }

  // Step 6.95: 最终搜索配额硬约束
  // normalizeConfigCenterSites 仍可能移除站点，因此配额必须在所有站点处理完成后执行。
  // 这样 KV_SEARCH_QUOTA_REPORT 和最终根配置始终使用同一份 sites。
  if (merged.sites) {
    const quotaConfig = await loadSearchQuota(storage);

    // 探测预算耗尽时，使用上次聚合保存的站点健康记录补全质量分级。
    // 该记录属于当前部署自己的 KV，不会与另一套部署共享。
    const siteHealthMap: SiteHealthMap = await loadSiteHealthMap(storage);
    const qualityPool = await loadQualityPool(storage);

    const { sites: quotaSites, qualityPoolSites, quotaReport } = applySearchQuota(merged.sites, quotaConfig, siteSourceMap, {
      speedMap: siteSpeedMap,
      probeMap: siteProbeMap,
      healthMap: siteHealthMap,
      qualityPool,
    });
    merged.sites = quotaSites;

    // 保存动态质量池：已做健康/去重/归一化并按测速排序，但未按
    // maxQuickSearch 截断。根地址只读这份池，并按后台
    // 启动源数量取前 N 个，不会反向修改最终配置或另一套部署的 KV。
    await storage.put(KV_STARTUP_SITE_POOL, JSON.stringify({
      updatedAt: new Date().toISOString(),
      sites: publicSites(qualityPoolSites),
    }));

    // autoLimit=false 时 0 表示明确不限制；开启时保存前必须满足最终不变量。
    if (quotaConfig.autoLimit && quotaReport.maxQuickSearch > 0 && quotaReport.quickSearchable > quotaReport.maxQuickSearch) {
      throw new Error(`quick-search quota invariant failed: quickSearchable=${quotaReport.quickSearchable} max=${quotaReport.maxQuickSearch}`);
    }

    logger.infoFields('aggregation', 'search-quota', {
      total: quotaReport.totalSites, jsExcluded: quotaReport.jsExcluded,
      pinned: quotaReport.pinnedCount, truncated: quotaReport.truncated,
      searchable: quotaReport.searchable, quickSearchable: quotaReport.quickSearchable,
      quickTruncated: quotaReport.quickTruncated, maxQuickSearch: quotaReport.maxQuickSearch,
      autoLimit: quotaReport.autoLimit, speedSorted: quotaReport.speedSorted,
      leanRemoved: quotaReport.leanRemoved,
      final: true,
    });
    await storage.put(KV_SEARCH_QUOTA_REPORT, JSON.stringify({
      updatedAt: new Date().toISOString(),
      ...quotaReport,
    }));
  }

  // Step 6.96: 解析器健康探测
  // 客户端会逐个初始化 parses，死解析器会让首屏等待多个超时周期。
  // 先做并发探测并剔除确认失效项，再写入最终配置。
  if (merged.parses && merged.parses.length > 0) {
    const quotaConfig = await loadSearchQuota(storage);
    const beforeParses = merged.parses.length;
    const { parses: healthyParses, report: parseReport } = await probeAndPruneParses(
      merged.parses,
      config.workerBaseUrl ? 3000 : 3500,
      config.workerBaseUrl ? 6 : 12,
      quotaConfig.maxParses ?? 0,
      quotaConfig.pruneDeadParses !== false,
    );
    merged.parses = healthyParses;
    logger.infoFields('aggregation', 'parse-health-processed', {
      before: beforeParses,
      after: merged.parses.length,
      probed: parseReport.probed,
      removed: parseReport.removed,
      timeouts: parseReport.timeouts,
      httpErrors: parseReport.httpErrors,
      networkErrors: parseReport.networkErrors,
      failedProbe: parseReport.failedProbe === true,
      parseLimit: parseReport.parseLimit ?? 0,
      parseTruncated: parseReport.parseTruncated ?? 0,
    });
    await storage.put(KV_PARSE_HEALTH_REPORT, JSON.stringify({
      updatedAt: new Date().toISOString(),
      ...parseReport,
    }));
  }

  // Step 7: JAR URL 改写（统一用占位符，请求时替换为实际 base URL）
  logger.infoFields('aggregation', 'Step 7: rewriting JAR URLs', { placeholder: BASE_URL_PLACEHOLDER });
  let jarEntries: JarEntry[] = [];
  merged = await rewriteJarUrls(merged, BASE_URL_PLACEHOLDER, storage, {
    onJarEntries: (entries) => {
      jarEntries = entries;
    },
  });

  // JAR 预取只依赖已经写入的 jar:key -> 原始 URL 映射，不等待聚合主流程。
  // Node 使用文件缓存，Cloudflare 使用 KV 二进制缓存；就绪索引完成前，
  // 根配置不会下发普通远程 type=3 源。
  if (jarEntries.length > 0) {
    const prefetchTask = prefetchJarBinaries(storage, jarEntries, {
      writeBinary: options.writeBinary,
    });
    if (options.waitUntil) {
      options.waitUntil(prefetchTask);
    } else {
      void prefetchTask.catch((error: unknown) => {
        logger.warn('aggregation', 'JAR prefetch failed: ' + (error instanceof Error ? error.message : String(error)));
      });
    }
    logger.infoFields('aggregation', 'jar-prefetch-scheduled', {
      count: jarEntries.length,
      platform: config.workerBaseUrl ? 'cf' : 'node',
    });
  }

  // Step 7.5: 注入图片代理前缀（统一用占位符或边缘代理）
  const edgeRaw = await storage.get(KV_EDGE_PROXIES);
  if (edgeRaw) {
    const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
    if (edge.cf) {
      merged.pic = `${edge.cf.replace(/\/$/, '')}/img/`;
      logger.infoFields('aggregation', 'pic-proxy-injected-edge', { pic: merged.pic });
    } else {
      merged.pic = `${BASE_URL_PLACEHOLDER}/img/`;
      logger.infoFields('aggregation', 'pic-proxy-placeholder', { pic: merged.pic });
    }
  } else {
    merged.pic = `${BASE_URL_PLACEHOLDER}/img/`;
    logger.infoFields('aggregation', 'pic-proxy-placeholder', { pic: merged.pic });
  }

  // Save the final processed lives to KV_LIVE_MERGED_DATA (so /live.json can serve them).
  // Node/Render 在直播源临时全部失败时保留上一版输出；直播主动禁用或无源时仍正常清空。
  const preservePreviousLiveOutput = !config.workerBaseUrl && liveMergeFailed && previousLiveLives.length > 0;
  if (preservePreviousLiveOutput) {
    logger.warn('aggregation', 'Skipping live output overwrite because this refresh produced no valid channels');
  } else {
    await storage.put(KV_LIVE_MERGED_DATA, JSON.stringify(merged.lives || []));
    // 运行时 TXT/版本由 rebuildLiveOutput 统一生成，禁止在此用 Date.now()
    // 覆盖指纹版本，否则策略变化后旧缓存会被错误判定为最新。
    if (config.workerBaseUrl && !liveDisabled && ((merged.lives?.length) || 0) > 0) {
      await storage.put(KV_LIVE_RUNTIME_EMPTY_AT, '');
    }
  }

  // Step 7.8: 统一直播入口 —— TVBox 的 lives 字段只认 FongMi 格式 {name,type,url}。
  // CF 的 /live 与 /live/<key> 都只读预构建文本，这里按当前模式重建最终指针。
  {
    const liveEntries = merged.lives || [];
    const isNative = liveEntries.some((l: any) => l.group && Array.isArray(l.channels));
    const workerBaseUrl = config.workerBaseUrl;

    if (workerBaseUrl) {
      // CF Workers 模式。不能以 merged.lives.length > 0 为前置条件：
      // 冷启动或分片首轮可能没有就绪源，此时必须明确清空，不能保留旧模式残留。
      const normalizedBaseUrl = workerBaseUrl.replace(/\/$/, '');
      const liveMergeMode = (await storage.get(KV_LIVE_MERGE_MODE)) || 'separated';
      if (liveMergeMode === 'merged') {
        const readyEntries = await listLiveProxyEntries(storage);
        merged.lives = readyEntries.length > 0
          ? [{ name: '直播(聚合)', type: 0, url: `${normalizedBaseUrl}/live` }]
          : [];
        console.log(
          `[aggregation] Step 7.8: ${merged.lives.length > 0 ? 'Unified live entry' : 'No ready live sources'} for /live (CF Workers)`,
        );
      } else {
        // 分离模式只读取分片预热已经写入且通过质量门禁的文本清单，
        // 绝不在聚合请求路径再次回源全部上游直播源。
        const readyEntries = await listLiveProxyEntries(storage);
        merged.lives = readyEntries.map((entry) => ({
          name: entry.name || '直播源',
          type: 0,
          url: `${normalizedBaseUrl}/live/${entry.key}`,
        }));
        console.log(
          `[aggregation] Step 7.8: Exposed ${merged.lives.length} prebuilt /live/<key> sources`,
        );
      }
    } else if (isNative) {
      // Node/Docker (Render) 模式：Native groups 不能直接放在 config JSON 的 lives 里，
      // 必须替换为 FongMi 指针，让 TVBox 通过 /live 拉取 txt 格式频道列表。
      merged.lives = [
        {
          name: '直播(聚合)',
          type: 0,
          url: `${BASE_URL_PLACEHOLDER}/live`,
        },
      ];
      console.log('[aggregation] Step 7.8: Unified live entry pointing to /live (Node/Docker)');
    }
  }

  // Step 8: 存入存储
  // 完整快照只保存上游原始配置；服务端不处理上游字段。
  // 总源映射只保留最终实际存在的站点，并且只允许本次实际启用的总源贡献。
  // __upstreamNames 是内部标记，绝不能写入对外配置。
  const finalSiteUpstreams: Record<string, string[]> = {};
  for (const site of merged.sites || []) {
    const upstreams = (site.__upstreamNames?.length ? site.__upstreamNames : siteUpstreamMap.get(site.key)) || [];
    if (upstreams.length > 0) finalSiteUpstreams[site.key] = [...new Set(upstreams)].sort();
  }
  // 总源边界/契约指纹属于可重建的派生结果：KV 额度不足时不能中断整轮聚合，
  // 否则应用端拿不到本轮最新配置。失败时仅警告，下一轮或 outbox 补传。
  try {
    const previousRaw = await storage.get(KV_SITE_UPSTREAM_MAP);
    const previous = previousRaw ? JSON.parse(previousRaw) : null;
    if (!previous || !stableJsonEqual(previous.sites, finalSiteUpstreams)) {
      await storage.put(KV_SITE_UPSTREAM_MAP, JSON.stringify({
        updatedAt: new Date().toISOString(),
        sites: finalSiteUpstreams,
      }));
    }
  } catch (err) {
    logger.warn('aggregation', `site_upstream_map write deferred: ${err instanceof Error ? err.message : String(err)}`);
  }

  const publicMerged = publicConfig(merged);
  const publicFullSnapshot = publicConfig(fullConfigSnapshot);
  const mergedJson = JSON.stringify(publicMerged);
  await storage.put(KV_MERGED_CONFIG, mergedJson);
  await storage.put(KV_MERGED_CONFIG_FULL, JSON.stringify(publicFullSnapshot));
  await storage.put(KV_LAST_UPDATE, new Date().toISOString());

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.infoFields('aggregation', 'done', {
    elapsed: `${elapsed}s`, sites: merged.sites?.length, parses: merged.parses?.length, lives: merged.lives?.length,
  });

  // Step 9: 聚合日志
  const nowSiteKeys = new Set((merged.sites || []).map(s => s.key));
  const siteKeyToName = new Map((merged.sites || []).map(s => [s.key, s.name || s.key]));

  const addedSites: AggLogSiteChange[] = [];
  for (const key of nowSiteKeys) {
    if (!prevSiteKeys.has(key)) {
      addedSites.push({ key, name: siteKeyToName.get(key) });
    }
  }

  const removedSites: AggLogSiteChange[] = [];
  for (const key of prevSiteKeys) {
    if (!nowSiteKeys.has(key)) {
      removedSites.push({ key });
    }
  }

  const failedSources: AggLogFailedSource[] = logFetchResults
    .filter(r => r.status !== 'ok')
    .map(r => ({ url: r.url, name: r.name, status: r.status, errorMessage: r.errorMessage }));

  const aggLog: AggregationLog = {
    id: new Date(startTime).toISOString(),
    startTime: new Date(startTime).toISOString(),
    endTime: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    success: true,
    totalSources: logFetchResults.length,
    okSources: logFetchResults.filter(r => r.status === 'ok').length,
    failedSources,
    addedSites,
    removedSites,
    finalSiteCount: merged.sites?.length || 0,
    finalParseCount: merged.parses?.length || 0,
    finalLiveCount: merged.lives?.length || 0,
    blacklistRemovedSites: logBlacklistRemovedSites,
    blacklistRemovedParses: logBlacklistRemovedParses,
    blacklistRemovedLives: logBlacklistRemovedLives,
  };

  await appendAggLog(storage, aggLog);
  await storage.put(KV_SITE_SNAPSHOT, JSON.stringify([...nowSiteKeys]));
  await clearDirtyMarker(storage);

  if (addedSites.length > 0 || removedSites.length > 0) {
    logger.infoFields('aggregation', 'site-diff', { added: addedSites.length, removed: removedSites.length });
  }
}

/**
 * 处理 MacCMS 源：
 * - CF 版（有 workerBaseUrl）：直接转换，API 指向代理路由
 * - 本地版（无 workerBaseUrl）：并发验证 + 过滤不可达站点 + 收集延迟
 */
async function processMacCMSSources(
  storage: Storage,
  config: AppConfig,
): Promise<SourcedConfig[]> {
  const raw = await storage.get(KV_MACCMS_SOURCES);
  const entries: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
  const activeEntries = entries.filter((e) => !e.disabled);

  if (activeEntries.length === 0) {
    logger.info('aggregation', 'No active MacCMS sources configured');
    return [];
  }

  logger.infoFields('aggregation', 'maccms-sources-found', { total: entries.length, active: activeEntries.length });

  let validEntries: MacCMSSourceEntry[];
  let speedMap: Map<string, number> | undefined;

  const edgeProxiesRaw = !config.workerBaseUrl ? await storage.get(KV_EDGE_PROXIES) : null;

  if (config.workerBaseUrl || edgeProxiesRaw) {
    // CF 版或本地有 edge proxy：跳过验证，运行时代理兜底
    logger.info('aggregation', `Skipping MacCMS validation (${config.workerBaseUrl ? 'CF proxy' : 'edge proxy configured'})`);
    validEntries = activeEntries;
  } else {
    // 本地版无 edge proxy：并发验证，过滤不可达站点
    logger.info('aggregation', 'Local mode (no edge proxy): validating MacCMS sources...');
    const result = await processMacCMSForLocal(activeEntries, config.siteTimeoutMs);
    validEntries = result.passed;
    speedMap = result.speedMap;
  }

  if (validEntries.length === 0) {
    logger.warn('aggregation', 'No valid MacCMS sources after processing');
    return [];
  }

  const sites = macCMSToTVBoxSites(validEntries, BASE_URL_PLACEHOLDER, speedMap);
  logger.infoFields('aggregation', 'maccms-converted', { sites: sites.length });

  return [{
    sourceUrl: 'maccms://builtin',
    sourceName: 'MacCMS Sources',
    config: { sites },
  }];
}

/**
 * 更新源健康状态：读取历史 → merge 本次 fetch 结果 → 写回
 */
async function updateSourceHealth(storage: Storage, fetchResults: SourceFetchResult[]): Promise<void> {
  if (fetchResults.length === 0) return;

  const now = new Date().toISOString();

  // 读取历史健康记录
  const raw = await storage.get(KV_SOURCE_HEALTH);
  const oldRecords: SourceHealthRecord[] = raw ? JSON.parse(raw) : [];
  const oldMap = new Map(oldRecords.map(r => [r.url, r]));

  // 本次参与 fetch 的 URL 集合
  const fetchedUrls = new Set(fetchResults.map(r => r.url));

  // Merge 逻辑
  const newRecords: SourceHealthRecord[] = [];

  for (const fr of fetchResults) {
    const old = oldMap.get(fr.url);

    if (fr.status === 'ok') {
      newRecords.push({
        url: fr.url,
        name: fr.name,
        latestStatus: 'ok',
        consecutiveFailures: 0,
        lastSuccessTime: now,
        lastFailTime: old?.lastFailTime,
        lastFailReason: old?.lastFailReason,
        lastSpeedMs: fr.speedMs,
      });
    } else {
      newRecords.push({
        url: fr.url,
        name: fr.name,
        latestStatus: fr.status,
        consecutiveFailures: (old?.consecutiveFailures ?? 0) + 1,
        lastSuccessTime: old?.lastSuccessTime,
        lastFailTime: now,
        lastFailReason: fr.errorMessage,
        lastSpeedMs: old?.lastSpeedMs,
      });
    }
  }

  // 保留未参与本次 fetch 的历史记录（源可能被临时排除但还在列表中）
  // 但已被用户删除的源不应保留——这由 fetchResults 只包含当前源列表来保证
  // 如果老记录的 URL 不在本次 fetch 中，丢弃（源已被删除）
  // 注：inline:// 源不经过 fetcher，不会出现在 fetchResults 中，也不需要追踪

  const failCount = newRecords.filter(r => r.consecutiveFailures > 0).length;
  if (failCount > 0) {
    logger.infoFields('aggregation', 'source-health', { ok: newRecords.length - failCount, failing: failCount });
  }

  await storage.put(KV_SOURCE_HEALTH, JSON.stringify(newRecords));
}

async function loadSiteHealthMap(storage: Storage): Promise<SiteHealthMap> {
  const raw = await storage.get(KV_SITE_HEALTH_MAP);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SiteHealthMap;
    }
  } catch {
    // 健康记录损坏时按空表处理，避免影响聚合主流程。
  }
  return {};
}

async function updateSiteHealth(
  storage: Storage,
  probeMap: Map<string, SiteProbeResult>,
  allSites: TVBoxSite[],
  output?: { sites?: TVBoxSite[] },
): Promise<void> {
  if (probeMap.size === 0) return;

  const raw = await storage.get(KV_SITE_HEALTH_MAP);
  let healthMap: Record<string, { consecutiveFailures: number; lastProbeTime: string; lastProbeResult: string; lastSuccessTime?: string }> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) healthMap = parsed;
    } catch {
      // 健康记录损坏时按空表处理，避免影响聚合主流程。
    }
  }
  const now = new Date().toISOString();

  for (const [key, probe] of probeMap) {
    // 预算耗尽导致的未探测不能计为失败，否则会触发错误的健康降级和自动清理。
    if (probe.result === 'not_probed') continue;
    const prev = healthMap[key];
    // 供质量分级读取：本次探测结果 + 历史连续失败/上次成功时间。
    probe.consecutiveFailures = probe.result === 'ok'
      ? 0
      : (prev?.consecutiveFailures ?? 0) + 1;
    probe.lastSuccessTime = probe.result === 'ok' ? now : prev?.lastSuccessTime;
    if (probe.result === 'ok') {
      healthMap[key] = { consecutiveFailures: 0, lastProbeTime: now, lastProbeResult: 'ok', lastSuccessTime: now };
    } else {
      healthMap[key] = {
        consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        lastProbeTime: now,
        lastProbeResult: probe.result,
        lastSuccessTime: prev?.lastSuccessTime,
      };
    }
  }

  // 标记连续失败 >= 3 的站点。健康统计覆盖过滤前全量，但标记应写回
  // 最终输出，确保被过滤后保留在配置中的源也能显示风险状态。
  const markSites = output?.sites ?? allSites;
  if (markSites.length > 0) {
    for (let i = 0; i < markSites.length; i++) {
      const h = healthMap[markSites[i].key];
      if (h && h.consecutiveFailures >= 3) {
        const name = markSites[i].name || markSites[i].key;
        if (!name.includes('[⚠]')) {
          markSites[i] = { ...markSites[i], name: `${name} [⚠]` };
        }
      }
    }
  }

  // 自动清理：连续失败 >= 5 时加黑名单（需开关开启）。清理必须覆盖
  // 过滤前全量，否则本轮被过滤掉的源无法累计到自动清理阈值。
  const autoCleanRaw = await storage.get(KV_SITE_AUTO_CLEAN);
  if (autoCleanRaw === 'true' && allSites.length > 0) {
    const blacklist = await loadBlacklist(storage);
    let cleaned = 0;
    const MAX_AUTO_CLEAN = 5;

    for (const site of allSites) {
      if (cleaned >= MAX_AUTO_CLEAN) break;
      const h = healthMap[site.key];
      if (h && h.consecutiveFailures >= 5) {
        const fp = await siteFingerprint(site);
        if (!blacklist.sites.includes(fp)) {
          blacklist.sites.push(fp);
          cleaned++;
          logger.infoFields('aggregation', 'auto-clean-blacklisted', { key: site.key, name: site.name, failures: h.consecutiveFailures });
        }
      }
    }

    if (cleaned > 0) {
      await saveBlacklist(storage, blacklist);
      logger.infoFields('aggregation', 'auto-clean-done', { cleaned });
    }
  }

  await storage.put(KV_SITE_HEALTH_MAP, JSON.stringify(healthMap));
}

async function appendAggLog(storage: Storage, log: AggregationLog): Promise<void> {
  try {
    const raw = await storage.get(KV_AGG_LOGS);
    const logs: AggregationLog[] = raw ? JSON.parse(raw) : [];
    logs.push(log);
    while (logs.length > AGG_LOGS_MAX) {
      logs.shift();
    }
    await storage.put(KV_AGG_LOGS, JSON.stringify(logs));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('aggregation', `Failed to write agg log: ${msg}`);
  }
}

function normalizeConfigCenterSites(sites: TVBoxSite[]): TVBoxSite[] {
  // 移除所有原有的配置中心，不再注入任何新的配置中心
  return sites.filter((site) => !isConfigCenterSite(site));
}

function isConfigCenterSite(site: TVBoxSite): boolean {
  const key = site.key || '';
  const name = site.name || '';
  const api = site.api || '';
  const text = `${key} ${name} ${api}`;

  return /配置|设置\s*[┃|｜-]?\s*中心|我配置|config/i.test(text) || api === 'csp_Config' || key === 'csp_Config';
}

function getCoreLiveUrl(url: string): string {
  let u = url.trim();
  // Strip known GitHub proxy prefixes
  const proxyRegexes = [
    /^https?:\/\/gh(proxy)?\.(com|net|org|co|xyz|cc|top|vip|live|icu|cf|ga|gq|ml|link|work|fun|pub)\//i,
    /^https?:\/\/gh-proxy\.[^/]+\//i,
    /^https?:\/\/git(hub)?\.[^/]+\//i,
    /^https?:\/\/mirror\.ghproxy\.com\//i,
    /^https?:\/\/gh\.11kk\.cc\//i,
    /^https?:\/\/ghfast\.top\//i,
    /^https?:\/\/fastly\.jsdelivr\.net\/gh\//i,
    /^https?:\/\/cdn\.jsdelivr\.net\/gh\//i,
  ];

  for (const regex of proxyRegexes) {
    if (regex.test(u)) {
      u = u.replace(regex, '');
      if (!/^https?:\/\//i.test(u)) {
        if (u.startsWith('http')) {
          u = u.replace(/^(https?)\/?/, '$1://');
        } else if (u.includes('github')) {
          u = 'https://' + u;
        } else {
          u = 'https://github.com/' + u;
        }
      }
    }
  }

  // Handle raw.gitmirror.com
  u = u.replace(/raw\.gitmirror\.com/i, 'raw.githubusercontent.com');

  return u.toLowerCase();
}
