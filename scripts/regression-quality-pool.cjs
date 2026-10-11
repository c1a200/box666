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

console.log('regression: quality pool freshness checks passed');
