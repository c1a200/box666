const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outfile = path.join(root, '.tmp-regression-build', 'live-source.cjs');

buildSync({
  entryPoints: [path.join(root, 'src/core/live-source.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
});

const {
  mergeLiveProxyManifest,
  isLiveProxyEntryDistributable,
} = require(outfile);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function entry(index, overrides = {}) {
  return {
    key: `key-${index}`,
    url: `https://live.example/${index}.txt`,
    name: `直播${index}`,
    health: 'healthy',
    consecutiveFailures: 0,
    checkedAt: '2026-10-13T00:00:00.000Z',
    successfulAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

const previous = Array.from({ length: 5 }, (_, index) => entry(index + 1));
const roundOne = mergeLiveProxyManifest(previous, previous, {
  checkedAt: '2026-10-13T00:01:00.000Z',
  validUrls: [previous[0].url, previous[1].url],
  transientUrls: [previous[2].url, previous[3].url, previous[4].url],
  invalidUrls: [],
});
const roundOneDistributable = roundOne.entries.filter(isLiveProxyEntryDistributable);
assert(roundOneDistributable.length === 5, '2 valid + 3 transient must keep all 5 distributable entries');
assert(roundOne.entries.slice(0, 2).every((item) => item.health === 'healthy'), 'healthy entries must sort first');
assert(roundOne.entries.slice(2).every((item) => item.health === 'unhealthy'), 'transient entries must remain fallback');

let repeatedInvalid = roundOne;
for (let round = 0; round < 3; round += 1) {
  repeatedInvalid = mergeLiveProxyManifest(
    repeatedInvalid,
    repeatedInvalid.entries.slice(0, 2).concat(repeatedInvalid.entries.slice(2).map((item) => ({ ...item }))),
    {
      checkedAt: `2026-10-13T00:0${round + 2}:00.000Z`,
      validUrls: [],
      transientUrls: [],
      invalidUrls: repeatedInvalid.entries.slice(2).map((item) => item.url),
    },
  );
}
assert(
  repeatedInvalid.entries.filter(isLiveProxyEntryDistributable).length === 2,
  'three consecutive invalid checks must remove the three unstable entries',
);

const migrated = mergeLiveProxyManifest(
  { version: 1, signature: 'old', entries: [{ key: 'legacy', url: 'https://legacy.example/live.txt' }] },
  [entry(9, { key: 'new', url: 'https://new.example/live.txt' })],
  { checkedAt: '2026-10-13T00:10:00.000Z', validUrls: ['https://new.example/live.txt'] },
);
assert(migrated.version === 2, 'v1 manifest must migrate to v2');
assert(migrated.entries.some((item) => item.key === 'new' && item.health === 'healthy'), 'new valid entry must be healthy');

const freshTransient = mergeLiveProxyManifest(null, [entry(10, { health: 'unhealthy', successfulAt: undefined })], {
  checkedAt: '2026-10-13T00:11:00.000Z',
  validUrls: [],
  transientUrls: ['https://live.example/10.txt'],
});
assert(freshTransient.entries.filter(isLiveProxyEntryDistributable).length === 0, 'new transient without a successful history must stay observational');

const runtimeCured = mergeLiveProxyManifest(roundOne, roundOne.entries, {
  checkedAt: '2026-10-13T00:20:00.000Z',
  validUrls: roundOne.entries.map((item) => item.url),
  transientUrls: [],
  invalidUrls: [],
});
assert(runtimeCured.entries.every((item) => item.health === 'healthy'), 'a later valid check must clear prior failures');

// v1 migration: old healthy entries were already distributed before upgrade,
// so their first transient round must still keep all five entries available.
const legacyPrevious = {
  version: 1,
  signature: 'legacy-v1',
  entries: previous.map(({ key, url, name }) => ({ key, url, name })),
};
const migratedFirstRound = mergeLiveProxyManifest(legacyPrevious, previous, {
  checkedAt: '2026-10-13T00:30:00.000Z',
  validUrls: [previous[0].url, previous[1].url],
  transientUrls: [previous[2].url, previous[3].url, previous[4].url],
  invalidUrls: [],
});
assert(
  migratedFirstRound.entries.filter(isLiveProxyEntryDistributable).length === 5,
  'v1 migrated entries must survive the first transient-only round',
);
console.log('regression: live manifest health checks passed');