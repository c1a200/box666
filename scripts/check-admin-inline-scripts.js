const { buildSync } = require('esbuild');
const Module = require('module');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadAdminHtml() {
  const result = buildSync({
    entryPoints: [path.join(ROOT, 'src', 'core', 'admin.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
  });
  const source = result.outputFiles[0].text;
  const filename = path.join(ROOT, 'dist', '.admin-inline-check.cjs');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(source, filename);
  return mod.exports.adminHtml;
}

function checkAdminInlineScripts() {
  const html = loadAdminHtml();
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('adminHtml is empty or not a string');
  }

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match, index) => ({ index: index + 1, code: match[1] }));

  if (scripts.length === 0) {
    throw new Error('adminHtml has no inline scripts');
  }

  const searchPanelStart = html.indexOf('id="panelSearchQuota"');
  const settingsPanelStart = html.indexOf('id="panelSettings"');
  if (searchPanelStart < 0 || settingsPanelStart < 0 || settingsPanelStart <= searchPanelStart) {
    throw new Error('admin search/settings panels could not be located');
  }
  const searchPanel = html.slice(searchPanelStart, settingsPanelStart);
  for (const id of ['rootSourceSelectionModeInput', 'rootSourceCountModeInput', 'rootSourceBuckets']) {
    if (!searchPanel.includes('id="' + id + '"')) {
      throw new Error('root source selection control is missing from the search page: ' + id);
    }
  }
  if (!searchPanel.includes("saveSearchQuota('root')")) {
    throw new Error('root source selection must have its own save action on the search page');
  }
  if (!searchPanel.includes('sqRankingHint') || !html.includes('sqQualityOrder = rawQualityPoolKeys.slice()') || !html.includes('compareByQualityPoolOrder')) {
    throw new Error('search source ranking must explain and use the server quality-pool order');
  }

  for (const script of scripts) {
    try {
      new vm.Script(script.code, { filename: 'admin-inline-' + script.index + '.js' });
    } catch (error) {
      throw new Error('admin inline script ' + script.index + ' syntax error: ' + error.message);
    }
  }

  const totalBytes = scripts.reduce((sum, script) => sum + Buffer.byteLength(script.code), 0);
  console.log('Admin inline scripts OK: ' + scripts.length + ' script(s), ' + totalBytes + ' byte(s)');
  return { count: scripts.length, bytes: totalBytes };
}

if (require.main === module) {
  try {
    checkAdminInlineScripts();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = { checkAdminInlineScripts };
