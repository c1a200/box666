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
  /** 聚合阶段按源实例固化的凭证绑定；存在时优先于 API/JAR 通用规则。 */
  binding?: {
    mechanism?: string;
    platforms?: string[];
    contractHash?: string;
  } | null;
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
 * 已验证的 Guard JAR 指纹。2cc/f782 外层壳相同，但内层实现可能不同；
 * 因此这里只按已确认的 API|JAR 组合登记，绝不做
 * “API 集合 × JAR 集合”的笛卡尔积盲匹配。
 */
const ALL_PLATFORMS = new Set<CloudPlatform>([
  'aliyun', 'bilibili', 'quark', 'uc', 'uc_tv', 'pan115',
  'tianyi', 'baidu', 'pan123', 'thunder', 'pikpak',
]);

const VALID_MECHANISMS = new Set<CredentialMechanism>([
  'ali-token-url', 'token-json-url', 'tvfan-config-url', 'pan-init-url',
  'd3-cloud-drive-json', 'b63-cloud-inline', 'pan-search-ext-pan',
  'pan-search-fixed-baidu', 'alist', 'direct-ext-field', 'none', 'unknown',
]);
const JAR_2CC = '2cc088afa757ba8bafffcfbab4b73ccc';
const JAR_F782 = 'f782cdee81118405176fd260be9ca5cd';
const JAR_2386 = '2386c62eb5f0b84dd53e27ad0fe9db49';

/**
 * 精确的 API|JAR -> 响应契约映射。
 *
 * 只登记已经通过反编译或现场回归确认的组合；没有证据的组合保持 unknown，
 * 即使 ext 里存在 Cloud-drive 也不注入，避免把一个源修好后污染其它源。
 * 同一 JAR 下还有 MyDrive、Push、S_zps 等完全不同的契约。
 */
/**
 * YpanSo/WoGG 的实测契约与同批 Cloud-drive Guard 不同：它们消费 Pan.init
 * 的 /credential/<field> 平台 URL，而不是 Cloud-drive token JSON。
 */
const PAN_INIT_GUARD_CONTRACTS = new Map<string, CredentialMechanism>([
  [`csp_woggguard|${JAR_F782}`, 'pan-init-url'],
  ['csp_woggguard|4ce29ce27eeff6a73a230dd92d98ba0c', 'pan-init-url'],
]);
/**
 * 这些 API|JAR 曾被错误登记为 tvfan-config-url，但反编译已确认它们并不消费
 * 该契约。显式返回 unknown 而不是依赖“没有精确规则”，这样旧 KV 绑定也不会
 * 在响应期把错误字段重新注入。
 */
const REVOKED_GUARD_BINDINGS = new Map<string, string>([
  [`csp_mydriveguard|${JAR_2386}`, 'MyDrive is not a Pan.init Guard contract'],
  [`csp_yisoguard|${JAR_2CC}`, '2cc YiSo is not a Pan.init Guard contract'],
  [`csp_yisoguard|${JAR_F782}`, 'f782 YiSo is not a Pan.init Guard contract'],
]);

const CLOUD_DRIVE_GUARD_CONTRACTS = new Map<string, CredentialMechanism>([
  // 2cc 与 f782 的 tvfan Guard 共享 Cloud-drive -> /tvfan/config 契约。
  [`csp_ypansoguard|${JAR_2CC}`, 'tvfan-config-url'],
  [`csp_bpansoguard|${JAR_2CC}`, 'tvfan-config-url'],
  [`csp_panssoguard|${JAR_2CC}`, 'tvfan-config-url'],
  [`csp_xzsoguard|${JAR_2CC}`, 'tvfan-config-url'],
  [`csp_uussguard|${JAR_2CC}`, 'tvfan-config-url'],
  [`csp_kkssguard|${JAR_2CC}`, 'tvfan-config-url'],
  [`csp_mipansoguard|${JAR_2CC}`, 'tvfan-config-url'],
  [`csp_libvioguard|${JAR_2CC}`, 'tvfan-config-url'],
  [`csp_pansearchguard|${JAR_2CC}`, 'tvfan-config-url'],
  [`csp_yisoguard|${JAR_2CC}`, 'tvfan-config-url'],

  // f782 与 2cc 同契约，保留独立分组便于后续 JAR 升级审计。
  [`csp_bpansoguard|${JAR_F782}`, 'tvfan-config-url'],
  [`csp_panssoguard|${JAR_F782}`, 'tvfan-config-url'],
  [`csp_xzsoguard|${JAR_F782}`, 'tvfan-config-url'],
  [`csp_uussguard|${JAR_F782}`, 'tvfan-config-url'],
  [`csp_kkssguard|${JAR_F782}`, 'tvfan-config-url'],
  [`csp_mipansoguard|${JAR_F782}`, 'tvfan-config-url'],
  [`csp_libvioguard|${JAR_F782}`, 'tvfan-config-url'],
  [`csp_pansearchguard|${JAR_F782}`, 'tvfan-config-url'],
  [`csp_yisoguard|${JAR_F782}`, 'tvfan-config-url'],
  [`csp_ypansoguard|${JAR_F782}`, 'tvfan-config-url'],

  // 2386 是饭太硬 Guard 的另一代契约，外层壳与 2cc/f782 相同但内层实现不同。
  // 只登记线上已确认携带 Cloud-drive 入口的 Guard；同 JAR 的 AiDj/Bili/
  // S_zps/Seedhub 等不能按 JAR 扩散，否则会写入它们不消费的字段。
  [`csp_uussguard|${JAR_2386}`, 'tvfan-config-url'],
  [`csp_ypansoguard|${JAR_2386}`, 'tvfan-config-url'],
  [`csp_woggguard|${JAR_2386}`, 'tvfan-config-url'],
  [`csp_bpansoguard|${JAR_2386}`, 'tvfan-config-url'],
  [`csp_kkssguard|${JAR_2386}`, 'tvfan-config-url'],
  [`csp_libvioguard|${JAR_2386}`, 'tvfan-config-url'],
  [`csp_mydriveguard|${JAR_2386}`, 'tvfan-config-url'],
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

const PAN_INIT_API_RE = /^csp_(?:Wo[bg]g|Mogg|MIPanSo|KkSs|PanSso|PanSou)(?:Guard)?/i;
const D3_CLOUD_DRIVE_API_RE = /^csp_(?:Wo[bg]g|Mogg|MIPanSo|KkSs|PanSso|PanSou|Libvio)(?:Guard)?$/i;
const ALI_TOKEN_API_RE = /^csp_YiSo$/i;

function unknownProtocol(reason: string): CredentialProtocol {
  return {
    mechanism: 'unknown',
    platforms: [],
    credentialRequired: false,
    canInject: false,
    reason,
  };
}

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
function resolvePreciseGuardContract(api: string, effectiveJar?: string): CredentialProtocol | null {
  const jarMd5 = extractJarMd5(effectiveJar)?.toLowerCase() || '';
  const apiJarKey = `${api.toLowerCase()}|${jarMd5}`;

  const revokedReason = REVOKED_GUARD_BINDINGS.get(apiJarKey);
  if (revokedReason) return unknownProtocol(revokedReason);

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
  if (cloudDriveContract) {
    // 精确登记的 API|JAR 组合已经证明会消费 Cloud-drive；入口字段可能由
    // 上游提供，也可能完全不存在（例如部分 WoGGGuard 只有 siteUrl/from），
    // 因此由注入器按该 JAR 的响应 schema 创建入口。
    return {
      mechanism: cloudDriveContract,
      platforms: [...TOKEN_JSON_PLATFORMS],
      credentialRequired: true,
      canInject: true,
      reason: cloudDriveContract === 'token-json-url'
        ? '2cc Guard Cloud-drive token.json contract'
        : 'Precise Guard Cloud-drive tvfan/config contract',
    };
  }

  return null;
}

/**
 * 解析一个源实际使用的凭证协议。
 *
 * 返回 unknown 表示没有足够证据证明该 JAR/API 会消费何种凭证；调用方
 * 必须拒绝注入，而不是退化为按平台名猜测。
 */
export function resolveCredentialProtocol(
  site: TVBoxSite,
  context: CredentialProtocolContext = {},
): CredentialProtocol {
  const api = String(site.api || '');
  const effectiveJar = extractJarMd5(site.jar)
    ? (site.jar || '')
    : (context.effectiveJar || '');

  // 聚合契约表可能比当前代码旧；当前代码已经按 API|JAR 精确登记时，必须以
  // 当前规则为准，否则旧表中的 unknown/错误 mechanism 会永久压住新契约，
  // 表现就是“代码已修但线上仍要扫码”。没有精确规则时才允许使用实例绑定。
  const preciseGuardContract = resolvePreciseGuardContract(api, effectiveJar);
  const binding = context.binding;
  if (binding && !preciseGuardContract) {
    const mechanism = typeof binding.mechanism === 'string'
      ? binding.mechanism as CredentialMechanism
      : undefined;
    const platforms = Array.isArray(binding.platforms)
      ? binding.platforms.filter((p): p is CloudPlatform => ALL_PLATFORMS.has(p as CloudPlatform))
      : [];

    if (!mechanism || !VALID_MECHANISMS.has(mechanism)) {
      return unknownProtocol('invalid or missing site credential mechanism binding');
    }
    if (mechanism === 'unknown') {
      return unknownProtocol('site contract binding marked mechanism unknown');
    }
    if (mechanism === 'none') {
      return {
        mechanism: 'none',
        platforms: [],
        credentialRequired: false,
        canInject: false,
        reason: 'site contract explicitly marks no credential injection',
      };
    }
    if (platforms.length === 0) {
      return unknownProtocol(`site contract binding ${mechanism} has no supported platforms`);
    }
    return {
      mechanism,
      platforms,
      credentialRequired: true,
      canInject: true,
      reason: `site contract binding: ${mechanism}`,
    };
  }

  if (preciseGuardContract) return preciseGuardContract;

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
