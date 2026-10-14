// Cloudflare KV 适配

import type { Storage } from './interface';

export class KVStorage implements Storage {
  private writeStats = { put: 0, skipped: 0 };

  constructor(private kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async putForced(key: string, value: string): Promise<void> {
    await this.kv.put(key, value);
    this.writeStats.put++;
  }

  async put(key: string, value: string): Promise<void> {
    // Cloudflare 免费版 KV 每日写入配额很小（约 1000 次）。定时任务若反复
    // 提交完全相同的时间戳/状态，会很快耗尽配额并让聚合与直播预热停摆。
    // 这里先读后比，值未变化直接跳过写；多一次读换取更宝贵的写额度。
    const previous = await this.kv.get(key);
    if (previous === value) {
      this.writeStats.skipped++;
      return;
    }
    await this.kv.put(key, value);
    this.writeStats.put++;
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      mode: 'cloudflare-kv',
      remoteConfigured: true,
      kvPut: this.writeStats.put,
      kvPutSkippedUnchanged: this.writeStats.skipped,
    };
  }
}
