import type { Storage } from './interface';

export class CloudflareKVStorage implements Storage {
  private accountId: string;
  private namespaceId: string;
  private apiToken: string;
  private timeoutMs: number;

  constructor(accountId: string, namespaceId: string, apiToken: string, timeoutMs = 2500) {
    this.accountId = accountId.trim();
    this.namespaceId = namespaceId.trim();
    this.apiToken = apiToken.trim();
    this.timeoutMs = Math.max(500, timeoutMs);
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async get(key: string): Promise<string | null> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${encodeURIComponent(key)}`;
    try {
      const resp = await this.request(url, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });
      if (resp.status === 404) return null;
      if (!resp.ok) {
        throw new Error(`CF KV GET error: ${resp.status}`);
      }
      return await resp.text();
    } catch (err) {
      // 交给 HybridStorage 统一做降级和冷却；直接吞掉错误会让上层误以为
      // “远程没有这个 key”，从而在每次请求都重复等待网络超时。
      throw err;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${encodeURIComponent(key)}`;
    try {
      const resp = await this.request(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        },
        body: value
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`CF KV PUT error ${resp.status}: ${text}`);
      }
    } catch (err) {
      console.error(`[storage-cf] PUT ${key} failed:`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
