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
  computeNextChannelProbeRun,
  isChannelProbeScheduleDue,
  isResumableFullProbeWorkingState,
  loadChannelProbeSchedule,
  markChannelProbeRun,
  saveChannelProbeSchedule,
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

function testChannelProbeScheduleCalculation() {
  const timeZone = 'Asia/Shanghai';
  const dailySchedule = {
    times: ['09:00', '13:00', '18:00'],
    repeatDays: 1,
    timezone: timeZone,
  };
  assert(computeNextChannelProbeRun(
    dailySchedule,
    new Date('2026-11-03T04:00:00.000Z'),
  ) === '2026-11-03T05:00:00.000Z',
  'a daily multi-slot schedule must select the next slot today');
  assert(computeNextChannelProbeRun(
    dailySchedule,
    new Date('2026-11-03T10:00:00.000Z'),
  ) === '2026-11-04T01:00:00.000Z',
  'a daily multi-slot schedule must roll over to the first slot tomorrow');

  const everyThreeDays = {
    ...dailySchedule,
    repeatDays: 3,
    lastRunAt: '2026-11-01T01:00:00.000Z',
  };
  assert(computeNextChannelProbeRun(
    everyThreeDays,
    new Date('2026-11-03T04:00:00.000Z'),
  ) === '2026-11-04T01:00:00.000Z',
  'an inactive day in a multi-day schedule must wait for the next active day');
  assert(computeNextChannelProbeRun(
    everyThreeDays,
    new Date('2026-11-04T04:00:00.000Z'),
  ) === '2026-11-04T05:00:00.000Z',
  'an active day in a multi-day schedule must still run later configured slots');
  assert(computeNextChannelProbeRun(
    everyThreeDays,
    new Date('2026-11-04T10:00:00.000Z'),
  ) === '2026-11-07T01:00:00.000Z',
  'after an active day finishes, a multi-day schedule must wait a full repeat interval');
}

async function testChannelProbeSchedulePersistenceAndDueChecks() {
  const timeZone = 'Asia/Shanghai';
  const initialTime = '06:30';
  const migrationStorage = memoryStorage({ channel_probe_interval: '1440' });
  const migrated = await loadChannelProbeSchedule(
    migrationStorage,
    timeZone,
    initialTime,
    new Date('2026-11-03T00:00:00.000Z'),
  );
  assert(migrated.times.join(',') === initialTime,
    'legacy 1440-minute configuration must migrate to the current aggregation time');
  assert(migrated.nextRunAt === '2026-11-03T22:30:00.000Z',
    'legacy schedule migration must preserve the configured timezone');

  const storage = memoryStorage();
  const saved = await saveChannelProbeSchedule(
    storage,
    {
      times: ['17:00', '05:00', '5:00', '17:00', '25:00'],
      repeatDays: 3,
    },
    timeZone,
    '05:00',
    new Date('2026-11-03T04:00:00.000Z'),
  );
  assert(saved.times.join(',') === '05:00,17:00',
    'saved schedule times must be normalized, deduplicated, and sorted');
  assert(saved.nextRunAt === '2026-11-03T09:00:00.000Z',
    'saving a schedule must calculate the next slot in the configured timezone');
  assert(!(await isChannelProbeScheduleDue(
    storage,
    new Date('2026-11-03T04:00:00.000Z'),
    timeZone,
    initialTime,
  )), 'a configured slot must not run before nextRunAt');
  assert(await isChannelProbeScheduleDue(
    storage,
    new Date('2026-11-03T09:00:00.000Z'),
    timeZone,
    initialTime,
  ), 'a configured slot must run at nextRunAt');

  const marked = await markChannelProbeRun(
    storage,
    new Date('2026-11-03T09:00:00.000Z'),
    timeZone,
    initialTime,
  );
  assert(marked.nextRunAt === '2026-11-05T21:00:00.000Z',
    'a completed run must advance a multi-day schedule by its repeat interval');
}

async function testChannelProbeSlotCannotRepeat() {
  const timeZone = 'Asia/Shanghai';
  const storage = memoryStorage();
  const initialTime = '05:00';
  await saveChannelProbeSchedule(
    storage,
    { times: ['09:00', '13:00', '18:00'], repeatDays: 1 },
    timeZone,
    initialTime,
    new Date('2026-11-03T00:00:00.000Z'),
  );
  assert(await isChannelProbeScheduleDue(
    storage,
    new Date('2026-11-03T01:00:00.000Z'),
    timeZone,
    initialTime,
  ), 'the first configured slot must become due');
  const marked = await markChannelProbeRun(
    storage,
    new Date('2026-11-03T01:00:00.000Z'),
    timeZone,
    initialTime,
  );
  assert(marked.nextRunAt === '2026-11-03T05:00:00.000Z',
    'marking a run must advance to the next slot on the same day');
  assert(!(await isChannelProbeScheduleDue(
    storage,
    new Date('2026-11-03T01:01:00.000Z'),
    timeZone,
    initialTime,
  )), 'a completed slot must not become due again on the next minute');
  assert(await isChannelProbeScheduleDue(
    storage,
    new Date('2026-11-03T05:00:00.000Z'),
    timeZone,
    initialTime,
  ), 'the next configured slot must still become due');

  storage.memory.set('channel_probe_schedule', JSON.stringify({
    times: ['09:00', '18:00'],
    repeatDays: 3,
    timezone: timeZone,
    lastRunAt: '2026-11-01T01:00:00.000Z',
    nextRunAt: '2026-11-04T01:00:00.000Z',
  }));
  assert(!(await isChannelProbeScheduleDue(
    storage,
    new Date('2026-11-03T09:00:00.000Z'),
    timeZone,
    initialTime,
  )), 'a multi-day schedule must not run early on an inactive day');
  assert(await isChannelProbeScheduleDue(
    storage,
    new Date('2026-11-04T01:00:00.000Z'),
    timeZone,
    initialTime,
  ), 'a multi-day schedule must become due on its active day');
}

function testChannelProbeResume() {
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
  testChannelProbeScheduleCalculation();
  await testChannelProbeSchedulePersistenceAndDueChecks();
  await testChannelProbeSlotCannotRepeat();
  testChannelProbeResume();
  console.log('regression: channel quality snapshot, scheduling, and line slicing passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
