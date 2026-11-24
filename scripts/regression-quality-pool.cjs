const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.tmp-regression-build');
const outfile = path.join(outDir, 'quality.cjs');

buildSync({
  entryPoints: [path.join(root, 'src/core/quality.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile,
});

const {
  getQualityPoolHealth,
  QUALITY_POOL_FRESH_TTL_MS,
  QUALITY_POOL_STALE_TTL_MS,
  qualityPoolKeysFromPool,
  distributableKeysFromPool,
  isHardJarProbeFailure,
  gradeForProbe,
} = require(outfile);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const now = Date.parse('2026-10-11T00:00:00.000Z');
const pool = (updatedAt) => ({
  updatedAt,
  entries: [{ key: 'source-a', grade: 'good', result: 'ok', speedMs: 500 }],
});

assert(
  getQualityPoolHealth(pool(new Date(now - QUALITY_POOL_FRESH_TTL_MS).toISOString()), now).state === 'fresh',
  'fresh TTL boundary must remain fresh',
);
assert(
  getQualityPoolHealth(pool(new Date(now - QUALITY_POOL_FRESH_TTL_MS - 1).toISOString()), now).state === 'stale',
  'pool just beyond fresh TTL must become stale',
);
assert(
  getQualityPoolHealth(pool(new Date(now - QUALITY_POOL_STALE_TTL_MS).toISOString()), now).state === 'stale',
  'stale TTL boundary must remain stale',
);
assert(
  getQualityPoolHealth(pool(new Date(now - QUALITY_POOL_STALE_TTL_MS - 1).toISOString()), now).state === 'expired',
  'pool just beyond stale TTL must become expired',
);
assert(
  getQualityPoolHealth(null, now).state === 'unavailable',
  'missing pool must be unavailable',
);
assert(
  getQualityPoolHealth({ updatedAt: 'not-a-date', entries: [{ key: 'source-a' }] }, now).state === 'unavailable',
  'invalid timestamp must be unavailable',
);
assert(
  getQualityPoolHealth({ updatedAt: new Date(now).toISOString(), entries: [] }, now).state === 'unavailable',
  'empty pool must be unavailable',
);

const mixedPool = {
  updatedAt: new Date(now).toISOString(),
  entries: [
    { key: 'excellent', grade: 'excellent', qualityScore: 900 },
    { key: 'untestable', grade: 'untestable', qualityScore: 420 },
    { key: 'transient', grade: 'transient', qualityScore: 120 },
    { key: 'timeout', grade: 'timeout', qualityScore: 80 },
    { key: 'unusable', grade: 'unusable', qualityScore: 0 },
  ],
};
const qualityPoolKeys = [...qualityPoolKeysFromPool(mixedPool)];
assert(qualityPoolKeys.join(',') === 'excellent,untestable,transient,timeout', 'quality pool must include every recoverable fallback grade and exclude unusable');

const distributed = [...distributableKeysFromPool({ entries: [
  { key: 'verified', grade: 'good', qualityScore: 760 },
  { key: 'transient', grade: 'transient', qualityScore: 120 },
  { key: 'timeout', grade: 'timeout', qualityScore: 80 },
  { key: 'client-a', grade: 'untestable', qualityScore: 420 },
  { key: 'client-b', grade: 'untestable', qualityScore: 420 },
  { key: 'dead', grade: 'unusable', qualityScore: 0 },
] }, { includeUntestable: true })];
assert(distributed.join(',') === 'verified,transient,timeout,client-a,client-b', 'default distribution must keep recoverable failures while excluding unusable sources');
assert(gradeForProbe({ key: 'status-404', result: 'error', speedMs: null, httpStatus: 404, failureKind: 'transient', consecutiveFailures: 1 }) === 'unusable', 'HTTP 404 must win over a stale transient failure kind');
assert(gradeForProbe({ key: 'status-410', result: 'error', speedMs: null, httpStatus: 410, consecutiveFailures: 1 }) === 'unusable', 'HTTP 410 is a definitive invalid source');
assert(gradeForProbe({ key: 'status-401', result: 'error', speedMs: null, httpStatus: 401, consecutiveFailures: 1 }) === 'transient', 'HTTP 401 must remain a recoverable failure');
assert(gradeForProbe({ key: 'status-403', result: 'error', speedMs: null, httpStatus: 403, consecutiveFailures: 1 }) === 'transient', 'HTTP 403 must remain a recoverable failure');
assert(gradeForProbe({ key: 'status-500', result: 'error', speedMs: null, httpStatus: 500, failureKind: 'transient', consecutiveFailures: 1 }) === 'transient', 'HTTP 5xx must remain a recoverable failure');
assert(gradeForProbe({ key: 'network-error', result: 'error', speedMs: null, failureKind: 'transient', consecutiveFailures: 1 }) === 'transient', 'network errors must remain recoverable');
assert(gradeForProbe({ key: 'empty-response', result: 'empty', speedMs: null, httpStatus: 200, failureKind: 'transient', consecutiveFailures: 1 }) === 'transient', 'empty responses must remain recoverable');
assert(isHardJarProbeFailure({ key: 'x', siteKey: 'x', result: 'error', speedMs: null, httpStatus: 404 }) === true, 'missing remote JAR must remain unusable');
assert(isHardJarProbeFailure({ key: 'x', siteKey: 'x', result: 'error', speedMs: null, httpStatus: 410 }) === true, 'gone remote JAR must remain unusable');
assert(isHardJarProbeFailure({ key: 'x', siteKey: 'x', result: 'error', speedMs: null, httpStatus: 401 }) === false, 'JAR authentication failures must remain client-verifiable');
assert(isHardJarProbeFailure({ key: 'x', siteKey: 'x', result: 'error', speedMs: null, httpStatus: 403 }) === false, 'JAR forbidden responses must remain client-verifiable');
assert(isHardJarProbeFailure({ key: 'x', siteKey: 'x', result: 'error', speedMs: null, httpStatus: 500 }) === false, 'JAR upstream failures must remain client-verifiable');
assert(isHardJarProbeFailure({ key: 'x', siteKey: 'x', result: 'error', speedMs: null, httpStatus: 200, zipValid: false, md5Verified: false }) === false, 'metadata/placeholder JAR failures must remain untestable');

console.log('regression: quality pool freshness checks passed');
