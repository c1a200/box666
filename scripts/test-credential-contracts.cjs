const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, '.tmp-credential-contract-regression.cjs');
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

function legacyContract(source) {
  const jarMd5 = source.jar.split(';md5;').pop();
  return {
    api: source.api,
    jarMd5,
    extShape: 'object',
    extKeys: ['Cloud-drive'],
    injectableExtKeys: ['Cloud-drive'],
    contractHash: jarMd5 + '|' + source.api + '|object|Cloud-drive||',
    siteKey: source.key,
    credentialMechanism: 'unknown',
    credentialPlatforms: [],
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

function expectTvfanConfig(ext, label) {
  if (!ext || typeof ext['Cloud-drive'] !== 'string') fail(label + ': missing Cloud-drive URL');
  if (!/^https:\/\/base\.example\/tvfan\/config\?token=[^#]+$/.test(ext['Cloud-drive'])) {
    fail(label + ': unexpected Cloud-drive URL: ' + ext['Cloud-drive']);
  }
  if (Object.prototype.hasOwnProperty.call(ext, 'quark')) fail(label + ': Cloud-drive contract must not add ext.quark');
  if (Object.prototype.hasOwnProperty.call(ext, 'uc')) fail(label + ': Cloud-drive contract must not add ext.uc');
  if (Object.prototype.hasOwnProperty.call(ext, 'baidu')) fail(label + ': Cloud-drive contract must not add ext.baidu');
}

function expectPanInit(ext, label) {
  if (!ext || typeof ext.quark !== 'string') fail(label + ': missing Pan.init ext.quark URL');
  if (!/^https:\/\/base\.example\/credential\/quark\?v=/.test(ext.quark)) {
    fail(label + ': unexpected Pan.init URL: ' + ext.quark);
  }
  if (Object.prototype.hasOwnProperty.call(ext, 'Cloud-drive')) fail(label + ': Pan.init contract must remove project Cloud-drive entry');
}

let injectCredentials;

async function main() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/core/credential-injector.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: BUNDLE,
    define: { __APP_VERSION: JSON.stringify('test'), __APP_COMMIT: JSON.stringify('test') },
    logLevel: 'silent',
  });
  ({ injectCredentials } = require(BUNDLE));

  const guards = [
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
    ['csp_UuSsGuard', JAR_2386],
    ['csp_YpanSoGuard', JAR_2386],
    ['csp_WoGGGuard', JAR_2386],
    ['csp_BpanSoGuard', JAR_2386],
    ['csp_KkSsGuard', JAR_2386],
    ['csp_LibvioGuard', JAR_2386],
  ];

  for (const [api, jar] of guards) {
    const source = site(api, jar);
    const result = inject(source);
    if (result.report.injected !== 1) fail(api + '/' + jar + ': expected one Cloud-drive injection, got ' + result.report.injected);
    expectTvfanConfig(result.ext, api + '/' + jar);

    const legacy = inject(site(api, jar), credentials(), BASE, legacyContract(source));
    if (legacy.report.injected !== 1) fail(api + '/' + jar + ': stale KV contract expected one Cloud-drive injection');
    expectTvfanConfig(legacy.ext, api + '/' + jar + ' legacy');
  }

  const revoked = [
    ['csp_MyDriveGuard', JAR_2386],
    ['csp_YiSoGuard', JAR_2CC],
    ['csp_YiSoGuard', JAR_F782],
  ];
  for (const [api, jar] of revoked) {
    const source = site(api, jar);
    const before = JSON.stringify(source.ext);
    const result = inject(source, credentials(), BASE, legacyContract(source));
    if (result.report.injected !== 0) fail(api + '/' + jar + ': revoked binding was injected');
    if (JSON.stringify(result.ext) !== before) fail(api + '/' + jar + ': revoked binding changed ext');
  }

  for (const [api, jar] of [['csp_WoGGGuard', JAR_F782], ['csp_WoGGGuard', JAR_4CE29]]) {
    const result = inject(site(api, jar));
    if (result.report.injected !== 1) fail(api + '/' + jar + ': expected Pan.init injection');
    expectPanInit(result.ext, api + '/' + jar);
  }

  const switchedSource = site('csp_YpanSoGuard', JAR_2386, {
    'Cloud-drive': BASE + '/tvfan/config?token=old',
    quark: BASE + '/credential/quark?v=old',
    upstream: 'keep-me',
    from: 'tvfan|keep-me',
  });
  const switched = inject(switchedSource, credentials(), BASE);
  if (switched.report.injected !== 1) fail('partial-policy case expected one Cloud-drive injection');
  expectTvfanConfig(switched.ext, 'partial-policy');
  if (Object.prototype.hasOwnProperty.call(switched.ext, 'quark')) fail('partial policy retained old project Pan.init URL');
  if (switched.ext.upstream !== 'keep-me') fail('partial policy removed upstream field');
  if (switched.ext.from !== 'tvfan|keep-me') fail('partial policy removed upstream from field');

  for (const api of ['csp_AiDjGuard', 'csp_BiliGuard', 'csp_S_zpsGuard', 'csp_SeedhubGuard']) {
    const source = site(api, JAR_2386, { cookie: 'UPSTREAM', 'Cloud-drive': 'tvfan/Cloud-drive.txt' });
    const before = JSON.stringify(source.ext);
    const result = inject(source);
    if (result.report.injected !== 0) fail(api + ': unrelated 2386 Guard was injected');
    if (JSON.stringify(result.ext) !== before) fail(api + ': unrelated 2386 Guard ext changed');
  }

  const noCredentialSource = site('csp_YpanSoGuard', JAR_2386);
  const noCredentialBefore = JSON.stringify(noCredentialSource.ext);
  const noCredential = inject(noCredentialSource, new Map());
  if (noCredential.report.injected !== 0) fail('no-credential case must not inject');
  if (JSON.stringify(noCredential.ext) !== noCredentialBefore) fail('no-credential case changed ext');

  const noBaseSource = site('csp_YpanSoGuard', JAR_2386);
  const noBaseBefore = JSON.stringify(noBaseSource.ext);
  const noBase = inject(noBaseSource, credentials(), '');
  if (noBase.report.injected !== 0) fail('empty-base-url case must not inject');
  if (JSON.stringify(noBase.ext) !== noBaseBefore) fail('empty-base-url case changed ext');

  console.log('RESULT=PASS: precise Guard Cloud-drive contracts, isolated Pan.init exceptions, stale KV override, cleanup, and negative cases verified');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(BUNDLE, { force: true });
});
