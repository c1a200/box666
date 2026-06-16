import type { Storage } from './interface';

export class MemoryCachedStorage implements Storage {
  private delegate: Storage;
  private cache = new Map<string, { value: string | null; mtime: number }>();
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
    const val = await this.delegate.get(key);
    this.cache.set(key, { value: val, mtime: now });
    return val;
  }

  async put(key: string, value: string): Promise<void> {
    await this.delegate.put(key, value);
    this.cache.set(key, { value, mtime: Date.now() });
  }

  // Helper to clear cache (e.g. after sync completion)
  clear(): void {
    this.cache.clear();
  }
}
