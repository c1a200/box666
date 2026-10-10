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
      key: 'source-quick-only',
      name: '仅快速搜索标记',
      type: 1,
      api: 'https://source.example/quick',
      searchable: 0,
      quickSearch: 1,
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
      maxSites: 0,
      maxSearchable: 0,
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
      maxSites: 0,
      maxSearchable: 0,
      includeGrades: [],
      siteTypes: [3],
      pinnedKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
};

function makeApp(overrides = {}) {
  const storage = new MemoryStorage({
    merged_config: JSON.stringify(mergedConfig),
    search_quality_pool: JSON.stringify(qualityPool),
    client_auth_distribution: JSON.stringify(overrides.distribution || distribution),
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
    assert(Array.isArray(body.sites) && body.sites.length === 3, 'local base URL should serve sources');
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
    assert(b.length === 1 && b[0].key === 'source-plugin', 'code-b should receive only type 3 sites');
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
        maxSites: 0,
        maxSearchable: 0,
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
    assert(keys === 'source-excellent,source-good', 'search mode should include only searchable sites, got ' + keys);
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
        maxSites: 0,
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
        maxSites: 0,
        maxSearchable: 0,
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
    assert(keys === 'source-good,source-plugin', 'custom mode should serve selected keys plus pinned keys, got ' + keys);
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
    const { app } = makeApp();
    const root = await readSites(await app.request('https://box.example/'));
    assert(root.length === 3, 'root link must not be filtered by auth-code policy');
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

  console.log('regression: route auth and source distribution checks passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});