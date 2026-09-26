// 本地优先 + 远程尽力同步存储
//
// 用途：Render 等 Node 环境继续使用本地 SQLite/JSON 作为主存储，
// 同时把写入尽力同步到 Cloudflare KV，读取时本地优先、远程兜底。
// 远程 KV 不可用不会导致本地服务不可用。
//
// Render 与 Cloudflare Worker 使用各自的 CF_KV_NAMESPACE_ID 即可保持数据独立，
// 本层不额外改 key，避免破坏已有 namespace 内的数据。

import type { Storage } from './interface';

const REMOTE_RETRY_COOLDOWN_MS = 60_000;

export class HybridStorage implements Storage {
  private local: Storage;
  private remote: Storage;

  // 同一个 key 只保留最后一次待同步值，避免聚合进度等高频写入造成请求堆积。
  private pendingWrites = new Map<string, string>();
  private flushing = false;
  private remoteUnavailableUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(local: Storage, remote: Storage) {
    this.local = local;
    this.remote = remote;
  }

  private isRemoteCoolingDown(): boolean {
    return Date.now() < this.remoteUnavailableUntil;
  }

  private markRemoteFailure(err: unknown): void {
    this.remoteUnavailableUntil = Date.now() + REMOTE_RETRY_COOLDOWN_MS;
    console.error(
      '[storage-hybrid] remote KV unavailable; using local storage only for 60s:',
      err instanceof Error ? err.message : String(err),
    );

    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.remoteUnavailableUntil = 0;
        void this.flushRemoteWrites();
      }, REMOTE_RETRY_COOLDOWN_MS);
    }
  }

  private async flushRemoteWrites(): Promise<void> {
    if (this.flushing || this.isRemoteCoolingDown() || this.pendingWrites.size === 0) return;

    this.flushing = true;
    try {
      while (!this.isRemoteCoolingDown() && this.pendingWrites.size > 0) {
        const [key, value] = this.pendingWrites.entries().next().value as [string, string];
        try {
          await this.remote.put(key, value);
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
    // 本地写入是成功条件，必须先完成。
    await this.local.put(key, value);

    // 远程同步是尽力而为：合并同 key 的最新值，后台执行，不阻塞 Render 请求。
    this.pendingWrites.set(key, value);
    void this.flushRemoteWrites();
  }
}