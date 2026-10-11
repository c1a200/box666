const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.tmp-regression-build');
fs.mkdirSync(outDir, { recursive: true });

function bundle(entry, outfile, expose) {
  buildSync({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: path.join(outDir, outfile),
    define: { __TEST_EXPOSE__: expose || 'undefined' },
  });
}

bundle('src/core/merger.ts', 'merger.cjs', 'true');
bundle('src/core/client-auth-store.ts', 'client-auth.cjs', 'true');

const { mergeConfigs } = require(path.join(outDir, 'merger.cjs'));
const { normalizeClientDistributionConfig, findClientAuthCode } = require(path.join(outDir, 'client-auth.cjs'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sourced(name, upstreams, sites) {
  return { sourceName: name, upstreamNames: upstreams, config: { sites } };
}

const base = {
  key: 'wogg',
  name: '玩偶哥哥',
  type: 3,
  api: 'csp_XiaoYuan',
  ext: 'https://pan.example/token.json',
};
const merged = mergeConfigs([
  sourced('上游A', ['上游A'], [{ ...base }]),
  sourced('上游B', ['上游B'], [{ ...base }]),
]);
assert(merged.config.sites.length === 1, 'identical child sources should merge');
assert(merged.config.sites[0].__upstreamNames.join(',') === '上游A,上游B', 'merged upstream names should be preserved');

const distinctExt = mergeConfigs([
  sourced('上游A', ['上游A'], [{ ...base }]),
  sourced('上游B', ['上游B'], [{ ...base, ext: 'https://pan.example/other.json' }]),
]);
assert(distinctExt.config.sites.length === 2, 'different ext must not merge');

const distinctJar = mergeConfigs([
  sourced('上游A', ['上游A'], [{ ...base, jar: 'https://a.example/a.jar' }]),
  sourced('上游B', ['上游B'], [{ ...base, jar: 'https://b.example/b.jar' }]),
]);
assert(distinctJar.config.sites.length === 2, 'different jar must not merge');

const distinctPan = mergeConfigs([
  sourced('上游A', ['上游A'], [{ ...base, pan: 'quark' }]),
  sourced('上游B', ['上游B'], [{ ...base, pan: 'uc' }]),
]);
assert(distinctPan.config.sites.length === 2, 'different pan must not merge');

const distinctApi = mergeConfigs([
  sourced('上游A', ['上游A'], [{ ...base, api: 'csp_A' }]),
  sourced('上游B', ['上游B'], [{ ...base, api: 'csp_B' }]),
]);
assert(distinctApi.config.sites.length === 2, 'different api must not merge');

const distinctType = mergeConfigs([
  sourced('上游A', ['上游A'], [{ ...base, type: 1 }]),
  sourced('上游B', ['上游B'], [{ ...base, type: 3, jar: 'https://a.example/a.jar' }]),
]);
assert(distinctType.config.sites.length === 2, 'different type must not merge');

const extObjectReordered = mergeConfigs([
  sourced('上游A', ['上游A'], [{ ...base, ext: { z: 1, nested: { b: 2, a: 1 } } }]),
  sourced('上游B', ['上游B'], [{ ...base, ext: { nested: { a: 1, b: 2 }, z: 1 } }]),
]);
assert(extObjectReordered.config.sites.length === 1, 'same ext object content with different key order should merge');

const sameKeyDistinctExt = mergeConfigs([
  sourced('上游A', ['上游A'], [{ ...base, name: '玩偶哥哥 4K' }]),
  sourced('上游B', ['上游B'], [{ ...base, name: '玩偶哥哥4K', ext: 'https://pan.example/other.json' }]),
]);
assert(sameKeyDistinctExt.config.sites.length === 2, 'same key with different ext must remain distinct');
assert(new Set(sameKeyDistinctExt.config.sites.map((site) => site.ext)).size === 2, 'distinct ext instances must both survive');

const cfg = normalizeClientDistributionConfig({
  requireAuth: true,
  authCodes: [
    { code: 'code-a', sourceMode: 'search', maxSites: 2, includeGrades: ['excellent'] },
    { code: 'code-b', sourceMode: 'selected', maxSearchable: 5, siteTypes: ['xml', 'json'] },
  ],
});
assert(cfg.requireAuth === true, 'requireAuth should persist');
assert(Array.isArray(cfg.authCodes[0].selectedKeys) && cfg.authCodes[0].selectedKeys.length === 0, 'selectedKeys should normalize to an empty array');
const custom = normalizeClientDistributionConfig({ authCodes: [{ code: 'custom-a', sourceMode: 'custom', selectedKeys: ['  key-a  ', 'key-a', '', 'key-b'], pinnedKeys: ['key-b'] }] });
assert(custom.authCodes[0].sourceMode === 'custom', 'custom source mode should persist');
assert(custom.authCodes[0].selectedKeys.join(',') === 'key-a,key-b', 'selectedKeys should trim and deduplicate');
assert(custom.authCodes[0].pinnedKeys.join(',') === 'key-b', 'pinnedKeys should trim and deduplicate');
assert(custom.authCodes[0].maxSites === -1 && custom.authCodes[0].maxSearchable === -1, 'numeric limits should default to all');
assert(findClientAuthCode(cfg, 'code-a').sourceMode === 'search', 'code-a policy should persist');
assert(findClientAuthCode(cfg, 'code-a').bucketLimits.quality.excellent === -1, 'legacy grades should migrate into quality buckets');
assert(findClientAuthCode(cfg, 'code-b').maxSearchable === 5, 'code-b policy should persist');
assert(findClientAuthCode(cfg, 'code-b').bucketLimits.type.xml === -1 && findClientAuthCode(cfg, 'code-b').bucketLimits.type.json === -1, 'legacy site types should migrate into type buckets');
assert(!findClientAuthCode(cfg, 'missing'), 'unknown auth code must not resolve');
const migrated = normalizeClientDistributionConfig({
  authCodes: [{ code: 'legacy-types', siteTypes: [0, 1, 3, 4], bucketLimits: { type: { 3: 9 } } }],
});
assert(migrated.authCodes[0].siteTypes.length === 0, 'legacy siteTypes must be consumed during migration');
assert(migrated.authCodes[0].bucketLimits.type.jar === 9 && migrated.authCodes[0].bucketLimits.type.js === 9, 'legacy type 3 bucket must expand to JAR and JS');
const migratedOnly = normalizeClientDistributionConfig({
  authCodes: [{ code: 'legacy-only-types', siteTypes: [0, 1, 3, 4] }],
});
assert(migratedOnly.authCodes[0].siteTypes.length === 0, 'legacy-only siteTypes must be consumed');
assert(migratedOnly.authCodes[0].bucketLimits.type.xml === -1 && migratedOnly.authCodes[0].bucketLimits.type.json === -1 && migratedOnly.authCodes[0].bucketLimits.type.jar === -1 && migratedOnly.authCodes[0].bucketLimits.type.js === -1 && migratedOnly.authCodes[0].bucketLimits.type.remote === -1, 'legacy numeric site types must migrate to selected type buckets');

const threeState = normalizeClientDistributionConfig({
  authCodes: [{
    code: 'three-state',
    maxSites: 0,
    maxSearchable: -1,
    bucketLimits: {
      quality: { excellent: -1, good: 0, usable: 3, untestable: 100 },
      type: { xml: -1, json: 0, jar: 7, js: 7 },
    },
  }],
});
assert(threeState.authCodes[0].maxSites === 0, 'maxSites=0 must be preserved');
assert(threeState.authCodes[0].maxSearchable === -1, 'maxSearchable=-1 must be preserved');
assert(threeState.authCodes[0].bucketLimits.quality.excellent === -1, 'bucket -1 must be preserved');
assert(threeState.authCodes[0].bucketLimits.quality.good === 0, 'bucket 0 must be preserved');
assert(threeState.authCodes[0].bucketLimits.quality.usable === 3, 'bucket positive limit must be preserved');
assert(threeState.authCodes[0].bucketLimits.type.jar === 7, 'JAR bucket must be preserved');
assert(threeState.authCodes[0].bucketLimits.type.js === 7, 'JS bucket must be preserved');

(async () => {
  bundle('src/core/quality.ts', 'quality.cjs', 'true');
  const { runQualityGrading } = require(path.join(outDir, 'quality.cjs'));
  const persisted = new Map();
  const storage = {
    async get(key) { return persisted.has(key) ? persisted.get(key) : null; },
    async put(key, value) { persisted.set(key, String(value)); },
  };
  const probeMap = new Map([
    ['quality-key', { key: 'quality-key', result: 'ok', speedMs: 120, status: 200 }],
  ]);
  await runQualityGrading(storage, [{ key: 'quality-key', name: '质量池测试源', type: 0, api: 'https://quality.example/api', searchable: 1 }], { mode: 'full', probeMap, markRun: false });
  assert(persisted.has('search_quality_pool'), 'quality grading must persist the quality pool');
  assert(persisted.has('search_quality_candidates'), 'quality grading must persist candidate sites');
  const snapshot = JSON.parse(persisted.get('search_quality_pool'));
  assert(snapshot.entries[0].key === 'quality-key', 'persisted quality pool must contain graded site');
  assert(snapshot.entries[0].qualityScore > 900, 'fresh graded entries must use the unified score calculator');
  assert(snapshot.grades.serverVerifiedTotal === 1, 'server-verified count should include excellent/good/usable only');
  assert(snapshot.grades.clientFallbackTotal === 0, 'server-verifiable test must not create a client fallback');

  const legacyStorage = {
    async get(key) {
      if (key !== 'search_quality_pool') return null;
      return JSON.stringify({
        updatedAt: new Date().toISOString(),
        total: 2,
        entries: [
          { key: 'legacy-untestable', name: '旧客户端源', grade: 'credential-ready', speedMs: null, result: 'not_probed', consecutiveFailures: 0 },
          { key: 'legacy-good', name: '旧优质源', grade: 'good', speedMs: 1200, result: 'ok', consecutiveFailures: 0 },
        ],
      });
    },
    async put() {},
  };
  bundle('src/core/speedtest.ts', 'speedtest.cjs', 'true');
  const { isSiteProbeable } = require(path.join(outDir, 'speedtest.cjs'));
  assert(!isSiteProbeable({ key: 'js-http', type: 3, api: 'https://example.com/api', searchable: 1 }), 'type=3 HTTP runtime sources must not be treated as server-probeable');
  assert(isSiteProbeable({ key: 'json-http', type: 1, api: 'https://example.com/api', searchable: 1 }), 'type=1 HTTP API sources should remain server-probeable');

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('temporary upstream failure'); };
  const softJarData = new Map();
  const softJarStorage = {
    async get(key) { return softJarData.has(key) ? softJarData.get(key) : null; },
    async put(key, value) { softJarData.set(key, String(value)); },
  };
  await runQualityGrading(softJarStorage, [{ key: 'soft-jar', name: '临时不可探测 JAR', type: 3, api: 'csp_Soft', jar: 'https://jar.example/soft.jar', searchable: 1 }], { mode: 'full', markRun: false });
  const softJarSnapshot = JSON.parse(softJarData.get('search_quality_pool'));
  assert(softJarSnapshot.entries[0].grade === 'untestable', 'temporary server-side JAR probe failure must remain client-verifiable');
  global.fetch = async () => new Response('gone', { status: 503 });
  const hardJarData = new Map();
  const hardJarStorage = {
    async get(key) { return hardJarData.has(key) ? hardJarData.get(key) : null; },
    async put(key, value) { hardJarData.set(key, String(value)); },
  };
  await runQualityGrading(hardJarStorage, [{ key: 'hard-jar', name: '明确拒绝 JAR', type: 3, api: 'csp_Hard', jar: 'https://jar.example/hard.jar', searchable: 1 }], { mode: 'full', markRun: false });
  const hardJarSnapshot = JSON.parse(hardJarData.get('search_quality_pool'));
  assert(hardJarSnapshot.entries[0].grade === 'unusable', 'explicit HTTP rejection should mark a client JAR unusable');
  global.fetch = originalFetch;

  const { loadQualitySnapshot } = require(path.join(outDir, 'quality.cjs'));
  const legacy = await loadQualitySnapshot(legacyStorage);
  assert(legacy.grades.poolTotal === 2, 'legacy snapshots must rebuild the complete quality pool count');
  assert(legacy.grades.serverVerifiedTotal === 1, 'legacy snapshots must classify verified grades');
  assert(legacy.grades.clientFallbackTotal === 1, 'legacy credential-ready grade must migrate to client fallback');
  assert(legacy.entries[0].key === 'legacy-good', 'legacy snapshots must be deterministically re-sorted');
  console.log('regression: source merge and client auth policy checks passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
