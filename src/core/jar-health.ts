// 远程 JAR/扩展的服务端元数据预检。
//
// 这里能确认的是“入口是否可达、下载速度、响应体积、ZIP/JAR 结构和声明的
// MD5 是否正确”。JAR 内部的业务逻辑仍由客户端执行，因此预检失败只做软降级，
// 不能把它直接当作客户端不可用。
import type { Storage } from '../storage/interface';
import type { TVBoxSite, SearchQualityEntry } from './types';
import { parseSpiderString, getJarKeyForSite, loadJarReadyKeys } from './jar-proxy';

export interface JarProbeResult {
  key: string;
  siteKey: string;
  result: 'ok' | 'error' | 'timeout' | 'not_probed';
  speedMs: number | null;
  httpStatus?: number;
  bytes?: number;
  md5Verified?: boolean;
  zipValid?: boolean;
  cached?: boolean;
  message?: string;
  probedAt?: string;
}

const JAR_PROBE_TIMEOUT_MS = 8000;
const JAR_PROBE_MAX_BYTES = 8 * 1024 * 1024;
const JAR_PROBE_CONCURRENCY = 3;
const JAR_PROBE_CACHE_MS = 6 * 60 * 60 * 1000;

function siteJarString(site: TVBoxSite, globalSpider?: string): string | null {
  const own = typeof site.jar === 'string' ? site.jar.trim() : '';
  const ext = typeof site.ext === 'string' ? site.ext.trim() : '';
  const raw = own || ext || globalSpider?.trim() || '';
  if (!raw) return null;
  const parsed = parseSpiderString(raw);
  if (!/^https?:\/\//i.test(parsed.url)) return null;
  return raw;
}

function hasRemoteJar(site: TVBoxSite, globalSpider?: string): boolean {
  if (site.type !== 3) return false;
  return !!siteJarString(site, globalSpider);
}

// 轻量 MD5。Web Crypto 不提供 MD5，CF/Node 都无法直接调用原生实现。
function md5Hex(input: Uint8Array): string {
  const add32 = (a: number, b: number) => (a + b) & 0xffffffff;
  const ff = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => add32(b, ((a + ((b & c) | (~b & d)) + x + t) << s | (a + ((b & c) | (~b & d)) + x + t) >>> (32 - s)));
  const gg = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => add32(b, (((a + ((b & d) | (c & ~d)) + x + t) << s) | ((a + ((b & d) | (c & ~d)) + x + t) >>> (32 - s))));
  const hh = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => add32(b, (((a + (b ^ c ^ d) + x + t) << s) | ((a + (b ^ c ^ d) + x + t) >>> (32 - s))));
  const ii = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => add32(b, (((a + (c ^ (b | ~d)) + x + t) << s) | ((a + (c ^ (b | ~d)) + x + t) >>> (32 - s))));
  const bytes = input;
  const len = bytes.length;
  const withPadding = new Uint8Array((((len + 8) >>> 6) + 1) * 64);
  withPadding.set(bytes);
  withPadding[len] = 0x80;
  const bitLen = len * 8;
  const dataView = new DataView(withPadding.buffer);
  dataView.setUint32(withPadding.length - 8, bitLen >>> 0, true);
  dataView.setUint32(withPadding.length - 4, Math.floor(bitLen / 0x100000000), true);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const x = new Uint32Array(16);
  for (let i = 0; i < withPadding.length; i += 64) {
    for (let j = 0; j < 16; j++) x[j] = dataView.getUint32(i + j * 4, true);
    const [aa, bb, cc, dd] = [a, b, c, d];
    a = ff(a,b,c,d,x[0],7,-680876936); d = ff(d,a,b,c,x[1],12,-389564586); c = ff(c,d,a,b,x[2],17,606105819); b = ff(b,c,d,a,x[3],22,-1044525330);
    a = ff(a,b,c,d,x[4],7,-176418897); d = ff(d,a,b,c,x[5],12,1200080426); c = ff(c,d,a,b,x[6],17,-1473231341); b = ff(b,c,d,a,x[7],22,-45705983);
    a = ff(a,b,c,d,x[8],7,1770035416); d = ff(d,a,b,c,x[9],12,-1958414417); c = ff(c,d,a,b,x[10],17,-42063); b = ff(b,c,d,a,x[11],22,-1990404162);
    a = ff(a,b,c,d,x[12],7,1804603682); d = ff(d,a,b,c,x[13],12,-40341101); c = ff(c,d,a,b,x[14],17,-1502002290); b = ff(b,c,d,a,x[15],22,1236535329);
    a = gg(a,b,c,d,x[1],5,-165796510); d = gg(d,a,b,c,x[6],9,-1069501632); c = gg(c,d,a,b,x[11],14,643717713); b = gg(b,c,d,a,x[0],20,-373897302);
    a = gg(a,b,c,d,x[5],5,-701558691); d = gg(d,a,b,c,x[10],9,38016083); c = gg(c,d,a,b,x[15],14,-660478335); b = gg(b,c,d,a,x[4],20,-405537848);
    a = gg(a,b,c,d,x[9],5,568446438); d = gg(d,a,b,c,x[14],9,-1019803690); c = gg(c,d,a,b,x[3],14,-187363961); b = gg(b,c,d,a,x[8],20,1163531501);
    a = gg(a,b,c,d,x[13],5,-1444681467); d = gg(d,a,b,c,x[2],9,-51403784); c = gg(c,d,a,b,x[7],14,1735328473); b = gg(b,c,d,a,x[12],20,-1926607734);
    a = hh(a,b,c,d,x[5],4,-378558); d = hh(d,a,b,c,x[8],11,-2022574463); c = hh(c,d,a,b,x[11],16,1839030562); b = hh(b,c,d,a,x[14],23,-35309556);
    a = hh(a,b,c,d,x[1],4,-1530992060); d = hh(d,a,b,c,x[4],11,1272893353); c = hh(c,d,a,b,x[7],16,-155497632); b = hh(b,c,d,a,x[10],23,-1094730640);
    a = hh(a,b,c,d,x[13],4,681279174); d = hh(d,a,b,c,x[0],11,-358537222); c = hh(c,d,a,b,x[3],16,-722521979); b = hh(b,c,d,a,x[6],23,76029189);
    a = hh(a,b,c,d,x[9],4,-640364487); d = hh(d,a,b,c,x[12],11,-421815835); c = hh(c,d,a,b,x[15],16,530742520); b = hh(b,c,d,a,x[2],23,-995338651);
    a = ii(a,b,c,d,x[0],6,-198630844); d = ii(d,a,b,c,x[7],10,1126891415); c = ii(c,d,a,b,x[14],15,-1416354905); b = ii(b,c,d,a,x[5],21,-574340890);
    a = ii(a,b,c,d,x[12],6,-1700485571); d = ii(d,a,b,c,x[3],10,-1894986606); c = ii(c,d,a,b,x[10],15,-1051523); b = ii(b,c,d,a,x[1],21,-2054922799);
    a = ii(a,b,c,d,x[8],6,1873313359); d = ii(d,a,b,c,x[15],10,-30611744); c = ii(c,d,a,b,x[6],15,-1560198380); b = ii(b,c,d,a,x[13],21,1309151649);
    a = ii(a,b,c,d,x[4],6,-145523070); d = ii(d,a,b,c,x[11],10,-1120210379); c = ii(c,d,a,b,x[2],15,718787259); b = ii(b,c,d,a,x[9],21,-343485551);
    a = add32(a, aa); b = add32(b, bb); c = add32(c, cc); d = add32(d, dd);
  }
  const out = [a,b,c,d].flatMap(v => { const r=[]; for(let i=0;i<4;i++) r.push((v >>> (i*8)) & 0xff); return r; });
  return out.map(v => v.toString(16).padStart(2,'0')).join('');
}

function isValidZip(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  // 允许标准 JAR（PK\x03\x04）和空 JAR（PK\x05\x06）两种头。
  const sig = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  if (sig !== 0x04034b50 && sig !== 0x06054b50) return false;
  if (bytes.length >= 4) {
    const end = bytes.length;
    // 有中央目录结束标记，且能取到中央目录偏移/大小。
    for (let i = Math.max(0, end - 65557); i + 22 <= end; i++) {
      if (bytes[i] === 0x50 && bytes[i+1] === 0x4b && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const cdSize = view.getUint32(i + 12, true);
        const cdOffset = view.getUint32(i + 16, true);
        return cdOffset + cdSize <= bytes.length + 22;
      }
    }
  }
  return false;
}

async function fetchJarProbe(url: string, timeoutMs = JAR_PROBE_TIMEOUT_MS): Promise<{ result: 'ok'|'error'|'timeout'; speedMs: number|null; status?: number; bytes?: Uint8Array; message?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'okhttp/3.12.0' }, signal: controller.signal, redirect: 'follow' });
    const status = resp.status;
    if (!resp.ok) return { result: 'error', speedMs: null, status, message: 'HTTP ' + status };
    const contentLength = Number(resp.headers.get('content-length') || 0);
    if (contentLength > JAR_PROBE_MAX_BYTES) return { result: 'error', speedMs: null, status, message: 'size-limit' };
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength <= 0 || bytes.byteLength > JAR_PROBE_MAX_BYTES) return { result: 'error', speedMs: null, status, message: 'size-invalid' };
    return { result: 'ok', speedMs: Date.now() - started, status, bytes };
  } catch (error: unknown) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { result: aborted ? 'timeout' : 'error', speedMs: null, message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function previousJarProbe(entry: SearchQualityEntry | undefined): JarProbeResult | null {
  if (!entry || !entry.jarProbeResult) return null;
  return { key: entry.key, siteKey: entry.key, result: entry.jarProbeResult, speedMs: entry.jarSpeedMs ?? null, httpStatus: entry.jarHttpStatus, bytes: entry.jarBytes, md5Verified: entry.jarMd5Verified, zipValid: entry.jarZipValid, cached: entry.jarCached };
}

export function isRemoteJarSite(site: TVBoxSite, globalSpider?: string): boolean {
  return hasRemoteJar(site, globalSpider);
}

/**
 * 批量预检远程 JAR。返回以站点 key 为索引的结果。
 * - 已 ready 或近期成功结果直接复用；
 * - 失败/超时记录为软降级，不把站点直接删除；
 * - 每个 JAR 最多下载 8MB，并发 3。
 */
export async function probeJarHealth(
  storage: Storage,
  sites: TVBoxSite[],
  previousEntries: Map<string, SearchQualityEntry> = new Map(),
  globalSpider?: string,
): Promise<Map<string, JarProbeResult>> {
  const resultMap = new Map<string, JarProbeResult>();
  let readyKeys = new Set<string>();
  try { readyKeys = await loadJarReadyKeys(storage); } catch {}
  const tasks: Array<{ site: TVBoxSite; url: string; key: string | null; raw: string; cached: boolean }> = [];
  for (const site of sites) {
    if (!hasRemoteJar(site, globalSpider)) continue;
    const raw = siteJarString(site, globalSpider);
    if (!raw) continue;
    const parsed = parseSpiderString(raw);
    const key = getJarKeyForSite(site, globalSpider) || parsed.md5 || null;
    const cached = !!key && readyKeys.has(key);
    const previous = previousJarProbe(previousEntries.get(site.key));
    if (previous && cached) {
      resultMap.set(site.key, { ...previous, cached: true });
      continue;
    }
    if (previous && previous.probedAt && previous.result === 'ok' && Date.now() - Date.parse(previous.probedAt) < JAR_PROBE_CACHE_MS) {
      resultMap.set(site.key, { ...previous, cached });
      continue;
    }
    tasks.push({ site, url: parsed.url, key, raw, cached });
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(JAR_PROBE_CONCURRENCY, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      const probe = await fetchJarProbe(task.url);
      const parsed = parseSpiderString(task.raw);
      const md5Ok = parsed.md5 && probe.bytes ? md5Hex(probe.bytes).toLowerCase() === parsed.md5.trim().toLowerCase() : undefined;
      const zipValid = probe.bytes ? isValidZip(probe.bytes) : undefined;
      const result: JarProbeResult = {
        key: task.key || task.site.key,
        siteKey: task.site.key,
        result: probe.result,
        speedMs: probe.speedMs,
        httpStatus: probe.status,
        bytes: probe.bytes?.byteLength,
        md5Verified: md5Ok,
        zipValid,
        cached: task.cached,
        message: probe.message,
        probedAt: new Date().toISOString(),
      };
      // MD5 是权威声明；明确不匹配时提高降级程度，但仍保留给客户端作最后判断。
      if (result.result === 'ok' && md5Ok === false) result.result = 'error';
      resultMap.set(task.site.key, result);
    }
  });
  await Promise.all(workers);
  return resultMap;
}

export function applyJarProbeToEntry(entry: SearchQualityEntry, probe: JarProbeResult | undefined): SearchQualityEntry {
  if (!probe) return entry;
  return {
    ...entry,
    jarProbeResult: probe.result,
    jarSpeedMs: probe.speedMs,
    jarHttpStatus: probe.httpStatus,
    jarBytes: probe.bytes,
    jarMd5Verified: probe.md5Verified,
    jarZipValid: probe.zipValid,
    jarCached: probe.cached,
  };
}

export { md5Hex, isValidZip };
