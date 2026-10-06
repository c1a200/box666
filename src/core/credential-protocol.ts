// 网盘凭证协议解析器
//
// 这里是风险识别与响应注入共用的唯一协议入口。规则只按“已验证的
// Spider API + JAR 契约”匹配，不按总源名称或单个站点 key 特判。
import type { CloudPlatform, TVBoxSite } from './types';
import { extractJarMd5 } from './site-contract';

export type CredentialMechanism =
  | 'ali-token-url'
  | 'token-json-url'
  | 'tvfan-config-url'
  | 'pan-init-url'
  | 'pan-search-ext-pan'
  | 'pan-search-fixed-baidu'
  | 'alist'
  | 'direct-ext-field'
  | 'none'
  | 'unknown';

export interface CredentialProtocol {
  mechanism: CredentialMechanism;
  /** 只列出该协议真正可能消费的平台。 */
  platforms: CloudPlatform[];
  /** 资源是否被识别为需要客户端凭证的源。 */
  credentialRequired: boolean;
  /** 无基址/无实现时仍可用于判断风险与来源边界。 */
  canInject: boolean;
  /** 固定平台协议使用；例如 B63 PanSearch 的 baidu。 */
  fixedPlatform?: CloudPlatform;
  /** ext.pan 协议使用；例如 3D PanSearch 的 quark/uc。 */
  panField?: string;
  reason: string;
}

export interface CredentialProtocolContext {
  effectiveJar?: string;
}

const JAR = {
  b63: 'b63a0eb8852bb7ab06500c424ccc3dae',
  d3: '3d161697458ecbcd2651a749db761ba1',
  mogg: '265301f463ec681dcbba91897f20f08b',
} as const;

const PAN_INIT_PLATFORMS: readonly CloudPlatform[] = [
  'pan123', 'thunder', 'quark', 'uc', 'tianyi', 'baidu',
];

const PAN_SEARCH_PLATFORMS: readonly CloudPlatform[] = [
  'quark', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder',
];

const TOKEN_JSON_PLATFORMS: readonly CloudPlatform[] = [
  'aliyun', 'quark', 'uc', 'uc_tv', 'pan115', 'thunder', 'pikpak', 'tianyi', 'baidu', 'pan123',
];

/**
 * 已验证的 2cc Guard 重打包指纹。两者虽然复用了同一批 Guard 类名，
 * 但内层实现读取的响应契约不同：
 * - 2cc 版本依赖完整 token.json schema（quark_cookie 等下划线别名）。
 * - f782 版本依赖上游 /tvfan/config 五字段契约。
 * 绝不能再做“JAR 集合 × API 集合”的笛卡尔积盲匹配。
 */
const JAR_2CC = '2cc088afa757ba8bafffcfbab4b73ccc';
const JAR_F782 = 'f782cdee81118405176fd260be9ca5cd';

/**
 * 只有已验证会通过 ext.Cloud-drive 消费凭证的 Guard API 才登记。
 * 同一 JAR 下还有 MyDrive、Push、S_zps 等完全不同的契约；未登记的
 * API|JAR 组合一律拒绝注入，避免旧问题修好又引入新问题。
 */
const CLOUD_DRIVE_GUARD_APIS = [
  'csp_ypansoguard',
  'csp_bpansoguard',
  'csp_panssoguard',
  'csp_xzsoguard',
  'csp_uussguard',
  'csp_kkssguard',
  'csp_mipansoguard',
  'csp_libvioguard',
  'csp_pansearchguard',
  'csp_yisoguard',
] as const;

/** 精确的 API|JAR -> 响应契约映射，不生成任何未验证组合。 */
const CLOUD_DRIVE_GUARD_CONTRACTS = new Map<string, CredentialMechanism>([
  ...CLOUD_DRIVE_GUARD_APIS.map((guardApi) => [`${guardApi}|${JAR_2CC}`, 'token-json-url'] as const),
  ...CLOUD_DRIVE_GUARD_APIS.map((guardApi) => [`${guardApi}|${JAR_F782}`, 'tvfan-config-url'] as const),
]);
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseExtRecord(ext: unknown): Record<string, unknown> | null {
  if (isObjectRecord(ext)) return ext;
  if (typeof ext !== 'string' || !ext.trim()) return null;
  try {
    const parsed = JSON.parse(ext);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 只读取 PanSearch 真正会消费的 ext.pan，不从字段或站点名称猜测。 */
export function getPanSearchPlatform(site: TVBoxSite): CloudPlatform | null {
  const ext = parseExtRecord(site.ext);
  const pan = ext && typeof ext.pan === 'string' ? ext.pan.trim().toLowerCase() : '';
  return PAN_SEARCH_PLATFORM_MAP[pan] || null;
}

function isB63(jar?: string): boolean {
  return extractJarMd5(jar) === JAR.b63;
}

function is3D(jar?: string): boolean {
  return extractJarMd5(jar) === JAR.d3;
}

function isMoggJar(jar?: string): boolean {
  return extractJarMd5(jar) === JAR.mogg;
}

/** 2cc Guard 契约只在 ext 明确提供 Cloud-drive 入口时才成立。 */
function hasCloudDriveTokenContract(site: TVBoxSite): boolean {
  const ext = parseExtRecord(site.ext);
  return !!ext
    && typeof ext['Cloud-drive'] === 'string'
    && ext['Cloud-drive'].trim().length > 0;
}

const PAN_SEARCH_PLATFORM_MAP: Record<string, CloudPlatform> = {
  quark: 'quark',
  '夸克': 'quark',
  uc: 'uc',
  tianyi: 'tianyi',
  '天翼': 'tianyi',
  baidu: 'baidu',
  '百度': 'baidu',
  p123: 'pan123',
  pan123: 'pan123',
  '123': 'pan123',
  xunlei: 'thunder',
  thunder: 'thunder',
  '迅雷': 'thunder',
};

const PAN_INIT_API_RE = /^csp_(?:Wo[bg]g|Mogg|MIPanSo|KkSs|PanSso)(?:Guard)?/i;
const ALI_TOKEN_API_RE = /^csp_YiSo$/i;

function directFieldProtocol(
  platform: CloudPlatform,
  reason: string,
): CredentialProtocol {
  return {
    mechanism: 'direct-ext-field',
    platforms: [platform],
    credentialRequired: true,
    canInject: true,
    reason,
  };
}

/**
 * 解析一个源实际使用的凭证协议。
 *
 * 返回 unknown 表示没有足够证据证明该 JAR/API 会消费何种凭证；调用方
 * 必须拒绝注入，而不是退化为按平台名猜测。
 */
export function resolveCredentialProtocol(
  site: TVBoxSite,
  context: { effectiveJar?: string } = {},
): CredentialProtocol {
  const api = String(site.api || '');
  const effectiveJar = extractJarMd5(site.jar)
    ? (site.jar || '')
    : (context.effectiveJar || '');

  if (/^csp_AList/i.test(api)) {
    return {
      mechanism: 'alist',
      platforms: ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak', 'tianyi', 'baidu', 'pan123'],
      credentialRequired: true,
      canInject: true,
      reason: 'AList JSON/drive contract',
    };
  }

  if (/^csp_AweSomeGuard/i.test(api)) {
    const ext = parseExtRecord(site.ext);
    const sp = ext && typeof ext.sp === 'string' ? ext.sp.toLowerCase() : '';
    if (sp === 'alist') {
      return {
        mechanism: 'alist',
        platforms: ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak', 'tianyi', 'baidu', 'pan123'],
        credentialRequired: true,
        canInject: true,
        reason: 'AweSomeGuard sp=AList',
      };
    }
    return {
      mechanism: 'none',
      platforms: [],
      credentialRequired: false,
      canInject: false,
      reason: 'AweSomeGuard without AList contract',
    };
  }

  const cloudDriveContract = CLOUD_DRIVE_GUARD_CONTRACTS.get(
    `${api.toLowerCase()}|${extractJarMd5(effectiveJar)?.toLowerCase() || ''}`,
  );
  if (cloudDriveContract && hasCloudDriveTokenContract(site)) {
    return {
      mechanism: cloudDriveContract,
      platforms: [...TOKEN_JSON_PLATFORMS],
      credentialRequired: true,
      canInject: true,
      reason: cloudDriveContract === 'token-json-url'
        ? '2cc Guard Cloud-drive token.json contract'
        : 'f782 Guard Cloud-drive tvfan/config contract',
    };
  }

  if (/^csp_PanSearch(?:Guard)?/i.test(api) && isB63(effectiveJar)) {
    return {
      mechanism: 'pan-search-fixed-baidu',
      platforms: ['baidu'],
      credentialRequired: true,
      canInject: true,
      fixedPlatform: 'baidu',
      panField: 'pan',
      reason: 'PanSearch B63 fixed baidu',
    };
  }

  if (/^csp_PanSearch(?:Guard)?/i.test(api) && is3D(effectiveJar)) {
    // 只有 ext.pan 能明确映射到 Pan.init 已支持的六类平台时才注入；
    // 缺失或不支持的 ext.pan 必须保持未知，不能按站点名称猜测。
    const platform = getPanSearchPlatform(site);
    return {
      mechanism: 'pan-search-ext-pan',
      platforms: platform ? [platform] : [...PAN_SEARCH_PLATFORMS],
      credentialRequired: true,
      canInject: !!platform,
      fixedPlatform: platform || undefined,
      panField: 'pan',
      reason: platform
        ? `PanSearch 3D ext.pan=${platform}`
        : 'PanSearch 3D missing/unsupported ext.pan',
    };
  }

  // 3D 的 YiSo 直接继承 Ali，实际 JAR 已确认会读取 ext.Cloud-drive；
  // 只有 ext.from 包含 tvfan 时才把该地址当 JSON 初始化源，因此由注入器补齐 from。
  if (ALI_TOKEN_API_RE.test(api) && is3D(effectiveJar)) {
    return {
      mechanism: 'ali-token-url',
      platforms: ['aliyun'],
      credentialRequired: true,
      canInject: true,
      reason: '3D YiSo Ali.init Cloud-drive JSON contract',
    };
  }

  if (PAN_INIT_API_RE.test(api) && (isB63(effectiveJar) || isMoggJar(effectiveJar))) {
    const isWogg = /^csp_Wo[bg]g/i.test(api);
    return {
      mechanism: 'pan-init-url',
      platforms: [...PAN_INIT_PLATFORMS],
      credentialRequired: true,
      canInject: true,
      reason: isWogg ? 'Wogg/Wobg Pan.init URL contract' : 'Mogg Pan.init URL contract',
    };
  }

  if (PAN_INIT_API_RE.test(api) && is3D(effectiveJar)) {
    return {
      mechanism: 'pan-init-url',
      platforms: [...PAN_INIT_PLATFORMS],
      credentialRequired: true,
      canInject: true,
      reason: '3D Pan-derived Pan.init URL contract',
    };
  }

  if (/^csp_Bili(?:2)?$/i.test(api)) {
    const ext = parseExtRecord(site.ext);
    if (!ext || !('cookie' in ext)) {
      return {
        mechanism: 'unknown',
        platforms: [],
        credentialRequired: false,
        canInject: false,
        reason: 'Bili cookie contract not present in ext',
      };
    }
    return directFieldProtocol('bilibili', 'Bili ext.cookie');
  }

  if (/^csp_Pan115(?:Guard)?$/i.test(api)) {
    const ext = parseExtRecord(site.ext);
    if (!ext || !('cookie' in ext)) {
      return {
        mechanism: 'unknown',
        platforms: [],
        credentialRequired: false,
        canInject: false,
        reason: 'Pan115 cookie contract not present in ext',
      };
    }
    return directFieldProtocol('pan115', 'Pan115 ext.cookie');
  }

  if (/^csp_P123(?:Guard)?$/i.test(api)) {
    const ext = parseExtRecord(site.ext);
    if (!ext || !('username' in ext) || !('password' in ext)) {
      return {
        mechanism: 'unknown',
        platforms: [],
        credentialRequired: false,
        canInject: false,
        reason: 'P123 username/password contract not present in ext',
      };
    }
    return directFieldProtocol('pan123', 'P123 ext.username/password');
  }

  if (/^csp_XunLei(?!8)/i.test(api)) {
    const ext = parseExtRecord(site.ext);
    if (!ext || !('username' in ext) || !('password' in ext)) {
      return {
        mechanism: 'unknown',
        platforms: [],
        credentialRequired: false,
        canInject: false,
        reason: 'XunLei username/password contract not present in ext',
      };
    }
    return directFieldProtocol('thunder', 'XunLei ext.username/password');
  }

  if (/^csp_Xunlei8/i.test(api)) {
    return {
      mechanism: 'none',
      platforms: [],
      credentialRequired: false,
      canInject: false,
      reason: 'Xunlei8 ext is a base URL, not a credential',
    };
  }

  return {
    mechanism: 'unknown',
    platforms: [],
    credentialRequired: false,
    canInject: false,
    reason: 'no verified credential contract',
  };
}
