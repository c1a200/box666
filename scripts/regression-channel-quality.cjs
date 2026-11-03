const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.tmp-regression-build');

function bundle(entry, name) {
  const outfile = path.join(outDir, name + '.cjs');
  buildSync({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile,
  });
  return require(outfile);
}

const {
  publishSpeedSnapshot,
  saveWorkingSpeedState,
  loadPublishedSpeedMap,
  loadPublishedSpeedSnapshot,
  selectProbeCandidates,
  CHANNEL_PROBE_RESULT_VERSION,
} = bundle('src/core/live-speed-store.ts', 'channel-quality-store');
const {
  hasCompletedFullProbeForCalendarDay,
  isResumableFullProbeWorkingState,
} = bundle('src/core/channel-probe-schedule.ts', 'channel-probe-schedule');
const {
  applyChannelSpeedToGroups,
  mergeLivesToNative,
} = bundle('src/core/live-merger.ts', 'channel-quality-merger');
const { computeLiveOutputFingerprint } = bundle('src/core/live-output.ts', 'channel-quality-output');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function memoryStorage(seed = {}) {
  const memory = new Map(Object.entries(seed));
  return {
    memory,
    async get(key) { return memory.has(key) ? memory.get(key) : null; },
    async put(key, value) { memory.set(key, String(value)); },
  };
}

function successEntry(speedMs, probedAt) {
  return {
    speedMs,
    probedAt,
    kind: 'm3u8',
    verification: 'media',
    probeVersion: CHANNEL_PROBE_RESULT_VERSION,
  };
}

async function testPublishedSnapshotStaysStableDuringWorkingRun() {
  const storage = memoryStorage();
  const publishedMap = {
    'https://published.example/live.m3u8': successEntry(80, '2026-11-03T00:00:00.000Z'),
  };
  const snapshot = await publishSpeedSnapshot(storage, publishedMap, {
    trigger: 'cron',
    evaluationMode: 'full',
    startedAt: '2026-11-02T21:00:00.000Z',
    finishedAt: '2026-11-02T21:05:00.000Z',
    durationMs: 300000,
    probed: 1,
    success: 1,
    failed: 0,
    totalChannels: 1,
  });
  const fingerprintBefore = await computeLiveOutputFingerprint(storage, {
    selectionMode: 'simple',
    maxSources: -1,
    maxUrlsPerChannel: 9,
  });

  await saveWorkingSpeedState(storage, {
    runStartedAt: '2026-11-03T21:00:00.000Z',
    trigger: 'cron',
    evaluationMode: 'full',
    completed: false,
    map: {
      'https://working.example/live.m3u8': successEntry(10, '2026-11-03T21:01:00.000Z'),
    },
  });

  const visible = await loadPublishedSpeedMap(storage);
  assert(Object.keys(visible).join(',') === 'https://published.example/live.m3u8',
    'output readers must keep the published snapshot while a full run is incomplete');
  const loaded = await loadPublishedSpeedSnapshot(storage);
  assert(loaded && loaded.publishedAt === snapshot.publishedAt,
    'working writes must not advance the published snapshot timestamp');
  const fingerprintAfter = await computeLiveOutputFingerprint(storage, {
    selectionMode: 'simple',
    maxSources: -1,
    maxUrlsPerChannel: 9,
  });
  assert(fingerprintBefore === fingerprintAfter,
    'output fingerprints must ignore the incomplete working cache');
}

function testFullAndIncrementalProbeFreshness() {
  const now = Date.parse('2026-11-03T12:00:00.000Z');
  const freshMap = {
    'https://fresh.example/live.m3u8': successEntry(100, new Date(now - 60_000).toISOString()),
  };
  const incremental = selectProbeCandidates(
    ['https://fresh.example/live.m3u8'],
    freshMap,
    now,
  );
  const full = selectProbeCandidates(
    ['https://fresh.example/live.m3u8'],
    freshMap,
    now,
    Number.POSITIVE_INFINITY,
    { force: true, forceBefore: now },
  );
  assert(incremental.length === 0, 'incremental probe must respect the success TTL');
  assert(full.length === 1, 'full probe must recheck fresh success entries');
}

function testLineLimitsAreSlicesOfOneRanking() {
  const now = '2026-11-03T00:00:00.000Z';
  const urls = Array.from({ length: 9 }, (_, index) => `https://line-${index + 1}.example/live.m3u8`);
  const groups = [{ group: '央视', channels: [{ name: 'CCTV-1', urls }] }];
  const speedMap = Object.fromEntries(urls.map((url, index) => [url, successEntry(100 + index * 50, now)]));
  const nine = applyChannelSpeedToGroups(groups, speedMap, undefined, 9, { requirePlaybackVerification: true });
  const three = applyChannelSpeedToGroups(groups, speedMap, undefined, 3, { requirePlaybackVerification: true });
  assert(nine[0].channels[0].urls.length === 9, 'limit 9 must publish all nine verified lines');
  assert(three[0].channels[0].urls.length === 3, 'limit 3 must publish three verified lines');
  assert(three[0].channels[0].urls.join(',') === nine[0].channels[0].urls.slice(0, 3).join(','),
    'a smaller line limit must be an exact prefix of the published global ranking');
}

async function testCandidatePoolKeepsMoreThan64Lines() {
  const lineCount = 80;
  const channelLines = Array.from({ length: lineCount }, (_, index) =>
    `CCTV-1,https://candidate-${index + 1}.example/live.m3u8#候选${index + 1}`);
  const otherChannels = Array.from({ length: 5 }, (_, index) =>
    `CCTV-${index + 2},https://candidate-${index + 2}-only.example/live.m3u8`);
  const txt = ['央视频道,#genre#', ...channelLines, ...otherChannels].join('\n');
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(txt, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
  try {
    const merged = await mergeLivesToNative(
      [{ name: '候选池测试', url: 'https://source.example/live.txt' }],
      3000,
      undefined,
      undefined,
      { preserveAllUrls: true, candidatePoolMaxUrlsPerChannel: -1 },
    );
    const cctv1 = merged.groups.flatMap((group) => group.channels).find((channel) => channel.name === 'CCTV-1');
    assert(cctv1 && cctv1.urls.length === lineCount,
      'candidate pool option -1 must retain channel lines beyond the old 64-line cutoff');
  } finally {
    global.fetch = originalFetch;
  }
}

function testDailyScheduleBoundaryAndResume() {
  const timeZone = 'Asia/Shanghai';
  assert(hasCompletedFullProbeForCalendarDay(
    '2026-11-02T20:59:00.000Z',
    new Date('2026-11-02T21:00:00.000Z'),
    timeZone,
  ), 'a Beijing-calendar-day run must suppress duplicate full probes even at 23h55m age');
  assert(!hasCompletedFullProbeForCalendarDay(
    '2026-11-01T21:05:00.000Z',
    new Date('2026-11-02T21:00:00.000Z'),
    timeZone,
  ), 'yesterday\'s full run must not suppress today\'s cron');

  const now = Date.parse('2026-11-03T12:00:00.000Z');
  const working = {
    version: 1,
    runStartedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    trigger: 'cron',
    evaluationMode: 'full',
    completed: false,
    map: {},
  };
  assert(isResumableFullProbeWorkingState(working, now), 'an incomplete full run within 24h must resume');
  assert(!isResumableFullProbeWorkingState({ ...working, completed: true }, now),
    'a completed full working checkpoint must not resume');
  assert(!isResumableFullProbeWorkingState({ ...working, evaluationMode: 'incremental' }, now),
    'an incremental working checkpoint must not block a full run');
  assert(!isResumableFullProbeWorkingState({ ...working, runStartedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() }, now),
    'a stale incomplete full run must not resume');
}

async function main() {
  await testPublishedSnapshotStaysStableDuringWorkingRun();
  testFullAndIncrementalProbeFreshness();
  testLineLimitsAreSlicesOfOneRanking();
  await testCandidatePoolKeepsMoreThan64Lines();
  testDailyScheduleBoundaryAndResume();
  console.log('regression: channel quality snapshot, scheduling, and line slicing passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
