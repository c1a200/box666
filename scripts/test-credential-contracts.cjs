const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, '.tmp-credential-contract-regression.cjs');
const BASE = 'https://base.example';
const JAR_2386 = '2386c62eb5f0b84dd53e27ad0fe9db49';
const JAR_F782 = 'f782cdee81118405176fd260be9ca5cd';
const JAR_4CE29 = '4ce29ce27eeff6a73a230dd92d98ba0c';

function site(api, jar, ext = { 'Cloud-drive': 'tvfan/Cloud-drive.txt' }) {
  return { key: `${api}_${jar.slice(0, 6)}`, name: api, type: 3, api, searchable: 1, jar: `https://jar.example/${jar};md5;${jar}`, ext };
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

function inject(source, creds = credentials(), baseUrl = BASE) {
  const result = injectCredentials([source], creds, { deniedKeys: [] }, baseUrl, null, null, false, false);
  return { source: result.sites[0], ext: parseExt(result.sites[0].ext), report: result.report };
}

function expectedTvfanConfig(ext) {
  if (!ext || typeof ext['Cloud-drive'] !== 'string') fail('missing tvfan Cloud-drive URL');
  if (!/^https:\/\/base\.example\/tvfan\/config\?token=[^#]+$/.test(ext['Cloud-drive'])) {
    fail(`unexpected tvfan Cloud-drive URL: ${ext['Cloud-drive']}`);
  }
  if (Object.prototype.hasOwnProperty.call(ext, 'quark')) fail('tvfan contract must not add ext.quark');
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

  const tvfanGuards = [
    'csp_UuSsGuard',
    'csp_YpanSoGuard',
    'csp_WoGGGuard',
    'csp_BpanSoGuard',
    'csp_KkSsGuard',
    'csp_LibvioGuard',
    'csp_MyDriveGuard',
  ];
  for (const api of tvfanGuards) {
    const result = inject(site(api, JAR_2386));
    if (result.report.injected !== 1) fail(`${api}: expected one injection, got ${result.report.injected}`);
    expectedTvfanConfig(result.ext);
  }

  for (const api of ['csp_AiDjGuard', 'csp_BiliGuard', 'csp_S_zpsGuard', 'csp_SeedhubGuard']) {
    const original = site(api, JAR_2386, { cookie: 'UPSTREAM', 'Cloud-drive': 'tvfan/Cloud-drive.txt' });
    const before = JSON.stringify(original.ext);
    const result = inject(original);
    if (result.report.injected !== 0) fail(`${api}: unrelated 2386 Guard was injected`);
    if (JSON.stringify(result.ext) !== before) fail(`${api}: unrelated 2386 Guard ext changed`);
  }

  for (const jar of [JAR_F782, JAR_4CE29]) {
    const result = inject(site('csp_WoGGGuard', jar));
    if (result.report.injected !== 1) fail(`${jar}: expected Pan.init injection`);
    expectedPanInit(result.ext);
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

  console.log('RESULT=PASS: 2386 tvfan contracts, Pan.init isolation, and negative cases verified');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(BUNDLE, { force: true });
});
