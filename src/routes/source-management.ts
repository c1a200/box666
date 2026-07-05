import { Hono } from 'hono';
import { KV_INLINE_PREFIX, KV_MANUAL_SOURCES } from '../core/config';
import { decodeConfigResponse } from '../core/decoder';
import { extractMultiRepoEntries, isMultiRepoConfig, parseConfigJson } from '../core/fetcher';
import type { AppConfig, SourceEntry } from '../core/types';
import type { Storage } from '../storage/interface';
import { verifyAdmin } from './admin-auth';

export interface SourceManagementDeps {
  storage: Storage;
  config: AppConfig;
  onDirty: () => Promise<void>;
}

function autoNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('githubusercontent.com') || parsed.hostname.includes('github.com')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return parts[0];
      }
    }
    const pathname = parsed.pathname;
    const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
    const dotIdx = filename.lastIndexOf('.');
    const nameWithoutExt = dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
    if (nameWithoutExt && !/^\d+$/.test(nameWithoutExt)) {
      return nameWithoutExt;
    }
    return parsed.hostname;
  } catch {
    return 'Imported';
  }
}

function splitPkUrl(input: string, explicitKey?: string): { url: string; configKey: string } {
  let url = input.trim();
  let configKey = explicitKey?.trim() || '';
  const pkMatch = url.match(/;pk;(.+)$/);
  if (pkMatch) {
    configKey = configKey || pkMatch[1];
    url = url.replace(/;pk;.+$/, '');
  }
  return { url, configKey };
}

export function createSourceManagementRouter(deps: SourceManagementDeps): Hono {
  const { storage, config, onDirty } = deps;
  const router = new Hono();

  router.get('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(sources);
  });

  router.post('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    let body: { name?: string; url?: string; configKey?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const split = splitPkUrl(body.url || '', body.configKey);
    const url = split.url;
    if (!url) return c.json({ error: 'URL is required' }, 400);

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    if (sources.some((s) => s.url === url)) {
      return c.json({ error: 'Source already exists' }, 409);
    }

    const entry: SourceEntry = { name: body.name?.trim() || autoNameFromUrl(url), url };
    if (split.configKey) entry.configKey = split.configKey;
    sources.push(entry);
    await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
    await onDirty();

    return c.json({ success: true });
  });

  router.delete('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    let body: { url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources.filter((s) => s.url !== url)));
    await onDirty();

    return c.json({ success: true });
  });

  router.put('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    let body: { oldUrl?: string; name?: string; url?: string; configKey?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const oldUrl = body.oldUrl?.trim();
    if (!oldUrl) return c.json({ error: 'Old URL is required' }, 400);

    const split = splitPkUrl(body.url || '', body.configKey);
    const url = split.url;
    if (!url) return c.json({ error: 'URL is required' }, 400);

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    const index = sources.findIndex((s) => s.url === oldUrl);
    if (index === -1) return c.json({ error: 'Source not found' }, 404);
    if (sources.some((s, idx) => idx !== index && s.url === url)) {
      return c.json({ error: 'Source already exists' }, 409);
    }

    const entry = sources[index];
    entry.name = body.name?.trim() || autoNameFromUrl(url);
    entry.url = url;
    if (split.configKey) {
      entry.configKey = split.configKey;
    } else {
      delete entry.configKey;
    }

    await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
    await onDirty();

    return c.json({ success: true });
  });

  router.post('/admin/sources/toggle', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    let body: { url?: string; disabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    const entry = sources.find((s) => s.url === url);
    if (!entry) return c.json({ error: 'Source not found' }, 404);

    entry.disabled = !!body.disabled;
    await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
    await onDirty();

    return c.json({ success: true, disabled: entry.disabled });
  });

  router.post('/admin/sources/import', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    let body: { input?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const input = body.input?.trim();
    if (!input) return c.json({ error: 'input is required' }, 400);

    const isUrl = /^https?:\/\//i.test(input);
    let jsonText: string;
    let sourceUrl: string | null = null;
    let configKey: string | undefined;

    if (isUrl) {
      const split = splitPkUrl(input);
      sourceUrl = split.url;
      configKey = split.configKey || undefined;
      try {
        const resp = await fetch(sourceUrl, {
          headers: { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'okhttp/3.12.0' },
        });
        if (!resp.ok) return c.json({ error: `Fetch failed: HTTP ${resp.status}` }, 502);
        const buffer = await resp.arrayBuffer();
        jsonText = await decodeConfigResponse(buffer, configKey) || '';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Fetch failed: ${msg}` }, 502);
      }
    } else {
      jsonText = input;
    }

    const parsed = parseConfigJson(jsonText);
    if (!parsed) return c.json({ error: 'Failed to parse JSON' }, 400);

    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    const existingUrls = new Set(sources.map(s => s.url));
    let added = 0;
    let duplicates = 0;
    const addedSources: string[] = [];

    if (isMultiRepoConfig(parsed)) {
      const entries = extractMultiRepoEntries(parsed, 'Imported');
      for (const entry of entries) {
        if (entry.name === 'Imported') entry.name = autoNameFromUrl(entry.url);
        if (existingUrls.has(entry.url)) {
          duplicates++;
        } else {
          sources.push(entry);
          existingUrls.add(entry.url);
          addedSources.push(entry.url);
          added++;
        }
      }
      await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
      await onDirty();
      return c.json({ type: 'multi', added, duplicates, sources: addedSources });
    }

    if (sourceUrl) {
      if (existingUrls.has(sourceUrl)) {
        return c.json({ type: 'single', added: 0, duplicates: 1, sources: [] });
      }
      const entry: SourceEntry = { name: autoNameFromUrl(sourceUrl), url: sourceUrl };
      if (configKey) entry.configKey = configKey;
      sources.push(entry);
      await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
      await onDirty();
      return c.json({ type: 'single', added: 1, duplicates: 0, sources: [sourceUrl] });
    }

    const key = `${KV_INLINE_PREFIX}${Date.now()}`;
    await storage.put(key, jsonText);
    const inlineUrl = `inline://${key}`;
    sources.push({ name: 'Inline Config', url: inlineUrl });
    await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
    await onDirty();
    return c.json({ type: 'single', added: 1, duplicates: 0, sources: [inlineUrl] });
  });

  return router;
}
