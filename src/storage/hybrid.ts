// 本地优先 + 远程持久化存储。
//
// Render 等 Node 环境的本地 SQLite 只作为缓存，不能被视为持久化存储；
// 用户配置类 key 必须等远程 KV 写入成功后才向前端返回成功。高频、可重建的任务
// 状态仍采用后台合并同步，避免聚合进度写入拖慢请求或压垮远端 KV。

import type { Storage } from './interface';

const REMOTE_RETRY_COOLDOWN_MS = 60_000;

// 这些 key 保存用户配置或持久化运行参数。写入失败时必须让管理接口感知，
// 否则 Render 重启/重新部署后会像“配置消失”一样回到空值。
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

    if (CRITICAL_STORAGE_KEYS.has(key)) {
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

    // 可重建状态/进度采用尽力而为的合并后台同步，不阻塞应用请求。
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
    };
  }
}