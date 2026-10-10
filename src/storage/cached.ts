import type { Storage } from './interface';

interface CacheEntry {
  value: string | null;
  mtime: number;
  promise?: Promise<string | null>;
}

export class MemoryCachedStorage implements Storage {
  private delegate: Storage;
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(delegate: Storage, ttlMs = 15000) {
    this.delegate = delegate;
    this.ttlMs = ttlMs;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.cache.get(key);
    const now = Date.now();
    if (entry && (now - entry.mtime < this.ttlMs)) {
      return entry.value;
    }

    // 同一个 Worker 实例内的并发请求（并发下载/初始化等）
    // 共享一次底层 KV 读取，避免重复等待网络和拖垮 5 秒初始化窗口。
    if (entry?.promise) return entry.promise;

    const promise = this.delegate.get(key)
      .then((val) => {
        this.cache.set(key, { value: val, mtime: Date.now() });
        return val;
      })
      .catch((err) => {
        if (entry) {
          this.cache.set(key, { value: entry.value, mtime: entry.mtime });
        } else {
          this.cache.delete(key);
        }
        throw err;
      });

    this.cache.set(key, { value: entry?.value ?? null, mtime: entry?.mtime ?? 0, promise });
    return promise;
  }

  async put(key: string, value: string): Promise<void> {
    await this.delegate.put(key, value);
    this.cache.set(key, { value, mtime: Date.now() });
  }

  getDiagnostics(): Record<string, unknown> | Promise<Record<string, unknown>> {
    return this.delegate.getDiagnostics?.() ?? { mode: 'direct', remoteConfigured: false };
  }

  // Helper to clear cache (e.g. after sync completion)
  clear(): void {
    this.cache.clear();
  }
}