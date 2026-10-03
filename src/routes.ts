// Hono 统一路由层

import { Hono } from 'hono';
import { MemoryCachedStorage } from './storage/cached';
import type { Storage } from './storage/interface';
import type { AppConfig, MacCMSSourceEntry, LiveSourceEntry, NameTransformConfig, EdgeProxyConfig, SearchQualityRunMode } from './core/types';
import { KV_MERGED_CONFIG, KV_MERGED_CONFIG_FULL, KV_STARTUP_SITE_POOL, KV_MANUAL_SOURCES, KV_LAST_UPDATE, KV_LAST_UPDATE_ERROR, KV_MACCMS_SOURCES, KV_LIVE_SOURCES, KV_LIVE_MERGED_DATA, KV_LIVE_MERGED_TXT, KV_LIVE_MERGED_TXT_FALLBACK, KV_LIVE_MERGED_TXT_VERSION, KV_LIVE_RUNTIME_TXT, KV_LIVE_RUNTIME_TXT_VERSION, KV_LIVE_RUNTIME_EMPTY_AT, KV_BLACKLIST, LIVE_PROXY_TTL, IMG_PROXY_TTL, KV_NAME_TRANSFORM, KV_CRON_INTERVAL, DEFAULT_CRON_INTERVAL, KV_SOURCE_HEALTH, KV_SPEED_TEST_ENABLED, KV_EDGE_PROXIES, KV_SEARCH_QUOTA_REPORT, KV_PARSE_HEALTH_REPORT, KV_AGG_LOGS, KV_BG_SETTINGS, KV_DEDUP_CONFIG, KV_LIVE_DISABLED, KV_LIVE_MERGE_MODE, KV_IGNORE_AGGREGATED_LIVES, KV_SMART_BASE_URL_ENABLED, KV_SITE_PROBE_DEPTH, KV_SITE_AUTO_CLEAN, KV_SITE_HEALTH_MAP, KV_CHANNEL_RUNTIME_TREE, KV_LIVE_TEXT_PREFIX, KV_CREDENTIAL_DISTRIBUTION, KV_CREDENTIAL_DISTRIBUTION_ENABLED, KV_SEARCH_QUALITY_CANDIDATES, KV_SITE_UPSTREAM_MAP, KV_SITE_CONTRACT_MAP } from './core/config';
import { getRequestBaseUrl, applyBaseUrlPlaceholder, assertHostAllowed } from './core/base-url';
import { logger } from './core/logger';
import { loadGroupOrder, saveGroupOrder } from './core/group-order';
import { validateMacCMS } from './core/maccms';
import { applyLegacyWoggCompatibility } from './core/cf-compat';
import { lookupJarUrl, isMd5Key, base64ToUint8Array, rewriteJarUrls, normalizeJarRequestKey, loadJarReadyKeys, markJarReady, getJarKeyForSite } from './core/jar-proxy';
import { BASE_URL_PLACEHOLDER } from './core/config';
import { lookupLiveSource, listLiveProxyEntries, removeLiveProxyEntry } from './core/live-source';
import { adminHtml } from './core/admin';
import { dashboardHtml } from './core/dashboard';
import { configEditorHtml } from './core/config-editor';
import { siteFingerprint, loadBlacklist, saveBlacklist, saveRegexRule, deleteRegexRule, updateRegexRule, validateRegexRule, testRegexAgainstSites, applyBlacklist } from './core/blacklist';
import { loadSearchQuota, saveSearchQuota } from './core/search-quota';
import {
  loadQualityCandidates,
  loadQualityPool,
  loadQualitySchedule,
  loadQualitySnapshot,
  loadQualityStatus,
  saveQualitySchedule,
  updateQualityStatus,
  excludedQualityKeys,
  candidateKeysFromPool,
} from './core/quality';
import { isPanInitCredentialDistributable, loadCredentials, saveCredential, deleteCredential, loadCredentialPolicy, saveCredentialPolicy, normalizeCredentialInput, prepareQuarkCookie, credentialRevision, loadCredentialDistribution, saveCredentialDistribution, findCredentialAuthCode, normalizeCredentialDistributionConfig, CLOUD_PLATFORMS, createCredentialAuthCode } from './core/credential-store';
import { isSiteProbeable } from './core/speedtest';
import { generateQR, pollQRStatus, passwordLogin, PLATFORM_NAMES, QR_PLATFORMS, PASSWORD_PLATFORMS } from './core/cloud-login';
import { assessAllSources, isClientCredentialSite } from './core/credential-risk';
import { generateTokenJson, generateTvfanConfig, injectAListDriveCredentials, injectCredentials } from './core/credential-injector';
import type { SiteContract } from './core/types';
import { stripInjectedCredentialsFromConfig, stripUpstreamCredentialEntries } from './core/credential-sanitizer';
import { formatAggregatedLiveGroupsAsTxt, formatLiveGroupsAsTxt, filterLivesBySource, filterLivesBySourceDetailed, sortLiveGroupsForOutput } from './core/live-merger';
import { containsBlockedLiveUrl, isBlockedLiveSource, isBlockedLiveUrl } from './core/live-policy';
import { autoNameFromUrl, backupTypeMismatch, createSourceBackup, extractBackupItems, parseSourceList } from './core/source-list-parser';
import type { TVBoxConfig, TVBoxSite, SearchQuotaConfig, SiteQualityGrade, CloudPlatform, CloudCredential, TVBoxLive, TVBoxLiveGroup, CredentialAuthCode, CredentialDistributionConfig, CredentialDistributionMode } from './core/types';
import { mountChannelProbeRoutes } from './routes/channel-probe-admin';
import { loadSpeedMap as loadChannelSpeedMap } from './core/channel-probe';
import { createLogViewerRouter } from './routes/log-viewer';
import { createStaticAssetsRouter } from './routes/static-assets';
import { clearDirtyMarker, getDirtyMarker, setDirtyMarker } from './core/dirty-marker';
import { createSourceManagementRouter } from './routes/source-management';
import * as QRCode from 'qrcode';

export interface AggregationTriggerResult {
  started: boolean;
  running: boolean;
  completed: boolean;
  skipped?: boolean;
  timedOut?: boolean;
  abandoned?: boolean;
  runId?: string;
  startedAt?: string;
  phase?: string;
  elapsedMs?: number;
  message?: string;
}

export interface AggregationStatusResult extends AggregationTriggerResult {
  lastResult?: AggregationTriggerResult | null;
}

export interface AppDeps {
  storage: Storage;
  config: AppConfig;
  triggerRefresh: () => Promise<AggregationTriggerResult | void>;
  triggerQuality?: (mode: SearchQualityRunMode) => Promise<void>;   // Node/Docker 入口启用质量分级
  onCronIntervalChange?: (intervalMinutes: number) => void;
  enableChannelProbe?: boolean; // 仅 Node/Docker 入口启用
  enableBuilder?: boolean;      // 仅 Node/Docker 入口启用（配置构建器）
  isSyncing?: () => boolean;
  aggregationStatus?: () => AggregationStatusResult | Promise<AggregationStatusResult>;
}

const ALIST_PROXY_MAX_BYTES = 2 * 1024 * 1024;
const ALIST_PROXY_TIMEOUT_MS = 8000;
const ALIST_PROXY_MAX_REDIRECTS = 5;

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number(part));
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = octets;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (host.includes(':')) {
    return (
      host === '::' ||
      host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb') ||
      host.startsWith('fc') || host.startsWith('fd') || host.startsWith('ff')
    );
  }
  return false;
}

function validatePublicHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    if (isPrivateOrLocalHostname(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchAListJson(rawUrl: string): Promise<Record<string, any>> {
  let current = validatePublicHttpUrl(rawUrl);
  if (!current) throw new Error('invalid_url');

  for (let redirects = 0; redirects <= ALIST_PROXY_MAX_REDIRECTS; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ALIST_PROXY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'TVBox-AList-Credential-Proxy/1.0' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === ALIST_PROXY_MAX_REDIRECTS) throw new Error('invalid_redirect');
      current = validatePublicHttpUrl(new URL(location, current).toString());
      if (!current) throw new Error('invalid_redirect');
      continue;
    }
    if (!response.ok) throw new Error('upstream_' + response.status);

    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > ALIST_PROXY_MAX_BYTES) throw new Error('too_large');
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > ALIST_PROXY_MAX_BYTES) throw new Error('too_large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('invalid_json');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
    return parsed as Record<string, any>;
  }
  throw new Error('too_many_redirects');
}

function macCMSKeyFromUrl(url: string, used: Set<string>): string {
  let base = autoNameFromUrl(url).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base || /^\d+$/.test(base)) base = 'maccms';
  let key = base;
  let suffix = 1;
  while (used.has(key)) {
    suffix++;
    key = `${base}-${suffix}`;
  }
  used.add(key);
  return key;
}

function normalizeImportedMacCMS(parsed: unknown): MacCMSSourceEntry[] {
  const rawItems = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : []);
  const result: MacCMSSourceEntry[] = [];
  const usedKeys = new Set<string>();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const api = typeof record.api === 'string' ? record.api.trim() : '';
    if (!api) continue;
    try {
      const parsedUrl = new URL(api);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : autoNameFromUrl(api);
    const key = typeof record.key === 'string' && record.key.trim() ? record.key.trim() : macCMSKeyFromUrl(api, usedKeys);
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    const entry: MacCMSSourceEntry = { key, name, api };
    if (typeof record.disabled === 'boolean') entry.disabled = record.disabled;
    result.push(entry);
  }
  return result;
}

function normalizeImportedLives(parsed: unknown): LiveSourceEntry[] {
  const root = parsed as { lives?: unknown } | null;
  const rawLives = Array.isArray(parsed)
    ? parsed
    : root && typeof root === 'object' && Array.isArray(root.lives)
      ? root.lives
      : [];

  const result: LiveSourceEntry[] = [];
  for (const item of rawLives) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rawUrl = typeof record.url === 'string'
      ? record.url
      : typeof record.api === 'string'
        ? record.api
        : '';
    const url = rawUrl.trim();
    if (!url) continue;

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue;
    } catch {
      continue;
    }

    const entry: LiveSourceEntry = {
      name: typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : autoNameFromUrl(url),
      url,
    };
    if (typeof record.disabled === 'boolean') entry.disabled = record.disabled;
    if (isBlockedLiveSource(entry)) continue;
    result.push(entry);
  }
  return result;
}

function filterBlockedLiveEntries(lives: TVBoxLive[]): TVBoxLive[] {
  const result: TVBoxLive[] = [];
  for (const live of lives) {
    if (Array.isArray(live.channels)) {
      const channels = live.channels
        .map((channel) => ({
          ...channel,
          urls: channel.urls.filter((url) => !isBlockedLiveUrl(url)),
        }))
        .filter((channel) => channel.urls.length > 0);
      if (channels.length > 0) result.push({ ...live, channels });
      continue;
    }

    const url = live.url || live.api || '';
    if (!isBlockedLiveSource({ name: live.name, url })) result.push(live);
  }
  return result;
}

function isNativeLiveGroups(lives: unknown): lives is TVBoxLiveGroup[] {
  if (!Array.isArray(lives)) return false;

  return lives.every((live) => {
    if (!live || typeof live !== 'object') return false;

    const group = (live as { group?: unknown }).group;
    const channels = (live as { channels?: unknown }).channels;
    if (typeof group !== 'string' || !Array.isArray(channels)) return false;

    return channels.every((channel) => {
      if (!channel || typeof channel !== 'object') return false;
      const name = (channel as { name?: unknown }).name;
      const urls = (channel as { urls?: unknown }).urls;
      return typeof name === 'string'
        && Array.isArray(urls)
        && urls.every((url) => typeof url === 'string');
    });
  });
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  const rawStorage = deps.storage;
  const storage = new MemoryCachedStorage(rawStorage);

  const origTriggerRefresh = deps.triggerRefresh;
  deps.triggerRefresh = async () => {
    const result = await origTriggerRefresh();
    storage.clear();
    return result ?? {
      started: true,
      running: false,
      completed: true,
      message: 'Refresh completed',
    };
  };

  const { config } = deps;

  // 同一 Worker 实例内合并直播刷新，避免并发请求重复下载同一批直播源。
  const liveRuntimeRefreshes = new Map<string, Promise<Response | null>>();

  async function proxyBilibiliQR(pathAndQuery: string, init: RequestInit = {}): Promise<{ data?: any; error?: string; status?: number }> {
    const base = config.bilibiliQrProxyBaseUrl?.replace(/\/+$/, '');
    if (!base) return {};
    const headers = new Headers(init.headers);
    headers.set('X-Bilibili-QR-Proxy', '1');
    const token = config.bilibiliQrProxyToken || config.adminToken;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    try {
      const resp = await fetch(base + pathAndQuery, {
        ...init,
        headers,
      });
      const text = await resp.text();
      let data: any = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || `HTTP ${resp.status}` }; }
      if (!resp.ok) {
        return { error: data.error || data.message || `Bilibili QR proxy failed: HTTP ${resp.status}`, status: resp.status };
      }
      return { data };
    } catch (err) {
      return { error: `Bilibili QR proxy failed: ${err instanceof Error ? err.message : String(err)}`, status: 502 };
    }
  }

  async function markOutputDirty(): Promise<void> {
    await setDirtyMarker(storage);
    await storage.put(KV_LIVE_RUNTIME_EMPTY_AT, '');
    storage.clear();
  }

  let credentialRefreshPromise: Promise<void> | null = null;

  // ─── 客户端鉴权与凭证分发上下文 ─────────────────────────
  //
  // 根链接使用 defaultCredentialMode / defaultPlatforms；启用强制鉴权后根链接
  // 直接 401。带鉴权链接形如 /auth/<code>/...，由对应鉴权码决定凭证下发策略。
  // 鉴权码只出现在 URL 路径中，绝不接受查询参数，避免被 Referer/日志记录。
  interface ClientAuthContext {
    distribution: CredentialDistributionConfig;
    authCode?: CredentialAuthCode;
    mode: CredentialDistributionMode;
    platforms: CloudPlatform[];
    /** 用于生成客户端链接的基地址，含 /auth/<code> 前缀（如有）。 */
    effectiveBaseUrl: string;
    /** 客户端请求的根地址（不含鉴权前缀）。 */
    rootBaseUrl: string;
    /** /auth/<code> 前缀（以斜杠开头），根链接为空字符串。 */
    authPrefix: string;
  }

  interface ClientAuthFailure {
    status: number;
    message: string;
    code: string;
  }

  const AUTH_PATH_RE = /^\/auth\/([^/]+)(\/.*)?$/;

  /**
   * Reject unauthenticated sub-resource requests (JAR/live/API) before they
   * reach the proxy handlers. Valid /auth/<code>/... paths are resolved into a
   * context so downstream URL builders can keep the auth prefix.
   */
  async function resolveOrRejectClientContext(
    c: any,
    rootBaseUrl: string,
  ): Promise<{ context?: ClientAuthContext; response?: Response }> {
    const resolved = await resolveClientAuthContext(c, rootBaseUrl);
    if (resolved.failure) {
      return { response: credentialAuthFailureResponse(c, resolved.failure) };
    }
    return { context: resolved.context! };
  }

  /**
   * Rewrite one client resource URL to include the current auth prefix.
   * Only project-owned resource paths are rewritten. Credential URLs are left
   * untouched because they are generated with effectiveBaseUrl already.
   */
  function applyAuthPrefixToProxyUrl(value: string, context: ClientAuthContext): string {
    if (!value || !context.authPrefix) return value;
    const prefix = context.authPrefix.replace(/\/+$/, '');
    const root = context.rootBaseUrl.replace(/\/+$/, '');

    try {
      const parsed = new URL(value);
      if (parsed.origin !== new URL(root).origin) return value;
      if (parsed.pathname === '/api/bg-settings') return value;
      if (/^\/auth\/[^/]+\//.test(parsed.pathname)) return value;
      if (!/^\/(?:jar\/|live(?:\/|$)|live\.json$|api\/)/.test(parsed.pathname)) return value;
      parsed.pathname = `${prefix}${parsed.pathname}`;
      return parsed.toString();
    } catch {
      // Relative resource URLs are also used by TVBox/影视仓 configs.
      const relativePath = value.split(/[?#]/, 1)[0];
      if (relativePath === '/api/bg-settings') return value;
      if (/^\/auth\/[^/]+\//.test(value)) return value;
      if (!/^\/(?:jar\/|live(?:\/|$)|live\.json$|api\/)/.test(relativePath)) return value;
      return `${prefix}${value}`;
    }
  }

  /**
   * Rewrite nested TVBox config fields. Doing this structurally avoids leaking
   * auth-code routes into unrelated strings and correctly handles ext/extend.
   */
  function applyAuthPrefixToConfigNode(node: any, context: ClientAuthContext, key = ''): any {
    if (typeof node === 'string') {
      const normalizedKey = key.toLowerCase();
      if ((normalizedKey === 'ext' || normalizedKey === 'extend') && node.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(node);
          if (parsed && typeof parsed === 'object') {
            return JSON.stringify(applyAuthPrefixToConfigNode(parsed, context, normalizedKey));
          }
        } catch { /* Keep non-JSON ext untouched. */ }
      }
      const resourceKey = /^(?:api|url|jar|spider|lives?|parses?|urls?)$/.test(normalizedKey);
      if (!resourceKey) return node;
      return applyAuthPrefixToProxyUrl(node, context);
    }
    if (Array.isArray(node)) return node.map((item) => applyAuthPrefixToConfigNode(item, context, key));
    if (!node || typeof node !== 'object') return node;
    const next: Record<string, any> = {};
    for (const [childKey, childValue] of Object.entries(node)) {
      next[childKey] = applyAuthPrefixToConfigNode(childValue, context, childKey);
    }
    return next;
  }

  /**
   * Rewrite root-relative proxy resources to include the current auth prefix.
   * JSON parsing keeps ext/extend and platform credential fields intact.
   */
  function applyAuthPrefixToProxyUrls(raw: string, context: ClientAuthContext): string {
    if (!raw || !context.authPrefix) return raw;
    try {
      return JSON.stringify(applyAuthPrefixToConfigNode(JSON.parse(raw), context));
    } catch {
      // Last-resort fallback for malformed/legacy payloads.
      const prefix = context.authPrefix.replace(/\/+$/, '');
      const root = context.rootBaseUrl.replace(/\/+$/, '');
      const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return raw.replace(new RegExp(String.raw`(^|[?"'\s([=,:])${escapedRoot}(/jar/|/live(?:/[^?"'\s]*)?|/live\.json|/api/[^?"'\s]*)`, 'g'),
        (_m, lead: string, path: string) => `${lead}${root}${prefix}${path}`)
        .replace(/(["'])(\/(?:jar\/|live(?:\/|\b)|live\.json|api\/)[^"']*)\1/g,
          (_m, quote: string, path: string) => `${quote}${prefix}${path}${quote}`);
    }
  }

  /** Apply base URL, credential policy, then auth-prefix rewriting. */
  async function applyClientContextToConfigBody(raw: string, context: ClientAuthContext): Promise<string> {
    let body = applyBaseUrlPlaceholder(raw, context.rootBaseUrl);
    body = await applyCredentialPolicyToResponseBody(body, context);
    return applyAuthPrefixToProxyUrls(body, context);
  }

  function modePlatforms(
    mode: CredentialDistributionMode,
    selected: CloudPlatform[],
  ): CloudPlatform[] {
    if (mode === 'none') return [];
    if (mode === 'all') return [...CLOUD_PLATFORMS];
    return selected.filter((platform): platform is CloudPlatform => (CLOUD_PLATFORMS as string[]).includes(platform));
  }

  /**
   * 解析客户端鉴权上下文。rootBaseUrl 为不含 /auth/<code> 的部署根地址。
   * 返回 { context } 或 { failure }。
   */
  async function resolveClientAuthContext(
    c: import('hono').Context,
    rootBaseUrl: string,
  ): Promise<{ context?: ClientAuthContext; failure?: ClientAuthFailure }> {
    const distribution = await loadCredentialDistribution(storage);
    const path = c.req.path;
    const match = AUTH_PATH_RE.exec(path);

    if (!match) {
      // 根链接：强制鉴权开启时必须拒绝。
      if (distribution.requireAuth) {
        return {
          failure: {
            status: 401,
            code: 'auth_required',
            message: 'Authentication required. Use a /auth/<code>/ link or enable it in the admin console.',
          },
        };
      }
      return {
        context: {
          distribution,
          mode: distribution.defaultCredentialMode,
          platforms: modePlatforms(distribution.defaultCredentialMode, distribution.defaultPlatforms),
          effectiveBaseUrl: rootBaseUrl.replace(/\/+$/, ''),
          rootBaseUrl: rootBaseUrl.replace(/\/+$/, ''),
          authPrefix: '',
        },
      };
    }

    const rawCode = match[1];
    let authCodeValue = rawCode;
    try {
      authCodeValue = decodeURIComponent(rawCode);
    } catch {
      return { failure: { status: 401, code: 'invalid_code', message: 'Invalid authentication code.' } };
    }
    if (!authCodeValue || authCodeValue.includes('/')) {
      return { failure: { status: 401, code: 'invalid_code', message: 'Invalid authentication code.' } };
    }
    const authCode = findCredentialAuthCode(distribution, authCodeValue);
    if (!authCode) {
      // 配置了鉴权码但当前码不存在/被禁用时，不回退到根策略。
      return {
        failure: {
          status: 403,
          code: 'forbidden',
          message: 'Invalid or disabled authentication code.',
        },
      };
    }

    // 保留 /auth/<code> 前缀作为拼接其它端点的基础地址。
    const authPrefix = `/auth/${encodeURIComponent(authCode.code)}`;
    const base = rootBaseUrl.replace(/\/+$/, '');
    return {
      context: {
        distribution,
        authCode,
        mode: authCode.credentialMode,
        platforms: modePlatforms(authCode.credentialMode, authCode.platforms),
        effectiveBaseUrl: `${base}${authPrefix}`,
        rootBaseUrl: base,
        authPrefix,
      },
    };
  }

  /** 归一化后返回实际需要下发的凭证集合。 */
  function selectCredentialsForContext(
    credentials: Map<CloudPlatform, CloudCredential>,
    context: ClientAuthContext,
  ): Map<CloudPlatform, CloudCredential> {
    const allowed = new Set(context.platforms);
    const selected = new Map<CloudPlatform, CloudCredential>();
    if (context.mode === 'none') return selected;
    for (const [platform, credential] of credentials) {
      if (context.mode === 'all' || allowed.has(platform)) selected.set(platform, credential);
    }
    return selected;
  }

  function credentialSecretSet(credentials: Map<CloudPlatform, CloudCredential>): Set<string> {
    const set = new Set<string>();
    for (const credential of credentials.values()) {
      for (const value of Object.values(credential.credential || {})) {
        if (typeof value === 'string' && value.trim()) set.add(value.trim());
      }
    }
    return set;
  }

  /** 读取聚合阶段保存的启用总源边界；仅确有凭证下发时才读取契约指纹。 */
  async function loadSiteInjectionConstraints(includeContracts: boolean): Promise<{
    allowedSiteKeys: Set<string> | null;
    contractsBySiteKey: Map<string, SiteContract> | null;
  }> {
    let allowedSiteKeys: Set<string> | null = null;
    let contractsBySiteKey: Map<string, SiteContract> | null = null;

    const [upstreamRaw, contractRaw] = await Promise.all([
      storage.get(KV_SITE_UPSTREAM_MAP),
      includeContracts ? storage.get(KV_SITE_CONTRACT_MAP) : Promise.resolve(null),
    ]);

    if (upstreamRaw) {
      try {
        const parsed = JSON.parse(upstreamRaw) as { sites?: Record<string, unknown> };
        // 映射存在时，仅允许映射中实际存在来源的站点注入；即使映射为空也保持拒绝，
        // 避免空聚合结果误用旧的对外配置。
        allowedSiteKeys = new Set(Object.keys(parsed.sites || {}));
      } catch {
        allowedSiteKeys = null;
      }
    }

    if (contractRaw) {
      try {
        const parsed = JSON.parse(contractRaw) as { sites?: Record<string, SiteContract> };
        contractsBySiteKey = new Map(Object.entries(parsed.sites || {}));
      } catch {
        contractsBySiteKey = null;
      }
    }

    return { allowedSiteKeys, contractsBySiteKey };
  }

  /** none 策略下必须剥离已验证的上游凭证入口，否则 JAR 会绕过策略直接登录。 */
  function shouldStripUpstreamCredentialEntries(context: ClientAuthContext): boolean {
    return context.mode === 'none' || context.distribution.stripUpstreamCredentialEntries === true;
  }

  /** 按当前上下文重新注入凭证地址。 */
  async function applyCredentialPolicyToConfig(
    raw: string,
    allCredentials: Map<CloudPlatform, CloudCredential>,
    policy: Awaited<ReturnType<typeof loadCredentialPolicy>>,
    context: ClientAuthContext,
  ): Promise<string> {
    if (!raw) return raw;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sites)) return raw;

    // none 策略必须剥离上游公开凭证入口；显式开关在 all/selected 下同样生效。
    if (shouldStripUpstreamCredentialEntries(context)) {
      parsed = stripUpstreamCredentialEntries(
        parsed,
        typeof parsed.spider === 'string' ? parsed.spider : undefined,
        context.mode === 'none',
      );
    }

    const effective = selectCredentialsForContext(allCredentials, context);
    const constraints = await loadSiteInjectionConstraints(
      context.mode !== 'none' && effective.size > 0,
    );
    // 先清除历史注入的凭证/地址；本次允许的值保留，随后重新按策略注入。
    const allowedSecrets = context.mode === 'none' ? new Set<string>() : credentialSecretSet(effective);
    const stripped = stripInjectedCredentialsFromConfig(parsed, context.effectiveBaseUrl, allCredentials, allowedSecrets);
    const { sites } = injectCredentials(
      stripped.sites || [],
      effective,
      policy,
      context.effectiveBaseUrl,
      constraints.allowedSiteKeys,
      constraints.contractsBySiteKey,
      true,
      true,
      typeof parsed.spider === 'string' ? parsed.spider : undefined,
    );
    // 注入结果必须写回响应配置，否则凭证计算完成但客户端仍收到原 ext。
    parsed.sites = sites;
    // 顶层 token 与本次下发的平台绑定：有凭证才下发，none/无可用凭证时移除，
    // 避免旧根地址残留导致客户端在未授权时仍尝试拉取凭证。
    const tokenUrl = `${context.effectiveBaseUrl}/token.json`;
    if (context.mode === 'none' || effective.size === 0) {
      delete parsed.token;
    } else {
      parsed.token = tokenUrl;
    }

    applyLegacyWoggCompatibility(parsed);
    return JSON.stringify(parsed);
  }

  /** 响应侧按上下文重新注入凭证并返回。 */
  async function applyCredentialPolicyToResponseBody(
    raw: string,
    context: ClientAuthContext,
  ): Promise<string> {
    if (!raw) return raw;
    const credentials = await loadCredentials(storage);
    const policy = await loadCredentialPolicy(storage);
    return await applyCredentialPolicyToConfig(raw, credentials, policy, context);
  }

  function stripMissingCredentialUrls(raw: string, effectiveBaseUrl: string, credentials: Map<CloudPlatform, CloudCredential>): string {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    const stripped = stripInjectedCredentialsFromConfig(parsed, effectiveBaseUrl, credentials, new Set());
    return JSON.stringify(stripped);
  }

  /**
   * 后台直改 KV 的即时重注入已废弃：聚合结果现在只保存源本身，凭证在每次
   * 响应时按请求上下文动态注入，避免不同鉴权码互相污染。这里仅清理旧内容。
   */
  async function reinjectCredentialsIntoOutputs(): Promise<void> {
    const credentials = await loadCredentials(storage);
    const keys = [
      KV_MERGED_CONFIG,
      KV_MERGED_CONFIG_FULL,
      KV_STARTUP_SITE_POOL,
      KV_SEARCH_QUALITY_CANDIDATES,
    ];
    let updated = 0;
    for (const key of keys) {
      const raw = await storage.get(key);
      if (!raw) continue;
      const cleaned = stripMissingCredentialUrls(raw, (config.workerBaseUrl || config.localBaseUrl || '').replace(/\/+$/, ''), credentials);
      if (cleaned && cleaned !== raw) {
        await storage.put(key, cleaned);
        updated++;
      }
    }
    if (updated > 0) storage.clear();
    logger.infoFields('routes', 'credential-output-stripped', { keys: updated });
  }

  async function refreshAfterCredentialChange(c: any): Promise<void> {
    // 保存成功后只做本地失效标记；凭证清理和聚合刷新必须在后台执行。
    // 否则 Render 请求会一直等到整次聚合结束，浏览器最终误报“保存失败”。
    try {
      await markOutputDirty();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('routes', `Credential change dirty marker failed: ${msg}`);
      return;
    }

    const background = (async () => {
      try {
        if (!credentialRefreshPromise) {
          credentialRefreshPromise = (async () => {
            try {
              await reinjectCredentialsIntoOutputs();
            } catch (error: unknown) {
              const msg = error instanceof Error ? error.message : String(error);
              logger.warn('routes', `Immediate credential cleanup failed: ${msg}`);
            }
          })().finally(() => {
            credentialRefreshPromise = null;
          });
        }
        await credentialRefreshPromise;

        if (deps.isSyncing?.()) return;
        await deps.triggerRefresh();
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn('routes', `Credential change refresh failed: ${msg}`);
      }
    })();

    try {
      if (c.executionCtx) {
        c.executionCtx.waitUntil(background);
      } else {
        void background;
      }
    } catch {
      // Hono 在 Worker 运行时之外访问 executionCtx 会抛错，此时直接后台执行。
      void background;
    }
  }

  // ─── 本地字体（仅 Node 侧）──────────────────────────────
  if (!config.workerBaseUrl) {
    app.route('/', createStaticAssetsRouter());
  }

  app.route('/', createLogViewerRouter(config));

  // ─── 版本信息 ──────────────────────────────────────────
  app.get('/version', (c) => {
    const { APP_VERSION, APP_COMMIT } = require('./core/version');
    return c.json({ version: APP_VERSION, commit: APP_COMMIT });
  });

  app.get('/qr.svg', async (c) => {
    const data = c.req.query('data') || '';
    if (!data) return c.text('Missing data', 400);
    if (data.length > 2048) return c.text('Data too long', 400);

    const svg = await QRCode.toString(data, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 250,
    });

    return c.body(svg, 200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  // ─── 占位符替换辅助 ────────────────────────────────────
  async function resolveBaseUrl(c: import('hono').Context): Promise<string | Response> {
    const smartEnabled = (await storage.get(KV_SMART_BASE_URL_ENABLED)) === 'true';
    const dmzEnabled = process.env.DMZ === '0';
    const fallback = (config.localBaseUrl || '').replace(/\/$/, '');

    if (config.workerBaseUrl) {
      return config.workerBaseUrl.replace(/\/$/, '');
    } else if (smartEnabled) {
      const baseUrl = getRequestBaseUrl(c, fallback);
      if (!assertHostAllowed(baseUrl, fallback, dmzEnabled)) {
        logger.security('host-blocked', { host: baseUrl, fallback });
        return c.json({ error: 'Non-LAN access denied. Set DMZ=0 to allow.' }, 403);
      }
      return baseUrl;
    }
    return fallback;
  }

  /**
   * 从已验证的 CF 直播代理清单构建 FongMi 入口。
   * 清单是 CF 分离模式的唯一事实来源，不能再从旧 KV_LIVE_MERGED_DATA 恢复。
   */
  async function getCfSeparatedLives(): Promise<TVBoxLive[]> {
    if (!config.workerBaseUrl) return [];
    const entries = await listLiveProxyEntries(storage);
    const baseUrl = config.workerBaseUrl.replace(/\/$/, '');
    return entries.map((entry) => ({
      name: entry.name || '直播源',
      type: 0,
      url: `${baseUrl}/live/${entry.key}`,
    }));
  }

  /**
   * CF 分离模式兼容修复：
   * 旧版本可能把根配置里的 lives 写成单个 /live（聚合）指针。
   * 这里只使用当前已验证的代理清单生成多个 /live/<key>，不会复活旧入口。
   * Render 不进入此分支，保持原有行为。
   */
  async function repairCfSeparatedLives(cached: string): Promise<string> {
    if (!config.workerBaseUrl) return cached;

    const liveMergeMode = (await storage.get(KV_LIVE_MERGE_MODE)) || 'separated';
    if (liveMergeMode !== 'separated') return cached;

    let parsedConfig: TVBoxConfig;
    try {
      parsedConfig = JSON.parse(cached) as TVBoxConfig;
    } catch {
      return cached;
    }

    const currentLives = Array.isArray(parsedConfig.lives) ? parsedConfig.lives : [];
    const proxyLives = await getCfSeparatedLives();
    const currentUrls = currentLives.map((live) => (live.url || live.api || '').trim());
    const expectedUrls = proxyLives.map((live) => (live.url || live.api || '').trim());
    const alreadyUpToDate = currentUrls.length === expectedUrls.length
      && expectedUrls.every((url, index) => currentUrls[index] === url);
    if (alreadyUpToDate) return cached;

    parsedConfig.lives = proxyLives;
    const repaired = JSON.stringify(parsedConfig);
    // 读接口不应因持久化写失败而失败；KV 写额度耗尽时仍返回修正后的内存配置，
    // 后台聚合/下次成功写入会再落盘。
    try {
      await storage.put(KV_MERGED_CONFIG, repaired);
    } catch (error: unknown) {
      logger.warn('routes', 'CF separated lives repair persist failed: ' + (error instanceof Error ? error.message : String(error)));
    }
    console.log(`[routes] CF separated lives repaired: ${proxyLives.length} verified /live/<key> entries`);
    return repaired;
  }
  /**
   * 客户端启动配置裁剪。完整聚合结果始终保存在 KV_MERGED_CONFIG，
   * 根地址默认只返回启动必需项，避免影视仓串行初始化大量远程 JAR/解析器。
   */
  async function buildStartupConfig(cached: string): Promise<string> {
    let quota: SearchQuotaConfig;
    try {
      quota = await loadSearchQuota(storage);
    } catch {
      return cached;
    }

    let parsed: TVBoxConfig;
    try {
      parsed = JSON.parse(cached) as TVBoxConfig;
    } catch {
      return cached;
    }

    const pinnedKeys = new Set(quota.pinnedKeys || []);
    const blockedKeys = new Set(
      (quota.blockedKeys || []).filter((key): key is string => typeof key === 'string')
    );
    const allSites = Array.isArray(parsed.sites) ? parsed.sites : [];

    // 优先使用全量质量分级池：池内已按“优 > 良 > 可用 > 未探测 > 不可用”
    // 且同级按速度排序。它覆盖过滤不可达之前的完整可搜索池，因此可以
    // 恢复被旧配额截断的站点，并按前端配置的 maxSearchable 取前 N 个。
    let qualityPool = null;
    try {
      qualityPool = await loadQualityPool(storage);
    } catch {
      qualityPool = null;
    }

    const qualityGradeByKey = new Map<string, SiteQualityGrade>();
    if (qualityPool && Array.isArray(qualityPool.entries)) {
      for (const entry of qualityPool.entries) {
        if (!qualityGradeByKey.has(entry.key)) qualityGradeByKey.set(entry.key, entry.grade);
      }
    }
    const retainCredentialMode: 'off' | 'all' | 'selected' =
      quota.retainCredentialMode === 'all' || quota.retainCredentialMode === 'selected' || quota.retainCredentialMode === 'off'
        ? quota.retainCredentialMode
        : (quota.retainCredentialSources === true ? 'all' : 'off');
    const retainedCredentialKeys = new Set(quota.retainedCredentialKeys || []);
    const isRetainedCredentialSite = (site: TVBoxSite): boolean => {
      if (blockedKeys.has(site.key)) return false;
      if (retainCredentialMode === 'off') return false;
      const grade = qualityGradeByKey.get(site.key);
      const eligible = grade
        ? grade === 'credential-ready' || grade === 'untestable'
        : isClientCredentialSite(site) || !isSiteProbeable(site);
      if (!eligible) return false;
      return retainCredentialMode === 'all' || retainedCredentialKeys.has(site.key);
    };

    // KV_MERGED_CONFIG 已经过 applySearchQuota，可能只保留前 N 个搜索源。
    // 质量池需要恢复被旧上限截断的站点，因此先以完整候选快照兜底，再用当前
    // 合并配置覆盖同 key 的最新对象（凭证、代理等字段可能刚刚更新）。
    let candidateSites: TVBoxSite[] = [];
    try {
      candidateSites = await loadQualityCandidates(storage);
    } catch {
      candidateSites = [];
    }
    const candidateByKey = new Map(
      candidateSites.filter((site) => !blockedKeys.has(site.key)).map((site) => [site.key, site])
    );
    const siteByKey = new Map(candidateByKey);
    for (const site of allSites) {
      if (blockedKeys.has(site.key)) continue;
      // 合并配置中的对象可能已被 maxQuickSearch 把 quickSearch 改为 0；
      // 根启动配置需要按 maxStartupQuickSearch 独立决策，因此以候选池
      // 的原始 quickSearch 为准，其余字段仍采用最新配置。
      const original = candidateByKey.get(site.key);
      siteByKey.set(site.key, original
        ? { ...site, quickSearch: original.quickSearch }
        : site);
    }
    let orderedSites: TVBoxSite[] = [];
    if (qualityPool && Array.isArray(qualityPool.entries) && qualityPool.entries.length > 0) {
      const restored: TVBoxSite[] = [];
      for (const entry of qualityPool.entries) {
        if (blockedKeys.has(entry.key)) continue;
        if (entry.grade === 'timeout' || entry.grade === 'unusable') continue;
        const site = siteByKey.get(entry.key);
        if (!site) continue;
        restored.push(site.searchable === 1 ? site : { ...site, searchable: 1 });
      }
      orderedSites = restored;
    } else {
      // 质量池尚未生成时保持旧行为：只使用最终配置中仍可搜索的源。
      orderedSites = allSites.filter((site) => site.searchable === 1 && !blockedKeys.has(site.key));
    }

    // 置顶源永远排在最前，且不受 maxSearchable 截断。
    const pinnedSites: TVBoxSite[] = [];
    const seenPinned = new Set<string>();
    for (const key of quota.pinnedKeys || []) {
      if (blockedKeys.has(key)) continue;
      const site = siteByKey.get(key);
      if (!site || seenPinned.has(key)) continue;
      if (qualityGradeByKey.size > 0) {
        const grade = qualityGradeByKey.get(key);
        if (grade === 'timeout' || grade === 'unusable') continue;
      }
      seenPinned.add(key);
      pinnedSites.push(site.searchable === 1 ? site : { ...site, searchable: 1 });
    }

    const pinnedKeySet = new Set(pinnedSites.map((site) => site.key));
    const rest = orderedSites.filter((site) => !pinnedKeySet.has(site.key) && !blockedKeys.has(site.key));

    // 轻量启动要等远程 JAR 已落到本部署缓存后再下发，避免客户端逐个等待
    // 慢速上游；完整启动模式不做这层裁剪。客户端凭证型 type=3 源始终保留，
    // 因为它们在客户端登录后可直接使用。/config-full.json 始终保留完整配置。
    const leanStartup = quota.startupMode !== 'full' && quota.leanStartup !== false;
    let eligibleRest = rest;
    let jarReadyKeys = new Set<string>();
    if (leanStartup) {
      jarReadyKeys = await loadJarReadyKeys(storage);
      eligibleRest = rest.filter((site) => {
        // 可搜索源不能因本部署尚未预取 JAR 而从根配置消失，否则
        // maxSearchable=0 仍会退化成少量启动源。JAR 就绪门槛只用于
        // 不可搜索的远程扩展，避免它们增加客户端启动等待。
        if (site.type !== 3 || site.searchable === 1 || isClientCredentialSite(site)) return true;
        const key = getJarKeyForSite(site, parsed.spider);
        // 直连 CDN JAR 无需等待本部署预取；只有实际代理 JAR 才要求 ready。
        return !key || jarReadyKeys.has(key);
      });
    }

    // 置顶是用户显式选择，轻量启动时也保留；普通候选才按模式门控。
    // 可选策略开启后，凭证就绪与客户端登录/JAR 源额外保留，不占可测速源上限。
    // selected 模式仅放行已勾选 key；其余凭证源仍按正常质量顺序参与上限。
    const limit = quota.maxSearchable ?? 0;
    let limitedRest = eligibleRest;
    if (limit > 0) {
      const pooledRest = eligibleRest.filter((site) => !isRetainedCredentialSite(site));
      const retainedCredentialRest = eligibleRest.filter(isRetainedCredentialSite);
      limitedRest = [...pooledRest.slice(0, Math.max(0, limit)), ...retainedCredentialRest];
    }

    // 根配置的快速搜索是独立策略：0=不额外裁剪；非 0 时按最终顺序
    // 仅保留前 N 个 quickSearch 源，其余仅关闭 quickSearch，不删站点。
    const startupQuickLimit = quota.maxStartupQuickSearch ?? 0;
    let startupSites = [...pinnedSites, ...limitedRest];
    if (startupQuickLimit > 0) {
      let keptQuick = 0;
      startupSites = startupSites.map((site) => {
        if (site.searchable !== 1 || site.quickSearch === 0) return site;
        if (keptQuick < startupQuickLimit) {
          keptQuick++;
          return site;
        }
        return { ...site, quickSearch: 0 };
      });
    }

    parsed.sites = startupSites;
    console.log('[startup] mode=' + (leanStartup ? 'lean' : 'full')
      + ' jar-ready=' + jarReadyKeys.size
      + ' type3-kept=' + parsed.sites.filter((site) => site.type === 3).length);

    // CF 分离模式在根配置中保留少量最快的直播入口；完整直播清单仍在
    // /live.json 和 /config-full.json 中，Render 的单个聚合入口不受影响。
    if (config.workerBaseUrl && Array.isArray(parsed.lives) && parsed.lives.length > 8) {
      parsed.lives = parsed.lives.slice(0, 8);
    }

    const parses = Array.isArray(parsed.parses) ? parsed.parses : [];
    const maxParses = quota.maxParses ?? 0;
    parsed.parses = maxParses > 0 ? parses.slice(0, maxParses) : parses;

    // 只有最终完全没有 type=3 源时才移除根 spider。type=3 站点可能
    // 不写自己的 jar 字段而依赖全局 spider，不能仅凭 jar/ext 字段判断。
    if (!parsed.sites.some((site) => site.type === 3)) {
      delete parsed.spider;
    }

    return JSON.stringify(parsed);
  }
  // 完整配置仍要排除质量分级里的超时/不可用源，保证 /config-full.json
  // 不会把客户端不可用的搜索源重新带回来。
  async function filterExcludedQualitySites(cached: string): Promise<string> {
    let quota: SearchQuotaConfig;
    try {
      quota = await loadSearchQuota(storage);
    } catch {
      return cached;
    }

    const excluded = new Set<string>(
      (quota.blockedKeys || []).filter((key): key is string => typeof key === 'string')
    );
    try {
      const pool = await loadQualityPool(storage);
      for (const key of excludedQualityKeys(pool)) excluded.add(key);
    } catch {
      // 显式屏蔽仍然生效，质量池缺失不应导致屏蔽失效。
    }

    if (excluded.size === 0) return cached;

    let parsed: TVBoxConfig;
    try {
      parsed = JSON.parse(cached) as TVBoxConfig;
    } catch {
      return cached;
    }
    if (!Array.isArray(parsed.sites)) return cached;
    parsed.sites = parsed.sites.filter((site) => !excluded.has(site.key));
    return JSON.stringify(parsed);
  }

  function repairWoggCompatibilityResponse(body: string): string {

    let parsed: TVBoxConfig;
    try {
      parsed = JSON.parse(body) as TVBoxConfig;
    } catch {
      return body;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sites)) return body;

    if (!applyLegacyWoggCompatibility(parsed)) return body;
    return JSON.stringify(parsed);
  }

  function configBody(body: string, headers: Record<string, string>): Response {
    // 不手工压缩：Cloudflare 边缘可能在客户端未请求 gzip 时剥离
    // Content-Encoding，却保留压缩字节，导致 TVBox/影视仓 JSON 解析失败。
    // 始终保持原始 JSON，由平台按 Accept-Encoding 正常协商压缩。
    body = repairWoggCompatibilityResponse(body);
    return new Response(body, {
      status: 200,
      headers: { ...headers, Vary: 'Accept-Encoding' },
    });
  }

  // ─── 主配置 ────────────────────────────────────────────
  const handleRootConfig = async (c: any) => {
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;

    // Authenticate before any KV read, repair, or startup build work.
    const resolved = await resolveClientAuthContext(c, baseUrl);
    if (resolved.failure) {
      return c.json({ error: resolved.failure.message, code: resolved.failure.code }, resolved.failure.status as any);
    }
    const ctx = resolved.context!;

    let cached = await storage.get(KV_MERGED_CONFIG);

    if (!cached) {
      return c.json(
        { error: 'No config available yet. Add sources in /admin and trigger a refresh.' },
        503,
      );
    }

    cached = await repairCfSeparatedLives(cached);
    cached = await buildStartupConfig(cached);
    cached = await applyClientContextToConfigBody(cached, ctx);

    return configBody(cached, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
  };
  app.get('/', handleRootConfig);
  app.get('/auth/:code', handleRootConfig);
  app.get('/auth/:code/', handleRootConfig);

  // ─── 纯直播配置 ────────────────────────────────────────
  const handleLive = async (c: any) => {
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    const authResolved = await resolveOrRejectClientContext(c, baseUrl);
    if (authResolved.response) return authResolved.response;
    const authContext = authResolved.context!;
    const renderLiveText = (text: string): string => applyAuthPrefixToProxyUrls(
      applyBaseUrlPlaceholder(text, authContext.rootBaseUrl),
      authContext,
    );
    const isCfRuntime = !!config.workerBaseUrl && typeof caches !== 'undefined';

    // 优先返回聚合阶段预生成的 txt，避免每次请求都实时下载/合并直播源。
    const prebuiltTxt = await storage.get(KV_LIVE_MERGED_TXT);
    const liveDisabled = (await storage.get(KV_LIVE_DISABLED)) === 'true';
    // 空字符串通常表示直播被禁用或确实没有频道；但历史上也存在聚合输出写入
    // 空 TXT、原生分组数据仍有效的部署。若直播未禁用，空预生成值不能遮蔽
    // KV_LIVE_MERGED_DATA，否则会永久返回空内容或旧运行时缓存。
    const hasUsablePrebuiltTxt = Boolean(prebuiltTxt && prebuiltTxt.trim())
      && prebuiltTxt !== KV_LIVE_MERGED_TXT_FALLBACK
      && !containsBlockedLiveUrl(prebuiltTxt!);
    const prebuiltEmptyIsAuthoritative = prebuiltTxt !== null
      && prebuiltTxt.trim() === ''
      && liveDisabled;
    if (hasUsablePrebuiltTxt || prebuiltEmptyIsAuthoritative) {
      return c.body(renderLiveText(prebuiltTxt!), 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400',
        'Access-Control-Allow-Origin': '*',
      });
    }

    // CF 非聚合模式：实时解析成功后写入持久化缓存，避免每次冷启动都重新下载直播源。
    // 版本一致时直接返回；版本已更新但旧缓存仍可用时采用 stale-while-revalidate：
    // 先快速返回旧直播，再在后台刷新，避免聚合后的首个 /live 请求阻塞数秒。
    const mergedVersion = await storage.get(KV_LIVE_MERGED_TXT_VERSION);
    const runtimeVersion = await storage.get(KV_LIVE_RUNTIME_TXT_VERSION);
    const runtimeTxt = await storage.get(KV_LIVE_RUNTIME_TXT);
    const runtimeVersionMatches = runtimeVersion !== null && runtimeVersion === (mergedVersion || 'legacy');
    const hasRuntimeTxt = Boolean(runtimeTxt && runtimeTxt.trim() && !containsBlockedLiveUrl(runtimeTxt));
    if (hasRuntimeTxt && runtimeVersionMatches && !liveDisabled) {
      return c.body(renderLiveText(runtimeTxt!), 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400',
        'Access-Control-Allow-Origin': '*',
      });
    }
    const runtimeCacheInvalidated = liveDisabled || !runtimeVersionMatches || !hasRuntimeTxt;

    // CF 非聚合模式：解析为空通常是上游超时或内容格式不兼容。若不记录负缓存，
    // 客户端会反复触发同一批慢请求。这里保留 10 分钟冷却，配置变更时会主动清空。
    const runtimeEmptyAtRaw = await storage.get(KV_LIVE_RUNTIME_EMPTY_AT);
    const runtimeEmptyAt = runtimeEmptyAtRaw ? Number(runtimeEmptyAtRaw) : 0;
    const runtimeEmptyTtlMs = 10 * 60 * 1000;
    if (!liveDisabled && isCfRuntime && runtimeEmptyAt > 0 && Date.now() - runtimeEmptyAt < runtimeEmptyTtlMs) {
      return c.body('', 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      });
    }

    let livesRaw = await storage.get(KV_LIVE_MERGED_DATA);
    let lives: any[] = [];
    if (livesRaw) {
      try {
        lives = JSON.parse(livesRaw);
      } catch { /* ignore */ }
    }

    if (!lives || lives.length === 0) {
      const cached = await storage.get(KV_MERGED_CONFIG_FULL) || await storage.get(KV_MERGED_CONFIG);
      if (cached) {
        try {
          const full = JSON.parse(cached);
          lives = full.lives || [];
        } catch { /* ignore */ }
      }
    }

    // 过滤掉指向自身或 live.json 的单条目，防止死循环；同时应用共享屏蔽策略，
    // 避免旧缓存或未重跑聚合时把已屏蔽源重新暴露。
    if (Array.isArray(lives)) {
      lives = filterBlockedLiveEntries(lives as TVBoxLive[]);
      lives = lives.filter((live) => {
        const url = live.url || live.api || '';
        return !(url && (url.endsWith('/live') || url.endsWith('/live-config') || url.endsWith('/live.json')));
      });
    }

    try {
      // FongMi 格式（type/url/api 指针）：实时下载并解析为 txt 格式。
      // CF Worker 使用边缘缓存；Node/Render 使用持久化下载缓存和限并发，
      // 避免缺失预生成 TXT 时一次性下载全部直播源。
      if (!isNativeLiveGroups(lives)) {
        const liveUrls: Array<{ name: string; url: string; header?: Record<string, string> }> = [];
        for (const entry of lives) {
          const url = entry.url || entry.api;
          // 过滤非直播配置指针：type=3 是插件/聚合处理器，不能当 m3u/txt 下载。
          // yqk 等相对值以及非 HTTP(S) 地址也一律跳过，避免每次请求白等超时。
          if (entry.type === 3 || url === 'yqk' || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            continue;
          }
          const liveSource = { name: entry.name || url, url };
          if (isBlockedLiveSource(liveSource)) continue;
          liveUrls.push({ ...liveSource, header: entry.header });
        }
        if (liveUrls.length > 0) {
          const resolvedUrls = liveUrls.map(u => ({
            ...u,
            url: applyBaseUrlPlaceholder(u.url, baseUrl)
          }));

          const cache = isCfRuntime ? (caches as any).default as Cache : null;
          const cacheKey = isCfRuntime
            ? new Request('https://live-cache.internal/' + encodeURIComponent(baseUrl) + '/' + encodeURIComponent(c.req.url))
            : null;
          const refreshKey = cacheKey?.url || baseUrl + '|' + resolvedUrls.map(u => u.url).join('|');

          // 同一 Worker 实例内合并并发刷新，避免多个客户端同时请求时重复下载。
          const refreshRuntimeLiveTxt = (): Promise<Response | null> => {
            const existing = liveRuntimeRefreshes.get(refreshKey);
            if (existing) return existing;

            const task = (async (): Promise<Response | null> => {
              try {
                const channelSpeedMap = await loadChannelSpeedMap(storage);
                const liveFetchTimeoutMs = isCfRuntime ? 4500 : 8000;
                const groups = await filterLivesBySource(resolvedUrls, liveFetchTimeoutMs, channelSpeedMap, isCfRuntime
                  ? {
                      maxUrlsPerChannel: 6,
                      maxChannels: 12000,
                      minChannelsPerSource: 5,
                      maxAdRatio: 0.5,
                      minPlayableRatio: 0.2,
                    }
                  : {
                      maxUrlsPerChannel: 6,
                      maxChannels: 12000,
                      minChannelsPerSource: 5,
                      maxAdRatio: 0.5,
                      minPlayableRatio: 0.2,
                      storage,
                      concurrency: 3,
                      useCache: true,
                    });
                if (groups.length === 0) {
                  // 后台刷新失败时保留旧直播缓存，只有从未成功解析过才记录空缓存。
                  if (isCfRuntime && !hasRuntimeTxt) {
                    await storage.put(KV_LIVE_RUNTIME_EMPTY_AT, String(Date.now()));
                  }
                  return null;
                }

                const txt = formatAggregatedLiveGroupsAsTxt(groups);
                await storage.put(KV_LIVE_RUNTIME_TXT, txt);
                await storage.put(KV_LIVE_RUNTIME_TXT_VERSION, mergedVersion || 'legacy');
                await storage.put(KV_LIVE_RUNTIME_EMPTY_AT, '');
                // 运行时过滤结果；完整候选池只由主聚合维护，不能被实时解析覆盖。
                await storage.put(KV_CHANNEL_RUNTIME_TREE, JSON.stringify(groups));
                const responseHeaders = {
                  'Content-Type': 'text/plain; charset=utf-8',
                  'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400',
                  'Access-Control-Allow-Origin': '*',
                };
                // Cache the root/placeholder form so auth-code paths never leak
                // one client's prefix into another client's cached response.
                const cacheResponse = new Response(applyBaseUrlPlaceholder(txt, authContext.rootBaseUrl), {
                  headers: responseHeaders,
                });
                if (cache && cacheKey) {
                  await cache.put(cacheKey, cacheResponse.clone());
                }
                return c.body(renderLiveText(txt), 200, responseHeaders);
              } catch (err) {
                console.warn('[live] Runtime refresh failed:', err instanceof Error ? err.message : String(err));
                return null;
              }
            })();

            liveRuntimeRefreshes.set(refreshKey, task);
            void task.finally(() => {
              if (liveRuntimeRefreshes.get(refreshKey) === task) {
                liveRuntimeRefreshes.delete(refreshKey);
              }
            });
            return task;
          };

          // 版本更新但旧直播可用：立即返回 stale 内容，后台刷新新版本。
          if (hasRuntimeTxt && !runtimeVersionMatches) {
            const staleResponse = c.body(renderLiveText(runtimeTxt!), 200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'public, max-age=300',
              'Access-Control-Allow-Origin': '*',
              'X-Live-Cache': 'stale',
            });
            const refreshTask = refreshRuntimeLiveTxt();
            try {
              c.executionCtx.waitUntil(refreshTask);
            } catch {
              void refreshTask;
            }
            return staleResponse;
          }

          if (cache && cacheKey && !runtimeCacheInvalidated) {
            const cached = await cache.match(cacheKey);
            if (cached) return c.body(renderLiveText(await cached.clone().text()), cached.status as any, Object.fromEntries(cached.headers.entries()));
          }

          const refreshed = await refreshRuntimeLiveTxt();
          if (refreshed) return refreshed;
        }
        // 无法解析时记录负缓存并返回空 txt，避免连续请求重复等待超时。
        if (isCfRuntime) {
          await storage.put(KV_LIVE_RUNTIME_EMPTY_AT, String(Date.now()));
        }
        return c.body('', 200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        });
      }

      // 如果已经是 Native 格式（Docker/Node 环境预先合并好的 groups），应用 baseUrl 占位符并返回
      const nativeTxt = formatAggregatedLiveGroupsAsTxt(lives);
      const resolvedTxt = renderLiveText(nativeTxt);
      return c.body(resolvedTxt, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400',
        'Access-Control-Allow-Origin': '*',
      });
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }
  };
  app.get('/live', handleLive);
  app.get('/live-config', handleLive);
  app.get('/auth/:code/live', handleLive);
  app.get('/auth/:code/live-config', handleLive);

  // ─── .json 下载别名 ────────────────────────────────────
  const handleIndexConfig = async (c: any) => {
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;

    // Authenticate before any KV read, repair, or startup build work.
    const resolved = await resolveClientAuthContext(c, baseUrl);
    if (resolved.failure) {
      return c.json({ error: resolved.failure.message, code: resolved.failure.code }, resolved.failure.status as any);
    }
    const ctx = resolved.context!;

    let cached = await storage.get(KV_MERGED_CONFIG);
    if (!cached) {
      return c.json({ error: 'No config available yet.' }, 503);
    }
    cached = await repairCfSeparatedLives(cached);
    cached = await buildStartupConfig(cached);
    cached = await applyClientContextToConfigBody(cached, ctx);
    return configBody(cached, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'attachment; filename="tvbox-config.json"',
    });
  };
  app.get('/index.json', handleIndexConfig);
  app.get('/auth/:code/index.json', handleIndexConfig);

  // 完整配置入口：不受轻量启动模式影响，始终返回最终聚合结果。
  // 仍然排除质量分级中的“超时/不可用”源，避免客户端拿到不可用搜索源。
  const handleFullConfig = async (c: any) => {
    let stage = 'base-url';
    try {
      const baseUrl = await resolveBaseUrl(c);
      if (baseUrl instanceof Response) return baseUrl;

      // Authenticate before any KV read, repair, or quality filtering work.
      stage = 'auth';
      const resolved = await resolveClientAuthContext(c, baseUrl);
      if (resolved.failure) {
        return c.json({ error: resolved.failure.message, code: resolved.failure.code }, resolved.failure.status as any);
      }
      const ctx = resolved.context!;

      stage = 'read-full-config';
      // 客户端入口必须读取黑名单过滤后的最终配置。KV_MERGED_CONFIG_FULL
      // 供管理端显示屏蔽源，包含不在最终来源边界内的站点，不能优先返回。
      let cached = await storage.get(KV_MERGED_CONFIG)
        || await storage.get(KV_MERGED_CONFIG_FULL);
      if (!cached) {
        return c.json({ error: 'No config available yet.' }, 503);
      }
      stage = 'repair-lives';
      cached = await repairCfSeparatedLives(cached);
      stage = 'quality-filter';
      cached = await filterExcludedQualitySites(cached);
      stage = 'credential-policy';
      cached = await applyClientContextToConfigBody(cached, ctx);
      stage = 'serialize-response';
      const response = configBody(cached, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': 'attachment; filename="tvbox-config-full.json"',
      });
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.errorFields('routes', 'config-full-failed', { stage, message });
      return c.json({ error: 'Full config processing failed.', code: 'config_full_failed' }, 500);
    }
  };
  app.get('/config-full.json', handleFullConfig);
  app.get('/auth/:code/config-full.json', handleFullConfig);
  const handleLiveJson = async (c: any) => {
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    const authResolved = await resolveOrRejectClientContext(c, baseUrl);
    if (authResolved.response) return authResolved.response;
    const authContext = authResolved.context!;

    let lives: TVBoxLive[];
    if (config.workerBaseUrl) {
      const liveMergeMode = (await storage.get(KV_LIVE_MERGE_MODE)) || 'separated';
      if (liveMergeMode === 'separated') {
        // CF 分离模式只导出当前有效代理清单，避免旧的上游直链或空入口被导出。
        lives = await getCfSeparatedLives();
      } else {
        let livesRaw = await storage.get(KV_LIVE_MERGED_DATA);
        if (!livesRaw) {
          const cached = await storage.get(KV_MERGED_CONFIG_FULL) || await storage.get(KV_MERGED_CONFIG);
          if (cached) {
            try {
              const full = JSON.parse(cached);
              livesRaw = JSON.stringify(full.lives || []);
            } catch { /* ignore */ }
          }
        }
        if (!livesRaw) return c.json({ lives: [] });
        livesRaw = applyBaseUrlPlaceholder(livesRaw, authContext.rootBaseUrl);
        try {
          lives = JSON.parse(livesRaw);
        } catch {
          return c.json({ error: 'Config parse error' }, 500);
        }
      }
    } else {
      let livesRaw = await storage.get(KV_LIVE_MERGED_DATA);
      if (!livesRaw) {
        const cached = await storage.get(KV_MERGED_CONFIG_FULL) || await storage.get(KV_MERGED_CONFIG);
        if (cached) {
          try {
            const full = JSON.parse(cached);
            livesRaw = JSON.stringify(full.lives || []);
          } catch { /* ignore */ }
        }
      }
      if (!livesRaw) return c.json({ lives: [] });
      livesRaw = applyBaseUrlPlaceholder(livesRaw, authContext.rootBaseUrl);
      try {
        lives = JSON.parse(livesRaw);
      } catch {
        return c.json({ error: 'Config parse error' }, 500);
      }
    }

    lives = filterBlockedLiveEntries(lives);
    if (lives.length > 0 && lives.every((live) => Array.isArray(live.channels))) {
      lives = sortLiveGroupsForOutput(lives as unknown as TVBoxLiveGroup[]) as unknown as TVBoxLive[];
    }

    return c.body(applyAuthPrefixToProxyUrls(JSON.stringify({ lives }), authContext), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'attachment; filename="tvbox-live.json"',
    });
  };
  app.get('/live.json', handleLiveJson);
  app.get('/auth/:code/live.json', handleLiveJson);
  // ─── 监控面板 ──────────────────────────────────────────
  app.get('/status', (c) => {
    return c.html(dashboardHtml);
  });

  app.get('/status-data', async (c) => {
    const lastUpdateRaw = await storage.get(KV_LAST_UPDATE);
    const storedUpdateError = await storage.get(KV_LAST_UPDATE_ERROR);
    const sources = await storage.get(KV_MANUAL_SOURCES);
    const macCMSSources = await storage.get(KV_MACCMS_SOURCES);
    const liveSources = await storage.get(KV_LIVE_SOURCES);
    const cached = await storage.get(KV_MERGED_CONFIG);

    let siteCount = 0;
    let parseCount = 0;
    let liveCount = 0;
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        siteCount = parsed.sites?.length || 0;
        parseCount = parsed.parses?.length || 0;
        liveCount = parsed.lives?.length || 0;
      } catch {
        // ignore
      }
    }

    const parsedLastUpdate = lastUpdateRaw ? Date.parse(lastUpdateRaw) : Number.NaN;
    const lastUpdate = lastUpdateRaw && Number.isFinite(parsedLastUpdate)
      ? new Date(parsedLastUpdate).toISOString()
      : 'never';
    const legacyLastUpdateError = lastUpdateRaw?.startsWith('ERROR @') ? lastUpdateRaw : null;

    const warnings: string[] = [];
    if (config.dockerMissingBaseUrl) {
      warnings.push('docker_no_base_url');
    }

    return c.json({
      lastUpdate,
      lastUpdateError: storedUpdateError || legacyLastUpdateError || null,
      sourceCount: sources ? JSON.parse(sources).length : 0,
      macCMSCount: macCMSSources ? JSON.parse(macCMSSources).length : 0,
      liveSourceCount: liveSources ? JSON.parse(liveSources).length : 0,
      sites: siteCount,
      parses: parseCount,
      lives: liveCount,
      warnings,
      dirty: await getDirtyMarker(storage),
    });
  });

  // ─── 源健康状态（无认证，Dashboard 需要访问）─────────────
  app.get('/source-status', async (c) => {
    const raw = await storage.get(KV_SOURCE_HEALTH);
    const records = raw ? JSON.parse(raw) : [];
    return c.json(records);
  });

  // ─── Admin 页面 ────────────────────────────────────────
  app.get('/admin', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    return c.html(adminHtml);
  });

  // ─── 存储诊断（需鉴权，仅返回掩码后的远端信息）─────────
  app.get('/admin/storage-diagnostics', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const diagnostics = await rawStorage.getDiagnostics?.();
    return c.json(diagnostics || { mode: 'direct', remoteConfigured: false });
  });

  // ─── Admin API（需鉴权）────────────────────────────────
  app.route('/', createSourceManagementRouter({ storage, config, onDirty: markOutputDirty }));

  // ─── 名称定制 API ──────────────────────────────────────
  app.get('/admin/name-transform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_NAME_TRANSFORM);
    const transform: NameTransformConfig = raw ? JSON.parse(raw) : {};
    return c.json(transform);
  });

  app.put('/admin/name-transform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: NameTransformConfig;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // 验证额外正则语法
    if (body.extraCleanPatterns) {
      for (const p of body.extraCleanPatterns) {
        try { new RegExp(p); } catch {
          return c.json({ error: `Invalid regex: ${p}` }, 400);
        }
      }
    }

    const transform: NameTransformConfig = {
      prefix: body.prefix || undefined,
      suffix: body.suffix || undefined,
      promoReplacement: body.promoReplacement || undefined,
      extraCleanPatterns: body.extraCleanPatterns?.length ? body.extraCleanPatterns : undefined,
    };

    await storage.put(KV_NAME_TRANSFORM, JSON.stringify(transform));
    await markOutputDirty();
    return c.json({ success: true });
  });

  // ─── 定时任务间隔 API ──────────────────────────────────
  app.get('/admin/cron-interval', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_CRON_INTERVAL);
    const interval = raw ? parseInt(raw) : DEFAULT_CRON_INTERVAL;
    return c.json({ interval });
  });

  app.put('/admin/cron-interval', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { interval?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const interval = body.interval;
    const validIntervals = [60, 180, 360, 720, 1440];
    if (!interval || !validIntervals.includes(interval)) {
      return c.json({ error: `interval must be one of: ${validIntervals.join(', ')}` }, 400);
    }

    await storage.put(KV_CRON_INTERVAL, String(interval));

    if (deps.onCronIntervalChange) {
      deps.onCronIntervalChange(interval);
    }

    return c.json({ success: true, interval });
  });

  // ─── 站点测速开关 ──────────────────────────────────────
  app.get('/admin/speed-test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_SPEED_TEST_ENABLED);
    return c.json({ enabled: raw !== 'false' });
  });

  app.put('/admin/speed-test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { enabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    await storage.put(KV_SPEED_TEST_ENABLED, String(body.enabled));
    await markOutputDirty();
    return c.json({ success: true, enabled: body.enabled });
  });

  // ─── 边缘函数代理配置 Admin API ──────────────────────
  app.get('/admin/edge-proxies', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_EDGE_PROXIES);
    return c.json(raw ? JSON.parse(raw) : {});
  });

  app.put('/admin/edge-proxies', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { cf?: string; vercel?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    // 清理尾部斜杠
    const clean = {
      cf: body.cf?.replace(/\/+$/, '') || undefined,
      vercel: body.vercel?.replace(/\/+$/, '') || undefined,
    };
    await storage.put(KV_EDGE_PROXIES, JSON.stringify(clean));
    storage.clear();
    return c.json({ success: true, ...clean });
  });

  // ─── Fetch 代理端点（仅 CF 版，供本地 Docker 中转请求）──
  if (config.workerBaseUrl) {
    app.get('/fetch-proxy', async (c) => {
      // 认证：adminToken 或 refreshToken
      const auth = c.req.raw.headers.get('Authorization');
      const validTokens = [config.adminToken, config.refreshToken].filter(Boolean);
      if (validTokens.length > 0 && !validTokens.some((t) => auth === `Bearer ${t}`)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const targetUrl = c.req.query('url');
      if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
        return c.json({ error: 'Missing or invalid ?url= parameter' }, 400);
      }

      try {
        const resp = await fetch(targetUrl, {
          headers: {
            'User-Agent': c.req.header('X-Proxy-UA') || 'okhttp/3.12.0',
          },
          redirect: 'follow',
        });

        return new Response(resp.body, {
          status: resp.status,
          headers: {
            'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return c.json({ error: msg }, 502);
      }
    });
  }

  // ─── 搜索配额管理 ──────────────────────────────────────
  app.get('/admin/search-quota', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const quota = await loadSearchQuota(storage);
    return c.json(quota);
  });

  app.put('/admin/search-quota', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: Partial<SearchQuotaConfig>;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const current = await loadSearchQuota(storage);
    if (typeof body.maxSearchable === 'number' && Number.isFinite(body.maxSearchable)) {
      current.maxSearchable = Math.max(0, Math.floor(body.maxSearchable));
    }
    // 快速搜索上限为 0 时明确不限制；字段缺失则保留当前值，避免管理页
    // 局部保存意外重置。旧版本自动写入的常量已由 loadSearchQuota 迁移。
    if (typeof body.maxQuickSearch === 'number' && Number.isFinite(body.maxQuickSearch)) {
      current.maxQuickSearch = Math.max(0, Math.floor(body.maxQuickSearch));
    }
    if (typeof body.maxStartupQuickSearch === 'number' && Number.isFinite(body.maxStartupQuickSearch)) {
      current.maxStartupQuickSearch = Math.max(0, Math.floor(body.maxStartupQuickSearch));
    }
    if (typeof body.maxParses === 'number' && Number.isFinite(body.maxParses)) {
      current.maxParses = Math.max(0, Math.floor(body.maxParses));
    }
    if (body.retainCredentialMode === 'off' || body.retainCredentialMode === 'all' || body.retainCredentialMode === 'selected') {
      current.retainCredentialMode = body.retainCredentialMode;
    } else if (typeof body.retainCredentialSources === 'boolean') {
      current.retainCredentialMode = body.retainCredentialSources ? 'all' : 'off';
    }
    current.retainCredentialSources = current.retainCredentialMode !== 'off';
    if (Array.isArray(body.retainedCredentialKeys)) {
      current.retainedCredentialKeys = [...new Set(body.retainedCredentialKeys.filter((key): key is string => typeof key === 'string'))];
    }
    if (Array.isArray(body.blockedKeys)) {
      current.blockedKeys = [...new Set(body.blockedKeys.filter((key): key is string => typeof key === 'string'))];
    }
    {
      const blocked = new Set(current.blockedKeys || []);
      current.pinnedKeys = (current.pinnedKeys || []).filter((key) => !blocked.has(key));
      current.retainedCredentialKeys = (current.retainedCredentialKeys || []).filter((key) => !blocked.has(key));
    }
    // autoLimit is retired in schema 8; the two user-facing caps are explicit.
    if (typeof body.sortBySpeed === 'boolean') current.sortBySpeed = body.sortBySpeed;
    if (typeof body.leanStartup === 'boolean') current.leanStartup = body.leanStartup;
    if (body.startupMode === 'lean' || body.startupMode === 'full') current.startupMode = body.startupMode;
    if (typeof body.pruneDeadParses === 'boolean') current.pruneDeadParses = body.pruneDeadParses;
    if (Array.isArray(body.pinnedKeys)) {
      const blocked = new Set(current.blockedKeys || []);
      current.pinnedKeys = [...new Set(body.pinnedKeys.filter((key): key is string => typeof key === 'string'))]
        .filter((key) => !blocked.has(key));
    }


    await saveSearchQuota(storage, current);
    await markOutputDirty();
    return c.json({ success: true, ...current });
  });

  app.post('/admin/search-quota/pinned', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    const blocked = new Set(current.blockedKeys || []);
    const set = new Set(current.pinnedKeys);
    for (const key of body.keys) {
      if (!blocked.has(key)) set.add(key);
    }
    current.pinnedKeys = [...set];
    await saveSearchQuota(storage, current);
    await markOutputDirty();
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  // 重排 pinned 顺序（整体替换）
  app.put('/admin/search-quota/pinned', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    const blocked = new Set(current.blockedKeys || []);
    current.pinnedKeys = [...new Set(body.keys.filter((key): key is string => typeof key === 'string'))]
      .filter((key) => !blocked.has(key));
    await saveSearchQuota(storage, current);
    await markOutputDirty();
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  app.delete('/admin/search-quota/pinned', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    const removeSet = new Set(body.keys);
    current.pinnedKeys = current.pinnedKeys.filter(k => !removeSet.has(k));
    await saveSearchQuota(storage, current);
    await markOutputDirty();
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  // 报告（admin 需鉴权）
  app.get('/admin/search-quota/report', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_SEARCH_QUOTA_REPORT);
    let report: Record<string, unknown> | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') report = parsed as Record<string, unknown>;
      } catch {
        // 损坏的报告不能阻塞管理页；下面从已落盘的质量池和根配置重建只读报告。
      }
    }

    if (!report) {
      const [quota, qualityPool, fullRaw, mergedRaw] = await Promise.all([
        loadSearchQuota(storage),
        loadQualityPool(storage),
        storage.get(KV_MERGED_CONFIG_FULL),
        storage.get(KV_MERGED_CONFIG),
      ]);
      // 搜索页数字必须与客户端最终可见配置口径一致；KV_MERGED_CONFIG 是经过黑名单/配额处理后的最终版，优先使用它。
      const configRaw = mergedRaw || fullRaw;
      let sites: TVBoxSite[] = [];
      if (configRaw) {
        try {
          const parsedConfig = JSON.parse(configRaw) as TVBoxConfig;
          if (Array.isArray(parsedConfig.sites)) sites = parsedConfig.sites;
        } catch {
          // 根配置损坏时仍返回质量池统计，不伪装成报告为空。
        }
      }
      // KV_MERGED_CONFIG 是黑名单 + applySearchQuota 之后的最终配置，直接统计
      // searchable===1 即等价于上一次生效的配额报告口径，无需再与质量池求交。
      const searchableKeys = new Set(sites.filter(site => site.searchable === 1).map(site => site.key));
      const searchable = searchableKeys.size;
      const quickSearchable = sites.filter(site => site.searchable === 1 && site.quickSearch !== 0).length;
      const blockedCount = (quota.blockedKeys || []).length;
      report = {
        status: 'derived',
        source: 'quality-snapshot-fallback',
        derived: true,
        updatedAt: qualityPool?.updatedAt,
        totalSites: sites.length || qualityPool?.total || 0,
        jsExcluded: 0,
        searchable,
        quickSearchable,
        maxSearchable: quota.maxSearchable,
        maxQuickSearch: quota.maxQuickSearch,
        autoLimit: quota.autoLimit === true,
        pinnedCount: (quota.pinnedKeys || []).filter(key => searchableKeys.has(key)).length,
        blockedCount,
        truncated: 0,
        quickTruncated: 0,
        speedSorted: quota.sortBySpeed !== false,
        leanRemoved: 0,
        qualityGrades: qualityPool?.grades ?? null,
        message: raw ? 'Stored report is invalid; derived from current config and quality pool.' : 'No stored report yet; derived from current config and quality pool.',
      };
    }

    const parseRaw = await storage.get(KV_PARSE_HEALTH_REPORT);
    if (parseRaw) {
      try {
        const parseReport = JSON.parse(parseRaw) as Record<string, unknown>;
        report.parseProbed = parseReport.probed;
        report.parseRemoved = parseReport.removed;
        report.parseTimeouts = parseReport.timeouts;
        report.parseHttpErrors = parseReport.httpErrors;
        report.parseNetworkErrors = parseReport.networkErrors;
        report.parseLimit = parseReport.parseLimit;
        report.parseTruncated = parseReport.parseTruncated;
        report.parseKept = parseReport.parseKept;
        report.parseProbeFailed = parseReport.failedProbe === true;
      } catch {}
    }
    return c.json(report);
  });

  // ─── 搜索源质量分级调度 API ─────────────────────────────
  app.get('/admin/quality-schedule', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const schedule = await loadQualitySchedule(storage, config.qualityTimezone);
    return c.json(schedule);
  });

  app.put('/admin/quality-schedule', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { enabled?: boolean; times?: unknown; repeatDays?: number; fullRepeatDays?: number; timezone?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const schedule = await saveQualitySchedule(storage, {
      enabled: body.enabled,
      times: Array.isArray(body.times) ? (body.times as string[]) : undefined,
      repeatDays: typeof body.repeatDays === 'number' ? body.repeatDays : undefined,
      fullRepeatDays: typeof body.fullRepeatDays === 'number' ? body.fullRepeatDays : undefined,
    }, config.qualityTimezone);
    return c.json({ success: true, ...schedule });
  });

  // 质量分级结果（质量池 + 统计 + 实际数量 + 推荐值）
  app.get('/admin/quality-report', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const [snapshot, schedule, status, quota, searchQuotaRaw, parseHealthRaw] = await Promise.all([
      loadQualitySnapshot(storage),
      loadQualitySchedule(storage, config.qualityTimezone),
      loadQualityStatus(storage),
      loadSearchQuota(storage),
      storage.get(KV_SEARCH_QUOTA_REPORT),
      storage.get(KV_PARSE_HEALTH_REPORT),
    ]);

    const parseReport = (() => {
      if (!parseHealthRaw) return null;
      try {
        const parsed = JSON.parse(parseHealthRaw);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    })();
    const quotaReport = (() => {
      if (!searchQuotaRaw) return null;
      try {
        const parsed = JSON.parse(searchQuotaRaw);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    })();

    const numberOrNull = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const parseLimit = numberOrNull(parseReport?.parseLimit) ?? (quota.maxParses ?? 0);
    const parsers = numberOrNull(parseReport?.parseKept);
    const actual = {
      searchable: numberOrNull(quotaReport?.searchable),
      parsers,
      parserLimit: parseLimit,
      candidatePool: snapshot?.total ?? null,
      usablePool: snapshot?.grades?.poolTotal ?? null,
      testable: snapshot?.coverage?.testable ?? null,
      probed: snapshot?.coverage?.probed ?? null,
      notProbed: snapshot?.coverage?.notProbed ?? null,
      untestable: snapshot?.coverage?.untestable ?? null,
      credentialReady: snapshot?.coverage?.credentialReady ?? null,
      credentialPartial: snapshot?.coverage?.credentialPartial ?? null,
      credentialMissing: snapshot?.coverage?.credentialMissing ?? null,
    };

    // 推荐解析器上限：客户端启动时会串行初始化解析器，保留 3 个已足够；
    // 健康解析器不足 3 个时按实际数量推荐，避免用户填一个永远取不满的值。
    const recommendedMaxParses = parsers !== null && parsers > 0
      ? Math.max(1, Math.min(3, parsers))
      : (snapshot?.recommendedMaxParses ?? 3);

    return c.json({
      snapshot,
      schedule,
      status,
      actual,
      recommendedMaxSearchable: snapshot?.recommendedMaxSearchable ?? 0,
      recommendedMaxParses,
    });
  });

  app.get('/admin/quality-status', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const [snapshot, schedule, status] = await Promise.all([
      loadQualitySnapshot(storage),
      loadQualitySchedule(storage, config.qualityTimezone),
      loadQualityStatus(storage),
    ]);
    return c.json({ snapshot, schedule, status });
  });

  // 立即执行质量分级。请求只负责启动后台任务，完整结果通过状态接口轮询。
  app.post('/admin/quality/run', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (!deps.triggerQuality) {
      return c.json({ error: 'Quality grading is not available in this runtime' }, 501);
    }
    const modeRaw = c.req.query('mode') || 'candidate';
    if (modeRaw !== 'candidate' && modeRaw !== 'full') {
      return c.json({ error: 'Invalid mode; expected candidate or full' }, 400);
    }
    const mode: SearchQualityRunMode = modeRaw;
    const status = await loadQualityStatus(storage);
    const startedAt = status.startedAt ? Date.parse(status.startedAt) : Number.NaN;
    const staleRunning = status.state === 'running'
      && (!Number.isFinite(startedAt) || Date.now() - startedAt > 30 * 60 * 1000);
    if (status.state === 'running' && !staleRunning) {
      return c.json({ success: true, alreadyRunning: true, status });
    }
    const resuming = staleRunning;
    const runningStatus = await updateQualityStatus(storage, resuming
      ? {
          state: 'running',
          mode: status.mode || mode,
          startedAt: new Date().toISOString(),
          finishedAt: undefined,
          total: status.total || 0,
          error: undefined,
        }
      : {
          state: 'running',
          mode,
          startedAt: new Date().toISOString(),
          finishedAt: undefined,
          processed: 0,
          cursor: 0,
          total: 0,
          error: undefined,
        });
    const task = deps.triggerQuality(resuming ? (status.mode || mode) : mode).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      await updateQualityStatus(storage, { state: 'error', error: message, finishedAt: new Date().toISOString() });
    });
    let hasCtx = false;
    try {
      if (c.executionCtx) hasCtx = true;
    } catch {
      // Hono throws when accessed outside a Worker runtime.
    }
    if (hasCtx) c.executionCtx.waitUntil(task);
    else void task;
    return c.json({
      success: true,
      mode: resuming ? (status.mode || mode) : mode,
      resumed: resuming,
      staleRecovered: resuming,
      status: runningStatus,
    });
  });
  // 报告精简版（dashboard 无需鉴权）
  app.get('/search-quota/summary', async (c) => {
    const raw = await storage.get(KV_SEARCH_QUOTA_REPORT);
    if (!raw) return c.json({ enabled: false });
    try {
      const report = JSON.parse(raw) as Record<string, unknown>;
      const quota = await loadSearchQuota(storage);
      return c.json({ enabled: true, ...report, maxSearchable: quota.maxSearchable, maxQuickSearch: quota.maxQuickSearch, startupSiteLimit: quota.startupSiteLimit ?? 0, maxParses: quota.maxParses, autoLimit: quota.autoLimit, blockedCount: (quota.blockedKeys || []).length });
    } catch {
      return c.json({ enabled: false });
    }
  });

  // ─── 网盘凭证管理 API ───────────────────────────────────

  // 查看所有已登录平台状态
  app.get('/admin/cloud-credentials', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const creds = await loadCredentials(storage);
    const result: Record<string, any> = {};
    for (const [platform, cred] of creds) {
      result[platform] = {
        platform: cred.platform,
        status: cred.status,
        obtainedAt: cred.obtainedAt,
        expiresAt: cred.expiresAt,
        hasCredential: Object.values(cred.credential).some((value) => typeof value === 'string' && value.trim().length > 0),
      };
    }
    return c.json({ platforms: PLATFORM_NAMES, credentials: result });
  });

  // 凭证分发与客户端鉴权配置。鉴权码只出现在 URL 路径中，不接受查询参数。
  app.get('/admin/credential-distribution', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(await loadCredentialDistribution(storage));
  });

  app.put('/admin/credential-distribution', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    let body: Partial<CredentialDistributionConfig>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const authCodes: CredentialAuthCode[] = [];
    const seenCodes = new Set<string>();
    if (body.authCodes !== undefined) {
      if (!Array.isArray(body.authCodes)) return c.json({ error: 'authCodes must be an array' }, 400);
      for (const raw of body.authCodes) {
        if (!raw || typeof raw !== 'object') return c.json({ error: 'authCodes entries must be objects' }, 400);
        const code = createCredentialAuthCode(raw as Partial<CredentialAuthCode>);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(code.code)) {
          return c.json({ error: 'Each auth code must be 1-64 letters, numbers, underscores or hyphens' }, 400);
        }
        if (seenCodes.has(code.code)) return c.json({ error: 'Auth codes must be unique' }, 400);
        seenCodes.add(code.code);
        authCodes.push(code);
      }
    }

    const candidate = normalizeCredentialDistributionConfig({
      requireAuth: body.requireAuth,
      defaultCredentialMode: body.defaultCredentialMode,
      defaultPlatforms: body.defaultPlatforms,
      authCodes,
      stripUpstreamCredentialEntries: body.stripUpstreamCredentialEntries === true,
    });
    if (candidate.requireAuth && !candidate.authCodes.some((item) => item.enabled)) {
      return c.json({ error: 'At least one enabled auth code is required when requireAuth is enabled' }, 400);
    }

    let saved: CredentialDistributionConfig;
    try {
      saved = await saveCredentialDistribution(storage, candidate);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const quotaBlocked = /10048|quota|usage limit|limit exceeded/i.test(message);
      logger.warn('routes', `Credential distribution save failed: ${message}`);
      return c.json({
        error: quotaBlocked
          ? 'Remote KV write quota is exhausted; credential distribution was not saved.'
          : 'Failed to persist credential distribution.',
        code: quotaBlocked ? 'kv_write_quota_exhausted' : 'credential_distribution_save_failed',
      }, quotaBlocked ? 503 : 500);
    }
    await refreshAfterCredentialChange(c);
    return c.json({ success: true, ...saved });
  });

  // 注销指定平台
  app.delete('/admin/cloud-credentials/:platform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PLATFORM_NAMES[platform]) return c.json({ error: 'Unknown platform' }, 400);
    await deleteCredential(storage, platform);
    await refreshAfterCredentialChange(c);
    return c.json({ success: true });
  });

  // 手动粘贴凭证
  app.post('/admin/cloud-credentials/:platform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PLATFORM_NAMES[platform]) return c.json({ error: 'Unknown platform' }, 400);

    let body: { credential?: Record<string, unknown> };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.credential || typeof body.credential !== 'object' || Array.isArray(body.credential)) {
      return c.json({ error: 'credential object is required' }, 400);
    }

    const credential = normalizeCredentialInput(platform, body.credential);
    if (Object.keys(credential).length === 0) {
      return c.json({ error: 'credential must contain at least one non-empty string' }, 400);
    }

    const cred: CloudCredential = {
      platform,
      credential,
      obtainedAt: new Date().toISOString(),
      status: 'valid',
    };
    await saveCredential(storage, cred);
    await refreshAfterCredentialChange(c);
    return c.json({ success: true });
  });

  // 生成二维码
  app.post('/admin/cloud-login/:platform/qr', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!QR_PLATFORMS.includes(platform)) {
      return c.json({ error: `Platform ${platform} does not support QR login` }, 400);
    }

    try {
      if (platform === 'bilibili' && config.bilibiliQrProxyBaseUrl && c.req.header('X-Bilibili-QR-Proxy') !== '1') {
        const proxied = await proxyBilibiliQR('/admin/cloud-login/bilibili/qr', { method: 'POST' });
        if (proxied.error) return c.json({ error: proxied.error }, (proxied.status || 502) as any);
        if (proxied.data) return c.json(proxied.data);
      }

      const result = await generateQR(platform);
      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  // 轮询扫码状态
  app.get('/admin/cloud-login/:platform/poll', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    const token = c.req.query('token');
    if (!token) return c.json({ error: 'token is required' }, 400);

    try {
      if (platform === 'bilibili' && config.bilibiliQrProxyBaseUrl && c.req.header('X-Bilibili-QR-Proxy') !== '1') {
        const proxied = await proxyBilibiliQR('/admin/cloud-login/bilibili/poll?token=' + encodeURIComponent(token), { method: 'GET' });
        if (proxied.error) return c.json({ error: proxied.error, status: 'error' }, (proxied.status || 502) as any);
        const result = proxied.data;

        if (result?.status === 'confirmed' && result.credential) {
          const cred: CloudCredential = {
            platform,
            credential: result.credential,
            obtainedAt: new Date().toISOString(),
            status: 'valid',
          };
          await saveCredential(storage, cred);
          await refreshAfterCredentialChange(c);
        }

        return c.json(result);
      }

      const result = await pollQRStatus(platform, token);

      // 登录成功：自动保存凭证
      if (result.status === 'confirmed' && result.credential) {
        const cred: CloudCredential = {
          platform,
          credential: result.credential,
          obtainedAt: new Date().toISOString(),
          status: 'valid',
        };
        await saveCredential(storage, cred);
        await refreshAfterCredentialChange(c);
      }

      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg, status: 'error' }, 500);
    }
  });

  // 密码登录（迅雷/PikPak）
  app.post('/admin/cloud-login/:platform/password', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PASSWORD_PLATFORMS.includes(platform)) {
      return c.json({ error: `Platform ${platform} does not support password login` }, 400);
    }

    let body: { username?: string; password?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    try {
      const result = await passwordLogin(platform, body.username || '', body.password || '');
      if (result.success && result.credential) {
        const cred: CloudCredential = {
          platform,
          credential: result.credential,
          obtainedAt: new Date().toISOString(),
          status: 'valid',
        };
        await saveCredential(storage, cred);
        await refreshAfterCredentialChange(c);
      }
      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, message: msg }, 500);
    }
  });

  // 凭证注入策略
  app.get('/admin/credential-policy', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(await loadCredentialPolicy(storage));
  });

  app.put('/admin/credential-policy', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { allowedHighRiskKeys?: string[]; deniedKeys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const policy = await loadCredentialPolicy(storage);
    if (Array.isArray(body.allowedHighRiskKeys)) policy.allowedHighRiskKeys = body.allowedHighRiskKeys;
    if (Array.isArray(body.deniedKeys)) policy.deniedKeys = body.deniedKeys;
    await saveCredentialPolicy(storage, policy);
    await refreshAfterCredentialChange(c);
    return c.json({ success: true, ...policy });
  });

  // 风险分级报告
  app.get('/admin/credential-risk-report', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const configRaw = await storage.get(KV_MERGED_CONFIG_FULL);
    if (!configRaw) return c.json({ error: 'No config available. Run aggregation first.' }, 404);

    const parsed: TVBoxConfig = JSON.parse(configRaw);
    const sites = parsed.sites || [];
    const assessments = assessAllSources(sites);
    const policy = await loadCredentialPolicy(storage);

    const summary = { safe: 0, low: 0, high: 0, unaudited: 0 };
    for (const a of assessments) {
      summary[a.riskLevel]++;
    }

    return c.json({ summary, assessments, policy });
  });

  // Pan.init 初始化数据（Mogg/Wogg 的 ext.p123/quark/... 会直接请求这些 URL）。
  // 所有响应都按当前根策略或 /auth/<code> 鉴权码过滤，绝不能回退到全量凭证。
  // 凭证响应不得进入客户端 HTTP 缓存：策略从下发切到不下发后，旧响应必须立即失效。
  const credentialResponseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
  };
  const tokenResponseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
  };

  function credentialAuthFailureResponse(c: any, failure: ClientAuthFailure): Response {
    return c.json({ error: failure.message, code: failure.code }, failure.status);
  }

  async function lookupPanCredential(
    c: any,
    platform: CloudPlatform,
  ): Promise<
    | { credential?: CloudCredential; response?: Response; context?: ClientAuthContext }
  > {
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return { response: baseUrl };
    const resolved = await resolveClientAuthContext(c, baseUrl);
    if (resolved.failure) return { response: credentialAuthFailureResponse(c, resolved.failure) };
    const context = resolved.context!;

    if (context.mode === 'none' || !context.platforms.includes(platform)) {
      return { response: c.body('', 404, credentialResponseHeaders), context };
    }

    const credentials = await loadCredentials(storage);
    const credential = selectCredentialsForContext(credentials, context).get(platform);
    if (!credential || !isPanInitCredentialDistributable(platform, credential)) {
      return { response: c.body('', 404, credentialResponseHeaders), context };
    }
    return { credential, context };
  }

  async function handleQuarkCredential(c: any) {
    const found = await lookupPanCredential(c, 'quark');
    if (found.response) return found.response;
    const credential = found.credential!;
    const cookie = credential.credential.cookie?.trim();
    if (!cookie) return c.body('', 404, credentialResponseHeaders);

    const prepared = await prepareQuarkCookie(cookie, 1500);
    if (prepared !== cookie) {
      await saveCredential(storage, {
        ...credential,
        credential: { ...credential.credential, cookie: prepared },
      });
    }
    return c.body(prepared, 200, credentialResponseHeaders);
  }

  async function handleCookieCredential(c: any, platform: 'uc' | 'baidu') {
    const found = await lookupPanCredential(c, platform);
    if (found.response) return found.response;
    const cookie = found.credential!.credential.cookie?.trim();
    if (!cookie) return c.body('', 404, credentialResponseHeaders);
    return c.body(cookie, 200, credentialResponseHeaders);
  }

  async function handleAccountCredential(
    c: any,
    platform: 'tianyi' | 'pan123' | 'thunder',
  ) {
    const found = await lookupPanCredential(c, platform);
    if (found.response) return found.response;
    const credential = found.credential!;
    const username = credential.credential.username?.trim();
    const password = credential.credential.password?.trim();
    if (!username || !password) return c.body('', 404, credentialResponseHeaders);
    return c.json({ username, password }, 200, credentialResponseHeaders);
  }

  async function handleAListCredential(c: any) {
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    const resolved = await resolveClientAuthContext(c, baseUrl);
    if (resolved.failure) return credentialAuthFailureResponse(c, resolved.failure);
    const context = resolved.context!;
    if (context.mode === 'none') {
      return c.json({ error: 'credential distribution disabled' }, 404, credentialResponseHeaders);
    }

    const source = c.req.query('src');
    if (!source) return c.json({ error: 'src is required' }, 400, credentialResponseHeaders);
    const target = validatePublicHttpUrl(source);
    if (!target) return c.json({ error: 'invalid src url' }, 400, credentialResponseHeaders);

    try {
      const parsed = await fetchAListJson(target.toString());
      if (Array.isArray(parsed.drives)) {
        const credentials = selectCredentialsForContext(await loadCredentials(storage), context);
        const merged = injectAListDriveCredentials(parsed.drives, credentials);
        if (merged.changed) parsed.drives = merged.drives;
      }
      return c.json(parsed, 200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'fetch_failed';
      const status = message === 'invalid_url' || message === 'invalid_redirect' ? 400 : 502;
      return c.json({ error: message }, status, credentialResponseHeaders);
    }
  }

  async function handleAliyunTokenJson(c: any) {
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    const resolved = await resolveClientAuthContext(c, baseUrl);
    if (resolved.failure) return credentialAuthFailureResponse(c, resolved.failure);
    const context = resolved.context!;
    if (context.mode === 'none' || !context.platforms.includes('aliyun')) {
      return c.json({ error: 'credential distribution disabled' }, 404, tokenResponseHeaders);
    }
    const credentials = selectCredentialsForContext(await loadCredentials(storage), context);
    const tokenJson = generateTokenJson(credentials, ['aliyun']);
    const token = typeof tokenJson.token === 'string' ? tokenJson.token.trim() : '';
    if (!token) return c.json({ error: 'no credential available' }, 404, tokenResponseHeaders);
    // 3D Ali.init 明确读取该 JSON 的 token 字段；不要返回完整 token.json，
    // 避免其他平台凭证因一个源而扩大暴露面。
    return c.json({ token }, 200, tokenResponseHeaders);
  }

  async function handleTvfanConfig(c: any) {
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    const resolved = await resolveClientAuthContext(c, baseUrl);
    if (resolved.failure) return credentialAuthFailureResponse(c, resolved.failure);
    const context = resolved.context!;
    if (context.mode === 'none') {
      return c.json({ error: 'credential distribution disabled' }, 404, tokenResponseHeaders);
    }
    const credentials = selectCredentialsForContext(await loadCredentials(storage), context);
    const config = generateTvfanConfig(credentials);
    // 正式 2cc 契约只接受五个凭证字段。空响应会被误判为服务端凭证模式
    // 已启用并跳过扫码，必须返回 404 让客户端回退本地登录。
    if (Object.keys(config).length === 0) {
      return c.json({ error: 'no credential available' }, 404, tokenResponseHeaders);
    }
    return c.json(config, 200, tokenResponseHeaders);
  }

  async function handleTokenJson(c: any) {
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    const resolved = await resolveClientAuthContext(c, baseUrl);
    if (resolved.failure) return credentialAuthFailureResponse(c, resolved.failure);
    const context = resolved.context!;
    if (context.mode === 'none') {
      return c.json({ error: 'credential distribution disabled' }, 404, tokenResponseHeaders);
    }
    const credentials = selectCredentialsForContext(await loadCredentials(storage), context);
    const tokenJson = generateTokenJson(credentials);
    // 空对象会被部分客户端/JAR 视为“服务端凭证模式已启用”并跳过扫码；
    // 没有实际可下发凭证时必须表现为端点不存在，让客户端回退本地登录。
    if (Object.keys(tokenJson).length === 0) {
      return c.json({ error: 'no credential available' }, 404, tokenResponseHeaders);
    }
    return c.json(tokenJson, 200, tokenResponseHeaders);
  }

  for (const prefix of ['', '/auth/:code']) {
    app.get(prefix + '/credential/quark', handleQuarkCredential);
    app.get(prefix + '/credential/uc', (c) => handleCookieCredential(c, 'uc'));
    app.get(prefix + '/credential/baidu', (c) => handleCookieCredential(c, 'baidu'));
    app.get(prefix + '/credential/tianyi', (c) => handleAccountCredential(c, 'tianyi'));
    app.get(prefix + '/credential/p123', (c) => handleAccountCredential(c, 'pan123'));
    app.get(prefix + '/credential/xunlei', (c) => handleAccountCredential(c, 'thunder'));
    app.get(prefix + '/credential/alist', handleAListCredential);
    app.get(prefix + '/credential/aliyun.json', handleAliyunTokenJson);
    app.get(prefix + '/credential/token.json', handleTokenJson);
    app.get(prefix + '/token.json', handleTokenJson);
    app.get(prefix + '/tvfan/config', handleTvfanConfig);
  }

  // ─── 背景设置公共接口（必须放在 /api/:key 之前以避免路由拦截） ────────
  app.get('/api/bg-settings', async (c) => {
    const raw = await storage.get(KV_BG_SETTINGS);
    if (!raw) return c.json({ type: 'default' });
    try {
      return c.json(JSON.parse(raw));
    } catch {
      return c.json({ type: 'default' });
    }
  });

  // ─── MacCMS API 代理（CF 版 + 本地版）──────────────────────
  if (config.workerBaseUrl || config.localBaseUrl) {
    const handleMacCMSApi = async (c: any) => {
      const baseUrl = await resolveBaseUrl(c);
      if (baseUrl instanceof Response) return baseUrl;
      const authResolved = await resolveOrRejectClientContext(c, baseUrl);
      if (authResolved.response) return authResolved.response;
      const authContext = authResolved.context!;
      const key = c.req.param('key');
      const raw = await storage.get(KV_MACCMS_SOURCES);
      const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
      const source = sources.find((s) => s.key === key);

      if (!source) {
        return c.json({ error: 'Unknown MacCMS source' }, 404);
      }

      const targetUrl = new URL(source.api);
      const reqUrl = new URL(c.req.url);
      reqUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));

      // 构造候选请求链：本地模式下优先走 edge（Vercel → CF），兜底直连
      const attempts: { label: string; url: string; headers: Record<string, string> }[] = [];

      if (!config.workerBaseUrl) {
        const edgeRaw = await storage.get(KV_EDGE_PROXIES);
        if (edgeRaw) {
          const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
          const encoded = encodeURIComponent(targetUrl.toString());
          if (edge.vercel) {
            attempts.push({
              label: 'vercel',
              url: `${edge.vercel.replace(/\/$/, '')}/api/proxy?url=${encoded}`,
              headers: {},
            });
          }
          if (edge.cf) {
            attempts.push({
              label: 'cf',
              url: `${edge.cf.replace(/\/$/, '')}/fetch-proxy?url=${encoded}`,
              headers: config.adminToken ? { Authorization: `Bearer ${config.adminToken}` } : {},
            });
          }
        }
      }

      attempts.push({ label: 'direct', url: targetUrl.toString(), headers: {} });

      let lastError = '';
      for (const { label, url, headers } of attempts) {
        try {
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'okhttp/3.12.0', ...headers },
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) {
            lastError = `upstream ${resp.status}`;
            console.log(`[maccms-proxy] ${key} via ${label} fail: ${lastError}`);
            continue;
          }
          const data = await resp.json();
          console.log(`[maccms-proxy] ${key} via ${label} ok`);
          return c.json(data, 200, {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300',
          });
        } catch (error: unknown) {
          lastError = error instanceof Error ? error.message : String(error);
          console.log(`[maccms-proxy] ${key} via ${label} fail: ${lastError}`);
        }
      }

      return c.json({ error: lastError || 'All proxies failed' }, 502);
    };
    app.all('/api/:key', handleMacCMSApi);
    app.all('/auth/:code/api/:key', handleMacCMSApi);
  }

  // ─── JAR 代理 ─────────────────────────────────────────
  if (config.workerBaseUrl) {
    // CF 版：用 CF Cache + KV 二进制缓存
    const handleCfJar = async (c: any) => {
      const baseUrl = await resolveBaseUrl(c);
      if (baseUrl instanceof Response) return baseUrl;
      const authResolved = await resolveOrRejectClientContext(c, baseUrl);
      if (authResolved.response) return authResolved.response;
      const rawKey = c.req.param('key');
      const key = normalizeJarRequestKey(rawKey);

      // 1. 查 CF Cache
      const cache = (caches as any).default as Cache;
      const cacheKey = new Request(c.req.url);
      const cached = await cache.match(cacheKey);
      if (cached) {
        c.executionCtx.waitUntil(markJarReady(storage, key));
        return cached;
      }

      const ttl = isMd5Key(key) ? 86400 : 21600; // MD5 key → 24h, URL hash → 6h
      const binaryHeaders = {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': `public, max-age=${ttl}`,
        'Access-Control-Allow-Origin': '*',
      };

      // 2. 优先读 KV 预缓存二进制。聚合阶段已预写入时，客户端无需等待慢上游。
      const binBase64 = await storage.get('jar_bin:' + key);
      if (binBase64) {
        const binary = base64ToUint8Array(binBase64);
        const response = new Response(binary, { headers: binaryHeaders });
        c.executionCtx.waitUntil(Promise.all([
          cache.put(cacheKey, response.clone()),
          markJarReady(storage, key),
        ]).then(() => undefined));
        return response;
      }

      // 3. 查 KV 原始 URL
      const originalUrl = await lookupJarUrl(key, storage);
      if (!originalUrl) {
        return c.json({ error: 'Unknown JAR key' }, 404);
      }

      // 4. 回源必须带超时，避免上游卡住整个客户端启动。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      try {
        const resp = await fetch(originalUrl, {
          headers: { 'User-Agent': 'okhttp/3.12.0' },
          signal: controller.signal,
        });

        if (resp.ok) {
          const response = new Response(resp.body, { headers: binaryHeaders });
          c.executionCtx.waitUntil(Promise.all([
            cache.put(cacheKey, response.clone()),
            markJarReady(storage, key),
          ]).then(() => undefined));
          return response;
        }

        console.log(`[jar-proxy] Origin returned ${resp.status} for ${key}`);
      } catch (error: unknown) {
        console.log(`[jar-proxy] Origin fetch error for ${key}: ${error instanceof Error ? error.message : error}`);
      } finally {
        clearTimeout(timer);
      }

      return c.json({ error: 'JAR unavailable from origin and no binary cache' }, 502);
    };
    app.get('/jar/:key', handleCfJar);
    app.get('/auth/:code/jar/:key', handleCfJar);
  } else if (config.localBaseUrl) {
    // Node.js 版：文件缓存 + 流式透传。不要先 await arrayBuffer，否则 4MB JAR
    // 会等到完整下载完才向 TVBox 发首包；缓存写入放到后台完成。
    const fs = require('fs');
    const pathMod = require('path');
    const jarCacheDir = pathMod.resolve(process.env.DATA_DIR || pathMod.join(process.cwd(), 'data'), 'jars');
    if (!fs.existsSync(jarCacheDir)) fs.mkdirSync(jarCacheDir, { recursive: true });

    // 过期缓存可先返回、后台刷新。Render 保活实例上可避免每轮 TTL 到期后
    // 用户再次等待完整 JAR 下载。
    const backgroundRefreshes = new Map<string, Promise<void>>();
    function refreshJarInBackground(key: string, originalUrl: string, cachePath: string): void {
      if (backgroundRefreshes.has(key)) return;
      const task = (async () => {
        const resp = await fetch(originalUrl, {
          headers: { 'User-Agent': 'okhttp/3.12.0' },
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buffer = Buffer.from(await resp.arrayBuffer());
        const tmpPath = cachePath + '.tmp';
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, cachePath);
        console.log('[jar-proxy] Refreshed ' + key + '.jar (' + (buffer.length / 1024).toFixed(1) + ' KB)');
      })()
        .catch((error: unknown) => {
          console.log('[jar-proxy] Background refresh error for ' + key + ': ' + (error instanceof Error ? error.message : error));
        })
        .finally(() => backgroundRefreshes.delete(key));
      backgroundRefreshes.set(key, task);
    }

    const handleNodeJar = async (c: any) => {
      const baseUrl = await resolveBaseUrl(c);
      if (baseUrl instanceof Response) return baseUrl;
      const authResolved = await resolveOrRejectClientContext(c, baseUrl);
      if (authResolved.response) return authResolved.response;
      const rawKey = c.req.param('key');
      const key = normalizeJarRequestKey(rawKey);

      const cachePath = pathMod.join(jarCacheDir, `${key}.jar`);
      const ttl = isMd5Key(key) ? 86400_000 : 21600_000;
      const cacheHeaders = {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': `public, max-age=${ttl / 1000}`,
        'Access-Control-Allow-Origin': '*',
      };

      // 文件缓存命中无需先查远端映射。启动预热/上一次请求写入后，这里直接
      // 返回本地字节，并异步补齐就绪索引。
      if (fs.existsSync(cachePath)) {
        const stat = fs.statSync(cachePath);
        const data = fs.readFileSync(cachePath);
        void markJarReady(storage, key).catch(() => {});
        if (Date.now() - stat.mtimeMs >= ttl) {
          void lookupJarUrl(key, storage).then((originalUrl) => {
            if (originalUrl) refreshJarInBackground(key, originalUrl, cachePath);
          });
        }
        return new Response(data, { headers: cacheHeaders });
      }

      const originalUrl = await lookupJarUrl(key, storage);
      if (!originalUrl) {
        return c.json({ error: 'Unknown JAR key' }, 404);
      }

      try {
        const resp = await fetch(originalUrl, {
          headers: { 'User-Agent': 'okhttp/3.12.0' },
        });
        if (!resp.ok) {
          console.log(`[jar-proxy] Origin returned ${resp.status} for ${key}`);
        } else if (resp.body) {
          // 用 tee 分出一条流给客户端、另一条流后台写缓存，避免重复请求上游。
          const [clientBody, cacheBody] = resp.body.tee();
          void (async () => {
            try {
              const reader = cacheBody.getReader();
              const chunks: Uint8Array[] = [];
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
              }
              const buffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
              const tmpPath = pathMod.join(jarCacheDir, key + '.jar.tmp');
              const targetPath = pathMod.join(jarCacheDir, key + '.jar');
              fs.writeFileSync(tmpPath, buffer);
              fs.renameSync(tmpPath, targetPath);
              await markJarReady(storage, key);
              console.log('[jar-proxy] Cached ' + key + '.jar (' + (buffer.length / 1024).toFixed(1) + ' KB)');
            } catch (error: unknown) {
              console.log('[jar-proxy] Cache write error for ' + key + ': ' + (error instanceof Error ? error.message : error));
            }
          })();
          return new Response(clientBody, { headers: cacheHeaders });
        }
      } catch (error: unknown) {
        console.log(`[jar-proxy] Origin fetch error for ${key}: ${error instanceof Error ? error.message : error}`);
      }

      // 上游暂时失败时，过期文件仍可作为可用兜底。
      if (fs.existsSync(cachePath)) {
        const data = fs.readFileSync(cachePath);
        void markJarReady(storage, key).catch(() => {});
        return new Response(data, { headers: cacheHeaders });
      }

      return c.json({ error: 'JAR unavailable from origin' }, 502);
    };
    app.get('/jar/:key', handleNodeJar);
    app.get('/auth/:code/jar/:key', handleNodeJar);
  }

  // ─── 直播源代理（仅 CF 版）──────────────────────────────
  if (config.workerBaseUrl) {
    const handleLiveSource = async (c: any) => {
      const baseUrl = await resolveBaseUrl(c);
      if (baseUrl instanceof Response) return baseUrl;
      const authResolved = await resolveOrRejectClientContext(c, baseUrl);
      if (authResolved.response) return authResolved.response;
      const authContext = authResolved.context!;
      const key = c.req.param('key');
      const isCfRuntime = !!config.workerBaseUrl && typeof caches !== 'undefined';

      const cache = (caches as any).default as Cache;
      // Version the live cache key so updated grouping/filter policy is not hidden
      // by an old cached live text response after deployment.
      const cacheKey = new Request(`https://live-cache.internal/live/${encodeURIComponent(key)}?v=20260929-1`);
      const cached = await cache.match(cacheKey);
      if (cached) {
        const cachedText = await cached.clone().text();
        if (cachedText.trim() && cachedText.includes('#genre#')) {
          const rewritten = applyAuthPrefixToProxyUrls(cachedText, authContext);
          const headers = new Headers(cached.headers);
          headers.delete('content-length');
          headers.delete('content-encoding');
          return new Response(rewritten, { status: cached.status, headers });
        }
        // 缓存内容异常不代表上游永久失效；仅清除坏缓存并让客户端稍后重试。
        await cache.delete(cacheKey);
        return c.json({ error: 'Cached live source is invalid or empty' }, 502, {
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
      }

      const source = await lookupLiveSource(key, storage);
      if (!source || isBlockedLiveSource(source)) {
        if (source && isBlockedLiveSource(source)) {
          await cache.delete(cacheKey);
          await removeLiveProxyEntry(key, storage);
        }
        return c.json({ error: 'Unknown live source key' }, 404, {
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
      }

      const prebuilt = await storage.get(`${KV_LIVE_TEXT_PREFIX}${key}`);
      if (prebuilt && prebuilt.trim() && prebuilt.includes('#genre#')) {
        const response = new Response(prebuilt, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': `public, max-age=${LIVE_PROXY_TTL}`,
            'Access-Control-Allow-Origin': '*',
            'X-Live-Source-Filtered': '1',
            'X-Live-Source-Prebuild': '1',
          },
        });
        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      try {
        const channelSpeedMap = await loadChannelSpeedMap(storage);
        const result = await filterLivesBySourceDetailed(
          [{ name: source.name || '直播源', url: source.url, ua: source.ua, header: source.header }],
          isCfRuntime ? 4500 : 8000,
          channelSpeedMap,
          {
            maxUrlsPerChannel: 6,
            maxChannels: 12000,
            minChannelsPerSource: 5,
            maxAdRatio: 0.5,
            minPlayableRatio: 0.2,
            storage,
            concurrency: 1,
            useCache: true,
          },
        );

        const text = formatLiveGroupsAsTxt(result.groups);
        if (!text.trim() || !text.includes('#genre#')) {
          if (result.failure === 'invalid') {
            // 下载成功但确认质量不合格：永久删除该入口。
            await cache.delete(cacheKey);
            await removeLiveProxyEntry(key, storage);
            return c.json({ error: 'Invalid or empty live source' }, 404, {
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            });
          }

          // 超时、限流、5xx、网络异常等临时失败：返回 502，保留 manifest 入口。
          await cache.delete(cacheKey);
          return c.json({ error: result.reason || 'Live source temporarily unavailable' }, 502, {
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
        }

        const response = new Response(text, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': `public, max-age=${LIVE_PROXY_TTL}`,
            'Access-Control-Allow-Origin': '*',
            'X-Live-Source-Filtered': '1',
          },
        });

        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return c.json({ error: msg }, 502, {
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
      }
    };
    app.get('/live/:key', handleLiveSource);
    app.get('/auth/:code/live/:key', handleLiveSource);
  }
  // ─── 图片代理（仅 CF 版）──────────────────────────────
  if (config.workerBaseUrl) {
    app.get('/img/*', async (c) => {
      // 从完整 URL 中提取原始图片地址（/img/ 之后的所有内容，含 query string）
      const fullUrl = c.req.url;
      const marker = '/img/';
      const markerIdx = fullUrl.indexOf(marker);
      const originalUrl = fullUrl.substring(markerIdx + marker.length);

      if (!originalUrl.startsWith('http://') && !originalUrl.startsWith('https://')) {
        return c.json({ error: 'Invalid image URL' }, 400);
      }

      // 1. 查 CF Cache
      const cache = (caches as any).default as Cache;
      const cacheKey = new Request(c.req.url);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      // 2. 回源拉取
      try {
        const resp = await fetch(originalUrl, {
          headers: { 'User-Agent': 'okhttp/3.12.0' },
        });

        if (!resp.ok) {
          return c.json({ error: `Origin returned ${resp.status}` }, 502);
        }

        // 3. 构建响应 + 异步写缓存
        const contentType = resp.headers.get('Content-Type') || 'image/jpeg';
        const response = new Response(resp.body, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': `public, max-age=${IMG_PROXY_TTL}`,
            'Access-Control-Allow-Origin': '*',
          },
        });

        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return c.json({ error: msg }, 502);
      }
    });
  }

  // ─── Live Sources Admin API ────────────────────────────
  app.get('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(entries.filter((entry) => !isBlockedLiveSource(entry)));
  });

  app.get('/admin/lives/export', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(createSourceBackup('live-sources', entries.filter((entry) => !isBlockedLiveSource(entry))));
  });

  app.post('/admin/lives/import', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { input?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const input = body.input?.trim();
    if (!input) return c.json({ error: 'input is required' }, 400);

    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    const looksLikeBackup = input.startsWith('{') || input.startsWith('[');
    const listResult = parseSourceList(input);
    const namedInlineList = listResult.entries.some((entry) => entry.explicitName) || listResult.entries.length > 1;
    if (namedInlineList && !looksLikeBackup) {
      const existingUrls = new Set(entries.map((entry) => entry.url));
      const addedSources: string[] = [];
      let duplicates = listResult.duplicates;
      for (const parsedEntry of listResult.entries) {
        if (existingUrls.has(parsedEntry.url)) {
          duplicates++;
          continue;
        }
        const entry: LiveSourceEntry = { name: parsedEntry.name, url: parsedEntry.url };
        if (isBlockedLiveSource(entry)) continue;
        entries.push(entry);
        existingUrls.add(entry.url);
        addedSources.push(entry.url);
      }
      if (addedSources.length > 0) {
        await storage.put(KV_LIVE_SOURCES, JSON.stringify(entries));
        await markOutputDirty();
      }
      return c.json({ type: 'list', added: addedSources.length, duplicates, invalid: listResult.invalid, sources: addedSources });
    }

    let jsonText = input;
    let remoteWasFetched = false;
    if (/^https?:\/\//i.test(input)) {
      try {
        const resp = await fetch(input, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': 'okhttp/3.12.0',
          },
        });
        if (!resp.ok) return c.json({ error: `Fetch failed: HTTP ${resp.status}` }, 502);
        jsonText = await resp.text();
        remoteWasFetched = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Fetch failed: ${msg}` }, 502);
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      // 单行纯 URL 既可能是直播源，也可能是历史用法中的远程 TVBox 配置。
      // 若远程内容不是 JSON，则按直播源 URL 本身导入。
      if (!remoteWasFetched) return c.json({ error: 'Failed to parse JSON' }, 400);
      parsed = null;
    }

    const liveMismatch = backupTypeMismatch(parsed, 'live-sources');
    if (liveMismatch) {
      return c.json({ error: `Backup type mismatch: expected live-sources, got ${liveMismatch}` }, 400);
    }
    const backupItems = extractBackupItems(parsed, 'live-sources');
    if (backupItems) {
      parsed = backupItems;
    }
    const imported = parsed
      ? normalizeImportedLives(parsed)
      : (/^https?:\/\//i.test(input) ? [{ name: autoNameFromUrl(input), url: input }] : []);
    if (imported.length === 0) {
      return c.json({ error: 'No valid live sources found' }, 400);
    }

    const existingUrls = new Set(entries.map((entry) => entry.url));
    const seenImportedUrls = new Set<string>();
    const addedSources: string[] = [];
    let duplicates = 0;

    for (const entry of imported) {
      if (existingUrls.has(entry.url) || seenImportedUrls.has(entry.url)) {
        duplicates++;
        continue;
      }
      seenImportedUrls.add(entry.url);
      existingUrls.add(entry.url);
      entries.push(entry);
      addedSources.push(entry.url);
    }

    if (addedSources.length > 0) {
      await storage.put(KV_LIVE_SOURCES, JSON.stringify(entries));
      await markOutputDirty();
    }

    return c.json({ added: addedSources.length, duplicates, sources: addedSources });
  });

  app.post('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { name?: string; url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const name = body.name?.trim() || autoNameFromUrl(url);
    if (isBlockedLiveSource({ name, url })) {
      return c.json({ error: 'This live source is blocked by policy' }, 400);
    }
    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];

    if (entries.some((e) => e.url === url)) {
      return c.json({ error: 'Live source already exists' }, 409);
    }

    entries.push({ name, url });
    await storage.put(KV_LIVE_SOURCES, JSON.stringify(entries));
    await markOutputDirty();

    return c.json({ success: true });
  });

  app.delete('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = entries.filter((e) => e.url !== url);
    await storage.put(KV_LIVE_SOURCES, JSON.stringify(filtered));
    await markOutputDirty();

    return c.json({ success: true });
  });

  app.put('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { oldUrl?: string; name?: string; url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const oldUrl = body.oldUrl?.trim();
    if (!oldUrl) return c.json({ error: 'Old URL is required' }, 400);

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const name = body.name?.trim() || autoNameFromUrl(url);
    if (isBlockedLiveSource({ name, url })) {
      return c.json({ error: 'This live source is blocked by policy' }, 400);
    }
    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];

    const index = entries.findIndex((e) => e.url === oldUrl);
    if (index === -1) {
      return c.json({ error: 'Live source not found' }, 404);
    }

    // 确保修改后的新 URL 不与其它已有直播源的 URL 冲突
    if (entries.some((e, idx) => idx !== index && e.url === url)) {
      return c.json({ error: 'Live source already exists' }, 409);
    }

    const entry = entries[index];
    entry.name = name;
    entry.url = url;

    await storage.put(KV_LIVE_SOURCES, JSON.stringify(entries));
    await markOutputDirty();

    return c.json({ success: true });
  });

  app.post('/admin/lives/toggle', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { url?: string; disabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    const entry = entries.find((e) => e.url === url);
    if (!entry) return c.json({ error: 'Source not found' }, 404);
    if (!body.disabled && isBlockedLiveSource(entry)) {
      return c.json({ error: 'This live source is blocked by policy' }, 400);
    }

    entry.disabled = !!body.disabled;
    await storage.put(KV_LIVE_SOURCES, JSON.stringify(entries));
    await markOutputDirty();

    return c.json({ success: true, disabled: entry.disabled });
  });

  // ─── MacCMS Admin API ─────────────────────────────────
  app.get('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(sources);
  });

  app.get('/admin/maccms/export', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(createSourceBackup('maccms-sources', sources));
  });

  app.post('/admin/maccms/import', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { input?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const input = body.input?.trim();
    if (!input) return c.json({ error: 'input is required' }, 400);

    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const existingKeys = new Set(sources.map((source) => source.key));
    const existingApis = new Set(sources.map((source) => source.api));
    const addedSources: string[] = [];
    let duplicates = 0;
    let invalid: unknown[] = [];

    const listResult = parseSourceList(input);
    const looksLikeBackup = input.startsWith('{') || input.startsWith('[');
    const singleLineDirectSource = !input.includes('\n') && listResult.entries.length === 1 && listResult.invalid.length === 0 && /^https?:\/\//i.test(input);
    const listMode = !looksLikeBackup && (input.includes('\n') || singleLineDirectSource || listResult.entries.some((entry) => entry.explicitName));
    let imported: MacCMSSourceEntry[] = [];
    if (listMode) {
      invalid = listResult.invalid;
      duplicates = listResult.duplicates;
      const usedKeys = new Set(existingKeys);
      for (const parsedEntry of listResult.entries) {
        imported.push({
          key: macCMSKeyFromUrl(parsedEntry.url, usedKeys),
          name: parsedEntry.name,
          api: parsedEntry.url,
        });
      }
    } else {
      let jsonText = input;
      if (/^https?:\/\//i.test(input)) {
        try {
          const resp = await fetch(input, {
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'User-Agent': 'okhttp/3.12.0',
            },
          });
          if (!resp.ok) return c.json({ error: `Fetch failed: HTTP ${resp.status}` }, 502);
          jsonText = await resp.text();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return c.json({ error: `Fetch failed: ${msg}` }, 502);
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        return c.json({ error: 'Failed to parse JSON' }, 400);
      }
      const mcMismatch = backupTypeMismatch(parsed, 'maccms-sources');
      if (mcMismatch) {
        return c.json({ error: `Backup type mismatch: expected maccms-sources, got ${mcMismatch}` }, 400);
      }
      const backupItems = extractBackupItems(parsed, 'maccms-sources');
      imported = normalizeImportedMacCMS(backupItems || parsed);
      if (imported.length === 0) {
        return c.json({ error: 'No valid MacCMS sources found' }, 400);
      }
    }

    for (const entry of imported) {
      if (existingKeys.has(entry.key) || existingApis.has(entry.api)) {
        duplicates++;
        continue;
      }
      existingKeys.add(entry.key);
      existingApis.add(entry.api);
      sources.push(entry);
      addedSources.push(entry.key);
    }

    if (addedSources.length > 0) {
      await storage.put(KV_MACCMS_SOURCES, JSON.stringify(sources));
      await markOutputDirty();
    }

    return c.json({
      type: listMode ? 'list' : 'backup',
      added: addedSources.length,
      duplicates,
      invalid,
      sources: addedSources,
    });
  });
  app.post('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: MacCMSSourceEntry | MacCMSSourceEntry[];
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const newEntries = Array.isArray(body) ? body : [body];

    // 验证字段
    for (const entry of newEntries) {
      if (!entry.key?.trim() || !entry.name?.trim() || !entry.api?.trim()) {
        return c.json({ error: 'Each entry requires key, name, and api' }, 400);
      }
      try {
        new URL(entry.api);
      } catch {
        return c.json({ error: `Invalid URL: ${entry.api}` }, 400);
      }
    }

    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const existingKeys = new Set(sources.map((s) => s.key));

    let added = 0;
    for (const entry of newEntries) {
      if (!existingKeys.has(entry.key)) {
        sources.push({ key: entry.key.trim(), name: entry.name.trim(), api: entry.api.trim() });
        existingKeys.add(entry.key);
        added++;
      }
    }

    await storage.put(KV_MACCMS_SOURCES, JSON.stringify(sources));
    await markOutputDirty();
    return c.json({ success: true, added, total: sources.length });
  });

  app.delete('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { key?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const key = body.key?.trim();
    if (!key) return c.json({ error: 'key is required' }, 400);

    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = sources.filter((s) => s.key !== key);
    await storage.put(KV_MACCMS_SOURCES, JSON.stringify(filtered));
    await markOutputDirty();

    return c.json({ success: true });
  });

  app.put('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { oldKey?: string; key?: string; name?: string; api?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const oldKey = body.oldKey?.trim();
    if (!oldKey) return c.json({ error: 'Old Key is required' }, 400);

    const key = body.key?.trim();
    const name = body.name?.trim();
    const api = body.api?.trim();

    if (!key || !name || !api) {
      return c.json({ error: 'key, name, and api are required' }, 400);
    }

    try {
      new URL(api);
    } catch {
      return c.json({ error: `Invalid URL: ${api}` }, 400);
    }

    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];

    const index = sources.findIndex((s) => s.key === oldKey);
    if (index === -1) {
      return c.json({ error: 'MacCMS Source not found' }, 404);
    }

    // 确保修改后的新 Key 不与其它已有 MacCMS 源冲突
    if (sources.some((s, idx) => idx !== index && s.key === key)) {
      return c.json({ error: 'MacCMS Key already exists' }, 409);
    }

    const entry = sources[index];
    entry.key = key;
    entry.name = name;
    entry.api = api;

    await storage.put(KV_MACCMS_SOURCES, JSON.stringify(sources));
    await markOutputDirty();

    return c.json({ success: true });
  });

  app.post('/admin/maccms/toggle', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { key?: string; disabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const key = body.key?.trim();
    if (!key) return c.json({ error: 'key is required' }, 400);

    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const entry = sources.find((s) => s.key === key);
    if (!entry) return c.json({ error: 'Source not found' }, 404);

    entry.disabled = !!body.disabled;
    await storage.put(KV_MACCMS_SOURCES, JSON.stringify(sources));
    await markOutputDirty();

    return c.json({ success: true, disabled: entry.disabled });
  });

  app.post('/admin/maccms/validate', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { api?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const api = body.api?.trim();
    if (!api) return c.json({ error: 'api is required' }, 400);

    const ok = await validateMacCMS(api, config.siteTimeoutMs);
    return c.json({ api, valid: ok });
  });

  // ─── Config Editor 页面 ─────────────────────────────────
  app.get('/admin/config-editor', (c) => {
    return c.html(configEditorHtml);
  });

  // ─── Config Editor API ─────────────────────────────────
  app.get('/admin/config-data', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // 读取过滤前的完整配置（含被屏蔽的项），降级到已过滤配置
    const full = await storage.get(KV_MERGED_CONFIG_FULL);
    const cached = full || await storage.get(KV_MERGED_CONFIG);
    if (!cached) {
      return c.json({ sites: [], parses: [], lives: [] });
    }

    let parsed: TVBoxConfig;
    try {
      parsed = JSON.parse(cached);
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }

    const blacklist = await loadBlacklist(storage);
    const siteSet = new Set(blacklist.sites);
    const parseSet = new Set(blacklist.parses);
    const liveSet = new Set(blacklist.lives);

    // 搜索页必须使用与搜索配额、质量池完全相同的候选集合。
    // 这里不能简单按 searchable===1 统计：JS URL 等源会在质量分级前被排除，
    // 直接统计会把“未入选源”混进候选源，导致数字与实际下发口径不一致。
    const qualityPool = await loadQualityPool(storage);
    const qualityEntryMap = new Map(
      (qualityPool?.entries || []).map(entry => [entry.key, entry]),
    );
    const candidateKeySet = candidateKeysFromPool(qualityPool);
    const searchableCandidateKeys = new Set(
      (parsed.sites || [])
        .filter(site => site.searchable === 1)
        .map(site => site.key),
    );
    const candidateReason = (site: TVBoxSite): string => {
      const entry = qualityEntryMap.get(site.key);
      if (!entry) {
        if (site.type === 3 && /^https?:\/\//.test(site.api || '')) return 'js-url-excluded';
        if (site.searchable !== 1) return 'not-searchable';
        return 'not-in-quality-pool';
      }
      if (entry.grade === 'timeout') return 'timeout';
      if (entry.grade === 'unusable') return 'unusable';
      return 'not-candidate';
    };

    // 预编译正则规则用于标记 regexBlocked
    const activeRegexRules = blacklist.regexRules.filter(r => r.enabled);
    const compiledRegex: Array<{ re: RegExp; field: string }> = [];
    for (const rule of activeRegexRules) {
      try { compiledRegex.push({ re: new RegExp(rule.pattern, 'i'), field: rule.field }); } catch { /* skip */ }
    }
    const overrideSet = new Set(blacklist.regexBlockOverrides);

    // Build sites with fingerprint + blocked status + group
    const sites = [];
    for (const site of parsed.sites || []) {
      const fp = await siteFingerprint(site);
      const api = site.api || '';
      let group = '其他';
      if (api.startsWith('csp_') || api.startsWith('py_') || api.startsWith('js_')) {
        group = api;
      } else if (api.startsWith('http')) {
        try { group = '远程: ' + new URL(api).hostname; } catch { group = '远程源'; }
      }
      const fpBlocked = siteSet.has(fp);
      let regexBlocked = false;
      let regexPattern = '';
      if (!fpBlocked && !overrideSet.has(site.name || '')) {
        for (const { re, field } of compiledRegex) {
          const value = String((site as unknown as Record<string, unknown>)[field] || '');
          if (re.test(value)) { regexBlocked = true; regexPattern = re.source; break; }
        }
      }
      sites.push({
        ...site,
        fingerprint: fp,
        blocked: fpBlocked || regexBlocked,
        regexBlocked,
        regexPattern,
        group,
        candidate: site.searchable === 1 && candidateKeySet.has(site.key),
        candidateReason: candidateKeySet.has(site.key) ? undefined : candidateReason(site),
      });
    }

    const parses = (parsed.parses || []).map(p => ({
      ...p,
      blocked: parseSet.has(p.url),
    }));

    const lives = (parsed.lives || []).map(l => ({
      ...l,
      blocked: liveSet.has(l.url || l.api || ''),
    }));

    return c.json({
      sites,
      parses,
      lives,
      searchQuality: {
        candidateCount: candidateKeySet.size,
        searchableCount: searchableCandidateKeys.size,
        qualityPoolTotal: qualityPool?.grades?.poolTotal ?? 0,
        qualitySnapshotTotal: qualityPool?.total ?? 0,
        candidateKeys: [...candidateKeySet],
      },
    });
  });

  app.post('/admin/blacklist', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { type?: string; id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, id } = body;
    if (!type || !id) return c.json({ error: 'type and id are required' }, 400);
    if (!['sites', 'parses', 'lives'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, or lives' }, 400);
    }

    const blacklist = await loadBlacklist(storage);
    const list = blacklist[type as keyof typeof blacklist] as string[];
    if (!list.includes(id)) {
      list.push(id);
    }
    await saveBlacklist(storage, blacklist);
    await markOutputDirty();
    await patchMergedConfig();

    return c.json({ success: true });
  });

  app.post('/admin/blacklist/batch', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { type?: string; ids?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, ids } = body;
    if (!type || !Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: 'type and ids[] are required' }, 400);
    }
    if (ids.length > 500) {
      return c.json({ error: 'Too many ids (max 500)' }, 400);
    }
    if (!['sites', 'parses', 'lives'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, or lives' }, 400);
    }

    const blacklist = await loadBlacklist(storage);
    const list = blacklist[type as keyof typeof blacklist] as string[];
    let added = 0;
    for (const id of ids) {
      if (typeof id === 'string' && !list.includes(id)) {
        list.push(id);
        added++;
      }
    }
    await saveBlacklist(storage, blacklist);
    await markOutputDirty();
    await patchMergedConfig();

    return c.json({ success: true, added });
  });

  app.delete('/admin/blacklist', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { type?: string; id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, id } = body;
    if (!type || !id) return c.json({ error: 'type and id are required' }, 400);
    if (!['sites', 'parses', 'lives'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, or lives' }, 400);
    }

    const blacklist = await loadBlacklist(storage);
    const key = type as keyof typeof blacklist;
    (blacklist[key] as string[]) = (blacklist[key] as string[]).filter((v: string) => v !== id);
    await saveBlacklist(storage, blacklist);
    await markOutputDirty();
    await patchMergedConfig();

    return c.json({ success: true });
  });

  // ─── 黑名单变更后实时 patch merged_config ──────────────
  async function patchMergedConfig(): Promise<void> {
    const fullRaw = await storage.get(KV_MERGED_CONFIG_FULL);
    if (!fullRaw) return;
    const blacklist = await loadBlacklist(storage);
    const hasBlacklist = blacklist.sites.length > 0 || blacklist.parses.length > 0 || blacklist.lives.length > 0 || blacklist.regexRules.some(r => r.enabled);

    let result: TVBoxConfig;
    if (!hasBlacklist) {
      result = JSON.parse(fullRaw);
    } else {
      const fullConfig: TVBoxConfig = JSON.parse(fullRaw);
      const { config: filtered } = await applyBlacklist(fullConfig, blacklist);
      result = filtered;
    }

    // 保留当前已合并的 Native lives（避免回退到 FongMi 格式）
    const currentRaw = await storage.get(KV_MERGED_CONFIG);
    if (currentRaw) {
      try {
        const current: TVBoxConfig = JSON.parse(currentRaw);
        if (Array.isArray(current.lives) && current.lives.length > 0 && current.lives[0]?.group) {
          result.lives = current.lives;
        }
      } catch { /* ignore parse error */ }
    }

    applyLegacyWoggCompatibility(result);

    // 重新应用 JAR proxy rewrite（与 aggregator Step 7 一致）
    result = await rewriteJarUrls(result, BASE_URL_PLACEHOLDER, storage);
    await storage.put(KV_MERGED_CONFIG, JSON.stringify(result));
    await clearDirtyMarker(storage);
  }

  // ─── 正则黑名单 ─────────────────────────────────────────
  app.get('/admin/blacklist/regex', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const blacklist = await loadBlacklist(storage);
    return c.json({ rules: blacklist.regexRules, overrides: blacklist.regexBlockOverrides });
  });

  app.post('/admin/blacklist/regex', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (deps.isSyncing?.()) return c.json({ error: 'Aggregation in progress, try later' }, 409);
    const body = await c.req.json<{ pattern: string; field: 'name' | 'api' | 'key'; enabled?: boolean }>();
    if (!body.pattern || !['name', 'api', 'key'].includes(body.field)) {
      return c.json({ error: 'Invalid input: pattern and field (name|api|key) required' }, 400);
    }
    const validation = validateRegexRule(body.pattern);
    if (!validation.ok) return c.json({ error: validation.error }, 400);
    const rule = {
      id: crypto.randomUUID().slice(0, 8),
      pattern: body.pattern,
      field: body.field,
      enabled: body.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    const blacklist = await loadBlacklist(storage);
    await saveRegexRule(storage, blacklist, rule);
    await markOutputDirty();
    await patchMergedConfig();
    return c.json({ success: true, rule });
  });

  app.put('/admin/blacklist/regex/:id', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (deps.isSyncing?.()) return c.json({ error: 'Aggregation in progress, try later' }, 409);
    const id = c.req.param('id');
    const body = await c.req.json<{ pattern?: string; field?: 'name' | 'api' | 'key'; enabled?: boolean }>();
    if (body.pattern) {
      const validation = validateRegexRule(body.pattern);
      if (!validation.ok) return c.json({ error: validation.error }, 400);
    }
    if (body.field && !['name', 'api', 'key'].includes(body.field)) {
      return c.json({ error: 'Invalid field' }, 400);
    }
    const blacklist = await loadBlacklist(storage);
    if (!blacklist.regexRules.find(r => r.id === id)) return c.json({ error: 'Rule not found' }, 404);
    await updateRegexRule(storage, blacklist, id, body);
    await markOutputDirty();
    await patchMergedConfig();
    return c.json({ success: true });
  });

  app.delete('/admin/blacklist/regex/:id', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const blacklist = await loadBlacklist(storage);
    if (!blacklist.regexRules.find(r => r.id === id)) return c.json({ error: 'Rule not found' }, 404);
    await deleteRegexRule(storage, blacklist, id);
    await markOutputDirty();
    await patchMergedConfig();
    return c.json({ success: true });
  });

  app.post('/admin/blacklist/regex/test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ pattern: string; field: 'name' | 'api' | 'key' }>();
    if (!body.pattern || !['name', 'api', 'key'].includes(body.field)) {
      return c.json({ error: 'Invalid input' }, 400);
    }
    const validation = validateRegexRule(body.pattern);
    if (!validation.ok) return c.json({ error: validation.error }, 400);
    const raw = await storage.get(KV_MERGED_CONFIG_FULL);
    if (!raw) return c.json({ matched: [] });
    const fullConfig: TVBoxConfig = JSON.parse(raw);
    const result = testRegexAgainstSites(fullConfig.sites || [], body.pattern, body.field);
    return c.json(result);
  });

  // ─── 聚合日志 ──────────────────────────────────────────
  app.get('/admin/agg-logs', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_AGG_LOGS);
    const logs = raw ? JSON.parse(raw) : [];
    const limitStr = c.req.query('limit');
    const limit = limitStr ? Math.min(parseInt(limitStr) || 20, 50) : 20;
    const compact = c.req.query('compact') === '1' || c.req.query('compact') === 'true';
    const sliced = logs.slice(-limit).reverse();
    if (!compact) {
      return c.json({ total: logs.length, logs: sliced });
    }
    // Keep the admin log view small enough for high-latency deployments while
    // preserving exact totals so the UI can show "+N more".
    const maxItems = 10;
    const maxErrorLength = 240;
    const compactLogs = sliced.map((log: Record<string, unknown>) => {
      const addedSites = Array.isArray(log.addedSites) ? log.addedSites : [];
      const removedSites = Array.isArray(log.removedSites) ? log.removedSites : [];
      const failedSources = Array.isArray(log.failedSources) ? log.failedSources : [];
      const errorMessage = typeof log.errorMessage === 'string'
        ? log.errorMessage.slice(0, maxErrorLength)
        : undefined;
      return {
        id: log.id,
        startTime: log.startTime,
        endTime: log.endTime,
        durationMs: log.durationMs,
        success: log.success,
        errorMessage,
        totalSources: log.totalSources,
        okSources: log.okSources,
        finalSiteCount: log.finalSiteCount,
        finalParseCount: log.finalParseCount,
        finalLiveCount: log.finalLiveCount,
        blacklistRemovedSites: log.blacklistRemovedSites,
        blacklistRemovedParses: log.blacklistRemovedParses,
        blacklistRemovedLives: log.blacklistRemovedLives,
        addedSites: addedSites.slice(0, maxItems).map((site: Record<string, unknown>) => ({ key: site.key, name: site.name })),
        addedSiteCount: addedSites.length,
        addedTruncated: addedSites.length > maxItems,
        removedSites: removedSites.slice(0, maxItems).map((site: Record<string, unknown>) => ({ key: site.key, name: site.name })),
        removedSiteCount: removedSites.length,
        removedTruncated: removedSites.length > maxItems,
        failedSources: failedSources.slice(0, maxItems).map((source: Record<string, unknown>) => ({
          url: source.url,
          name: source.name,
          status: source.status,
          errorMessage: typeof source.errorMessage === 'string' ? source.errorMessage.slice(0, maxErrorLength) : undefined,
        })),
        failedSourceCount: failedSources.length,
        failedTruncated: failedSources.length > maxItems,
      };
    });
    return c.json({ total: logs.length, logs: compactLogs });
  });

  app.delete('/admin/agg-logs', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await storage.put(KV_AGG_LOGS, '[]');
    return c.json({ success: true });
  });

  app.get('/admin/dirty-marker', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ dirty: await getDirtyMarker(storage) });
  });

  app.delete('/admin/dirty-marker', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await clearDirtyMarker(storage);
    return c.json({ success: true, dirty: false });
  });

  // ─── 分组排序 ──────────────────────────────────────────
  app.get('/admin/group-order', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const cfg = await loadGroupOrder(storage);
    return c.json(cfg);
  });

  app.put('/admin/group-order', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    let body: { rules?: unknown; unmatchedPosition?: string; enabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const cfg = {
      rules: Array.isArray(body.rules) ? body.rules : [],
      unmatchedPosition: (body.unmatchedPosition === 'before' ? 'before' : 'after') as 'before' | 'after',
      enabled: body.enabled !== false,
    };
    await saveGroupOrder(storage, cfg);
    await markOutputDirty();
    return c.json({ success: true, ...cfg });
  });

  // ─── 去重配置 ──────────────────────────────────────────
  app.get('/admin/dedup-config', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_DEDUP_CONFIG);
    if (!raw) {
      return c.json({ similarDedup: true, similarDedupThreshold: 0.85 });
    }
    try {
      return c.json(JSON.parse(raw));
    } catch {
      return c.json({ similarDedup: true, similarDedupThreshold: 0.85 });
    }
  });

  app.put('/admin/dedup-config', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    let body: { similarDedup?: boolean; similarDedupThreshold?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const cfg = {
      similarDedup: body.similarDedup !== false,
      similarDedupThreshold: typeof body.similarDedupThreshold === 'number'
        ? Math.max(0.5, Math.min(1.0, body.similarDedupThreshold))
        : 0.85,
    };
    await storage.put(KV_DEDUP_CONFIG, JSON.stringify(cfg));
    await markOutputDirty();
    return c.json({ success: true, ...cfg });
  });

  // ─── 背景设置 ──────────────────────────────────────────

  app.get('/admin/bg-settings', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_BG_SETTINGS);
    if (!raw) return c.json({ type: 'default' });
    try {
      return c.json(JSON.parse(raw));
    } catch {
      return c.json({ type: 'default' });
    }
  });

  app.put('/admin/bg-settings', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    let body: { type?: string; imageUrl?: string; overlay?: number; solidColor?: string; gradient?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const cfg = {
      type: body.type || 'default',
      imageUrl: body.imageUrl || '',
      overlay: typeof body.overlay === 'number' ? Math.max(0, Math.min(100, body.overlay)) : 85,
      solidColor: body.solidColor || '#0a0e14',
      gradient: body.gradient || '',
    };
    await storage.put(KV_BG_SETTINGS, JSON.stringify(cfg));
    storage.clear();
    return c.json({ success: true, ...cfg });
  });

  // ─── 刷新 ─────────────────────────────────────────────
  app.get('/admin/aggregation-status', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (deps.aggregationStatus) {
      return c.json(await deps.aggregationStatus());
    }
    return c.json({
      running: deps.isSyncing?.() === true,
      completed: false,
      message: deps.isSyncing?.() ? 'Aggregation is running' : 'Aggregation status is unavailable',
    });
  });

  app.post('/refresh', async (c) => {
    if (config.refreshToken || config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      const validTokens = [config.refreshToken, config.adminToken].filter(Boolean);
      if (!validTokens.some((t) => auth === `Bearer ${t}`)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    try {
      let hasCtx = false;
      try {
        if (c.executionCtx) {
          hasCtx = true;
        }
      } catch (e) {
        // Ignored: Hono throws if executionCtx getter is accessed in non-worker environments
      }

      if (hasCtx) {
        c.executionCtx.waitUntil(deps.triggerRefresh());
        return c.json({ success: true, started: true, running: true, message: 'Refresh started in background' }, 202);
      }

      const result = await deps.triggerRefresh();
      const normalized: AggregationTriggerResult = result ?? {
        started: true,
        running: false,
        completed: true,
        message: 'Refresh completed',
      };
      if (normalized.skipped) {
        return c.json({
          success: false,
          ...normalized,
          error: normalized.message || 'Aggregation is already running',
        }, 409);
      }
      if (normalized.started && normalized.running) {
        return c.json({
          success: true,
          ...normalized,
        }, 202);
      }
      if (normalized.completed) {
        return c.json({
          success: true,
          ...normalized,
        }, 200);
      }
      return c.json({
        success: false,
        ...normalized,
        error: normalized.message || 'Refresh failed',
      }, 500);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ success: false, error: msg }, 500);
    }
  });

  // ─── 直播禁用开关 ─────────────────────────────────────────
  app.get('/admin/live-disabled', async (c) => {
    const raw = await storage.get(KV_LIVE_DISABLED);
    return c.json({ disabled: raw === 'true' });
  });

  app.put('/admin/live-disabled', async (c) => {
    if (config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      if (auth !== `Bearer ${config.adminToken}`) return c.json({ error: 'Unauthorized' }, 401);
    }
    if (deps.isSyncing?.()) {
      return c.json({ error: 'Aggregation in progress, try later' }, 409);
    }
    const body = await c.req.json<{ disabled: boolean }>();
    await storage.put(KV_LIVE_DISABLED, body.disabled ? 'true' : 'false');
    if (body.disabled) {
      const currentRaw = await storage.get(KV_MERGED_CONFIG);
      if (currentRaw) {
        try {
          const current: TVBoxConfig = JSON.parse(currentRaw);
          current.lives = [];
          await storage.put(KV_MERGED_CONFIG, JSON.stringify(current));
        } catch {
          await markOutputDirty();
        }
      }
      await storage.put(KV_LIVE_MERGED_DATA, '[]');
      await storage.put(KV_LIVE_MERGED_TXT, '');
      await clearDirtyMarker(storage);
      return c.json({ success: true, disabled: body.disabled, patched: true });
    }
    await markOutputDirty();
    try { await deps.triggerRefresh(); } catch { /* best effort */ }
    return c.json({ success: true, disabled: body.disabled, patched: false });
  });

  // ─── 忽略第三方直播源开关 ──────────────────────────────────
  app.get('/admin/ignore-aggregated-lives', async (c) => {
    const raw = await storage.get(KV_IGNORE_AGGREGATED_LIVES);
    return c.json({ ignore: raw === 'true' });
  });

  app.put('/admin/ignore-aggregated-lives', async (c) => {
    if (config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      if (auth !== `Bearer ${config.adminToken}`) return c.json({ error: 'Unauthorized' }, 401);
    }
    if (deps.isSyncing?.()) {
      return c.json({ error: 'Aggregation in progress, try later' }, 409);
    }
    const body = await c.req.json<{ ignore: boolean }>();
    await storage.put(KV_IGNORE_AGGREGATED_LIVES, body.ignore ? 'true' : 'false');
    await markOutputDirty();
    try { await deps.triggerRefresh(); } catch { /* best effort */ }
    return c.json({ success: true, ignore: body.ignore });
  });

  // ─── 直播合并模式 ─────────────────────────────────────────
  app.get('/admin/live-merge-mode', async (c) => {
    const raw = await storage.get(KV_LIVE_MERGE_MODE);
    return c.json({ mode: raw || 'separated' });
  });

  app.put('/admin/live-merge-mode', async (c) => {
    if (config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      if (auth !== `Bearer ${config.adminToken}`) return c.json({ error: 'Unauthorized' }, 401);
    }
    if (deps.isSyncing?.()) {
      return c.json({ error: 'Aggregation in progress, try later' }, 409);
    }
    const body = await c.req.json<{ mode: string }>();
    const mode = body.mode === 'merged' ? 'merged' : 'separated';
    await storage.put(KV_LIVE_MERGE_MODE, mode);
    await markOutputDirty();
    try { await deps.triggerRefresh(); } catch { /* best effort */ }
    return c.json({ success: true, mode });
  });

  // ─── 智能 Base URL 开关 ──────────────────────────────────
  app.get('/admin/smart-base-url', async (c) => {
    const raw = await storage.get(KV_SMART_BASE_URL_ENABLED);
    return c.json({ enabled: raw === 'true' });
  });

  app.put('/admin/smart-base-url', async (c) => {
    if (config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      if (auth !== `Bearer ${config.adminToken}`) return c.json({ error: 'Unauthorized' }, 401);
    }
    const body = await c.req.json<{ enabled: boolean }>();
    await storage.put(KV_SMART_BASE_URL_ENABLED, body.enabled ? 'true' : 'false');
    storage.clear();
    return c.json({ success: true, enabled: body.enabled });
  });

  // ─── 站点验活设置 ───────────────────────────────────────
  app.get('/admin/site-probe-depth', async (c) => {
    const raw = await storage.get(KV_SITE_PROBE_DEPTH);
    return c.json({ depth: raw || 'deep' });
  });

  app.put('/admin/site-probe-depth', async (c) => {
    if (config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      if (auth !== `Bearer ${config.adminToken}`) return c.json({ error: 'Unauthorized' }, 401);
    }
    const body = await c.req.json<{ depth: 'shallow' | 'deep' }>();
    if (!['shallow', 'deep'].includes(body.depth)) return c.json({ error: 'Invalid depth' }, 400);
    await storage.put(KV_SITE_PROBE_DEPTH, body.depth);
    await markOutputDirty();
    return c.json({ success: true, depth: body.depth });
  });

  app.get('/admin/site-auto-clean', async (c) => {
    const raw = await storage.get(KV_SITE_AUTO_CLEAN);
    return c.json({ enabled: raw === 'true' });
  });

  app.put('/admin/site-auto-clean', async (c) => {
    if (config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      if (auth !== `Bearer ${config.adminToken}`) return c.json({ error: 'Unauthorized' }, 401);
    }
    const body = await c.req.json<{ enabled: boolean }>();
    await storage.put(KV_SITE_AUTO_CLEAN, body.enabled ? 'true' : 'false');
    await markOutputDirty();
    return c.json({ success: true, enabled: body.enabled });
  });

  app.get('/admin/site-health', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_SITE_HEALTH_MAP);
    const healthMap = raw ? JSON.parse(raw) : {};
    return c.json(healthMap);
  });

  // 频道级测速 admin 路由（仅 Node/Docker 启用）
  if (deps.enableChannelProbe) {
    mountChannelProbeRoutes(app, { storage, config });
  }

  // Builder 路由（仅 Node/Docker 启用，动态 import 避免 CF bundle 引入 fs/path）
  if (deps.enableBuilder) {
    import('./routes/builder').then(({ mountBuilderRoutes }) => {
      mountBuilderRoutes(app, { storage, config });
    });
  }

  // ─── 图片代理（供 reader 漫画阅读器使用）─────────────────
  app.get('/img-proxy', async (c) => {
    const url = c.req.query('url');
    if (!url) return c.text('missing url', 400);

    const referer = c.req.query('referer') || new URL(url).origin + '/';

    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': referer,
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });

      if (!resp.ok) return c.body(null, resp.status as 502);

      return new Response(resp.body, {
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return c.body(null, 502);
    }
  });

  // ─── Reader 通用代理（无 auth，供 reader 后端中转被封站点）──
  app.get('/reader-proxy', async (c) => {
    const url = c.req.query('url');
    if (!url) return c.text('missing url', 400);

    const referer = c.req.query('referer') || new URL(url).origin + '/';
    const cookie = c.req.query('cookie') || '';

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Referer': referer,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    };
    if (cookie) headers['Cookie'] = cookie;

    try {
      const resp = await fetch(url, { headers });

      return new Response(resp.body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'text/plain',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return c.body(null, 502);
    }
  });

  return app;
}

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${token}`;
}
