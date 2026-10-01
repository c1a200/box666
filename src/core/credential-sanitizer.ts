import type { TVBoxConfig, CloudPlatform, CloudCredential } from './types';

const PROJECT_CREDENTIAL_FIELDS = new Set<string>([
  'cookie',
  'quark_cookie', 'quarkCookie',
  'uc_cookie', 'ucCookie', 'uccookie',
  '115_cookie', '115Cookie',
  'tyitoken', 'tianyi_cookie', 'tianyiCookie',
  'dutoken', 'baidu_cookie', 'baiduCookie',
  'p123token', '123_token', '123token',
  'p123_username', 'p123_password',
  'tuctoken', 'thunder_token', 'thunder_username', 'thunder_password',
  'xunlei_username', 'xunlei_password',
  'pikpak_username', 'pikpak_password',
  'bili_cookie', 'bilibili_cookie',
  'refresh_token', 'open_token', 'ali_token',
  'token',
]);

const ACCOUNT_SECRET_FIELDS = new Set<string>([
  'username', 'password', 'pass', 'user', 'account', 'email', 'phone',
]);

const NESTED_CREDENTIAL_KEYS = new Set<string>([
  'p123', 'xunlei', 'quark', 'uc', 'tianyi', 'baidu', '115', 'aliyun',
  'pan123', 'thunder', 'bilibili', 'pikpak', 'drives', 'drive', 'credential',
  'credentials',
]);

function isProjectCredentialUrl(value: unknown, baseUrl: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) return false;
    const path = parsed.pathname.replace(/\/+$/, '');
    return /^(?:\/auth\/[^/]+)?\/(?:credential\/[A-Za-z0-9_.-]+|token\.json)$/.test(path);
  } catch {
    return false;
  }
}

function isAListProxyUrl(value: unknown, baseUrl: string): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) return null;
    if (!parsed.pathname.replace(/\/+$/, '').endsWith('/credential/alist')) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function collectCredentialSecrets(
  credentials: Map<CloudPlatform, CloudCredential>,
): Set<string> {
  const secrets = new Set<string>();
  for (const credential of credentials.values()) {
    for (const value of Object.values(credential.credential || {})) {
      if (typeof value === 'string' && value.trim()) secrets.add(value.trim());
    }
  }
  return secrets;
}

function cleanStringValue(
  value: string,
  baseUrl: string,
  secrets: Set<string>,
  allowedSecrets: Set<string>,
  strictCredentialField = false,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return value;

  const alist = isAListProxyUrl(trimmed, baseUrl);
  if (alist) {
    const source = alist.searchParams.get('src');
    if (source) return source;
  }

  if (isProjectCredentialUrl(trimmed, baseUrl)) return null;
  // In strict mode the caller has identified this as a project credential
  // field. Remove it unless it is explicitly allowed for this request. This
  // also removes stale plaintext values whose credential was deleted from KV.
  if (strictCredentialField && !allowedSecrets.has(trimmed)) return null;
  if (secrets.has(trimmed) && !allowedSecrets.has(trimmed)) return null;
  return value;
}

function cleanCredentialNode(
  node: any,
  baseUrl: string,
  secrets: Set<string>,
  allowedSecrets: Set<string>,
  parentKey = '',
): { value: any; changed: boolean } {
  if (Array.isArray(node)) {
    let changed = false;
    const values = node.map((item) => {
      const result = cleanCredentialNode(item, baseUrl, secrets, allowedSecrets, parentKey);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: changed ? values : node, changed };
  }

  if (!node || typeof node !== 'object') {
    if (typeof node === 'string') {
      const cleaned = cleanStringValue(node, baseUrl, secrets, allowedSecrets);
      if (cleaned !== node) return { value: cleaned, changed: true };
    }
    return { value: node, changed: false };
  }

  const next: Record<string, any> = { ...node };
  let changed = false;

  for (const [key, rawValue] of Object.entries(node)) {
    const lowerKey = key.toLowerCase();
    const isCredentialField = PROJECT_CREDENTIAL_FIELDS.has(key) || PROJECT_CREDENTIAL_FIELDS.has(lowerKey);
    const isAccountField = ACCOUNT_SECRET_FIELDS.has(lowerKey);
    const nestedKey = NESTED_CREDENTIAL_KEYS.has(lowerKey);

    if (typeof rawValue === 'string') {
      const isProjectUrl = isProjectCredentialUrl(rawValue, baseUrl) || !!isAListProxyUrl(rawValue, baseUrl);
      if (isCredentialField || isAccountField || nestedKey || isProjectUrl || lowerKey === 'ext' || lowerKey === 'extend') {
        const cleaned = cleanStringValue(
          rawValue,
          baseUrl,
          secrets,
          allowedSecrets,
          isCredentialField || isAccountField || nestedKey || isProjectUrl,
        );
        if (cleaned === null) {
          delete next[key];
          changed = true;
          continue;
        }
        if (cleaned !== rawValue) {
          next[key] = cleaned;
          changed = true;
        }
        if (lowerKey === 'ext' || lowerKey === 'extend') {
          const parsedText = rawValue.trim();
          if (parsedText.startsWith('{') || parsedText.startsWith('[')) {
            try {
              const parsed = JSON.parse(parsedText);
              const result = cleanCredentialNode(parsed, baseUrl, secrets, allowedSecrets, lowerKey);
              if (result.changed) {
                next[key] = JSON.stringify(result.value);
                changed = true;
              }
            } catch {
              // Keep non-JSON strings untouched.
            }
          }
        }
      }
      continue;
    }

    const result = cleanCredentialNode(rawValue, baseUrl, secrets, allowedSecrets, key);
    if (result.changed) {
      next[key] = result.value;
      changed = true;
    }
  }

  return { value: changed ? next : node, changed };
}

export function stripInjectedCredentialsFromConfig(
  config: TVBoxConfig | any,
  baseUrl: string,
  allCredentials: Map<CloudPlatform, CloudCredential> = new Map(),
  allowedSecrets: Set<string> = new Set(),
): any {
  if (!config || typeof config !== 'object') return config;
  const secrets = collectCredentialSecrets(allCredentials);
  return cleanCredentialNode(config, baseUrl, secrets, allowedSecrets).value;
}