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
    { key: 'timeout', grade: 'timeout', qualityScore: 80 },
    { key: 'unusable', grade: 'unusable', qualityScore: 0 },
  ],
};
const qualityPoolKeys = [...qualityPoolKeysFromPool(mixedPool)];
assert(qualityPoolKeys.join(',') === 'excellent,untestable', 'quality pool must include untestable and exclude timeout/unusable');

const distributed = [...distributableKeysFromPool({ entries: [
  { key: 'verified', grade: 'good', qualityScore: 760 },
  { key: 'client-a', grade: 'untestable', qualityScore: 420 },
  { key: 'client-b', grade: 'untestable', qualityScore: 420 },
  { key: 'dead', grade: 'unusable', qualityScore: 0 },
] }, { includeUntestable: true })];
assert(distributed.join(',') === 'verified,client-a,client-b', 'default client fallback must keep all untestable sources');
assert(isHardJarProbeFailure({ key: 'x', siteKey: 'x', result: 'error', speedMs: null, httpStatus: 404 }) === true, 'missing remote JAR must remain unusable');
assert(isHardJarProbeFailure({ key: 'x', siteKey: 'x', result: 'error', speedMs: null, httpStatus: 200, zipValid: false, md5Verified: false }) === false, 'metadata/placeholder JAR failures must remain untestable');

console.log('regression: quality pool freshness checks passed');
