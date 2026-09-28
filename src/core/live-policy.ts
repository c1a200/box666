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

export function isBlockedLiveUrl(url: string): boolean {
  const value = url.trim();
  return BLOCKED_LIVE_URL_PATTERNS.some((pattern) => pattern.test(value));
}

export function isBlockedLiveSource(source: BlockableLiveSource): boolean {
  const name = (source.name || '').trim();
  if (name && BLOCKED_LIVE_SOURCE_NAMES.test(name)) return true;
  return isBlockedLiveUrl(source.url);
}
