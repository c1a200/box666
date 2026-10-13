import type { Storage } from '../storage/interface';
import { KV_LIVE_PREPARE_INPUTS } from './config';
import type { LiveSourceInput } from './live-merger';
import { isBlockedLiveSource, partitionBlockedLiveSources } from './live-policy';

export interface LivePrepareInputSet {
  updatedAt: string;
  signature: string;
  sourceCount: number;
  sources: LiveSourceInput[];
}

function parseInput(value: unknown): LiveSourceInput | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return null;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'source';
  const ua = typeof record.ua === 'string' && record.ua.trim() ? record.ua.trim() : undefined;
  const header = record.header && typeof record.header === 'object'
    ? Object.fromEntries(
      Object.entries(record.header as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
    : undefined;
  return {
    name,
    url,
    ...(ua ? { ua } : {}),
    ...(header && Object.keys(header).length > 0 ? { header } : {}),
    ...(typeof record.speedMs === 'number' && Number.isFinite(record.speedMs) ? { speedMs: record.speedMs } : {}),
    ...(typeof record.isAggregated === 'boolean' ? { isAggregated: record.isAggregated } : {}),
  };
}

function coreUrl(url: string): string {
  return url.trim().replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
}

export function normalizeLivePrepareInputs(sources: readonly LiveSourceInput[]): LiveSourceInput[] {
  const seen = new Set<string>();
  const normalized: LiveSourceInput[] = [];
  for (const source of partitionBlockedLiveSources(sources).allowed) {
    const parsed = parseInput(source);
    if (!parsed) continue;
    const key = coreUrl(parsed.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(parsed);
  }
  return normalized;
}

export function collectLivePrepareInputs(
  aggregatedLives: readonly unknown[],
  manualSourcesRaw: string | null,
  options: { ignoreAggregated?: boolean } = {},
): LiveSourceInput[] {
  const sources: LiveSourceInput[] = [];
  if (!options.ignoreAggregated) {
    for (const raw of aggregatedLives) {
      if (!raw || typeof raw !== 'object') continue;
      const live = raw as Record<string, unknown>;
      if (typeof live.group === 'string' && !live.url && !live.api) continue;
      const url = typeof live.url === 'string' ? live.url : typeof live.api === 'string' ? live.api : '';
      const parsed = parseInput({ ...live, url, isAggregated: true });
      if (parsed) sources.push(parsed);
    }
  }
  if (manualSourcesRaw) {
    try {
      const manual = JSON.parse(manualSourcesRaw) as unknown;
      if (Array.isArray(manual)) {
        for (const raw of manual) {
          if (!raw || typeof raw !== 'object') continue;
          const source = raw as Record<string, unknown>;
          if (source.disabled === true) continue;
          const parsed = parseInput({ ...source, name: source.name || 'manual', isAggregated: false });
          if (parsed) sources.push(parsed);
        }
      }
    } catch {
      // Ignore malformed manual source data; the admin endpoint reports it separately.
    }
  }
  return normalizeLivePrepareInputs(sources);
}

export function parseLivePrepareInputs(raw: string | null): LivePrepareInputSet | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LivePrepareInputSet>;
    if (!Array.isArray(parsed.sources)) return null;
    const sources = normalizeLivePrepareInputs(parsed.sources as LiveSourceInput[]);
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      signature: typeof parsed.signature === 'string' ? parsed.signature : livePrepareInputSignature(sources),
      sourceCount: sources.length,
      sources,
    };
  } catch {
    return null;
  }
}

export function livePrepareInputSignature(sources: readonly LiveSourceInput[]): string {
  return normalizeLivePrepareInputs(sources).map((source) => coreUrl(source.url)).sort().join('\n');
}

export async function persistLivePrepareInputs(
  sources: readonly LiveSourceInput[],
  storage: Storage,
): Promise<LivePrepareInputSet> {
  const normalized = normalizeLivePrepareInputs(sources);
  const value: LivePrepareInputSet = {
    updatedAt: new Date().toISOString(),
    signature: livePrepareInputSignature(normalized),
    sourceCount: normalized.length,
    sources: normalized,
  };
  await storage.put(KV_LIVE_PREPARE_INPUTS, JSON.stringify(value));
  return value;
}

export async function loadLivePrepareInputs(storage: Storage): Promise<LivePrepareInputSet | null> {
  return parseLivePrepareInputs(await storage.get(KV_LIVE_PREPARE_INPUTS));
}

export async function persistCollectedLivePrepareInputs(
  aggregatedLives: readonly unknown[],
  manualSourcesRaw: string | null,
  storage: Storage,
  options: { ignoreAggregated?: boolean } = {},
): Promise<LivePrepareInputSet> {
  const collected = collectLivePrepareInputs(aggregatedLives, manualSourcesRaw, options)
    .filter((source) => !isBlockedLiveSource(source));
  return persistLivePrepareInputs(collected, storage);
}
