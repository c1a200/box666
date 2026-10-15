const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outfile = path.join(root, '.tmp-regression-build', 'live-source.cjs');
const qualityOutfile = path.join(root, '.tmp-regression-build', 'live-quality.cjs');
const prepareOutfile = path.join(root, '.tmp-regression-build', 'live-prepare.cjs');
const inputsOutfile = path.join(root, '.tmp-regression-build', 'live-inputs.cjs');
const mergerOutfile = path.join(root, '.tmp-regression-build', 'live-merger.cjs');

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
  prepareLiveSourcesChunk,
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

const {
  filterLiveSourcesDetailed: filterLiveSourcesDetailedForRegression,
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
assert(migrated.version === 4, 'v1 manifest must migrate to v4');
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
  extractUrlsForSourceLabels,
  filterGroupsBySourceLabels,
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

// 频道级排序：已知快线优先、未知线路保留在后、明确失败线路剔除、每频道限流。
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
  'http://slow.example/live': { speedMs: 1800, probedAt: '2026-10-13T00:00:00.000Z', kind: 'm3u8' },
  'http://failed.example/live': { speedMs: 0, probedAt: '2026-10-13T00:00:00.000Z', kind: 'fail', consecutiveFailures: 2 },
  'http://fast.example/live': { speedMs: 120, probedAt: '2026-10-13T00:00:00.000Z', kind: 'tcp' },
};
const speedApplied = applyChannelSpeedToGroups(speedGroups, speedMap, 5000, AGGREGATED_MAX_URLS_PER_CHANNEL);
assert(speedApplied[0].channels[0].urls[0].includes('fast.example'), 'known fastest line must be first after channel speed probe');
assert(speedApplied[0].channels[0].urls[1].includes('slow.example'), 'known slower line must follow faster line');
assert(speedApplied[0].channels[0].urls[2].includes('unknown.example'), 'unknown line must remain after known successful lines');
assert(speedApplied[0].channels[0].urls[3].includes('failed.example'), 'one or two transient failures must retain the line as the final fallback');
const hardFailed = applyChannelSpeedToGroups(speedGroups, {
  'http://failed.example/live': { speedMs: 0, probedAt: '2026-10-13T00:00:00.000Z', kind: 'fail', consecutiveFailures: 3 },
}, 5000, AGGREGATED_MAX_URLS_PER_CHANNEL);
assert(!hardFailed[0].channels[0].urls.some((url) => url.includes('failed.example')), 'three consecutive failures must remove the line');
const recovered = applyChannelSpeedToGroups(speedGroups, {
  'http://failed.example/live': { speedMs: 80, probedAt: '2026-10-13T00:00:00.000Z', kind: 'tcp' },
}, 5000, AGGREGATED_MAX_URLS_PER_CHANNEL);
assert(recovered[0].channels[0].urls[0].includes('failed.example'), 'a successful probe must immediately restore the line to the ranked output');
const manyLines = [{ group: '测试', channels: [{ name: '限量', urls: Array.from({ length: AGGREGATED_MAX_URLS_PER_CHANNEL + 4 }, (_, i) => 'http://line' + i + '.example/live#abc' + i) }] }];
const limitedLines = applyChannelSpeedToGroups(manyLines, {}, 5000, AGGREGATED_MAX_URLS_PER_CHANNEL);
assert(limitedLines[0].channels[0].urls.length === AGGREGATED_MAX_URLS_PER_CHANNEL, 'merged output must cap each channel at AGGREGATED_MAX_URLS_PER_CHANNEL');

const labels = { 'https://live.example/labeled.txt': '源C#cccccccc' };
const preparedWithLabel = prepareManifestEntries([
  { name: '源C', url: 'https://live.example/labeled.txt' },
], undefined, labels);
assert(preparedWithLabel[0].label === '源C#cccccccc', 'prepareManifestEntries must persist merged output label');

// 运行时 TXT 恢复：必须保留每条线路的 $源标签，不能按裸 # 拆散。
const restoredTxtGroups = parseLiveGroupsFromTxt(
  '央视,#genre#\nCCTV-1,http://a$源A#aaaaaaaa#http://b$源B#bbbbbbbb\n',
);
assert(restoredTxtGroups.length === 1, 'runtime TXT must restore group structure');
assert(restoredTxtGroups[0].channels[0].urls.length === 2, 'runtime TXT must restore both lines');
assert(restoredTxtGroups[0].channels[0].urls[0].endsWith('$源A#aaaaaaaa'), 'runtime TXT must preserve first source label');
assert(restoredTxtGroups[0].channels[0].urls[1].endsWith('$源B#bbbbbbbb'), 'runtime TXT must preserve second source label');
assert(extractAllUrls(restoredTxtGroups).join(',') === 'http://a,http://b', 'runtime TXT restore must expose bare URLs for probing');

// 优先测速：每频道限流、失败线不优先、已知快线排前；单线路频道应被上层排除。
const preferred = extractPreferredLiveUrls(speedGroups, speedMap, 2);
assert(preferred.length === 2, 'priority extraction must honor the per-channel limit, got ' + preferred.length);
assert(preferred[0] === 'http://fast.example/live', 'fastest known line must be first priority candidate');
assert(preferred[1] === 'http://slow.example/live', 'second priority candidate must be the next usable line');
assert(!preferred.includes('http://failed.example/live'), 'failed line must never enter priority probing');
assert(!preferred.includes('http://unknown.example/live') || preferred.length === 2, 'unknown line may only appear after known usable lines and within limit');
const noSingleLine = [{ group: '测试', channels: [{ name: '单线路', urls: ['http://only.example/live$源O#12345678'] }] }];
assert(extractPreferredLiveUrls(noSingleLine, {}, 2).length === 1, 'helper itself extracts single-line channels');
const filteredSingle = noSingleLine.map((group) => ({
  group: group.group,
  channels: group.channels.filter((channel) => channel.urls.length > 1),
})).filter((group) => group.channels.length > 0);
assert(filteredSingle.length === 0, 'multi-line priority filter must exclude single-line channels');

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
  ],
}, {
  group: '其他',
  channels: [
    { name: 'abc news', urls: ['http://sub.example/abc'] },
    { name: '咪咕视频1', urls: ['http://sub.example/migu'] },
    { name: 'NewTv超级电影', urls: ['http://sub.example/newtv'] },
    { name: '测试频道', urls: ['http://sub.example/test'] },
    { name: '购物频道', urls: ['http://sub.example/shop'] },
    { name: '生活服务频道', urls: ['http://sub.example/life'] },
    { name: '未分类频道', urls: ['http://sub.example/other'] },
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
assert(subgroupOfChannel('abc news') === '国际·新闻', 'English news channel must use international news subgroup');
assert(subgroupOfChannel('咪咕视频1') === '其他·咪咕', 'Migu channel must use Migu subgroup');
assert(subgroupOfChannel('NewTv超级电影') === '其他·NewTV', 'NewTV channel must use NewTV subgroup');
assert(subgroupOfChannel('测试频道') === '其他·测试备用', 'test channel must use test/backup subgroup');
assert(subgroupOfChannel('购物频道') === '其他·购物生活', 'shopping channel must use shopping/life subgroup');
assert(subgroupOfChannel('生活服务频道') === '其他·生活服务', 'life-service channel must use life-service subgroup');
assert(subgroupOfChannel('未分类频道') === '其他·中文A', 'unclassified Chinese channel must use a stable Chinese-initial subgroup');
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
  subgroupParsed.reduce((sum, group) => sum + group.channels.length, 0) === subgroupGroups.reduce((sum, group) => sum + group.channels.length, 0),
  'subgrouping must not change channel count',
);
assert(
  subgroupParsed.every((group) => group.group !== '一起看' && group.group !== '其他' && group.group !== '影视' && group.group !== '音乐' && group.group !== '纪录' && group.group !== '风景直播'),
  'oversized parent groups must not be emitted after subgrouping',
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
const huyaPages = pagedParsed.filter((group) => group.group.startsWith('一起看·虎牙中文'));
const huyaPageBase = huyaPages[0]?.group.replace(/\d{2}$/, '') || '';
assert(huyaPages.length === 3, '401 Huya channels must split into three controlled pages');
assert(huyaPages[0].channels.length === 180 && huyaPages[1].channels.length === 180 && huyaPages[2].channels.length === 41, 'Huya pages must keep stable 180/180/41 capacity');
assert(huyaPages.every((group) => group.group === huyaPageBase + '01' || group.group === huyaPageBase + '02' || group.group === huyaPageBase + '03'), 'Huya pages must expose readable 01/02/03 suffixes');
assert(pagedHeaders.indexOf(huyaPageBase + '01') < pagedHeaders.indexOf(huyaPageBase + '02'), 'Huya page order must be stable');
assert(pagedHeaders.indexOf(huyaPageBase + '02') < pagedHeaders.indexOf(huyaPageBase + '03'), 'Huya page order must remain stable');
assert(pagedParsed.some((group) => group.group === '地方·浙江' && group.channels.length === 220), 'local province groups must stay complete and unpaged');
assert(pagedParsed.reduce((sum, group) => sum + group.channels.length, 0) === 621, 'paging must not lose channels');
assert(pagedParsed.reduce((sum, group) => sum + group.channels.reduce((urls, channel) => urls + channel.urls.length, 0), 0) === 621, 'paging must not lose channel URLs');
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
  incrementalSecond.entries.find((item) => item.key === 'key-51')?.textReady === false,
  'incremental batch must revoke textReady for a failed source in that batch',
);
assert(
  isLiveProxyEntryDistributable(incrementalSecond.entries.find((item) => item.key === 'key-51')) === false,
  'failed incremental source must not remain distributable',
);
assert(
  incrementalSecond.entries.find((item) => item.key === 'key-50')?.textReady === true,
  'incremental batch must mark its own successful text ready',
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

// ── 18c. HTTP 2xx 但无可用频道正文时必须判定 invalid，不得进入质量池 ──
async function testSuccessWithoutUsableText() {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('<html><body>ok</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
  try {
    const result = await filterLiveSourcesDetailedForRegression([
      { name: '空正文', url: 'https://live.example/empty-body.m3u' },
    ], 1000, undefined, {
      minChannelsPerSource: 1,
      minPlayableRatio: 0,
      maxAdRatio: 1,
    });
    assert(result.valid.length === 0, '2xx response without playable channels must not be valid');
    assert(result.invalid.length === 1, '2xx response without playable channels must be invalid');
    assert(result.transient.length === 0, '2xx response without playable channels must not be transient');
  } finally {
    global.fetch = originalFetch;
  }
}

// ── 18b. 单源复检失败必须撤销旧 textReady ──
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
  const failed = await recordLiveProxyValidation('manual-fail', 'transient', storage);
  assert(failed?.textReady === false, 'failed manual validation must revoke textReady');
  assert(isLiveProxyEntryDistributable(failed) === false, 'failed manual validation must not remain distributable');
  const persisted = JSON.parse(memory.get('live_proxy_manifest'));
  assert(persisted.entries[0].textReady === false, 'revoked readiness must be persisted');
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
    entry(72, { key: 'legacy-invalid', url: 'https://live.example/legacy-invalid.txt', textReady: false, lastFailure: 'invalid' }),
    entry(73, { key: 'legacy-blocked', url: 'https://live.example/legacy-blocked.txt', textReady: false, name: '音乐所' }),
  ];
  memory.set('live_proxy_manifest', JSON.stringify({
    version: 4,
    signature: 'legacy-readiness',
    entries: legacyEntries,
  }));
  memory.set('live_txt:legacy-ready', '央视,#genre#\nCCTV-1,http://legacy.example/live');
  memory.set('live_txt:legacy-invalid', '央视,#genre#\nCCTV-1,http://invalid.example/live');
  memory.set('live_txt:legacy-blocked', '央视,#genre#\nCCTV-1,http://blocked.example/live');
  const storage = {
    async get(key) { return memory.has(key) ? memory.get(key) : null; },
    async put(key, value) { memory.set(key, String(value)); },
  };
  const { repairLiveProxyTextReadiness } = require(outfile);
  const repaired = await repairLiveProxyTextReadiness(storage);
  assert(repaired.changed === true, 'startup repair must persist a changed manifest');
  assert(repaired.repaired === 1, 'startup repair must restore exactly the eligible legacy source');
  assert(repaired.revoked === 0, 'startup repair must not revoke already false entries');
  assert(repaired.distributable === 1, 'startup repair must expose exactly one distributable source');
  const persisted = JSON.parse(memory.get('live_proxy_manifest'));
  const byKey = new Map(persisted.entries.map((item) => [item.key, item]));
  assert(byKey.get('legacy-ready')?.textReady === true, 'startup repair must restore source with valid text');
  assert(byKey.get('legacy-empty')?.textReady === false, 'startup repair must not restore source without text');
  assert(byKey.get('legacy-invalid')?.textReady === false, 'startup repair must not restore explicitly invalid source');
  assert(byKey.get('legacy-blocked')?.textReady === false, 'startup repair must not restore blocked source');
  assert(isLiveProxyEntryDistributable(byKey.get('legacy-ready')) === true, 'restored source must be distributable');
  assert(isLiveProxyEntryDistributable(byKey.get('legacy-empty')) === false, 'textless source must remain non-distributable');
  assert(isLiveProxyEntryDistributable(byKey.get('legacy-invalid')) === false, 'invalid source must remain non-distributable');
  assert(isLiveProxyEntryDistributable(byKey.get('legacy-blocked')) === false, 'blocked source must remain non-distributable');
}

async function main() {
  await testSuccessWithoutUsableText();
  await testManualValidationFailure();
  await testStartupReadinessRepair();
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

  console.log('regression: live manifest + distribution passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
