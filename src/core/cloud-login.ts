// 网盘扫码登录 / 密码登录

import type { CloudPlatform } from './types';

export type QRStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';

export interface QRResult {
  qrUrl: string;    // 需要编码为二维码的内容（URL 或 token）
  token: string;    // 轮询用的会话 token
}

export interface PollResult {
  status: QRStatus;
  credential?: Record<string, string>;
  message?: string;
}

export interface PasswordLoginResult {
  success: boolean;
  credential?: Record<string, string>;
  message?: string;
}

interface PlatformLoginHandler {
  generateQR?: () => Promise<QRResult>;
  pollStatus?: (token: string) => Promise<PollResult>;
  passwordLogin?: (username: string, password: string) => Promise<PasswordLoginResult>;
}

// ─── 网络请求安全辅助函数 ────────────────────────────────────

async function safeFetchJson(url: string, init?: RequestInit, platformName: string = '网盘'): Promise<any> {
  try {
    const resp = await fetch(url, init);
    if (resp.status === 403) {
      throw new Error(`服务器返回 403 错误 (IP可能被 ${platformName} 屏蔽，请在下方直接使用【手动粘贴凭证】配置 Cookie 登录)`);
    }
    if (!resp.ok) {
      throw new Error(`HTTP 错误 ${resp.status}`);
    }
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await resp.text();
      if (text.includes('cloudflare') || text.includes('challenge') || text.includes('captcha') || text.includes('Verify')) {
        throw new Error(`触发了人机验证或 Cloudflare 防御，请在下方直接使用【手动粘贴凭证】配置 Cookie 登录 ${platformName}`);
      }
      // 容错：有些网盘（如 115）虽然返回的是 text/html 或 text/plain，但内容实际上是合法的 JSON 字符串
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`服务器未返回 JSON 格式数据，可能是 IP 被限制，请使用下方【手动粘贴凭证】登录 ${platformName}`);
      }
    }
    return await resp.json();
  } catch (err: any) {
    if (err instanceof Error && err.message.includes('手动粘贴凭证')) {
      throw err;
    }
    throw new Error(`获取二维码失败: ${err instanceof Error ? err.message : String(err)}。由于部署在 Cloudflare Worker 上的外网 IP 极易被国内接口防火墙拦截，建议直接在下方使用【手动粘贴凭证】。`);
  }
}

// ─── Bilibili TV 端二维码 ────────────────────────────────

const BILI_APPKEY = '4409e2ce8ffd12b8';
const BILI_APPSEC = '59b43e04ad6965f34319062b478f83dd';

async function biliSign(params: Record<string, string>): Promise<string> {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const raw = sorted + BILI_APPSEC;
  const hash = await md5(raw);
  return sorted + '&sign=' + hash;
}

async function md5(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('MD5', data).catch(() => null);
  if (hash) {
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // CF Workers 不支持 MD5，用纯 JS 实现
  return md5Pure(text);
}

// 纯 JS MD5（CF Workers 的 crypto.subtle 不支持 MD5）
function md5Pure(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476;
  const k = new Uint32Array(64);
  const s = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
             5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
             4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
             6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
  for (let i = 0; i < 64; i++) k[i] = Math.floor(2**32 * Math.abs(Math.sin(i + 1))) >>> 0;

  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 8 >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 8, bitLen, true);

  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = new Uint32Array(16);
    for (let j = 0; j < 16; j++) w[j] = new DataView(padded.buffer).getUint32(offset + j * 4, true);
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

  const hex = (n: number) => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, n, true);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  };
  return hex(h0) + hex(h1) + hex(h2) + hex(h3);
}

const bilibiliHandler: PlatformLoginHandler = {
  async generateQR() {
    const ts = Math.floor(Date.now() / 1000).toString();
    const params: Record<string, string> = { appkey: BILI_APPKEY, local_id: '0', ts };
    const body = await biliSign(params);

    const data = await safeFetchJson('https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, 'Bilibili');

    if (data.code !== 0) throw new Error(data.message || 'Bilibili QR generate failed');

    return {
      qrUrl: data.data.url,
      token: data.data.auth_code,
    };
  },

  async pollStatus(token: string) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const params: Record<string, string> = { appkey: BILI_APPKEY, auth_code: token, local_id: '0', ts };
    const body = await biliSign(params);

    const data = await safeFetchJson('https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, 'Bilibili');

    if (data.code === 0) {
      // 登录成功，提取 cookie
      const cookies = data.data?.cookie_info?.cookies || [];
      const cookieParts: string[] = [];
      for (const c of cookies) {
        cookieParts.push(`${c.name}=${c.value}`);
      }
      return {
        status: 'confirmed' as QRStatus,
        credential: { cookie: cookieParts.join('; ') },
      };
    }

    if (data.code === 86090) return { status: 'scanned' as QRStatus };
    if (data.code === 86038) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 阿里云盘（Web QR 登录）─────────────────────────────

const aliyunHandler: PlatformLoginHandler = {
  async generateQR() {
    const data = await safeFetchJson('https://passport.aliyundrive.com/newlogin/qrcode/generate.do?appName=aliyun_drive&fromSite=52&appEntrance=web&_bx-v=2.5.6', {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, '阿里云盘');
    const content = data?.content?.data;

    if (!content?.codeContent) throw new Error('Aliyun QR generate failed');

    return {
      qrUrl: content.codeContent,
      token: JSON.stringify({ t: content.t, ck: content.ck || '' }),
    };
  },

  async pollStatus(token: string) {
    const { t, ck } = JSON.parse(token);
    const body = new URLSearchParams({
      t: String(t),
      ck: ck || '',
      appName: 'aliyun_drive',
      appEntrance: 'web',
      fromSite: '52',
      '_bx-v': '2.5.6',
    });

    const data = await safeFetchJson('https://passport.aliyundrive.com/newlogin/qrcode/query.do', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, '阿里云盘');
    const content = data?.content?.data;

    if (!content) return { status: 'error' as QRStatus, message: 'Invalid response' };

    const qrStatus = content.qrCodeStatus;
    if (qrStatus === 'CONFIRMED') {
      // bizExt 是 base64 编码的 JSON
      try {
        const bizJson = JSON.parse(atob(content.bizExt));
        const loginResult = bizJson.pds_login_result;
        return {
          status: 'confirmed' as QRStatus,
          credential: {
            refresh_token: loginResult?.refreshToken || '',
            access_token: loginResult?.accessToken || '',
          },
        };
      } catch {
        return { status: 'error' as QRStatus, message: 'Failed to parse login result' };
      }
    }

    if (qrStatus === 'SCANED') return { status: 'scanned' as QRStatus };
    if (qrStatus === 'EXPIRED') return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 夸克网盘 ────────────────────────────────────────────

const QUARK_CLIENT_ID = '386';
const QUARK_QR_BIZ_STR = 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0';
const QUARK_CONFIRM_PAGE_URL = 'https://su.quark.cn/4_eMHBJ?uc_param_str=';

const quarkHandler: PlatformLoginHandler = {
  async generateQR() {
    const body = new URLSearchParams({
      client_id: QUARK_CLIENT_ID,
      v: '1.2',
      request_id: String(Date.now()),
    });
    const data = await safeFetchJson('https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: body.toString(),
    }, '夸克网盘');

    // 夸克新型接口成功状态码返回 2000000，这里需要进行兼容
    if (data.status !== 200 && data.status !== 2000000 || !data.data?.members?.token) {
      throw new Error(data.message || 'Quark QR generate failed');
    }

    const token = data.data.members.token;
    const qrParams = new URLSearchParams({
      token,
      client_id: QUARK_CLIENT_ID,
      uc_biz_str: QUARK_QR_BIZ_STR,
    });
    return {
      qrUrl: `${QUARK_CONFIRM_PAGE_URL}&${qrParams.toString()}`,
      token: JSON.stringify({ token, clientId: QUARK_CLIENT_ID }),
    };
  },

  async pollStatus(tokenStr: string) {
    let token = tokenStr;
    let clientId = QUARK_CLIENT_ID;
    try {
      const parsed = JSON.parse(tokenStr);
      if (parsed && typeof parsed === 'object') {
        token = parsed.token || tokenStr;
        clientId = String(parsed.clientId || parsed.client_id || QUARK_CLIENT_ID);
      }
    } catch {}

    const body = new URLSearchParams({
      client_id: clientId,
      v: '1.2',
      request_id: String(Date.now()),
      token,
    });
    const data = await safeFetchJson('https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: body.toString(),
    }, '夸克网盘');

    const bodyStatus = data.status;
    const status = data.data?.members?.status;
    if (bodyStatus === 2000000 || status === 'CONFIRMED') {
      const serviceTicket = data.data?.members?.service_ticket;
      if (!serviceTicket) return { status: 'error' as QRStatus, message: 'No service ticket' };

      // 用 service ticket 换 cookie
      try {
        const loginResp = await fetch(`https://pan.quark.cn/account/info?st=${serviceTicket}&lw=scan`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          redirect: 'manual',
        });
        const setCookies = (loginResp.headers as any).getSetCookie?.() || [];
        const cookieParts: string[] = [];
        for (const sc of setCookies) {
          const part = sc.split(';')[0];
          if (part) cookieParts.push(part);
        }
        if (cookieParts.length > 0) {
          return { status: 'confirmed' as QRStatus, credential: { cookie: cookieParts.join('; ') } };
        }
        // 如果拿不到 set-cookie，尝试从响应中提取
        return { status: 'confirmed' as QRStatus, credential: { cookie: `__st=${serviceTicket}` } };
      } catch (err) {
        return { status: 'error' as QRStatus, message: `Cookie exchange failed: ${err}` };
      }
    }

    if (status === 'SCANED' || status === 'SCANNED') return { status: 'scanned' as QRStatus };
    if (status === 'EXPIRED' || bodyStatus === 50004002) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── UC 网盘（与夸克类似，同属 UCWeb）────────────────────

const UC_CLIENT_ID = '381';
const UC_QR_BIZ_STR = 'S:custom|C:titlebar_fix';
const UC_CONFIRM_PAGE_URL = 'https://su.uc.cn/1_n0ZCv?uc_param_str=dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt';

const ucHandler: PlatformLoginHandler = {
  async generateQR() {
    const body = new URLSearchParams({
      client_id: UC_CLIENT_ID,
      v: '1.2',
      request_id: String(Date.now()),
    });
    const data = await safeFetchJson('https://api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: body.toString(),
    }, 'UC 网盘');

    // UC新型接口成功状态码返回 2000000，这里需要进行兼容
    if (data.status !== 200 && data.status !== 2000000 || !data.data?.members?.token) {
      throw new Error(data.message || 'UC QR generate failed');
    }

    const token = data.data.members.token;
    const qrParams = new URLSearchParams({
      token,
      client_id: UC_CLIENT_ID,
      uc_biz_str: UC_QR_BIZ_STR,
    });
    return {
      qrUrl: `${UC_CONFIRM_PAGE_URL}&${qrParams.toString()}`,
      token: JSON.stringify({ token, clientId: UC_CLIENT_ID }),
    };
  },

  async pollStatus(tokenStr: string) {
    let token = tokenStr;
    let clientId = UC_CLIENT_ID;
    try {
      const parsed = JSON.parse(tokenStr);
      if (parsed && typeof parsed === 'object') {
        token = parsed.token || tokenStr;
        clientId = String(parsed.clientId || parsed.client_id || UC_CLIENT_ID);
      }
    } catch {}

    const body = new URLSearchParams({
      client_id: clientId,
      v: '1.2',
      request_id: String(Date.now()),
      token,
    });
    const data = await safeFetchJson('https://api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: body.toString(),
    }, 'UC 网盘');

    const bodyStatus = data.status;
    const status = data.data?.members?.status;
    if (bodyStatus === 2000000 || status === 'CONFIRMED') {
      const serviceTicket = data.data?.members?.service_ticket;
      if (!serviceTicket) return { status: 'error' as QRStatus, message: 'No service ticket' };

      try {
        const loginResp = await fetch(`https://drive.uc.cn/account/info?st=${serviceTicket}&lw=scan`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          redirect: 'manual',
        });
        const setCookies = (loginResp.headers as any).getSetCookie?.() || [];
        const cookieParts: string[] = [];
        for (const sc of setCookies) {
          const part = sc.split(';')[0];
          if (part) cookieParts.push(part);
        }
        if (cookieParts.length > 0) {
          return { status: 'confirmed' as QRStatus, credential: { cookie: cookieParts.join('; ') } };
        }
        return { status: 'confirmed' as QRStatus, credential: { cookie: `__st=${serviceTicket}` } };
      } catch (err) {
        return { status: 'error' as QRStatus, message: `Cookie exchange failed: ${err}` };
      }
    }

    if (status === 'SCANED' || status === 'SCANNED') return { status: 'scanned' as QRStatus };
    if (status === 'EXPIRED' || bodyStatus === 50004002) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 115 网盘 ────────────────────────────────────────────

const pan115Handler: PlatformLoginHandler = {
  async generateQR() {
    const data = await safeFetchJson('https://qrcodeapi.115.com/api/1.0/web/1.0/token/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, '115 网盘');

    if (!data?.data?.uid) throw new Error('115 QR generate failed');

    return {
      qrUrl: `https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode?uid=${data.data.uid}`,
      token: JSON.stringify({ uid: data.data.uid, time: data.data.time, sign: data.data.sign }),
    };
  },

  async pollStatus(token: string) {
    const { uid, time, sign } = JSON.parse(token);
    const data = await safeFetchJson(`https://qrcodeapi.115.com/get/status/?uid=${uid}&time=${time}&sign=${sign}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, '115 网盘');

    if (data?.data?.status === 2) {
      // 已确认，用 uid 换取 cookie
      try {
        const loginResp = await fetch('https://passportapi.115.com/app/1.0/web/1.0/login/qrcode/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          body: `account=${uid}&app=web`,
        });
        const loginData = await loginResp.json() as any;
        const cookie = loginData?.data?.cookie;

        if (cookie) {
          // cookie 是一个对象 { CID, SEID, UID, ... }
          const parts = Object.entries(cookie).map(([k, v]) => `${k}=${v}`).join('; ');
          return { status: 'confirmed' as QRStatus, credential: { cookie: parts } };
        }

        return { status: 'error' as QRStatus, message: 'No cookie in login response' };
      } catch (err) {
        return { status: 'error' as QRStatus, message: `Login failed: ${err}` };
      }
    }

    if (data?.data?.status === 1) return { status: 'scanned' as QRStatus };
    if (data?.data?.status === -2) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 天翼云盘 ────────────────────────────────────────────

const tianyiHandler: PlatformLoginHandler = {
  async generateQR() {
    // 天翼网盘官方已下线该网页版扫码登录 API，抛出明确的不支持提示引导用户手动录入
    throw new Error('天翼网盘官方已关闭扫码登录接口，请直接在下方使用【手动粘贴凭证】配置 Cookie 登录');
  },

  async pollStatus(token: string) {
    const data = await safeFetchJson('https://open.e.189.cn/api/logbox/oauth2/qrcodeLoginState.do', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://open.e.189.cn/',
      },
      body: `uuid=${token}&appId=8025431004`,
    }, '天翼云盘');

    if (data?.result === 0 && data?.redirectUrl) {
      // 登录成功，从重定向 URL 获取 cookie
      try {
        const redirectResp = await fetch(data.redirectUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          redirect: 'manual',
        });
        const setCookies = (redirectResp.headers as any).getSetCookie?.() || [];
        const cookieParts: string[] = [];
        for (const sc of setCookies) {
          const part = sc.split(';')[0];
          if (part) cookieParts.push(part);
        }
        if (cookieParts.length > 0) {
          return { status: 'confirmed' as QRStatus, credential: { cookie: cookieParts.join('; ') } };
        }
      } catch {
        // fallback
      }
      return { status: 'confirmed' as QRStatus, credential: { cookie: '' } };
    }

    if (data?.result === 0 && data?.status === 1) return { status: 'scanned' as QRStatus };
    if (data?.result === -1 || data?.status === -1) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 百度网盘 ────────────────────────────────────────────

const baiduHandler: PlatformLoginHandler = {
  async generateQR() {
    const gid = generateGid();
    const data = await safeFetchJson('https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=' + gid, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, '百度网盘');

    if (!data?.imgurl || !data?.sign) throw new Error('Baidu QR generate failed');

    return {
      qrUrl: `https://${data.imgurl}`,
      token: JSON.stringify({ sign: data.sign, gid }),
    };
  },

  async pollStatus(tokenStr: string) {
    let sign = tokenStr;
    let gid = '';
    try {
      const parsed = JSON.parse(tokenStr);
      if (parsed && typeof parsed === 'object') {
        sign = parsed.sign || tokenStr;
        gid = parsed.gid || '';
      }
    } catch {}
    if (!gid) gid = generateGid();

    const data = await safeFetchJson(`https://passport.baidu.com/channel/unicast?channel_id=${sign}&tpl=netdisk&gid=${gid}&apiver=v3`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, '百度网盘');

    if (data?.errno === 0 && data?.channel_v) {
      try {
        const channelData = JSON.parse(data.channel_v);
        if (channelData.status === 0) {
          // 登录成功，需要用 v 值换取 cookie
          const loginResp = await fetch(`https://passport.baidu.com/v3/login/main/qrbdusslogin?bduss=${channelData.v}&loginVersion=v5`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            redirect: 'manual',
          });
          const setCookies = (loginResp.headers as any).getSetCookie?.() || [];
          const cookieParts: string[] = [];
          for (const sc of setCookies) {
            const part = sc.split(';')[0];
            if (part && (part.includes('BDUSS') || part.includes('STOKEN'))) {
              cookieParts.push(part);
            }
          }
          if (cookieParts.length > 0) {
            return { status: 'confirmed' as QRStatus, credential: { cookie: cookieParts.join('; ') } };
          }
          // fallback: 直接用 bduss
          return { status: 'confirmed' as QRStatus, credential: { cookie: `BDUSS=${channelData.v}` } };
        }
        if (channelData.status === 1) return { status: 'scanned' as QRStatus };
      } catch {
        // 非 JSON，可能是中间状态
      }
    }

    if (data?.errno === 1) return { status: 'waiting' as QRStatus }; // channel 无新消息
    if (data?.errno === -1) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

function generateGid(): string {
  return 'xxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16).toUpperCase();
  });
}

// ─── 123 网盘 ────────────────────────────────────────────

const pan123Handler: PlatformLoginHandler = {
  async generateQR() {
    // 123网盘官方已下线第三方网页扫码接口，抛出明确的不支持提示引导用户手动录入
    throw new Error('123网盘官方已关闭第三方扫码登录接口，请直接在下方使用【手动粘贴凭证】配置 Token 登录');
  },

  async pollStatus(token: string) {
    const data = await safeFetchJson(`https://www.123pan.com/api/user/sign_in/qr/result?requestId=${token}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Platform': 'web',
      },
    }, '123 网盘');

    if (data?.code === 0 && data?.data?.token) {
      return {
        status: 'confirmed' as QRStatus,
        credential: { token: data.data.token },
      };
    }

    if (data?.data?.status === 1) return { status: 'scanned' as QRStatus };
    if (data?.code === 400 || data?.data?.expired) return { status: 'expired' as QRStatus };
    return { status: 'waiting' as QRStatus };
  },
};

// ─── 迅雷（账号密码）────────────────────────────────────

const thunderHandler: PlatformLoginHandler = {
  async passwordLogin(username: string, password: string) {
    // 迅雷使用账号密码登录，凭证直接保存
    // TVBox Spider 需要的是 username + password 明文
    if (!username || !password) {
      return { success: false, message: '请输入账号和密码' };
    }
    return {
      success: true,
      credential: { username, password },
    };
  },
};

// ─── PikPak（账号密码）──────────────────────────────────

const pikpakHandler: PlatformLoginHandler = {
  async passwordLogin(username: string, password: string) {
    if (!username || !password) {
      return { success: false, message: '请输入账号和密码' };
    }
    // 可选：验证登录有效性
    try {
      const resp = await fetch('https://user.mypikpak.com/v1/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'YNxT9w7GMdWvEOKa',
          username,
          password,
        }),
      });
      const data = await resp.json() as any;
      if (data?.access_token) {
        return {
          success: true,
          credential: { username, password },
        };
      }
      return { success: false, message: data?.error_description || '登录失败' };
    } catch (err) {
      // 验证失败不阻塞，仍然保存凭证（可能是网络问题）
      return {
        success: true,
        credential: { username, password },
      };
    }
  },
};

// ─── 统一接口 ────────────────────────────────────────────

const HANDLERS: Record<CloudPlatform, PlatformLoginHandler> = {
  bilibili: bilibiliHandler,
  aliyun: aliyunHandler,
  quark: quarkHandler,
  uc: ucHandler,
  pan115: pan115Handler,
  tianyi: tianyiHandler,
  baidu: baiduHandler,
  pan123: pan123Handler,
  thunder: thunderHandler,
  pikpak: pikpakHandler,
};

export const PASSWORD_PLATFORMS: CloudPlatform[] = ['thunder', 'pikpak'];
export const QR_PLATFORMS: CloudPlatform[] = ['bilibili', 'aliyun', 'quark', 'uc', 'pan115', 'baidu'];

export const PLATFORM_NAMES: Record<CloudPlatform, string> = {
  aliyun: '阿里云盘',
  bilibili: 'Bilibili',
  quark: '夸克网盘',
  uc: 'UC 网盘',
  pan115: '115 网盘',
  tianyi: '天翼云盘',
  baidu: '百度网盘',
  pan123: '123 网盘',
  thunder: '迅雷',
  pikpak: 'PikPak',
};

export async function generateQR(platform: CloudPlatform): Promise<QRResult> {
  const handler = HANDLERS[platform];
  if (!handler?.generateQR) throw new Error(`Platform ${platform} does not support QR login`);
  return handler.generateQR();
}

export async function pollQRStatus(platform: CloudPlatform, token: string): Promise<PollResult> {
  const handler = HANDLERS[platform];
  if (!handler?.pollStatus) throw new Error(`Platform ${platform} does not support QR login`);
  return handler.pollStatus(token);
}

export async function passwordLogin(platform: CloudPlatform, username: string, password: string): Promise<PasswordLoginResult> {
  const handler = HANDLERS[platform];
  if (!handler?.passwordLogin) throw new Error(`Platform ${platform} does not support password login`);
  return handler.passwordLogin(username, password);
}
