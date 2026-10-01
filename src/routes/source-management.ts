import { Hono } from 'hono';
import { KV_INLINE_PREFIX, KV_MANUAL_SOURCES } from '../core/config';
import { decodeConfigResponse } from '../core/decoder';
import { extractMultiRepoEntries, isMultiRepoConfig, parseConfigJson } from '../core/fetcher';
import { autoNameFromUrl, createSourceBackup, parseSourceList, splitPkUrl } from '../core/source-list-parser';
import type { AppConfig, SourceEntry } from '../core/types';
import type { Storage } from '../storage/interface';
import { verifyAdmin } from './admin-auth';

export interface SourceManagementDeps {
  storage: Storage;
  config: AppConfig;
  onDirty: () => Promise<void>;
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

  router.get('/admin/sources/export', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(createSourceBackup('tvbox-sources', sources));
  });

  router.post('/admin/sources/import', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    let body: { input?: string; mode?: 'merge' | 'replace' };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const input = body.input?.trim();
    if (!input) return c.json({ error: 'input is required' }, 400);

    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

    // 多行清单：源名 URL / URL 源名 / 只有 URL
    // 单行 URL 仍按“抓取配置”处理，Backup JSON 也在这里兼容。
    const listResult = parseSourceList(input);
    const looksLikeBackup = input.startsWith('{') || input.startsWith('[');
    const namedInlineList = listResult.entries.some((entry) => entry.explicitName) || listResult.entries.length > 1;
    if (!looksLikeBackup && (namedInlineList || listResult.invalid.length > 0)) {
      if (listResult.entries.length === 0) {
        return c.json({ error: 'No valid sources found', invalid: listResult.invalid }, 400);
      }

      const existingUrls = new Set(sources.map((source) => source.url));
      let added = 0;
      let duplicates = listResult.duplicates;
      const addedSources: string[] = [];

      for (const parsed of listResult.entries) {
        if (existingUrls.has(parsed.url)) {
          duplicates++;
          continue;
        }
        const entry: SourceEntry = { name: parsed.name, url: parsed.url };
        if (parsed.configKey) entry.configKey = parsed.configKey;
        sources.push(entry);
        existingUrls.add(parsed.url);
        addedSources.push(parsed.url);
        added++;
      }

      if (added > 0) {
        await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
        await onDirty();
      }
      return c.json({ type: 'list', added, duplicates, invalid: listResult.invalid, sources: addedSources });
    }

    // 无协议的 JSON 内容先尝试作为备份恢复，避免多行输入中的 JSON 被误判成纯文本。
    if (looksLikeBackup) {
      try {
        const parsedBackup = JSON.parse(input);
        const parsedRecord = parsedBackup && typeof parsedBackup === 'object' && !Array.isArray(parsedBackup)
          ? parsedBackup as Record<string, unknown>
          : null;
        if (parsedRecord && typeof parsedRecord.type === 'string' && parsedRecord.type !== 'tvbox-sources') {
          return c.json({ error: `Backup type mismatch: expected tvbox-sources, got ${parsedRecord.type}` }, 400);
        }
        const backupItems = Array.isArray(parsedBackup)
          ? parsedBackup
          : (parsedRecord && Array.isArray(parsedRecord.items))
            ? parsedRecord.items as unknown[]
            : null;
        if (backupItems) {
          const mode = body.mode === 'replace' ? 'replace' : 'merge';
          const existingUrls = new Set(sources.map((source) => source.url));
          const restored: SourceEntry[] = [];
          const restoredUrls = new Set<string>();
          let duplicates = 0;
          let invalid = 0;

          for (const item of backupItems) {
            if (!item || typeof item !== 'object') { invalid++; continue; }
            const record = item as Record<string, unknown>;
            const rawUrl = typeof record.url === 'string' ? record.url : '';
            const split = splitPkUrl(rawUrl, typeof record.configKey === 'string' ? record.configKey : undefined);
            if (!split.url) { invalid++; continue; }
            try { new URL(split.url); } catch { invalid++; continue; }
            if (restoredUrls.has(split.url)) { duplicates++; continue; }
            if (mode === 'merge' && existingUrls.has(split.url)) { duplicates++; continue; }
            const entry: SourceEntry = {
              name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : autoNameFromUrl(split.url),
              url: split.url,
            };
            if (split.configKey) entry.configKey = split.configKey;
            if (typeof record.disabled === 'boolean') entry.disabled = record.disabled;
            restored.push(entry);
            restoredUrls.add(split.url);
          }

          let nextSources: SourceEntry[];
          if (mode === 'replace') {
            // 替换模式必须真的带来源；空备份或全部无效时直接拒绝，避免误清空源列表。
            if (restored.length === 0) {
              return c.json({ error: 'Backup contains no valid sources', invalid }, 400);
            }
            nextSources = restored;
          } else {
            nextSources = [...sources, ...restored];
          }

          if (mode === 'replace' || restored.length > 0) {
            await storage.put(KV_MANUAL_SOURCES, JSON.stringify(nextSources));
            await onDirty();
          }
          return c.json({
            type: 'backup',
            mode,
            added: restored.length,
            duplicates,
            invalid,
            sources: restored.map((entry) => entry.url),
          });
        }
      } catch {
        // 继续走原有 JSON 配置解析。
      }
    }

    const isUrl = /^https?:\/\//i.test(input);
    let jsonText: string;
    let sourceUrl: string | null = null;
    let configKey: string | undefined;

    if (isUrl) {
      const split = splitPkUrl(input);
      sourceUrl = split.url;
      configKey = split.configKey || undefined;
      try {
        const resp = await fetch(sourceUrl!, {
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
