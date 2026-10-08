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
  return { key: `${api}_${jar.slice(0, 6)}`, name: api, type: 3, api, searchable: 1, jar: `https://jar.example/${jar};md5;${jar}`, ext };
}

function oldUnknownContract(source) {
  return {
    api: source.api,
    jarMd5: source.jar.slice(-source.jar.split(';md5;')[1].length),
    extShape: 'object',
    extKeys: ['Cloud-drive'],
    injectableExtKeys: ['Cloud-drive'],
    contractHash: `${source.jar.slice(-source.jar.split(';md5;')[1].length)}|${source.api}|object|Cloud-drive||`,
    siteKey: source.key,
    credentialMechanism: 'unknown',
    credentialPlatforms: [],
  };
}

function oldWrongTvfanContract(source) {
  const contract = oldUnknownContract(source);
  contract.credentialMechanism = 'tvfan-config-url';
  contract.credentialPlatforms = ['quark', 'uc', 'baidu'];
  return contract;
}

function parseExt(value) {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function credentials(platforms = ['quark']) {
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

function expectedPanInit(ext) {
  if (!ext || typeof ext.quark !== 'string') fail('missing Pan.init ext.quark URL');
  if (!/^https:\/\/base\.example\/credential\/quark\?v=/.test(ext.quark)) fail(`unexpected Pan.init URL: ${ext.quark}`);
  if (Object.prototype.hasOwnProperty.call(ext, 'Cloud-drive')) fail('Pan.init contract must remove project Cloud-drive entry');
}

function fail(message) {
  throw new Error(message);
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

  const panInitGuardsByJar = [
    [JAR_2CC, [
      'csp_YpanSoGuard', 'csp_BpanSoGuard', 'csp_PanSsoGuard', 'csp_XzSoGuard',
      'csp_UuSsGuard', 'csp_KkSsGuard', 'csp_MIPanSoGuard', 'csp_LibvioGuard',
      'csp_PanSearchGuard',
    ]],
    [JAR_F782, [
      'csp_YpanSoGuard', 'csp_BpanSoGuard', 'csp_PanSsoGuard', 'csp_XzSoGuard',
      'csp_UuSsGuard', 'csp_KkSsGuard', 'csp_MIPanSoGuard', 'csp_LibvioGuard',
      'csp_PanSearchGuard', 'csp_WoGGGuard',
    ]],
    [JAR_2386, [
      'csp_UuSsGuard', 'csp_YpanSoGuard', 'csp_WoGGGuard',
      'csp_BpanSoGuard', 'csp_KkSsGuard', 'csp_LibvioGuard',
    ]],
  ];
  for (const [jar, guardApis] of panInitGuardsByJar) {
    for (const api of guardApis) {
      const source = site(api, jar);
      const result = inject(source);
      if (result.report.injected !== 1) fail(`${api}/${jar}: expected one injection, got ${result.report.injected}`);
      expectedPanInit(result.ext);

      const legacySource = site(api, jar);
      const legacy = inject(legacySource, credentials(), BASE, oldWrongTvfanContract(legacySource));
      if (legacy.report.injected !== 1) fail(`${api}/${jar}: stale KV contract expected one injection, got ${legacy.report.injected}`);
      expectedPanInit(legacy.ext);
    }
  }

  for (const api of ['csp_AiDjGuard', 'csp_BiliGuard', 'csp_S_zpsGuard', 'csp_SeedhubGuard']) {
    const original = site(api, JAR_2386, { cookie: 'UPSTREAM', 'Cloud-drive': 'tvfan/Cloud-drive.txt' });
    const before = JSON.stringify(original.ext);
    const result = inject(original);
    if (result.report.injected !== 0) fail(`${api}: unrelated 2386 Guard was injected`);
    if (JSON.stringify(result.ext) !== before) fail(`${api}: unrelated 2386 Guard ext changed`);
  }

  const revokedBindings = [
    ['csp_MyDriveGuard', JAR_2386],
    ['csp_YiSoGuard', JAR_2CC],
    ['csp_YiSoGuard', JAR_F782],
  ];
  for (const [api, jar] of revokedBindings) {
    const source = site(api, jar);
    const before = JSON.stringify(source.ext);
    const result = inject(source, credentials(), BASE, oldWrongTvfanContract(source));
    if (result.report.injected !== 0) fail(`${api}/${jar}: revoked binding was injected`);
    if (JSON.stringify(result.ext) !== before) fail(`${api}/${jar}: revoked binding changed ext`);
  }

  for (const jar of [JAR_F782, JAR_4CE29]) {
    const source = site('csp_WoGGGuard', jar);
    const result = inject(source);
    if (result.report.injected !== 1) fail(`${jar}: expected Pan.init injection`);
    expectedPanInit(result.ext);

    const legacySource = site('csp_WoGGGuard', jar);
    const legacy = inject(legacySource, credentials(), BASE, oldUnknownContract(legacySource));
    if (legacy.report.injected !== 1) fail(`${jar}: stale KV contract expected Pan.init injection`);
    expectedPanInit(legacy.ext);
  }

  const switchedSource = site('csp_YpanSoGuard', JAR_2386, {
    quark: `${BASE}/credential/quark?v=old`,
    uc: `${BASE}/credential/uc?v=old`,
    upstream: 'keep-me',
  });
  const switched = inject(switchedSource, credentials(['quark']));
  if (switched.report.injected !== 1) fail('partial-policy case expected one injection');
  expectedPanInit(switched.ext);
  if (Object.prototype.hasOwnProperty.call(switched.ext, 'uc')) fail('partial policy retained old project UC URL');
  if (switched.ext.upstream !== 'keep-me') fail('partial policy removed upstream field');

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

  console.log('RESULT=PASS: verified audited Pan.init Guard families, revoked bindings, partial cleanup, and isolation');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(BUNDLE, { force: true });
});
