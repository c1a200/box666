// Cloudflare Worker 入口

import { createApp } from './routes';
import { KVStorage } from './storage/kv';
import { runAggregation } from './aggregator';
import { probeLiveUrlsBounded } from './core/channel-probe';
import { DEFAULT_SPEED_TIMEOUT_MS, DEFAULT_SITE_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_SPEED_TEST_CONCURRENCY, DEFAULT_SPEED_TEST_BUDGET_MS, KV_CRON_INTERVAL, KV_LAST_UPDATE, DEFAULT_CRON_INTERVAL } from './core/config';
import {
  beginQualityRun,
  finishQualityRun,
  loadQualityCandidates,
  collectSearchableSites,
  loadQualityStatus,
  runQualityGradingChunk,
  shouldRunQualityNow,
  shouldRunFullQualityNow,
  updateQualityStatus,
} from './core/quality';
import type { AppConfig, SearchQualityRunMode } from './core/types';

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
  BILIBILI_QR_PROXY_BASE_URL?: string;
  BILIBILI_QR_PROXY_TOKEN?: string;
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
    bilibiliQrProxyBaseUrl: env.BILIBILI_QR_PROXY_BASE_URL || undefined,
    bilibiliQrProxyToken: env.BILIBILI_QR_PROXY_TOKEN || undefined,
  };
}

const QUALITY_CHUNK_SIZE = 40;

/** CF 单次执行一个分片；到期时自动开始新的一轮，running 时继续游标。 */
async function runQualityChunkWithStatus(storage: KVStorage, requestedMode?: SearchQualityRunMode, timezone = 'Asia/Shanghai'): Promise<void> {
  let status = await loadQualityStatus(storage);
  const fullDue = await shouldRunFullQualityNow(storage, new Date(), timezone);
  const candidateDue = await shouldRunQualityNow(storage, new Date(), timezone);
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
  if (!resuming && !requestedMode && !fullDue && !candidateDue) return;
  const mode: SearchQualityRunMode = requestedMode
    || (resuming && status.mode ? status.mode : (fullDue ? 'full' : 'candidate'));
  const cursor = resuming ? (status.cursor || 0) : 0;
  if (!resuming) {
    // 新的一轮：重置游标和进度后再取回状态，避免沿用上一轮的 processed
    // 把“刚开始”误报成“已接近完成”。
    status = await beginQualityRun(storage, sites.length, QUALITY_CHUNK_SIZE, mode);
  }
  await updateQualityStatus(storage, { state: 'running', mode, cursor, batchSize: QUALITY_CHUNK_SIZE });
  const result = await runQualityGradingChunk(storage, sites, cursor, QUALITY_CHUNK_SIZE, mode, timezone);
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
      storage,
      config,
      triggerRefresh: () => runAggregation(storage, config, {
        waitUntil: (task) => ctx.waitUntil(task),
      }),
      triggerQuality: (mode) => runQualityChunkWithStatus(storage, mode, config.qualityTimezone),
    });

    return app.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: CfEnv, ctx: ExecutionContext): Promise<void> {
    const storage = new KVStorage(env.TVBOX_KV);
    const config = buildConfig(env);

    // 聚合优先：先判断聚合是否到期，避免质量分片长期占用 cron 而饿死聚合。
    const intervalRaw = await storage.get(KV_CRON_INTERVAL);
    const intervalMinutes = intervalRaw ? parseInt(intervalRaw) : DEFAULT_CRON_INTERVAL;
    const lastUpdateRaw = await storage.get(KV_LAST_UPDATE);
    let aggregationDue = true;
    if (lastUpdateRaw) {
      const lastUpdate = Date.parse(lastUpdateRaw);
      const elapsed = Date.now() - lastUpdate;
      const intervalMs = intervalMinutes * 60 * 1000;
      aggregationDue = !(Number.isFinite(lastUpdate) && elapsed >= 0 && elapsed < intervalMs);
      if (!aggregationDue) {
        console.log('[scheduled] Aggregation not due: ' + Math.round(elapsed / 60000) + 'min since last update, interval is ' + intervalMinutes + 'min');
      }
    }

    if (aggregationDue) {
      console.log('[scheduled] Running aggregation (interval: ' + intervalMinutes + 'min)');
      ctx.waitUntil(runAggregation(storage, config, {
        waitUntil: (task) => ctx.waitUntil(task),
      }));
      return;
    }

    // 聚合未到期时：到期或未完成的质量分级每次只跑一个分片，
    // 剩余时间用于少量直播测速，避免超过 Worker 时长限制。
    const qualityStatus = await loadQualityStatus(storage);
    const candidateDue = await shouldRunQualityNow(storage, new Date(), config.qualityTimezone);
    const fullDue = await shouldRunFullQualityNow(storage, new Date(), config.qualityTimezone);
    const qualityDue = candidateDue || fullDue;
    const qualityActive = qualityDue || qualityStatus.state === 'running';

    ctx.waitUntil(
      (async () => {
        if (qualityActive) {
          console.log('[scheduled] Running search quality chunk (due=' + qualityDue + ', state=' + qualityStatus.state + ')');
          await runQualityChunkWithStatus(storage, undefined, config.qualityTimezone);
        }
        // 免费 Worker：非聚合周期只做一小批直播测速。
        await probeLiveUrlsBounded(storage, {
          maxUrls: 28,
          timeoutMs: 3000,
          concurrency: 5,
          budgetMs: 25000,
        });
      })().catch((err) => {
        console.warn('[scheduled] Non-aggregation tick failed:', err instanceof Error ? err.message : String(err));
      }),
    );
  },
};