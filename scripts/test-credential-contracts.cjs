const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, '.tmp-credential-contract-regression');
const BASE = 'https://base.example';
const JAR_2CC = '2cc088afa757ba8bafffcfbab4b73ccc';
const JAR_F782 = 'f782cdee81118405176fd260be9ca5cd';
const JAR_2386 = '2386c62eb5f0b84dd53e27ad0fe9db49';
const JAR_4CE29 = '4ce29ce27eeff6a73a230dd92d98ba0c';

function site(api, jar, ext = { 'Cloud-drive': 'tvfan/Cloud-drive.txt' }) {
  return {
    key: api + '_' + jar.slice(0, 6),
    name: api,
    type: 3,
    api,
    searchable: 1,
    jar: 'https://jar.example/' + jar + ';md5;' + jar,
    ext,
  };
}

function legacyContract(source, mechanism = 'unknown', platforms = []) {
  const jarMd5 = source.jar.split(';md5;').pop();
  const ext = source.ext && typeof source.ext === 'object' && !Array.isArray(source.ext)
    ? source.ext
    : {};
  const extKeys = Object.keys(ext).sort();
  const extPan = typeof ext.pan === 'string' ? ext.pan.trim().toLowerCase() : undefined;
  const pan = typeof source.pan === 'string' && source.pan.trim() ? source.pan.trim() : undefined;
  const extShape = source.ext == null ? 'null' : 'object';
  const contractHash = [
    jarMd5 || 'jar:none',
    source.api,
    extShape,
    extKeys.join(','),
    pan || '',
    extPan || '',
  ].join('|');
  return {
    api: source.api,
    jarMd5,
    extShape,
    extKeys,
    injectableExtKeys: extKeys.filter((key) => key === 'Cloud-drive' || key === 'quark' || key === 'uc' || key === 'baidu'),
    contractHash,
    siteKey: source.key,
    credentialMechanism: mechanism,
    credentialPlatforms: platforms,
  };
}
function parseExt(value) {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function credentials(platforms = ['quark', 'uc']) {
  const all = new Map([
    ['quark', { platform: 'quark', credential: { cookie: 'TEST_QUARK_COOKIE; __pus=TEST_PUS' }, status: 'valid', updatedAt: '2026-10-08T00:00:00.000Z' }],
    ['uc', { platform: 'uc', credential: { cookie: 'TEST_UC_COOKIE' }, status: 'valid', updatedAt: '2026-10-08T00:00:00.000Z' }],
  ]);
  return new Map(platforms.map((platform) => [platform, all.get(platform)]));
}

function inject(source, creds = credentials(), baseUrl = BASE, contract = null) {
  const contracts = contract ? new Map([[source.key, contract]]) : null;
  const result = injectCredentials(
    [source],
    creds,
    { deniedKeys: [] },
    baseUrl,
    null,
    contracts,
    false,
    Boolean(contract),
  );
  return { source: result.sites[0], ext: parseExt(result.sites[0].ext), report: result.report };
}

function fail(message) {
  throw new Error(message);
}

function expectTvfanConfig(ext, label, upstreamFields = []) {
  if (!ext || typeof ext['Cloud-drive'] !== 'string') fail(label + ': missing Cloud-drive URL');
  if (!/^https:\/\/base\.example\/tvfan\/config\?token=[^#]+$/.test(ext['Cloud-drive'])) {
    fail(label + ': unexpected Cloud-drive URL: ' + ext['Cloud-drive']);
  }
  const allowed = new Set(upstreamFields);
  for (const field of ['quark', 'uc', 'baidu']) {
    if (Object.prototype.hasOwnProperty.call(ext, field) && !allowed.has(field)) {
      fail(label + ': Cloud-drive contract must not add ext.' + field);
    }
  }
}

function expectPanInit(ext, label) {
  if (!ext || typeof ext.quark !== 'string') fail(label + ': missing Pan.init ext.quark URL');
  if (!/^https:\/\/base\.example\/credential\/quark\?v=/.test(ext.quark)) {
    fail(label + ': unexpected Pan.init URL: ' + ext.quark);
  }
  if (Object.prototype.hasOwnProperty.call(ext, 'Cloud-drive')
    && ext['Cloud-drive'] !== 'tvfan/Cloud-drive.txt') {
    fail(label + ': Pan.init contract changed upstream Cloud-drive entry');
  }
}

let injectCredentials;
let stripInjectedCredentialsFromConfig;

async function main() {
  fs.rmSync(OUTDIR, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [
      path.join(ROOT, 'src/core/credential-injector.ts'),
      path.join(ROOT, 'src/core/credential-sanitizer.ts'),
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outdir: OUTDIR,
    define: { __APP_VERSION: JSON.stringify('test'), __APP_COMMIT: JSON.stringify('test') },
    logLevel: 'silent',
  });
  ({ injectCredentials } = require(path.join(OUTDIR, 'credential-injector.js')));
  ({ stripInjectedCredentialsFromConfig } = require(path.join(OUTDIR, 'credential-sanitizer.js')));

  const cloudDriveGuards = [
    ['csp_YpanSoGuard', JAR_2CC],
    ['csp_BpanSoGuard', JAR_2CC],
    ['csp_PanSsoGuard', JAR_2CC],
    ['csp_XzSoGuard', JAR_2CC],
    ['csp_UuSsGuard', JAR_2CC],
    ['csp_KkSsGuard', JAR_2CC],
    ['csp_MIPanSoGuard', JAR_2CC],
    ['csp_LibvioGuard', JAR_2CC],
    ['csp_PanSearchGuard', JAR_2CC],
    ['csp_BpanSoGuard', JAR_F782],
    ['csp_PanSsoGuard', JAR_F782],
    ['csp_XzSoGuard', JAR_F782],
    ['csp_UuSsGuard', JAR_F782],
    ['csp_KkSsGuard', JAR_F782],
    ['csp_MIPanSoGuard', JAR_F782],
    ['csp_LibvioGuard', JAR_F782],
    ['csp_PanSearchGuard', JAR_F782],
    ['csp_YpanSoGuard', JAR_F782],
  ];

  for (const [api, jar] of cloudDriveGuards) {
    const source = site(api, jar);
    const result = inject(source);
    if (result.report.injected !== 1) fail(api + '/' + jar + ': expected one Cloud-drive injection, got ' + result.report.injected);
    expectTvfanConfig(result.ext, api + '/' + jar);

    const legacy = inject(site(api, jar), credentials(), BASE, legacyContract(source, 'unknown', []));
    if (legacy.report.injected !== 1) fail(api + '/' + jar + ': stale unknown KV contract expected one Cloud-drive injection');
    expectTvfanConfig(legacy.ext, api + '/' + jar + ' legacy');
  }

  const staleWrong = [
    ['csp_MyDriveGuard', JAR_2386],
    ['csp_YiSoGuard', JAR_2CC],
    ['csp_YiSoGuard', JAR_F782],
  ];
  for (const [api, jar] of staleWrong) {
    const source = site(api, jar, {
      'Cloud-drive': 'tvfan/Cloud-drive.txt',
      quark: 'https://upstream.example/quark-init',
      uc: 'UPSTREAM_UC',
      baidu: 'UPSTREAM_BAIDU',
    });
    const before = JSON.stringify(source.ext);
    const result = inject(source, credentials(), BASE, legacyContract(source, 'tvfan-config-url', ['quark', 'uc', 'baidu']));
    if (result.report.injected !== 0) fail(api + '/' + jar + ': stale wrong binding was injected');
    if (JSON.stringify(result.ext) !== before) fail(api + '/' + jar + ': stale wrong binding changed ext');
  }

  const unknown2386 = [
    ['csp_UuSsGuard', JAR_2386],
    ['csp_YpanSoGuard', JAR_2386],
    ['csp_WoGGGuard', JAR_2386],
    ['csp_BpanSoGuard', JAR_2386],
    ['csp_KkSsGuard', JAR_2386],
    ['csp_LibvioGuard', JAR_2386],
    ['csp_AiDjGuard', JAR_2386],
    ['csp_BiliGuard', JAR_2386],
    ['csp_S_zpsGuard', JAR_2386],
    ['csp_SeedhubGuard', JAR_2386],
  ];
  for (const [api, jar] of unknown2386) {
    const source = site(api, jar, {
      cookie: 'UPSTREAM',
      'Cloud-drive': 'tvfan/Cloud-drive.txt',
      'Ali-drive': 'https://upstream.example/ali-drive.txt',
      quark: 'https://upstream.example/quark-init',
      uc: 'UPSTREAM_UC',
      baidu: 'UPSTREAM_BAIDU',
    });
    const before = JSON.stringify(source.ext);
    const result = inject(source, credentials(), BASE, legacyContract(source, 'tvfan-config-url', ['quark', 'uc', 'baidu']));
    if (result.report.injected !== 0) fail(api + '/' + jar + ': 2386 unknown Guard was injected');
    if (JSON.stringify(result.ext) !== before) fail(api + '/' + jar + ': 2386 unknown Guard ext changed');
  }

  for (const [api, jar] of [['csp_WoGGGuard', JAR_F782], ['csp_WoGGGuard', JAR_4CE29]]) {
    const result = inject(site(api, jar));
    if (result.report.injected !== 1) fail(api + '/' + jar + ': expected Pan.init injection');
    expectPanInit(result.ext, api + '/' + jar);
  }

  const all = inject(site('csp_YpanSoGuard', JAR_2CC, {
    'Cloud-drive': 'tvfan/Cloud-drive.txt',
    'Ali-drive': 'https://upstream.example/ali-drive.txt',
    cookie: 'UPSTREAM_COOKIE',
    quark: 'https://upstream.example/quark-init',
    from: 'tvfan|keep-me',
  }), credentials());
  if (all.report.injected !== 1) fail('all policy expected injection');
  if (all.ext['Ali-drive'] !== 'https://upstream.example/ali-drive.txt') fail('all policy removed upstream Ali-drive');
  if (all.ext.cookie !== 'UPSTREAM_COOKIE') fail('all policy removed upstream cookie');
  if (all.ext.from !== 'tvfan|keep-me') fail('all policy removed upstream from');

  const selected = inject(site('csp_YpanSoGuard', JAR_2CC, {
    'Cloud-drive': 'tvfan/Cloud-drive.txt',
    cookie: 'UPSTREAM_COOKIE',
    quark: 'https://upstream.example/quark-init',
  }), credentials(['quark']));
  if (selected.report.injected !== 1) fail('selected policy expected quark injection');
  expectTvfanConfig(selected.ext, 'selected policy', ['quark']);
  if (selected.ext.cookie !== 'UPSTREAM_COOKIE') fail('selected policy removed upstream cookie');
  if (selected.ext.quark !== 'https://upstream.example/quark-init') fail('selected policy removed upstream quark init');

  const noneSource = site('csp_YpanSoGuard', JAR_2CC, {
    'Cloud-drive': 'tvfan/Cloud-drive.txt',
    'Ali-drive': 'https://upstream.example/ali-drive.txt',
    cookie: 'UPSTREAM_COOKIE',
    quark: 'https://upstream.example/quark-init',
    uc: 'UPSTREAM_UC',
    baidu: 'UPSTREAM_BAIDU',
    from: 'tvfan|keep-me',
  });
  const noneBefore = JSON.stringify(noneSource.ext);
  const none = inject(noneSource, new Map());
  if (none.report.injected !== 0) fail('none policy must not inject');
  if (JSON.stringify(none.ext) !== noneBefore) fail('none policy changed upstream ext');

  const allToNone = stripInjectedCredentialsFromConfig(
    { sites: [site('csp_YpanSoGuard', JAR_2CC, {
      'Cloud-drive': BASE + '/tvfan/config?token=old',
      'Ali-drive': 'https://upstream.example/ali-drive.txt',
      cookie: 'UPSTREAM_COOKIE',
      quark: BASE + '/credential/quark?v=old',
      uc: 'UPSTREAM_UC',
      baidu: 'UPSTREAM_BAIDU',
    })] },
    BASE,
    credentials(),
    new Set(),
  );
  const allToNoneExt = allToNone.sites[0].ext;
  if (allToNoneExt['Cloud-drive'] !== undefined) fail('none cleanup retained project Cloud-drive URL');
  if (allToNoneExt.quark !== undefined) fail('none cleanup retained project Pan.init URL');
  if (allToNoneExt['Ali-drive'] !== 'https://upstream.example/ali-drive.txt') fail('none cleanup removed upstream Ali-drive');
  if (allToNoneExt.cookie !== 'UPSTREAM_COOKIE') fail('none cleanup removed upstream cookie');
  if (allToNoneExt.uc !== 'UPSTREAM_UC') fail('none cleanup removed upstream uc');
  if (allToNoneExt.baidu !== 'UPSTREAM_BAIDU') fail('none cleanup removed upstream baidu');

  const crossMechanism = stripInjectedCredentialsFromConfig(
    { sites: [site('csp_WoGGGuard', JAR_F782, {
      'Cloud-drive': BASE + '/tvfan/config?token=old',
      quark: BASE + '/credential/quark?v=old',
      uc: 'https://upstream.example/uc-init',
    })] },
    BASE,
    credentials(),
    new Set(),
  );
  if (crossMechanism.sites[0].ext['Cloud-drive'] !== undefined) fail('cross-mechanism cleanup retained project Cloud-drive URL');
  if (crossMechanism.sites[0].ext.quark !== undefined) fail('cross-mechanism cleanup retained project Pan.init URL');
  if (crossMechanism.sites[0].ext.uc !== 'https://upstream.example/uc-init') fail('cross-mechanism cleanup removed upstream uc init');

  const switchedSource = site('csp_YpanSoGuard', JAR_2CC, {
    'Cloud-drive': BASE + '/tvfan/config?token=old',
    quark: BASE + '/credential/quark?v=old',
    uc: 'https://upstream.example/uc-init',
    from: 'tvfan|keep-me',
  });
  const switched = inject(switchedSource, credentials(), BASE);
  if (switched.report.injected !== 1) fail('switch case expected one Cloud-drive injection');
  expectTvfanConfig(switched.ext, 'switch case', ['uc']);
  if (switched.ext.quark !== undefined) fail('switch case retained project Pan.init URL');
  if (switched.ext.uc !== 'https://upstream.example/uc-init') fail('switch case removed upstream uc init');
  if (switched.ext.from !== 'tvfan|keep-me') fail('switch case removed upstream from');

  const noCredentialSource = site('csp_YpanSoGuard', JAR_2CC);
  const noCredentialBefore = JSON.stringify(noCredentialSource.ext);
  const noCredential = inject(noCredentialSource, new Map());
  if (noCredential.report.injected !== 0) fail('no-credential case must not inject');
  if (JSON.stringify(noCredential.ext) !== noCredentialBefore) fail('no-credential case changed ext');

  const noBaseSource = site('csp_YpanSoGuard', JAR_2CC);
  const noBaseBefore = JSON.stringify(noBaseSource.ext);
  const noBase = inject(noBaseSource, credentials(), '');
  if (noBase.report.injected !== 0) fail('empty-base-url case must not inject');
  if (JSON.stringify(noBase.ext) !== noBaseBefore) fail('empty-base-url case changed ext');

  const authBase = BASE + '/auth/client-a';
  const authScoped = stripInjectedCredentialsFromConfig(
    { sites: [site('csp_YpanSoGuard', JAR_2CC, {
      'Cloud-drive': BASE + '/tvfan/config?token=old',
      quark: authBase + '/credential/quark?v=old',
      uc: 'https://upstream.example/uc-init',
    })] },
    authBase,
    credentials(),
    new Set(),
  );
  if (authScoped.sites[0].ext['Cloud-drive'] !== undefined) fail('auth-scoped cleanup missed root Cloud-drive URL');
  if (authScoped.sites[0].ext.quark !== undefined) fail('auth-scoped cleanup missed auth-prefixed Pan.init URL');
  if (authScoped.sites[0].ext.uc !== 'https://upstream.example/uc-init') fail('auth-scoped cleanup removed upstream uc init');

  console.log('RESULT=PASS: policy isolation, upstream credential preservation, cross-mechanism cleanup, stale KV override, 2386 unknown, and negative cases verified');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(OUTDIR, { recursive: true, force: true });
});
