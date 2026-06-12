import type { Storage } from './interface';

export class CloudflareKVStorage implements Storage {
  private accountId: string;
  private namespaceId: string;
  private apiToken: string;

  constructor(accountId: string, namespaceId: string, apiToken: string) {
    this.accountId = accountId.trim();
    this.namespaceId = namespaceId.trim();
    this.apiToken = apiToken.trim();
  }

  async get(key: string): Promise<string | null> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${encodeURIComponent(key)}`;
    try {
      const resp = await fetch(url, {
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
      console.error(`[storage-cf] GET ${key} failed:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${encodeURIComponent(key)}`;
    try {
      const resp = await fetch(url, {
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
