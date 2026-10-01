// 本地优先 + 远程持久化存储。
//
// Render 等 Node 环境以本机 SQLite（或 JSON 文件）为第一落点：先写本地保证服务可用，
// 再把用户配置和最终可下发结果同步到远端 KV。远端额度耗尽或暂不可用时，关键写入不再
// 中断聚合/管理保存，而是转入本地持久化 outbox，额度恢复后自动补传。任务进度、探测缓存
// 和可重建索引只留本地，避免定时测速/JAR 预热把 Cloudflare 免费额度耗尽。

import type { Storage } from './interface';

const REMOTE_RETRY_COOLDOWN_MS = 60_000;
const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// 本地持久化 outbox：远端 KV 额度耗尽或暂不可用时，待同步写入落在本机，
// 进程重启后仍可补传，避免“额度用尽 = Render 项目不可用”。
const OUTBOX_INDEX_KEY = '__hybrid_outbox_index';
const OUTBOX_VALUE_PREFIX = '__hybrid_outbox_value:';
const MAX_OUTBOX_KEYS = 64;

function outboxValueKey(key: string): string {
  return OUTBOX_VALUE_PREFIX + key;
}

// 用户配置或持久化运行参数：写入失败时必须让管理接口感知，否则 Render
// 重启/重新部署后会像“配置消失”一样回到空值。
export const CRITICAL_STORAGE_KEYS = new Set<string>([
  'manual_sources',
  'source_urls',
  'source_url_blacklist',
  'maccms_sources',
  'live_sources',
  'name_transform',
  'cloud_credentials',
  'credential_policy',
  'credential_encryption_key',
  'credential_distribution_enabled',
  'credential_distribution',
  'site_upstream_map',
  'site_contract_map',
  'search_quota',
  'cron_interval',
  'speed_test_enabled',
  'edge_proxies',
  'blacklist',
  'live_disabled',
  'live_merge_mode',
  'ignore_aggregated_lives',
  'smart_base_url_enabled',
  'site_probe_depth',
  'site_auto_clean',
  'dedup_config',
  'group_order',
  'bg_settings',
  'channel_probe_enabled',
  'search_quality_schedule',
]);

// 最终下发/恢复所需的派生结果。它们数量有界，变化频率低，允许后台同步；
// 远端额度不足时只会影响缓存重建，不会静默丢失用户配置。
export const DURABLE_STORAGE_KEYS = new Set<string>([
  'merged_config',
  'merged_config_full',
  'startup_site_pool',
  'last_update',
  'live_merged_data',
  'live_merged_txt',
  'live_merged_txt_version',
  'live_proxy_manifest',
  'search_quality_pool',
  'search_quality_snapshot',
  'search_quality_candidates',
]);

// 这些前缀属于最终结果/派生内容，而不是任务进度。
export const DURABLE_STORAGE_PREFIXES = [
  'inline_config_',
  'jar:',
  'live_txt:',
] as const;

// 明确排除：这些 key 高频、可重建，必须只写本地。
export const LOCAL_ONLY_STORAGE_KEYS = new Set<string>([
  'jar_ready_index',
  'source_health',
  'site_health_map',
  'site_snapshot',
  'builder_source_map',
  'agg_logs',
  'dirty_marker',
  'parse_health_report',
  'search_quota_report',
  'channel_probe_status',
  'channel_speed_map',
  'channel_merged_tree',
  'channel_runtime_tree',
  'live_merge_report',
  'live_source_cache',
  'live_runtime_txt',
  'live_runtime_txt_version',
  'live_runtime_empty_at',
  'search_quality_status',
  OUTBOX_INDEX_KEY,
]);

export const LOCAL_ONLY_STORAGE_PREFIXES = [
  'jar_bin:',
  OUTBOX_VALUE_PREFIX,
] as const;

function hasPrefix(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

export function isCriticalStorageKey(key: string): boolean {
  return CRITICAL_STORAGE_KEYS.has(key);
}

export function isLocalOnlyStorageKey(key: string): boolean {
  return LOCAL_ONLY_STORAGE_KEYS.has(key) || hasPrefix(key, LOCAL_ONLY_STORAGE_PREFIXES);
}

export function isDurableStorageKey(key: string): boolean {
  return DURABLE_STORAGE_KEYS.has(key) || hasPrefix(key, DURABLE_STORAGE_PREFIXES);
}

export function shouldSyncToRemote(key: string): boolean {
  if (isLocalOnlyStorageKey(key)) return false;
  return isCriticalStorageKey(key) || isDurableStorageKey(key);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function maskId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export class HybridStorage implements Storage {
  private local: Storage;
  private remote: Storage;

  // 同一个 key 只保留最后一次待同步值，避免聚合进度等高频写入造成请求堆积。
  private pendingWrites = new Map<string, string>();
  private remoteWriteChains = new Map<string, Promise<void>>();
  private flushing = false;
  private remoteUnavailableUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimerDeadline = 0;
  private remoteQuotaBlockedUntil: string | undefined;
  private lastWriteValues = new Map<string, string>();
  private lastRemoteReadAt: string | undefined;
  private lastRemoteWriteAt: string | undefined;
  private lastRemoteError: string | undefined;
  private lastRemoteErrorAt: string | undefined;
  private skippedLocalOnlyWrites = 0;
  private lastSkippedLocalOnlyKey: string | undefined;
  private lastSkippedLocalOnlyAt: string | undefined;
  private outboxLoadPromise: Promise<void> | undefined;
  private deferredCriticalWrites = 0;
  private lastDeferredCriticalKey: string | undefined;
  private lastDeferredCriticalAt: string | undefined;

  constructor(local: Storage, remote: Storage) {
    this.local = local;
    this.remote = remote;
  }

  private isRemoteCoolingDown(): boolean {
    return Date.now() < this.remoteUnavailableUntil;
  }

  private isRemoteQuotaCoolingDown(): boolean {
    if (!this.remoteQuotaBlockedUntil) return false;
    const until = Date.parse(this.remoteQuotaBlockedUntil);
    if (Number.isFinite(until) && Date.now() < until) return true;
    this.remoteQuotaBlockedUntil = undefined;
    return false;
  }

  private clearRemoteFailure(): void {
    this.lastRemoteError = undefined;
    this.lastRemoteErrorAt = undefined;
    this.remoteUnavailableUntil = 0;
    this.remoteQuotaBlockedUntil = undefined;
    this.retryTimerDeadline = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private markRemoteSuccess(kind: 'read' | 'write'): void {
    if (kind === 'read') this.lastRemoteReadAt = new Date().toISOString();
    if (kind === 'write') this.lastRemoteWriteAt = new Date().toISOString();
    // KV reads and writes have separate quotas. A successful read must not
    // clear an active write-quota cooldown, while a successful write proves
    // that writes are available again.
    if (kind === 'write' || !this.isRemoteQuotaCoolingDown()) {
      this.clearRemoteFailure();
    }
  }

  private markRemoteFailure(err: unknown): void {
    const now = Date.now();
    const message = errorMessage(err);
    const quotaLimited = /(?:^|\D)429(?:\D|$)|10048|free usage limit|usage limit/i.test(message);
    const cooldownMs = quotaLimited ? QUOTA_COOLDOWN_MS : REMOTE_RETRY_COOLDOWN_MS;
    const quotaCooling = this.isRemoteQuotaCoolingDown();
    this.lastRemoteError = message;
    this.lastRemoteErrorAt = new Date(now).toISOString();

    // Do not shorten an existing longer cooldown, and do not keep extending
    // a quota cooldown when repeat requests fail during the same outage.
    if (quotaLimited && !quotaCooling) {
      this.remoteUnavailableUntil = now + cooldownMs;
      this.remoteQuotaBlockedUntil = new Date(this.remoteUnavailableUntil).toISOString();
    } else if (!quotaLimited && !this.isRemoteCoolingDown()) {
      this.remoteUnavailableUntil = now + cooldownMs;
    }

    console.error(
      '[storage-hybrid] remote KV unavailable; using local storage only for ' +
        Math.round(cooldownMs / 1000) + 's' + (quotaLimited ? ' (CF daily quota):' : ':'),
      this.lastRemoteError,
    );

    if (this.remoteUnavailableUntil > this.retryTimerDeadline) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimerDeadline = this.remoteUnavailableUntil;
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = undefined;
          this.retryTimerDeadline = 0;
          this.remoteUnavailableUntil = 0;
          this.remoteQuotaBlockedUntil = undefined;
          void this.flushRemoteWrites();
        },
        Math.max(0, this.retryTimerDeadline - Date.now()),
      );
      // 不要让长额度冷却定时器单独吊住 Node 进程；服务本身由 HTTP server 保活。
      if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
    }
  }

  // Each key has its own write chain. Large background objects (for example a
  // full quality candidate snapshot) must never block a small critical config
  // save such as credential_distribution, while writes to the same key still
  // stay ordered.
  private enqueueRemoteWrite(key: string, value: string): Promise<void> {
    const previous = this.remoteWriteChains.get(key) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (this.lastWriteValues.get(key) === value) return;
      await this.remote.put(key, value);
      this.lastWriteValues.set(key, value);
      this.markRemoteSuccess('write');
    });
    const settled = task.catch(() => undefined);
    this.remoteWriteChains.set(key, settled);
    void settled.then(() => {
      if (this.remoteWriteChains.get(key) === settled) this.remoteWriteChains.delete(key);
    });
    return task;
  }

  private async flushRemoteWrites(): Promise<void> {
    if (!this.outboxLoadPromise) await this.ensureOutboxLoaded();
    if (this.flushing || this.isRemoteCoolingDown() || this.pendingWrites.size === 0) return;

    this.flushing = true;
    try {
      while (!this.isRemoteCoolingDown() && this.pendingWrites.size > 0) {
        const [key, value] = this.pendingWrites.entries().next().value as [string, string];
        try {
          await this.enqueueRemoteWrite(key, value);
          // 如果同步期间又写了新值，保留新值，下一轮继续同步。
          if (this.pendingWrites.get(key) === value) {
            this.pendingWrites.delete(key);
            await this.removePersisted(key);
          }
        } catch (err) {
          this.markRemoteFailure(err);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private ensureOutboxLoaded(): Promise<void> {
    if (!this.outboxLoadPromise) this.outboxLoadPromise = this.loadPersistedOutbox();
    return this.outboxLoadPromise;
  }

  private async loadPersistedOutbox(): Promise<void> {
    try {
      const raw = await this.local.get(OUTBOX_INDEX_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const key of parsed) {
            if (typeof key !== 'string' || this.pendingWrites.has(key)) continue;
            const value = await this.local.get(outboxValueKey(key));
            if (value !== null && value !== '') this.pendingWrites.set(key, value);
          }
        }
      }
      if (this.pendingWrites.size > 0) {
        console.log(`[storage-hybrid] restored ${this.pendingWrites.size} pending write(s) from local outbox`);
        setTimeout(() => { void this.flushRemoteWrites(); }, 0);
      }
    } catch (err) {
      console.warn('[storage-hybrid] failed to restore local outbox:', errorMessage(err));
    }
  }

  private async readOutboxKeys(): Promise<string[]> {
    try {
      const raw = await this.local.get(OUTBOX_INDEX_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  private async persistPending(key: string, value: string): Promise<void> {
    try {
      await this.local.put(outboxValueKey(key), value);
      const keys = await this.readOutboxKeys();
      if (!keys.includes(key)) keys.push(key);
      if (keys.length > MAX_OUTBOX_KEYS) {
        const dropped = keys.splice(0, keys.length - MAX_OUTBOX_KEYS);
        for (const stale of dropped) await this.local.put(outboxValueKey(stale), '');
      }
      await this.local.put(OUTBOX_INDEX_KEY, JSON.stringify(keys));
    } catch (err) {
      console.warn('[storage-hybrid] failed to persist local outbox entry:', errorMessage(err));
    }
  }

  private async removePersisted(key: string): Promise<void> {
    try {
      const keys = await this.readOutboxKeys();
      const next = keys.filter((k) => k !== key);
      if (next.length !== keys.length) await this.local.put(OUTBOX_INDEX_KEY, JSON.stringify(next));
      await this.local.put(outboxValueKey(key), '');
    } catch {
      // outbox 清理失败不影响主流程；下次 flush 会覆盖同一 key。
    }
  }

  private noteDeferredCritical(key: string): void {
    this.deferredCriticalWrites++;
    this.lastDeferredCriticalKey = key;
    this.lastDeferredCriticalAt = new Date().toISOString();
  }

  async get(key: string): Promise<string | null> {
    const localValue = await this.local.get(key);
    if (localValue !== null) return localValue;

    // 可重建缓存不能在重启后从远端恢复旧索引，否则会误判本地 JAR
    // 仍然存在，实际读取文件时又回退到慢速上游。
    if (isLocalOnlyStorageKey(key)) return null;

    if (this.isRemoteCoolingDown()) return null;

    try {
      const remoteValue = await this.remote.get(key);
      this.markRemoteSuccess('read');
      if (remoteValue !== null) {
        // 回填本地，后续请求不再依赖远程。
        await this.local.put(key, remoteValue);
      }
      return remoteValue;
    } catch (err) {
      this.markRemoteFailure(err);
      return null;
    }
  }

  async put(key: string, value: string): Promise<void> {
    await this.local.put(key, value);
    await this.ensureOutboxLoaded();

    if (isLocalOnlyStorageKey(key)) {
      this.skippedLocalOnlyWrites++;
      this.lastSkippedLocalOnlyKey = key;
      this.lastSkippedLocalOnlyAt = new Date().toISOString();
      return;
    }

    if (isCriticalStorageKey(key)) {
      // 关键配置以本机持久化为准：远端写入是尽力而为的补传。
      // 远端额度用尽或不可用时不再抛错，否则 Render 的聚合和管理保存会整体失败；
      // 待同步值进入本地 outbox，额度恢复后由 flushRemoteWrites 自动补传。
      this.pendingWrites.set(key, value);
      if (this.isRemoteCoolingDown()) {
        this.noteDeferredCritical(key);
        await this.persistPending(key, value);
        return;
      }
      try {
        await this.enqueueRemoteWrite(key, value);
        if (this.pendingWrites.get(key) === value) {
          this.pendingWrites.delete(key);
          await this.removePersisted(key);
        }
        return;
      } catch (err) {
        // 并发更新时只保留最新值，避免较旧的失败写入覆盖它。
        if (this.pendingWrites.get(key) === undefined) this.pendingWrites.set(key, value);
        this.markRemoteFailure(err);
        this.noteDeferredCritical(key);
        await this.persistPending(key, value);
        return;
      }
    }

    if (!isDurableStorageKey(key)) return;

    // 最终派生结果采用尽力而为的合并后台同步，不阻塞应用请求。
    this.pendingWrites.set(key, value);
    await this.persistPending(key, value);
    void this.flushRemoteWrites();
  }

  async getDiagnostics(): Promise<Record<string, unknown>> {
    await this.ensureOutboxLoaded();
    let remoteDiagnostics: Record<string, unknown> = {};
    try {
      remoteDiagnostics = (await this.remote.getDiagnostics?.()) || {};
    } catch (err) {
      this.lastRemoteError = errorMessage(err);
      this.lastRemoteErrorAt = new Date().toISOString();
    }

    const namespaceId = typeof remoteDiagnostics.namespaceId === 'string'
      ? remoteDiagnostics.namespaceId
      : undefined;

    return {
      mode: 'hybrid',
      remoteConfigured: true,
      namespace: maskId(namespaceId),
      remoteTimeoutMs: remoteDiagnostics.timeoutMs,
      lastRemoteReadAt: this.lastRemoteReadAt,
      lastRemoteWriteAt: this.lastRemoteWriteAt,
      lastRemoteError: this.lastRemoteError,
      lastRemoteErrorAt: this.lastRemoteErrorAt,
      pendingWrites: this.pendingWrites.size,
      pendingKeys: [...this.pendingWrites.keys()],
      remoteCoolingDown: this.isRemoteCoolingDown(),
      remoteQuotaBlockedUntil: this.remoteQuotaBlockedUntil,
      criticalKeys: [...CRITICAL_STORAGE_KEYS],
      durableKeys: [...DURABLE_STORAGE_KEYS],
      localOnlyKeys: [...LOCAL_ONLY_STORAGE_KEYS],
      localOnlyPrefixes: [...LOCAL_ONLY_STORAGE_PREFIXES],
      skippedLocalOnlyWrites: this.skippedLocalOnlyWrites,
      lastSkippedLocalOnlyKey: this.lastSkippedLocalOnlyKey,
      lastSkippedLocalOnlyAt: this.lastSkippedLocalOnlyAt,
      deferredCriticalWrites: this.deferredCriticalWrites,
      lastDeferredCriticalKey: this.lastDeferredCriticalKey,
      lastDeferredCriticalAt: this.lastDeferredCriticalAt,
      outboxPersisted: true,
    };
  }
}
