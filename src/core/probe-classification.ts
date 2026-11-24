import type { ProbeFailureKind } from './types';

/**
 * 只有明确表示资源不存在或永久失效的 HTTP 状态才算硬失败。
 * 401/403 可能是登录、鉴权头或反爬策略变化，429/5xx 与网络错误均可能恢复，
 * 因此不能进入永久排除或自动拉黑流程。
 */
export function failureKindForHttpStatus(status: number): ProbeFailureKind {
  return status === 404 || status === 410 ? 'invalid' : 'transient';
}

export interface ProbeFailureEvidence {
  result?: string;
  httpStatus?: number;
  failureKind?: ProbeFailureKind;
}

export function isInvalidProbeFailure(evidence: ProbeFailureEvidence | undefined): boolean {
  if (!evidence) return false;
  // HTTP status is the stronger historical signal. Older snapshots may have
  // persisted failureKind=transient alongside a definitive 404/410.
  if (typeof evidence.httpStatus === 'number'
    && failureKindForHttpStatus(evidence.httpStatus) === 'invalid') {
    return true;
  }
  if (evidence.failureKind === 'invalid') return true;
  if (evidence.failureKind === 'transient') return false;
  return false;
}
