const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');

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
      maxSearchable: -1,
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
      maxSearchable: -1,
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
    search_quality_pool: JSON.stringify(overrides.qualityPool || qualityPool),
    client_auth_distribution: JSON.stringify(overrides.distribution || distribution),
    ...(overrides.quota ? { search_quota: JSON.stringify(overrides.quota) } : {}),
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

async function readSites(response) {
  assert(response.status === 200, 'expected 200, got ' + response.status);
  const body = await response.json();
  assert(Array.isArray(body.sites), 'response should contain sites');
  assert(!JSON.stringify(body).includes('__upstreamNames'), 'internal upstream marker must not leak');
  return body.sites;
}

(async () => {
  {
    const { app } = makeApp();
    const sites = await readSites(await app.request('https://box.example/'));
    assert(sites.length >= 2, 'root link should receive enabled startup sites when requireAuth is false');
    const keys = sites.map((site) => site.key);
    assert(keys.includes('source-client-fallback'), 'root link should include a bounded client-runtime fallback');
    assert(!keys.includes('source-timeout'), 'root link must never distribute timeout sources');
    assert(keys.indexOf('source-excellent') < keys.indexOf('source-good'), 'root link must preserve the quality-pool order');
  }

  {
    const quota = {
      maxSearchable: 0,
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
    assert(keys.includes('source-client-fallback'), 'full config should keep the default bounded client-runtime fallback');
    assert(keys.includes('source-plugin'), 'full config may keep non-searchable functional extensions');
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
    assert(a.length === 1 && a[0].key === 'source-excellent', 'code-a should receive only excellent sites');

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
        maxSearchable: -1,
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
    assert(defaultFallbacks.length === 3 && allDefaultFallbacks.length === 4,
      'default distribution must cap untestable searchable JARs at four: ' + allDefaultFallbacks.map((site) => site.key).join(','));
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
        maxSearchable: -1,
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
        maxSearchable: -1,
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
        maxSites: -1,
        maxSearchable: 1,
        includeGrades: [],
        siteTypes: [],
        pinnedKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({ distribution: limitedDistribution });
    const limited = await readSites(await app.request('https://box.example/auth/limit-search/'));
    assert(limited.filter((site) => site.searchable === 1).length === 1, 'maxSearchable should count actual searchable sites only');
    assert(limited.filter((site) => site.searchable === 1).length === 1, 'maxSearchable must apply only to searchable sites');
    assert(limited.some((site) => site.key === 'source-plugin'), 'maxSearchable should keep non-searchable sites when maxSites is all');
  }

  {
    const zeroSearchDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-zero-search',
        label: '不下发可搜索源',
        code: 'zero-search',
        enabled: true,
        sourceMode: 'all',
        maxSites: -1,
        maxSearchable: 0,
        includeGrades: [],
        siteTypes: [],
        pinnedKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({ distribution: zeroSearchDistribution });
    const sites = await readSites(await app.request('https://box.example/auth/zero-search/'));
    assert(sites.every((site) => site.searchable !== 1), 'maxSearchable=0 must exclude every searchable site');
    assert(sites.some((site) => site.key === 'source-plugin'), 'maxSearchable=0 must keep non-searchable sites');
  }

  {
    const zeroTotalDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-zero-total',
        label: '不下发任何源',
        code: 'zero-total',
        enabled: true,
        sourceMode: 'all',
        maxSites: 0,
        maxSearchable: -1,
        includeGrades: [],
        siteTypes: [],
        pinnedKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    const { app } = makeApp({ distribution: zeroTotalDistribution });
    const sites = await readSites(await app.request('https://box.example/auth/zero-total/'));
    assert(sites.length === 0, 'maxSites=0 must exclude every source');
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
        maxSearchable: -1,
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
        maxSearchable: -1,
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
    assert(sites.length === 0, 'pinned keys must not bypass grade, type, or bucket exclusions, got ' + sites.map((site) => site.key).join(','));

    const pinnedLimitDistribution = {
      requireAuth: false,
      authCodes: [{
        id: 'auth-pinned-limit',
        label: '置顶上限',
        code: 'pinned-limit',
        enabled: true,
        sourceMode: 'all',
        maxSites: 1,
        maxSearchable: -1,
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
    assert(limitedSites.length === 1 && limitedSites[0].key === 'source-good', 'pinned keys must only affect order and must not exceed maxSites, got ' + limitedSites.map((site) => site.key).join(','));
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
        maxSearchable: -1,
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
    assert(body.searchQuality && body.searchQuality.categoryCounts, 'config-data should expose source category counts');
    assert(body.searchQuality.candidateCategoryCounts, 'config-data should expose candidate category counts');
    const categories = ['xml', 'json', 'jar', 'js', 'remote', 'other'];
    const sumCounts = (counts) => categories.reduce((sum, key) => sum + (Number(counts[key]) || 0), 0);
    assert(sumCounts(body.searchQuality.categoryCounts) === body.searchQuality.searchableCount, 'category counts must equal searchable count');
    assert(sumCounts(body.searchQuality.candidateCategoryCounts) === body.searchQuality.candidateCount, 'candidate category counts must equal candidate count');
    const byKey = new Map(body.sites.map((site) => [site.key, site]));
    assert(byKey.get('source-excellent').sourceCategory === 'xml', 'type 0 site should classify as xml');
    assert(byKey.get('source-good').sourceCategory === 'json', 'type 1 site should classify as json');
    assert(byKey.get('source-custom-type').sourceCategory === 'other', 'unknown site type should classify as other');
    for (const category of categories) {
      const searchableSites = body.sites.filter((site) => site.inFinal && !site.blocked && site.searchable === 1 && site.sourceCategory === category);
      const candidateSites = searchableSites.filter((site) => site.candidate === true);
      assert(searchableSites.length === body.searchQuality.categoryCounts[category], 'category count mismatch for ' + category + ': list=' + searchableSites.length + ', server=' + body.searchQuality.categoryCounts[category]);
      assert(candidateSites.length === body.searchQuality.candidateCategoryCounts[category], 'candidate category count mismatch for ' + category + ': list=' + candidateSites.length + ', server=' + body.searchQuality.candidateCategoryCounts[category]);
    }
  }

  console.log('regression: route auth and source distribution checks passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
