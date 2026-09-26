import { TVBOX_UA, DEFAULT_SPEED_TEST_CONCURRENCY, DEFAULT_SPEED_TEST_BUDGET_MS } from './config';
import { logger } from './logger';
import type { TVBoxSite } from './types';

export type ProbeResult = 'ok' | 'empty' | 'error' | 'timeout';

export interface SiteProbeResult {
  key: string;
  speedMs: number | null;
  result: ProbeResult;
}

async function siteProbe(url: string, siteType: number, timeoutMs: number, deep: boolean): Promise<{ speedMs: number | null; result: ProbeResult }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const start = Date.now();
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': TVBOX_UA },
    });
    const speedMs = Date.now() - start;

    if (!resp.ok) return { speedMs: null, result: 'error' };

    const body = await resp.text();

    if (!deep) {
      return { speedMs, result: body.length > 0 ? 'ok' : 'empty' };
    }

    const valid = validateResponseContent(siteType, body);
    return { speedMs, result: valid ? 'ok' : 'empty' };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { speedMs: null, result: 'timeout' };
    }
    return { speedMs: null, result: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

async function siteProbeWithRetry(
  url: string,
  siteType: number,
  timeoutMs: number,
  deep: boolean,
  deadline: number,
  retries = 1,
): Promise<{ speedMs: number | null; result: ProbeResult }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { speedMs: null, result: 'timeout' };

    const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);
    const result = await siteProbe(url, siteType, attemptTimeoutMs, deep);
    if (result.result !== 'timeout' && result.result !== 'error') return result;
    if (attempt === retries || Date.now() >= deadline) return result;

    const waitMs = Math.min(500, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  }
  return { speedMs: null, result: 'error' };
}

function validateResponseContent(siteType: number, body: string): boolean {
  if (!body || body.length < 10) return false;

  if (siteType === 1) {
    try {
      const json = JSON.parse(body);
      if (Array.isArray(json.list) && json.list.length > 0) return true;
      if (Array.isArray(json.class) && json.class.length > 0) return true;
      return false;
    } catch {
      return false;
    }
  }

  if (siteType === 0) {
    if (body.includes('<list>') || body.includes('<video>') || body.includes('<class>')) return true;
    try {
      const json = JSON.parse(body);
      if (Array.isArray(json.list) && json.list.length > 0) return true;
      if (Array.isArray(json.class) && json.class.length > 0) return true;
      return false;
    } catch {
      return false;
    }
  }

  return body.length > 0;
}

export async function batchSiteSpeedTest(
  sites: TVBoxSite[],
  timeoutMs: number,
  deep = false,
  concurrency: number = DEFAULT_SPEED_TEST_CONCURRENCY,
  budgetMs: number = DEFAULT_SPEED_TEST_BUDGET_MS,
): Promise<Map<string, SiteProbeResult>> {
  const tasks: Array<{ key: string; url: string; type: number }> = [];

  for (const site of sites) {
    const url = getTestableUrl(site);
    if (url) {
      tasks.push({ key: site.key, url, type: site.type });
    }
  }

  if (tasks.length === 0) return new Map();

  logger.infoFields('speedtest', 'batch-start', { sites: tasks.length, deep, concurrency });

  const probeMap = new Map<string, SiteProbeResult>();
  const deadline = Date.now() + budgetMs;
  let cursor = 0;
  let active = 0;
  let budgetExhausted = false;
  let updateCounter = 0;

  await new Promise<void>((resolve) => {
    let settled = false;
    let hardStopTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (hardStopTimer) clearTimeout(hardStopTimer);
      resolve();
    };

    function scheduleNext() {
      if (settled) return;
      while (active < concurrency && cursor < tasks.length) {
        if (Date.now() >= deadline) {
          budgetExhausted = true;
          break;
        }

        const task = tasks[cursor++];
        active++;
        updateCounter++;

        siteProbeWithRetry(task.url, task.type, timeoutMs, deep, deadline).then((probe) => {
          if (settled) return;
          probeMap.set(task.key, { key: task.key, ...probe });
          active--;

          if (updateCounter % 100 === 0) {
            logger.infoFields('speedtest', 'progress', { completed: probeMap.size, total: tasks.length });
          }

          scheduleNext();
        });
      }

      if (active === 0) finish();
    }

    // 硬预算：即使个别探测未及时返回，也不让整个聚合无限等待。
    hardStopTimer = setTimeout(() => {
      budgetExhausted = true;
      finish();
    }, Math.max(1000, deadline - Date.now() + 1000));

    scheduleNext();
  });

  if (budgetExhausted) {
    let completed = 0;
    let marked = 0;
    for (const task of tasks) {
      if (probeMap.has(task.key)) {
        completed++;
      } else {
        probeMap.set(task.key, { key: task.key, speedMs: null, result: 'timeout' });
        marked++;
      }
    }
    logger.warnFields('speedtest', 'budget-exhausted', { completed, timeout: marked, total: tasks.length });
  }

  const ok = [...probeMap.values()].filter(v => v.result === 'ok').length;
  const empty = [...probeMap.values()].filter(v => v.result === 'empty').length;
  const timedOut = [...probeMap.values()].filter(v => v.result === 'timeout').length;
  logger.infoFields('speedtest', 'batch-done', { ok, empty, timeout: timedOut, error: probeMap.size - ok - empty - timedOut, total: probeMap.size });

  return probeMap;
}

export function appendSpeedToName(sites: TVBoxSite[], speedMap: Map<string, SiteProbeResult>): TVBoxSite[] {
  return sites.map((site) => {
    const probe = speedMap.get(site.key);
    if (!probe || probe.speedMs == null) return site;
    const seconds = (probe.speedMs / 1000).toFixed(1);
    return { ...site, name: `${site.name || site.key} [${seconds}s]` };
  });
}

export function filterUnreachableSites(
  sites: TVBoxSite[],
  speedMap: Map<string, SiteProbeResult>,
): { sites: TVBoxSite[]; filtered: number } {
  const totalTestable = speedMap.size;
  if (totalTestable === 0) return { sites, filtered: 0 };

  const reachable: TVBoxSite[] = [];
  const unreachable: TVBoxSite[] = [];

  for (const site of sites) {
    const probe = speedMap.get(site.key);
    if (!probe) {
      reachable.push(site);
    } else if (probe.result === 'ok') {
      reachable.push(site);
    } else {
      unreachable.push(site);
    }
  }

  const reachableTestable = reachable.filter(s => speedMap.has(s.key)).length;
  if (totalTestable > 0 && reachableTestable / totalTestable < 0.1) {
    logger.warn('speedtest', `Safety valve: only ${reachableTestable}/${totalTestable} sites ok (<10%), keeping all`);
    return { sites, filtered: 0 };
  }

  logger.infoFields('speedtest', 'filter-done', { filtered: unreachable.length, kept: reachable.length });
  return { sites: reachable, filtered: unreachable.length };
}

function getTestableUrl(site: TVBoxSite): string | null {
  const api = site.api || '';

  if (site.type === 1 || site.type === 0) {
    if (!api.startsWith('http')) return null;
    return api.includes('?') ? `${api}&ac=list` : `${api}?ac=list`;
  }

  if (site.type === 3) {
    if (api.startsWith('http://') || api.startsWith('https://')) return api;
    return null;
  }

  return null;
}
