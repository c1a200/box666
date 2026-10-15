const { buildSync } = require('esbuild');
const Module = require('module');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadHtml(entryFile, exportName) {
  const result = buildSync({
    entryPoints: [path.join(ROOT, 'src', 'core', entryFile)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
  });
  const source = result.outputFiles[0].text;
  const filename = path.join(ROOT, 'dist', '.inline-check.cjs');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(source, filename);
  return mod.exports[exportName];
}

function loadAdminHtml() {
  return loadHtml('admin.ts', 'adminHtml');
}

function loadConfigEditorHtml() {
  return loadHtml('config-editor.ts', 'configEditorHtml');
}

function checkHtmlInlineScripts(label, html, required) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error(label + ' HTML is empty or not a string');
  }

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match, index) => ({ index: index + 1, code: match[1] }));

  if (scripts.length === 0) {
    throw new Error(label + ' HTML has no inline scripts');
  }

  for (const snippet of required || []) {
    if (!html.includes(snippet)) {
      throw new Error(label + ' is missing required content: ' + snippet);
    }
  }

  for (const script of scripts) {
    try {
      new vm.Script(script.code, {
        filename: label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-inline-' + script.index + '.js',
      });
    } catch (error) {
      throw new Error(label + ' inline script ' + script.index + ' syntax error: ' + error.message);
    }
  }

  const totalBytes = scripts.reduce((sum, script) => sum + Buffer.byteLength(script.code), 0);
  console.log(label + ' inline scripts OK: ' + scripts.length + ' script(s), ' + totalBytes + ' byte(s)');
  return { count: scripts.length, bytes: totalBytes };
}

function checkAdminInlineScripts() {
  const html = loadAdminHtml();
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
  const sourcesPanelStart = html.indexOf('id="panelSources"');
  const sourcesPanelEnd = html.indexOf('id="panelMaccms"');
  if (sourcesPanelStart < 0 || sourcesPanelEnd <= sourcesPanelStart) {
    throw new Error('admin sources panel could not be located');
  }
  const sourcesPanel = html.slice(sourcesPanelStart, sourcesPanelEnd);
  const sourceListStart = sourcesPanel.indexOf('data-i18n="sourcesList"');
  const importSection = sourceListStart >= 0 ? sourcesPanel.slice(0, sourceListStart) : '';
  if (!importSection.includes('data-i18n="importConfig"') || !importSection.includes('id="importInput"') || !importSection.includes('id="exportBtn"') || !importSection.includes('id="restoreBtn"') || !importSection.includes('data-i18n="backupHelp"')) {
    throw new Error('source backup and restore actions must live inside the collapsible batch import panel');
  }
  if (!searchPanel.includes('id="rootSourceCountInput"') || !searchPanel.includes('oninput="syncRootSourceCountInput()"') || !html.includes('function syncRootSourceCountInput()') || !html.includes('const parsed = rootLimitValue(rootCount.value, rootCountInput)') || !html.includes('rootSourceSelection.maxSites = parsed.value')) {
    throw new Error('root simple source count must read the current custom value before saving');
  }
  if (!searchPanel.includes('sqRankingHint') || !html.includes('sqQualityOrder = rawQualityPoolKeys.slice()') || !html.includes('compareByQualityPoolOrder')) {
    throw new Error('search source ranking must explain and use the server quality-pool order');
  }
  if (!html.includes("['all', 'search', 'selected', 'custom'].includes(item && item.sourceMode)") || !html.includes('selectedKeys: Array.isArray(item && item.selectedKeys)')) {
    throw new Error('legacy auth sourceMode/selectedKeys must round-trip through the admin editor');
  }

  return checkHtmlInlineScripts('Admin', html, [
    'id="rootSourceSelectionModeInput"',
    'id="rootSourceCountModeInput"',
    'id="rootSourceBuckets"',
    "saveSearchQuota('root')",
    'id="rootSourceCountInput"',
    'oninput="syncRootSourceCountInput()"',
    'function syncRootSourceCountInput()',
    'const parsed = rootLimitValue(rootCount.value, rootCountInput)',
    'rootSourceSelection.maxSites = parsed.value',
    'data-i18n="sqRankingHint"',
    'sqQualityOrder = rawQualityPoolKeys.slice()',
    'compareByQualityPoolOrder',
    "['all', 'search', 'selected', 'custom'].includes(item && item.sourceMode)",
    'selectedKeys: Array.isArray(item && item.selectedKeys)',
  ]);
}

function checkConfigEditorInlineScripts() {
  const html = loadConfigEditorHtml();
  return checkHtmlInlineScripts('Config editor', html, [
    'data-filter="all"',
    'data-filter="available"',
    'data-filter="blocked"',
    'data-filter="manual"',
    'data-filter="regex"',
    'function setFilter(filter)',
    'function matchesFilter(item)',
    'function batchRestore()',
    'regexLiveUrl',
  ]);
}

if (require.main === module) {
  try {
    checkAdminInlineScripts();
    checkConfigEditorInlineScripts();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = { checkAdminInlineScripts, checkConfigEditorInlineScripts };
