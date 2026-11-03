// 频道测速 admin 路由（方案 D+ 运维独立模块）

import type { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, ChannelProbeSchedule, ChannelProbeTrigger } from '../core/types';
import {
  isProbeEnabled,
  setProbeEnabled,
  loadStatus,
  runChannelProbe,
  isRunning,
} from '../core/channel-probe';
import {
  MAX_CHANNEL_PROBE_REPEAT_DAYS,
  MAX_CHANNEL_PROBE_TIMES,
} from '../core/config';
import {
  loadChannelProbeSchedule,
  normalizeChannelProbeRepeatDays,
  normalizeChannelProbeTime,
  normalizeChannelProbeTimes,
  saveChannelProbeSchedule,
} from '../core/channel-probe-schedule';
import { loadPublishedSpeedSnapshotSummary } from '../core/live-speed-store';

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${token}`;
}

export interface ChannelProbeRouteDeps {
  storage: Storage;
  config: AppConfig;
  triggerChannelProbe?: (
    trigger?: ChannelProbeTrigger,
  ) => Promise<void>;
  onChannelProbeScheduleChange?: (schedule: ChannelProbeSchedule) => void;
  getChannelProbeInitialTime?: () => string;
}

export function mountChannelProbeRoutes(app: Hono, deps: ChannelProbeRouteDeps): void {
  const {
    storage,
    config,
    triggerChannelProbe,
    onChannelProbeScheduleChange,
    getChannelProbeInitialTime,
  } = deps;
  const timezone = config.qualityTimezone || 'Asia/Shanghai';
  const initialTime = () => getChannelProbeInitialTime?.() || '05:00';

  // GET /admin/channel-probe/status — 查询状态 + 开关
  app.get('/admin/channel-probe/status', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const [enabled, status, schedule, snapshot] = await Promise.all([
      isProbeEnabled(storage),
      loadStatus(storage),
      loadChannelProbeSchedule(storage, timezone, initialTime()),
      loadPublishedSpeedSnapshotSummary(storage),
    ]);
    return c.json({
      enabled,
      running: isRunning(),
      // Kept for clients that still understand the previous daily-only API.
      intervalMinutes: 1440,
      schedule,
      evaluationMode: status.evaluationMode ?? null,
      publishedAt: snapshot?.publishedAt ?? status.publishedAt ?? null,
      lastFullPublishedAt: snapshot?.lastFullPublishedAt ?? status.lastFullPublishedAt ?? null,
      snapshotUrls: snapshot?.urls ?? status.snapshotUrls ?? 0,
      snapshotVersion: snapshot?.version ?? status.snapshotVersion ?? null,
      publishedInThisRun: status.publishedInThisRun === true,
      snapshot,
      status,
    });
  });

  // PUT /admin/channel-probe/toggle — 开关
  app.put('/admin/channel-probe/toggle', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { enabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    await setProbeEnabled(storage, body.enabled);
    return c.json({ success: true, enabled: body.enabled });
  });

  // PUT /admin/channel-probe/schedule — 全量评估周期与多个执行时刻
  app.put('/admin/channel-probe/schedule', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { times?: unknown; repeatDays?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (!Array.isArray(body.times)
      || body.times.length === 0
      || body.times.length > MAX_CHANNEL_PROBE_TIMES
      || body.times.some((time) => normalizeChannelProbeTime(time) === null)) {
      return c.json({
        error: `times must contain 1-${MAX_CHANNEL_PROBE_TIMES} valid HH:MM values`,
      }, 400);
    }
    const repeatDays = typeof body.repeatDays === 'number'
      ? body.repeatDays
      : parseInt(String(body.repeatDays ?? ''), 10);
    if (!Number.isFinite(repeatDays)
      || repeatDays < 1
      || repeatDays > MAX_CHANNEL_PROBE_REPEAT_DAYS
      || normalizeChannelProbeRepeatDays(repeatDays) !== repeatDays) {
      return c.json({
        error: `repeatDays must be an integer from 1 to ${MAX_CHANNEL_PROBE_REPEAT_DAYS}`,
      }, 400);
    }

    const schedule = await saveChannelProbeSchedule(storage, {
      times: normalizeChannelProbeTimes(body.times, []),
      repeatDays,
    }, timezone, initialTime());
    if (onChannelProbeScheduleChange) onChannelProbeScheduleChange(schedule);
    return c.json({ success: true, schedule });
  });

  // Compatibility for an admin page cached from the daily-only version.
  app.put('/admin/channel-probe/interval', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { intervalMinutes?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (Number(body.intervalMinutes) !== 1440) {
      return c.json({ error: 'intervalMinutes must be: 1440; use /admin/channel-probe/schedule' }, 400);
    }
    const current = await loadChannelProbeSchedule(storage, timezone, initialTime());
    const schedule = await saveChannelProbeSchedule(storage, {
      times: current.times,
      repeatDays: 1,
    }, timezone, initialTime());
    if (onChannelProbeScheduleChange) onChannelProbeScheduleChange(schedule);
    return c.json({ success: true, intervalMinutes: 1440, schedule });
  });

  // POST /admin/channel-probe/trigger — 手动增量补检（异步启动，不阻塞响应）
  app.post('/admin/channel-probe/trigger', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await isProbeEnabled(storage))) {
      return c.json({ success: false, error: 'Probe is disabled, enable it first' }, 400);
    }
    // A full evaluation already covers every candidate. Do not queue an
    // incremental pass behind it; the shared scheduler also absorbs duplicates.
    if (isRunning()) {
      return c.json({ success: false, running: true, error: 'Probe is already running' }, 409);
    }
    if (triggerChannelProbe) {
      void triggerChannelProbe('manual').catch((err) => {
        console.error('[channel-probe-admin] Trigger error:', err);
      });
    } else {
      void runChannelProbe(storage, { trigger: 'manual' }).catch((err) => {
        console.error('[channel-probe-admin] Trigger error:', err);
      });
    }
    return c.json({
      success: true,
      running: isRunning(),
      message: isRunning() ? 'Probe queued' : 'Probe started',
    });
  });
}
