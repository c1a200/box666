import type { LiveSourceEntry, TVBoxLive, TVBoxLiveGroup } from './types';
import type { Storage } from '../storage/interface';
import { KV_LIVE_TEXT_PREFIX, LIVE_PROXY_TTL } from './config';
import { isBlockedLiveSource } from './live-policy';
import {
  classifyLiveCategory,
  compareLiveRank,
  computeLiveSourceQualityScore,
  isLiveSourceDistributable,
  liveSourceFormatFromUrl,
  normalizeLiveCategory,
  normalizeLiveSourceFormat,
  type LiveCategory,
  type LiveRankView,
  type LiveSourceFormat,
  type LiveSourceHealth,
  type LiveSourceMetrics,
} from './live-quality';

const KV_LIVE_PREFIX = 'live:';
export const KV_LIVE_PROXY_MANIFEST = 'live_proxy_manifest';
/**
 * 失败判定规则版本。旧规则曾把超时、HTML、解析失败等可恢复问题写成
 * invalid；升级后必须把这些历史结论降级重试，不能让一次误判永久生效。
 */
export const LIVE_PROXY_FAILURE_RULE_VERSION = 1;
const LIVE_PROXY_MANIFEST_VERSION = 5;
const LIVE_PROXY_MANIFEST_MAX_ENTRIES = 4096;
const LIVE_PROXY_INVALID_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const LIVE_PROXY_UNHEALTHY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_PROXY_INVALID_DELETE_THRESHOLD = 3;

export type LiveProxyHealth = LiveSourceHealth;

async function urlToKey(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface LiveTestResult {
  name: string;
  url: string;
  reachable: boolean;
  speedMs: number;
}

export interface LiveProxySource {
  name?: string;
  url: string;
  ua?: string;
  header?: Record<string, string>;
}

export interface LiveProxyEntryHint {
  /** manual=管理端手动添加；aggregated=来自第三方订阅/上游配置。 */
  kind?: 'aggregated' | 'manual';
  /** 该源解析出的主要分类（按分组名判定）。 */
  category?: LiveCategory;
}

export interface LiveProxyManifestEntry extends LiveProxySource {
  key: string;
  health: LiveProxyHealth;
  consecutiveFailures: number;
  checkedAt: string;
  successfulAt?: string;
  lastFailure?: 'transient' | 'invalid';
  /** 产生 lastFailure 时采用的失败判定规则版本。缺失表示规则升级前的历史结论。 */
  failureRuleVersion?: number;
  kind?: 'aggregated' | 'manual';
  format?: LiveSourceFormat;
  category?: LiveCategory;
  /** 合并或代理输出中此源的真实线路标签；供运行时精确过滤，不能再用 URL 反查。 */
  label?: string;
  qualityScore?: number;
  rank?: number;
  channelCount?: number;
  totalEntries?: number;
  usableEntries?: number;
  playableRatio?: number | null;
  adRatio?: number | null;
  downloadMs?: number | null;
  everSucceeded?: boolean;
  /** 是否已生成可用的代理文本；缺失时禁止下发，避免客户端实时回源。 */
  textReady?: boolean;
  /** 最近一次在完整聚合快照中被看到的时刻；用于淘汰上游已删除的幽灵源。 */
  lastSeenAt?: string;
}

export interface LiveProxyManifest {
  version: number;
  signature: string;
  entries: LiveProxyManifestEntry[];
}

function isCurrentRuleInvalid(
  entry: Pick<LiveProxyManifestEntry, 'lastFailure' | 'failureRuleVersion'>,
): boolean {
  return entry.lastFailure === 'invalid'
    && entry.failureRuleVersion === LIVE_PROXY_FAILURE_RULE_VERSION;
}

/**
 * 只迁移失败证据，不改变源本身。
 *
 * - 旧规则 invalid 没有可信的永久失败证据，降级为 transient 并清零旧的
 *   连续失败次数，避免历史计数直接触发三次淘汰；
 * - 旧 transient 保留失败次数，但标记为当前规则；
 * - 成功记录不应携带失败规则版本。
 */
function normalizeFailureEvidence(entry: LiveProxyManifestEntry): LiveProxyManifestEntry {
  if (!entry.lastFailure) {
    if (entry.failureRuleVersion === undefined) return entry;
    const next = { ...entry };
    delete next.failureRuleVersion;
    return next;
  }
  if (!isCurrentRuleInvalid(entry) && entry.lastFailure === 'invalid') {
    return {
      ...entry,
      lastFailure: 'transient',
      failureRuleVersion: LIVE_PROXY_FAILURE_RULE_VERSION,
      consecutiveFailures: 0,
    };
  }
  if (entry.failureRuleVersion !== LIVE_PROXY_FAILURE_RULE_VERSION) {
    return { ...entry, failureRuleVersion: LIVE_PROXY_FAILURE_RULE_VERSION };
  }
  return entry;
}

export interface LiveProxyValidationUpdate {
  entries: LiveSourceEntry[];
  validUrls: readonly string[];
  transientUrls?: readonly string[];
  invalidUrls?: readonly string[];
  checkedAt?: string;
  metrics?: Readonly<Record<string, LiveSourceMetrics>>;
  /** 逐源来源与分类提示，聚合阶段解析后回填，避免清单分类一律为“其他”。 */
  hints?: Readonly<Record<string, LiveProxyEntryHint>>;
  /** 原始源 URL -> 合并输出实际使用的线路标签。 */
  labels?: Readonly<Record<string, string>>;
  texts?: Record<string, string>;
  /** 本轮是完整聚合快照：可对上轮未出现的旧入口执行宽限期淘汰。 */
  fullSnapshot?: boolean;
  /**
   * 本轮只是受限分片，而不是覆盖全部源。
   * 此时 texts 只能更新本批次，严禁把未出现在本批次的旧 textReady 清零。
   */
  incremental?: boolean;
}

export async function liveProxyKey(url: string): Promise<string> {
  return urlToKey(url);
}

function parseLiveProxySource(raw: string): LiveProxySource | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LiveProxySource>;
    if (typeof parsed.url === 'string' && parsed.url) {
      return {
        url: parsed.url,
        ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
        ...(typeof parsed.ua === 'string' ? { ua: parsed.ua } : {}),
        ...(parsed.header && typeof parsed.header === 'object' ? { header: parsed.header } : {}),
      };
    }
  } catch { /* legacy raw URL */ }
  return { url: raw };
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeManifestEntry(
  record: Record<string, unknown>,
  checkedAt: string,
  legacyVerified = false,
): LiveProxyManifestEntry | null {
  if (typeof record.key !== 'string' || !record.key || typeof record.url !== 'string' || !record.url) return null;
  const rawFailures = typeof record.consecutiveFailures === 'number' && Number.isFinite(record.consecutiveFailures)
    ? Math.floor(record.consecutiveFailures)
    : 0;
  const health: LiveProxyHealth = record.health === 'unhealthy' ? 'unhealthy' : 'healthy';
  const lastFailure = record.lastFailure === 'transient' || record.lastFailure === 'invalid' ? record.lastFailure : undefined;
  const successfulAt = stringValue(record, 'successfulAt') || (legacyVerified && health === 'healthy' ? checkedAt : undefined);
  const url = record.url;
  return normalizeFailureEvidence({
    key: record.key,
    url,
    health,
    consecutiveFailures: Math.max(0, rawFailures),
    checkedAt: stringValue(record, 'checkedAt') || checkedAt,
    ...(successfulAt ? { successfulAt } : {}),
    ...(lastFailure ? { lastFailure } : {}),
    ...(lastFailure && numberValue(record, 'failureRuleVersion') != null
      ? { failureRuleVersion: numberValue(record, 'failureRuleVersion') }
      : {}),
    ...(stringValue(record, 'name') ? { name: record.name as string } : {}),
    ...(stringValue(record, 'ua') ? { ua: record.ua as string } : {}),
    ...(record.header && typeof record.header === 'object' ? { header: record.header as Record<string, string> } : {}),
    ...(record.kind === 'aggregated' || record.kind === 'manual' ? { kind: record.kind } : {}),
    format: normalizeLiveSourceFormat(record.format ?? liveSourceFormatFromUrl(url)),
    category: normalizeLiveCategory(record.category),
    ...(stringValue(record, 'label') ? { label: record.label as string } : {}),
    ...(numberValue(record, 'qualityScore') != null ? { qualityScore: numberValue(record, 'qualityScore') } : {}),
    ...(numberValue(record, 'rank') != null ? { rank: numberValue(record, 'rank') } : {}),
    ...(numberValue(record, 'channelCount') != null ? { channelCount: numberValue(record, 'channelCount') } : {}),
    ...(numberValue(record, 'totalEntries') != null ? { totalEntries: numberValue(record, 'totalEntries') } : {}),
    ...(numberValue(record, 'usableEntries') != null ? { usableEntries: numberValue(record, 'usableEntries') } : {}),
    ...(numberValue(record, 'playableRatio') != null ? { playableRatio: numberValue(record, 'playableRatio') } : {}),
    ...(numberValue(record, 'adRatio') != null ? { adRatio: numberValue(record, 'adRatio') } : {}),
    ...(numberValue(record, 'downloadMs') != null ? { downloadMs: numberValue(record, 'downloadMs') } : {}),
    ...(typeof record.everSucceeded === 'boolean' ? { everSucceeded: record.everSucceeded } : {}),
    ...(typeof record.textReady === 'boolean' ? { textReady: record.textReady } : {}),
    ...(stringValue(record, 'lastSeenAt') ? { lastSeenAt: record.lastSeenAt as string } : {}),
  });
}

export function parseLiveProxyManifest(raw: string | null): LiveProxyManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LiveProxyManifest>;
    const supported = parsed.version === 1
      || parsed.version === 2
      // 兼容线上尚未重建的旧版清单；v3 没有 textReady，按未就绪处理，
      // 避免升级后整份清单被丢弃，同时在重新聚合前 fail-closed。
      || parsed.version === 3
      || parsed.version === 4
      || parsed.version === LIVE_PROXY_MANIFEST_VERSION;
    if (!supported || !Array.isArray(parsed.entries)) return null;
    const checkedAt = new Date().toISOString();
    const entries: LiveProxyManifestEntry[] = [];
    for (const entry of parsed.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const normalized = normalizeManifestEntry(entry as unknown as Record<string, unknown>, checkedAt, parsed.version === 1);
      if (normalized) entries.push(normalized);
    }
    return {
      version: LIVE_PROXY_MANIFEST_VERSION,
      signature: typeof parsed.signature === 'string' ? parsed.signature : manifestSignature(entries),
      entries: sortManifestEntries(entries),
    };
  } catch {
    return null;
  }
}

/**
 * 清单签名只覆盖会影响下发决策的实质字段。
 *
 * checkedAt / lastSeenAt / rank / qualityScore 都是派生或时间展示字段：
 * 它们变化不应该触发整份 manifest 写入。否则每次定时探测都会形成
 * “字段变化 -> 签名变化 -> 写 KV -> 再次触发”的写入放大，最终耗尽
 * Cloudflare KV 日额度并让直播预构建停摆。
 */
function manifestSignature(entries: LiveProxyManifestEntry[]): string {
  const stable = entries.map((entry) => ({
    key: entry.key,
    url: entry.url,
    name: entry.name,
    ua: entry.ua,
    header: entry.header,
    kind: entry.kind,
    format: entry.format,
    category: entry.category,
    label: entry.label,
    health: entry.health,
    consecutiveFailures: entry.consecutiveFailures,
    successfulAt: entry.successfulAt,
    lastFailure: entry.lastFailure,
    failureRuleVersion: entry.failureRuleVersion,
    everSucceeded: entry.everSucceeded,
    textReady: entry.textReady === true,
    channelCount: entry.channelCount,
    totalEntries: entry.totalEntries,
    usableEntries: entry.usableEntries,
    playableRatio: entry.playableRatio,
    adRatio: entry.adRatio,
    downloadMs: entry.downloadMs,
  }));
  return JSON.stringify(stable);
}

async function persistManifest(
  storage: Storage,
  entries: LiveProxyManifestEntry[],
): Promise<LiveProxyManifest> {
  const manifest: LiveProxyManifest = {
    version: LIVE_PROXY_MANIFEST_VERSION,
    signature: manifestSignature(entries),
    entries: sortManifestEntries(entries),
  };
  await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify(manifest));
  return manifest;
}

function scoreEntry(entry: LiveProxyManifestEntry): number {
  return computeLiveSourceQualityScore({
    health: entry.health,
    everSucceeded: entry.everSucceeded ?? !!entry.successfulAt,
    lastFailure: entry.lastFailure,
    channelCount: entry.channelCount,
    totalEntries: entry.totalEntries,
    usableEntries: entry.usableEntries,
    playableRatio: entry.playableRatio,
    adRatio: entry.adRatio,
    downloadMs: entry.downloadMs,
    successfulAt: entry.successfulAt,
    now: Date.now(),
  });
}

function rankManifestEntries(entries: LiveProxyManifestEntry[]): LiveProxyManifestEntry[] {
  const scored = entries.map((entry) => ({ ...entry, qualityScore: scoreEntry(entry) }));
  scored.sort(compareLiveRank);
  return scored.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function sortManifestEntries(entries: LiveProxyManifestEntry[]): LiveProxyManifestEntry[] {
  return rankManifestEntries(entries);
}

export function prepareManifestEntries(
  entries: LiveSourceEntry[],
  hints?: Record<string, LiveProxyEntryHint>,
  labels?: Readonly<Record<string, string>>,
): LiveProxyManifestEntry[] {
  const checkedAt = new Date().toISOString();
  const prepared: LiveProxyManifestEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const url = entry.url.trim();
    if (!url || seen.has(url) || isBlockedLiveSource({ name: entry.name, url })) continue;
    seen.add(url);
    const hint = hints?.[url];
    const metrics: LiveSourceMetrics = {};
    prepared.push({
      key: '',
      url,
      health: 'unhealthy',
      consecutiveFailures: 0,
      checkedAt,
      kind: hint?.kind ?? 'aggregated',
      ...(labels?.[url] ? { label: labels[url] } : {}),
      format: liveSourceFormatFromUrl(url),
      // 分类来自本轮聚合解析出的分组；缺省才退回“其他”，不再一律判成其他。
      category: hint?.category ?? classifyLiveCategory([]),
      qualityScore: computeLiveSourceQualityScore(metrics),
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.ua ? { ua: entry.ua } : {}),
      ...(entry.header ? { header: entry.header } : {}),
    });
  }
  return prepared;
}

export function mergeLiveProxyManifest(
  previous: LiveProxyManifest | null,
  currentEntries: LiveProxyManifestEntry[],
  update: Omit<LiveProxyValidationUpdate, 'entries'>,
): LiveProxyManifest {
  const checkedAt = update.checkedAt || new Date().toISOString();
  const byKey = new Map<string, LiveProxyManifestEntry>();
  if (previous?.entries) {
    for (const entry of previous.entries) {
      const normalized = normalizeFailureEvidence(entry);
      byKey.set(normalized.key, normalized);
    }
  }
  const valid = new Set(update.validUrls);
  const transient = new Set(update.transientUrls || []);
  const invalid = new Set(update.invalidUrls || []);
  const observed = new Set<string>([...valid, ...transient, ...invalid]);
  // 增量分片只对 currentEntries 负责：本批明确无效或权威文本快照中
  // 未产文的源必须立即关闭 textReady；本批未出现的其他 ready 源仍保留，
  // 避免每推进一步就把其余已完成批次清空。
  const incrementalTextUpdate = !!update.texts && update.incremental === true;
  const batchTextUrls = new Set(Object.entries(update.texts || {})
    .filter(([, text]) => typeof text === 'string' && text.trim() && text.includes('#genre#'))
    .map(([url]) => url));
  // 只有明确 invalid，或本轮权威文本构建确认“有效但无正文”，才立即撤销
  // textReady。transient 无论连续多少次都只是当前网络环境的瞬时结论；成熟正文
  // 必须保留到重新成功或明确 invalid，否则 Render 出网抖动会让整台频道消失。
  const textStateAuthoritative = !!(update.fullSnapshot || (update.texts && !update.incremental));
  const revokedInBatch = new Set([
    ...invalid,
    ...currentEntries
      .filter((item) => textStateAuthoritative
        && valid.has(item.url)
        && !batchTextUrls.has(item.url))
      .map((item) => item.url),
    ...currentEntries
      .filter((item) => incrementalTextUpdate
        && valid.has(item.url)
        && !batchTextUrls.has(item.url))
      .map((item) => item.url),
  ]);

  const legacyV1 = previous?.version === 1;
  for (const current of currentEntries) {
    const previousEntry = byKey.get(current.key);
    const metrics = update.metrics?.[current.url] || update.metrics?.[current.key] || {};
    const priorSucceeded = previousEntry?.everSucceeded !== false
      && (previousEntry?.everSucceeded === true
        || !!previousEntry?.successfulAt
        || !!current.successfulAt
        || legacyV1);
    const priorReady = previousEntry?.textReady === true
      || (legacyV1 && current.textReady === true);
    const merged: LiveProxyManifestEntry = {
      ...previousEntry,
      ...current,
      key: current.key,
      url: current.url,
      health: previousEntry?.health || current.health,
      consecutiveFailures: previousEntry?.consecutiveFailures ?? current.consecutiveFailures,
      checkedAt,
      ...(previousEntry?.successfulAt ? { successfulAt: previousEntry.successfulAt } : {}),
      ...(previousEntry?.lastFailure ? { lastFailure: previousEntry.lastFailure } : {}),
      everSucceeded: priorSucceeded,
      // 只有本轮或历史确实存在可用文本时才允许继承 textReady；否则新清单
      // 不能凭旧标记继续下发一个已经无法生成文本的入口。
      // 完整快照或带文本的更新代表本轮文本状态是权威结果；
      // 不能从 previous 的 spread 中继承旧的 textReady。
      ...((update.fullSnapshot || (update.texts && !update.incremental)) ? { textReady: false } : {}),
      // 本批明确无效或权威文本快照中未产文的入口必须显式落为 false；
      // 否则 previousEntry 的 spread
      // 会把旧的 textReady=true 带回来，形成客户端可见但正文不存在的幽灵入口。
      ...(revokedInBatch.has(current.url) ? { textReady: false } : {}),
      ...(current.textReady === undefined
        && previousEntry?.textReady === true
        && !revokedInBatch.has(current.url)
        && !update.fullSnapshot
        && (!update.texts || update.incremental)
        ? { textReady: true }
        : {}),
      ...(current.textReady === true ? { textReady: true } : {}),
      ...(current.textReady === false ? { textReady: false } : {}),
      lastSeenAt: checkedAt,
    };
    for (const key of [
      'channelCount', 'totalEntries', 'usableEntries', 'playableRatio', 'adRatio', 'downloadMs',
    ] as const) {
      const value = metrics[key];
      if (value != null) (merged as unknown as Record<string, unknown>)[key] = value;
    }
    if (metrics.lastFailure === 'invalid' || metrics.lastFailure === 'transient') {
      merged.lastFailure = metrics.lastFailure;
      merged.failureRuleVersion = LIVE_PROXY_FAILURE_RULE_VERSION;
    }
    if (valid.has(current.url)) {
      merged.health = 'healthy';
      merged.consecutiveFailures = 0;
      merged.successfulAt = checkedAt;
      merged.everSucceeded = true;
      delete merged.lastFailure;
      delete merged.failureRuleVersion;
    } else if (transient.has(current.url)) {
      merged.health = 'unhealthy';
      merged.consecutiveFailures = (previousEntry?.consecutiveFailures ?? 0) + 1;
      merged.lastFailure = 'transient';
      merged.failureRuleVersion = LIVE_PROXY_FAILURE_RULE_VERSION;
      // 成熟正文在任意次数超时、网络或 HTTP 抖动中保留为后备。新源没有
      // 成功历史时仍不可下发；只有明确 invalid 才撤销。
      merged.textReady = priorReady
        && priorSucceeded;
    } else if (invalid.has(current.url)) {
      merged.health = 'unhealthy';
      merged.consecutiveFailures = (previousEntry?.consecutiveFailures ?? 0) + 1;
      merged.lastFailure = 'invalid';
      merged.failureRuleVersion = LIVE_PROXY_FAILURE_RULE_VERSION;
      merged.textReady = false;
    }
    byKey.set(current.key, merged);
  }

  const now = Date.parse(checkedAt) || Date.now();
  // 完整聚合快照语义：本轮 currentEntries 覆盖全部上游入口。
  // 若某旧入口本轮未再出现，说明已被上游删除，保留一个宽限期后清理，
  // 避免签名/URL 变更后永久残留幽灵源；局部验证调用不传该标记。
  const fullSnapshotObserved = !!update.fullSnapshot;
  const currentKeys = new Set(currentEntries.map((item) => item.key));
  for (const [key, entry] of byKey) {
    const isObserved = observed.has(entry.url);
    const invalidRepeated = isObserved && isCurrentRuleInvalid(entry)
      && entry.consecutiveFailures >= LIVE_PROXY_INVALID_DELETE_THRESHOLD;
    let expired = false;
    if (isObserved && entry.lastFailure) {
      const lastActive = Date.parse(entry.successfulAt || '') || Date.parse(entry.checkedAt || '') || now;
      const staleForMs = Math.max(0, now - lastActive);
      expired = isCurrentRuleInvalid(entry)
        ? staleForMs >= LIVE_PROXY_INVALID_RETENTION_MS
        : staleForMs >= LIVE_PROXY_UNHEALTHY_RETENTION_MS;
    }
    if (fullSnapshotObserved && !currentKeys.has(key)) {
      const lastSeen = Date.parse(entry.lastSeenAt || '') || Date.parse(entry.checkedAt || '') || 0;
      if (lastSeen > 0 && now - lastSeen >= LIVE_PROXY_UNHEALTHY_RETENTION_MS) byKey.delete(key);
      continue;
    }
    if (invalidRepeated || expired) byKey.delete(key);
  }

  const entries = sortManifestEntries([...byKey.values()]).slice(0, LIVE_PROXY_MANIFEST_MAX_ENTRIES);
  return { version: LIVE_PROXY_MANIFEST_VERSION, signature: manifestSignature(entries), entries };
}

export function isLiveProxyEntryDistributable(entry: LiveProxyManifestEntry): boolean {
  return !isBlockedLiveSource(entry)
    && entry.textReady === true
    && isLiveSourceDistributable({
      ...entry,
      everSucceeded: entry.everSucceeded ?? !!entry.successfulAt,
    });
}

export interface LiveProxyValidationResult {
  key: string;
  state: 'valid' | 'invalid' | 'transient';
  entry: LiveProxyManifestEntry | null;
}

/**
 * 批量写入单源验证结果：一次读取 manifest、一次排序、最多一次整体写入。
 *
 * 旧实现每验证一个源就写整份 manifest；几十个源会放大成几十次 KV put，
 * 在免费额度下足以阻断后续聚合。这里保留原逐源语义，但把写放大收敛为 1。
 */
export async function recordLiveProxyValidations(
  results: readonly { key: string; state: 'valid' | 'invalid' | 'transient' }[],
  storage: Storage,
): Promise<LiveProxyValidationResult[]> {
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  if (!manifest || results.length === 0) {
    return results.map((result) => ({ key: result.key, state: result.state, entry: null }));
  }

  const checkedAt = new Date().toISOString();
  const byKey = new Map(manifest.entries.map((entry) => [entry.key, entry]));
  const output: LiveProxyValidationResult[] = [];
  let changed = false;

  for (const result of results) {
    const entry = byKey.get(result.key);
    if (!entry) {
      output.push({ key: result.key, state: result.state, entry: null });
      continue;
    }
    const nextEntry: LiveProxyManifestEntry = { ...entry, checkedAt };
    if (result.state === 'valid') {
      nextEntry.health = 'healthy';
      nextEntry.consecutiveFailures = 0;
      nextEntry.successfulAt = checkedAt;
      nextEntry.everSucceeded = true;
      delete nextEntry.lastFailure;
      delete nextEntry.failureRuleVersion;
    } else if (result.state === 'invalid') {
      nextEntry.health = 'unhealthy';
      nextEntry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
      nextEntry.lastFailure = 'invalid';
      nextEntry.failureRuleVersion = LIVE_PROXY_FAILURE_RULE_VERSION;
      nextEntry.textReady = false;
    } else {
      nextEntry.health = 'unhealthy';
      nextEntry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
      nextEntry.lastFailure = 'transient';
      nextEntry.failureRuleVersion = LIVE_PROXY_FAILURE_RULE_VERSION;
      // 单源手动复检与批量定时复检使用同一语义：成熟正文在任意次数瞬时
      // 失败时保留为后备，只有明确 invalid 才撤销。新源没有历史成功记录时
      // 仍保持不可下发，避免把未验证入口暴露给客户端。
      const matureText = entry.textReady === true
        && entry.everSucceeded !== false
        && (entry.everSucceeded === true || !!entry.successfulAt);
      nextEntry.textReady = matureText;
    }
    byKey.set(result.key, nextEntry);
    output.push({ key: result.key, state: result.state, entry: nextEntry });
    changed = true;
  }

  if (!changed) return output;
  const nextEntries = sortManifestEntries([...byKey.values()]);
  const nextManifest: LiveProxyManifest = {
    version: LIVE_PROXY_MANIFEST_VERSION,
    signature: manifestSignature(nextEntries),
    entries: nextEntries,
  };
  if (manifest.signature !== nextManifest.signature) {
    await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify(nextManifest));
  }
  return output;
}

export async function recordLiveProxyValidation(
  key: string,
  result: 'valid' | 'invalid' | 'transient',
  storage: Storage,
): Promise<LiveProxyManifestEntry | null> {
  const [updated] = await recordLiveProxyValidations([{ key, state: result }], storage);
  return updated?.entry ?? null;
}

export interface LiveTextReadinessRepairResult {
  checked: number;
  repaired: number;
  revoked: number;
  distributable: number;
  changed: boolean;
  manifest: LiveProxyManifest;
}

/**
 * 修复升级前已有 live_txt 但 manifest 没有 textReady 的在线状态。
 *
 * 这里只读取 KV 正文，不请求上游。恢复条件同时要求：
 * - 正文非空且含 #genre#；
 * - 当前健康或历史成功，明确 invalid 的源不恢复；
 * - 未被屏蔽。
 *
 * 该修复幂等，重复调用不会生成额外写入。
 */
export async function repairLiveProxyTextReadiness(
  storage: Storage,
): Promise<LiveTextReadinessRepairResult> {
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  if (!manifest) {
    const empty: LiveProxyManifest = { version: LIVE_PROXY_MANIFEST_VERSION, signature: manifestSignature([]), entries: [] };
    return { checked: 0, repaired: 0, revoked: 0, distributable: 0, changed: false, manifest: empty };
  }

  let repaired = 0;
  let revoked = 0;
  let checked = 0;
  const next: LiveProxyManifestEntry[] = [];
  for (const entry of manifest.entries) {
    const text = await storage.get(`${KV_LIVE_TEXT_PREFIX}${entry.key}`);
    const textValid = !!text && text.trim().length > 0 && text.includes('#genre#');
    // 正文本身是最强的可下发证据；从未验证成功只影响排序，不能据此
    // 永久关闭一个已经拥有完整 #genre# 文本的源。只有明确 invalid 或屏蔽
    // 才撤销，transient 由排序层承担降级。
    const sourceEligible = !isBlockedLiveSource(entry)
      && !isCurrentRuleInvalid(entry);
    const shouldReady = textValid && sourceEligible;
    checked++;
    const wasReady = entry.textReady === true;
    if (shouldReady !== wasReady) {
      if (shouldReady) repaired++;
      else revoked++;
    }
    next.push({ ...entry, ...(shouldReady ? { textReady: true } : { textReady: false }) });
  }

  const sorted = sortManifestEntries(next);
  const nextManifest: LiveProxyManifest = {
    version: LIVE_PROXY_MANIFEST_VERSION,
    signature: manifestSignature(sorted),
    entries: sorted,
  };
  const changed = manifest.signature !== nextManifest.signature;
  if (changed) await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify(nextManifest));
  return {
    checked,
    repaired,
    revoked,
    distributable: nextManifest.entries.filter(isLiveProxyEntryDistributable).length,
    changed,
    manifest: nextManifest,
  };
}

async function testLiveSource(entry: LiveSourceEntry, timeoutMs: number): Promise<LiveTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const start = Date.now();
    const resp = await fetch(entry.url, { signal: controller.signal, headers: { 'User-Agent': 'okhttp/3.12.0' } });
    const speedMs = Date.now() - start;
    if (!resp.ok) return { name: entry.name, url: entry.url, reachable: false, speedMs };
    const reader = resp.body?.getReader();
    if (reader) {
      try {
        const { value } = await reader.read();
        if (value) new TextDecoder().decode(value.slice(0, 1024));
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    return { name: entry.name, url: entry.url, reachable: true, speedMs };
  } catch {
    return { name: entry.name, url: entry.url, reachable: false, speedMs: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function batchTestLiveSources(
  entries: LiveSourceEntry[],
  timeoutMs: number,
): Promise<{ passed: LiveSourceEntry[]; speedMap: Map<string, number> }> {
  if (entries.length === 0) return { passed: [], speedMap: new Map() };
  const results = await Promise.allSettled(entries.map((entry) => testLiveSource(entry, timeoutMs)));
  const passed: LiveSourceEntry[] = [];
  const speedMap = new Map<string, number>();
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.reachable) {
      passed.push({ name: result.value.name, url: result.value.url });
      speedMap.set(result.value.url, result.value.speedMs);
    }
  }
  return { passed, speedMap };
}

/**
 * 把聚合阶段已经算出的逐源质量结果写入持久清单。
 * Render 与 Cloudflare 共用同一份清单，因此下发策略在两种运行模式
 * 下使用完全一致的质量池排序、分类、屏蔽与置顶规则。
 */
export async function updateLiveProxyManifest(
  entries: LiveSourceEntry[],
  storage: Storage,
  validationUpdate: Omit<LiveProxyValidationUpdate, 'entries'>,
): Promise<LiveProxyManifest> {
  const proxyEntries = prepareManifestEntries(entries, validationUpdate.hints, validationUpdate.labels);
  for (const entry of proxyEntries) entry.key = await urlToKey(entry.url);
  // 代理文本只接受“非空且包含频道分组”的完整构建结果；文本就绪与清单不得分离更新。
  for (const entry of proxyEntries) {
    const text = validationUpdate.texts?.[entry.url];
    if (!text || !text.trim() || !text.includes('#genre#')) continue;
    await storage.put(`${KV_LIVE_TEXT_PREFIX}${entry.key}`, text);
    entry.textReady = true;
  }
  for (const entry of proxyEntries) {
    const metrics = validationUpdate.metrics?.[entry.url];
    if (!metrics) continue;
    entry.health = metrics.health === 'healthy' ? 'healthy' : 'unhealthy';
    entry.everSucceeded = metrics.everSucceeded ?? entry.everSucceeded;
    if (metrics.lastFailure) entry.lastFailure = metrics.lastFailure;
    if (metrics.channelCount != null) entry.channelCount = metrics.channelCount;
    if (metrics.totalEntries != null) entry.totalEntries = metrics.totalEntries;
    if (metrics.usableEntries != null) entry.usableEntries = metrics.usableEntries;
    if (metrics.playableRatio != null) entry.playableRatio = metrics.playableRatio;
    if (metrics.adRatio != null) entry.adRatio = metrics.adRatio;
    if (metrics.downloadMs != null) entry.downloadMs = metrics.downloadMs;
    if (metrics.successfulAt) entry.successfulAt = metrics.successfulAt;
    entry.qualityScore = computeLiveSourceQualityScore(metrics);
  }
  const previous = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  // 历史成功时间必须继承；否则本轮临时失败会把成熟后备源错误降级。
  for (const entry of proxyEntries) {
    const prior = previous?.entries.find((item) => item.key === entry.key);
    if (!prior) continue;
    if (!entry.successfulAt && prior.successfulAt) entry.successfulAt = prior.successfulAt;
    if (entry.everSucceeded == null && prior.everSucceeded != null) entry.everSucceeded = prior.everSucceeded;
  }
  const manifest = mergeLiveProxyManifest(previous, proxyEntries, validationUpdate);
  if (!previous || previous.signature !== manifest.signature) {
    await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify(manifest));
  }
  return manifest;
}
export async function liveSourcesToTVBoxLives(
  entries: LiveSourceEntry[],
  workerBaseUrl: string | undefined,
  storage: Storage,
  speedMap?: Map<string, number>,
  prebuiltTexts?: Record<string, string>,
  validationUpdate?: Omit<LiveProxyValidationUpdate, 'entries'>,
  labels?: Readonly<Record<string, string>>,
): Promise<TVBoxLive[]> {
  const lives: TVBoxLive[] = [];
  if (workerBaseUrl) {
    const proxyEntries = prepareManifestEntries(entries, validationUpdate?.hints, labels);
    const manifest = await updateLiveProxyManifest(entries, storage, validationUpdate || {
      validUrls: proxyEntries.map((entry) => entry.url),
    });
    // 运行时只允许已经写入完整预构建文本的入口，绝不能下发需要客户端回源的“幽灵源”。
    const distributableEntries = manifest.entries.filter(isLiveProxyEntryDistributable);
    for (const entry of distributableEntries) {
      lives.push({ name: entry.name || '直播源', type: 0, url: `${workerBaseUrl.replace(/\/$/, '')}/live/${entry.key}` });
    }
    return lives;
  }

  for (const entry of entries) {
    let name = entry.name;
    const ms = speedMap?.get(entry.url);
    if (ms != null) name = `${name} [${(ms / 1000).toFixed(1)}s]`;
    lives.push({ name, type: 0, url: entry.url });
  }
  return lives;
}

/**
 * 解析一条清单源在合并输出中的真实标签。
 * 优先使用清单回写的 label；旧缓存没有 label 时，按合并器的短哈希规则匹配 `源名#hash`。
 * 这里不做“同名即匹配”，避免同名不同源串源。
 */
export function liveProxyEntryLabel(
  entry: LiveProxyManifestEntry,
  groups: readonly TVBoxLiveGroup[],
): string {
  const explicit = (entry.label || "").trim();
  if (explicit) return explicit;

  const name = (entry.name || "").trim();
  const url = (entry.url || "").trim();
  if (!url) return name;

  // 兼容旧清单：合并器标签形如 `源名#短哈希`。旧清单没有 label，
  // 但 key 来自同一 URL 的 SHA-256 前 8 字节。这里只做哈希精确匹配。
  const hash = entry.key && /^[0-9a-f]{8,64}$/i.test(entry.key)
    ? entry.key.slice(0, 8).toLowerCase()
    : "";
  if (hash) {
    for (const group of groups) {
      for (const channel of group.channels || []) {
        for (const raw of channel.urls || []) {
          const value = (raw || "").trim();
          const idx = value.lastIndexOf("$");
          if (idx <= 0) continue;
          const label = value.slice(idx + 1);
          if (label.toLowerCase().endsWith("#" + hash)) return label;
        }
      }
    }
  }
  return name;
}

/**
 * 仅保留当前聚合快照仍存在的源入口。
 *
 * KV 没有物理删除 API；这里不批量写空值清文本，只压缩 manifest 的权威集合。
 * 路由在读取正文前必须按 manifest 的 textReady 资格复核，因此被裁剪的旧文本
 * 不会继续进入候选树、质量池或 /live/<key> 下发池，也不会浪费 KV 写配额。
 */
export async function pruneLiveProxyManifestToUrls(
  urls: readonly string[],
  storage: Storage,
): Promise<LiveProxyManifest> {
  const allowed = new Set(urls.map((url) => url.trim()).filter(Boolean));
  const previous = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  if (!previous) {
    return { version: LIVE_PROXY_MANIFEST_VERSION, signature: '[]', entries: [] };
  }
  const entries = sortManifestEntries(previous.entries.filter((entry) => allowed.has(entry.url)));
  const manifest = {
    version: LIVE_PROXY_MANIFEST_VERSION,
    signature: manifestSignature(entries),
    entries,
  };
  if (previous.signature !== manifest.signature) {
    await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify(manifest));
  }
  return manifest;
}

export async function listLiveProxyEntries(storage: Storage): Promise<LiveProxyManifestEntry[]> {
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  return rankManifestEntries(manifest?.entries ?? []).filter(isLiveProxyEntryDistributable);
}

export async function listAllLiveProxyEntries(storage: Storage): Promise<LiveProxyManifestEntry[]> {
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  return rankManifestEntries(manifest?.entries ?? []);
}

export async function removeLiveProxyEntry(key: string, storage: Storage): Promise<boolean> {
  const raw = await storage.get(KV_LIVE_PROXY_MANIFEST);
  const manifest = parseLiveProxyManifest(raw);
  if (!manifest) return false;
  const entries = manifest.entries.filter((entry) => entry.key !== key);
  if (entries.length === manifest.entries.length) return false;
  const next = sortManifestEntries(entries);
  await storage.put(KV_LIVE_PROXY_MANIFEST, JSON.stringify({ version: LIVE_PROXY_MANIFEST_VERSION, signature: manifestSignature(next), entries: next }));
  await storage.put(`${KV_LIVE_PREFIX}${key}`, '');
  return true;
}

export async function lookupLiveSource(key: string, storage: Storage): Promise<LiveProxySource | null> {
  const raw = await storage.get(`${KV_LIVE_PREFIX}${key}`);
  if (raw) return parseLiveProxySource(raw);
  const manifest = parseLiveProxyManifest(await storage.get(KV_LIVE_PROXY_MANIFEST));
  const entry = manifest?.entries.find((item) => item.key === key);
  if (!entry) return null;
  return {
    url: entry.url,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.ua ? { ua: entry.ua } : {}),
    ...(entry.header ? { header: entry.header } : {}),
  };
}

export async function lookupLiveUrl(key: string, storage: Storage): Promise<string | null> {
  return (await lookupLiveSource(key, storage))?.url ?? null;
}

export { LIVE_PROXY_TTL };
