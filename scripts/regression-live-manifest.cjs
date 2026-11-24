const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outfile = path.join(root, '.tmp-regression-build', 'live-source.cjs');
const qualityOutfile = path.join(root, '.tmp-regression-build', 'live-quality.cjs');
const prepareOutfile = path.join(root, '.tmp-regression-build', 'live-prepare.cjs');
const inputsOutfile = path.join(root, '.tmp-regression-build', 'live-inputs.cjs');
const mergerOutfile = path.join(root, '.tmp-regression-build', 'live-merger.cjs');
const outputOutfile = path.join(root, '.tmp-regression-build', 'live-output.cjs');

buildSync({
  entryPoints: [path.join(root, 'src/core/live-source.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
});

buildSync({
  entryPoints: [path.join(root, 'src/core/live-quality.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: qualityOutfile,
});

const {
  liveProxyKey,
  mergeLiveProxyManifest,
  isLiveProxyEntryDistributable,
  LIVE_PROXY_FAILURE_RULE_VERSION,
} = require(outfile);

buildSync({
  entryPoints: [path.join(root, 'src/core/live-prepare.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: prepareOutfile,
});

const {
  buildPreparedLiveGroups,
  livePrepareStateMatchesInputs,
  prepareLiveSourcesChunk,
  runLivePrepareChunk,
  serializePreparedLiveGroups,
} = require(prepareOutfile);

buildSync({
  entryPoints: [path.join(root, 'src/core/live-merger.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: mergerOutfile,
});
buildSync({
  entryPoints: [path.join(root, 'src/core/live-inputs.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: inputsOutfile,
});

buildSync({
  entryPoints: [path.join(root, 'src/core/live-output.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: outputOutfile,
});

const {
  computeLiveOutputFingerprint,
} = require(outputOutfile);

const {
  filterLiveSourcesDetailed: filterLiveSourcesDetailedForRegression,
  filterLivesBySourceDetailed: filterLivesBySourceDetailedForRegression,
} = require(mergerOutfile);

const {
  selectLiveDistribution,
  normalizeLiveDistributionPolicy,
  compareLiveRank,
  partitionMergeSourceMetrics,
} = require(qualityOutfile);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Must match CHANNEL_PROBE_RESULT_VERSION. Keeping fixtures on the current
// version makes a probe-evidence rule change fail loudly until tests migrate.
const CURRENT_PROBE_VERSION = 7;

function countTxtChannelUrls(txt, channelName) {
  let total = 0;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    const comma = line.indexOf(',');
    if (comma <= 0 || line.slice(comma + 1).trim() === '#genre#') continue;
    if (line.slice(0, comma).trim() !== channelName) continue;
    total += line.slice(comma + 1).split('#').filter(Boolean).length;
  }
  return total;
}

function entry(index, overrides = {}) {
  return {
    key: 'key-' + index,
    url: 'https://live.example/' + index + '.txt',
    name: '直播' + index,
    health: 'healthy',
    consecutiveFailures: 0,
    checkedAt: '2026-10-13T00:00:00.000Z',
    successfulAt: '2026-10-13T00:00:00.000Z',
    textReady: true,
    ...overrides,
  };
}

// ── 1. 基础健康池：valid + transient 都保留，valid 排前面 ──
const previous = Array.from({ length: 5 }, (_, index) => entry(index + 1));
const roundOne = mergeLiveProxyManifest({ version: 3, signature: 'seed', entries: previous }, previous, {
  checkedAt: '2026-10-13T00:01:00.000Z',
  validUrls: [previous[0].url, previous[1].url],
  transientUrls: [previous[2].url, previous[3].url, previous[4].url],
  invalidUrls: [],
});
const roundOneDistributable = roundOne.entries.filter(isLiveProxyEntryDistributable);
assert(roundOneDistributable.length === 5, '2 valid + 3 transient must keep all 5 distributable entries');
assert(roundOne.entries.slice(0, 2).every((item) => item.health === 'healthy'), 'healthy entries must sort first');
assert(roundOne.entries.slice(2).every((item) => item.health === 'unhealthy'), 'transient entries must remain fallback');

// ── 2. 连续三次 invalid 才彻底移除 ──
let repeatedInvalid = roundOne;
for (let round = 0; round < 3; round += 1) {
  repeatedInvalid = mergeLiveProxyManifest(
    repeatedInvalid,
    repeatedInvalid.entries.slice(0, 2).concat(repeatedInvalid.entries.slice(2).map((item) => ({ ...item }))),
    {
      checkedAt: '2026-10-13T00:0' + (round + 2) + ':00.000Z',
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

// ── 3. v1 迁移到 v3 ──
const migrated = mergeLiveProxyManifest(
  { version: 1, signature: 'old', entries: [{ key: 'legacy', url: 'https://legacy.example/live.txt' }] },
  [entry(9, { key: 'new', url: 'https://new.example/live.txt' })],
  { checkedAt: '2026-10-13T00:10:00.000Z', validUrls: ['https://new.example/live.txt'] },
);
assert(migrated.version === 5, 'v1 manifest must migrate to v5');
assert(migrated.entries.some((item) => item.key === 'new' && item.health === 'healthy'), 'new valid entry must be healthy');

// ── 4. 未验证/transient 也可进入质量池（只是排序靠后）──
const freshTransient = mergeLiveProxyManifest(null, [entry(10, {
  health: 'unhealthy',
  successfulAt: undefined,
  textReady: false,
})], {
  checkedAt: '2026-10-13T00:11:00.000Z',
  validUrls: [],
  transientUrls: ['https://live.example/10.txt'],
});
assert(freshTransient.entries.filter(isLiveProxyEntryDistributable).length === 0, 'transient without history or prebuilt text must stay out of the delivery pool');
assert(freshTransient.entries[0].lastFailure === 'transient', 'transient failure reason must be recorded');

// ── 4b. 旧规则 invalid 是历史误判，迁移为 transient 且不计入三次淘汰 ──
const migratedLegacyInvalid = mergeLiveProxyManifest(
  {
    version: 4,
    signature: 'legacy-invalid',
    entries: [entry(11, {
      health: 'unhealthy',
      consecutiveFailures: 3,
      lastFailure: 'invalid',
    })],
  },
  [],
  { checkedAt: '2026-10-13T00:12:00.000Z', validUrls: [] },
);
const legacyInvalidEntry = migratedLegacyInvalid.entries.find((item) => item.key === 'key-11');
assert(legacyInvalidEntry?.lastFailure === 'transient',
  'legacy invalid without a failure rule version must be retried as transient');
assert(legacyInvalidEntry?.failureRuleVersion === LIVE_PROXY_FAILURE_RULE_VERSION,
  'migrated failure evidence must be stamped with the current rule version');
assert(legacyInvalidEntry?.consecutiveFailures === 0,
  'legacy invalid failure counts must not survive the rule migration');
assert(isLiveProxyEntryDistributable(legacyInvalidEntry),
  'a migrated legacy invalid with mature text must re-enter the delivery pool');

// ── 5. 之后 valid 会清除失败历史 ──
const runtimeCured = mergeLiveProxyManifest(roundOne, roundOne.entries, {
  checkedAt: '2026-10-13T00:20:00.000Z',
  validUrls: roundOne.entries.map((item) => item.url),
  transientUrls: [],
  invalidUrls: [],
});
assert(runtimeCured.entries.every((item) => item.health === 'healthy'), 'a later valid check must clear prior failures');

// ── 6. v1 老数据首轮 transient 仍全量可见 ──
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

// ── 7. 下发选择：排名、TopN、屏蔽、置顶 ──
function ranked(index, overrides = {}) {
  return {
    key: 'k' + index,
    url: 'https://live.example/r' + index + '.txt',
    category: 'cctv',
    qualityScore: 100 - index,
    health: 'healthy',
    everSucceeded: true,
    successfulAt: '2026-10-13T00:00:00.000Z',
    textReady: true,
    ...overrides,
  };
}
const pool = [ranked(1), ranked(2), ranked(3), ranked(4), ranked(5)];

assert(selectLiveDistribution(pool, { selectionMode: 'simple', maxSources: -1 }).length === 5, 'simple -1 must deliver the full quality pool');
assert(selectLiveDistribution(pool, { selectionMode: 'simple', maxSources: 0 }).length === 0, 'simple 0 must deliver nothing');
const topTwo = selectLiveDistribution(pool, { selectionMode: 'simple', maxSources: 2 });
assert(topTwo.length === 2 && topTwo[0].key === 'k1' && topTwo[1].key === 'k2', 'simple TopN must take the highest ranked entries');

const invalidPool = [ranked(1), ranked(2, { lastFailure: 'invalid' }), ranked(3)];
assert(selectLiveDistribution(invalidPool, { selectionMode: 'simple', maxSources: -1 }).every((e) => e.key !== 'k2'), 'invalid entries must be excluded entirely');

const blockedPool = selectLiveDistribution(pool, { selectionMode: 'simple', maxSources: -1, blockedKeys: ['k2'] });
assert(blockedPool.length === 4 && blockedPool.every((e) => e.key !== 'k2'), 'blocked entries must be excluded from delivery');

const pinnedSelected = selectLiveDistribution(pool, { selectionMode: 'simple', maxSources: 3, pinnedKeys: ['k3', 'k9'] });
assert(pinnedSelected[0].key === 'k3', 'pinned entry inside selection must move to front');
assert(pinnedSelected.length === 3, 'pinning must not grow the delivered set');
assert(pinnedSelected.every((e) => e.key !== 'k9'), 'pinning an out-of-selection entry must not bypass the quota gate');

const pinnedBlocked = selectLiveDistribution(pool, { selectionMode: 'simple', maxSources: 3, pinnedKeys: ['k2'], blockedKeys: ['k2'] });
assert(pinnedBlocked.every((e) => e.key !== 'k2'), 'blocking must win over pinning');

const pinnedSlot = selectLiveDistribution(pool, { selectionMode: 'simple', maxSources: 1, pinnedKeys: ['k5'] });
assert(pinnedSlot.length === 1 && pinnedSlot[0].key === 'k5', 'global pin must occupy a simple-mode slot, got ' + pinnedSlot.map((e) => e.key).join(','));

// ── 8. 分类模式：每个分类独立取 TopN ──
const catPool = [
  ranked(1, { category: 'cctv', qualityScore: 95 }),
  ranked(2, { category: 'cctv', qualityScore: 90 }),
  ranked(3, { category: 'cctv', qualityScore: 85 }),
  ranked(4, { category: 'satellite', qualityScore: 80 }),
  ranked(5, { category: 'satellite', qualityScore: 70 }),
  ranked(6, { category: 'local', qualityScore: 60 }),
];
const categoryPicked = selectLiveDistribution(catPool, { selectionMode: 'category', maxSources: -1, bucketLimits: { cctv: 2, satellite: 1, local: 0 } });
const keys = categoryPicked.map((e) => e.key).sort();
assert(JSON.stringify(keys) === JSON.stringify(['k1', 'k2', 'k4']), 'category mode must take per-category TopN and honour zero buckets, got ' + keys.join(','));
assert(selectLiveDistribution(catPool, { selectionMode: 'category', maxSources: 1, bucketLimits: {} }).length === 6, 'category mode without limits must deliver every category fully');

const categoryPinIgnored = selectLiveDistribution(catPool, { selectionMode: 'simple', maxSources: 1, categoryPinnedKeys: ['k3'] });
assert(categoryPinIgnored.length === 1 && categoryPinIgnored[0].key === 'k1', 'simple mode must ignore category pins, got ' + categoryPinIgnored.map((e) => e.key).join(','));

const categoryPinSlot = selectLiveDistribution(catPool, {
  selectionMode: 'category',
  maxSources: -1,
  bucketLimits: { cctv: 1 },
  categoryPinnedKeys: ['k3'],
});
assert(categoryPinSlot.filter((e) => e.category === 'cctv').map((e) => e.key).join(',') === 'k3', 'category pin must occupy its own category slot, got ' + categoryPinSlot.map((e) => e.key).join(','));

const categoryPinKeepsCategoryPriority = selectLiveDistribution(catPool, {
  selectionMode: 'category',
  maxSources: -1,
  bucketLimits: { cctv: 1, satellite: 1 },
  categoryPinnedKeys: ['k5'],
});
assert(
  categoryPinKeepsCategoryPriority.map((e) => e.key).join(',') === 'k1,k5,k6',
  'category pin must not break category priority, got ' + categoryPinKeepsCategoryPriority.map((e) => e.key).join(','),
);

const globalPinBreaksCategoryPriority = selectLiveDistribution(catPool, {
  selectionMode: 'category',
  maxSources: -1,
  bucketLimits: { cctv: 1, satellite: 1, local: 1 },
  pinnedKeys: ['k6'],
});
assert(
  globalPinBreaksCategoryPriority.map((e) => e.key).join(',') === 'k6,k1,k4',
  'global pin must break category priority while still taking its own category slot, got ' + globalPinBreaksCategoryPriority.map((e) => e.key).join(','),
);

const globalAndCategoryPinOrder = selectLiveDistribution(catPool, {
  selectionMode: 'category',
  maxSources: -1,
  bucketLimits: { cctv: 2, satellite: 1, local: 1 },
  pinnedKeys: ['k6', 'k1'],
  categoryPinnedKeys: ['k3', 'k2'],
});
assert(
  globalAndCategoryPinOrder.map((e) => e.key).join(',') === 'k6,k1,k3,k4',
  'global pins then category pins must preserve saved order, got ' + globalAndCategoryPinOrder.map((e) => e.key).join(','),
);

const zeroBucketPinsIgnored = selectLiveDistribution(catPool, {
  selectionMode: 'category',
  maxSources: -1,
  bucketLimits: { cctv: 1, satellite: 0, local: 0 },
  pinnedKeys: ['k6'],
  categoryPinnedKeys: ['k5'],
});
assert(
  zeroBucketPinsIgnored.map((e) => e.key).join(',') === 'k1',
  'zero-limit buckets must reject both global and category pins, got ' + zeroBucketPinsIgnored.map((e) => e.key).join(','),
);

const categoryPinBlocked = selectLiveDistribution(catPool, {
  selectionMode: 'category',
  maxSources: -1,
  bucketLimits: { cctv: 1 },
  categoryPinnedKeys: ['k3'],
  blockedKeys: ['k3'],
});
assert(categoryPinBlocked.filter((e) => e.category === 'cctv').map((e) => e.key).join(',') === 'k1', 'blocking must win over category pinning, got ' + categoryPinBlocked.map((e) => e.key).join(','));

// ── 9. 稳定排序：同分不打乱 ──
const tieA = [ranked(1, { qualityScore: 50 }), ranked(2, { qualityScore: 50 })];
const sortedTie = tieA.slice().sort(compareLiveRank).map((e) => e.key);
assert(JSON.stringify(sortedTie) === JSON.stringify(['k1', 'k2']), 'equal scores must fall back to key order');

// ── 10. 策略规范化容错 ──
const normalized = normalizeLiveDistributionPolicy({ maxSources: '3', blockedKeys: ['x', 'x', ''] });
assert(normalized.maxSources === 3, 'string maxSources must normalize to a number');
assert(JSON.stringify(normalized.blockedKeys) === JSON.stringify(['x']), 'blockedKeys must be de-duplicated');
assert(normalizeLiveDistributionPolicy({ maxSources: -5 }).maxSources === -1, 'illegal maxSources must fall back to -1');
assert(normalizeLiveDistributionPolicy({}).maxUrlsPerChannel === 9, 'missing per-channel URL limit must preserve the legacy merged default');
assert(normalizeLiveDistributionPolicy({ maxUrlsPerChannel: '12' }).maxUrlsPerChannel === 12, 'string per-channel URL limit must normalize to a number');
assert(normalizeLiveDistributionPolicy({ maxUrlsPerChannel: -1 }).maxUrlsPerChannel === -1, 'per-channel URL limit -1 must mean all lines');
assert(normalizeLiveDistributionPolicy({ maxUrlsPerChannel: 0 }).maxUrlsPerChannel === 9, 'illegal per-channel URL limit must fall back to 9');

// ── 11. 可用性分层优先于历史高分：本轮健康源必须压过历史后备源 ──
const availabilityTierPool = [
  ranked(1, { health: 'healthy', qualityScore: 40, successfulAt: '2026-10-13T00:00:00.000Z' }),
  ranked(2, { health: 'unhealthy', qualityScore: 100, everSucceeded: true, lastFailure: 'transient' }),
  ranked(3, { health: 'unhealthy', qualityScore: 100, everSucceeded: false, lastFailure: undefined }),
];
const availabilityOrdered = availabilityTierPool.slice().sort(compareLiveRank).map((e) => e.key);
assert(availabilityOrdered[0] === 'k1', 'current healthy source must outrank historical high-score fallback, got ' + availabilityOrdered.join(','));
assert(availabilityOrdered[1] === 'k2' && availabilityOrdered[2] === 'k3', 'historical succeeded fallback must outrank never-verified source, got ' + availabilityOrdered.join(','));

// ── 12. 完整质量池：全选不截断，invalid/blocked 仍被排除 ──
const fullPool = [
  ranked(1, { category: 'cctv' }),
  ranked(2, { category: 'satellite' }),
  ranked(3, { category: 'local' }),
  ranked(4, { category: 'variety' }),
  ranked(5, { category: 'special' }),
  ranked(6, { category: 'ipv6' }),
  ranked(7, { category: 'other' }),
  ranked(8, { category: 'other', lastFailure: 'invalid' }),
];
const fullSelection = selectLiveDistribution(fullPool, { selectionMode: 'simple', maxSources: -1, blockedKeys: ['k3'] });
assert(fullSelection.length === 6, 'simple full selection must keep every quality-pool entry except invalid/blocked, got ' + fullSelection.length);
assert(fullSelection.every((e) => e.lastFailure !== 'invalid' && e.key !== 'k3'), 'invalid and blocked sources must never leak into full selection');

// ── 13. 分类全选/限制：每个分类按自己的排名取真实 TopN ──
const categoryFull = selectLiveDistribution(fullPool, { selectionMode: 'category', maxSources: -1, bucketLimits: {} });
assert(categoryFull.length === 7, 'category mode without limits must keep full quality pool minus invalid, got ' + categoryFull.length);
const categoryTop = selectLiveDistribution(fullPool, { selectionMode: 'category', maxSources: -1, bucketLimits: { other: 1 } });
assert(categoryTop.filter((e) => e.category === 'other').map((e) => e.key).join(',') === 'k7', 'per-category TopN must use that category rank, got ' + categoryTop.map((e) => e.key).join(','));

// ── 14. 同 URL 不同标签：按 key 精确屏蔽，不能被同名源绕过 ──
const duplicateLabelPool = [
  ranked(1, { key: 'same-url-a', url: 'https://live.example/same.txt', name: '同名源' }),
  ranked(2, { key: 'same-url-b', url: 'https://live.example/same.txt', name: '同名源' }),
];
const duplicateBlocked = selectLiveDistribution(duplicateLabelPool, { selectionMode: 'simple', maxSources: -1, blockedKeys: ['same-url-a'] });
assert(duplicateBlocked.length === 1 && duplicateBlocked[0].key === 'same-url-b', 'blocking one duplicate URL key must not remove the other distinct manifest entry');

// ── 15. 聚合度量分流：确定性 invalid 绝不混入 transient（Render 聚合快照路径）──
const partitioned = partitionMergeSourceMetrics({
  'https://live.example/ok.txt': { health: 'healthy', everSucceeded: true },
  'https://live.example/timeout.txt': { health: 'unhealthy', lastFailure: 'transient' },
  'https://live.example/never.txt': { health: 'unhealthy' },
  'https://live.example/gone.txt': { health: 'unhealthy', lastFailure: 'invalid' },
});
assert(JSON.stringify(partitioned.validUrls) === JSON.stringify(['https://live.example/ok.txt']), 'partition must route healthy urls to valid');
assert(
  JSON.stringify(partitioned.invalidUrls) === JSON.stringify(['https://live.example/gone.txt']),
  'partition must route deterministic invalid urls to invalid (not transient), got ' + partitioned.invalidUrls.join(','),
);
assert(
  JSON.stringify(partitioned.transientUrls.sort()) ===
    JSON.stringify(['https://live.example/never.txt', 'https://live.example/timeout.txt'].sort()),
  'partition must route transient + never-verified urls to transient, got ' + partitioned.transientUrls.join(','),
);

// ── 16. 聚合快照写入：invalid 经 manifest 合并后仍为 invalid，连续三次淘汰 ──
const snapshotEntries = [
  entry(20, { key: 'b-ok', url: 'https://live.example/ok.txt' }),
  entry(21, { key: 'b-bad', url: 'https://live.example/gone.txt', health: 'unhealthy' }),
];
let snapshotManifest = null;
const snapshotMetrics = {
  'https://live.example/ok.txt': { health: 'healthy', everSucceeded: true },
  'https://live.example/gone.txt': { health: 'unhealthy', lastFailure: 'invalid', everSucceeded: false },
};
const snapshotPartition = partitionMergeSourceMetrics(snapshotMetrics);
for (let round = 0; round < 3; round += 1) {
  snapshotManifest = mergeLiveProxyManifest(snapshotManifest, snapshotEntries, {
    checkedAt: '2026-10-13T01:0' + round + ':00.000Z',
    validUrls: snapshotPartition.validUrls,
    transientUrls: snapshotPartition.transientUrls,
    invalidUrls: snapshotPartition.invalidUrls,
    metrics: snapshotMetrics,
    fullSnapshot: true,
  });
}
assert(
  snapshotManifest.entries.find((item) => item.key === 'b-bad') === undefined,
  'explicit invalid source must be evicted after three snapshot rounds, not resurrected by transient override',
);
assert(
  snapshotManifest.entries.some((item) => item.key === 'b-ok' && item.health === 'healthy'),
  'healthy source must survive snapshot rounds',
);

// ── 16.5 文本权威更新：完整快照丢失文本必须 fail-closed ──
const readyPrevious = mergeLiveProxyManifest(null, [entry(25)], {
  checkedAt: '2026-10-13T01:10:00.000Z',
  validUrls: ['https://live.example/25.txt'],
});
assert(readyPrevious.entries[0].textReady === true, 'seed manifest must be text-ready');
const missingTextSnapshot = mergeLiveProxyManifest(
  readyPrevious,
  readyPrevious.entries.map((item) => ({ ...item, textReady: undefined })),
  {
    checkedAt: '2026-10-13T01:11:00.000Z',
    validUrls: ['https://live.example/25.txt'],
    fullSnapshot: true,
  },
);
assert(missingTextSnapshot.entries[0].textReady === false, 'full snapshot without text must revoke textReady');
assert(isLiveProxyEntryDistributable(missingTextSnapshot.entries[0]) === false, 'revoked text must not be distributable');
const explicitUnavailable = mergeLiveProxyManifest(
  readyPrevious,
  readyPrevious.entries.map((item) => ({ ...item, textReady: false })),
  {
    checkedAt: '2026-10-13T01:12:00.000Z',
    validUrls: ['https://live.example/25.txt'],
    texts: {},
  },
);
assert(explicitUnavailable.entries[0].textReady === false, 'explicit missing text must override prior ready flag');
// ── 17. 陈旧缓存兜底：仍可下发，但排到当前健康源之后 ──
// 陈旧缓存兜底的真实形态：health=unhealthy + lastFailure=transient + 有成功历史。
// 故意给更高的 qualityScore，验证可用性分层优先于历史高分。
const staleBackup = ranked(30, { key: 'stale', health: 'unhealthy', qualityScore: 99, lastFailure: 'transient', everSucceeded: true });
// 质量池在进入下发选择前必须先按统一口径排序（生产链路即如此）。
const stalePool = [staleBackup, ranked(31, { key: 'fresh' })];
stalePool.sort(compareLiveRank);
const staleSelected = selectLiveDistribution(stalePool, { selectionMode: 'simple', maxSources: -1 });
assert(staleSelected.length === 2, 'stale cache fallback must remain distributable');
assert(staleSelected[0].key === 'fresh', 'current healthy source must outrank stale cache fallback, got ' + staleSelected.map((e) => e.key).join(','));


// merged source labels: exact label, legacy hash fallback, same-name isolation
const liveMergerOutfile = path.join(root, '.tmp-regression-build', 'live-merger.cjs');
buildSync({
  entryPoints: [path.join(root, 'src/core/live-merger.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: liveMergerOutfile,
});
const {
  liveProxyEntryLabel,
  prepareManifestEntries,
} = require(outfile);
const {
  AGGREGATED_MAX_URLS_PER_CHANNEL,
  applyChannelSpeedToGroups,
  extractAllUrls,
  extractPreferredLiveUrls,
  extractCoverageTopUpLiveUrls,
  extractUrlsForSourceLabels,
  filterGroupsBySourceLabels,
  mergeLiveCandidateTreeSources,
  parseLiveCandidatePool,
  formatAggregatedLiveGroupsAsTxt,
  parseLiveGroupsFromTxt,
  reorderGroupsBySourcePriority,
  serializeLiveCandidatePool,
  normalizeSourceLabelKey,
} = require(liveMergerOutfile);

const mergedGroups = [
  {
    group: '央视',
    channels: [
      {
        name: 'CCTV-1',
        urls: [
          'http://a.example/cctv1$源A#aaaaaaaa',
          'http://b.example/cctv1$源B#bbbbbbbb',
          'http://c.example/cctv1$源A#aaaaaaaa',
        ],
      },
    ],
  },
  {
    group: '卫视',
    channels: [
      { name: '湖南卫视', urls: ['http://b.example/hunan$源B#bbbbbbbb'] },
    ],
  },
];

const explicitEntry = Object.assign({}, entry(40), { key: 'aaaaaaaa1234', name: '源A', label: '源A#aaaaaaaa' });
assert(liveProxyEntryLabel(explicitEntry, mergedGroups) === '源A#aaaaaaaa', 'explicit manifest label must win');
const explicitSelected = new Set([normalizeSourceLabelKey(liveProxyEntryLabel(explicitEntry, mergedGroups))]);
const explicitFiltered = filterGroupsBySourceLabels(mergedGroups, explicitSelected, false);
assert(explicitFiltered.length === 1, 'explicit label must retain matching groups');
assert(explicitFiltered[0].channels[0].urls.length === 2, 'explicit label must keep all matching lines');
assert(explicitFiltered[0].channels[0].urls.every((url) => url.endsWith('源A#aaaaaaaa')), 'unselected source B must not leak');

const legacyEntry = Object.assign({}, entry(41), { key: 'bbbbbbbbffff', name: '任意名字', label: undefined });
assert(liveProxyEntryLabel(legacyEntry, mergedGroups) === '源B#bbbbbbbb', 'legacy key hash must resolve output label');
const legacySelected = new Set([normalizeSourceLabelKey(liveProxyEntryLabel(legacyEntry, mergedGroups))]);
const legacyFiltered = filterGroupsBySourceLabels(mergedGroups, legacySelected, false);
assert(legacyFiltered.length === 2, 'legacy hash fallback must retain selected source across groups');
assert(legacyFiltered.every((group) => group.channels.every((channel) => channel.urls.every((url) => url.endsWith('源B#bbbbbbbb')))), 'legacy hash fallback must not retain unselected source');

const sameNameGroups = [
  {
    group: '测试',
    channels: [
      { name: '频道', urls: ['http://one.example/live$同名源#11111111', 'http://two.example/live$同名源#22222222'] },
    ],
  },
];
const sameNameEntry = Object.assign({}, entry(42), { key: '22222222deadbeef', name: '同名源', label: undefined });
const sameNameLabel = liveProxyEntryLabel(sameNameEntry, sameNameGroups);
assert(sameNameLabel === '同名源#22222222', 'same-name different-hash source must resolve by hash');
const sameNameFiltered = filterGroupsBySourceLabels(sameNameGroups, new Set([normalizeSourceLabelKey(sameNameLabel)]), false);
assert(sameNameFiltered[0].channels[0].urls.length === 1, 'same-name different-hash must retain only the matching source');
assert(sameNameFiltered[0].channels[0].urls[0].includes('22222222'), 'same-name different-hash must keep the correct line');

const priorityGroups = [
  { group: '央视', channels: [{ name: 'CCTV-2', urls: ['http://low.example$低质#33333333', 'http://high.example$优质#44444444'] }] },
];
const priorityResult = reorderGroupsBySourcePriority(priorityGroups, ['优质#44444444', '低质#33333333']);
assert(priorityResult[0].channels[0].urls[0].includes('优质#44444444'), 'higher-ranked source must be first line after filtering');

// 精确标签提取：只允许本次实际选择的源进入优先测速集合。
const extractedPriority = extractUrlsForSourceLabels(
  mergedGroups,
  new Set([normalizeSourceLabelKey('源A#aaaaaaaa')]),
);
assert(extractedPriority.length === 2, 'priority extraction must return unique bare URLs for selected label only');
assert(extractedPriority.every((url) => url === 'http://a.example/cctv1' || url === 'http://c.example/cctv1'), 'priority extraction must not leak unselected labels');
assert(extractUrlsForSourceLabels(mergedGroups, new Set()).length === 0, 'empty selected-label set must produce no priority URLs');
const hashLabeledGroups = [{
  group: '央视',
  channels: [{
    name: 'CCTV-HashLabel',
    urls: ['http://a.example/cctv1#源A#aaaaaaaa', 'http://b.example/cctv1#源B#bbbbbbbb'],
  }],
}];
assert(
  extractUrlsForSourceLabels(hashLabeledGroups, new Set([normalizeSourceLabelKey('源A#aaaaaaaa')])).length === 1,
  'runtime #source-label form must be parsed without treating the whole hash as a bare URL',
);

// 频道级最终下发：只允许当前版本已验真线路，未知/TCP/失败线路不得凑数。
const speedGroups = [{
  group: '央视',
  channels: [{
    name: 'CCTV-Test',
    urls: [
      'http://unknown.example/live#源U#ffffffff',
      'http://slow.example/live#源S#11111111',
      'http://failed.example/live#源F#22222222',
      'http://fast.example/live#源Q#33333333',
    ],
  }],
}];
const speedMap = {
  'http://slow.example/live': { speedMs: 1800, probedAt: '2026-10-13T00:00:00.000Z', kind: 'm3u8', verification: 'manifest', probeVersion: CURRENT_PROBE_VERSION },
  'http://failed.example/live': { speedMs: 0, probedAt: '2026-10-13T00:00:00.000Z', kind: 'fail', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 2 },
  'http://fast.example/live': { speedMs: 120, probedAt: '2026-10-13T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
};
const speedApplied = applyChannelSpeedToGroups(speedGroups, speedMap, 5000, AGGREGATED_MAX_URLS_PER_CHANNEL);
assert(speedApplied[0].channels[0].urls.length === 1, 'final output must use only the highest available playback-evidence tier');
assert(speedApplied[0].channels[0].urls[0].includes('fast.example'), 'media-verified line must rank first');
assert(!speedApplied[0].channels[0].urls.some((url) => url.includes('slow.example')), 'manifest line must not be mixed into a media-verified output');
assert(!speedApplied[0].channels[0].urls.some((url) => url.includes('unknown.example')), 'unknown line must never be distributed');
assert(!speedApplied[0].channels[0].urls.some((url) => url.includes('failed.example')), 'failed line must never be distributed');

const candidateFallback = applyChannelSpeedToGroups(
  speedGroups,
  speedMap,
  5000,
  AGGREGATED_MAX_URLS_PER_CHANNEL,
  { requirePlaybackVerification: false },
);
assert(candidateFallback[0].channels[0].urls.some((url) => url.includes('unknown.example')), 'candidate mode must retain unknown URLs for future probing');
assert(candidateFallback[0].channels[0].urls.some((url) => url.includes('failed.example')), 'candidate mode may retain transient failures only for probing');

const threeTransientFailures = applyChannelSpeedToGroups(speedGroups, {
  'http://failed.example/live': { speedMs: 0, probedAt: '2026-10-13T00:00:00.000Z', kind: 'fail', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 3 },
}, 5000, AGGREGATED_MAX_URLS_PER_CHANNEL);
assert(threeTransientFailures.length === 1
  && threeTransientFailures[0].channels[0].urls[0].includes('failed.example'),
  'three transient failures without invalid evidence must remain available as fallback');
const recovered = applyChannelSpeedToGroups(speedGroups, {
  'http://failed.example/live': { speedMs: 80, probedAt: '2026-10-13T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
}, 5000, AGGREGATED_MAX_URLS_PER_CHANNEL);
assert(recovered[0].channels[0].urls.length === 1 && recovered[0].channels[0].urls[0].includes('failed.example'), 'a media-verified probe must immediately restore only that line');

const manyLineUrls = Array.from({ length: AGGREGATED_MAX_URLS_PER_CHANNEL + 4 }, (_, i) => 'http://line' + i + '.example/live#abc' + i);
const manyLines = [{ group: '测试', channels: [{ name: '限量', urls: manyLineUrls }] }];
const manyLineSpeedMap = Object.fromEntries(manyLineUrls.map((url, i) => [
  url,
  { speedMs: 100 + i, probedAt: '2026-10-13T00:00:00.000Z', kind: 'm3u8', verification: 'manifest', probeVersion: CURRENT_PROBE_VERSION },
]));
const limitedLines = applyChannelSpeedToGroups(manyLines, manyLineSpeedMap, 5000, AGGREGATED_MAX_URLS_PER_CHANNEL);
assert(limitedLines[0].channels[0].urls.length === AGGREGATED_MAX_URLS_PER_CHANNEL, 'merged output must cap each channel at AGGREGATED_MAX_URLS_PER_CHANNEL');

const perChannelLines = [{
  group: '测试',
  channels: [
    { name: '频道甲', urls: ['http://a1.example/live', 'http://a2.example/live', 'http://a3.example/live', 'http://a4.example/live'] },
    { name: '频道乙', urls: ['http://b1.example/live', 'http://b2.example/live', 'http://b3.example/live', 'http://b4.example/live'] },
  ],
}];
const perChannelSpeedMap = Object.fromEntries(perChannelLines[0].channels.flatMap((channel) =>
  channel.urls.map((url, i) => [url, { speedMs: 100 + i, probedAt: '2026-10-13T00:00:00.000Z', kind: 'm3u8', verification: 'manifest', probeVersion: CURRENT_PROBE_VERSION }]),
));
const twoLinesPerChannel = applyChannelSpeedToGroups(perChannelLines, perChannelSpeedMap, 5000, 2);
assert(twoLinesPerChannel[0].channels.every((channel) => channel.urls.length === 2), 'per-channel limits must be counted independently for every channel');
assert(twoLinesPerChannel[0].channels[0].urls.join(',') === 'http://a1.example/live,http://a2.example/live', 'per-channel limit must preserve quality order within each channel');
assert(twoLinesPerChannel[0].channels[1].urls.join(',') === 'http://b1.example/live,http://b2.example/live', 'per-channel limit must not consume a global shared quota');
const allLinesPerChannel = applyChannelSpeedToGroups(perChannelLines, perChannelSpeedMap, 5000, -1);
assert(allLinesPerChannel[0].channels.every((channel) => channel.urls.length === 4), 'per-channel limit -1 must keep every verified line');

const mixedCoverageGroups = [{
  group: '测试',
  channels: [{
    name: '九条测试',
    urls: [
      ...Array.from({ length: 9 }, (_, i) => 'http://bad-' + i + '.example/live'),
      ...Array.from({ length: 3 }, (_, i) => 'http://verified-' + i + '.example/live'),
    ],
  }],
}];
const mixedCoverageMap = Object.fromEntries(Array.from({ length: 3 }, (_, i) => {
  const url = 'http://verified-' + i + '.example/live';
  return [url, { speedMs: 500 + i, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION }];
}));
const mixedCoverage = applyChannelSpeedToGroups(mixedCoverageGroups, mixedCoverageMap, 5000, 9);
assert(mixedCoverage[0].channels[0].urls.length === 3, 'a nine-line cap must emit only three lines when only three are verified');
assert(mixedCoverage[0].channels[0].urls.every((url) => url.includes('verified-')), 'verified lines must fill the actual output without unknown fallbacks');

const manifestPool = Array.from({ length: 9 }, (_, i) => 'http://manifest-' + i + '.example/live');
const tcpPool = Array.from({ length: 9 }, (_, i) => 'http://tcp-' + i + '.example/live');
const tcpFallbackGroups = [{ group: '测试', channels: [{ name: 'TCP排除', urls: [...tcpPool, ...manifestPool] }] }];
const tcpFallbackMap = Object.fromEntries([
  ...tcpPool.map((url) => [url, { speedMs: 1, probedAt: '2026-11-03T00:00:00.000Z', kind: 'tcp', probeVersion: CURRENT_PROBE_VERSION }]),
  ...manifestPool.map((url, i) => [url, { speedMs: 1000 + i, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'manifest', probeVersion: CURRENT_PROBE_VERSION }]),
]);
const tcpFallbackApplied = applyChannelSpeedToGroups(tcpFallbackGroups, tcpFallbackMap, 5000, 9);
assert(tcpFallbackApplied[0].channels[0].urls.length === 9, 'zero TCP-only lines may enter a nine-line final output');
assert(tcpFallbackApplied[0].channels[0].urls.every((url) => url.includes('manifest-')), 'manifest-verified lines must replace every TCP-only line');

// 最终下发的环境性误判保护：验真线路永远优先，后备只补到 9 条。
const nineVerifiedUrls = Array.from({ length: 9 }, (_, i) => `http://verified-${i}.example/live`);
const unknownBackupUrls = Array.from({ length: 20 }, (_, i) => `http://unknown-backup-${i}.example/live`);
const verifiedWithUnknownGroups = [{
  group: '测试',
  channels: [{ name: '验真优先', urls: [...unknownBackupUrls, ...nineVerifiedUrls] }],
}];
const verifiedWithUnknownMap = Object.fromEntries(nineVerifiedUrls.map((url, i) => [
  url,
  { speedMs: 500 + i, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
]));
const verifiedWithUnknown = applyChannelSpeedToGroups(
  verifiedWithUnknownGroups,
  verifiedWithUnknownMap,
  5000,
  15,
);
assert(verifiedWithUnknown[0].channels[0].urls.length === 9,
  'nine verified lines must not be padded toward a fifteen-line cap');
assert(verifiedWithUnknown[0].channels[0].urls.every((url) => url.includes('verified-')),
  'unknown lines must never displace verified lines when nine are available');

const threeVerifiedUrls = nineVerifiedUrls.slice(0, 3);
const threeVerifiedWithUnknown = applyChannelSpeedToGroups(
  verifiedWithUnknownGroups,
  Object.fromEntries(threeVerifiedUrls.map((url, i) => [
    url,
    { speedMs: 500 + i, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
  ])),
  5000,
  9,
);
assert(threeVerifiedWithUnknown[0].channels[0].urls.length === 3,
  'a channel with three media-verified lines must emit exactly those three lines');
assert(threeVerifiedWithUnknown[0].channels[0].urls.every((url) => url.includes('verified-')),
  'unknown lines must never pad a media-verified channel');

// 9/15/全部必须共享同一个稳定前缀。最高证据层不足时不得混入下一层，
// 更不能因为上限更大就偷偷补入未验真线路。
const variableLimitVerifiedUrls = nineVerifiedUrls.slice(0, 6);
const variableLimitGroups = [{
  group: '测试',
  channels: [{
    name: '稳定前缀',
    urls: [...unknownBackupUrls, ...variableLimitVerifiedUrls],
  }],
}];
const variableLimitMap = Object.fromEntries(variableLimitVerifiedUrls.map((url, i) => [
  url,
  { speedMs: 500 + i, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
]));
const selectVariableLimit = (limit) => applyChannelSpeedToGroups(
  variableLimitGroups,
  variableLimitMap,
  5000,
  limit,
)[0].channels[0].urls;
const variableLimitNine = selectVariableLimit(9);
const variableLimitFifteen = selectVariableLimit(15);
const variableLimitAll = selectVariableLimit(-1);
assert(variableLimitNine.length === 6 && variableLimitFifteen.length === 6 && variableLimitAll.length === 6,
  '9, 15 and All must emit only the six media-verified lines');
assert(variableLimitNine.every((url) => url.includes('verified-')),
  'unknown lines must not pad a short media-verified pool');
assert(JSON.stringify(variableLimitFifteen) === JSON.stringify(variableLimitNine)
  && JSON.stringify(variableLimitAll) === JSON.stringify(variableLimitNine),
  '9, 15 and All must be prefixes of one unchanged ordering');

const fallbackOnlyGroups = [{
  group: '测试',
  channels: [{
    name: '无验真仍下发',
    urls: [
      'http://http-failed.example/live',
      'http://public-unknown.example/live',
      'http://transient.example/live',
      'http://[2001:db8::1]/live',
      'http://tcp-only.example/live',
      'http://invalid.example/live',
      'http://hard-failed.example/live',
      'http://http-hard-failed.example/live',
    ],
  }],
}];
const fallbackOnlyMap = {
  'http://tcp-only.example/live': { speedMs: 20, probedAt: '2026-11-03T00:00:00.000Z', kind: 'tcp', probeVersion: CURRENT_PROBE_VERSION },
  'http://transient.example/live': { speedMs: 0, probedAt: '2026-11-03T00:00:00.000Z', kind: 'fail', failureReason: 'timeout', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 1 },
  'http://http-failed.example/live': { speedMs: 0, probedAt: '2026-11-03T00:00:00.000Z', kind: 'fail', failureReason: 'http', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 1 },
  'http://http-hard-failed.example/live': { speedMs: 0, probedAt: '2026-11-03T00:00:00.000Z', kind: 'fail', failureReason: 'http', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 3 },
  'http://invalid.example/live': { speedMs: 0, probedAt: '2026-11-03T00:00:00.000Z', kind: 'fail', failureReason: 'invalid', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 1 },
  'http://hard-failed.example/live': { speedMs: 0, probedAt: '2026-11-03T00:00:00.000Z', kind: 'fail', failureReason: 'timeout', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 3 },
};
const fallbackOnly = applyChannelSpeedToGroups(
  fallbackOnlyGroups,
  fallbackOnlyMap,
  5000,
  9,
);
assert(fallbackOnly.length === 1 && fallbackOnly[0].channels.length === 1,
  'a channel with no successful verification must not disappear from final output');
const fallbackOnlyUrls = fallbackOnly[0].channels[0].urls;
assert(fallbackOnlyUrls.length === 7,
  'fallback must preserve TCP, unknown, IPv6 and transiently failed lines');
assert(fallbackOnlyUrls[0].includes('tcp-only.example'),
  'current TCP evidence must rank first when no playback evidence exists');
assert(fallbackOnlyUrls.includes('http://transient.example/live')
  && fallbackOnlyUrls.includes('http://http-failed.example/live')
  && fallbackOnlyUrls.includes('http://hard-failed.example/live')
  && fallbackOnlyUrls.includes('http://http-hard-failed.example/live'),
  'timeout and HTTP failures must remain recoverable regardless of consecutive failure count');
assert(fallbackOnlyUrls[fallbackOnlyUrls.length - 2].includes('public-unknown.example')
  && fallbackOnlyUrls[fallbackOnlyUrls.length - 1].includes('2001:db8'),
  'ordinary public fallback must rank before IPv6 fallback');
assert(!fallbackOnlyUrls.includes('http://invalid.example/live'),
  'only current-version invalid evidence may be removed from final fallback');

// 最高非空证据层独占下发：media 存在时不混 manifest，manifest 存在时不混后备。
const evidenceTierGroups = [{
  group: '测试',
  channels: [{
    name: '证据分层',
    urls: [
      'http://media-tier.example/live',
      'http://manifest-tier.example/live',
      'http://tcp-tier.example/live',
      'http://unknown-tier.example/live',
    ],
  }],
}];
const evidenceTierMap = {
  'http://media-tier.example/live': { speedMs: 2500, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
  'http://manifest-tier.example/live': { speedMs: 100, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'manifest', probeVersion: CURRENT_PROBE_VERSION },
  'http://tcp-tier.example/live': { speedMs: 20, probedAt: '2026-11-03T00:00:00.000Z', kind: 'tcp', probeVersion: CURRENT_PROBE_VERSION },
};
const mediaTierOutput = applyChannelSpeedToGroups(evidenceTierGroups, evidenceTierMap, 5000, 9);
assert(mediaTierOutput[0].channels[0].urls.length === 1
  && mediaTierOutput[0].channels[0].urls[0].includes('media-tier.example'),
  'media evidence must exclusively control output when present');
const manifestTierOutput = applyChannelSpeedToGroups(
  evidenceTierGroups,
  { ...evidenceTierMap, 'http://media-tier.example/live': { speedMs: 0, probedAt: '2026-11-03T00:00:00.000Z', kind: 'fail', failureReason: 'invalid', probeVersion: CURRENT_PROBE_VERSION } },
  5000,
  9,
);
assert(manifestTierOutput[0].channels[0].urls.length === 1
  && manifestTierOutput[0].channels[0].urls[0].includes('manifest-tier.example'),
  'manifest evidence must exclusively control output when media evidence is absent');

// 升级验真规则后，旧版本判定的失败不能继续把整个频道藏起来。旧版结论
// 先作为后备参与恢复，并在下一次全量评估中按新版本重新验真。
const staleFailureGroups = [{
  group: '测试',
  channels: [{
    name: '旧版误判恢复',
    urls: ['http://stale-failed.example/live', 'http://stale-unknown.example/live'],
  }],
}];
const staleFailure = applyChannelSpeedToGroups(
  staleFailureGroups,
  {
    'http://stale-failed.example/live': {
      speedMs: 0,
      probedAt: '2026-10-13T00:00:00.000Z',
      kind: 'fail',
      failureReason: 'invalid',
      probeVersion: CURRENT_PROBE_VERSION - 1,
      consecutiveFailures: 9,
    },
  },
  5000,
  9,
);
assert(staleFailure.length === 1 && staleFailure[0].channels[0].urls.length === 2,
  'failures from an older probe version must stay available as fallback while new evaluation is pending');

const verifiedOnlyGroups = [{
  group: '测试',
  channels: [{
    name: '全部验真',
    urls: ['http://v1.example/live', 'http://v2.example/live', 'http://unknown1.example/live', 'http://unknown2.example/live'],
  }],
}];
const verifiedOnlyMap = {
  'http://v1.example/live': { speedMs: 100, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
  'http://v2.example/live': { speedMs: 200, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'manifest', probeVersion: CURRENT_PROBE_VERSION },
};
const verifiedOnly = applyChannelSpeedToGroups(verifiedOnlyGroups, verifiedOnlyMap, 5000, -1);
assert(verifiedOnly[0].channels[0].urls.length === 1
  && verifiedOnly[0].channels[0].urls[0].includes('v1.example'),
  'All must emit only every media-verified line, not manifest or unknown candidates');

const preferenceGroups = [{
  group: '测试',
  channels: [{
    name: '偏好排序',
    urls: [
      'http://auth.example/live?token=secret',
      'http://[2001:db8::1]/live',
      'http://public.example/live',
    ],
  }],
}];
const preferenceMap = Object.fromEntries(preferenceGroups[0].channels[0].urls.map((url) => [
  url,
  { speedMs: 100, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
]));
const preferenceApplied = applyChannelSpeedToGroups(preferenceGroups, preferenceMap, 5000, -1);
assert(preferenceApplied[0].channels[0].urls[0].includes('public.example'), 'same-rank public no-auth line must rank first');
assert(preferenceApplied[0].channels[0].urls[1].includes('2001:db8'), 'same-rank IPv6 line must rank after ordinary public line');
assert(preferenceApplied[0].channels[0].urls[2].includes('auth.example'), 'same-rank authenticated line must rank last');

const evidenceGroups = [{
  group: '测试',
  channels: [{
    name: '验真排序',
    urls: [
      'http://connect-only.example/live#源C#30303030',
      'http://manifest-only.example/live#源M#31313131',
      'http://media-verified.example/live#源V#32323232',
    ],
  }],
}];
const evidenceMap = {
  'http://connect-only.example/live': { speedMs: 20, probedAt: '2026-10-13T00:00:00.000Z', kind: 'tcp', probeVersion: CURRENT_PROBE_VERSION },
  'http://manifest-only.example/live': { speedMs: 10, probedAt: '2026-10-13T00:00:00.000Z', kind: 'm3u8', verification: 'manifest', probeVersion: CURRENT_PROBE_VERSION },
  'http://media-verified.example/live': { speedMs: 4500, probedAt: '2026-10-13T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
};
const evidenceApplied = applyChannelSpeedToGroups(evidenceGroups, evidenceMap, 5000, 3);
assert(evidenceApplied[0].channels[0].urls.length === 1, 'connectivity-only and manifest responses must not be mixed with media evidence');
assert(evidenceApplied[0].channels[0].urls[0].includes('media-verified.example'), 'media-verified stream must outrank manifest-only response');
assert(!evidenceApplied[0].channels[0].urls.some((url) => url.includes('manifest-only.example')),
  'manifest-only response must not enter a media-verified channel');
const evidencePreferred = extractPreferredLiveUrls(evidenceGroups, evidenceMap, 3);
assert(evidencePreferred[0] === 'http://media-verified.example/live', 'priority probing must also prefer media-verified lines');

const fairProbeGroups = [{
  group: '测试',
  channels: [
    { name: '频道A', urls: ['http://a-0.example/live', 'http://a-1.example/live', 'http://a-2.example/live'] },
    { name: '频道B', urls: ['http://b-0.example/live', 'http://b-1.example/live', 'http://b-2.example/live'] },
  ],
}];
const fairProbe = extractPreferredLiveUrls(fairProbeGroups, {}, 3);
assert(fairProbe[0].includes('a-0') && fairProbe[1].includes('b-0'), 'priority probing must cover every channel before going deeper into one channel');
assert(fairProbe[2].includes('a-1') && fairProbe[3].includes('b-1'), 'priority probing must advance channels by candidate depth');


// CCTV-1 实测中存在“前 18 条都失败、可播源排在第 19/24 条”的情况。
// 初轮 priority 切片不应让这种频道永久显示 0 条；补测必须继续覆盖尾部候选。
const deepPriorityUrls = Array.from({ length: 24 }, (_, i) => `http://deep-${i}.example/live`);
const deepPriorityGroups = [{ group: '测试', channels: [{ name: '深位可播', urls: deepPriorityUrls }] }];
const deepPriorityFailures = Object.fromEntries(deepPriorityUrls.slice(0, 18).map((url) => [
  url,
  { speedMs: 0, probedAt: '2026-11-03T00:00:00.000Z', kind: 'fail', failureReason: 'network', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 1 },
]));
const deepPriorityTopUp = extractCoverageTopUpLiveUrls(deepPriorityGroups, deepPriorityFailures, 9);
assert(deepPriorityTopUp.length === 6, 'priority top-up must cover every remaining candidate after the first 18 fail');
assert(deepPriorityTopUp.includes('http://deep-18.example/live'), 'top-up must reach the 19th line');
assert(deepPriorityTopUp.includes('http://deep-23.example/live'), 'top-up must reach the 24th line');
assert(!deepPriorityTopUp.some((url) => url.includes('deep-0.example')), 'top-up must not retest fresh failures');

const queuedFirstSlice = new Set(deepPriorityUrls.slice(0, 18));
const excludedPriorityTopUp = extractCoverageTopUpLiveUrls(deepPriorityGroups, {}, 9, queuedFirstSlice);
assert(excludedPriorityTopUp.length === 6 && excludedPriorityTopUp[0].includes('deep-18'), 'queued first-pass URLs must be excluded before the top-up limit, so the 19th line is reachable');
assert(extractCoverageTopUpLiveUrls(deepPriorityGroups, {}, 9, queuedFirstSlice, new Set([deepPriorityUrls[0]])).length === 0, 'a channel with any queued first-pass candidate must not jump into its tail');

const fairTopUpGroups = [{
  group: '测试',
  channels: [
    { name: '补测A', urls: ['http://topup-a0.example/live', 'http://topup-a1.example/live'] },
    { name: '补测B', urls: ['http://topup-b0.example/live', 'http://topup-b1.example/live'] },
  ],
}];
const firstCoverageWave = extractCoverageTopUpLiveUrls(fairTopUpGroups, {}, 9, new Set(), new Set(), 1);
assert(firstCoverageWave.length === 2, 'coverage scheduling must take exactly one next candidate per channel');
assert(firstCoverageWave[0].includes('a0') && firstCoverageWave[1].includes('b0'), 'coverage scheduling must rotate across channels');

const secondCoverageWave = extractCoverageTopUpLiveUrls(
  deepPriorityGroups,
  { 'http://deep-0.example/live': { speedMs: 0, probedAt: '2026-11-03T00:00:00.000Z', kind: 'fail', failureReason: 'network', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 1 } },
  9,
  new Set(['http://deep-0.example/live']),
  new Set(),
  1,
);
assert(secondCoverageWave.length === 1 && secondCoverageWave[0].includes('deep-1'), 'a failed first candidate must schedule only the next candidate for that channel');

const eightMediaOneTcpMap = {
  ...Object.fromEntries(deepPriorityUrls.slice(0, 8).map((url, i) => [url, {
    speedMs: 500 + i, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION,
  }])),
  'http://deep-8.example/live': { speedMs: 20, probedAt: '2026-11-03T00:00:00.000Z', kind: 'tcp', probeVersion: CURRENT_PROBE_VERSION },
};
const tcpAwareTopUp = extractCoverageTopUpLiveUrls(deepPriorityGroups, eightMediaOneTcpMap, 9);
assert(tcpAwareTopUp.includes('http://deep-9.example/live'), 'TCP-only evidence must not satisfy the nine-line playback target');

const enoughVerifiedMap = Object.fromEntries(deepPriorityUrls.slice(0, 10).map((url, i) => [
  url,
  { speedMs: 500 + i, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
]));
assert(extractCoverageTopUpLiveUrls(deepPriorityGroups, enoughVerifiedMap, 9).length === 0, 'top-up must stop once nine playback-verified lines are available');
const nineVerified = applyChannelSpeedToGroups(deepPriorityGroups, enoughVerifiedMap, 5000, 9);
assert(nineVerified[0].channels[0].urls.length === 9, 'a channel with more than nine playable candidates must retain a full nine-line output');

// 旧版探测可能把一次 TCP 握手当成可播。升级后必须把这类缓存视为未知，
// 不能让更快的历史结果挤掉新版已经验到媒体分片的线路。
const legacyProbeGroups = [{
  group: '测试',
  channels: [{
    name: '旧缓存',
    urls: ['http://legacy-tcp.example/live', 'http://current-media.example/live'],
  }],
}];
const legacyProbeMap = {
  'http://legacy-tcp.example/live': { speedMs: 1, probedAt: '2026-10-13T00:00:00.000Z', kind: 'tcp' },
  'http://current-media.example/live': { speedMs: 4800, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION },
};
const legacyProbeApplied = applyChannelSpeedToGroups(legacyProbeGroups, legacyProbeMap, 5000, 1);
assert(legacyProbeApplied[0].channels[0].urls.length === 1 && legacyProbeApplied[0].channels[0].urls[0].includes('current-media.example'), 'legacy TCP cache must be excluded from final output');
const noSingleLine = [{ group: '测试', channels: [{ name: '单线路', urls: ['http://only.example/live$源O#12345678'] }] }];
assert(extractPreferredLiveUrls(noSingleLine, {}, 2).length === 1, 'helper itself extracts single-line channels');
const prioritySingle = noSingleLine.map((group) => ({
  group: group.group,
  channels: group.channels.filter((channel) => channel.urls.length > 0),
})).filter((group) => group.channels.length > 0);
assert(prioritySingle.length === 1, 'priority probing must retain single-line channels');

// 持久化完整候选池：结构化快照必须保留分组、频道和源标签，供重启后从少量
// 下发扩展为全量时恢复；旧版裸 URL 数组只能恢复探测面，不能冒充频道树。
const candidateSnapshot = serializeLiveCandidatePool([
  {
    group: '央视',
    channels: [{
      name: 'CCTV-1',
      urls: ['http://a.example/cctv1$源A#aaaaaaaa', 'http://b.example/cctv1$源B#bbbbbbbb'],
    }],
  },
  {
    group: '卫视',
    channels: [{ name: '湖南卫视', urls: ['http://c.example/hunan$源C#cccccccc'] }],
  },
]);
const restoredSnapshot = parseLiveCandidatePool(candidateSnapshot);
assert(restoredSnapshot.source === 'structured', 'structured candidate snapshot must be detected');
assert(restoredSnapshot.groups.length === 2, 'structured candidate snapshot must restore every group');
assert(restoredSnapshot.groups[0].channels[0].urls.length === 2, 'structured candidate snapshot must restore every line');
assert(restoredSnapshot.groups[0].channels[0].urls[0].endsWith('$源A#aaaaaaaa'), 'structured candidate snapshot must preserve source label');
assert(restoredSnapshot.urls.length === 3, 'structured candidate snapshot must expose three unique bare URLs');
assert(restoredSnapshot.urls.includes('http://a.example/cctv1'), 'structured candidate snapshot must expose bare URLs for probing');

const legacyCandidateSnapshot = parseLiveCandidatePool(JSON.stringify(['http://legacy-a.example/live', 'http://legacy-b.example/live']));
assert(legacyCandidateSnapshot.source === 'legacy-urls', 'legacy URL array must remain parseable');
assert(legacyCandidateSnapshot.groups.length === 1, 'legacy URL array must expose a probe-only group');
assert(legacyCandidateSnapshot.urls.length === 2, 'legacy URL array must restore both probe URLs');
assert(parseLiveCandidatePool('not-json').source === 'none', 'invalid candidate snapshot must fail closed');

// 局部 merged tree 不能遮蔽更完整的候选池；同一频道只按裸 URL 去重，
// 有标签版本应覆盖裸 URL，旧版裸 URL 仅进入探测恢复组。
const partialCandidateTree = [{
  group: '央视',
  channels: [{
    name: 'CCTV-1',
    urls: ['http://shared-candidate.example/live', 'http://partial-only.example/live'],
  }],
}];
const completeCandidateTree = [{
  group: '央视',
  channels: [{
    name: 'CCTV-1',
    urls: ['http://full-only.example/live', 'http://shared-candidate.example/live$源完整#12345678'],
  }, {
    name: 'CCTV-2',
    urls: ['http://full-two.example/live'],
  }],
}];
const mergedCandidateTree = mergeLiveCandidateTreeSources([partialCandidateTree, completeCandidateTree]);
assert(mergedCandidateTree.length === 1 && mergedCandidateTree[0].channels.length === 2,
  'candidate merging must preserve channels hidden by a partial tree');
const mergedCctv1Urls = mergedCandidateTree[0].channels.find((channel) => channel.name === 'CCTV-1').urls;
assert(mergedCctv1Urls.length === 3, 'candidate merging must dedupe by group + channel + bare URL');
assert(mergedCctv1Urls.includes('http://shared-candidate.example/live$源完整#12345678'),
  'labeled candidate form must replace a bare duplicate');
const legacyMergedCandidateTree = mergeLiveCandidateTreeSources([partialCandidateTree], {
  legacyUrls: ['http://legacy-only.example/live', 'http://shared-candidate.example/live'],
  includeLegacyOnlyGroup: true,
});
const recoveryGroup = legacyMergedCandidateTree.find((group) => group.group === '候选恢复');
assert(recoveryGroup?.channels[0].urls.length === 1
  && recoveryGroup.channels[0].urls[0] === 'http://legacy-only.example/live',
  'legacy bare URLs must only add unrepresented URLs to the probe recovery group');

// ── 17b. 聚合分类：央视白名单、国际/教育/专题频道与地方二级目录 ──
const classificationGroups = [{
  group: '央视',
  channels: [
    { name: '[HD]CCTV-1', urls: ['http://classify.example/cctv1'] },
    { name: 'CCTV-1', urls: ['http://classify.example/cctv1-alt'] },
    { name: 'CCTV-5+', urls: ['http://classify.example/cctv5plus'] },
    { name: 'CCTV-4K', urls: ['http://classify.example/cctv4k'] },
    { name: 'CCTV第一剧场', urls: ['http://classify.example/cctv-theater'] },
    { name: 'CCTV风云音乐', urls: ['http://classify.example/cctv-music'] },
    { name: 'CCTV世界地理', urls: ['http://classify.example/cctv-geography'] },
    { name: 'CETV-1', urls: ['http://classify.example/cetv1'] },
    { name: 'CGTN英语', urls: ['http://classify.example/cgtn'] },
    { name: '咪咕视频1', urls: ['http://classify.example/migu'] },
    { name: 'NewTV东北热剧', urls: ['http://classify.example/newtv'] },
    { name: '大庆公共', urls: ['http://classify.example/daqing'] },
    { name: '上海ICS', urls: ['http://classify.example/shics'] },
    { name: '广东民生', urls: ['http://classify.example/gd'] },
    { name: '北京卫视', urls: ['http://classify.example/bjtv'] },
  ],
}, {
  group: '地方',
  channels: [
    { name: '综合频道', urls: ['http://classify.example/local-general'] },
  ],
}];
const classifiedTxt = formatAggregatedLiveGroupsAsTxt(classificationGroups);
const classifiedGroups = parseLiveGroupsFromTxt(classifiedTxt);
const groupOfChannel = (name) => {
  const match = classifiedGroups.find((group) => group.channels.some((channel) => channel.name === name));
  return match ? match.group : '';
};
assert(groupOfChannel('CCTV-1') === '央视', 'real CCTV channel must stay in 央视');
assert((classifiedGroups.find((group) => group.group === '央视')?.channels.find((channel) => channel.name === 'CCTV-1')?.urls.length || 0) === 2, 'quality prefixes must merge into the same CCTV channel');
assert(groupOfChannel('CCTV-5+') === '央视', 'CCTV-5+ must stay in 央视');
assert(groupOfChannel('CCTV-4K') === '4K/8K', 'CCTV-4K must move to 4K/8K');
assert(groupOfChannel('CCTV第一剧场') === '影视·剧场', 'CCTV specialty movie channel must move to 影视·剧场');
assert(groupOfChannel('CCTV风云音乐') === '音乐·歌曲', 'CCTV music channel must move to 音乐·歌曲');
assert(groupOfChannel('CCTV世界地理') === '纪录·自然', 'CCTV documentary channel must move to 纪录·自然');
assert(groupOfChannel('CETV-1') === '教育', 'CETV must move to 教育');
assert(groupOfChannel('CGTN英语') === '国际·新闻', 'CGTN must move to 国际·新闻');
assert(groupOfChannel('咪咕视频1') === '其他·咪咕', 'Migu video must not enter 央视');
assert(groupOfChannel('NewTV东北热剧') === '电视剧', 'NewTV drama must move to 电视剧');
assert(groupOfChannel('大庆公共') === '地方·黑龙江', 'Daqing public channel must move to 地方·黑龙江');
assert(groupOfChannel('上海ICS') === '地方·上海', 'Shanghai ICS must move to 地方·上海');
assert(groupOfChannel('广东民生') === '地方·广东', 'Guangdong livelihood channel must move to 地方·广东');
assert(groupOfChannel('北京卫视') === '卫视', 'satellite channel must stay in 卫视');
assert(groupOfChannel('综合频道') === '地方·其他', 'local group without a detectable region must use 地方·其他');
assert(classifiedTxt.includes('地方·黑龙江,#genre#'), 'output must expose the 地方·黑龙江 group header');
assert(classifiedTxt.includes('地方·上海,#genre#'), 'output must expose the 地方·上海 group header');
// ── 17c. 超大目录扁平细分：平台/语义子目录，不改变频道总数 ──
const subgroupGroups = [{
  group: '一起看',
  channels: [
    { name: '虎牙电影1', urls: ['http://sub.example/huya$虎牙电影#11111111'] },
    { name: '斗鱼游戏1', urls: ['http://sub.example/douyu$斗鱼游戏#22222222'] },
    { name: 'YY音乐1', urls: ['http://sub.example/yy$YY音乐#33333333'] },
    { name: '虎牙随便看看1', urls: ['http://sub.example/huya/1000001$虎牙#44444444'] },
    { name: '斗鱼随便看看1', urls: ['http://sub.example/douyu/2000001$斗鱼#55555555'] },
    { name: 'YY随便看看1', urls: ['http://sub.example/yy/3000001$YY#66666666'] },
    { name: '随便看看频道1', urls: ['http://sub.example/generic/4000001'] },
    { name: '裸线路虎牙1', urls: ['https://sub.example/huya/5000001'] },
    { name: '裸线路斗鱼1', urls: ['https://sub.example/douyu/5000002'] },
    { name: '裸线路YY1', urls: ['https://sub.example/yy/5000003'] },
    { name: '裸线路B站1', urls: ['https://sub.example/bilibili/5000004'] },
    { name: '裸线路快手1', urls: ['https://sub.example/kuaishou/5000005'] },
    { name: '张家港新闻综合', urls: ['http://sub.example/zjg-news'] },
    { name: '大庆公共', urls: ['http://sub.example/daqing-public'] },
  ],
}, {
  group: '其他',
  channels: [
    { name: 'abc news', urls: ['http://sub.example/abc'] },
    { name: 'Zeta TV', urls: ['http://sub.example/zeta'] },
    { name: 'Alpha TV', urls: ['http://sub.example/alpha'] },
    { name: '咪咕视频1', urls: ['http://sub.example/migu'] },
    { name: 'NewTv超级电影', urls: ['http://sub.example/newtv'] },
    { name: '测试频道', urls: ['http://sub.example/test'] },
    { name: '购物频道', urls: ['http://sub.example/shop'] },
    { name: '生活服务频道', urls: ['http://sub.example/life'] },
    { name: '未分类频道', urls: ['http://sub.example/other'] },
    { name: 'Z频道', urls: ['http://sub.example/other-z'] },
    { name: '123频道', urls: ['http://sub.example/other-123'] },
    { name: '其他组虎牙线路', urls: ['https://sub.example/huya/6000001'] },
    { name: '其他组YY线路', urls: ['https://sub.example/yy/6000002'] },
    { name: 'россия 1', urls: ['http://sub.example/russia-one'] },
    { name: 'беларусь 24', urls: ['http://sub.example/belarus-24'] },
    { name: 'DW Deutsch', urls: ['http://sub.example/dw-de'] },
    { name: 'hindi khabar', urls: ['http://sub.example/hindi-khabar'] },
    { name: '上视外语 8M', urls: ['http://sub.example/shanghai-foreign'] },
    { name: '中天亞洲', urls: ['http://sub.example/cti-asia'] },
    { name: '金色学堂 8M', urls: ['http://sub.example/education'] },
    { name: '百变课堂 8M', urls: ['http://sub.example/classroom'] },
    { name: '全纪实 8M', urls: ['http://sub.example/documentary'] },
    { name: '金鹰纪实', urls: ['http://sub.example/golden-eagle-doc'] },
    { name: '纪实科教 8M', urls: ['http://sub.example/doc-science'] },
    { name: '快乐垂钓 8M', urls: ['http://sub.example/fishing'] },
    { name: '高尔夫', urls: ['http://sub.example/golf'] },
    { name: '电子竞技 8M', urls: ['http://sub.example/esports-generic'] },
    { name: '游戏风云 8M', urls: ['http://sub.example/game-wind'] },
    { name: '睛彩竞技', urls: ['http://sub.example/esports-colorful'] },
    { name: '睛彩篮球', urls: ['http://sub.example/basketball-colorful'] },
    { name: '武术世界', urls: ['http://sub.example/martial-arts'] },
    { name: '睛彩羽毛球', urls: ['http://sub.example/badminton'] },
    { name: '现代教育', urls: ['http://sub.example/modern-education'] },
    { name: '经济科教', urls: ['http://sub.example/economics-science-education'] },
    { name: '党员教育', urls: ['http://sub.example/party-education'] },
    { name: '法治天地', urls: ['http://sub.example/law'] },
    { name: '法制天地', urls: ['http://sub.example/law-alt'] },
    { name: '中国交通', urls: ['http://sub.example/traffic'] },
    { name: '交通频道', urls: ['http://sub.example/traffic-channel'] },
    { name: '哒啵电竞', urls: ['http://sub.example/esports'] },
    { name: '电竞天堂 8M', urls: ['http://sub.example/esports-heaven'] },
    { name: '梨园频道', urls: ['http://sub.example/opera'] },
    { name: '沪剧频道', urls: ['http://sub.example/shanghai-opera'] },
    { name: '文物宝库', urls: ['http://sub.example/relics'] },
    { name: '置业频道', urls: ['http://sub.example/property'] },
    { name: '都江堰神树坪②', urls: ['http://sub.example/panda-camera'] },
  ],
}, {
  group: '国际·新闻',
  channels: [
    { name: 'CGTN Français', urls: ['http://sub.example/cgtn-fr'] },
    { name: 'CGTN Español', urls: ['http://sub.example/cgtn-es'] },
    { name: 'CGTN العربية', urls: ['http://sub.example/cgtn-ar'] },
    { name: 'CGTN Русский', urls: ['http://sub.example/cgtn-ru'] },
    { name: 'CGTN记录', urls: ['http://sub.example/cgtn-doc-cn'] },
    { name: 'CGTN F', urls: ['http://sub.example/cgtn-f'] },
    { name: '中国环球电视', urls: ['http://sub.example/cgtn-cn'] },
    { name: 'BBC One', urls: ['http://sub.example/bbc-one'] },
    { name: 'BBC Two', urls: ['http://sub.example/bbc-two'] },
    { name: 'ABC KGO-TV', urls: ['http://sub.example/abc-kgo'] },
    { name: 'abc kero-tv', urls: ['http://sub.example/abc-kero'] },
    { name: 'arirang', urls: ['http://sub.example/arirang'] },
    { name: 'NHK World', urls: ['http://sub.example/nhk-world'] },
    { name: 'CNN Turk', urls: ['http://sub.example/cnn-turk'] },
  ],
}, {
  group: '国际·英语',
  channels: [
    { name: 'france 2', urls: ['http://sub.example/france-2'] },
    { name: 'italia 1', urls: ['http://sub.example/italia-1'] },
    { name: 'cine brasil', urls: ['http://sub.example/cine-brasil'] },
    { name: 'BBC Earth', urls: ['http://sub.example/bbc-earth'] },
    { name: 'France 24 English', urls: ['http://sub.example/france-24-en'] },
    { name: 'DW Español', urls: ['http://sub.example/dw-es'] },
    { name: 'CNN Brasil', urls: ['http://sub.example/cnn-brasil'] },
    { name: 'franceinfo', urls: ['http://sub.example/france-info'] },
    { name: 'Sky News Arabia', urls: ['http://sub.example/sky-news-arabia'] },
    { name: 'Love Nature', urls: ['http://sub.example/love-nature'] },
  ],
}, {
  group: '港澳台',
  channels: [
    { name: '凤凰传奇-策马奔腾', urls: ['http://sub.example/music-phoenix-legend'] },
    { name: '凤凰传奇-荷塘月色', urls: ['http://sub.example/music-phoenix-legend-2'] },
  ],
}, {
  group: '体育',
  channels: [
    { name: '动物搏击赛', urls: ['http://sub.example/animal-fight'] },
    { name: '动物冠军竞技场(上)', urls: ['http://sub.example/animal-champion'] },
  ],
}, {
  group: '影视',
  channels: [
    { name: '经典电影', urls: ['http://sub.example/movie'] },
    { name: '电影剧场', urls: ['http://sub.example/drama'] },
  ],
}, {
  group: '音乐',
  channels: [
    { name: '经典歌曲', urls: ['http://sub.example/song'] },
    { name: 'DJ舞曲', urls: ['http://sub.example/dj'] },
    { name: '演唱会现场', urls: ['http://sub.example/live'] },
  ],
}, {
  group: '纪录',
  channels: [
    { name: '自然动物', urls: ['http://sub.example/nature'] },
    { name: '历史人文', urls: ['http://sub.example/humanity'] },
    { name: '科学探索', urls: ['http://sub.example/science'] },
  ],
}, {
  group: '风景直播',
  channels: [
    { name: '景区直播', urls: ['http://sub.example/scenic'] },
    { name: '城市街景', urls: ['http://sub.example/city'] },
  ],
}];
const subgroupTxt = formatAggregatedLiveGroupsAsTxt(subgroupGroups);
const subgroupParsed = parseLiveGroupsFromTxt(subgroupTxt);
const subgroupOfChannel = (name) => {
  const match = subgroupParsed.find((group) => group.channels.some((channel) => channel.name === name));
  return match ? match.group : '';
};
assert(subgroupOfChannel('虎牙电影1') === '一起看·虎牙影视', 'huya movie channel must use platform + content subgroup');
assert(subgroupOfChannel('斗鱼游戏1') === '一起看·斗鱼游戏', 'douyu game channel must use platform + content subgroup');
assert(subgroupOfChannel('YY音乐1') === '一起看·YY音乐', 'YY music channel must use platform + content subgroup');
assert(subgroupOfChannel('虎牙随便看看1') === '一起看·虎牙其他', 'unclassified Huya channel must use one stable fallback subgroup');
assert(subgroupOfChannel('斗鱼随便看看1') === '一起看·斗鱼其他', 'unclassified Douyu channel must use one stable fallback subgroup');
assert(subgroupOfChannel('YY随便看看1') === '一起看·YY其他', 'unclassified YY channel must use one stable fallback subgroup');
assert(subgroupOfChannel('随便看看频道1') === '一起看·其他', 'unclassified together channel must not produce 一起看·其他其他');
assert(subgroupOfChannel('裸线路虎牙1') === '一起看·虎牙其他', 'bare Huya URL must identify its platform without a source label');
assert(subgroupOfChannel('裸线路斗鱼1') === '一起看·斗鱼其他', 'bare Douyu URL must identify its platform without a source label');
assert(subgroupOfChannel('裸线路YY1') === '一起看·YY其他', 'bare YY URL must identify its platform without a source label');
assert(subgroupOfChannel('裸线路B站1') === '一起看·B站其他', 'bare Bilibili URL must identify its platform without a source label');
assert(subgroupOfChannel('裸线路快手1') === '一起看·短视频其他', 'bare short-video URL must identify its platform without a source label');
assert(subgroupOfChannel('其他组虎牙线路') === '一起看·虎牙其他', 'Huya URL in a legacy other bucket must move back to 一起看');
assert(subgroupOfChannel('其他组YY线路') === '一起看·YY其他', 'YY URL in a legacy other bucket must move back to 一起看');
assert(subgroupOfChannel('张家港新闻综合') === '地方·江苏', 'an explicit local channel must win over its together-platform bucket');
assert(subgroupOfChannel('大庆公共') === '地方·黑龙江', 'local-channel structure must be detected before platform fallback');
assert(subgroupOfChannel('россия 1') === '国际·俄语', 'Cyrillic international channels must not fall into the generic other bucket');
assert(subgroupOfChannel('беларусь 24') === '国际·俄语', 'Cyrillic-language brands must share the Russian-language subgroup');
assert(subgroupOfChannel('CGTN Français') === '国际·法语', 'CGTN French must use the French-language subgroup');
assert(subgroupOfChannel('CGTN Español') === '国际·西班牙语', 'CGTN Spanish must use the Spanish-language subgroup');
assert(subgroupOfChannel('CGTN العربية') === '国际·阿拉伯语', 'CGTN Arabic must use the Arabic-language subgroup');
assert(subgroupOfChannel('CGTN Русский') === '国际·俄语', 'CGTN Russian must use the Russian-language subgroup');
assert(subgroupOfChannel('DW Deutsch') === '国际·德语', 'DW German must use the German-language subgroup');
assert(subgroupOfChannel('france 2') === '国际·法语', 'France 2 must use the French-language subgroup');
assert(subgroupOfChannel('italia 1') === '国际·意大利语', 'Italia 1 must use the Italian-language subgroup');
assert(subgroupOfChannel('cine brasil') === '国际·葡萄牙语', 'Brazilian Portuguese channels must use the Portuguese-language subgroup');
assert(subgroupOfChannel('hindi khabar') === '国际·亚洲', 'Hindi channels must use the Asian-language subgroup');
assert(subgroupOfChannel('上视外语 8M') === '地方·上海', 'Shanghai foreign-language channels must keep their local region');
assert(subgroupOfChannel('中天亞洲') === '港澳台', 'CTi Asia must use the Hong Kong/Macau/Taiwan group');
assert(subgroupOfChannel('中国环球电视') === '国际·新闻', 'China Global Television must use international news');
assert(subgroupOfChannel('金色学堂 8M') === '教育', 'education channels must not fall into 其他·综合');
assert(subgroupOfChannel('百变课堂 8M') === '教育', 'classroom channels must not fall into 其他·综合');
assert(subgroupOfChannel('全纪实 8M') === '纪录·探索', 'full-documentary channels must use the documentary group');
assert(subgroupOfChannel('金鹰纪实') === '纪录·探索', 'documentary channels must use the documentary group');
assert(subgroupOfChannel('纪实科教 8M') === '纪录·探索', 'documentary-science channels must use the documentary group');
assert(subgroupOfChannel('快乐垂钓 8M') === '体育', 'fishing channels must use the sports group');
assert(subgroupOfChannel('高尔夫') === '体育', 'golf channels must use the sports group');
assert(subgroupOfChannel('电子竞技 8M') === '体育', 'generic esports channels must use the sports group');
assert(subgroupOfChannel('游戏风云 8M') === '体育', 'game-channel brands must use the sports group');
assert(subgroupOfChannel('睛彩竞技') === '体育', 'sports-competition variants must use the sports group');
assert(subgroupOfChannel('睛彩篮球') === '体育', 'basketball variants must use the sports group');
assert(subgroupOfChannel('武术世界') === '体育', 'martial-arts channels must use the sports group');
assert(subgroupOfChannel('睛彩羽毛球') === '体育', 'badminton channels must use the sports group');
assert(subgroupOfChannel('现代教育') === '教育', 'modern-education channels must use the education group');
assert(subgroupOfChannel('经济科教') === '教育', 'economics/science-education channels must use the education group');
assert(subgroupOfChannel('党员教育') === '教育', 'party-education channels must use the education group');
assert(subgroupOfChannel('法治天地') === '新闻财经', 'law channels must use the news/finance group');
assert(subgroupOfChannel('法制天地') === '新闻财经', 'law channels using the 法制 variant must use the news/finance group');
assert(subgroupOfChannel('中国交通') === '新闻财经', 'traffic channels must use the news/finance group');
assert(subgroupOfChannel('交通频道') === '新闻财经', 'generic traffic channels must use the news/finance group');
assert(subgroupOfChannel('哒啵电竞') === '体育', 'esports channels must use the sports group');
assert(subgroupOfChannel('电竞天堂 8M') === '体育', 'esports channels must use the sports group');
assert(subgroupOfChannel('梨园频道') === '音乐·戏曲', 'opera channels must use the opera subgroup');
assert(subgroupOfChannel('沪剧频道') === '音乐·戏曲', 'local-opera variants must use the opera subgroup');
assert(subgroupOfChannel('文物宝库') === '纪录·人文', 'cultural-relic channels must use the humanities documentary subgroup');
assert(subgroupOfChannel('置业频道') === '其他·生活服务', 'property channels must use the life-service subgroup');
assert(subgroupOfChannel('都江堰神树坪②') === '风景·自然', 'wildlife camera channels must use the natural-scenery subgroup');
assert(subgroupOfChannel('abc news') === '国际·新闻', 'English news channel must use international news subgroup');
assert(subgroupOfChannel('BBC Earth') === '国际·纪录', 'BBC documentary brands must not be forced into international news');
assert(subgroupOfChannel('BBC One') === '国际·英语', 'general BBC entertainment must stay in the English subgroup');
assert(subgroupOfChannel('ABC KGO-TV') === '国际·英语', 'local ABC affiliate channels must stay in the English subgroup');
assert(subgroupOfChannel('BBC Two') === '国际·英语', 'generic BBC entertainment must ignore its stale news group');
assert(subgroupOfChannel('abc kero-tv') === '国际·英语', 'ABC affiliates must ignore their stale news group');
assert(subgroupOfChannel('arirang') === '国际·亚洲', 'Arirang must use the Asian-language subgroup');
assert(subgroupOfChannel('NHK World') === '国际·亚洲', 'NHK World must use the Asian-language subgroup');
assert(subgroupOfChannel('CNN Turk') === '国际·土耳其语', 'CNN Turk must use the Turkish-language subgroup');
assert(subgroupOfChannel('France 24 English') === '国际·新闻', 'English-language France 24 must use international news');
assert(subgroupOfChannel('DW Español') === '国际·西班牙语', 'DW Spanish must use the Spanish-language subgroup');
assert(subgroupOfChannel('CNN Brasil') === '国际·葡萄牙语', 'CNN Brasil must use the Portuguese-language subgroup');
assert(subgroupOfChannel('CGTN记录') === '国际·纪录', 'CGTN documentary variants must use the international documentary subgroup');
assert(subgroupOfChannel('CGTN F') === '国际·法语', 'CGTN French feed aliases must use the French-language subgroup');
assert(subgroupOfChannel('franceinfo') === '国际·法语', 'France Info must use the French-language subgroup');
assert(subgroupOfChannel('Sky News Arabia') === '国际·阿拉伯语', 'Sky News Arabia must use the Arabic-language subgroup');
assert(subgroupOfChannel('Love Nature') === '国际·纪录', 'international nature channels must use the documentary subgroup');
assert(subgroupOfChannel('凤凰传奇-策马奔腾') === '音乐·歌曲', 'Phoenix Legend songs must not be mistaken for Phoenix TV');
assert(subgroupOfChannel('凤凰传奇-荷塘月色') === '音乐·歌曲', 'Phoenix Legend song titles must stay in the music group');
assert(subgroupOfChannel('动物搏击赛') === '纪录·自然', 'animal competition documentaries must not use the sports group');
assert(subgroupOfChannel('动物冠军竞技场(上)') === '纪录·自然', 'animal championship documentaries must not use the sports group');
assert(subgroupOfChannel('Zeta TV') === '国际·英语', 'English channel must not be split by initial letter');
assert(subgroupOfChannel('Alpha TV') === '国际·英语', 'English channels must share the semantic English subgroup');
assert(subgroupOfChannel('咪咕视频1') === '其他·咪咕', 'Migu channel must use Migu subgroup');
assert(subgroupOfChannel('NewTv超级电影') === '其他·NewTV', 'NewTV channel must use NewTV subgroup');
assert(subgroupOfChannel('测试频道') === '其他·测试备用', 'test channel must use test/backup subgroup');
assert(subgroupOfChannel('购物频道') === '其他·购物生活', 'shopping channel must use shopping/life subgroup');
assert(subgroupOfChannel('生活服务频道') === '其他·生活服务', 'life-service channel must use life-service subgroup');
assert(subgroupOfChannel('未分类频道') === '其他·综合', 'unclassified channel must use one stable fallback subgroup');
assert(subgroupOfChannel('Z频道') === '其他·综合', 'Latin-prefixed Chinese channel must not use an initial-letter bucket');
assert(subgroupOfChannel('123频道') === '其他·综合', 'numeric-prefixed channel must not use a numeric bucket');
assert(subgroupOfChannel('经典电影') === '影视·电影', 'movie channel must use film subgroup');
assert(subgroupOfChannel('电影剧场') === '影视·剧场', 'drama theater channel must use theater subgroup');
assert(subgroupOfChannel('经典歌曲') === '音乐·歌曲', 'song channel must use song subgroup');
assert(subgroupOfChannel('DJ舞曲') === '音乐·DJ', 'DJ channel must use DJ subgroup');
assert(subgroupOfChannel('演唱会现场') === '音乐·现场', 'concert channel must use live-music subgroup');
assert(subgroupOfChannel('自然动物') === '纪录·自然', 'nature channel must use nature subgroup');
assert(subgroupOfChannel('历史人文') === '纪录·人文', 'humanity channel must use humanity subgroup');
assert(subgroupOfChannel('科学探索') === '纪录·探索', 'science channel must use exploration subgroup');
assert(subgroupOfChannel('景区直播') === '风景·景区', 'scenic channel must use scenic subgroup');
assert(subgroupOfChannel('城市街景') === '风景·城市', 'city channel must use city subgroup');
assert(
  subgroupParsed.every((group) => !/^(?:国际·英语[A-Z]|其他·(?:字母[A-Z]|数字|中文[A-Z])|一起看·[^·]+(?:中文[A-Z]|字母数字))$/.test(group.group)),
  'aggregate subgroups must not split channels into meaningless initial-letter or numeric buckets',
);
assert(
  subgroupParsed.reduce((sum, group) => sum + group.channels.length, 0) === subgroupGroups.reduce((sum, group) => sum + group.channels.length, 0),
  'subgrouping must not change channel count',
);
assert(
  subgroupParsed.every((group) => group.group !== '一起看' && group.group !== '其他' && group.group !== '影视' && group.group !== '音乐' && group.group !== '纪录' && group.group !== '风景直播'),
  'oversized parent groups must not be emitted after subgrouping',
);
const subgroupRoundTripTxt = formatAggregatedLiveGroupsAsTxt(subgroupParsed);
const subgroupRoundTrip = parseLiveGroupsFromTxt(subgroupRoundTripTxt);
assert(
  subgroupRoundTrip.map((group) => group.group).join('|') === subgroupParsed.map((group) => group.group).join('|'),
  'semantic aggregate subgroups must be idempotent across persisted TXT round trips: '
    + subgroupParsed.map((group) => group.group).join('|') + ' => '
    + subgroupRoundTrip.map((group) => group.group).join('|'),
);

// 17c-2. 历史首字母/平台ID桶和容量页尾再次进入聚合器时，必须按当前语义重新归类。
const legacyBucketGroups = [{
  group: '国际·英语A',
  channels: [
    { name: 'Alpha TV', urls: ['http://legacy.example/alpha'] },
    { name: 'CCTV-5', urls: ['http://legacy.example/cctv5'] },
  ],
}, {
  group: '国际·新闻',
  channels: [
    { name: '小虎牙频道甲', urls: ['http://legacy.example/huya$虎牙一起看#aaaabbbb'] },
  ],
}, {
  group: '国际·英语R01',
  channels: [
    { name: '湖南卫视', urls: ['http://legacy.example/hunan'] },
  ],
}, {
  group: '国际·英语R',
  channels: [
    { name: 'Bravo TV', urls: ['http://legacy.example/bravo'] },
  ],
}, {
  group: '其他·中文A',
  channels: [
    { name: '购物频道', urls: ['http://legacy.example/shop'] },
  ],
}, {
  group: '其他·中文其他',
  channels: [
    { name: '生活服务频道2', urls: ['http://legacy.example/life2'] },
  ],
}, {
  group: '其他·字母C',
  channels: [
    { name: '测试频道', urls: ['http://legacy.example/test'] },
  ],
}, {
  group: '其他·数字',
  channels: [
    { name: '未分类频道', urls: ['http://legacy.example/other'] },
  ],
}, {
  group: '一起看·虎牙中文R01',
  channels: [
    { name: '虎牙随便看看2', urls: ['http://legacy.example/huya2$虎牙#ccccdddd'] },
  ],
}, {
  group: '一起看·斗鱼字母数字',
  channels: [
    { name: '斗鱼随便看看2', urls: ['http://legacy.example/douyu2$斗鱼#eeeeffff'] },
  ],
}, {
  group: '一起看·YY中文A',
  channels: [
    { name: 'YY随便看看2', urls: ['http://legacy.example/yy2$YY#11112222'] },
  ],
}, {
  group: '一起看·YY中文其他',
  channels: [
    { name: 'YY随便看看3', urls: ['http://legacy.example/yy3'] },
  ],
}, {
  group: '一起看·YY字母数字',
  channels: [
    { name: 'YY随便看看4', urls: ['http://legacy.example/yy4'] },
  ],
}, {
  group: '影视·电影01',
  channels: [
    { name: '经典电影', urls: ['http://legacy.example/movie'] },
  ],
}, {
  group: '纪录·自然01',
  channels: [
    { name: '自然动物', urls: ['http://legacy.example/nature'] },
  ],
}, {
  group: '风景·景区02',
  channels: [
    { name: '景区直播', urls: ['http://legacy.example/scenic'] },
  ],
}, {
  group: '其他·生活服务',
  channels: [
    { name: '生活服务频道', urls: ['http://legacy.example/life'] },
  ],
}, {
  group: '一起看·其他',
  channels: [
    { name: '张家港新闻综合', urls: ['http://legacy.example/zjg-news'] },
  ],
}, {
  group: '其他·俄语',
  channels: [
    { name: 'россия 1', urls: ['http://legacy.example/russia-one'] },
  ],
}];
const legacyBucketTxt = formatAggregatedLiveGroupsAsTxt(legacyBucketGroups);
const legacyBucketParsed = parseLiveGroupsFromTxt(legacyBucketTxt);
const legacyGroupOfChannel = (name) => {
  const match = legacyBucketParsed.find((group) => group.channels.some((channel) => channel.name === name));
  return match ? match.group : '';
};
assert(legacyGroupOfChannel('Alpha TV') === '国际·英语', 'legacy international letter bucket must collapse into 国际·英语');
assert(legacyGroupOfChannel('CCTV-5') === '央视', 'legacy international bucket must not hide a real CCTV channel');
assert(legacyGroupOfChannel('小虎牙频道甲') === '一起看·虎牙其他', 'legacy international bucket must not hide a Huya source');
assert(legacyGroupOfChannel('湖南卫视') === '卫视', 'legacy international bucket must not hide a satellite channel');
assert(legacyGroupOfChannel('Bravo TV') === '国际·英语', 'legacy international page without a two-digit suffix must collapse into 国际·英语');
assert(legacyGroupOfChannel('购物频道') === '其他·购物生活', 'legacy Chinese-letter bucket must retain semantic subgrouping');
assert(legacyGroupOfChannel('生活服务频道2') === '其他·生活服务', 'legacy 其他·中文其他 bucket must retain semantic subgrouping');
assert(legacyGroupOfChannel('测试频道') === '其他·测试备用', 'legacy Latin-letter bucket must retain semantic subgrouping');
assert(legacyGroupOfChannel('未分类频道') === '其他·综合', 'legacy numeric bucket must collapse into 其他·综合');
assert(legacyGroupOfChannel('虎牙随便看看2') === '一起看·虎牙其他', 'legacy Huya page bucket must collapse into one platform fallback');
assert(legacyGroupOfChannel('斗鱼随便看看2') === '一起看·斗鱼其他', 'legacy Douyu bucket must collapse into one platform fallback');
assert(legacyGroupOfChannel('YY随便看看2') === '一起看·YY其他', 'legacy YY bucket must collapse into one platform fallback');
assert(legacyGroupOfChannel('YY随便看看3') === '一起看·YY其他', 'legacy 一起看·YY中文其他 bucket must collapse into one platform fallback');
assert(legacyGroupOfChannel('YY随便看看4') === '一起看·YY其他', 'legacy 一起看·YY字母数字 bucket must collapse into one platform fallback');
assert(legacyGroupOfChannel('经典电影') === '影视·电影', 'legacy movie page must round-trip into its semantic subgroup');
assert(legacyGroupOfChannel('自然动物') === '纪录·自然', 'legacy documentary page must round-trip into its semantic subgroup');
assert(legacyGroupOfChannel('景区直播') === '风景·景区', 'legacy scenery page must round-trip into its semantic subgroup');
assert(legacyGroupOfChannel('生活服务频道') === '其他·生活服务', 'persisted semantic subgroup must remain idempotent');
assert(legacyGroupOfChannel('张家港新闻综合') === '地方·江苏', 'legacy together fallback must release an explicit local channel');
assert(legacyGroupOfChannel('россия 1') === '国际·俄语', 'legacy other-Russian bucket must merge into international Russian');
assert(
  legacyBucketParsed.every((group) => !/^(?:国际·英语[A-Z](?:\d{2})?|其他·(?:字母[A-Z]|数字|中文[A-Z]|中文其他|俄语)(?:\d{2})?|一起看·[^·]+(?:中文[A-Z]|中文其他|字母数字)(?:\d{2})?)$/.test(group.group)),
  'legacy initial-letter and numeric buckets must never be emitted',
);
assert(
  legacyBucketParsed.every((group) => group.group !== '一起看·其他其他'),
  'generic together fallback must not duplicate 其他',
);
assert(
  legacyBucketParsed.reduce((sum, group) => sum + group.channels.length, 0) === legacyBucketGroups.reduce((sum, group) => sum + group.channels.length, 0),
  'legacy bucket normalization must not change channel count',
);

// 17d. 超大主题目录按稳定顺序分页；地方省市目录保持完整，频道和线路不丢失。
const pagedGroups = [{
  group: '一起看',
  channels: Array.from({ length: 401 }, (_, index) => ({
    name: '虎牙中文' + String(index + 1).padStart(3, '0'),
    urls: ['http://paged.example/huya/' + (1000000 + index) + '$虎牙#11111111'],
  })),
}, {
  group: '地方',
  channels: Array.from({ length: 220 }, (_, index) => ({
    name: '浙江频道' + String(index + 1).padStart(3, '0'),
    urls: ['http://paged.example/zj/' + index],
  })),
}];
const pagedTxt = formatAggregatedLiveGroupsAsTxt(pagedGroups);
const pagedParsed = parseLiveGroupsFromTxt(pagedTxt);
const pagedHeaders = pagedParsed.map((group) => group.group);
const huyaPages = pagedParsed.filter((group) => group.group.startsWith('一起看·虎牙其他'));
const huyaPageBase = huyaPages[0]?.group.replace(/\d{2}$/, '') || '';
assert(huyaPages.length === 3, '401 Huya channels must split into three controlled pages');
assert(huyaPages[0].channels.length === 180 && huyaPages[1].channels.length === 180 && huyaPages[2].channels.length === 41, 'Huya pages must keep stable 180/180/41 capacity');
assert(huyaPages.every((group) => group.group === huyaPageBase + '01' || group.group === huyaPageBase + '02' || group.group === huyaPageBase + '03'), 'Huya pages must expose readable 01/02/03 suffixes');
assert(pagedHeaders.indexOf(huyaPageBase + '01') < pagedHeaders.indexOf(huyaPageBase + '02'), 'Huya page order must be stable');
assert(pagedHeaders.indexOf(huyaPageBase + '02') < pagedHeaders.indexOf(huyaPageBase + '03'), 'Huya page order must remain stable');
assert(pagedParsed.some((group) => group.group === '地方·浙江' && group.channels.length === 220), 'local province groups must stay complete and unpaged');
assert(pagedParsed.reduce((sum, group) => sum + group.channels.length, 0) === 621, 'paging must not lose channels');
assert(pagedParsed.reduce((sum, group) => sum + group.channels.reduce((urls, channel) => urls + channel.urls.length, 0), 0) === 621, 'paging must not lose channel URLs');

// 17e. 语义统一后仍要保留超量容量的 01/02/03 分页，不能为了去编号而丢频道。
const pagedInternationalGroups = [{
  group: '国际·英语R01',
  channels: Array.from({ length: 361 }, (_, index) => ({
    name: 'Global TV ' + String(index + 1).padStart(3, '0'),
    urls: ['http://international-paged.example/channel/' + index],
  })),
}];
const pagedInternationalTxt = formatAggregatedLiveGroupsAsTxt(pagedInternationalGroups);
const pagedInternationalParsed = parseLiveGroupsFromTxt(pagedInternationalTxt);
const englishPages = pagedInternationalParsed.filter((group) => group.group.startsWith('国际·英语'));
assert(englishPages.length === 3, '361 international English channels must retain three capacity pages');
assert(
  englishPages.map((group) => group.group).join(',') === '国际·英语01,国际·英语02,国际·英语03',
  'international English capacity pages must use stable semantic 01/02/03 suffixes',
);
assert(
  englishPages.map((group) => group.channels.length).join(',') === '180,180,1',
  'international English capacity pages must preserve every channel',
);
// ── 18. 分片更新：仅撤销本批次未就绪文本，不清空其他已完成批次 ──
const incrementalBase = mergeLiveProxyManifest(null, [entry(50), entry(51)], {
  checkedAt: '2026-10-13T02:00:00.000Z',
  validUrls: ['https://live.example/50.txt', 'https://live.example/51.txt'],
  texts: {
    'https://live.example/50.txt': '央视,#genre#\nCCTV-1,http://50.example/live',
    'https://live.example/51.txt': '卫视,#genre#\n湖南卫视,http://51.example/live',
  },
});
assert(incrementalBase.entries.every((item) => item.textReady === true), 'incremental seed must mark both batches ready');
// 18d. 规范化签名必须稳定：同一组 URL 的 query、尾斜杠和大小写变化
// 只能触发一次输入变更，不能在状态 complete 后反复重跑全部直播分片。
const inputSignatureMod = require(inputsOutfile);
const signatureA = inputSignatureMod.livePrepareInputSignature([
  { name: 'a', url: 'https://Live.Example/a.txt?token=1' },
  { name: 'b', url: 'https://live.example/b.txt/' },
]);
const signatureB = inputSignatureMod.livePrepareInputSignature([
  { name: 'b', url: 'HTTPS://LIVE.EXAMPLE/b.txt' },
  { name: 'a', url: 'https://live.example/a.txt' },
]);
assert(signatureA === signatureB, 'normalized live input signature must be stable across query/order/case changes');
const incrementalSecond = mergeLiveProxyManifest(
  incrementalBase,
  incrementalBase.entries.map((item) => ({ ...item, textReady: undefined })),
  {
    checkedAt: '2026-10-13T02:01:00.000Z',
    validUrls: ['https://live.example/50.txt'],
    transientUrls: ['https://live.example/51.txt'],
    texts: { 'https://live.example/50.txt': '央视,#genre#\nCCTV-1,http://50-new.example/live' },
    incremental: true,
  },
);
assert(
  incrementalSecond.entries.find((item) => item.key === 'key-51')?.textReady === true,
  'the first transient failure must preserve a mature source text as fallback',
);
assert(
  isLiveProxyEntryDistributable(incrementalSecond.entries.find((item) => item.key === 'key-51')) === true,
  'the first transient failure must not hide a mature source that still has valid text',
);
assert(
  incrementalSecond.entries.find((item) => item.key === 'key-50')?.textReady === true,
  'incremental batch must mark its own successful text ready',
);

const incrementalThird = mergeLiveProxyManifest(
  incrementalSecond,
  incrementalBase.entries.map((item) => ({ ...item, textReady: undefined })),
  {
    checkedAt: '2026-10-13T02:01:30.000Z',
    validUrls: ['https://live.example/50.txt'],
    transientUrls: ['https://live.example/51.txt'],
    texts: { 'https://live.example/50.txt': '央视,#genre#\nCCTV-1,http://50-new.example/live' },
    incremental: true,
  },
);
assert(
  incrementalThird.entries.find((item) => item.key === 'key-51')?.consecutiveFailures === 2
    && incrementalThird.entries.find((item) => item.key === 'key-51')?.textReady === true,
  'the second transient failure must still preserve mature source text',
);

const incrementalFourth = mergeLiveProxyManifest(
  incrementalThird,
  incrementalBase.entries.map((item) => ({ ...item, textReady: undefined })),
  {
    checkedAt: '2026-10-13T02:01:45.000Z',
    validUrls: ['https://live.example/50.txt'],
    transientUrls: ['https://live.example/51.txt'],
    texts: { 'https://live.example/50.txt': '央视,#genre#\nCCTV-1,http://50-new.example/live' },
    incremental: true,
  },
);
assert(
  incrementalFourth.entries.find((item) => item.key === 'key-51')?.textReady === true,
  'consecutive transient failures must never revoke mature source text',
);
assert(
  isLiveProxyEntryDistributable(incrementalFourth.entries.find((item) => item.key === 'key-51')) === true,
  'consecutive transient failures must leave the mature source distributable',
);

const incrementalInvalid = mergeLiveProxyManifest(
  incrementalBase,
  incrementalBase.entries.map((item) => ({ ...item, textReady: undefined })),
  {
    checkedAt: '2026-10-13T02:01:30.000Z',
    validUrls: [],
    transientUrls: [],
    invalidUrls: ['https://live.example/51.txt'],
    texts: {},
    incremental: true,
  },
);
assert(
  incrementalInvalid.entries.find((item) => item.key === 'key-51')?.textReady === false,
  'invalid source in an incremental batch must also revoke textReady',
);
assert(
  isLiveProxyEntryDistributable(incrementalInvalid.entries.find((item) => item.key === 'key-51')) === false,
  'invalid incremental source must not remain distributable',
);

// 18a. 增量更新标记 valid 但本批没有正文，必须撤销旧 ready。
const incrementalMissingText = mergeLiveProxyManifest(
  incrementalBase,
  incrementalBase.entries.map((item) => ({ ...item, textReady: undefined })),
  {
    checkedAt: '2026-10-13T02:01:45.000Z',
    validUrls: ['https://live.example/50.txt', 'https://live.example/51.txt'],
    texts: { 'https://live.example/50.txt': '央视,#genre#\nCCTV-1,http://50-new.example/live' },
    incremental: true,
  },
);
assert(
  incrementalMissingText.entries.find((item) => item.key === 'key-50')?.textReady === true,
  'incremental valid source with text must stay ready',
);
assert(
  incrementalMissingText.entries.find((item) => item.key === 'key-51')?.textReady === false,
  'incremental valid-without-text source must not inherit old textReady',
);
assert(
  isLiveProxyEntryDistributable(incrementalMissingText.entries.find((item) => item.key === 'key-51')) === false,
  'incremental valid-without-text source must not remain distributable',
);

// ── 18c. 所有普通 2xx 异常正文都只算瞬时失败，不能永久判废 ──
async function testHttpBodyClassification() {
  const originalFetch = global.fetch;
  const htmlUrl = 'https://live.example/anti-bot-page.m3u';
  const junkUrl = 'https://live.example/plain-junk.m3u';
  global.fetch = async (input) => {
    const url = String(input);
    if (url === htmlUrl) {
      return new Response('<!doctype html><html><body>Cloudflare attention required</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response('upstream maintenance message without any live channel', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  };
  try {
    const result = await filterLiveSourcesDetailedForRegression([
      { name: '反爬页面', url: htmlUrl },
      { name: '普通空正文', url: junkUrl },
    ], 1000, undefined, {
      minChannelsPerSource: 1,
      minPlayableRatio: 0,
      maxAdRatio: 1,
    });
    assert(result.valid.length === 0, '2xx responses without playable channels must not be valid');
    assert(
      result.transient.some((source) => source.url === htmlUrl),
      'HTML/anti-bot 2xx responses must stay retryable',
    );
    assert(
      result.transient.some((source) => source.url === junkUrl),
      'ordinary 2xx responses without channels must remain retryable',
    );
  } finally {
    global.fetch = originalFetch;
  }
}

// ── 18d. HTTP 状态分类：仅 404/410 立即判废，其余状态都允许重试 ──
async function testHttpStatusClassification() {
  const originalFetch = global.fetch;
  const transientCodes = [401, 403, 406, 408, 412, 425, 429, 451, 500, 503];
  const invalidCodes = [404, 410];
  const sources = [...transientCodes, ...invalidCodes].map((code) => ({
    name: 'HTTP-' + code,
    url: 'https://live.example/http-status-' + code + '.m3u',
  }));
  global.fetch = async (input) => {
    const match = String(input).match(/http-status-(\d+)\.m3u/);
    const status = match ? Number(match[1]) : 500;
    return new Response('upstream unavailable', {
      status,
      headers: { 'Content-Type': 'text/plain' },
    });
  };
  try {
    const result = await filterLiveSourcesDetailedForRegression(sources, 1000, undefined, {
      minChannelsPerSource: 1,
      minPlayableRatio: 0,
      maxAdRatio: 1,
    });
    const transientUrls = new Set(result.transient.map((source) => source.url));
    const invalidUrls = new Set(result.invalid.map((source) => source.url));
    for (const code of transientCodes) {
      assert(
        transientUrls.has('https://live.example/http-status-' + code + '.m3u'),
        'HTTP ' + code + ' must remain retryable',
      );
    }
    for (const code of invalidCodes) {
      assert(
        invalidUrls.has('https://live.example/http-status-' + code + '.m3u'),
        'HTTP ' + code + ' must be classified as invalid',
      );
    }
  } finally {
    global.fetch = originalFetch;
  }
}

// ── 18d2. 管理端直连路径必须复用同一套失败分类 ──
async function testDirectPathFailureClassification() {
  const originalFetch = global.fetch;
  const htmlUrl = 'https://live.example/direct-anti-bot.m3u';
  const deniedUrl = 'https://live.example/direct-403.m3u';
  global.fetch = async (input) => {
    if (String(input) === htmlUrl) {
      return new Response('<html><body>Verify you are human</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response('forbidden', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
  };
  try {
    const htmlResult = await filterLivesBySourceDetailedForRegression(
      [{ name: '反爬页', url: htmlUrl }],
      1000,
      undefined,
      { useCache: false, minChannelsPerSource: 1, maxAdRatio: 1 },
    );
    assert(htmlResult.groups.length === 0 && htmlResult.failure === 'transient',
      'direct 2xx HTML/anti-bot responses must be retryable');

    const deniedResult = await filterLivesBySourceDetailedForRegression(
      [{ name: '拒绝访问', url: deniedUrl }],
      1000,
      undefined,
      { useCache: false, minChannelsPerSource: 1, maxAdRatio: 1 },
    );
    assert(deniedResult.groups.length === 0 && deniedResult.failure === 'transient',
      'direct HTTP 403 responses must be retryable');
  } finally {
    global.fetch = originalFetch;
  }
}

// ── 18d3. 频道数、广告占比等质量门禁失败不得写成永久 invalid ──
async function testQualityGateFailuresStayTransient() {
  const originalFetch = global.fetch;
  const sourceUrl = 'https://live.example/quality-gate-transient.m3u';
  const sourceText = [
    '直播,#genre#',
    'CCTV-1,http://quality-gate.example/cctv1',
  ].join('\n');
  global.fetch = async () => new Response(sourceText, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
  try {
    const result = await filterLiveSourcesDetailedForRegression(
      [{ name: '质量不足源', url: sourceUrl }],
      1000,
      undefined,
      {
        minChannelsPerSource: 5,
        maxAdRatio: 1,
        maxUrlsPerChannel: 64,
        forceRefresh: true,
      },
    );
    assert(result.valid.length === 0, 'a source below the channel minimum must not be valid');
    assert(result.invalid.length === 0, 'quality gate failure must not be recorded as invalid');
    assert(result.transient.length === 1, 'quality gate failure must remain retryable');
    assert(result.metrics[sourceUrl]?.lastFailure === 'transient',
      'quality gate failure metrics must remain transient');

    const directResult = await filterLivesBySourceDetailedForRegression(
      [{ name: '质量不足源', url: sourceUrl }],
      1000,
      undefined,
      { useCache: false, minChannelsPerSource: 5, maxAdRatio: 1 },
    );
    assert(directResult.groups.length === 0 && directResult.failure === 'transient',
      'direct quality gate failure must remain retryable');
  } finally {
    global.fetch = originalFetch;
  }
}

// ── 18d4. 手动复检必须绕过新鲜缓存，且失败时不得回退旧正文 ──
async function testForceRefreshBypassesCachedLiveText() {
  const originalFetch = global.fetch;
  const sourceUrl = 'https://live.example/force-refresh-cache.m3u';
  const sourceText = [
    '央视,#genre#',
    'CCTV-1,http://force-refresh.example/cctv1',
    'CCTV-2,http://force-refresh.example/cctv2',
    'CCTV-3,http://force-refresh.example/cctv3',
    'CCTV-4,http://force-refresh.example/cctv4',
    'CCTV-5,http://force-refresh.example/cctv5',
  ].join('\n');
  let failUpstream = false;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    if (failUpstream) {
      return new Response('upstream unavailable', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new Response(sourceText, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  };
  const options = {
    minChannelsPerSource: 1,
    maxAdRatio: 1,
    maxUrlsPerChannel: 64,
    useCache: true,
  };
  try {
    const first = await filterLiveSourcesDetailedForRegression(
      [{ name: '缓存源', url: sourceUrl }],
      1000,
      undefined,
      options,
    );
    assert(first.valid.length === 1, 'the first check must download a valid source');
    assert(fetchCalls === 1, 'the first check must contact the upstream once');

    failUpstream = true;
    const cached = await filterLiveSourcesDetailedForRegression(
      [{ name: '缓存源', url: sourceUrl }],
      1000,
      undefined,
      options,
    );
    assert(cached.valid.length === 1, 'a normal check may reuse a fresh successful cache');
    assert(fetchCalls === 1, 'a normal check inside the cache TTL must not contact the upstream');

    const refreshed = await filterLiveSourcesDetailedForRegression(
      [{ name: '缓存源', url: sourceUrl }],
      1000,
      undefined,
      { ...options, forceRefresh: true },
    );
    assert(refreshed.valid.length === 0 && refreshed.transient.length === 1,
      'forceRefresh must expose upstream failure instead of falling back to cached text');
    assert(refreshed.metrics[sourceUrl]?.lastFailure === 'transient',
      'forceRefresh upstream failure must be classified as transient');
    assert(fetchCalls === 3,
      'forceRefresh must make fresh requests for both player and browser UA attempts');
  } finally {
    global.fetch = originalFetch;
  }
}

function testLivePrepareInputFreshness() {
  const inputSet = {
    updatedAt: '2026-11-24T01:00:00.000Z',
    signature: 'https://live.example/freshness.m3u',
    sourceCount: 1,
    sources: [{ name: '新鲜度', url: 'https://live.example/freshness.m3u' }],
  };
  const state = {
    cursor: 1,
    sourceSignature: inputSet.signature,
    inputUpdatedAt: inputSet.updatedAt,
    updatedAt: '2026-11-24T01:01:00.000Z',
    processed: 1,
    total: 1,
    ready: 1,
    failed: 0,
    complete: true,
  };
  assert(
    livePrepareStateMatchesInputs(state, inputSet),
    'complete state with the same signature and input timestamp must be reusable',
  );
  assert(
    !livePrepareStateMatchesInputs(state, {
      ...inputSet,
      updatedAt: '2026-11-24T02:00:00.000Z',
    }),
    'a newer input timestamp must force a new prepare round even when URLs are unchanged',
  );
  assert(
    !livePrepareStateMatchesInputs({ ...state, inputUpdatedAt: '' }, inputSet),
    'legacy complete state without an input timestamp must not be reused',
  );
}

// ── 18e. 当前测速为空只影响本轮下发，不撤销成熟正文 ──
async function testEmptyProbeDoesNotRevokeMatureText() {
  const originalFetch = global.fetch;
  const sourceUrl = 'https://live.example/mature-probe.m3u';
  const key = await liveProxyKey(sourceUrl);
  const lineUrls = Array.from({ length: 5 }, (_, index) =>
    'http://mature-probe.example/cctv-' + index + '.m3u8');
  const sourceText = [
    '央视,#genre#',
    ...lineUrls.map((url, index) => 'CCTV-' + (index + 1) + ',' + url),
  ].join('\n');
  const hardFailureMap = Object.fromEntries(lineUrls.map((url) => [url, {
    speedMs: 0,
    probedAt: '2026-11-24T00:00:00.000Z',
    kind: 'fail',
    failureReason: 'invalid',
    probeVersion: CURRENT_PROBE_VERSION,
    consecutiveFailures: 1,
  }]));
  global.fetch = async () => new Response(sourceText, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
  try {
    const matureMemory = new Map();
    matureMemory.set('live_proxy_manifest', JSON.stringify({
      version: 4,
      signature: 'mature-probe-seed',
      entries: [entry(90, {
        key,
        url: sourceUrl,
        textReady: true,
        successfulAt: '2026-11-23T00:00:00.000Z',
      })],
    }));
    matureMemory.set('live_txt:' + key, '央视,#genre#\nCCTV-1,http://old-mature.example/live');
    const matureStorage = {
      async get(storageKey) { return matureMemory.has(storageKey) ? matureMemory.get(storageKey) : null; },
      async put(storageKey, value) { matureMemory.set(storageKey, String(value)); },
    };
    const matureState = await prepareLiveSourcesChunk(
      [{ name: '成熟源', url: sourceUrl }],
      matureStorage,
      { batchSize: 1, timeoutMs: 1000, concurrency: 1, channelSpeedMap: hardFailureMap },
    );
    const matureManifest = JSON.parse(matureMemory.get('live_proxy_manifest'));
    const matureEntry = matureManifest.entries.find((item) => item.key === key);
    assert(matureState.ready === 0, 'empty current probe must not mark the source ready this round');
    assert(matureEntry?.textReady === true, 'empty current probe must not revoke mature textReady');
    assert(
      isLiveProxyEntryDistributable(matureEntry) === true,
      'mature source with retained text must remain distributable as fallback',
    );

    const freshMemory = new Map();
    const freshStorage = {
      async get(storageKey) { return freshMemory.has(storageKey) ? freshMemory.get(storageKey) : null; },
      async put(storageKey, value) { freshMemory.set(storageKey, String(value)); },
    };
    const freshState = await prepareLiveSourcesChunk(
      [{ name: '新源', url: sourceUrl }],
      freshStorage,
      { batchSize: 1, timeoutMs: 1000, concurrency: 1, channelSpeedMap: hardFailureMap },
    );
    assert(freshState.ready === 0, 'new source without probe evidence must not be ready');
    assert(freshState.failed === 1, 'empty-probe source must count as a retryable failure');
    const freshManifest = JSON.parse(freshMemory.get('live_proxy_manifest'));
    const freshEntry = freshManifest.entries.find((item) => item.key === key);
    assert(freshEntry?.textReady === false, 'new source without text must not claim textReady');
    assert(
      isLiveProxyEntryDistributable(freshEntry) === false,
      'new source without probe evidence must not be distributable',
    );
    assert(freshEntry?.lastFailure === 'transient', 'empty probe must remain a transient failure');
  } finally {
    global.fetch = originalFetch;
  }
}

// ── 18f. 旧 invalid 不是永久死刑：新准备轮次成功下载后恢复成熟源 ──
async function testMatureInvalidSourceRecoversAfterFreshPrepare() {
  const originalFetch = global.fetch;
  const sourceUrl = 'https://live.example/mature-invalid-recovery.m3u';
  const sourceKey = await liveProxyKey(sourceUrl);
  const sourceText = [
    '央视,#genre#',
    'CCTV-1,http://mature-recovery.example/cctv1',
    'CCTV-2,http://mature-recovery.example/cctv2',
    'CCTV-3,http://mature-recovery.example/cctv3',
    'CCTV-4,http://mature-recovery.example/cctv4',
    'CCTV-5,http://mature-recovery.example/cctv5',
  ].join('\n');

  global.fetch = async () => new Response(sourceText, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
  try {
    const memory = new Map();
    memory.set('live_merge_mode', 'separated');
    memory.set('live_prepare_inputs', JSON.stringify({
      updatedAt: '2026-11-24T03:00:00.000Z',
      signature: sourceUrl,
      sourceCount: 1,
      sources: [{ name: '成熟恢复源', url: sourceUrl }],
    }));
    // 线上旧状态的典型形态：complete=true、没有 inputUpdatedAt，且旧清单
    // 曾因瞬态错误被判 invalid，但 successfulAt、everSucceeded 和正文仍在。
    memory.set('live_prepare_state', JSON.stringify({
      cursor: 1,
      sourceSignature: sourceUrl,
      updatedAt: '2026-11-23T00:00:00.000Z',
      processed: 1,
      total: 1,
      ready: 0,
      failed: 1,
      complete: true,
    }));
    memory.set('live_proxy_manifest', JSON.stringify({
      version: 4,
      signature: 'old-invalid-state',
      entries: [entry(91, {
        key: sourceKey,
        url: sourceUrl,
        name: '成熟恢复源',
        health: 'unhealthy',
        consecutiveFailures: 1,
        lastFailure: 'invalid',
        textReady: false,
        everSucceeded: true,
        successfulAt: '2026-11-20T00:00:00.000Z',
      })],
    }));
    memory.set('live_txt:' + sourceKey, '央视,#genre#\n旧频道,http://old.example/live');

    const storage = {
      async get(key) { return memory.has(key) ? memory.get(key) : null; },
      async put(key, value) { memory.set(key, String(value)); },
    };
    const result = await runLivePrepareChunk(storage, {
      batchSize: 1,
      timeoutMs: 1000,
      concurrency: 1,
    });

    const persisted = JSON.parse(memory.get('live_prepare_state'));
    const manifest = JSON.parse(memory.get('live_proxy_manifest'));
    const recovered = manifest.entries.find((item) => item.key === sourceKey);
    assert(persisted.inputUpdatedAt === '2026-11-24T03:00:00.000Z',
      'the fresh prepare round must persist the input timestamp');
    assert(result.state.complete === true && result.state.ready === 1,
      'a mature source recovered from a fresh download must complete as ready');
    assert(recovered?.textReady === true,
      'a successful fresh prepare must restore textReady after a stale invalid classification');
    assert(recovered?.lastFailure === undefined && recovered?.health === 'healthy',
      'a successful fresh prepare must clear the transient/invalid failure state');
    assert(recovered?.everSucceeded === true && recovered?.successfulAt,
      'mature success history must survive the recovery round');
    assert(isLiveProxyEntryDistributable(recovered),
      'the recovered mature source must re-enter the delivery pool');
    assert((memory.get('live_txt:' + sourceKey) || '').includes('mature-recovery.example/cctv1'),
      'the source text must be regenerated from the fresh successful response');
    assert(result.runtimeGroups
      .flatMap((group) => group.channels)
      .some((channel) => channel.name === 'CCTV-1'),
      'the recovered source must be usable by runtime output');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testRecoverableProbeFailuresSurvivePrebuild() {
  const originalFetch = global.fetch;
  const sourceUrl = 'https://live.example/recoverable-failures.m3u';
  const sourceText = [
    '直播,#genre#',
    '瞬时超时,http://timeout-once.example/live',
    '瞬时网络,http://network-twice.example/live',
    '旧版误判,http://legacy-failed.example/live',
    '未知线路,http://unknown.example/live',
    '额外未知,http://unknown-extra.example/live',
    '硬失败,http://hard-failed.example/live',
    'HTTP瞬时失败,http://http-failed.example/live',
    'HTTP连续失败,http://http-hard-failed.example/live',
    '无效内容,http://invalid.example/live',
  ].join('\n');
  const channelSpeedMap = {
    'http://timeout-once.example/live': {
      speedMs: 0, probedAt: '2026-11-24T00:00:00.000Z', kind: 'fail',
      failureReason: 'timeout', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 1,
    },
    'http://network-twice.example/live': {
      speedMs: 0, probedAt: '2026-11-24T00:00:00.000Z', kind: 'fail',
      failureReason: 'network', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 2,
    },
    'http://legacy-failed.example/live': {
      speedMs: 0, probedAt: '2026-11-20T00:00:00.000Z', kind: 'fail',
      failureReason: 'invalid', probeVersion: CURRENT_PROBE_VERSION - 1, consecutiveFailures: 9,
    },
    'http://hard-failed.example/live': {
      speedMs: 0, probedAt: '2026-11-24T00:00:00.000Z', kind: 'fail',
      failureReason: 'timeout', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 3,
    },
    'http://http-failed.example/live': {
      speedMs: 0, probedAt: '2026-11-24T00:00:00.000Z', kind: 'fail',
      failureReason: 'http', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 1,
    },
    'http://http-hard-failed.example/live': {
      speedMs: 0, probedAt: '2026-11-24T00:00:00.000Z', kind: 'fail',
      failureReason: 'http', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 3,
    },
    'http://invalid.example/live': {
      speedMs: 0, probedAt: '2026-11-24T00:00:00.000Z', kind: 'fail',
      failureReason: 'invalid', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 1,
    },
  };

  global.fetch = async () => new Response(sourceText, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
  try {
    const memory = new Map();
    const storage = {
      async get(key) { return memory.has(key) ? memory.get(key) : null; },
      async put(key, value) { memory.set(key, String(value)); },
    };
    const state = await prepareLiveSourcesChunk(
      [{ name: '恢复源', url: sourceUrl }],
      storage,
      { batchSize: 1, timeoutMs: 1000, concurrency: 1, channelSpeedMap },
    );
    assert(state.ready === 1, 'source with only recoverable failures must stay ready after prebuild');

    const text = Array.from(memory.entries())
      .find(([key]) => key.startsWith('live_txt:'))?.[1] || '';
    assert(text.includes('timeout-once.example'), 'one-time timeout must survive source prebuild');
    assert(text.includes('network-twice.example'), 'two-time network failure must survive source prebuild');
    assert(text.includes('legacy-failed.example'), 'legacy failure must survive until the current probe rechecks it');
    assert(text.includes('unknown.example'), 'unknown line must survive source prebuild');
    assert(text.includes('http-failed.example'), 'one-time HTTP failure must survive source prebuild as fallback');
    assert(text.includes('hard-failed.example'), 'three-time timeout must survive source prebuild for a later recovery probe');
    assert(text.includes('http-hard-failed.example'), 'three-time HTTP failure must survive source prebuild for a later recovery probe');
    assert(!text.includes('invalid.example'), 'invalid content must be removed from source prebuild');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testTransientFailuresDoNotDiscardSource() {
  const originalFetch = global.fetch;
  const sourceUrl = 'https://live.example/transient-ratio.m3u';
  const transientUrls = Array.from({ length: 5 }, (_, index) => `http://quality-transient-${index}.example/live`);
  const sourceText = [
    '直播,#genre#',
    ['质量频道,http://quality-success.example/live', ...transientUrls].join('#'),
    '频道二,http://quality-unknown-2.example/live',
    '频道三,http://quality-unknown-3.example/live',
    '频道四,http://quality-unknown-4.example/live',
    '频道五,http://quality-unknown-5.example/live',
  ].join('\n');
  const channelSpeedMap = {
    'http://quality-success.example/live': {
      speedMs: 120, probedAt: '2026-11-24T00:00:00.000Z', kind: 'm3u8',
      verification: 'media', probeVersion: CURRENT_PROBE_VERSION,
    },
    ...Object.fromEntries(transientUrls.map((url) => [url, {
      speedMs: 0, probedAt: '2026-11-24T00:00:00.000Z', kind: 'fail',
      failureReason: 'timeout', probeVersion: CURRENT_PROBE_VERSION, consecutiveFailures: 1,
    }])),
  };

  global.fetch = async () => new Response(sourceText, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
  try {
    const result = await filterLiveSourcesDetailedForRegression(
      [{ name: '瞬时失败源', url: sourceUrl }],
      1000,
      channelSpeedMap,
      {
        minChannelsPerSource: 5,
        minPlayableRatio: 0.2,
        maxAdRatio: 1,
        maxUrlsPerChannel: 64,
      },
    );
    assert(result.valid.length === 1, 'transient failures must not make the whole source look unplayable');
    assert(result.texts[sourceUrl].includes('quality-success.example'), 'verified line must remain in the source text');
    assert(result.texts[sourceUrl].includes('quality-transient-0.example'), 'transient failures must remain as fallback lines');
  } finally {
    global.fetch = originalFetch;
  }
}

// ── 18b. 单源复检使用与批量一致的成熟正文保护 ──
async function testManualValidationFailure() {
  const memory = new Map();
  const ready = entry(52, { key: 'manual-fail', url: 'https://live.example/manual-fail.txt' });
  memory.set('live_proxy_manifest', JSON.stringify({
    version: 4,
    signature: 'manual-fail-seed',
    entries: [ready],
  }));
  const storage = {
    async get(key) { return memory.has(key) ? memory.get(key) : null; },
    async put(key, value) { memory.set(key, String(value)); },
  };
  const { recordLiveProxyValidation } = require(outfile);
  const firstFailure = await recordLiveProxyValidation('manual-fail', 'transient', storage);
  assert(firstFailure?.consecutiveFailures === 1 && firstFailure?.textReady === true,
    'the first manual transient failure must preserve mature text');
  assert(isLiveProxyEntryDistributable(firstFailure) === true,
    'the first manual transient failure must leave the mature source distributable');

  const secondFailure = await recordLiveProxyValidation('manual-fail', 'transient', storage);
  assert(secondFailure?.consecutiveFailures === 2 && secondFailure?.textReady === true,
    'the second manual transient failure must still preserve mature text');

  const thirdFailure = await recordLiveProxyValidation('manual-fail', 'transient', storage);
  assert(thirdFailure?.consecutiveFailures === 3 && thirdFailure?.textReady === true,
    'the third manual transient failure must preserve mature text');
  assert(isLiveProxyEntryDistributable(thirdFailure) === true,
    'the third manual transient failure must leave the mature source distributable');
  const persisted = JSON.parse(memory.get('live_proxy_manifest'));
  assert(persisted.entries[0].textReady === true
    && persisted.entries[0].consecutiveFailures === 3,
  'the retained mature text and failure count must be persisted');

  const explicitInvalid = await recordLiveProxyValidation('manual-fail', 'invalid', storage);
  assert(explicitInvalid?.lastFailure === 'invalid'
    && explicitInvalid?.failureRuleVersion === LIVE_PROXY_FAILURE_RULE_VERSION,
  'current-rule invalid evidence must be persisted with its rule version');
  assert(explicitInvalid?.textReady === false,
    'current-rule invalid evidence must revoke mature text');
  assert(isLiveProxyEntryDistributable(explicitInvalid) === false,
    'current-rule invalid evidence must leave the source non-distributable');

  const recovered = await recordLiveProxyValidation('manual-fail', 'valid', storage);
  assert(recovered?.lastFailure === undefined
    && recovered?.failureRuleVersion === undefined,
  'a later valid probe must clear both failure state and its rule version');
  assert(recovered?.textReady === false,
    'a valid probe alone must not claim that aggregate text has been rebuilt');
  assert(isLiveProxyEntryDistributable(recovered) === false,
    'delivery must wait for a successful text rebuild after invalid revoked mature text');
}

// ── 19. 非增量 texts 更新仍是权威快照：缺失文本必须撤销 ──
const authoritativeTexts = mergeLiveProxyManifest(
  incrementalBase,
  incrementalBase.entries.map((item) => ({ ...item, textReady: undefined })),
  {
    checkedAt: '2026-10-13T02:02:00.000Z',
    validUrls: ['https://live.example/50.txt'],
    texts: { 'https://live.example/50.txt': '央视,#genre#\nCCTV-1,http://50-new.example/live' },
    fullSnapshot: true,
  },
);
assert(
  authoritativeTexts.entries.find((item) => item.key === 'key-51')?.textReady === false,
  'authoritative text update must revoke missing text',
);
assert(
  isLiveProxyEntryDistributable(authoritativeTexts.entries.find((item) => item.key === 'key-51')) === false,
  'revoked authoritative text must not remain distributable',
);


// ── 19b. Node 启动修复：旧清单已有完整正文时恢复 textReady ──
async function testStartupReadinessRepair() {
  const memory = new Map();
  const legacyEntries = [
    entry(70, { key: 'legacy-ready', url: 'https://live.example/legacy-ready.txt', textReady: false }),
    entry(71, { key: 'legacy-empty', url: 'https://live.example/legacy-empty.txt', textReady: false }),
    entry(72, {
      key: 'legacy-invalid',
      url: 'https://live.example/legacy-invalid.txt',
      textReady: false,
      consecutiveFailures: 3,
      lastFailure: 'invalid',
    }),
    entry(73, { key: 'legacy-blocked', url: 'https://live.example/legacy-blocked.txt', textReady: false, name: '音乐所' }),
    entry(74, {
      key: 'current-invalid',
      url: 'https://live.example/current-invalid.txt',
      textReady: false,
      lastFailure: 'invalid',
      failureRuleVersion: LIVE_PROXY_FAILURE_RULE_VERSION,
    }),
  ];
  memory.set('live_proxy_manifest', JSON.stringify({
    version: 5,
    signature: 'legacy-readiness',
    entries: legacyEntries,
  }));
  memory.set('live_txt:legacy-ready', '央视,#genre#\nCCTV-1,http://legacy.example/live');
  memory.set('live_txt:legacy-invalid', '央视,#genre#\nCCTV-1,http://invalid.example/live');
  memory.set('live_txt:legacy-blocked', '央视,#genre#\nCCTV-1,http://blocked.example/live');
  memory.set('live_txt:current-invalid', '央视,#genre#\nCCTV-1,http://current-invalid.example/live');
  const storage = {
    async get(key) { return memory.has(key) ? memory.get(key) : null; },
    async put(key, value) { memory.set(key, String(value)); },
  };
  const { repairLiveProxyTextReadiness } = require(outfile);
  const repaired = await repairLiveProxyTextReadiness(storage);
  assert(repaired.changed === true, 'startup repair must persist a changed manifest');
  assert(repaired.repaired === 2, 'startup repair must restore eligible ready and legacy-invalid sources');
  assert(repaired.revoked === 0, 'startup repair must not revoke already false entries');
  assert(repaired.distributable === 2, 'startup repair must expose only the recoverable sources');
  const persisted = JSON.parse(memory.get('live_proxy_manifest'));
  const byKey = new Map(persisted.entries.map((item) => [item.key, item]));
  assert(byKey.get('legacy-ready')?.textReady === true, 'startup repair must restore source with valid text');
  assert(byKey.get('legacy-empty')?.textReady === false, 'startup repair must not restore source without text');
  assert(byKey.get('legacy-invalid')?.textReady === true,
    'legacy invalid evidence must not permanently block an existing complete text');
  assert(byKey.get('legacy-invalid')?.lastFailure === 'transient'
    && byKey.get('legacy-invalid')?.consecutiveFailures === 0,
  'legacy invalid must migrate to retryable transient without old failure counts');
  assert(byKey.get('legacy-blocked')?.textReady === false, 'startup repair must not restore blocked source');
  assert(byKey.get('current-invalid')?.textReady === false,
    'current-rule invalid evidence must not be restored from stale text');
  assert(isLiveProxyEntryDistributable(byKey.get('legacy-ready')) === true, 'restored source must be distributable');
  assert(isLiveProxyEntryDistributable(byKey.get('legacy-empty')) === false, 'textless source must remain non-distributable');
  assert(isLiveProxyEntryDistributable(byKey.get('legacy-invalid')) === true,
    'migrated legacy invalid source must become distributable when complete text exists');
  assert(isLiveProxyEntryDistributable(byKey.get('legacy-blocked')) === false, 'blocked source must remain non-distributable');
  assert(isLiveProxyEntryDistributable(byKey.get('current-invalid')) === false,
    'current-rule invalid source must remain non-distributable');
  assert(persisted.version === 5, 'startup repair must persist manifest version 5');
}


async function testRuntimeCacheIsUnified() {
  const memory = new Map();
  memory.set('live_merge_mode', 'separated');
  memory.set('live_runtime_txt', '旧,#genre#\n旧频道,http://old.example/live');
  memory.set('live_proxy_manifest', JSON.stringify({
    version: 1,
    signature: 'runtime-unified',
    entries: [entry(80, { key: '1234567890abcdef', name: '源R', url: 'https://live.example/runtime.txt', textReady: true })],
  }));
  memory.set('live_txt:1234567890abcdef', '央视,#genre#\nCCTV-1,http://runtime.example/live$源R#12345678');
  memory.set('channel_merged_tree', JSON.stringify([{ group: '央视', channels: [{ name: 'CCTV-1', urls: ['http://runtime.example/live$源R#12345678'] }] }]));
  memory.set('channel_speed_map', JSON.stringify({ 'http://runtime.example/live': { speedMs: 100, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION } }));
  const storage = {
    async get(key) { return memory.has(key) ? memory.get(key) : null; },
    async put(key, value) { memory.set(key, String(value)); },
  };
  const { rebuildLiveOutput } = require(outputOutfile);
  const rebuilt = await rebuildLiveOutput(storage);
  assert(rebuilt.txt.includes('央视,#genre#'), 'runtime rebuild must produce aggregate txt');
  assert(memory.get('live_runtime_txt') === rebuilt.txt, 'runtime cache must be overwritten with unified output');
  assert(memory.get('live_runtime_txt_version') === rebuilt.version, 'runtime cache version must match unified output');
  assert(!memory.get('live_runtime_txt').includes('旧频道'), 'stale runtime cache must not survive rebuild');
}

async function testBareUrlCandidateMapping() {
  const memory = new Map();
  const key = 'bare-url-source';
  memory.set('live_merge_mode', 'separated');
  memory.set('live_proxy_manifest', JSON.stringify({
    version: 4,
    signature: 'bare-url-source',
    entries: [entry(81, {
      key,
      name: '裸URL源',
      url: 'https://live.example/bare.txt',
      textReady: true,
      health: 'healthy',
      everSucceeded: true,
      successfulAt: '2026-10-13T00:00:00.000Z',
    })],
  }));
  memory.set('live_txt:' + key, '央视,#genre#\nCCTV-1,http://runtime.example/live');
  memory.set('channel_merged_tree', JSON.stringify([
    { group: '央视', channels: [{ name: 'CCTV-1', urls: ['http://runtime.example/live'] }] },
    { group: '地方', channels: [{ name: '上海', urls: ['http://other.example/live'] }] },
  ]));
  memory.set('channel_speed_map', JSON.stringify({ 'http://runtime.example/live': { speedMs: 100, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION } }));
  const storage = {
    async get(k) { return memory.has(k) ? memory.get(k) : null; },
    async put(k, value) { memory.set(k, String(value)); },
  };
  const { rebuildLiveOutput } = require(outputOutfile);
  const rebuilt = await rebuildLiveOutput(storage, {
    policy: { selectionMode: 'simple', maxSources: -1 },
  });
  assert(rebuilt.txt.includes('央视,#genre#'), 'bare-url mapping must keep selected group');
  assert(rebuilt.txt.includes('http://runtime.example/live'), 'bare-url mapping must keep selected url');
  assert(!rebuilt.txt.includes('http://other.example/live'), 'bare-url mapping must not leak unselected url');
  assert(memory.get('live_runtime_txt') === rebuilt.txt, 'bare-url mapping must refresh runtime txt');
  assert(memory.get('live_merged_txt') === rebuilt.txt, 'bare-url mapping must refresh merged txt');
  assert(memory.get('live_runtime_txt_version') === rebuilt.version, 'bare-url mapping must refresh runtime version');
  assert(memory.get('live_merged_txt_version') === rebuilt.version, 'bare-url mapping must refresh merged version');
}

async function testSelectedSourceTextFillsPartialCandidateTree() {
  const key = 'selected-text-coverage-source';
  const cctv1Urls = [
    'http://74.91.26.218:82/live/cctv1hd.m3u8',
    ...Array.from(
      { length: 11 },
      (_, index) => `http://74.91.26.218:82/live/cctv1-${index + 1}.m3u8`,
    ),
  ];
  const cctv3Url = 'http://74.91.26.218:82/live/cctv3hd.m3u8';
  const unselectedUrl = 'http://unselected.example/cctv5.m3u8';
  const sourceGroups = [{
    group: '央视',
    channels: [
      { name: 'CCTV1綜合', urls: cctv1Urls },
      { name: 'CCTV-3', urls: [cctv3Url] },
    ],
  }];
  const speedMap = Object.fromEntries(
    [...cctv1Urls, cctv3Url].map((url, index) => [
      url,
      {
        speedMs: 100 + index,
        probedAt: '2026-11-24T00:00:00.000Z',
        kind: 'm3u8',
        verification: 'media',
        probeVersion: CURRENT_PROBE_VERSION,
      },
    ]),
  );

  for (const candidateCctv3Url of [cctv3Url, cctv3Url + '$简单TV#c5edfeb6']) {
    const memory = new Map();
    memory.set('live_merge_mode', 'separated');
    memory.set('live_proxy_manifest', JSON.stringify({
      version: 4,
      signature: 'selected-text-coverage-' + candidateCctv3Url.includes('$'),
      entries: [entry(85, {
        key,
        name: '简单TV',
        url: 'https://live.example/selected-text-coverage.txt',
        textReady: true,
        health: 'healthy',
        everSucceeded: true,
        successfulAt: '2026-11-24T00:00:00.000Z',
      })],
    }));
    memory.set('live_txt:' + key, formatAggregatedLiveGroupsAsTxt(sourceGroups));
    memory.set('channel_merged_tree', JSON.stringify([{
      group: '央视',
      channels: [
        { name: 'CCTV-3', urls: [candidateCctv3Url] },
        { name: 'CCTV-5', urls: [unselectedUrl] },
      ],
    }]));
    memory.set('channel_speed_map', JSON.stringify(speedMap));
    const storage = {
      async get(k) { return memory.has(k) ? memory.get(k) : null; },
      async put(k, value) { memory.set(k, String(value)); },
    };
    const { rebuildLiveOutput } = require(outputOutfile);
    const getChannel = (rebuilt, name) => rebuilt.groups
      .flatMap((group) => group.channels)
      .find((channel) => channel.name === name);

    const nine = await rebuildLiveOutput(storage, {
      policy: { selectionMode: 'simple', maxSources: -1, maxUrlsPerChannel: 9 },
    });
    const nineCctv1 = getChannel(nine, 'CCTV-1');
    const nineCctv3 = getChannel(nine, 'CCTV-3');
    assert(nineCctv1?.urls.length === 9,
      'partial candidate tree must not hide selected source CCTV-1 lines');
    assert(nineCctv3?.urls.length === 1,
      'selected source text must fill a channel missing from the candidate tree');
    assert(!nine.txt.includes(unselectedUrl),
      'merging selected source text must not leak an unselected candidate URL');

    const wider = await rebuildLiveOutput(storage, {
      policy: { selectionMode: 'simple', maxSources: -1, maxUrlsPerChannel: 15 },
    });
    const all = await rebuildLiveOutput(storage, {
      policy: { selectionMode: 'simple', maxSources: -1, maxUrlsPerChannel: -1 },
    });
    const widerCctv1 = getChannel(wider, 'CCTV-1');
    const allCctv1 = getChannel(all, 'CCTV-1');
    assert(widerCctv1?.urls.length === 12 && allCctv1?.urls.length === 12,
      'all selected source lines must remain available after partial-tree recovery');
    assert(JSON.stringify(widerCctv1?.urls.slice(0, 9)) === JSON.stringify(nineCctv1?.urls)
      && JSON.stringify(allCctv1?.urls.slice(0, 9)) === JSON.stringify(nineCctv1?.urls),
    '9, 15 and All must share one quality-ordered channel prefix after recovery');
  }
}

async function testMergedLiveOutputLimitsEachChannel() {
  const memory = new Map();
  const key = 'merged-channel-limit-source';
  const channelTree = [{
    group: '央视',
    channels: [
      { name: 'CCTV-1', urls: ['http://cctv1.example/1', 'http://cctv1.example/2', 'http://cctv1.example/3', 'http://cctv1.example/4'] },
      { name: 'CCTV-2', urls: ['http://cctv2.example/1', 'http://cctv2.example/2', 'http://cctv2.example/3', 'http://cctv2.example/4'] },
    ],
  }, {
    // 上游常把同一频道拆在多个分组对象里。最终配额必须跨分组合并后共享，
    // 不能每个对象各保留 N 条后在 TXT 中再次叠回 2N 条。
    group: 'CCTV',
    channels: [
      { name: 'CCTV1', urls: ['http://cctv1.example/5', 'http://cctv1.example/6', 'http://cctv1.example/7', 'http://cctv1.example/8'] },
    ],
  }];
  memory.set('live_merge_mode', 'merged');
  memory.set('live_proxy_manifest', JSON.stringify({
    version: 4,
    signature: 'merged-channel-limit',
    entries: [entry(83, {
      key,
      name: '聚合源',
      url: 'https://live.example/merged-limit.txt',
      textReady: true,
      health: 'healthy',
      everSucceeded: true,
      successfulAt: '2026-10-13T00:00:00.000Z',
    })],
  }));
  memory.set('live_txt:' + key, formatAggregatedLiveGroupsAsTxt(channelTree));
  memory.set('channel_merged_tree', JSON.stringify(channelTree));
  memory.set('channel_speed_map', JSON.stringify(Object.fromEntries(
    channelTree
      .flatMap((group) => group.channels.flatMap((channel) => channel.urls))
      .map((url, i) => [url, { speedMs: 100 + i, probedAt: '2026-11-03T00:00:00.000Z', kind: 'm3u8', verification: 'media', probeVersion: CURRENT_PROBE_VERSION }]),
  )));
  const storage = {
    async get(k) { return memory.has(k) ? memory.get(k) : null; },
    async put(k, value) { memory.set(k, String(value)); },
  };
  const { rebuildLiveOutput } = require(outputOutfile);

  const limited = await rebuildLiveOutput(storage, {
    policy: { selectionMode: 'simple', maxSources: -1, maxUrlsPerChannel: 2 },
  });
  assert(limited.groups.every((group) => group.channels.every((channel) => channel.urls.length === 2)), 'merged rebuild must apply the configured per-channel URL limit independently');
  assert(limited.groups[0].channels[0].urls.join(',') === 'http://cctv1.example/1,http://cctv1.example/2', 'merged rebuild must keep the top lines in existing quality order');
  assert(countTxtChannelUrls(limited.txt, 'CCTV-1') === 2, 'merged output must enforce one canonical-channel quota across source groups');
  assert(memory.get('channel_runtime_tree') === JSON.stringify(limited.groups), 'merged rebuild must persist the limited channel tree');

  const all = await rebuildLiveOutput(storage, {
    policy: { selectionMode: 'simple', maxSources: -1, maxUrlsPerChannel: -1 },
  });
  const allCctv1 = all.groups.flatMap((group) => group.channels).find((channel) => channel.name === 'CCTV-1');
  assert(allCctv1 && allCctv1.urls.length === 8, 'merged rebuild with -1 must persist every canonical-channel preferred line');
  assert(countTxtChannelUrls(all.txt, 'CCTV-1') === 8, 'merged rebuild with -1 must keep every unique preferred line after channel merge');
  assert(memory.get('channel_runtime_tree') === JSON.stringify(all.groups), 'merged rebuild must replace the limited tree when All is selected');

  const duplicateSingleGroup = [{
    group: '央视',
    channels: [
      { name: 'CCTV-1', urls: ['http://dup.example/1', 'http://dup.example/2'] },
      { name: '[HD]CCTV1', urls: ['http://dup.example/3', 'http://dup.example/4'] },
    ],
  }];
  const duplicateLimitedTxt = formatAggregatedLiveGroupsAsTxt(duplicateSingleGroup, 3);
  assert(countTxtChannelUrls(duplicateLimitedTxt, 'CCTV-1') === 3, 'duplicate channel objects in one group must also share the final quota');
  const duplicateAllTxt = formatAggregatedLiveGroupsAsTxt(duplicateSingleGroup, -1);
  assert(countTxtChannelUrls(duplicateAllTxt, 'CCTV-1') === 4, 'aggregate formatter with -1 must keep all merged unique lines');
}

async function testConfiguredOutputLimitInBothModes() {
  const key = 'configured-channel-limit-source';
  const urls = Array.from({ length: 12 }, (_, index) => `http://configured-limit.example/cctv1/${index + 1}.m3u8`);
  const channelTree = [{
    group: '央视',
    channels: [{ name: 'CCTV-1', urls }],
  }];
  const speedMap = Object.fromEntries(urls.map((url, index) => [
    url,
    {
      speedMs: 100 + index,
      probedAt: '2026-11-03T00:00:00.000Z',
      kind: 'm3u8',
      verification: 'media',
      probeVersion: CURRENT_PROBE_VERSION,
    },
  ]));

  for (const mode of ['separated', 'merged']) {
    const memory = new Map();
    memory.set('live_merge_mode', mode);
    memory.set('live_proxy_manifest', JSON.stringify({
      version: 4,
      signature: 'configured-channel-limit-' + mode,
      entries: [entry(84, {
        key,
        name: '配置限额源',
        url: 'https://live.example/configured-limit.txt',
        textReady: true,
      })],
    }));
    memory.set('live_txt:' + key, formatAggregatedLiveGroupsAsTxt(channelTree));
    memory.set('channel_merged_tree', JSON.stringify(channelTree));
    memory.set('channel_speed_map', JSON.stringify(speedMap));
    const storage = {
      async get(k) { return memory.has(k) ? memory.get(k) : null; },
      async put(k, value) { memory.set(k, String(value)); },
    };
    const { rebuildLiveOutput } = require(outputOutfile);
    const nine = await rebuildLiveOutput(storage, {
      policy: { selectionMode: 'simple', maxSources: -1, maxUrlsPerChannel: 9 },
    });
    assert(countTxtChannelUrls(nine.txt, 'CCTV-1') === 9,
      mode + ' output must use the configured nine-line limit instead of the legacy six-line cap');
    const nineUrls = nine.groups.flatMap((group) => group.channels)
      .find((channel) => channel.name === 'CCTV-1')?.urls || [];
    const wider = await rebuildLiveOutput(storage, {
      policy: { selectionMode: 'simple', maxSources: -1, maxUrlsPerChannel: 15 },
    });
    const widerUrls = wider.groups.flatMap((group) => group.channels)
      .find((channel) => channel.name === 'CCTV-1')?.urls || [];
    assert(widerUrls.length === 12, mode + ' output with a wider limit must retain every available verified line');
    assert(JSON.stringify(widerUrls.slice(0, 9)) === JSON.stringify(nineUrls),
      mode + ' nine-line output must be a strict prefix of the same global quality ordering');
  }
}

async function testEmptyRebuildKeepsPreviousCache() {
  const memory = new Map();
  const key = 'mapping-miss-source';
  const previousTxt = '旧,#genre#\n旧频道,http://old.example/live';
  memory.set('live_merge_mode', 'separated');
  memory.set('live_runtime_txt', previousTxt);
  memory.set('live_merged_txt', previousTxt);
  memory.set('live_runtime_txt_version', 'old-runtime-version');
  memory.set('live_merged_txt_version', 'old-merged-version');
  memory.set('live_output_fingerprint', 'old-fingerprint');
  memory.set('live_proxy_manifest', JSON.stringify({
    version: 4,
    signature: 'mapping-miss-source',
    entries: [entry(82, {
      key,
      name: '失配源',
      url: 'https://live.example/missing.txt',
      textReady: true,
      health: 'healthy',
      everSucceeded: true,
      successfulAt: '2026-10-13T00:00:00.000Z',
    })],
  }));
  memory.set('channel_merged_tree', JSON.stringify([
    { group: '央视', channels: [{ name: 'CCTV-1', urls: ['http://candidate.example/live'] }] },
  ]));
  const storage = {
    async get(k) { return memory.has(k) ? memory.get(k) : null; },
    async put(k, value) { memory.set(k, String(value)); },
  };
  const { rebuildLiveOutput } = require(outputOutfile);
  let failed = false;
  try {
    await rebuildLiveOutput(storage, {
      policy: { selectionMode: 'simple', maxSources: -1 },
    });
  } catch {
    failed = true;
  }
  assert(failed, 'empty rebuild must fail instead of writing empty output');
  assert(memory.get('live_runtime_txt') === previousTxt, 'failed rebuild must keep previous runtime txt');
  assert(memory.get('live_merged_txt') === previousTxt, 'failed rebuild must keep previous merged txt');
  assert(memory.get('live_output_fingerprint') === 'old-fingerprint', 'failed rebuild must keep previous fingerprint');
}

async function testCanonicalChannelLimitAfterPlaybackRanking() {
  const memory = new Map();
  const key = 'canonical-nine-line-source';
  const failedLines = Array.from({ length: 9 }, (_, i) => 'http://bad-' + i + '.example/live');
  const playableLines = Array.from({ length: 9 }, (_, i) => 'http://good-' + i + '.example/live');
  const candidateGroups = [{
    group: '央视',
    channels: [{ name: 'CCTV-1', urls: failedLines }],
  }, {
    group: 'CCTV',
    channels: [{ name: 'CCTV1', urls: playableLines }],
  }];
  const speedMap = Object.fromEntries(playableLines.map((url, i) => [url, {
    speedMs: 900 + i,
    probedAt: '2026-11-03T00:00:00.000Z',
    kind: 'm3u8',
    verification: 'media',
    probeVersion: CURRENT_PROBE_VERSION,
  }]));
  memory.set('live_merge_mode', 'merged');
  memory.set('channel_merged_tree', JSON.stringify(candidateGroups));
  memory.set('channel_speed_map', JSON.stringify(speedMap));
  memory.set('live_proxy_manifest', JSON.stringify({
    version: 4,
    signature: 'canonical-nine-line',
    entries: [entry(84, {
      key,
      name: '九线路源',
      url: 'https://live.example/canonical-nine.txt',
      textReady: true,
      health: 'healthy',
      everSucceeded: true,
      successfulAt: '2026-11-03T00:00:00.000Z',
    })],
  }));
  memory.set('live_txt:' + key, formatAggregatedLiveGroupsAsTxt(candidateGroups));
  const storage = {
    async get(k) { return memory.has(k) ? memory.get(k) : null; },
    async put(k, value) { memory.set(k, String(value)); },
  };
  const { rebuildLiveOutput } = require(outputOutfile);
  const rebuilt = await rebuildLiveOutput(storage, {
    policy: { selectionMode: 'simple', maxSources: -1, maxUrlsPerChannel: 9 },
  });
  const cctv1 = rebuilt.groups.flatMap((group) => group.channels).find((channel) => channel.name === 'CCTV-1');
  assert(cctv1 && cctv1.urls.length === 9, 'canonical channel must contain exactly nine lines');
  assert(cctv1.urls.every((url) => playableLines.some((playable) => url.includes(playable))), 'duplicate channel objects must not fill the quota before media-verified lines are ranked');
  assert(countTxtChannelUrls(rebuilt.txt, 'CCTV-1') === 9, 'TXT output must keep exactly nine playable lines for the canonical channel');
}

async function testLiveFingerprintIncludesCategoryPins() {
  const storage = { async get() { return null; } };
  const basePolicy = {
    selectionMode: 'category',
    maxSources: -1,
    bucketLimits: { cctv: 1 },
    pinnedKeys: [],
    categoryPinnedKeys: [],
    blockedKeys: [],
  };
  const baseline = await computeLiveOutputFingerprint(storage, basePolicy);
  const categoryPinned = await computeLiveOutputFingerprint(storage, {
    ...basePolicy,
    categoryPinnedKeys: ['k3'],
  });
  const globallyPinned = await computeLiveOutputFingerprint(storage, {
    ...basePolicy,
    pinnedKeys: ['k3'],
  });
  const channelUrlLimited = await computeLiveOutputFingerprint(storage, {
    ...basePolicy,
    maxUrlsPerChannel: 2,
  });
  assert(baseline !== categoryPinned, 'category pin changes must change live output fingerprint');
  assert(baseline !== globallyPinned, 'global pin changes must change live output fingerprint');
  assert(categoryPinned !== globallyPinned, 'global and category pin scopes must have distinct live output fingerprints');
  assert(baseline !== channelUrlLimited, 'per-channel URL limit changes must change live output fingerprint');
}

async function main() {
  await testMergedLiveOutputLimitsEachChannel();
  await testCanonicalChannelLimitAfterPlaybackRanking();
  await testConfiguredOutputLimitInBothModes();
  await testLiveFingerprintIncludesCategoryPins();
  await testHttpBodyClassification();
  await testHttpStatusClassification();
  await testDirectPathFailureClassification();
  await testQualityGateFailuresStayTransient();
  await testForceRefreshBypassesCachedLiveText();
  testLivePrepareInputFreshness();
  await testEmptyProbeDoesNotRevokeMatureText();
  await testMatureInvalidSourceRecoversAfterFreshPrepare();
  await testRecoverableProbeFailuresSurvivePrebuild();
  await testTransientFailuresDoNotDiscardSource();
  await testManualValidationFailure();
  await testStartupReadinessRepair();
  await testRuntimeCacheIsUnified();
  await testBareUrlCandidateMapping();
  await testSelectedSourceTextFillsPartialCandidateTree();
  await testEmptyRebuildKeepsPreviousCache();
  // ── 20. 源码裁剪：manifest 只保留允许 URL，不写入空 live:<key> ──
  const memory = new Map();
  memory.set('live_proxy_manifest', JSON.stringify({
    version: 4,
    signature: 'prune-source',
    entries: [
      entry(60, { key: 'prune-keep', url: 'https://live.example/keep.txt' }),
      entry(61, { key: 'prune-drop', url: 'https://live.example/drop.txt' }),
    ],
  }));
  memory.set('live:prune-drop', JSON.stringify({ url: 'https://live.example/drop.txt' }));
  memory.set('live_txt:prune-drop', '旧,#genre#\n频道,http://old.example/live');
  const storage = {
    async get(key) { return memory.has(key) ? memory.get(key) : null; },
    async put(key, value) { memory.set(key, String(value)); },
  };
  const { pruneLiveProxyManifestToUrls } = require(outfile);
  const pruned = await pruneLiveProxyManifestToUrls(['https://live.example/keep.txt'], storage);
  assert(pruned.entries.length === 1 && pruned.entries[0].key === 'prune-keep', 'prune must retain only allowed urls');
  assert(memory.get('live:prune-drop') !== '', 'prune must not write empty live:<key> values');
  assert(memory.get('live_txt:prune-drop').includes('#genre#'), 'prune must not erase live text kv values');

  // ── 21. 预构建文本恢复：分片成功后能重建完整候选树 ──
  memory.set('live_txt:prune-keep', '央视,#genre#\nCCTV-1,http://keep.example/live$源K#12345678');
  const preparedGroups = await buildPreparedLiveGroups([{ key: 'prune-keep' }], storage);
  assert(preparedGroups.length === 1 && preparedGroups[0].group === '央视', 'prepared groups must restore from live_txt kv');
  assert(preparedGroups[0].channels[0].urls.length === 1, 'prepared groups must restore channel urls');
  const preparedSnapshot = serializePreparedLiveGroups(preparedGroups);
  assert(preparedSnapshot.includes('源K#12345678'), 'prepared snapshot must retain source label');

  // ── 22. CF 分片下载可延迟重建，避免每个小分片重复扫描全量频道树 ──
  const deferredUrl = 'https://live.example/deferred.m3u';
  const deferredKey = await liveProxyKey(deferredUrl);
  const deferredMemory = new Map([
    ['live_prepare_inputs', JSON.stringify({
      updatedAt: '2026-11-24T04:00:00.000Z',
      signature: deferredUrl,
      sourceCount: 1,
      sources: [{ name: '延迟重建源', url: deferredUrl, isAggregated: true }],
    })],
    ['live_prepare_state', JSON.stringify({
      cursor: 1,
      sourceSignature: deferredUrl,
      inputUpdatedAt: '2026-11-24T04:00:00.000Z',
      updatedAt: '2026-11-24T04:00:01.000Z',
      processed: 1,
      total: 1,
      ready: 1,
      failed: 0,
      complete: true,
    })],
    ['live_proxy_manifest', JSON.stringify({
      version: 4,
      signature: 'deferred-rebuild',
      entries: [entry(70, {
        key: deferredKey,
        url: deferredUrl,
        name: '延迟重建源',
        textReady: true,
      })],
    })],
    ['live_txt:' + deferredKey, '央视,#genre#\nCCTV-1,http://deferred.example/live$源D#12345678'],
  ]);
  const deferredWrites = [];
  const deferredStorage = {
    async get(key) { return deferredMemory.has(key) ? deferredMemory.get(key) : null; },
    async put(key, value) {
      deferredWrites.push(key);
      deferredMemory.set(key, String(value));
    },
  };
  const deferredResult = await runLivePrepareChunk(deferredStorage, { deferRebuild: true });
  assert(deferredResult.rebuilt === false, 'deferRebuild must not rebuild runtime output');
  assert(deferredResult.readyEntries.length === 1, 'deferRebuild must still expose prepared text count');
  assert(
    deferredWrites.length === 0,
    'an unchanged complete prepare round with deferRebuild must not rewrite candidate/output state',
  );

  console.log('regression: live manifest + distribution passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
