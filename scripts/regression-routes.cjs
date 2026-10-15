const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.tmp-regression-build');
fs.mkdirSync(outDir, { recursive: true });

buildSync({
  entryPoints: [path.join(root, 'src/routes.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(outDir, 'routes.cjs'),
  define: { __TEST_EXPOSE__: 'true' },
});

const { createApp } = require(path.join(outDir, 'routes.cjs'));

class MemoryStorage {
  constructor(seed = {}) {
    this.data = new Map(Object.entries(seed));
  }
  async get(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }
  async put(key, value) {
    this.data.set(key, String(value));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function siteFingerprint(site) {
  const ext = typeof site.ext === 'string' ? site.ext : JSON.stringify(site.ext || '');
  const raw = `${site.api}|${ext}|${site.jar || ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

const mergedConfig = {
  sites: [
    {
      key: 'source-excellent',
      name: '优秀源',
      type: 0,
      api: 'https://source.example/api',
      searchable: 1,
      ext: '{"token":"upstream-token"}',
    },
    {
      key: 'source-good',
      name: '良好源',
      type: 1,
      api: 'csp_Source',
      searchable: 1,
      jar: 'https://source.example/source.jar',
    },
    {
      key: 'source-plugin',
      name: '插件源',
      type: 3,
      api: 'csp_Plugin',
      searchable: 0,
      ext: '{"site":"https://source.example/site"}',
    },
    {
      key: 'source-client-fallback',
      name: '客户端后备源',
      type: 3,
      api: 'csp_ClientFallback',
      searchable: 1,
    },
    {
      key: 'source-quick-only',
      name: '仅快速搜索标记',
      type: 1,
      api: 'https://source.example/quick',
      searchable: 0,
      quickSearch: 1,
    },
    {
      key: 'source-custom-type',
      name: '自定义类型源',
      type: 9,
      api: 'https://source.example/custom-type',
      searchable: 1,
    },
    {
      key: 'source-xml-good',
      name: '次优 XML 源',
      type: 0,
      api: 'https://source.example/xml-good',
      searchable: 1,
    },
    {
      key: 'source-timeout',
      name: '超时源',
      type: 1,
      api: 'https://source.example/timeout',
      searchable: 1,
    },
  ],
  spider: 'https://source.example/spider.jar',
  lives: [
    {
      name: '测试直播',
      url: 'https://source.example/live.m3u',
    },
  ],
};

const qualityPool = {
  updatedAt: new Date().toISOString(),
  entries: [
    { key: 'source-excellent', name: '优秀源', grade: 'excellent', speedMs: 100, result: 'ok', consecutiveFailures: 0 },
    { key: 'source-good', name: '良好源', grade: 'good', speedMs: 2000, result: 'ok', consecutiveFailures: 0 },
    { key: 'source-plugin', name: '插件源', grade: 'untestable', speedMs: null, result: 'not_probed', consecutiveFailures: 0 },
    { key: 'source-client-fallback', name: '客户端后备源', grade: 'untestable', speedMs: null, result: 'not_probed', consecutiveFailures: 0 },
    { key: 'source-custom-type', name: '自定义类型源', grade: 'good', speedMs: 1500, result: 'ok', consecutiveFailures: 0 },
    { key: 'source-xml-good', name: '次优 XML 源', grade: 'good', speedMs: 2500, result: 'ok', consecutiveFailures: 0 },
    { key: 'source-timeout', name: '超时源', grade: 'timeout', speedMs: null, result: 'timeout', consecutiveFailures: 1 },
  ],
};

const distribution = {
  requireAuth: false,
  authCodes: [
    {
      id: 'auth-a',
      label: '仅优秀',
      code: 'code-a',
      enabled: true,
      sourceMode: 'all',
      maxSites: -1,
      includeGrades: ['excellent'],
      siteTypes: [],
      pinnedKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'auth-b',
      label: '仅插件',
      code: 'code-b',
      enabled: true,
      sourceMode: 'all',
      maxSites: -1,
      includeGrades: [],
      siteTypes: ['jar'],
      pinnedKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
};

function makeApp(overrides = {}) {
  const storage = new MemoryStorage({
    merged_config: JSON.stringify(overrides.mergedConfig || mergedConfig),
    merged_config_full: JSON.stringify(overrides.mergedConfigFull || overrides.mergedConfig || mergedConfig),
    search_quality_pool: JSON.stringify(overrides.qualityPool === undefined ? qualityPool : overrides.qualityPool),
    client_auth_distribution: JSON.stringify(overrides.distribution || distribution),
    ...(overrides.quota ? { search_quota: JSON.stringify(overrides.quota) } : {}),
    ...(overrides.blacklist ? { blacklist: JSON.stringify(overrides.blacklist) } : {}),
    ...(overrides.qualityCandidates ? { search_quality_candidates: JSON.stringify({ updatedAt: new Date().toISOString(), sites: overrides.qualityCandidates }) } : {}),
    ...(overrides.liveMergeMode ? { live_merge_mode: overrides.liveMergeMode } : {}),
    ...(overrides.liveDistribution ? { live_distribution: JSON.stringify(overrides.liveDistribution) } : {}),
    ...(overrides.liveProxyManifest ? { live_proxy_manifest: JSON.stringify(overrides.liveProxyManifest) } : {}),
    ...(overrides.channelCandidateUrls ? { channel_candidate_urls: typeof overrides.channelCandidateUrls === 'string' ? overrides.channelCandidateUrls : JSON.stringify(overrides.channelCandidateUrls) } : {}),
    ...(overrides.liveTextByKey
      ? Object.fromEntries(
          Object.entries(overrides.liveTextByKey).map(([key, text]) => [`live_txt:${key}`, text])
        )
      : {}),
  });
  const config = {
    adminToken: 'test-token',
    workerBaseUrl: 'https://box.example',
    localBaseUrl: '',
    ...overrides.config,
  };
  const app = createApp({
    storage,
    config,
    triggerRefresh: async () => ({ started: true, running: false, completed: true }),
  });
  return { app, storage };
}

async function readConfig(response) {
  assert(response.status === 200, 'expected 200, got ' + response.status);
  const body = await response.json();
  assert(Array.isArray(body.sites), 'response should contain sites');
  assert(!JSON.stringify(body).includes('__upstreamNames'), 'internal upstream marker must not leak');
  return body;
}

async function readSites(response) {
  return (await readConfig(response)).sites;
}

(async () => {
  {
    const { app } = makeApp();
    const sites = await readSites(await app.request('https://box.example/'));
    assert(sites.length >= 2, 'root link should receive enabled startup sites when requireAuth is false');
    const keys = sites.map((site) => site.key);
    assert(keys.includes('source-client-fallback'), 'root link should include all client-runtime fallback sources');
    assert(!keys.includes('source-timeout'), 'root link must never distribute timeout sources');
    assert(keys.indexOf('source-excellent') < keys.indexOf('source-good'), 'root link must preserve the quality-pool order');
  }

  {
    const bulkSites = Array.from({ length: 120 }, (_, index) => ({
      key: 'bulk-source-' + String(index).padStart(3, '0'),
      name: '批量源 ' + index,
      type: index < 5 ? 3 : 1,
      api: index < 5 ? 'csp_Bulk' + index : 'https://bulk.example/api/' + index,
      jar: index < 5 ? 'https://bulk.example/' + index + '.jar' : undefined,
      searchable: 1,
    }));
    const entries = bulkSites.map((site, index) => ({
      key: site.key,
      name: site.name,
      grade: index === 118 ? 'timeout' : index === 119 ? 'unusable' : index < 5 ? 'untestable' : 'excellent',
      speedMs: index < 5 || index >= 118 ? null : 100 + index,
      result: index === 118 ? 'timeout' : index === 119 ? 'error' : index < 5 ? 'not_probed' : 'ok',
      consecutiveFailures: index >= 118 ? 1 : 0,
    }));
    const allDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-bulk-all', label: '全部源', code: 'bulk-all', enabled: true,
        sourceMode: 'all', selectionMode: 'simple', maxSites: -1,
        selectedKeys: [], pinnedKeys: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({
      mergedConfig: { sites: bulkSites, lives: [] },
      qualityPool: { updatedAt: new Date().toISOString(), entries },
      distribution: allDistribution,
      quota: { startupMode: 'full', leanStartup: false, selectionMode: 'simple', maxSites: -1 },
    });
    const rootSites = await readSites(await app.request('https://box.example/'));
    const authSites = await readSites(await app.request('https://box.example/auth/bulk-all/'));
    const rootKeys = rootSites.map((site) => site.key).sort();
    const authKeys = authSites.map((site) => site.key).sort();
    assert(rootSites.length === 118, 'root full selection must distribute every eligible source above the old 50-source range; got ' + rootSites.length);
    assert(authSites.length === rootSites.length, 'auth full selection must match root full selection count');
    assert(authKeys.join(',') === rootKeys.join(','), 'auth and root full selection must distribute the same deduplicated eligible source set');
    assert(authSites.filter((site) => site.type === 3).length === 5, 'auth full selection must retain every eligible searchable JAR source');
    assert(!authKeys.includes('bulk-source-118') && !authKeys.includes('bulk-source-119'), 'auth full selection must exclude timeout and unusable sources just like root');

    const limitedDistribution = {
      ...allDistribution,
      authCodes: [{ ...allDistribution.authCodes[0], id: 'auth-bulk-limited', code: 'bulk-limited', maxSites: 17 }],
    };
    const limitedApp = makeApp({
      mergedConfig: { sites: bulkSites, lives: [] },
      qualityPool: { updatedAt: new Date().toISOString(), entries },
      distribution: limitedDistribution,
      quota: { startupMode: 'full', leanStartup: false, selectionMode: 'simple', maxSites: 17 },
    }).app;
    const limitedRoot = await readSites(await limitedApp.request('https://box.example/'));
    const limitedAuth = await readSites(await limitedApp.request('https://box.example/auth/bulk-limited/'));
    assert(limitedRoot.filter((site) => site.searchable === 1).length === 17, 'root explicit simple count must still cap searchable sources');
    assert(limitedAuth.filter((site) => site.searchable === 1).length === 17, 'auth explicit simple count must apply the same Top-N rule');
    assert(limitedAuth.map((site) => site.key).join(',') === limitedRoot.map((site) => site.key).join(','), 'matching root and auth limits must preserve identical quality ordering');

    const categorySites = [...bulkSites, {
      key: 'bulk-functional-plugin', name: '非搜索插件', type: 3,
      api: 'csp_Functional', searchable: 0,
    }];
    // Non-searchable functional plugins are not quality-pool entries. They are
    // appended after the ranked searchable pool and may only use leftover type
    // capacity; they must never displace a searchable JAR from the Top-N.
    const categoryEntries = [...entries];
    const categoryLimits = { quality: { excellent: 8, untestable: -1 }, type: { jar: 0 } };
    const categoryDistribution = {
      ...allDistribution,
      authCodes: [{ ...allDistribution.authCodes[0], id: 'auth-bulk-category', code: 'bulk-category', selectionMode: 'category', bucketLimits: categoryLimits }],
    };
    const categoryApp = makeApp({
      mergedConfig: { sites: categorySites, lives: [] },
      qualityPool: { updatedAt: new Date().toISOString(), entries: categoryEntries },
      distribution: categoryDistribution,
      quota: { startupMode: 'full', leanStartup: false, selectionMode: 'category', bucketLimits: categoryLimits },
    }).app;
    const categoryRootConfig = await readConfig(await categoryApp.request('https://box.example/'));
    const categoryAuthConfig = await readConfig(await categoryApp.request('https://box.example/auth/bulk-category/'));
    assert(categoryRootConfig.sites.map((site) => site.key).join(',') === categoryAuthConfig.sites.map((site) => site.key).join(','), 'matching category policies must select the same source set and order for root and auth');
    assert(!categoryAuthConfig.sites.some((site) => site.type === 3), 'JAR=0 must remove every type=3 site, including non-searchable plugins');
    assert(!('spider' in categoryAuthConfig), 'JAR=0 must remove the global spider when no type=3 site remains');
    const jarOneLimits = { type: { jar: 1 } };
    const jarOneDistribution = {
      ...allDistribution,
      authCodes: [{ ...allDistribution.authCodes[0], id: 'auth-bulk-jar-one', code: 'bulk-jar-one', selectionMode: 'category', bucketLimits: jarOneLimits }],
    };
    const jarOneApp = makeApp({
      mergedConfig: { sites: categorySites, lives: [], spider: 'https://source.example/spider.jar' },
      qualityPool: { updatedAt: new Date().toISOString(), entries: categoryEntries },
      distribution: jarOneDistribution,
      quota: { startupMode: 'full', leanStartup: false, selectionMode: 'category', bucketLimits: jarOneLimits },
    }).app;
    const jarOneConfig = await readConfig(await jarOneApp.request('https://box.example/auth/bulk-jar-one/'));
    const keptType3 = jarOneConfig.sites.filter((site) => site.type === 3);
    assert(keptType3.length === 1, 'JAR=1 must retain exactly one type=3 site');
    assert(keptType3[0].key === 'bulk-source-000', 'JAR=1 must retain the highest-ranked type=3 site');
    assert(jarOneConfig.spider === 'https://source.example/spider.jar', 'a remaining type=3 site must keep the global spider for client compatibility');
  }

  {
    // Production CF shape: the final merged config was truncated by an old
    // quota, while the full snapshot and quality pool still hold every source.
    const verifiedSites = Array.from({ length: 27 }, (_, index) => ({
      key: 'cf-verified-' + String(index).padStart(3, '0'),
      name: 'CF verified ' + index,
      type: 1,
      api: 'https://cf.example/verified/' + index,
      searchable: 1,
    }));
    const clientSites = Array.from({ length: 273 }, (_, index) => ({
      key: 'cf-client-' + String(index).padStart(3, '0'),
      name: 'CF client ' + index,
      type: 3,
      api: 'csp_CFClient' + index,
      searchable: 1,
    }));
    const allCfSites = [...verifiedSites, ...clientSites];
    const cfEntries = [
      ...verifiedSites.map((site, index) => ({
        key: site.key, name: site.name, grade: 'excellent', speedMs: 100 + index,
        result: 'ok', consecutiveFailures: 0,
      })),
      ...clientSites.map((site) => ({
        key: site.key, name: site.name, grade: 'untestable', speedMs: null,
        result: 'not_probed', consecutiveFailures: 0,
      })),
    ];
    const cfDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-cf-full', label: 'CF full', code: 'cf-full', enabled: true,
        sourceMode: 'all', selectionMode: 'simple', maxSites: -1,
        selectedKeys: [], pinnedKeys: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }, {
        id: 'auth-cf-category', label: 'CF category', code: 'cf-category', enabled: true,
        sourceMode: 'all', selectionMode: 'category',
        maxSites: -1, bucketLimits: { quality: { untestable: 12 } },
        selectedKeys: [], pinnedKeys: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({
      mergedConfig: { sites: verifiedSites, lives: [] },
      mergedConfigFull: { sites: allCfSites, lives: [] },
      qualityPool: { updatedAt: new Date().toISOString(), entries: cfEntries },
      distribution: cfDistribution,
      quota: {
        startupMode: 'full', leanStartup: false, selectionMode: 'simple', maxSites: -1,
        quotaSchemaVersion: 9, bucketLimits: { quality: { untestable: -1 } },
      },
    });
    const rootSites = await readSites(await app.request('https://box.example/'));
    assert(rootSites.length === 300, 'CF root must restore all 300 quality-pool sources; got ' + rootSites.length);
    assert(rootSites.filter((site) => site.key.startsWith('cf-client-')).length === 273,
      'CF root must restore all 273 client-verifiable JAR sources');

    const categorySites = await readSites(await app.request('https://box.example/auth/cf-category/'));
    assert(categorySites.filter((site) => site.key.startsWith('cf-client-')).length === 12,
      'CF category mode must apply the explicit untestable Top-N');

    const report = await (await app.request('https://box.example/admin/quality-report', {
      headers: { Authorization: 'Bearer test-token' },
    })).json();
    assert(report.actual.qualityPoolCount === 300, 'quality report must count client-verifiable sources in the pool');
    assert(report.actual.serverVerifiedPool === 27, 'quality report must separate server-verified sources');
    assert(report.actual.clientFallbackPool === 273, 'quality report must expose client-verifiable sources');

    const data = await (await app.request('https://box.example/admin/config-data', {
      headers: { Authorization: 'Bearer test-token' },
    })).json();
    const clientRows = data.sites.filter((site) => site.key.startsWith('cf-client-'));
    assert(clientRows.length === 273, 'config-data must list all 273 client-verifiable sources');
    assert(clientRows.every((site) => site.inFinal === true && site.inQualityPool === true),
      'client-verifiable sources must be marked selectable in config-data');
    assert(data.searchQuality.qualityPoolCount === 300, 'config-data quality pool count must include client-verifiable sources');
  }
  {
    // A blacklist entry must not be silently restored into root/auth output by
    // the full-candidate snapshot, and pool membership vs distributable count
    // must be reported separately.
    const verifiedSites2 = Array.from({ length: 5 }, (_, index) => ({
      key: 'bk-verified-' + index,
      name: 'BK verified ' + index,
      type: 1,
      api: 'https://bk.example/v/' + index,
      searchable: 1,
    }));
    const blockedSite = { key: 'bk-blocked', name: 'BK blocked', type: 1, api: 'https://bk.example/blocked', searchable: 1 };
    const allBkSites = [...verifiedSites2, blockedSite];
    const bkEntries = [
      ...verifiedSites2.map((site, index) => ({
        key: site.key, name: site.name, grade: 'excellent', speedMs: 100 + index,
        result: 'ok', consecutiveFailures: 0,
      })),
      { key: blockedSite.key, name: blockedSite.name, grade: 'excellent', speedMs: 500, result: 'ok', consecutiveFailures: 0 },
    ];
    const bkDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'bk-all', label: 'BK all', code: 'bk-all', enabled: true,
        sourceMode: 'all', selectionMode: 'simple', maxSites: -1,
        selectedKeys: [], pinnedKeys: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({
      mergedConfig: { sites: verifiedSites2, lives: [] },
      mergedConfigFull: { sites: allBkSites, lives: [] },
      qualityPool: { updatedAt: new Date().toISOString(), entries: bkEntries },
      qualityCandidates: allBkSites,
      distribution: bkDistribution,
      blacklist: { sites: [siteFingerprint(blockedSite)], parses: [], lives: [], regexRules: [], regexBlockOverrides: [] },
      quota: {
        startupMode: 'full', leanStartup: false, selectionMode: 'simple', maxSites: -1,
        quotaSchemaVersion: 9, bucketLimits: { quality: { untestable: -1 } },
      },
    });
    const rootSites = await readSites(await app.request('https://box.example/'));
    assert(!rootSites.some((site) => site.key === 'bk-blocked'), 'root must not restore a blacklisted source from the full snapshot');
    assert(rootSites.some((site) => site.key === 'bk-verified-0'), 'root must still serve non-blocked restored sources');

    const authSites = await readSites(await app.request('https://box.example/auth/bk-all/'));
    assert(!authSites.some((site) => site.key === 'bk-blocked'), 'auth link must not restore a blacklisted source');

    const report = await (await app.request('https://box.example/admin/quality-report', {
      headers: { Authorization: 'Bearer test-token' },
    })).json();
    assert(report.actual.qualityPoolCount === 6, 'quality pool count must include the blocked member; got ' + report.actual.qualityPoolCount);
    assert(report.actual.distributablePoolCount === 5, 'distributable count must exclude the blocked member; got ' + report.actual.distributablePoolCount);
    assert(report.actual.blockedPoolCount === 1, 'blocked pool count must equal 1; got ' + report.actual.blockedPoolCount);
    assert(report.actual.searchable === 5, 'actual searchable must equal the distributable count; got ' + report.actual.searchable);

    const quotaReport = await (await app.request('https://box.example/admin/search-quota/report', {
      headers: { Authorization: 'Bearer test-token' },
    })).json();
    assert(quotaReport.qualityPoolCount === 6, 'search-quota report must report full pool membership; got ' + quotaReport.qualityPoolCount);
    assert(quotaReport.distributablePoolCount === 5, 'search-quota report must report the distributable subset; got ' + quotaReport.distributablePoolCount);
    assert(quotaReport.blockedPoolCount === 1, 'search-quota report must report the blocked count; got ' + quotaReport.blockedPoolCount);
  }
  {
    // Config editor must expose manual and regex blocks separately, and
    // restoring a regex-blocked item must write an override so it stays
    // restored on the next config-data / output refresh.
    const regexSite = { key: 'bk-regex-site', name: 'Regex Site Alpha', type: 1, api: 'https://regex.example/site', searchable: 1, quickSearch: 1 };
    const regexLive = { name: 'Regex Live Alpha', url: 'https://regex.example/live.m3u' };
    const regexEntries = [
      { key: regexSite.key, name: regexSite.name, grade: 'excellent', speedMs: 100, result: 'ok', consecutiveFailures: 0 },
    ];
    const { app, storage } = makeApp({
      mergedConfig: { sites: [regexSite], lives: [regexLive] },
      mergedConfigFull: { sites: [regexSite], lives: [regexLive] },
      qualityPool: { updatedAt: new Date().toISOString(), entries: regexEntries },
      qualityCandidates: [regexSite],
      blacklist: {
        sites: [], parses: [], lives: [], regexRules: [
          { id: 'r-site', pattern: 'Regex Site', field: 'name', enabled: true, createdAt: new Date().toISOString() },
          { id: 'r-live', pattern: 'Regex Live', field: 'name', enabled: true, createdAt: new Date().toISOString() },
        ], regexBlockOverrides: [], regexLiveBlockOverrides: [],
      },
      quota: {
        startupMode: 'full', leanStartup: false, selectionMode: 'simple', maxSites: -1,
        quotaSchemaVersion: 9, bucketLimits: { quality: { untestable: -1 } },
      },
    });

    let data = await (await app.request('https://box.example/admin/config-data', {
      headers: { Authorization: 'Bearer test-token' },
    })).json();
    const siteRow = data.sites.find((site) => site.key === regexSite.key);
    const liveRow = data.lives.find((live) => live.url === regexLive.url);
    assert(siteRow, 'config-data must include the regex test site; rows=' + JSON.stringify(data.sites.map(s => ({ key: s.key, blocked: s.blocked, regexBlocked: s.regexBlocked, manualBlocked: s.manualBlocked }))));
    assert(siteRow.blocked === true && siteRow.regexBlocked === true && siteRow.manualBlocked !== true,
      'config-data must mark regex-blocked sites with separate status; row=' + JSON.stringify(siteRow));
    assert(liveRow, 'config-data must include the regex test live; rows=' + JSON.stringify(data.lives.map(l => ({ url: l.url, blocked: l.blocked, regexBlocked: l.regexBlocked, manualBlocked: l.manualBlocked }))));
    assert(liveRow.blocked === true && liveRow.regexBlocked === true && liveRow.manualBlocked === false,
      'config-data must mark regex-blocked lives with separate status; row=' + JSON.stringify(liveRow));

    let response = await app.request('https://box.example/admin/blacklist', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'sites', id: siteRow.fingerprint, regexName: regexSite.name }),
    });
    assert(response.status === 200, 'single regex site restore should succeed');

    response = await app.request('https://box.example/admin/blacklist/batch-delete', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'lives', ids: [regexLive.url], regexLiveUrls: [regexLive.url] }),
    });
    assert(response.status === 200, 'batch regex live restore should succeed');

    const stored = JSON.parse(await storage.get('blacklist'));
    assert(stored.regexBlockOverrides.includes(regexSite.name), 'site regex restore must persist name override');
    assert(stored.regexLiveBlockOverrides.includes(regexLive.url), 'live regex restore must persist URL override');

    data = await (await app.request('https://box.example/admin/config-data', {
      headers: { Authorization: 'Bearer test-token' },
    })).json();
    const restoredSite = data.sites.find((site) => site.key === regexSite.key);
    const restoredLive = data.lives.find((live) => live.url === regexLive.url);
    assert(restoredSite && restoredSite.blocked === false, 'restored regex site must become available');
    assert(restoredLive && restoredLive.blocked === false, 'restored regex live must become available');
  }  {
    // Schema 8 used untestable:0 as an implicit cap. It must migrate to
    // unlimited so old KV values do not hide all client-verifiable sources.
    const legacyQuota = {
      maxQuickSearch: 20,
      maxStartupQuickSearch: 20,
      maxParses: 3,
      bucketLimits: { quality: { untestable: 0 } },
      pinnedKeys: [],
      sortBySpeed: true,
      leanStartup: false,
      startupMode: 'full',
      quotaSchemaVersion: 8,
    };
    const { app } = makeApp({ quota: legacyQuota });
    const sites = await readSites(await app.request('https://box.example/'));
    assert(sites.some((site) => site.key === 'source-client-fallback'),
      'schema 8 untestable:0 must migrate to unlimited client fallback');
  }

  {
    // Schema 9 is explicit: untestable:0 means the operator chose no client
    // fallback, and must remain an exclusion rather than being migrated.
    const explicitQuota = {
      maxQuickSearch: 20,
      maxStartupQuickSearch: 20,
      maxParses: 3,
      bucketLimits: { quality: { untestable: 0 } },
      pinnedKeys: [],
      sortBySpeed: true,
      leanStartup: false,
      startupMode: 'full',
      quotaSchemaVersion: 9,
    };
    const { app } = makeApp({ quota: explicitQuota });
    const sites = await readSites(await app.request('https://box.example/'));
    assert(!sites.some((site) => site.key === 'source-client-fallback'),
      'schema 9 untestable:0 must explicitly exclude client fallback');
  }

  {
    const quota = {
      maxQuickSearch: 20,
      maxStartupQuickSearch: 20,
      maxParses: 3,
      bucketLimits: { type: { xml: 1 }, quality: { untestable: 1 } },
      pinnedKeys: ['source-xml-good', 'source-client-fallback'],
      sortBySpeed: true,
      leanStartup: false,
      startupMode: 'full',
      quotaSchemaVersion: 8,
    };
    const { app } = makeApp({ quota });
    const sites = await readSites(await app.request('https://box.example/'));
    const keys = sites.map((site) => site.key);
    assert(keys.includes('source-client-fallback'), 'explicit untestable quota should allow a bounded client fallback');
    assert(!keys.includes('source-xml-good'), 'lower-quality pinned source must not consume the XML Top-N slot');
    assert(keys.includes('source-excellent'), 'XML Top-N must keep the best XML source');
    assert(keys.indexOf('source-client-fallback') < keys.indexOf('source-excellent'), 'pinning should reorder only after bucket selection');
  }

  {
    const mergedWithUnranked = {
      ...mergedConfig,
      sites: [...mergedConfig.sites, {
        key: 'source-outside-pool',
        name: '质量池外源',
        type: 1,
        api: 'https://source.example/outside-pool',
        searchable: 1,
      }],
    };
    const { app } = makeApp({ mergedConfig: mergedWithUnranked });
    const sites = await readSites(await app.request('https://box.example/config-full.json'));
    const keys = sites.map((site) => site.key);
    assert(!keys.includes('source-outside-pool'), 'full config must not restore searchable sources outside the quality pool');
    assert(!keys.includes('source-timeout'), 'full config must not restore timeout sources');
    assert(keys.includes('source-client-fallback'), 'full config should keep the default client-runtime fallback');
    assert(keys.includes('source-plugin'), 'full config may keep non-searchable functional extensions');
  }

  {
    const expiredPool = {
      ...qualityPool,
      updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const expiredDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-expired',
        label: '过期池',
        code: 'expired-pool',
        enabled: true,
        sourceMode: 'selected',
        maxSites: -1,
        includeGrades: [],
        siteTypes: [],
        selectedKeys: [],
        pinnedKeys: [],
      }],
    };
    const { app } = makeApp({ qualityPool: expiredPool, distribution: expiredDistribution });
    const sites = await readSites(await app.request('https://box.example/auth/expired-pool/'));
    const searchable = sites.filter((site) => site.searchable === 1);
    assert(searchable.length >= 3, 'expired quality pool must keep the complete deduplicated searchable fallback');
    assert(searchable.some((site) => site.type === 3), 'expired quality pool fallback must retain client-executed JAR sources');
  }

  {
    const manifest = {
      version: 4,
      signature: 'routes-mode-manifest',
      entries: [
        {
          key: 'abc12345',
          name: '测试直播A',
          url: 'https://live.example/a.m3u',
          health: 'healthy',
          consecutiveFailures: 0,
          checkedAt: new Date().toISOString(),
          successfulAt: new Date().toISOString(),
          everSucceeded: true,
          textReady: true,
          format: 'm3u',
          category: 'cctv',
        },
        {
          key: 'def67890',
          name: '测试直播B',
          url: 'https://live.example/b.m3u',
          health: 'healthy',
          consecutiveFailures: 0,
          checkedAt: new Date().toISOString(),
          successfulAt: new Date().toISOString(),
          everSucceeded: true,
          textReady: true,
          format: 'm3u',
          category: 'satellite',
        },
      ],
    };
    const modeCandidatePool = {
      version: 1,
      groups: [
        { group: '央视', channels: [{ name: 'CCTV1', urls: ['https://live.example/cctv.m3u$测试直播A#abc12345'] }] },
        { group: '卫视', channels: [{ name: '湖南卫视', urls: ['https://live.example/hunan.m3u$测试直播B#def67890'] }] },
      ],
    };
    const modeConfig = {
      sites: mergedConfig.sites,
      lives: [
        { name: '旧合并入口', type: 0, url: 'https://box.example/live' },
        { name: '旧分离入口', type: 0, url: 'https://box.example/live/abc12345' },
      ],
    };
    const separated = makeApp({ mergedConfig: modeConfig, liveMergeMode: 'separated', liveProxyManifest: manifest });
    const separatedRoot = await (await separated.app.request('https://box.example/')).json();
    const separatedAuth = await (await separated.app.request('https://box.example/auth/code-a/')).json();
    assert(separatedRoot.lives.length === 2, 'separated root mode must deliver every selected /live/<key> entry, got ' + separatedRoot.lives.length);
    assert(separatedRoot.lives.every((live) => /\/live\/[^/]+$/.test(live.url)), 'separated root mode must not deliver the aggregate /live entry');
    assert(!separatedRoot.lives.some((live) => /\/live\/?$/.test(live.url)), 'separated root mode must not mix in merged /live');
    assert(separatedAuth.lives.length === separatedRoot.lives.length, 'separated auth mode must follow the same exclusive output rule');
    const separatedJson = await (await separated.app.request('https://box.example/live.json')).json();
    assert(separatedJson.lives.length === 2, 'separated /live.json must expose selected /live/<key> entries');
    assert(separatedJson.lives.every((live) => /\/live\/[^/]+$/.test(live.url)), 'separated /live.json must not expose aggregate /live');

    const merged = makeApp({
      mergedConfig: modeConfig,
      liveMergeMode: 'merged',
      liveProxyManifest: manifest,
      channelCandidateUrls: modeCandidatePool,
    });
    const mergedRebuild = await merged.app.request('https://box.example/admin/live-distribution', {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachToRoot: true, attachToAuth: true }),
    });
    assert(mergedRebuild.status === 200, 'merged output must be rebuildable before config delivery');
    const mergedRoot = await (await merged.app.request('https://box.example/')).json();
    const mergedAuth = await (await merged.app.request('https://box.example/auth/code-a/')).json();
    assert(mergedRoot.lives.length === 1, 'merged root mode must deliver exactly one aggregate entry, got ' + mergedRoot.lives.length);
    assert(/\/live\/?$/.test(mergedRoot.lives[0].url), 'merged root mode must deliver the aggregate /live entry');
    assert(!mergedRoot.lives.some((live) => /\/live\/[^/]+$/.test(live.url)), 'merged root mode must not leak /live/<key> entries');
    assert(mergedAuth.lives.length === 1 && !/\/live\/[^/]+$/.test(mergedAuth.lives[0].url), 'merged auth mode must not leak separated entries');
    const mergedJson = await (await merged.app.request('https://box.example/live.json')).json();
    assert(mergedJson.lives.length === 1 && /\/live\/?$/.test(mergedJson.lives[0].url), 'merged /live.json must expose exactly one aggregate /live');

    const renderSeparated = makeApp({
      mergedConfig: modeConfig,
      liveMergeMode: 'separated',
      liveProxyManifest: manifest,
      liveTextByKey: {
        abc12345: '央视频道,#genre#\nCCTV1,https://live.example/cctv.m3u',
        def67890: '卫视频道,#genre#\n湖南卫视,https://live.example/hunan.m3u',
      },
      config: { workerBaseUrl: '', localBaseUrl: 'https://render.example' },
    });
    const renderSeparatedRoot = await (await renderSeparated.app.request('https://render.example/')).json();
    assert(renderSeparatedRoot.lives.length === 2, 'render separated root must deliver every /live/<key> entry');
    assert(renderSeparatedRoot.lives.every((live) => live.url.startsWith('https://render.example/live/')), 'render separated root must use the deployed root URL');
    assert(!renderSeparatedRoot.lives.some((live) => /\/live\/?$/.test(live.url)), 'render separated root must not deliver aggregate /live');
    const renderSeparatedJson = await (await renderSeparated.app.request('https://render.example/live.json')).json();
    assert(renderSeparatedJson.lives.length === 2, 'render separated /live.json must deliver every /live/<key> entry');
    assert(!JSON.stringify(renderSeparatedRoot).includes('{{BASE_URL}}'), 'render separated root must resolve BASE_URL placeholder');
    const renderLive = await renderSeparated.app.request('https://render.example/live/abc12345');
    assert(renderLive.status === 200, 'render separated /live/<key> must be available, got ' + renderLive.status);
    assert((renderLive.headers.get('content-type') || '').includes('text/plain'), 'render separated /live/<key> must return text');
    assert((await renderLive.text()).includes('#genre#'), 'render separated /live/<key> must return live text');

    const renderMerged = makeApp({
      mergedConfig: modeConfig,
      liveMergeMode: 'merged',
      liveProxyManifest: manifest,
      channelCandidateUrls: modeCandidatePool,
      config: { workerBaseUrl: '', localBaseUrl: 'https://render.example' },
    });
    const renderMergedRebuild = await renderMerged.app.request('https://render.example/admin/live-distribution', {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachToRoot: true, attachToAuth: true }),
    });
    assert(renderMergedRebuild.status === 200, 'render merged output must be rebuildable before config delivery');
    const renderMergedRoot = await (await renderMerged.app.request('https://render.example/')).json();
    assert(renderMergedRoot.lives.length === 1 && /\/live\/?$/.test(renderMergedRoot.lives[0].url), 'render merged root must deliver exactly one aggregate /live');
    assert(!renderMergedRoot.lives.some((live) => /\/live\/[^/]+$/.test(live.url)), 'render merged root must not leak /live/<key> entries');
    const renderMergedJson = await (await renderMerged.app.request('https://render.example/live.json')).json();
    assert(renderMergedJson.lives.length === 1 && /\/live\/?$/.test(renderMergedJson.lives[0].url), 'render merged /live.json must deliver exactly one aggregate /live');
    assert(!JSON.stringify(renderMergedJson).includes('/live/'), 'render merged /live.json must not leak separated entries');
    const detached = makeApp({
      mergedConfig: modeConfig,
      liveMergeMode: 'separated',
      liveProxyManifest: manifest,
      liveDistribution: { attachToRoot: false, attachToAuth: false },
    });
    const detachedRoot = await (await detached.app.request('https://box.example/')).json();
    const detachedAuth = await (await detached.app.request('https://box.example/auth/code-a/')).json();
    assert(detachedRoot.lives.length === 0, 'detached root config must not carry live entries');
    assert(detachedAuth.lives.length === 0, 'detached auth config must not carry live entries');

    const full = await (await merged.app.request('https://box.example/config-full.json')).json();
    assert(full.lives.length === 1 && /\/live\/?$/.test(full.lives[0].url), 'full config must obey the selected exclusive mode');
  }
  {
    const coldStartCandidatePool = {
      version: 1,
      groups: [
        { group: '央视', channels: [{ name: 'CCTV1', urls: ['https://live.example/cctv.m3u$测试直播A#abc12345'] }] },
        { group: '卫视', channels: [{ name: '湖南卫视', urls: ['https://live.example/hunan.m3u$测试直播B#def67890'] }] },
      ],
    };
    const coldStartManifest = {
      version: 4,
      signature: 'cold-start-recovery',
      entries: [
        {
          key: 'abc12345',
          name: '测试直播A',
          url: 'https://live.example/cctv.m3u',
          health: 'unhealthy',
          consecutiveFailures: 1,
          checkedAt: new Date().toISOString(),
          everSucceeded: true,
          lastFailure: 'transient',
          textReady: true,
          format: 'm3u',
          category: 'cctv',
        },
        {
          key: 'def67890',
          name: '测试直播B',
          url: 'https://live.example/hunan.m3u',
          health: 'unhealthy',
          consecutiveFailures: 1,
          checkedAt: new Date().toISOString(),
          everSucceeded: true,
          lastFailure: 'transient',
          textReady: true,
          format: 'm3u',
          category: 'satellite',
        },
      ],
    };
    const coldStart = makeApp({
      mergedConfig: { sites: mergedConfig.sites, lives: [] },
      liveMergeMode: 'merged',
      liveProxyManifest: coldStartManifest,
      channelCandidateUrls: coldStartCandidatePool,
      config: { workerBaseUrl: '', localBaseUrl: 'https://render.example' },
    });
    const coldResponse = await coldStart.app.request('https://render.example/live');
    const coldText = await coldResponse.text();
    assert(coldResponse.status === 200, 'cold-start render /live must return 200, got ' + coldResponse.status);
    assert((coldResponse.headers.get('content-type') || '').includes('text/plain'), 'cold-start render /live must return text/plain');
    assert(coldText.trim().length > 0, 'cold-start render /live must not be empty');
    assert(coldText.includes('#genre#'), 'cold-start render /live must contain channel groups');
    assert(!coldText.trim().startsWith('{'), 'cold-start render /live must not return an error JSON body');
    assert(coldText.includes('测试直播A') && coldText.includes('测试直播B'), 'cold-start render /live must recover both structured candidate entries');

    const noTextManifest = {
      version: 4,
      signature: 'no-text-ready',
      entries: [{
        key: 'noprebuilt01',
        name: '无预构建文本',
        url: 'https://live.example/no-text.m3u',
        health: 'healthy',
        consecutiveFailures: 0,
        checkedAt: new Date().toISOString(),
        successfulAt: new Date().toISOString(),
        everSucceeded: true,
        format: 'm3u',
        category: 'cctv',
      }],
    };
    const noText = makeApp({
      mergedConfig: { sites: mergedConfig.sites, lives: [] },
      liveMergeMode: 'separated',
      liveProxyManifest: noTextManifest,
      config: { workerBaseUrl: '', localBaseUrl: 'https://render.example' },
    });
    const noTextRoot = await (await noText.app.request('https://render.example/')).json();
    assert(noTextRoot.lives.length === 0, 'manifest entry without prebuilt text must not be delivered');
    const noTextLive = await noText.app.request('https://render.example/live/noprebuilt01');
    assert(noTextLive.status === 200, 'manifest entry without text must return 200 empty text, got ' + noTextLive.status);
    assert((await noTextLive.text()) === '', 'manifest entry without text must return empty body');
    assert(noTextLive.headers.get('x-live-source-state') === 'unavailable', 'manifest entry without text must report unavailable');
    const missingLive = await noText.app.request('https://render.example/live/unknown-key');
    assert(missingLive.status === 200, 'unknown live key must return 200 empty text, got ' + missingLive.status);
    assert((await missingLive.text()) === '', 'unknown live key must not return an error body');
    assert(missingLive.headers.get('x-live-source-state') === 'missing', 'unknown live key must report missing state');

    const coldRestricted = makeApp({
      mergedConfig: { sites: mergedConfig.sites, lives: [] },
      liveMergeMode: 'merged',
      liveProxyManifest: coldStartManifest,
      channelCandidateUrls: coldStartCandidatePool,
      liveDistribution: {
        selectionMode: 'category',
        maxSources: -1,
        bucketLimits: { cctv: 1, satellite: 0, local: 0, variety: 0, special: 0, ipv6: 0, other: 0 },
      },
      config: { workerBaseUrl: '', localBaseUrl: 'https://render.example' },
    });
    const restrictedResponse = await coldRestricted.app.request('https://render.example/auth/code-a/live');
    const restrictedText = await restrictedResponse.text();
    assert(restrictedResponse.status === 200, 'cold-start restricted auth /live must return 200');
    assert(restrictedText.includes('测试直播A'), 'cold-start restricted auth /live must keep the allowed category');
    assert(!restrictedText.includes('测试直播B'), 'cold-start restricted auth /live must not leak categories whose limit is zero');
  }

  {
    const { app } = makeApp();
    const response = await app.request('https://box.example/missing.jpg');
    assert(response.status === 404, 'unknown non-config route should remain unrelated to auth');
  }

  {
    const { app } = makeApp();
    for (const requestPath of ['/credential/anything', '/admin/cloud-login', '/admin/cloud-credentials', '/token.json', '/tvfan/config']) {
      const response = await app.request('https://box.example' + requestPath);
      assert(response.status === 404, 'removed credential route should be 404: ' + requestPath);
    }
  }

  {
    const { app } = makeApp({
      config: { workerBaseUrl: '', localBaseUrl: 'https://local.example' },
    });
    const rootResponse = await app.request('https://local.example/');
    assert(rootResponse.status === 200, 'local base URL should serve root when worker base URL is empty');
    const body = await rootResponse.json();
    assert(Array.isArray(body.sites) && body.sites.some((site) => site.key === 'source-custom-type'), 'local base URL should serve sources');
  }

  {
    const { app } = makeApp({
      distribution: { ...distribution, requireAuth: true },
    });
    for (const requestPath of ['/', '/index.json', '/live', '/live.json', '/jar/source-key', '/api/source-key']) {
      const response = await app.request('https://box.example' + requestPath);
      assert(response.status === 401, 'root/proxy route should be 401 when requireAuth=true: ' + requestPath);
    }
  }

  {
    const originalFetch = global.fetch;
    const seenHeaders = [];
    global.fetch = async (_url, init = {}) => {
      seenHeaders.push(new Headers(init.headers || {}));
      return new Response('reader-ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    };
    try {
      const publicApp = makeApp().app;
      const publicResponse = await publicApp.request('https://box.example/reader-proxy?url=https%3A%2F%2Fsource.example%2Fpage&cookie=server-secret');
      assert(publicResponse.status === 200, 'reader proxy should remain usable when auth is not required');
      assert(seenHeaders.length === 1, 'reader proxy should perform one upstream fetch');
      assert(!seenHeaders[0].has('cookie'), 'reader proxy must not forward cookie query parameter');

      const authApp = makeApp({ distribution: { ...distribution, requireAuth: true } }).app;
      const blocked = await authApp.request('https://box.example/reader-proxy?url=https%3A%2F%2Fsource.example%2Fpage');
      assert(blocked.status === 401, 'reader proxy should require an auth link when requireAuth=true');

      const authResponse = await authApp.request('https://box.example/auth/code-a/reader-proxy?url=https%3A%2F%2Fsource.example%2Fpage');
      assert(authResponse.status === 200, 'auth reader proxy should reach proxy handling');
      assert(seenHeaders.length === 2, 'auth reader proxy should perform one upstream fetch');
    } finally {
      global.fetch = originalFetch;
    }
  }

  {
    const { app } = makeApp({
      distribution: { ...distribution, requireAuth: true },
    });
    const invalid = await app.request('https://box.example/auth/not-found/');
    assert(invalid.status === 403, 'invalid auth code should be forbidden');
  }

  {
    const { app } = makeApp();
    const a = await readSites(await app.request('https://box.example/auth/code-a/'));
    assert(a.some((site) => site.key === 'source-excellent') && !a.some((site) => site.key === 'source-good'), 'code-a should receive only excellent searchable sites');
    assert(a.some((site) => site.key === 'source-plugin'), 'quality-only auth policies must retain non-searchable functional plugins');

    const b = await readSites(await app.request('https://box.example/auth/code-b/'));
    assert(b.some((site) => site.key === 'source-plugin'), 'code-b should retain non-searchable type 3 plugins');
    assert(b.some((site) => site.key === 'source-client-fallback'), 'code-b should retain searchable client-runtime sources');
  }

  {
    const controlledFallback = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-controlled-fallback',
        label: '受控客户端后备',
        code: 'controlled-fallback',
        enabled: true,
        sourceMode: 'search',
        maxSites: -1,
        bucketLimits: { quality: { excellent: -1, good: -1, usable: -1, untestable: 1 } },
        selectedKeys: [],
        pinnedKeys: ['source-client-fallback'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({ distribution: controlledFallback });
    const sites = await readSites(await app.request('https://box.example/auth/controlled-fallback/'));
    const fallbackCount = sites.filter((site) => site.key === 'source-client-fallback').length;
    assert(fallbackCount === 1, 'explicit untestable policy should include at most the configured count: ' + sites.map((site) => site.key).join(','));
    assert(!sites.some((site) => site.key === 'source-timeout'), 'timeout sources must remain excluded under fallback policy');
  }

  {
    const fallbackSites = Array.from({ length: 6 }, (_, index) => ({
      key: 'source-extra-fallback-' + (index + 1),
      name: 'Client fallback ' + (index + 1),
      type: 3,
      api: 'csp_ClientFallback' + (index + 1),
      searchable: 1,
    }));
    const fallbackEntries = fallbackSites.map((site) => ({
      key: site.key,
      name: site.name,
      grade: 'untestable',
      speedMs: null,
      result: 'not_probed',
      consecutiveFailures: 0,
    }));
    const expandedMergedConfig = {
      ...mergedConfig,
      sites: [...mergedConfig.sites, ...fallbackSites],
    };
    const expandedQualityPool = {
      ...qualityPool,
      entries: [...qualityPool.entries, ...fallbackEntries],
    };

    const { app: defaultApp } = makeApp({
      mergedConfig: expandedMergedConfig,
      qualityPool: expandedQualityPool,
    });
    const defaultSites = await readSites(await defaultApp.request('https://box.example/'));
    const defaultFallbacks = defaultSites.filter((site) => site.key.startsWith('source-extra-fallback-'));
    const allDefaultFallbacks = defaultSites.filter((site) => site.key === 'source-client-fallback' || site.key.startsWith('source-extra-fallback-'));
    assert(defaultFallbacks.length === 6 && allDefaultFallbacks.length === 7,
      'root default must include every untestable searchable JAR without an implicit cap: ' + allDefaultFallbacks.map((site) => site.key).join(','));
    assert(defaultSites.findIndex((site) => site.key === 'source-excellent')
      < defaultSites.findIndex((site) => site.key === defaultFallbacks[0].key),
    'server-verified sources must precede client-runtime fallbacks');

    const explicitZero = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-no-fallback',
        label: 'No fallback',
        code: 'no-fallback',
        enabled: true,
        sourceMode: 'search',
        maxSites: -1,
        bucketLimits: { quality: { untestable: 0 } },
        selectedKeys: [],
        pinnedKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app: zeroApp } = makeApp({
      mergedConfig: expandedMergedConfig,
      qualityPool: expandedQualityPool,
      distribution: explicitZero,
    });
    const zeroSites = await readSites(await zeroApp.request('https://box.example/auth/no-fallback/'));
    assert(!zeroSites.some((site) => site.key.startsWith('source-extra-fallback-')),
      'explicit untestable=0 must exclude every client-runtime fallback');

    const explicitAll = {
      ...explicitZero,
      authCodes: [{
        ...explicitZero.authCodes[0],
        id: 'auth-all-fallback',
        code: 'all-fallback',
        label: 'All fallback',
        bucketLimits: { quality: { untestable: -1 } },
      }],
    };
    const { app: allApp } = makeApp({
      mergedConfig: expandedMergedConfig,
      qualityPool: expandedQualityPool,
      distribution: explicitAll,
    });
    const allSites = await readSites(await allApp.request('https://box.example/auth/all-fallback/'));
    assert(allSites.filter((site) => site.key.startsWith('source-extra-fallback-')).length === 6,
      'explicit untestable=-1 must include every client-runtime fallback');
  }

  {
    const searchModeDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-search',
        label: '仅可搜索源',
        code: 'search-only',
        enabled: true,
        sourceMode: 'search',
        maxSites: -1,
        includeGrades: [],
        siteTypes: [],
        pinnedKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({ distribution: searchModeDistribution });
    const searchable = await readSites(await app.request('https://box.example/auth/search-only/'));
    const keys = searchable.map((site) => site.key).sort().join(',');
    assert(keys === 'source-client-fallback,source-custom-type,source-excellent,source-good,source-xml-good', 'search mode should include only searchable sites, got ' + keys);
  }

  {
    const limitedDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-limit',
        label: '限制可搜索源',
        code: 'limit-search',
        enabled: true,
        sourceMode: 'all',
        maxSites: 1,
        includeGrades: [],
        siteTypes: [],
        pinnedKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({ distribution: limitedDistribution });
    const limited = await readSites(await app.request('https://box.example/auth/limit-search/'));
    assert(limited.length === 1, 'maxSites=1 must cap the total distributed site count including JAR/plugins');
    assert(limited[0].searchable === 1, 'simple Top-1 must take the highest-ranked source available after filtering');
    assert(!limited.some((site) => site.key === 'source-plugin'), 'simple maxSites must not silently append a non-searchable plugin beyond N');
  }

  {
    const zeroAuthDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-zero-total',
        label: '不下发任何源',
        code: 'zero-total',
        enabled: true,
        sourceMode: 'all',
        selectionMode: 'simple',
        maxSites: 0,
        includeGrades: [],
        siteTypes: [],
        pinnedKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const zeroQuota = { startupMode: 'full', leanStartup: false, selectionMode: 'simple', maxSites: 0 };
    const { app } = makeApp({ distribution: zeroAuthDistribution, quota: zeroQuota });
    const authSites = await readSites(await app.request('https://box.example/auth/zero-total/'));
    const rootSites = await readSites(await app.request('https://box.example/'));
    assert(authSites.length === 0, 'maxSites=0 must distribute no sources at all through auth links');
    assert(rootSites.length === 0, 'maxSites=0 must distribute no sources at all through the root link');
  }
  {
    const customDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-custom',
        label: '指定源',
        code: 'custom-a',
        enabled: true,
        sourceMode: 'custom',
        maxSites: -1,
        includeGrades: [],
        siteTypes: [],
        selectedKeys: ['source-good'],
        pinnedKeys: ['source-plugin'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({ distribution: customDistribution });
    const custom = await readSites(await app.request('https://box.example/auth/custom-a/'));
    const keys = custom.map((site) => site.key).sort().join(',');
    assert(keys === 'source-good', 'custom mode must not let pinned keys bypass selectedKeys, got ' + keys);
  }

  {
    const { app } = makeApp();
    const response = await app.request('https://box.example/admin/client-distribution', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requireAuth: false,
        authCodes: [{
          id: 'auth-custom',
          label: '空白名单',
          code: 'custom-empty',
          enabled: true,
          sourceMode: 'custom',
          selectedKeys: [],
          pinnedKeys: [],
        }],
      }),
    });
    assert(response.status === 400, 'custom mode with empty selectedKeys should be rejected');
  }

  {
    const pinnedPolicyDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-pinned-policy',
        label: '置顶边界',
        code: 'pinned-policy',
        enabled: true,
        sourceMode: 'all',
        maxSites: -1,
        includeGrades: ['excellent'],
        siteTypes: ['xml'],
        bucketLimits: { type: { xml: 0 } },
        selectedKeys: [],
        pinnedKeys: ['source-good', 'source-excellent'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({ distribution: pinnedPolicyDistribution });
    const sites = await readSites(await app.request('https://box.example/auth/pinned-policy/'));
    assert(sites.map((site) => site.key).sort().join(',') === 'source-plugin,source-quick-only', 'pinned keys must not bypass searchable-source exclusions, while functional non-searchable plugins remain available; got ' + sites.map((site) => site.key).join(','));

    const pinnedLimitDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-pinned-limit',
        label: '置顶上限',
        code: 'pinned-limit',
        enabled: true,
        sourceMode: 'all',
        maxSites: 1,
        includeGrades: [],
        siteTypes: [],
        selectedKeys: [],
        pinnedKeys: ['source-good', 'source-excellent'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const limited = makeApp({ distribution: pinnedLimitDistribution });
    const limitedSites = await readSites(await limited.app.request('https://box.example/auth/pinned-limit/'));
    assert(limitedSites.filter((site) => site.searchable === 1).length === 1 && limitedSites[0].key === 'source-excellent', 'pinned keys must only affect order and must not exceed maxSites, got ' + limitedSites.map((site) => site.key).join(','));
  }

  {
    const dynamicTypeDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-dynamic-type',
        label: '动态类型桶',
        code: 'dynamic-type',
        enabled: true,
        sourceMode: 'all',
        maxSites: -1,
        bucketLimits: { type: { other: 0, xml: -1 } },
        includeGrades: [],
        siteTypes: [],
        pinnedKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({ distribution: dynamicTypeDistribution });
    const sites = await readSites(await app.request('https://box.example/auth/dynamic-type/'));
    assert(!sites.some((site) => site.key === 'source-custom-type'), 'other type bucket 0 must exclude unclassified sources');
    assert(sites.some((site) => site.key === 'source-excellent'), 'unknown neighboring type bucket must not block type 0');
  }

  {
    const { app } = makeApp();
    const root = await readSites(await app.request('https://box.example/'));
    assert(root.some((site) => site.key === 'source-custom-type'), 'root link must not be filtered by auth-code policy');
    const auth = await readSites(await app.request('https://box.example/auth/code-a/'));
    assert(auth.length < root.length, 'auth link must be independently filtered');
  }

  {
    const { app } = makeApp();
    const response = await app.request('https://box.example/auth/code-a/live');
    assert(response.status === 200, 'auth live route should work');
    const text = await response.text();
    assert(!text.includes('/live/'), 'empty live body should not be rewritten unexpectedly');
  }

  {
    const { app } = makeApp();
    const response = await app.request('https://box.example/admin/config-data', {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert(response.status === 200, 'admin config-data should return 200, got ' + response.status);
    const body = await response.json();
    assert(body.searchQuality && body.searchQuality.searchableCategoryCounts, 'config-data should expose searchable source category counts');
    assert(Array.isArray(body.searchQuality.qualityPoolKeys), 'config-data should expose quality pool keys');
    assert(body.searchQuality.qualityPoolCategoryCounts, 'config-data should expose quality pool category counts');
    assert(body.searchQuality.distributablePoolCategoryCounts, 'config-data should expose distributable pool category counts');
    assert(Array.isArray(body.searchQuality.distributablePoolKeys), 'config-data should expose distributable pool keys');
    assert(typeof body.searchQuality.assessedSourceCount === 'number', 'config-data should expose assessed source count');
    assert(typeof body.searchQuality.qualityPoolCount === 'number', 'config-data should expose quality pool count');
    assert(typeof body.searchQuality.distributablePoolCount === 'number', 'config-data should expose distributable pool count');
    const categories = ['xml', 'json', 'jar', 'js', 'remote', 'other'];
    const sumCounts = (counts) => categories.reduce((sum, key) => sum + (Number(counts[key]) || 0), 0);
    assert(sumCounts(body.searchQuality.searchableCategoryCounts) === body.searchQuality.searchableCount, 'searchable category counts must equal searchable count');
    assert(sumCounts(body.searchQuality.qualityPoolCategoryCounts) === body.searchQuality.qualityPoolCount, 'quality pool category counts must equal quality pool count');
    assert(sumCounts(body.searchQuality.distributablePoolCategoryCounts) === body.searchQuality.distributablePoolCount, 'distributable pool category counts must equal distributable pool count');
    assert(body.searchQuality.assessedSourceCount === qualityPool.entries.length, 'assessed source count must equal quality snapshot total');
    assert(!('candidateKeys' in body.searchQuality), 'config-data must not expose duplicate candidate keys');
    assert(!('candidateCount' in body.searchQuality), 'config-data must not expose duplicate candidate count');
    assert(!('candidateCategoryCounts' in body.searchQuality), 'config-data must not expose duplicate candidate category counts');
    assert(!('categoryCounts' in body.searchQuality), 'config-data must use searchableCategoryCounts');
    assert(!('qualityPoolTotal' in body.searchQuality), 'config-data must not expose duplicate quality pool total');
    assert(!('qualitySnapshotTotal' in body.searchQuality), 'config-data must not expose duplicate quality snapshot total');
    assert(body.searchQuality.qualityPoolKeys.includes('source-client-fallback'), 'untestable source must remain in the quality pool');
    const byKey = new Map(body.sites.map((site) => [site.key, site]));
    assert(byKey.get('source-excellent').sourceCategory === 'xml', 'type 0 site should classify as xml');
    assert(byKey.get('source-good').sourceCategory === 'json', 'type 1 site should classify as json');
    assert(byKey.get('source-custom-type').sourceCategory === 'other', 'unknown site type should classify as other');
    for (const category of categories) {
      const searchableSites = body.sites.filter((site) => site.inFinal && !site.blocked && site.searchable === 1 && site.sourceCategory === category);
      const qualityPoolSites = searchableSites.filter((site) => site.inQualityPool === true);
      assert(searchableSites.length === body.searchQuality.searchableCategoryCounts[category], 'searchable category count mismatch for ' + category + ': list=' + searchableSites.length + ', server=' + body.searchQuality.searchableCategoryCounts[category]);
      assert(qualityPoolSites.length === body.searchQuality.qualityPoolCategoryCounts[category], 'quality pool category count mismatch for ' + category + ': list=' + qualityPoolSites.length + ', server=' + body.searchQuality.qualityPoolCategoryCounts[category]);
    }
    const sampleSite = byKey.get('source-excellent');
    assert(sampleSite && !('candidate' in sampleSite) && !('qualityPoolMember' in sampleSite), 'source response must not expose duplicate pool flags');
  }

  console.log('regression: route auth and source distribution checks passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
