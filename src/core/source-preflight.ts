// 服务端源预检：尽量模拟 TVBox 客户端的配置读取 / 接口请求 / JAR 下载行为，
// 只把确实需要 Android/Java 执行的步骤留给客户端最终验证。
//
// 说明：这里不会执行 JAR，也不会记录 Cookie/token。预检结果只保存状态、
// 原因、耗时与响应摘要，供后台分级和前端管理页展示。

import type {
  CloudCredential,
  CloudPlatform,
  SiteContract,
  SourcePreflightResult,
  TVBoxSite,
} from './types';
import { TVBOX_UA } from './config';
import { parseSpiderString } from './jar-proxy';
import {
  canDistributeCredentialsToSite,
  injectAListDriveCredentials,
  injectCredentials,
} from './credential-injector';
import { decodeConfigResponse } from './decoder';

const DEFAULT_TIMEOUT_MS = 6500;
const DEFAULT_CONCURRENCY = 6;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_JAR_BYTES = 8 * 1024 * 1024;

// 400/405/415 通常表示该 API 需要 POST 参数，客户端也会换成 POST 再试。
const API_RETRY_STATUS = new Set([400, 405, 415]);

const OBJECT_URL_KEYS = new Set([
  'url', 'php', 'api', 'json', 'site', 'siteurl', 'apiurl', 'server',
  'host', 'baseurl', 'endpoint', 'proxy', 'tokenurl', 'token_json',
  'ext', 'config', 'source', 'list', 'data', 'vod', 'search',
]);

// JAR 结构特征：命中越多，越能确认这是 TVBox 的猫影视/影视仓扩展包。
const JAR_STRUCT_MARKERS = ['META-INF/MANIFEST.MF', 'classes.dex'];
const JAR_LIB_MARKERS = ['com/fongmi', 'okhttp', 'quark', 'alist', 'csp_', 'com/github/catvod'];

function nowIso(): string {
  return new Date().toISOString();
}

function result(
  status: SourcePreflightResult['status'],
  reason: string,
  message: string,
  extra: Partial<SourcePreflightResult> = {},
): SourcePreflightResult {
  return {
    status,
    reason,
    message,
    checkedAt: nowIso(),
    ...extra,
  };
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function sanitizeUrl(raw: string): string {
  return raw
    .replace(/([?&](?:token|secret|password|passwd|pwd|auth|code|sign|key)=)[^&\s]+/gi, '$1***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***@');
}

function hostOf(raw: string): string {
  try {
    const url = new URL(raw);
    return url.host;
  } catch {
    return sanitizeUrl(raw).slice(0, 80);
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function splitExtUrl(raw: string): { value: string; suffix: string } {
  const at = raw.indexOf('|');
  if (at < 0) return { value: raw, suffix: '' };
  return { value: raw.slice(0, at), suffix: raw.slice(at + 1) };
}

function parseExtObject(ext: unknown): Record<string, unknown> | null {
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    return ext as Record<string, unknown>;
  }
  if (typeof ext !== 'string' || !ext.trim()) return null;
  try {
    const parsed = JSON.parse(ext);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 非 JSON 的字符串配置由 URL 提取逻辑处理。
  }
  return null;
}

function decodeBase64Candidate(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length < 24 || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null;
  try {
    const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const text = new TextDecoder('utf-8').decode(bytes).trim();
    if (!text) return null;
    const printable = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').length;
    return printable / text.length > 0.85 ? text : null;
  } catch {
    return null;
  }
}

function extractUrls(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || value == null || out.length > 200) return out;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return out;
    if (isValidHttpUrl(text)) out.push(text);
    for (const match of text.matchAll(/https?:\/\/[^\s"',<>|]+/g)) {
      out.push(match[0].replace(/[),.;]+$/, ''));
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 60)) extractUrls(item, depth + 1, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (typeof item === 'string') {
        if (OBJECT_URL_KEYS.has(lower) || isValidHttpUrl(item)) extractUrls(item, depth + 1, out);
      } else if (item && typeof item === 'object') {
        extractUrls(item, depth + 1, out);
      }
    }
  }
  return out;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function readLimited(
  resp: Response,
  limit = MAX_BODY_BYTES,
): Promise<{ bytes: Uint8Array; text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (resp.body) {
    const reader = resp.body.getReader();
    try {
      while (total < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const remaining = limit - total;
        const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
        chunks.push(slice);
        total += slice.byteLength;
        if (slice.byteLength < value.byteLength) break;
      }
    } catch {
      // 读取中断时保留已经拿到的字节。
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
  } else {
    try {
      const raw = new Uint8Array(await resp.arrayBuffer());
      const slice = raw.byteLength > limit ? raw.slice(0, limit) : raw;
      chunks.push(slice);
      total += slice.byteLength;
    } catch {
      // 无响应体。
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, text: new TextDecoder('utf-8').decode(bytes), truncated: total >= limit };
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
  limit = MAX_BODY_BYTES,
  signal?: AbortSignal,
): Promise<{ resp: Response; body: string; bytes: Uint8Array; truncated: boolean } | null> {
  const controller = new AbortController();
  const externalSignal = signal ?? init.signal ?? undefined;
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': TVBOX_UA,
        Accept: 'application/json, text/plain, */*',
        ...(init.headers || {}),
      },
    });
    const { bytes, text, truncated } = await readLimited(resp, limit);
    return { resp, body: text, bytes, truncated };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

/**
 * 部分 API（csp_AppUn / csp_AppGet 之类）在缺少参数时返回 400/405，
 * 客户端会改用 POST。这里先 GET 再按需 POST，尽量贴近客户端行为。
 */
async function fetchApiWithFallback(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ resp: Response; body: string; bytes: Uint8Array; truncated: boolean; method: string } | null> {
  const first = await fetchWithTimeout(url, timeoutMs, {}, MAX_BODY_BYTES, signal);
  if (!first) return null;
  if (!API_RETRY_STATUS.has(first.resp.status)) return { ...first, method: 'GET' };

  const second = await fetchWithTimeout(url, timeoutMs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }, MAX_BODY_BYTES, signal);
  if (second && second.resp.ok) return { ...second, method: 'POST' };
  return { ...first, method: 'GET' };
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try { JSON.parse(trimmed); return true; } catch { return false; }
  }
  const decoded = decodeBase64Candidate(trimmed);
  if (!decoded) return false;
  try { JSON.parse(decoded); return true; } catch { return false; }
}

function looksLikeConfig(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (looksLikeJson(trimmed)) return true;
  return /<(?:rss|list|video|class|channel|tv)\b/i.test(trimmed) || /#EXTM3U/i.test(trimmed);
}

async function decodeResponse(bytes: Uint8Array, configKey?: string): Promise<string> {
  const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    const decoded = await decodeConfigResponse(raw, configKey);
    if (decoded) return decoded;
  } catch {
    // 解码失败时退回 UTF-8 文本，交给 looksLikeConfig 判断。
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function extractConfigKey(raw: string): string | undefined {
  const match = raw.match(/;pk;([^;|]+)/i);
  return match ? match[1].trim() : undefined;
}

function jarUrl(site: TVBoxSite): string | null {
  const raw = site.jar ? parseSpiderString(site.jar).url : '';
  return raw && isValidHttpUrl(raw) ? raw : null;
}

function jarMd5(site: TVBoxSite): string | null {
  if (!site.jar) return null;
  const parsed = parseSpiderString(site.jar);
  const md5 = parsed.md5?.split(';', 1)[0]?.trim().toLowerCase();
  return md5 && /^[0-9a-f]{32}$/.test(md5) ? md5 : null;
}

function isJarSite(site: TVBoxSite): boolean {
  return site.type === 3 && (/^csp_/i.test(site.api) || !!site.jar);
}

/**
 * 服务端可以真实请求的配置地址（按可信度排序）。
 * 覆盖 ext 为字符串、ext 为对象（drives/ext/site 等）以及 api 本身是 HTTP 的情况。
 */
function candidateConfigUrls(site: TVBoxSite): string[] {
  const out: string[] = [];
  if (typeof site.ext === 'string' && site.ext.trim()) {
    const direct = splitExtUrl(site.ext).value.trim();
    if (isValidHttpUrl(direct)) out.push(direct);
  }
  const extObj = parseExtObject(site.ext);
  if (extObj) {
    const urls = extractUrls(extObj, 0).filter(isValidHttpUrl);
    const preferred = urls.filter((url) => /\.(?:json|php|txt)(?:$|\?)|(?:api|config|vod|provide)/i.test(url));
    out.push(...preferred, ...urls);
  }
  if (typeof site.ext === 'string' && site.ext.trim()) {
    out.push(...extractUrls(site.ext, 0).filter(isValidHttpUrl));
  }
  if (isValidHttpUrl(site.api)) out.push(site.api);
  return unique(out).slice(0, 4);
}

// ─── 纯 JS MD5（CF Workers 的 crypto.subtle 不支持 MD5） ───────

function md5Hex(bytes: Uint8Array): string {
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476;
  const k = new Uint32Array(64);
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) k[i] = Math.floor(2 ** 32 * Math.abs(Math.sin(i + 1))) >>> 0;

  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 8 >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = new Uint32Array(16);
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(offset + j * 4, true);
    let a = h0, b = h1, c = h2, d = h3;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const temp = d;
      d = c; c = b;
      const x = (a + f + k[i] + w[g]) >>> 0;
      b = (b + ((x << s[i]) | (x >>> (32 - s[i])))) >>> 0;
      a = temp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
  }

  const hex = (n: number): string => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, n, true);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  return hex(h0) + hex(h1) + hex(h2) + hex(h3);
}

function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return out;
}

// ─── JAR 结构校验 ────────────────────────────────────────────

async function inspectJar(
  url: string,
  timeoutMs: number,
  expectedMd5: string | null,
  signal?: AbortSignal,
): Promise<SourcePreflightResult> {
  const startedAt = Date.now();
  const fetched = await fetchWithTimeout(url, timeoutMs, {}, MAX_JAR_BYTES + 1, signal);
  if (!fetched) {
    return result('failed', 'jar-fetch-failed', `JAR 下载失败或超时（${hostOf(url)}）`, {
      durationMs: elapsed(startedAt),
    });
  }
  const { resp, bytes, truncated } = fetched;
  if (!resp.ok) {
    return result('failed', 'jar-http-error', `JAR 返回 HTTP ${resp.status}（${hostOf(url)}）`, {
      httpStatus: resp.status,
      durationMs: elapsed(startedAt),
    });
  }
  if (bytes.byteLength === 0) {
    return result('failed', 'jar-empty', 'JAR 响应为空', {
      httpStatus: resp.status,
      durationMs: elapsed(startedAt),
    });
  }
  if (truncated || bytes.byteLength > MAX_JAR_BYTES) {
    return result('failed', 'jar-too-large', `JAR 体积超过 ${Math.round(MAX_JAR_BYTES / 1024 / 1024)}MB 上限`, {
      httpStatus: resp.status,
      contentLength: bytes.byteLength,
      durationMs: elapsed(startedAt),
    });
  }
  const isZip = bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip) {
    const kind = looksLikeJson(fetched.body) ? 'JSON' : '非 ZIP 数据';
    return result('client-jar-unverified', 'jar-not-zip', `已下载资源但不是标准 ZIP/JAR（${kind}），仍需客户端执行确认`, {
      httpStatus: resp.status,
      contentLength: bytes.byteLength,
      jarBytes: bytes.byteLength,
      durationMs: elapsed(startedAt),
    });
  }

  const text = bytesToLatin1(bytes);
  const structHits = JAR_STRUCT_MARKERS.filter((marker) => text.includes(marker));
  const libHits = JAR_LIB_MARKERS.filter((marker) => text.toLowerCase().includes(marker.toLowerCase()));
  const hasManifest = structHits.includes('META-INF/MANIFEST.MF');
  const hasDex = structHits.includes('classes.dex');
  const structurallyValid = hasManifest && (hasDex || libHits.length > 0);

  const actualMd5 = md5Hex(bytes);
  const md5Matches = expectedMd5 ? actualMd5 === expectedMd5 : null;
  if (md5Matches === false) {
    return result('failed', 'jar-md5-mismatch', `JAR MD5 与配置声明不一致（${actualMd5.slice(0, 8)}… ≠ ${expectedMd5!.slice(0, 8)}…）`, {
      httpStatus: resp.status,
      contentLength: bytes.byteLength,
      jarBytes: bytes.byteLength,
      durationMs: elapsed(startedAt),
    });
  }

  if (!structurallyValid) {
    return result('client-jar-unverified', 'jar-structure-weak', 'ZIP 已下载，但缺少 MANIFEST/classes.dex 等扩展特征，仍需客户端执行确认', {
      httpStatus: resp.status,
      contentLength: bytes.byteLength,
      jarBytes: bytes.byteLength,
      durationMs: elapsed(startedAt),
    });
  }

  const traits = [structHits[0], libHits[0]].filter(Boolean).join(' + ');
  const md5Note = md5Matches === true ? '，MD5 与配置一致' : '';
  return result('client-jar-verified', 'jar-verified', `JAR 已下载并通过结构校验（${traits}${md5Note}）；Java 执行仍由客户端完成`, {
    httpStatus: resp.status,
    contentLength: bytes.byteLength,
    jarBytes: bytes.byteLength,
    durationMs: elapsed(startedAt),
  });
}

// ─── 配置 / 接口预检 ─────────────────────────────────────────

async function preflightConfigTarget(
  target: string,
  configKey: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SourcePreflightResult | null> {
  const startedAt = Date.now();
  const fetched = await fetchApiWithFallback(target, timeoutMs, signal);
  if (!fetched) return null;
  const { resp, bytes, truncated } = fetched;
  const durationMs = elapsed(startedAt);
  const httpStatus = resp.status;
  const contentLength = bytes.byteLength;

  if (resp.ok) {
    const decoded = await decodeResponse(bytes, configKey);
    if (looksLikeConfig(decoded)) {
      return result('verified', 'config-verified', `配置已由服务端真实请求并解析（${hostOf(target)}，${fetched.method}）`, {
        httpStatus,
        contentLength,
        durationMs,
      });
    }
    const obj = parseExtObject(decoded);
    if (obj) {
      const nested = unique(extractUrls(obj, 0).filter(isValidHttpUrl)).filter((url) => url !== target);
      for (const next of nested.slice(0, 2)) {
        const second = await fetchApiWithFallback(next, timeoutMs, signal);
        if (!second || !second.resp.ok) continue;
        const nestedText = await decodeResponse(second.bytes, configKey);
        if (looksLikeConfig(nestedText)) {
          return result('verified', 'nested-config-verified', `嵌套配置已由服务端真实请求并解析（${hostOf(next)}）`, {
            httpStatus: second.resp.status,
            contentLength: second.bytes.byteLength,
            durationMs: elapsed(startedAt),
          });
        }
      }
    }
    return result('client-jar-unverified', 'config-response-needs-client', `配置请求成功但响应需要 TVBox/Java 客户端解释（HTTP ${httpStatus}）`, {
      httpStatus,
      contentLength,
      durationMs,
    });
  }

  if (httpStatus === 404 || httpStatus === 410) {
    return result('failed', 'config-http-error', `配置返回 HTTP ${httpStatus}（${hostOf(target)}）`, {
      httpStatus,
      durationMs,
    });
  }
  return result('client-jar-unverified', 'config-http-unconfirmed', `配置返回 HTTP ${httpStatus}，服务端无法确认（${hostOf(target)}）`, {
    httpStatus,
    contentLength,
    durationMs,
  });
}

async function preflightHttpConfig(
  site: TVBoxSite,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SourcePreflightResult | null> {
  const targets = candidateConfigUrls(site);
  const configKey = typeof site.ext === 'string' ? extractConfigKey(site.ext) : undefined;
  let last: SourcePreflightResult | null = null;
  for (const target of targets) {
    const attempt = await preflightConfigTarget(target, configKey, timeoutMs, signal);
    if (!attempt) {
      last = result('timeout', 'config-http-failed', `配置地址请求失败或超时（${hostOf(target)}）`);
      continue;
    }
    if (attempt.status === 'verified' || attempt.status === 'credential-ready') return attempt;
    last = attempt;
  }
  return last;
}

function credentialCookie(
  credentials: Map<CloudPlatform, CloudCredential>,
  platform: CloudPlatform,
): string {
  return credentials.get(platform)?.credential?.cookie?.trim() || '';
}

async function preflightCredentialConfig(
  site: TVBoxSite,
  credentials: Map<CloudPlatform, CloudCredential>,
  timeoutMs: number,
  signal?: AbortSignal,
  contract?: SiteContract,
  globalSpider?: string,
): Promise<SourcePreflightResult | null> {
  if (
    credentials.size === 0
    || !contract
    || !contract.credentialMechanism
    || contract.credentialMechanism === 'none'
    || contract.credentialMechanism === 'unknown'
  ) return null;

  if (!canDistributeCredentialsToSite(
    site,
    credentials,
    'https://credential.invalid',
    globalSpider,
    contract,
  )) return null;

  let injectedSite: TVBoxSite;
  try {
    const injected = injectCredentials(
      [site],
      credentials,
      { allowedHighRiskKeys: [], deniedKeys: [] },
      undefined,
      new Set([site.key]),
      new Map([[site.key, contract]]),
      true,
      true,
      globalSpider,
    );
    injectedSite = injected.sites[0];
    if (injected.report.injected !== 1 || !injectedSite) return null;
    if (JSON.stringify(injectedSite) === JSON.stringify(site)) return null;
  } catch {
    return null;
  }

  const cookie = credentialCookie(credentials, 'quark') || credentialCookie(credentials, 'uc')
    || credentialCookie(credentials, 'baidu') || credentialCookie(credentials, 'bilibili');
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;

  const targets = candidateConfigUrls(injectedSite);
  const originalTargets = new Set(candidateConfigUrls(site));
  const preferred = targets.filter((url) => !originalTargets.has(url) || url === targets[0]);
  for (const target of (preferred.length > 0 ? preferred : targets).slice(0, 3)) {
    const startedAt = Date.now();
    const fetched = await fetchWithTimeout(target, timeoutMs, { headers }, MAX_BODY_BYTES, signal);
    if (!fetched) continue;
    const durationMs = elapsed(startedAt);
    if (!fetched.resp.ok) {
      if (fetched.resp.status === 401 || fetched.resp.status === 403) {
        return result('credential-invalid', 'credential-http-error', `凭证注入后返回 HTTP ${fetched.resp.status}（${hostOf(target)}）`, {
          httpStatus: fetched.resp.status,
          durationMs,
        });
      }
      continue;
    }
    const decoded = await decodeResponse(fetched.bytes);
    if (!looksLikeConfig(decoded)) continue;
    return result('credential-ready', 'credential-config-verified', `凭证已注入且配置可读取（${hostOf(target)}）；播放地址仍由客户端最终验证`, {
      httpStatus: fetched.resp.status,
      contentLength: fetched.bytes.byteLength,
      durationMs,
    });
  }
  return null;
}

// ─── AList 预检 ──────────────────────────────────────────────

async function preflightAList(
  site: TVBoxSite,
  credentials: Map<CloudPlatform, CloudCredential>,
  timeoutMs: number,
  signal?: AbortSignal,
  contract?: SiteContract,
  globalSpider?: string,
): Promise<SourcePreflightResult> {
  const startedAt = Date.now();
  if (!contract || contract.credentialMechanism !== 'alist') {
    return result('client-jar-unverified', 'alist-contract-missing', '未找到该 AList 源实例的可信凭证契约，服务端不注入', {
      durationMs: elapsed(startedAt),
    });
  }
  if (!canDistributeCredentialsToSite(
    site,
    credentials,
    'https://credential.invalid',
    globalSpider,
    contract,
  )) {
    return result('client-jar-unverified', 'alist-credential-disallowed', '当前凭证不满足该 AList 源实例的契约，服务端不注入', {
      durationMs: elapsed(startedAt),
    });
  }
  const allowedPlatforms = new Set(contract.credentialPlatforms || []);
  const allowedCredentials = new Map(
    [...credentials].filter(([platform]) => allowedPlatforms.has(platform)),
  );
  const extObj = parseExtObject(site.ext);
  let injected = false;
  let candidateExt: unknown = site.ext;
  if (extObj && Array.isArray(extObj.drives) && allowedCredentials.size > 0) {
    try {
      const res = injectAListDriveCredentials(extObj.drives, allowedCredentials);
      if (res.changed) {
        injected = true;
        candidateExt = { ...extObj, drives: res.drives };
      }
    } catch {
      // 注入失败时继续用原始配置探测。
    }
  }

  const urls = unique(extractUrls(candidateExt, 0).filter(isValidHttpUrl));
  const apiUrl = urls.find((url) => /\/api\/fs\/(?:list|get|search|dir)/i.test(url));
  const base = apiUrl || urls.find((url) => !/\.(?:png|jpe?g|webp|gif)(?:$|\?)/i.test(url));
  if (!base) {
    return result('client-jar-unverified', 'alist-url-missing', '未从配置中解析到 AList API 地址', {
      durationMs: elapsed(startedAt),
    });
  }
  const endpoint = /\/api\/fs\/(?:list|get|search|dir)/i.test(base)
    ? base
    : base.replace(/\/+$/, '') + '/api/fs/list';

  const body = JSON.stringify({ path: '/', password: '', page: 1, per_page: 0, refresh: false });
  const fetched = await fetchWithTimeout(endpoint, timeoutMs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, MAX_BODY_BYTES, signal);
  if (!fetched) {
    return result('failed', 'alist-http-failed', `AList 接口请求失败或超时（${hostOf(endpoint)}）`, {
      durationMs: elapsed(startedAt),
    });
  }
  const durationMs = elapsed(startedAt);
  if (!fetched.resp.ok) {
    return result('failed', 'alist-http-error', `AList 返回 HTTP ${fetched.resp.status}（${hostOf(endpoint)}）`, {
      httpStatus: fetched.resp.status,
      durationMs,
    });
  }

  let parsed: any = null;
  try { parsed = JSON.parse(fetched.body); } catch { parsed = null; }
  const ok = parsed && (parsed.code === 200 || Array.isArray(parsed.data?.content) || Array.isArray(parsed.content));
  if (!ok) {
    return result('client-jar-unverified', 'alist-response-unconfirmed', `AList 返回非预期结构（${hostOf(endpoint)}），仍需客户端确认`, {
      httpStatus: fetched.resp.status,
      contentLength: fetched.bytes.byteLength,
      durationMs,
    });
  }

  const entries = Array.isArray(parsed.data?.content) ? parsed.data.content.length
    : Array.isArray(parsed.content) ? parsed.content.length : 0;
  const credentialNote = injected ? '，网盘凭证已注入' : '';
  return result('alist-verified', 'alist-api-verified', `AList 接口已在服务端验证（${hostOf(endpoint)}，返回 ${entries} 项${credentialNote}）`, {
    httpStatus: fetched.resp.status,
    contentLength: fetched.bytes.byteLength,
    durationMs,
  });
}

// ─── 对外接口 ────────────────────────────────────────────────

export interface PreflightOptions {
  timeoutMs?: number;
  concurrency?: number;
  budgetMs?: number;
  signal?: AbortSignal;
  baseUrl?: string;
  contractsBySiteKey?: Map<string, SiteContract>;
  globalSpider?: string;
}

/**
 * 单个源的服务端预检。只做网络 / 配置 / JAR 结构校验，不执行客户端 Java 代码。
 */
export async function preflightSource(
  site: TVBoxSite,
  credentials: Map<CloudPlatform, CloudCredential>,
  options: PreflightOptions = {},
): Promise<SourcePreflightResult> {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal;
  const startedAt = Date.now();
  const contract = options.contractsBySiteKey?.get(site.key);

  if (signal?.aborted) {
    return result('timeout', 'preflight-budget-exhausted', '服务端预检超出本轮时间预算，下一轮继续', {
      durationMs: elapsed(startedAt),
    });
  }

  if (contract?.credentialMechanism === 'alist') {
    return preflightAList(site, credentials, timeoutMs, signal, contract, options.globalSpider);
  }

  // 1) 凭证注入后的配置请求（优先级最高：证明“凭证 + 源”真的可用）。
  const credentialResult = await preflightCredentialConfig(
    site,
    credentials,
    timeoutMs,
    signal,
    contract,
    options.globalSpider,
  );
  if (credentialResult && credentialResult.status === 'credential-ready') return credentialResult;
  if (signal?.aborted) {
    return result('timeout', 'preflight-budget-exhausted', '服务端预检超出本轮时间预算，下一轮继续', {
      durationMs: elapsed(startedAt),
    });
  }

  // 2) 原始配置 / 接口请求，尽量复刻客户端启动时的读取行为。
  const configResult = await preflightHttpConfig(site, timeoutMs, signal);
  if (configResult && configResult.status === 'verified') {
    return {
      ...configResult,
      durationMs: configResult.durationMs ?? elapsed(startedAt),
    };
  }
  if (signal?.aborted) {
    return result('timeout', 'preflight-budget-exhausted', '服务端预检超出本轮时间预算，下一轮继续', {
      durationMs: elapsed(startedAt),
    });
  }

  // 3) 仅在配置未验证时才下载 JAR 做结构校验，避免为已确认源浪费流量。
  const jar = jarUrl(site);
  const jarResult = jar ? await inspectJar(jar, timeoutMs, jarMd5(site), signal) : null;

  if (credentialResult) return credentialResult;
  if (configResult && (configResult.status === 'client-jar-unverified' || configResult.status === 'timeout')) {
    if (jarResult && jarResult.status !== 'failed') {
      return {
        ...jarResult,
        message: configResult.status === 'timeout'
          ? `${jarResult.message}（配置接口不可达，已回退到 JAR 校验）`
          : jarResult.message,
        durationMs: elapsed(startedAt),
      };
    }
  }
  if (jarResult) return { ...jarResult, durationMs: jarResult.durationMs ?? elapsed(startedAt) };
  if (configResult) return configResult;

  if (isJarSite(site)) {
    return result('client-jar-unverified', 'no-http-endpoint', '未解析到可请求的配置端点，且无可用 JAR 地址，需客户端执行确认', {
      durationMs: elapsed(startedAt),
    });
  }
  return result('client-jar-unverified', 'no-http-endpoint', '配置中没有可由服务端请求的 HTTP 端点', {
    durationMs: elapsed(startedAt),
  });
}

/**
 * 批量预检。并发受控，不抛异常；单个源失败不会影响其他源。
 * budgetMs 是整批硬预算：到期后会中止在途请求并停止启动新源。
 */
export async function preflightSourcesBatch(
  sites: TVBoxSite[],
  credentials: Map<CloudPlatform, CloudCredential>,
  options: PreflightOptions = {},
): Promise<Map<string, SourcePreflightResult>> {
  const out = new Map<string, SourcePreflightResult>();
  const queue = [...sites];
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? DEFAULT_CONCURRENCY));
  const budgetMs = Math.max(0, options.budgetMs ?? 0);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = budgetMs > 0 ? setTimeout(() => controller.abort(), budgetMs) : undefined;
  const deadlineAt = budgetMs > 0 ? Date.now() + budgetMs : Number.POSITIVE_INFINITY;

  async function worker(): Promise<void> {
    for (;;) {
      if (controller.signal.aborted) return;
      const site = queue.shift();
      if (!site) return;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        controller.abort();
        return;
      }
      const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, remainingMs));
      try {
        const value = await preflightSource(site, credentials, {
          ...options,
          timeoutMs,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) out.set(site.key, value);
      } catch {
        if (!controller.signal.aborted) {
          out.set(site.key, result('failed', 'preflight-crashed', '服务端预检异常'));
        }
      }
    }
  }

  try {
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, () => worker());
    await Promise.all(workers);
    return out;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}