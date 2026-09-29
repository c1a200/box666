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
  loadQualityStatus,
  runQualityGradingChunk,
  shouldRunQualityNow,
  updateQualityStatus,
} from './core/quality';
import type { AppConfig } from './core/types';

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
    bilibiliQrProxyBaseUrl: env.BILIBILI_QR_PROXY_BASE_URL || undefined,
    bilibiliQrProxyToken: env.BILIBILI_QR_PROXY_TOKEN || undefined,
  };
}

const QUALITY_CHUNK_SIZE = 40;

/** CF 单次执行一个分片；到期时自动开始新的一轮，running 时继续游标。 */
async function runQualityChunkWithStatus(storage: KVStorage): Promise<void> {
  const status = await loadQualityStatus(storage);
  const due = await shouldRunQualityNow(storage);
  const sites = await loadQualityCandidates(storage);
  if (sites.length === 0) {
    console.log('[quality] No candidate sites; run aggregation first');
    // 无候选也必须推进计划，否则每个 cron tick 都会重复进入空任务。
    await finishQualityRun(storage, 0, 0, true);
    return;
  }
  const resuming = status.state === 'running';
  if (!resuming && !due) return;
  const cursor = resuming ? (status.cursor || 0) : 0;
  if (!resuming) await beginQualityRun(storage, sites.length, QUALITY_CHUNK_SIZE);
  await updateQualityStatus(storage, { state: 'running', total: sites.length, cursor, batchSize: QUALITY_CHUNK_SIZE });
  const result = await runQualityGradingChunk(storage, sites, cursor, QUALITY_CHUNK_SIZE);
  const processed = Math.max(status.processed || 0, result.cursor);
  if (result.done) {
    await finishQualityRun(storage, processed, sites.length, false);
    console.log('[quality] Completed: ' + processed + '/' + sites.length);
  } else {
    await updateQualityStatus(storage, { state: 'running', cursor: result.cursor, processed, total: sites.length, batchSize: QUALITY_CHUNK_SIZE });
    console.log('[quality] Chunk done: ' + result.cursor + '/' + sites.length);
  }
}
export default {
  async fetch(request: Request, env: CfEnv, ctx: ExecutionContext): Promise<Response> {
    const storage = new KVStorage(env.TVBOX_KV);
    const config = buildConfig(env);

    const app = createApp({
      storage,
      config,
      triggerRefresh: () => runAggregation(storage, config),
      triggerQuality: () => runQualityChunkWithStatus(storage),
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
    if (lastUpdateRaw && !lastUpdateRaw.startsWith('ERROR')) {
      const lastUpdate = new Date(lastUpdateRaw).getTime();
      const elapsed = Date.now() - lastUpdate;
      const intervalMs = intervalMinutes * 60 * 1000;
      aggregationDue = !(Number.isFinite(lastUpdate) && elapsed < intervalMs);
      if (!aggregationDue) {
        console.log('[scheduled] Aggregation not due: ' + Math.round(elapsed / 60000) + 'min since last update, interval is ' + intervalMinutes + 'min');
      }
    }

    if (aggregationDue) {
      console.log('[scheduled] Running aggregation (interval: ' + intervalMinutes + 'min)');
      ctx.waitUntil(runAggregation(storage, config));
      return;
    }

    // 聚合未到期时：到期或未完成的质量分级每次只跑一个分片，
    // 剩余时间用于少量直播测速，避免超过 Worker 时长限制。
    const qualityStatus = await loadQualityStatus(storage);
    const qualityDue = await shouldRunQualityNow(storage);
    const qualityActive = qualityDue || qualityStatus.state === 'running';

    ctx.waitUntil(
      (async () => {
        if (qualityActive) {
          console.log('[scheduled] Running search quality chunk (due=' + qualityDue + ', state=' + qualityStatus.state + ')');
          await runQualityChunkWithStatus(storage);
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