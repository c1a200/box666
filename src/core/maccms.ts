// MacCMS 源验证与 TVBoxSite 转换

import { failureKindForHttpStatus, isInvalidProbeFailure } from './probe-classification';
import type { MacCMSSourceEntry, ProbeFailureKind, TVBoxSite } from './types';

export interface MacCMSValidation {
  ok: boolean;
  speedMs: number;
  result: 'ok' | 'empty' | 'error' | 'timeout';
  httpStatus?: number;
  failureKind?: ProbeFailureKind;
}

/**
 * 验证单个 MacCMS API 可用性，返回结果和延迟
 * 发 ?ac=list 请求，检查响应包含 class 或 list 字段
 */
export async function validateMacCMS(
  api: string,
  timeoutMs: number,
): Promise<MacCMSValidation> {
  const url = api.includes('?') ? `${api}&ac=list` : `${api}?ac=list`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    const speedMs = Date.now() - start;

    if (!resp.ok) {
      return {
        ok: false,
        speedMs,
        result: 'error',
        httpStatus: resp.status,
        failureKind: failureKindForHttpStatus(resp.status),
      };
    }

    let data: Record<string, unknown>;
    try {
      data = (await resp.json()) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        speedMs,
        result: 'empty',
        httpStatus: resp.status,
        failureKind: 'transient',
      };
    }
    // MacCMS 标准响应包含 class（分类）或 list（视频列表）
    const ok = !!(data && (data.class || data.list));
    return ok
      ? { ok: true, speedMs, result: 'ok', httpStatus: resp.status }
      : { ok: false, speedMs, result: 'empty', httpStatus: resp.status, failureKind: 'transient' };
  } catch (error: unknown) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      speedMs: Date.now() - start,
      result: timedOut ? 'timeout' : 'error',
      failureKind: 'transient',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 将 MacCMS 源条目转换为 TVBoxSite 数组
 * - 有 proxyBaseUrl（workerBaseUrl || localBaseUrl）：使用代理 URL
 * - 无 proxyBaseUrl：使用原始 API URL
 * - speedMap 有值时追加延迟标记到 name
 */
export function macCMSToTVBoxSites(
  entries: MacCMSSourceEntry[],
  proxyBaseUrl?: string,
  speedMap?: Map<string, number>,
): TVBoxSite[] {
  return entries.map((entry) => {
    let name = entry.name;
    const speedMs = speedMap?.get(entry.key);
    if (speedMs != null) {
      const seconds = (speedMs / 1000).toFixed(1);
      name = `${name} [${seconds}s]`;
    }

    return {
      key: entry.key,
      name,
      type: 1,
      api: proxyBaseUrl
        ? `${proxyBaseUrl.replace(/\/$/, '')}/api/${entry.key}`
        : entry.api,
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    };
  });
}

/**
 * 本地版：并发验证所有 MacCMS 源，返回通过验证的条目 + 延迟映射
 */
export async function processMacCMSForLocal(
  entries: MacCMSSourceEntry[],
  timeoutMs: number,
): Promise<{ passed: MacCMSSourceEntry[]; speedMap: Map<string, number> }> {
  if (entries.length === 0) return { passed: [], speedMap: new Map() };

  console.log(`[maccms] Validating ${entries.length} MacCMS sources...`);

  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const validation = await validateMacCMS(entry.api, timeoutMs);
      return { entry, validation };
    }),
  );

  const passed: MacCMSSourceEntry[] = [];
  const speedMap = new Map<string, number>();

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { entry, validation } = result.value;
      if (validation.ok) {
        passed.push(entry);
        speedMap.set(entry.key, validation.speedMs);
      } else if (!isInvalidProbeFailure(validation)) {
        // 本地验证只淘汰确定性失效的 MacCMS API。超时、限流、5xx、
        // 403/反爬或临时无效 JSON 都保留，稍后由站点探测/质量任务重试。
        passed.push(entry);
        console.log(
          `[maccms] Kept ${entry.key} after transient failure (${validation.httpStatus || validation.result})`,
        );
      } else {
        console.log(
          `[maccms] Filtered out ${entry.key}: permanent failure (${validation.httpStatus || validation.result})`,
        );
      }
    } else {
      console.log(`[maccms] Filtered out unknown: ${result.reason}`);
    }
  }

  console.log(
    `[maccms] ${passed.length}/${entries.length} MacCMS sources retained`,
  );
  return { passed, speedMap };
}
