// 本地优先 + 远程持久化存储。
//
// Render 等 Node 环境的本地 SQLite 只作为缓存，不能被视为持久化存储；
// 用户配置类 key 必须等远程 KV 写入成功后才向前端返回成功。远端 KV 只保存
// 用户配置和最终可下发结果，任务进度、探测缓存和可重建索引都留在本地，避免
// 定时测速/JAR 预热把 Cloudflare 免费额度耗尽。

import type { Storage } from './interface';

const REMOTE_RETRY_COOLDOWN_MS = 60_000;

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
  'live_merge_report',
  'live_source_cache',
  'live_runtime_txt',
  'live_runtime_txt_version',
  'live_runtime_empty_at',
  'search_quality_status',
]);

export const LOCAL_ONLY_STORAGE_PREFIXES = [
  'jar_bin:',
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
  private remoteWriteChain: Promise<void> = Promise.resolve();
  private flushing = false;
  private remoteUnavailableUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRemoteReadAt: string | undefined;
  private lastRemoteWriteAt: string | undefined;
  private lastRemoteError: string | undefined;
  private lastRemoteErrorAt: string | undefined;
  private skippedLocalOnlyWrites = 0;
  private lastSkippedLocalOnlyKey: string | undefined;
  private lastSkippedLocalOnlyAt: string | undefined;

  constructor(local: Storage, remote: Storage) {
    this.local = local;
    this.remote = remote;
  }

  private isRemoteCoolingDown(): boolean {
    return Date.now() < this.remoteUnavailableUntil;
  }

  private markRemoteSuccess(kind: 'read' | 'write'): void {
    if (kind === 'read') this.lastRemoteReadAt = new Date().toISOString();
    if (kind === 'write') this.lastRemoteWriteAt = new Date().toISOString();
    this.lastRemoteError = undefined;
    this.lastRemoteErrorAt = undefined;
    this.remoteUnavailableUntil = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private markRemoteFailure(err: unknown): void {
    this.remoteUnavailableUntil = Date.now() + REMOTE_RETRY_COOLDOWN_MS;
    this.lastRemoteError = errorMessage(err);
    this.lastRemoteErrorAt = new Date().toISOString();
    console.error(
      '[storage-hybrid] remote KV unavailable; using local storage only for 60s:',
      this.lastRemoteError,
    );

    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.remoteUnavailableUntil = 0;
        void this.flushRemoteWrites();
      }, REMOTE_RETRY_COOLDOWN_MS);
    }
  }

  // All remote writes go through one promise chain. This prevents a stale
  // background sync from landing after a newer critical config write.
  private enqueueRemoteWrite(key: string, value: string): Promise<void> {
    const task = this.remoteWriteChain.then(async () => {
      await this.remote.put(key, value);
      this.markRemoteSuccess('write');
    });
    this.remoteWriteChain = task.catch(() => undefined);
    return task;
  }

  private async flushRemoteWrites(): Promise<void> {
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

    if (isLocalOnlyStorageKey(key)) {
      this.skippedLocalOnlyWrites++;
      this.lastSkippedLocalOnlyKey = key;
      this.lastSkippedLocalOnlyAt = new Date().toISOString();
      return;
    }

    if (isCriticalStorageKey(key)) {
      // 关键配置必须同步写远端并确认成功；否则管理端不能误报“已保存”。
      // 先记录 pending，防止后台旧值同步完成后删除新值。
      this.pendingWrites.set(key, value);
      try {
        await this.enqueueRemoteWrite(key, value);
        if (this.pendingWrites.get(key) === value) this.pendingWrites.delete(key);
        return;
      } catch (err) {
        // 并发更新时只保留最新值，避免较旧的失败写入覆盖它。
        if (this.pendingWrites.get(key) === undefined) this.pendingWrites.set(key, value);
        this.markRemoteFailure(err);
        throw new Error(`配置已写入本机，但远端 KV 持久化失败：${errorMessage(err)}`);
      }
    }

    if (!isDurableStorageKey(key)) return;

    // 最终派生结果采用尽力而为的合并后台同步，不阻塞应用请求。
    this.pendingWrites.set(key, value);
    void this.flushRemoteWrites();
  }

  async getDiagnostics(): Promise<Record<string, unknown>> {
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
      criticalKeys: [...CRITICAL_STORAGE_KEYS],
      durableKeys: [...DURABLE_STORAGE_KEYS],
      localOnlyKeys: [...LOCAL_ONLY_STORAGE_KEYS],
      localOnlyPrefixes: [...LOCAL_ONLY_STORAGE_PREFIXES],
      skippedLocalOnlyWrites: this.skippedLocalOnlyWrites,
      lastSkippedLocalOnlyKey: this.lastSkippedLocalOnlyKey,
      lastSkippedLocalOnlyAt: this.lastSkippedLocalOnlyAt,
    };
  }
}