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
  | 'd3-cloud-drive-json'
  | 'b63-cloud-inline'
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
 * 已验证的重打包指纹。2cc/f782 外层壳相同，差异只在加密 Guard 内层；
 * 现场回归表明 Pan/WoGG 系列应统一通过 Cloud-drive 消费
 * `/tvfan/config` 五字段契约。此处仍按精确 API|JAR 登记，避免退化为
 * “API 集合 × JAR 集合”的笛卡尔积盲匹配。
 */
const JAR_2CC = '2cc088afa757ba8bafffcfbab4b73ccc';
const JAR_F782 = 'f782cdee81118405176fd260be9ca5cd';

/**
 * 只有已验证会通过 ext.Cloud-drive 消费凭证的 Guard API 才登记。
 * 同一 JAR 下还有 MyDrive、Push、S_zps 等完全不同的契约；未登记的
 * API|JAR 组合一律拒绝注入，避免旧问题修好又引入新问题。
 */
/**
 * 精确的 API|JAR -> 响应契约映射。
 *
 * 这里只登记已经通过反编译或现场回归确认的组合，绝不再做
 * “API 集合 × JAR 集合”的笛卡尔积。没有证据的组合保持 unknown，
 * 即使 ext 里存在 Cloud-drive 也不注入，避免把一个源修好后污染其它源。
 */
/**
 * 只有已通过现场回归证明走 Pan.init 平台 URL 的 Guard 组合才登记。
 * YpanSoGuard 已确认使用 Cloud-drive 契约，不能再放回这里，否则会删除
 * Cloud-drive 并只留下部分平台字段。
 */
const PAN_INIT_GUARD_CONTRACTS = new Map<string, CredentialMechanism>();
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
  'csp_woggguard',
] as const;
const CLOUD_DRIVE_GUARD_CONTRACTS = new Map<string, CredentialMechanism>([
  ...CLOUD_DRIVE_GUARD_APIS.map((api) => [`${api}|${JAR_2CC}`, 'tvfan-config-url'] as const),
  ...CLOUD_DRIVE_GUARD_APIS.map((api) => [`${api}|${JAR_F782}`, 'tvfan-config-url'] as const),
  ['csp_woggguard|4ce29ce27eeff6a73a230dd92d98ba0c', 'tvfan-config-url'],
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

/**
 * 精确登记的 API|JAR 组合已经证明会消费 Cloud-drive。入口字段可能是上游
 * 已提供的 tvfan/Cloud-drive.txt，也可能完全不存在（例如部分 WoGGGuard
 * 只有 siteUrl/from）。此时由注入器创建入口，不能再要求原 ext 预先含该字段，
 * 否则会出现“协议已识别但永远不下发”的静默失败。
 */
function hasVerifiedCloudDriveGuardContract(apiJarKey: string): boolean {
  return CLOUD_DRIVE_GUARD_CONTRACTS.has(apiJarKey);
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

const PAN_INIT_API_RE = /^csp_(?:Wo[bg]g|Mogg|MIPanSo|KkSs|PanSso|PanSou)(?:Guard)?/i;
const D3_CLOUD_DRIVE_API_RE = /^csp_(?:Wo[bg]g|Mogg|MIPanSo|KkSs|PanSso|PanSou|Libvio)(?:Guard)?$/i;
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

  const apiJarKey = `${api.toLowerCase()}|${extractJarMd5(effectiveJar)?.toLowerCase() || ''}`;


  const panInitContract = PAN_INIT_GUARD_CONTRACTS.get(apiJarKey);
  if (panInitContract) {
    return {
      mechanism: panInitContract,
      platforms: [...PAN_INIT_PLATFORMS],
      credentialRequired: true,
      canInject: true,
      reason: 'YpanSo Guard Pan.init platform URL contract',
    };
  }
  const cloudDriveContract = CLOUD_DRIVE_GUARD_CONTRACTS.get(apiJarKey);
  if (cloudDriveContract && (hasVerifiedCloudDriveGuardContract(apiJarKey) || hasCloudDriveTokenContract(site))) {
    return {
      mechanism: cloudDriveContract,
      platforms: [...TOKEN_JSON_PLATFORMS],
      credentialRequired: true,
      canInject: true,
      reason: `${apiJarKey.split('|')[1].slice(0, 8)} Guard Cloud-drive tvfan/config contract`,
    };
  }

  if (/^csp_PanSearch(?:Guard)?/i.test(api) && is3D(effectiveJar)) {
    // 3D PanSearch 继承 Pan；Pan.init 已确认读取 ext.Cloud-drive 指向的 JSON。
    // ext.pan 只是搜索目标，不能拿它选择凭证字段或平台。
    return {
      mechanism: 'd3-cloud-drive-json',
      platforms: ['aliyun', 'quark', 'uc'],
      credentialRequired: true,
      canInject: true,
      reason: '3D PanSearch Cloud-drive JSON contract',
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

  // B63 的 Wogg/WoGG/Mogg 均继承 Pan.init：Pan.init 会把 ext 中
  // quark/uc/tianyi/baidu 等值当作 URL 下载，再把响应交给对应平台 init。
  // Quark/UC 只接受带 __pus 的 Cookie，Baidu 接受 Cookie 文本，因此必须
  // 下发 /credential/<field> URL，不能把 Cookie 内联到 ext。
  if (PAN_INIT_API_RE.test(api) && (isB63(effectiveJar) || isMoggJar(effectiveJar))) {
    return {
      mechanism: 'pan-init-url',
      platforms: [...PAN_INIT_PLATFORMS],
      credentialRequired: true,
      canInject: true,
      reason: 'B63/Mogg Pan.init platform URL contract',
    };
  }

  if (/^csp_PanSearch(?:Guard)?/i.test(api) && isB63(effectiveJar)) {
    return {
      mechanism: 'pan-init-url',
      platforms: ['quark', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder'],
      credentialRequired: true,
      canInject: true,
      reason: 'PanSearch B63 Pan.init platform URL contract',
    };
  }

  // 3D JAR 的 Pan 派生 Spider 共享 Pan.init：真正读取的是 ext.Cloud-drive
  // 指向的 JSON。Libvio 等类虽不叫 PanSearch，也继承 Pan，不能漏掉。
  // 只接受已验证会提供该入口的 API，避免把普通 Libvio 网页源误判。
  if (D3_CLOUD_DRIVE_API_RE.test(api) && is3D(effectiveJar) && hasCloudDriveTokenContract(site)) {
    return {
      mechanism: 'd3-cloud-drive-json',
      platforms: ['aliyun', 'quark', 'uc'],
      credentialRequired: true,
      canInject: true,
      reason: '3D Pan-derived Cloud-drive JSON contract',
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
