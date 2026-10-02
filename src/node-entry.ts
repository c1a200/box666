// Node.js 入口

import { serve } from '@hono/node-server';
import { webcrypto } from 'crypto';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

if (typeof (globalThis as any).crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true
  });
}
import * as cron from 'node-cron';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as dns from 'dns';
import { createApp } from './routes';
import { runAggregation } from './aggregator';
import { collectJarEntriesForSites, prefetchJarBinaries } from './core/jar-proxy';
import { runChannelProbe, isProbeEnabled, loadStatus } from './core/channel-probe';
import { currentAggregationPhase } from './core/logger';
import {
  beginQualityRun,
  finishQualityRun,
  loadQualityCandidates,
  loadQualityPool,
  qualityTargetSites,
  collectSearchableSites,
  loadQualityStatus,
  runQualityGradingChunk,
  shouldRunQualityNow,
  shouldRunFullQualityNow,
  updateQualityStatus,
} from './core/quality';
import {
  DEFAULT_SPEED_TIMEOUT_MS,
  DEFAULT_SITE_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_SPEED_TEST_CONCURRENCY,
  DEFAULT_SPEED_TEST_BUDGET_MS,
  DEFAULT_QUALITY_PROBE_CHUNK_SIZE,
  DEFAULT_QUALITY_PROBE_YIELD_MS,
  KV_CRON_INTERVAL,
  KV_MERGED_CONFIG,
  KV_LAST_UPDATE,
  DEFAULT_CRON_INTERVAL,
  CHANNEL_PROBE_CRON,
} from './core/config';
import type { Storage } from './storage/interface';
import type { AppConfig, SearchQualityRunMode } from './core/types';

// 加载 .env（嵌入式/无文件系统环境下容错：nodejs-mobile 无 .env，依赖注入的环境变量）
try {
  dotenv.config();
} catch {
  // 忽略：无 .env 或文件系统受限时，回退到已注入的 process.env
}

// 配置全局 HTTP/HTTPS 代理，用于国内网盘（如 Quark/UC/115 等）扫码登录时绕过海外云服务器的 IP 屏蔽
const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
if (proxyUrl) {
  try {
    const proxyAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(proxyAgent);
    console.log(`[proxy] Global undici dispatcher configured with proxy: ${proxyUrl}`);
  } catch (err: any) {
    console.error(`[proxy] Failed to configure global ProxyAgent: ${err.message}`);
  }
}

// ─── 存储初始化（SQLite → JSON 降级）───────────────────

function createJarBinaryWriter(): (key: string, bytes: Uint8Array) => Promise<void> {
  const jarDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'jars');
  return async (key: string, bytes: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(jarDir, { recursive: true });
    const dest = path.join(jarDir, key + '.jar');
    const tmp = dest + '.tmp';
    await fs.promises.writeFile(tmp, Buffer.from(bytes));
    await fs.promises.rename(tmp, dest);
  };
}

async function warmCachedJarBinaries(storage: Storage): Promise<void> {
  try {
    const cached = await storage.get(KV_MERGED_CONFIG);
    if (!cached) return;
    const parsed = JSON.parse(cached) as { sites?: any[]; spider?: string };
    const entries = collectJarEntriesForSites(parsed.sites || [], parsed.spider);
    if (entries.length === 0) return;
    console.log('[jar-proxy] Startup warm: ' + entries.length + ' cached type=3 JARs');
    await prefetchJarBinaries(storage, entries, { writeBinary: createJarBinaryWriter() });
  } catch (error: unknown) {
    console.warn('[jar-proxy] Startup warm failed:', error instanceof Error ? error.message : String(error));
  }
}

function createStorage(): Storage {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

  // 本地存储优先：Render 等 Node 环境不因远程 KV 慢/不可用而卡住。
  let localStorage: Storage;

  // 尝试 SQLite
  try {
    const { SQLiteStorage } = require('./storage/sqlite');
    const dbPath = path.join(dataDir, 'tvbox.db');
    localStorage = new SQLiteStorage(dbPath);
    console.log(`[storage] SQLite initialized: ${dbPath}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[storage] SQLite unavailable (${msg}), falling back to JSON file`);
    const { JsonFileStorage } = require('./storage/json-file');
    const jsonPath = path.join(dataDir, 'tvbox-data.json');
    localStorage = new JsonFileStorage(jsonPath);
    console.log(`[storage] JSON file storage: ${jsonPath}`);
  }

  // 显式关闭远端同步：仅用本地 SQLite 运行，便于验证/调试，完全不消耗 KV 额度。
  // 支持 STORAGE_REMOTE_SYNC=off / CF_KV_DISABLE=1。
  const remoteDisabled =
    /^(?:0|false|off|no)$/i.test((process.env.STORAGE_REMOTE_SYNC || '').trim()) ||
    /^(?:1|true|on|yes)$/i.test((process.env.CF_KV_DISABLE || '').trim());
  if (remoteDisabled) {
    console.log('[storage] Remote KV sync disabled by env; using local storage only');
    return localStorage;
  }

  // Cloudflare KV 作为可选同步后端（保留 Render 上已配置的三个变量）。
  if (process.env.CF_ACCOUNT_ID && process.env.CF_KV_NAMESPACE_ID && process.env.CF_API_TOKEN) {
    try {
      const { CloudflareKVStorage } = require('./storage/cloudflare-kv');
      const { HybridStorage } = require('./storage/hybrid');
      const remote = new CloudflareKVStorage(
        process.env.CF_ACCOUNT_ID,
        process.env.CF_KV_NAMESPACE_ID,
        process.env.CF_API_TOKEN,
        parseInt(process.env.CF_KV_TIMEOUT_MS || '') || 2500
      );
      console.log(
        `[storage] Cloudflare KV sync enabled: namespace ${process.env.CF_KV_NAMESPACE_ID} ` +
        `(Render namespace must differ from Worker namespace)`
      );
      return new HybridStorage(localStorage, remote);
    } catch (err: any) {
      console.error('[storage] Failed to initialize Cloudflare KV sync backend:', err.message);
    }
  }

  return localStorage;
}

// ─── 配置 ────────────────────────────────────────────────

async function buildConfig(port: number): Promise<AppConfig> {
  const docker = isDocker();
  let lanIp = getLocalIp();
  let dockerMissingBaseUrl = false;

  if (docker && !process.env.BASE_URL) {
    try {
      const result = await dns.promises.lookup('host.docker.internal');
      lanIp = result.address;
    } catch {
      // host.docker.internal 不可用（Linux Docker 非 Desktop），保留容器 IP 但标记警告
      dockerMissingBaseUrl = true;
    }
  }

  const baseUrl = process.env.BASE_URL || `http://${lanIp || 'localhost'}:${port}`;
  return {
    adminToken: process.env.ADMIN_TOKEN,
    refreshToken: process.env.REFRESH_TOKEN,
    speedTimeoutMs: parseInt(process.env.SPEED_TIMEOUT_MS || '') || DEFAULT_SPEED_TIMEOUT_MS,
    siteTimeoutMs: parseInt(process.env.SITE_TIMEOUT_MS || '') || DEFAULT_SITE_TIMEOUT_MS,
    fetchTimeoutMs: parseInt(process.env.FETCH_TIMEOUT_MS || '') || DEFAULT_FETCH_TIMEOUT_MS,
    speedTestConcurrency: parseInt(process.env.SPEED_TEST_CONCURRENCY || '') || DEFAULT_SPEED_TEST_CONCURRENCY,
    speedTestBudgetMs: parseInt(process.env.SPEED_TEST_BUDGET_MS || '') || DEFAULT_SPEED_TEST_BUDGET_MS,
    cronSchedule: process.env.CRON_SCHEDULE || '0 5 * * *',
    qualityTimezone: process.env.QUALITY_TIMEZONE || 'Asia/Shanghai',
    localBaseUrl: baseUrl.replace(/\/$/, ''),
    bilibiliQrProxyBaseUrl: process.env.BILIBILI_QR_PROXY_BASE_URL,
    bilibiliQrProxyToken: process.env.BILIBILI_QR_PROXY_TOKEN,
    dockerMissingBaseUrl,
    // 自动抓取（环境变量驱动）
    scrapeSourceUrl: process.env.SCRAPE_SOURCE_URL,
    scrapeSourceReferer: process.env.SCRAPE_SOURCE_REFERER,
    maccmsApiUrl: process.env.MACCMS_API_URL,
    maccmsAesKey: process.env.MACCMS_AES_KEY,
    maccmsAesIv: process.env.MACCMS_AES_IV,
  };
}

// ─── 启动 ────────────────────────────────────────────────

/** 将间隔分钟数转换为 cron 表达式 */
function intervalToCron(minutes: number): string {
  switch (minutes) {
    case 60:   return '0 */1 * * *';
    case 180:  return '0 */3 * * *';
    case 360:  return '0 */6 * * *';
    case 720:  return '0 */12 * * *';
    case 1440: return '0 5 * * *';
    default:   return '0 5 * * *';
  }
}

/** 间隔分钟数转可读文本 */
function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  if (minutes < 1440) return `${minutes / 60}h`;
  return `${minutes / 1440}d`;
}

async function main() {
  const storage = createStorage();
  const port = parseInt(process.env.PORT || '') || 5678;
  const config = await buildConfig(port);

  type AggregationTriggerResult = {
    started: boolean;
    running: boolean;
    completed: boolean;
    skipped?: boolean;
    timedOut?: boolean;
    runId?: string;
    startedAt?: string;
    phase?: string;
    elapsedMs?: number;
    message?: string;
  };

  let refreshRunning = false;
  let refreshRunId = '';
  let refreshStartedAt = 0;
  let refreshTimedOut = false;
  let refreshLastPhase = '';
  let refreshLastResult: AggregationTriggerResult | null = null;
  const aggregationTimeoutMs = Math.max(
    60_000,
    parseInt(process.env.AGGREGATION_TIMEOUT_MS || '') || 420_000,
  );

  function aggregationStatus(): AggregationTriggerResult & { lastResult: AggregationTriggerResult | null } {
    const now = Date.now();
    const phase = currentAggregationPhase();
    if (refreshRunning && phase.updatedAt > refreshStartedAt) {
      refreshLastPhase = phase.phase;
    }
    return {
      started: false,
      running: refreshRunning,
      completed: false,
      timedOut: refreshTimedOut || undefined,
      runId: refreshRunId || undefined,
      startedAt: refreshStartedAt ? new Date(refreshStartedAt).toISOString() : undefined,
      phase: refreshLastPhase || undefined,
      elapsedMs: refreshStartedAt ? now - refreshStartedAt : undefined,
      message: refreshRunning
        ? `Aggregation is running${refreshLastPhase ? ` (phase: ${refreshLastPhase})` : ''}`
        : 'Aggregation is idle',
      lastResult: refreshLastResult,
    };
  }

  const runWithGuard = async (): Promise<AggregationTriggerResult> => {
    if (refreshRunning) {
      const runningResult = aggregationStatus();
      console.log(`[aggregation] Already running, skipping (phase: ${refreshLastPhase || 'unknown'})`);
      return {
        started: false,
        running: true,
        completed: false,
        skipped: true,
        timedOut: refreshTimedOut || undefined,
        runId: refreshRunId || undefined,
        startedAt: refreshStartedAt ? new Date(refreshStartedAt).toISOString() : undefined,
        phase: refreshLastPhase || undefined,
        elapsedMs: runningResult.elapsedMs,
        message: 'Aggregation is already running',
      };
    }

    refreshRunning = true;
    refreshTimedOut = false;
    refreshStartedAt = Date.now();
    refreshRunId = new Date(refreshStartedAt).toISOString();
    refreshLastPhase = 'starting';
    const runId = refreshRunId;
    const startedAt = refreshStartedAt;

    const aggregation = runAggregation(storage, config, {
      writeBinary: createJarBinaryWriter(),
    });

    // 后台执行，不阻塞 HTTP 请求；状态接口负责报告真实完成/失败。
    aggregation.then(() => {
      if (refreshRunId !== runId) return;
      refreshRunning = false;
      refreshTimedOut = false;
      refreshLastPhase = 'completed';
      refreshLastResult = {
        started: true,
        running: false,
        completed: true,
        runId,
        startedAt: new Date(startedAt).toISOString(),
        phase: 'completed',
        elapsedMs: Date.now() - startedAt,
        message: 'Refresh completed',
      };
      console.log(`[aggregation] Completed in ${Date.now() - startedAt}ms`);
    }).catch((error: unknown) => {
      if (refreshRunId !== runId) return;
      refreshRunning = false;
      refreshTimedOut = false;
      const msg = error instanceof Error ? error.message : String(error);
      refreshLastResult = {
        started: true,
        running: false,
        completed: false,
        runId,
        startedAt: new Date(startedAt).toISOString(),
        phase: refreshLastPhase || undefined,
        elapsedMs: Date.now() - startedAt,
        message: msg,
      };
      console.error(`[aggregation] Background task failed: ${msg}`);
    });

    const timer = setTimeout(() => {
      if (refreshRunId !== runId || !refreshRunning) return;
      refreshTimedOut = true;
      refreshLastPhase = refreshLastPhase || 'unknown';
      refreshLastResult = {
        started: true,
        running: true,
        completed: false,
        timedOut: true,
        runId,
        startedAt: new Date(startedAt).toISOString(),
        phase: refreshLastPhase || undefined,
        elapsedMs: Date.now() - startedAt,
        message: 'Aggregation is still running after the soft timeout',
      };
      console.error(`[aggregation] Soft timeout after ${aggregationTimeoutMs}ms; still running in background`);
    }, aggregationTimeoutMs);
    aggregation.finally(() => clearTimeout(timer)).catch(() => {});

    return {
      started: true,
      running: true,
      completed: false,
      runId,
      startedAt: new Date(startedAt).toISOString(),
      phase: refreshLastPhase,
      elapsedMs: 0,
      message: 'Refresh started in background',
    };
  };

  let startupChannelProbeStarted = false;
  const startupChannelProbeDelayMs = Math.max(
    0,
    parseInt(process.env.STARTUP_CHANNEL_PROBE_DELAY_MS || '') || 120_000,
  );
  const startupChannelProbeEnabled = process.env.STARTUP_CHANNEL_PROBE_ENABLED !== 'false';

  async function scheduleStartupChannelProbe(): Promise<void> {
    if (!startupChannelProbeEnabled || startupChannelProbeStarted) return;
    startupChannelProbeStarted = true;
    try {
      if (!(await isProbeEnabled(storage))) {
        console.log('[channel-probe] Startup probe skipped: disabled by user');
        return;
      }
      const status = await loadStatus(storage);
      if (status.state === 'running') {
        console.log('[channel-probe] Startup probe skipped: already running');
        return;
      }
      console.log('[channel-probe] Startup probe scheduled in ' + startupChannelProbeDelayMs + 'ms');
      const startProbeWhenIdle = (): void => {
        if (refreshRunning) {
          // Main aggregation may still be running after its timeout. Recheck
          // shortly instead of competing with it for upstream bandwidth.
          setTimeout(startProbeWhenIdle, 30_000);
          return;
        }
        void runChannelProbe(storage).catch((err: unknown) => {
          console.error('[channel-probe] Startup probe failed:', err);
        });
      };
      setTimeout(startProbeWhenIdle, startupChannelProbeDelayMs);
    } catch (err) {
      console.error('[channel-probe] Startup probe scheduling failed:', err);
    }
  }

  let qualityRunning = false;
  async function runQualityWithGuard(requestedMode?: SearchQualityRunMode): Promise<void> {
    if (qualityRunning) {
      console.log('[quality] Already running, skipping');
      return;
    }
    qualityRunning = true;
    try {
      const persisted = await loadQualityStatus(storage);
      const resuming = persisted.state === 'running';
      const fullDue = await shouldRunFullQualityNow(storage, new Date(), config.qualityTimezone);
      const mode: SearchQualityRunMode = requestedMode
        || (resuming && persisted.mode ? persisted.mode : (fullDue ? 'full' : 'candidate'));
      const storedSites = await loadQualityCandidates(storage);
      const allSites = collectSearchableSites(storedSites);
      if (allSites.length === 0) {
        console.log('[quality] No candidate sites; run aggregation first');
        // 不推进计划：候选站点要等一次聚合才会写入，提前推进会让本轮计划
        // 被“空跑”消耗掉，用户要再等一整天。保持到期状态，下个 tick 重试。
        await finishQualityRun(storage, 0, 0, false, mode, config.qualityTimezone);
        return;
      }

      const pool = await loadQualityPool(storage);
      const target = qualityTargetSites(allSites, pool, mode);
      const targetTotal = target.length > 0 ? target.length : allSites.length;
      let cursor = resuming ? Math.max(0, persisted.cursor || 0) : 0;
      if (!resuming) {
        await beginQualityRun(storage, targetTotal, DEFAULT_QUALITY_PROBE_CHUNK_SIZE, mode);
      } else {
        await updateQualityStatus(storage, {
          state: 'running',
          mode,
          total: targetTotal,
          batchSize: DEFAULT_QUALITY_PROBE_CHUNK_SIZE,
          error: undefined,
        });
      }

      let result = await runQualityGradingChunk(
        storage,
        allSites,
        cursor,
        DEFAULT_QUALITY_PROBE_CHUNK_SIZE,
        mode,
        config.qualityTimezone,
      );
      cursor = result.cursor;
      let processed = cursor;
      while (!result.done) {
        await updateQualityStatus(storage, {
          state: 'running',
          mode: result.mode,
          cursor,
          processed,
          total: result.targetTotal,
          batchSize: DEFAULT_QUALITY_PROBE_CHUNK_SIZE,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_QUALITY_PROBE_YIELD_MS));
        result = await runQualityGradingChunk(
          storage,
          allSites,
          cursor,
          DEFAULT_QUALITY_PROBE_CHUNK_SIZE,
          result.mode,
          config.qualityTimezone,
        );
        cursor = result.cursor;
        processed = cursor;
      }

      const finalTotal = result.targetTotal || targetTotal;
      await finishQualityRun(storage, finalTotal, finalTotal, true, result.mode, config.qualityTimezone);
      console.log('[quality] Completed (' + result.mode + '): ' + finalTotal + ' targets');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[quality] Error:', message);
      await updateQualityStatus(storage, { state: 'error', error: message, finishedAt: new Date().toISOString() });
    } finally {
      qualityRunning = false;
    }
  }

  // 动态 cron 管理
  let currentTask: cron.ScheduledTask | null = null;
  let currentSchedule = '';

  function scheduleCron(cronExpr: string) {
    if (currentTask) {
      currentTask.stop();
    }
    currentSchedule = cronExpr;
    currentTask = cron.schedule(cronExpr, () => {
      console.log(`[cron] Triggered at ${new Date().toISOString()}`);
      runWithGuard();
    });
    console.log(`[cron] Scheduled: ${cronExpr}`);
  }

  // 读取 KV 中的间隔设置，否则用环境变量/默认值
  const storedInterval = await storage.get(KV_CRON_INTERVAL);
  let initialSchedule: string;
  let intervalMin: number;

  if (storedInterval) {
    intervalMin = parseInt(storedInterval) || DEFAULT_CRON_INTERVAL;
    initialSchedule = intervalToCron(intervalMin);
  } else {
    initialSchedule = config.cronSchedule || '0 5 * * *';
    intervalMin = DEFAULT_CRON_INTERVAL;
  }

  scheduleCron(initialSchedule);

  // 频道测速独立 cron（每 12 小时，默认关闭）
  cron.schedule(CHANNEL_PROBE_CRON, async () => {
    try {
      if (!(await isProbeEnabled(storage))) return;
      console.log(`[channel-probe-cron] Triggered at ${new Date().toISOString()}`);
      await runChannelProbe(storage);
    } catch (err) {
      console.error('[channel-probe-cron] Error:', err);
    }
  });
  console.log(`[channel-probe-cron] Scheduled: ${CHANNEL_PROBE_CRON} (runs when enabled)`);

  // 搜索源质量分级独立 cron（每分钟检查计划；到期后异步执行）
  // 候选池重排与全量分级分别按各自周期判断，互不阻塞 HTTP 请求。
  cron.schedule('* * * * *', async () => {
    try {
      const candidateDue = await shouldRunQualityNow(storage, new Date(), config.qualityTimezone);
      const fullDue = await shouldRunFullQualityNow(storage, new Date(), config.qualityTimezone);
      if (!candidateDue && !fullDue) return;
      console.log('[quality-cron] Triggered (' + (fullDue ? 'full' : 'candidate') + ') at ' + new Date().toISOString());
      void runQualityWithGuard(fullDue ? 'full' : 'candidate');
    } catch (err) {
      console.error('[quality-cron] Error:', err);
    }
  });
  console.log('[quality-cron] Scheduled: every minute (runs when due)');

  const startupAggregationEnabled = process.env.STARTUP_AGGREGATION_ENABLED !== 'false';
  const startupAggregationDelayMs = Math.max(
    0,
    parseInt(process.env.STARTUP_AGGREGATION_DELAY_MS || '') || 5000,
  );
  const startupAggregationWarmDelayMs = Math.max(
    0,
    parseInt(process.env.STARTUP_AGGREGATION_WARM_DELAY_MS || '') || 600_000,
  );
  const startupAggregationMaxAgeMs = Math.max(
    60_000,
    parseInt(process.env.STARTUP_AGGREGATION_MAX_AGE_MS || '') || 24 * 60 * 60 * 1000,
  );

  async function scheduleStartupAggregation(): Promise<void> {
    if (!startupAggregationEnabled) {
      console.log('[aggregation] Automatic startup aggregation disabled');
      void scheduleStartupChannelProbe();
      return;
    }

    let cachedConfig: string | null = null;
    let lastUpdate: string | null = null;
    try {
      cachedConfig = await storage.get(KV_MERGED_CONFIG);
      lastUpdate = await storage.get(KV_LAST_UPDATE);
    } catch (err) {
      console.warn('[aggregation] Failed to inspect startup cache:', err);
    }

    const parsedLastUpdate = lastUpdate ? Date.parse(lastUpdate) : Number.NaN;
    const cacheAgeMs = Number.isFinite(parsedLastUpdate) ? Date.now() - parsedLastUpdate : null;
    const hasFreshCache = Boolean(cachedConfig)
      && (lastUpdate === null || (cacheAgeMs !== null && cacheAgeMs >= 0 && cacheAgeMs <= startupAggregationMaxAgeMs));
    const delayMs = hasFreshCache ? startupAggregationWarmDelayMs : startupAggregationDelayMs;

    if (hasFreshCache && startupAggregationWarmDelayMs === 0) {
      console.log('[aggregation] Fresh cached config found; skipping automatic startup aggregation');
      void scheduleStartupChannelProbe();
      return;
    }

    if (hasFreshCache) {
      console.log('[aggregation] Fresh cached config found; delaying automatic aggregation by ' + delayMs + 'ms');
    } else if (cachedConfig) {
      console.log('[aggregation] Cached config is stale; scheduling aggregation in ' + delayMs + 'ms');
    } else {
      console.log('[aggregation] No cached config; scheduling initialization in ' + delayMs + 'ms');
    }

    setTimeout(() => {
      console.log('[aggregation] Triggering automatic startup aggregation...');
      void runWithGuard()
        .catch((err: unknown) => { console.error('[aggregation] Startup run failed:', err); })
        .finally(() => { void scheduleStartupChannelProbe(); });
    }, delayMs);
  }

  const app = createApp({
    storage,
    config,
    triggerRefresh: runWithGuard,
    triggerQuality: runQualityWithGuard,
    enableChannelProbe: true,
    enableBuilder: true,
    isSyncing: () => refreshRunning,
    aggregationStatus,
    onCronIntervalChange: (intervalMinutes: number) => {
      const newCron = intervalToCron(intervalMinutes);
      console.log(`[cron] Interval changed to ${intervalLabel(intervalMinutes)} (${newCron})`);
      scheduleCron(newCron);
    },
  });

  let displayHost = 'localhost';
  try {
    const u = new URL(config.localBaseUrl || '');
    displayHost = u.hostname;
  } catch { /* keep localhost */ }

  serve({ fetch: app.fetch, port }, (info) => {
    console.log('');
    console.log('  TVBox Source Aggregator');
    console.log(`  > Local:   http://localhost:${info.port}/`);
    if (displayHost !== 'localhost') {
      console.log(`  > Network: http://${displayHost}:${info.port}/`);
    }
    console.log(`  > Admin:   http://${displayHost}:${info.port}/admin`);
    console.log(`  > Status:  http://${displayHost}:${info.port}/status`);
    console.log(`  > Cron:    ${currentSchedule} (every ${intervalLabel(intervalMin)})`);
    if (config.dockerMissingBaseUrl) {
      console.log('');
      console.log('  ⚠️  检测到 Docker 环境但未配置 BASE_URL');
      console.log(`     当前地址 ${displayHost} 为容器内部 IP，TVBox 客户端可能无法访问`);
      console.log('     请在 .env 或 docker-compose.yml 中设置：BASE_URL=http://宿主机IP:端口');
    }
    console.log('');
    console.log(`  TVBox 填入地址: http://${displayHost}:${info.port}/`);
    console.log('');

    // 先预热已缓存配置中的 JAR，随后再按策略启动聚合；预热不阻塞 HTTP 服务。
    void warmCachedJarBinaries(storage);
    void scheduleStartupAggregation();
  });

  // Render/Docker 滚动重启时给正在执行的聚合一段时间收尾。软超时只用于
  // 可观测性，不再释放单实例锁，避免两个任务并发写同一份配置。
  let shutdownRequested = false;
  const waitForAggregationOnShutdown = async (signal: string): Promise<void> => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    const waitStartedAt = Date.now();
    console.log(`[shutdown] ${signal} received; waiting for active aggregation to finish`);
    while (refreshRunning && Date.now() - waitStartedAt < 15 * 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (refreshRunning) {
      console.error('[shutdown] Aggregation still running after 15 minutes; exiting');
    } else {
      console.log(`[shutdown] Aggregation settled in ${Date.now() - waitStartedAt}ms`);
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => { void waitForAggregationOnShutdown('SIGTERM'); });
  process.once('SIGINT', () => { void waitForAggregationOnShutdown('SIGINT'); });
}

function getLocalIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function isDocker(): boolean {
  try {
    fs.accessSync('/.dockerenv');
    return true;
  } catch {
    try {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      return /docker|containerd/.test(cgroup);
    } catch {
      return false;
    }
  }
}

main();
