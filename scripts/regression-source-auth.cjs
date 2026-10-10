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
    { code: 'code-b', sourceMode: 'selected', maxSearchable: 5, siteTypes: [0, 1] },
  ],
});
assert(cfg.requireAuth === true, 'requireAuth should persist');
assert(Array.isArray(cfg.authCodes[0].selectedKeys) && cfg.authCodes[0].selectedKeys.length === 0, 'selectedKeys should normalize to an empty array');
const custom = normalizeClientDistributionConfig({ authCodes: [{ code: 'custom-a', sourceMode: 'custom', selectedKeys: ['  key-a  ', 'key-a', '', 'key-b'], pinnedKeys: ['key-b'] }] });
assert(custom.authCodes[0].sourceMode === 'custom', 'custom source mode should persist');
assert(custom.authCodes[0].selectedKeys.join(',') === 'key-a,key-b', 'selectedKeys should trim and deduplicate');
assert(custom.authCodes[0].pinnedKeys.join(',') === 'key-b', 'pinnedKeys should trim and deduplicate');
assert(custom.authCodes[0].maxSites === 0 && custom.authCodes[0].maxSearchable === 0, 'numeric limits should default safely');
assert(findClientAuthCode(cfg, 'code-a').sourceMode === 'search', 'code-a policy should persist');
assert(findClientAuthCode(cfg, 'code-b').maxSearchable === 5, 'code-b policy should persist');
assert(!findClientAuthCode(cfg, 'missing'), 'unknown auth code must not resolve');

console.log('regression: source merge and client auth policy checks passed');
