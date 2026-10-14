// Cloudflare Worker 入口

import { createApp } from './routes';
import { KVStorage } from './storage/kv';
import { runAggregation } from './aggregator';
import { probeLiveUrlsBounded } from './core/channel-probe';
import { loadLivePrepareState, runLivePrepareChunk } from './core/live-prepare';
import { loadLivePrepareInputs } from './core/live-inputs';
import { repairLiveProxyTextReadiness } from './core/live-source';
import { rebuildLiveOutput } from './core/live-output';
import { DEFAULT_SPEED_TIMEOUT_MS, DEFAULT_SITE_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_SPEED_TEST_CONCURRENCY, DEFAULT_SPEED_TEST_BUDGET_MS, KV_CRON_INTERVAL, KV_CRON_TIME, KV_LAST_UPDATE, KV_AGGREGATION_STATUS, KV_MERGED_CONFIG, DEFAULT_CRON_INTERVAL, DEFAULT_CRON_TIME, normalizeCronTime } from './core/config';
import { currentAggregationPhase } from './core/logger';
import {
  beginQualityRun,
  finishQualityRun,
  loadQualityCandidates,
  collectSearchableSites,
  loadQualityStatus,
  runQualityGradingChunk,
  resolveQualityRunMode,
  updateQualityStatus,
} from './core/quality';
import type { AppConfig, SearchQualityRunMode } from './core/types';
import type { AggregationStatusResult, AggregationTriggerResult } from './routes';

interface CfEnv {
  TVBOX_KV: KVNamespace;
  REFRESH_TOKEN?: string;
  ADMIN_TOKEN?: string;
  SPEED_TIMEOUT_MS?: string;
  SITE_TIMEOUT_MS?: string;
  FETCH_TIMEOUT_MS?: string;
  SPEED_TEST_CONCURRENCY?: string;
  SPEED_TEST_BUDGET_MS?: string;
  WORKER_BASE_URL?: string;
  QUALITY_TIMEZONE?: string;
}

function buildConfig(env: CfEnv): AppConfig {
  return {
    adminToken: env.ADMIN_TOKEN,
    refreshToken: env.REFRESH_TOKEN,
    speedTimeoutMs: parseInt(env.SPEED_TIMEOUT_MS || '') || DEFAULT_SPEED_TIMEOUT_MS,
    siteTimeoutMs: parseInt(env.SITE_TIMEOUT_MS || '') || DEFAULT_SITE_TIMEOUT_MS,
    fetchTimeoutMs: parseInt(env.FETCH_TIMEOUT_MS || '') || DEFAULT_FETCH_TIMEOUT_MS,
    speedTestConcurrency: parseInt(env.SPEED_TEST_CONCURRENCY || '') || DEFAULT_SPEED_TEST_CONCURRENCY,
    speedTestBudgetMs: parseInt(env.SPEED_TEST_BUDGET_MS || '') || DEFAULT_SPEED_TEST_BUDGET_MS,
    workerBaseUrl: env.WORKER_BASE_URL || undefined,
    qualityTimezone: env.QUALITY_TIMEZONE || 'Asia/Shanghai',
  };
}

const QUALITY_CHUNK_SIZE = 40;

function zonedDateTimeParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function localDayOrdinal(parts: { year: number; month: number; day: number }): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
}

function localMinuteOfDay(parts: { hour: number; minute: number }): number {
  return parts.hour * 60 + parts.minute;
}

function cronTimeMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

/**
 * Worker 实例内的实时状态。KV 负责跨实例/冷启动恢复，内存状态负责轮询时
 * 及时展示 phase，避免每次状态查询都读 KV、消耗额度。
 */
const liveAggregationStatus = new Map<string, AggregationTriggerResult>();
const AGGREGATION_STALE_MS = 20 * 60 * 1000;

function aggregationStatusKey(storage: KVStorage): string {
  return KV_AGGREGATION_STATUS;
}

async function writeAggregationStatus(storage: KVStorage, status: AggregationStatusResult): Promise<void> {
  liveAggregationStatus.set(aggregationStatusKey(storage), status);
  try {
    await storage.put(aggregationStatusKey(storage), JSON.stringify(status));
  } catch (error) {
    // 状态落盘是诊断能力，不能反过来阻断聚合本身。
    console.warn('[aggregation] Failed to persist status:', error instanceof Error ? error.message : String(error));
  }
}

async function readAggregationStatus(storage: KVStorage): Promise<AggregationStatusResult> {
  const inMemory = liveAggregationStatus.get(aggregationStatusKey(storage));
  if (inMemory) {
    const startedAt = inMemory.startedAt ? Date.parse(inMemory.startedAt) : Number.NaN;
    if (inMemory.running && Number.isFinite(startedAt)) {
      inMemory.elapsedMs = Math.max(0, Date.now() - startedAt);
    }
    const phase = inMemory.running ? currentAggregationPhase() : null;
    if (phase && phase.updatedAt > startedAt && phase.phase !== inMemory.phase) {
      inMemory.phase = phase.phase;
      inMemory.message = `Aggregation is running (phase: ${phase.phase})`;
    }
    if (inMemory.running) {
      liveAggregationStatus.set(aggregationStatusKey(storage), inMemory);
    }
    return { ...inMemory };
  }

  try {
    const raw = await storage.get(aggregationStatusKey(storage));
    if (!raw) {
      return {
        started: false,
        running: false,
        completed: false,
        message: 'Aggregation status is unavailable',
        lastResult: null,
      };
    }
    const persisted = JSON.parse(raw) as AggregationStatusResult;
    return persisted;
  } catch (error) {
    console.warn('[aggregation] Failed to read status:', error instanceof Error ? error.message : String(error));
    return {
      started: false,
      running: false,
      completed: false,
      message: 'Aggregation status is unavailable',
      lastResult: null,
    };
  }
}

async function runAggregationTracked(
  storage: KVStorage,
  config: AppConfig,
  ctx: ExecutionContext,
  onStart?: (result: AggregationTriggerResult) => void,
): Promise<void> {
  const previous = await readAggregationStatus(storage);
  const previousStartedAt = previous.startedAt ? Date.parse(previous.startedAt) : Number.NaN;
  const previousAgeMs = Number.isFinite(previousStartedAt) ? Date.now() - previousStartedAt : Number.POSITIVE_INFINITY;
  if (previous.running && previousAgeMs >= 0 && previousAgeMs < AGGREGATION_STALE_MS) {
    const skipped: AggregationTriggerResult = {
      started: false,
      running: true,
      completed: false,
      skipped: true,
      runId: previous.runId,
      startedAt: previous.startedAt,
      phase: previous.phase,
      elapsedMs: previousAgeMs,
      message: 'Aggregation is already running',
    };
    console.log('[aggregation] Already running, skipping duplicate start');
    onStart?.(skipped);
    return;
  }

  const runId = new Date().toISOString();
  const startedAt = new Date().toISOString();
  const runningStatus: AggregationTriggerResult = {
    started: true,
    running: true,
    completed: false,
    runId,
    startedAt,
    phase: 'starting',
    elapsedMs: 0,
    message: 'Aggregation is running (phase: starting)',
  };
  if (previous.running) {
    const stale: AggregationTriggerResult = {
      started: true,
      running: false,
      completed: false,
      timedOut: true,
      runId: previous.runId,
      startedAt: previous.startedAt,
      phase: previous.phase,
      elapsedMs: previousAgeMs,
      message: 'Previous aggregation exceeded the stale-run threshold; retrying',
    };
    await writeAggregationStatus(storage, { ...stale, lastResult: stale });
    console.warn('[aggregation] Recovered stale running status; starting a new run');
  }
  await writeAggregationStatus(storage, runningStatus);
  onStart?.(runningStatus);

  try {
    await runAggregation(storage, config, {
      waitUntil: (task) => ctx.waitUntil(task),
    });
    const completed: AggregationTriggerResult = {
      started: true,
      running: false,
      completed: true,
      runId,
      startedAt,
      phase: 'completed',
      elapsedMs: Date.now() - Date.parse(startedAt),
      message: 'Refresh completed',
    };
    await writeAggregationStatus(storage, { ...completed, lastResult: completed });
    console.log(`[aggregation] Completed in ${completed.elapsedMs}ms`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: AggregationTriggerResult = {
      started: true,
      running: false,
      completed: false,
      runId,
      startedAt,
      phase: currentAggregationPhase().phase || 'failed',
      elapsedMs: Date.now() - Date.parse(startedAt),
      message,
    };
    await writeAggregationStatus(storage, { ...failed, lastResult: failed });
    console.error(`[aggregation] Background task failed: ${message}`);
  }
}

/** CF 单次执行一个分片；到期时自动开始新的一轮，running 时继续游标。 */
async function runQualityChunkWithStatus(storage: KVStorage, requestedMode?: SearchQualityRunMode, timezone = 'Asia/Shanghai'): Promise<void> {
  let status = await loadQualityStatus(storage);
  const dueMode = await resolveQualityRunMode(storage, new Date(), timezone);
  const storedSites = await loadQualityCandidates(storage);
  const sites = collectSearchableSites(storedSites);
  if (sites.length === 0) {
    console.log('[quality] No candidate sites; run aggregation first');
    // 不推进计划：候选站点要等一次聚合才会写入，提前推进会让本轮计划
    // 被“空跑”消耗掉，用户要再等一整天。保持到期状态，下个 tick 重试。
    await finishQualityRun(storage, 0, 0, false, 'candidate', timezone);
    return;
  }
  const resuming = status.state === 'running';
  if (!resuming && !requestedMode && !dueMode) return;
  const mode: SearchQualityRunMode = requestedMode
    || (resuming && status.mode ? status.mode : (dueMode || 'candidate'));
  const cursor = resuming ? (status.cursor || 0) : 0;
  if (!resuming) {
    // 新的一轮：重置游标和进度后再取回状态，避免沿用上一轮的 processed
    // 把“刚开始”误报成“已接近完成”。
    status = await beginQualityRun(storage, sites.length, QUALITY_CHUNK_SIZE, mode);
  }
  await updateQualityStatus(storage, { state: 'running', mode, cursor, batchSize: QUALITY_CHUNK_SIZE });
  let globalSpider: string | undefined;
  const mergedConfigRaw = await storage.get(KV_MERGED_CONFIG);
  if (mergedConfigRaw) {
    try {
      const mergedConfig = JSON.parse(mergedConfigRaw) as { spider?: unknown };
      if (typeof mergedConfig.spider === 'string') globalSpider = mergedConfig.spider;
    } catch { /* keep undefined */ }
  }
  const result = await runQualityGradingChunk(storage, sites, cursor, QUALITY_CHUNK_SIZE, mode, timezone, globalSpider);
  const targetTotal = result.targetTotal || sites.length;
  const processed = result.done ? targetTotal : Math.max(status.processed || 0, result.cursor);
  if (result.done) {
    await finishQualityRun(storage, processed, targetTotal, false, result.mode, timezone);
    console.log('[quality] Completed (' + result.mode + '): ' + processed + '/' + targetTotal);
  } else {
    await updateQualityStatus(storage, { state: 'running', mode: result.mode, cursor: result.cursor, processed, total: targetTotal, batchSize: QUALITY_CHUNK_SIZE });
    console.log('[quality] Chunk done (' + result.mode + '): ' + result.cursor + '/' + targetTotal);
  }
}
export default {
  async fetch(request: Request, env: CfEnv, ctx: ExecutionContext): Promise<Response> {
    const storage = new KVStorage(env.TVBOX_KV);
    const config = buildConfig(env);

    const app = createApp({
      // 启动握手：返回值只代表运行状态已落盘；真实聚合任务单独交给 waitUntil 保活。
      triggerRefresh: () => {
        let resolveStart!: (result: AggregationTriggerResult) => void;
        let startSettled = false;
        const startSignal = new Promise<AggregationTriggerResult>((resolve) => {
          resolveStart = resolve;
        });
        const settleStart = (result: AggregationTriggerResult) => {
          if (startSettled) return;
          startSettled = true;
          resolveStart(result);
        };
        const task = runAggregationTracked(storage, config, ctx, settleStart)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            settleStart({ started: false, running: false, completed: false, message });
            console.error('[aggregation] Startup task failed:' , message);
          });
        ctx.waitUntil(task);
        return startSignal;
      },
      storage,
      config,
      triggerLivePrepare: () => runLivePrepareChunk(storage, {
        batchSize: 8,
        timeoutMs: 6000,
        concurrency: 3,
      }),
      triggerQuality: (mode) => runQualityChunkWithStatus(storage, mode, config.qualityTimezone),
      isSyncing: () => liveAggregationStatus.get(aggregationStatusKey(storage))?.running === true,
      aggregationStatus: () => readAggregationStatus(storage),
    });

    return app.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: CfEnv, ctx: ExecutionContext): Promise<void> {
    const storage = new KVStorage(env.TVBOX_KV);
    const config = buildConfig(env);

    // 聚合优先：先判断聚合是否到期，避免质量分片长期占用 cron 而饿死聚合。
    const [intervalRaw, cronTimeRaw, lastUpdateRaw] = await Promise.all([
      storage.get(KV_CRON_INTERVAL),
      storage.get(KV_CRON_TIME),
      storage.get(KV_LAST_UPDATE),
    ]);
    const intervalMinutes = intervalRaw ? parseInt(intervalRaw) : DEFAULT_CRON_INTERVAL;
    // cron_time 为空时保持默认每日时刻；CF 的 cron 仍为每小时检查。
    const cronTime = normalizeCronTime(cronTimeRaw || DEFAULT_CRON_TIME);
    let aggregationDue = true;
    const now = new Date();
    if (intervalMinutes === 1440) {
      // CF 的 cron 表达式在部署时固定为每小时一次；这里按本地时刻判断，
      // 到点后的首个整点执行。Render 则使用精确 HH:MM。
      const timezone = config.qualityTimezone || 'Asia/Shanghai';
      const nowParts = zonedDateTimeParts(now, timezone);
      const scheduledMinute = cronTimeMinutes(cronTime);
      const nowMinute = localMinuteOfDay(nowParts);
      const nowDay = localDayOrdinal(nowParts);
      // Use the most recent due boundary. Before today's time, it is yesterday's boundary,
      // so a late schedule such as 23:30 runs at the first hourly tick after midnight.
      const dueBoundaryDay = nowMinute >= scheduledMinute ? nowDay : nowDay - 1;
      let alreadyRanAfterDueBoundary = false;
      if (lastUpdateRaw) {
        const lastUpdate = Date.parse(lastUpdateRaw);
        if (Number.isFinite(lastUpdate)) {
          const lastParts = zonedDateTimeParts(new Date(lastUpdate), timezone);
          const lastDay = localDayOrdinal(lastParts);
          const lastMinute = localMinuteOfDay(lastParts);
          alreadyRanAfterDueBoundary = lastDay > dueBoundaryDay
            || (lastDay === dueBoundaryDay && lastMinute >= scheduledMinute);
        }
      }
      aggregationDue = !alreadyRanAfterDueBoundary;
      if (!aggregationDue) {
        console.log('[scheduled] Daily aggregation not due: local ' + String(nowParts.hour).padStart(2, '0') + ':' + String(nowParts.minute).padStart(2, '0') + ', scheduled ' + cronTime);
      }
    } else if (lastUpdateRaw) {
      const lastUpdate = Date.parse(lastUpdateRaw);
      const elapsed = now.getTime() - lastUpdate;
      const intervalMs = intervalMinutes * 60 * 1000;
      aggregationDue = !(Number.isFinite(lastUpdate) && elapsed >= 0 && elapsed < intervalMs);
      if (!aggregationDue) {
        console.log('[scheduled] Aggregation not due: ' + Math.round(elapsed / 60000) + 'min since last update, interval is ' + intervalMinutes + 'min');
      }
    }

    if (aggregationDue) {
      console.log('[scheduled] Running aggregation (interval: ' + intervalMinutes + 'min)');
      ctx.waitUntil(runAggregationTracked(storage, config, ctx));
      return;
    }

    // 聚合未到期时，优先级：直播正文准备 > 搜索质量分级 > 少量直播测速。
    // 未完成正文预构建的直播入口绝不下发，因此必须先补齐直播分片。
    // 同时核对输入签名：新聚合可能已持久化新输入，但旧 prepare state 仍是
    // complete=true；若不识别签名变化，新直播源会被永久跳过。
    const livePrepareState = await loadLivePrepareState(storage);
    const livePrepareInputs = await loadLivePrepareInputs(storage);
    const livePrepareSignatureMatches = !!livePrepareState
      && livePrepareState.sourceSignature === (livePrepareInputs?.signature || '');
    const livePrepareActive = !!livePrepareInputs
      && livePrepareInputs.sources.length > 0
      && (livePrepareState?.complete !== true || !livePrepareSignatureMatches);
    const qualityStatus = await loadQualityStatus(storage);
    const qualityDueMode = await resolveQualityRunMode(storage, new Date(), config.qualityTimezone);
    const qualityDue = qualityDueMode !== null;
    const qualityActive = qualityDue || qualityStatus.state === 'running';

    ctx.waitUntil(
      (async () => {
        // 1) 无网络修复：升级前已落盘 live_txt 但清单缺少 textReady 的入口。
        // 该步骤只读正文，不回源，不占用子请求预算。
        const repaired = await repairLiveProxyTextReadiness(storage);
        if (repaired.changed) {
          await rebuildLiveOutput(storage, { reason: "readiness-repair" });
          console.log("[scheduled] Live text readiness repaired: " + repaired.repaired + " restored, " + repaired.revoked + " revoked");
        }

        if (livePrepareActive) {
          console.log("[scheduled] Running live prepare chunk (cursor=" + (livePrepareState?.cursor ?? 0) + "/" + (livePrepareState?.total ?? 0) + ")");
          const prepareResult = await runLivePrepareChunk(storage, {
            batchSize: 8,
            timeoutMs: 6000,
            concurrency: 3,
          });
          console.log("[scheduled] Live prepare chunk done: " + prepareResult.state.cursor + "/" + prepareResult.state.total);
          // prepare 与本轮小批探测叠加，不再直接 return，避免长期只有下载没有迭代验证。
          await probeLiveUrlsBounded(storage, {
            maxUrls: 16,
            timeoutMs: 3000,
            concurrency: 4,
            budgetMs: 12000,
          });
          return;
        }
        if (qualityActive) {
          console.log("[scheduled] Running search quality chunk (due=" + qualityDue + ", state=" + qualityStatus.state + ")");
          await runQualityChunkWithStatus(storage, undefined, config.qualityTimezone);
        }
        // 免费 Worker：前沿优先，一次最多 56 条；失败线路仅在重试到期后参与。
        await probeLiveUrlsBounded(storage, {
          maxUrls: 56,
          timeoutMs: 3000,
          concurrency: 5,
          budgetMs: 25000,
        });
      })().catch((err) => {
        console.warn("[scheduled] Non-aggregation tick failed:", err instanceof Error ? err.message : String(err));
      }),
    );
  },
};
