const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outfile = path.join(root, '.tmp-regression-build', 'live-source.cjs');
const qualityOutfile = path.join(root, '.tmp-regression-build', 'live-quality.cjs');

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
  mergeLiveProxyManifest,
  isLiveProxyEntryDistributable,
} = require(outfile);

const {
  selectLiveDistribution,
  normalizeLiveDistributionPolicy,
  compareLiveRank,
  partitionMergeSourceMetrics,
} = require(qualityOutfile);

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
assert(migrated.version === 3, 'v1 manifest must migrate to v3');
assert(migrated.entries.some((item) => item.key === 'new' && item.health === 'healthy'), 'new valid entry must be healthy');

// ── 4. 未验证/transient 也可进入质量池（只是排序靠后）──
const freshTransient = mergeLiveProxyManifest(null, [entry(10, { health: 'unhealthy', successfulAt: undefined })], {
  checkedAt: '2026-10-13T00:11:00.000Z',
  validUrls: [],
  transientUrls: ['https://live.example/10.txt'],
});
assert(freshTransient.entries.filter(isLiveProxyEntryDistributable).length === 1, 'transient without history must still stay in quality pool (可下发但排后)');
assert(freshTransient.entries[0].lastFailure === 'transient', 'transient failure reason must be recorded');

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

// ── 9. 稳定排序：同分不打乱 ──
const tieA = [ranked(1, { qualityScore: 50 }), ranked(2, { qualityScore: 50 })];
const sortedTie = tieA.slice().sort(compareLiveRank).map((e) => e.key);
assert(JSON.stringify(sortedTie) === JSON.stringify(['k1', 'k2']), 'equal scores must fall back to key order');

// ── 10. 策略规范化容错 ──
const normalized = normalizeLiveDistributionPolicy({ maxSources: '3', blockedKeys: ['x', 'x', ''] });
assert(normalized.maxSources === 3, 'string maxSources must normalize to a number');
assert(JSON.stringify(normalized.blockedKeys) === JSON.stringify(['x']), 'blockedKeys must be de-duplicated');
assert(normalizeLiveDistributionPolicy({ maxSources: -5 }).maxSources === -1, 'illegal maxSources must fall back to -1');

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

// ── 15. 聚合度量分流：invalid 绝不混入 transient（Render 聚合快照路径）──
const partitioned = partitionMergeSourceMetrics({
  'https://live.example/ok.txt': { health: 'healthy', everSucceeded: true },
  'https://live.example/timeout.txt': { health: 'unhealthy', lastFailure: 'transient' },
  'https://live.example/never.txt': { health: 'unhealthy' },
  'https://live.example/html.txt': { health: 'unhealthy', lastFailure: 'invalid' },
});
assert(JSON.stringify(partitioned.validUrls) === JSON.stringify(['https://live.example/ok.txt']), 'partition must route healthy urls to valid');
assert(
  JSON.stringify(partitioned.invalidUrls) === JSON.stringify(['https://live.example/html.txt']),
  'partition must route explicit invalid urls to invalid (not transient), got ' + partitioned.invalidUrls.join(','),
);
assert(
  JSON.stringify(partitioned.transientUrls.sort()) ===
    JSON.stringify(['https://live.example/never.txt', 'https://live.example/timeout.txt'].sort()),
  'partition must route transient + never-verified urls to transient, got ' + partitioned.transientUrls.join(','),
);

// ── 16. 聚合快照写入：invalid 经 manifest 合并后仍为 invalid，连续三次淘汰 ──
const snapshotEntries = [
  entry(20, { key: 'b-ok', url: 'https://live.example/ok.txt' }),
  entry(21, { key: 'b-bad', url: 'https://live.example/html.txt', health: 'unhealthy' }),
];
let snapshotManifest = null;
const snapshotMetrics = {
  'https://live.example/ok.txt': { health: 'healthy', everSucceeded: true },
  'https://live.example/html.txt': { health: 'unhealthy', lastFailure: 'invalid', everSucceeded: false },
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
  filterGroupsBySourceLabels,
  reorderGroupsBySourcePriority,
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

const labels = { 'https://live.example/labeled.txt': '源C#cccccccc' };
const preparedWithLabel = prepareManifestEntries([
  { name: '源C', url: 'https://live.example/labeled.txt' },
], undefined, labels);
assert(preparedWithLabel[0].label === '源C#cccccccc', 'prepareManifestEntries must persist merged output label');

console.log('regression: live manifest + distribution passed');
