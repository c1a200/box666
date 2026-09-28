// Central live-source and live-line block policy.
// Keep this module dependency-free so it can be shared by source discovery,
// proxy manifests and the final live merger without creating import cycles.

export const BLOCKED_LIVE_SOURCE_NAMES = /^(?:音乐所|有效期27年7月)$/;

export const BLOCKED_LIVE_URL_PATTERNS: RegExp[] = [
  // Render aggregated CCTV-1: this line serves a medicine advertisement.
  /^https?:\/\/219\.147\.245\.238:25480\/newlive\/live\/hls\/1\/live\.m3u8(?:\?|$)/i,
  // Empty/broken separated-mode sources requested for removal.
  /^https?:\/\/szyyds\.cn\/tv\/live\/yy\.txt(?:\?|$)/i,
  /^https?:\/\/m\.szyyds\.cn\/api\.php(?:\?|$)/i,
];

export interface BlockableLiveSource {
  name?: string;
  url: string;
}

export interface LiveSourcePolicyResult<T extends BlockableLiveSource> {
  allowed: T[];
  blocked: T[];
}

function stripLiveSourceSuffix(url: string): string {
  const value = url.trim();
  const suffixIndex = value.indexOf('$');
  return suffixIndex >= 0 ? value.slice(0, suffixIndex) : value;
}

function extractLiveUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s,#]+/gi) || [];
}

export function isBlockedLiveUrl(url: string): boolean {
  const candidates = extractLiveUrls(url);
  const values = candidates.length > 0 ? candidates : [url];
  return values.some((candidate) => {
    const value = stripLiveSourceSuffix(candidate);
    return BLOCKED_LIVE_URL_PATTERNS.some((pattern) => pattern.test(value));
  });
}

export function isBlockedLiveSource(source: BlockableLiveSource): boolean {
  const name = (source.name || '').trim();
  if (name && BLOCKED_LIVE_SOURCE_NAMES.test(name)) return true;
  return isBlockedLiveUrl(source.url);
}

export function containsBlockedLiveUrl(text: string): boolean {
  return extractLiveUrls(text).some((url) => isBlockedLiveUrl(url));
}

/**
 * Apply the shared source-level policy before any aggregation/separated-mode
 * processing. Keeping this in one place prevents a blocked source from being
 * downloaded, cached, probed or exposed by one runtime but not another.
 */
export function partitionBlockedLiveSources<T extends BlockableLiveSource>(
  sources: readonly T[],
): LiveSourcePolicyResult<T> {
  const allowed: T[] = [];
  const blocked: T[] = [];
  for (const source of sources) {
    if (isBlockedLiveSource(source)) blocked.push(source);
    else allowed.push(source);
  }
  return { allowed, blocked };
}
