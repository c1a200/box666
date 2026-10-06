import { sharedStyles } from './shared-styles';
import { sharedUi } from './shared-ui';

export const adminHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TVBox Aggregator - Admin</title>
<style>
${sharedStyles}

/* Admin-specific: action bar in header */
.agg-bar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  margin-top:16px;
  padding:12px 16px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:6px;
  font-family:var(--mono);
  font-size:0.75rem;
  color:var(--text-dim);
}

.agg-bar .status-text{font-family:var(--mono);font-size:0.75rem;color:var(--text-dim)}
.agg-bar .status-text.success{color:var(--green)}
.agg-bar .status-text.error{color:var(--red)}

/* Inline form label */
.form-label{
  font-family:var(--mono);
  font-size:0.65rem;
  color:var(--text-dim);
  text-transform:uppercase;
  letter-spacing:0.1em;
  display:block;
  margin-bottom:4px;
}

/* Name transform grid */
.nt-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px;
  margin-bottom:10px;
}

.nt-input{
  width:100%;
  font-family:var(--mono);
  font-size:0.8rem;
  padding:8px 12px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  outline:none;
  transition:border-color 0.2s;
}

.nt-input:focus{border-color:var(--green)}

.nt-textarea{
  width:100%;
  min-height:60px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:8px 12px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  resize:vertical;
  outline:none;
}

.nt-textarea:focus{border-color:var(--green)}

/* Cloud login and credential distribution */
.cloud-card{
  padding:12px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:6px;
  display:flex;
  flex-direction:column;
  gap:8px;
}
.cloud-card-header{display:flex;justify-content:space-between;align-items:center;gap:8px}
.cloud-card-name{font-weight:600;font-size:0.9rem;color:var(--text-bright)}
.cloud-badge{font-family:var(--mono);font-size:0.65rem;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.05em}
.cloud-badge.valid{background:rgba(80,250,123,0.15);color:var(--green)}
.cloud-badge.expired{background:rgba(255,85,85,0.15);color:var(--red)}
.cloud-badge.none{background:rgba(136,136,136,0.15);color:var(--text-dim)}
.cloud-card-actions{display:flex;gap:6px;flex-wrap:wrap}
.cloud-card-time{font-family:var(--mono);font-size:0.7rem;color:var(--text-dim)}
.cloud-card-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px}
.cloud-card-row-info{display:flex;flex-direction:column;gap:2px;min-width:0}
.cloud-card-row-name{font-size:0.82rem;color:var(--text-bright);font-weight:600}
.cloud-card-row-status{font-family:var(--mono);font-size:0.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em}
.cloud-card-row-status.valid{color:var(--green)}
.cloud-card-row-status.expired{color:var(--red)}
.credential-policy-box{padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px}
.credential-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.credential-help{font-size:0.78rem;color:var(--text-secondary);line-height:1.55;margin-top:8px}
.credential-status{font-family:var(--mono);font-size:0.72rem;color:var(--text-dim)}
.credential-platform-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin-top:10px}
.credential-platform-grid label{display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;font-size:0.8rem;color:var(--text-secondary)}
.credential-auth-list{display:grid;gap:12px;margin-top:10px}
.credential-auth-card{padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px}
.credential-auth-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:8px}
.credential-auth-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.credential-pill{font-family:var(--mono);font-size:0.65rem;padding:2px 6px;border-radius:8px;background:rgba(80,250,123,0.12);color:var(--green)}
.credential-pill-warning{background:rgba(255,184,77,0.14);color:var(--yellow)}
.credential-help-warning{color:var(--yellow);margin-top:8px}

/* Search source tables */
.sq-table-wrap{max-height:420px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;border:1px solid var(--border);border-radius:6px;background:var(--surface)}
.sq-table-wrap.is-pinned{max-height:260px;margin-bottom:12px}
.sq-table{width:100%;border-collapse:separate;border-spacing:0;font-size:0.8rem}
.sq-table th{position:sticky;top:0;z-index:2;background:var(--surface-2);color:var(--text-secondary);text-align:left;font-weight:600;padding:7px 8px;border-bottom:1px solid var(--border);box-shadow:inset 0 -1px 0 var(--border)}
.sq-table td{padding:4px}
.sq-table tbody tr:last-child td{border-bottom:0}

/* Risk badges */
.risk-badge{
  font-family:var(--mono);
  font-size:0.7rem;
  padding:1px 6px;
  border-radius:8px;
}
.risk-badge.safe{background:rgba(80,250,123,0.15);color:var(--green)}
.risk-badge.low{background:rgba(80,250,123,0.1);color:var(--green)}
.risk-badge.high{background:rgba(255,85,85,0.15);color:var(--red)}
.risk-badge.unaudited{background:rgba(241,250,140,0.15);color:var(--yellow)}

/* QR modal */
.qr-modal-overlay{
  position:fixed;top:0;left:0;right:0;bottom:0;
  background:rgba(0,0,0,0.7);
  display:flex;align-items:center;justify-content:center;
  z-index:1000;
}
.qr-modal{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:8px;
  padding:24px;
  min-width:300px;
  max-width:400px;
  text-align:center;
}
.qr-modal h3{margin:0 0 16px;color:var(--text-bright);font-size:1rem}
.qr-modal img{
  max-width:250px;
  max-height:250px;
  border-radius:4px;
  background:#fff;
  padding:8px;
}
.qr-status{
  margin-top:12px;
  font-family:var(--mono);
  font-size:0.8rem;
  color:var(--text-dim);
}
.qr-status.scanned{color:var(--yellow)}
.qr-status.confirmed{color:var(--green)}
.qr-status.expired{color:var(--red)}

/* Import textarea */
.import-textarea{
  width:100%;
  min-height:100px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:10px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  resize:vertical;
  margin-bottom:8px;
}

/* Batch textarea */
.batch-textarea{
  width:100%;
  margin-top:8px;
  min-height:120px;
  font-family:var(--mono);
  font-size:0.75rem;
  padding:10px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  color:var(--text-bright);
  resize:vertical;
}

/* Source health dot in list items */
.source-health-dot{
  width:8px;height:8px;
  border-radius:50%;
  flex-shrink:0;
  position:relative;
  cursor:default;
}

.source-health-dot.ok{
  background:var(--green);
  box-shadow:0 0 4px var(--green-glow);
}

.source-health-dot.warn{
  background:var(--amber);
  box-shadow:0 0 4px var(--amber-dim);
}

.source-health-dot.error{
  background:var(--red);
  box-shadow:0 0 4px var(--red-dim);
}

.source-health-dot.unknown{
  background:var(--text-dim);
}

.source-health-dot.disabled{
  background:#666;
  box-shadow:none;
}

.source-health-dot::after{
  content:attr(data-tooltip);
  position:absolute;
  left:50%;
  bottom:calc(100% + 8px);
  transform:translateX(-50%);
  padding:6px 10px;
  background:var(--surface-2);
  border:1px solid var(--border);
  border-radius:4px;
  font-family:var(--mono);
  font-size:0.6rem;
  color:var(--text);
  white-space:nowrap;
  pointer-events:none;
  opacity:0;
  transition:opacity 0.2s;
  z-index:10;
}

.source-health-dot:hover::after{
  opacity:1;
}

.live-log-box{
  height:260px;
  overflow:auto;
  padding:10px;
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  font-family:var(--mono);
  font-size:0.72rem;
  line-height:1.5;
  color:var(--text);
  white-space:pre-wrap;
}

@media(max-width:560px){
  .nt-grid{grid-template-columns:1fr}
  .tabs{overflow-x:auto;flex-wrap:nowrap}
  .tab{padding:12px 14px;font-size:0.65rem}
}
</style>
<script>(function(){var t=localStorage.getItem('theme')||'light';document.documentElement.setAttribute('data-theme',t)})()</script>
</head>
<body style="opacity:0">

<!-- Login -->
<div class="login-overlay" id="loginOverlay">
  <div class="login-box">
    <h2 data-i18n="loginTitle">Admin Access</h2>
    <p data-i18n="loginSubtitle">TVBox Aggregator Management</p>
    <div class="error-msg" id="loginError" data-i18n="invalidToken">Invalid token</div>
    <input type="password" id="loginInput" placeholder="Enter admin token" data-i18n-placeholder="enterToken" autocomplete="off">
    <button class="btn" style="width:100%" onclick="auth.doLogin()" data-i18n="login">Login</button>
  </div>
</div>

<!-- Main content -->
<div class="container" id="mainContent" style="display:none">
  <header class="header">
    <div class="header-top">
      <div class="header-label" data-i18n="headerLabel">Admin Console</div>
      <div style="display:flex;gap:8px;align-items:center">
        <span id="themeDropdown"></span>
        <button class="lang-toggle" id="langToggle" onclick="doToggleLang()">中文</button>
      </div>
    </div>
    <h1 class="header-title">Source <span>Manager</span></h1>
    <nav class="header-nav">
      <a href="/admin/config-editor" data-i18n="navConfigEditor">Config Editor</a>
      <a href="/builder">Builder</a>
      <a href="/status" data-i18n="navDashboard">Dashboard</a>
    </nav>
    <!-- Aggregation status bar -->
    <div class="agg-bar">
      <span class="status-text" id="aggStatus" data-i18n="loadingStatus">Loading...</span>
      <button class="btn btn-sm" id="refreshBtn" onclick="triggerRefresh()" data-i18n="aggregateNow">Aggregate now</button>
    </div>
  </header>

  <!-- Tabs -->
  <div class="tabs">
    <div class="tab active" data-tab="sources" onclick="switchTab('sources')"><span data-i18n="tabSources">Sources</span> <span class="badge" id="badgeSources">0</span></div>
    <div class="tab" data-tab="maccms" onclick="switchTab('maccms')"><span data-i18n="tabMacCMS">MacCMS</span> <span class="badge" id="badgeMacCMS">0</span></div>
    <div class="tab" data-tab="live" onclick="switchTab('live')"><span data-i18n="tabLive">Live</span> <span class="badge" id="badgeLive">0</span></div>
    <div class="tab" data-tab="searchQuota" onclick="switchTab('searchQuota')" id="tabSearchQuota"><span data-i18n="tabSearchQuota">Search</span> <span class="badge" id="badgeSearchQuota">0</span></div>
    <div class="tab" data-tab="cloud" onclick="switchTab('cloud')"><span data-i18n="tabCloud">Cloud</span></div>
    <div class="tab" data-tab="settings" onclick="switchTab('settings')"><span data-i18n="tabSettings">Settings</span></div>
    <div class="tab" data-tab="aggLogs" onclick="switchTab('aggLogs')"><span data-i18n="tabAggLogs">Logs</span></div>
  </div>

  <!-- Sources Tab -->
  <div class="tab-panel active" id="panelSources">
    <!-- Add source -->
    <div class="section">
      <div class="section-title" id="sourceFormTitle" data-i18n="addSource">Add Source</div>
      <div class="add-form">
        <input class="name-input" type="text" id="addName" placeholder="Name (optional)" data-i18n-placeholder="nameOptional">
        <input type="url" id="addUrl" placeholder="TVBox config JSON URL" data-i18n-placeholder="configJsonUrl">
        <input class="name-input" type="text" id="addConfigKey" placeholder="Config Key (optional, for AES ECB)">
        <div style="display:flex;gap:8px" id="sourceFormButtons">
          <button class="btn" id="addBtn" onclick="addSource()" data-i18n="add">Add</button>
        </div>
      </div>
      <!-- Backup & Restore (always visible) -->
      <div class="section" style="margin-top:16px">
        <div class="section-title" data-i18n="backupRestore">Source Backup &amp; Restore</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-sm" id="exportBtn" onclick="exportConfig()" data-i18n="export">Download Backup</button>
          <input type="file" id="restoreFile" accept=".json,application/json" style="display:none" onchange="loadRestoreFile(this)">
          <button class="btn btn-sm secondary" type="button" onclick="document.getElementById('restoreFile').click()" data-i18n="chooseBackup">Choose backup file</button>
          <button class="btn btn-sm secondary" id="restoreBtn" onclick="restoreSources()" data-i18n="restoreBackup">Restore Backup</button>
          <span class="status-text" id="restoreFileName" style="font-family:var(--mono);font-size:0.75rem"></span>
          <span class="status-text" id="importResult" style="font-family:var(--mono);font-size:0.75rem"></span>
        </div>
        <div class="source-help" data-i18n="backupHelp">Download Backup saves all movie sources. Restore replaces the current list, so download a backup first.</div>
      </div>

      <!-- Batch import (collapsible) -->
      <div class="collapsible-toggle" onclick="toggleCollapsible(this)" data-i18n="importConfig">Batch Import</div>
      <div class="collapsible-body">
        <textarea id="importInput" class="import-textarea" placeholder="每行一个源：源名 URL / URL 源名 / 仅 URL；也可粘贴旧版 JSON 或远程配置 URL。" data-i18n-placeholder="importPlaceholder"></textarea>
        <div class="source-help" data-i18n="sourceListHelp">每行一个源，支持“源名 URL”“URL 源名”或仅 URL；单行 URL 仍按远程配置抓取。导入默认合并，重复 URL 不会覆盖现有源。</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-sm" id="importBtn" onclick="importConfig()" data-i18n="import">Import</button>
        </div>
      </div>

    <!-- Source list -->
    <div class="section">
      <div class="section-title">
        <span data-i18n="sourcesList">Sources</span>
        <span class="count" id="sourceCount">0</span>
      </div>
      <div class="source-list" id="sourceList">
        <div class="empty">Loading sources...</div>
      </div>
    </div>
    </div>
  </div>

  <!-- MacCMS Tab -->
  <div class="tab-panel" id="panelMaccms">
    <!-- Add MacCMS -->
    <div class="section">
      <div class="section-title" id="mcFormTitle" data-i18n="addMacCMS">Add MacCMS Source</div>
      <div class="add-form">
        <input class="name-input" type="text" id="mcKey" placeholder="Key (e.g. hongniuzy)" data-i18n-placeholder="mcKeyPh">
        <input class="name-input" type="text" id="mcName" placeholder="Name" data-i18n-placeholder="mcNamePh">
        <input type="url" id="mcApi" placeholder="MacCMS API URL" data-i18n-placeholder="mcApiPh">
        <div style="display:flex;gap:8px" id="mcFormButtons">
          <button class="btn" id="mcAddBtn" onclick="addMacCMS()" data-i18n="add">Add</button>
        </div>
      </div>
      <!-- Batch import (collapsible) -->
      <div class="collapsible-toggle" onclick="toggleCollapsible(this)" data-i18n="batchImport">Batch Import</div>
      <div class="collapsible-body">
        <textarea id="mcBatchInput" class="batch-textarea" placeholder="每行一个 MacCMS 源：源名 API URL / API URL 源名 / 仅 URL；也可粘贴旧版 JSON 数组。" data-i18n-placeholder="mcBatchPlaceholder"></textarea>
        <div class="source-help" data-i18n="mcListHelp">每行一个 MacCMS 源，支持“源名 API URL”“API URL 源名”或仅 URL；缺少 key 时会自动生成唯一 key。导入默认合并，重复 key/API 不会覆盖现有源。</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
          <button class="btn btn-sm" id="mcBatchBtn" onclick="batchImportMacCMS()" data-i18n="submitBatch">Import / Restore</button>
          <button class="btn btn-sm" id="mcExportBtn" onclick="exportMacCMS()" data-i18n="export">Export</button>
          <span class="status-text" id="mcBatchResult" style="font-family:var(--mono);font-size:0.75rem"></span>
        </div>
      </div>
    </div>

    <!-- MacCMS list -->
    <div class="section">
      <div class="section-title">
        <span data-i18n="macCMSSources">MacCMS Sources</span>
        <span class="count" id="mcCount">0</span>
      </div>
      <div class="source-list" id="mcList">
        <div class="empty">Loading MacCMS sources...</div>
      </div>
    </div>
  </div>

  <!-- Live Tab -->
  <div class="tab-panel" id="panelLive">
    <!-- Add live source -->
    <div class="section">
      <div class="section-title" id="liveFormTitle" data-i18n="addLiveSource">Add Live Source</div>
      <div class="add-form">
        <input class="name-input" type="text" id="liveName" placeholder="Name (e.g. iptv365)" data-i18n-placeholder="liveNamePh">
        <input type="url" id="liveUrl" placeholder="m3u/txt URL" data-i18n-placeholder="liveUrlPh">
        <div style="display:flex;gap:8px" id="liveFormButtons">
          <button class="btn" id="liveAddBtn" onclick="addLive()" data-i18n="add">Add</button>
        </div>
      </div>
      <!-- Live import/export (collapsible) -->
      <div class="collapsible-toggle" onclick="toggleCollapsible(this)" data-i18n="liveImportExport">Live Import / Export</div>
      <div class="collapsible-body">
        <textarea id="liveImportInput" class="import-textarea" placeholder="每行一个直播源：源名 URL / URL 源名 / 仅 URL；也可粘贴旧版 JSON、TVBox 配置或远程配置 URL。" data-i18n-placeholder="liveImportPlaceholder"></textarea>
        <div class="source-help" data-i18n="liveListHelp">每行一个直播源，支持“源名 URL”“URL 源名”或仅 URL；仍兼容旧版 JSON、TVBox 配置和远程 URL。导入默认合并，重复 URL 不会覆盖现有源。</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-sm" id="liveImportBtn" onclick="importLives()" data-i18n="liveImport">Import Live Sources</button>
          <button class="btn btn-sm" id="liveExportBtn" onclick="exportLives()" data-i18n="liveExport">Export Live Sources</button>
          <span class="status-text" id="liveImportResult" style="font-family:var(--mono);font-size:0.75rem"></span>
        </div>
      </div>
    </div>

    <!-- Live list -->
    <div class="section">
      <div class="section-title">
        <span data-i18n="liveSources">Live Sources</span>
        <span class="count" id="liveCount">0</span>
      </div>
      <div class="source-list" id="liveList">
        <div class="empty">Loading live sources...</div>
      </div>
    </div>

    <!-- Channel Probe (Node/Docker only) -->
    <div class="section" id="channelProbeSection">
      <div class="section-title" data-i18n="channelProbeTitle">Channel Speed Probe (Node/Docker)</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="channelProbeCheck" onchange="toggleChannelProbe()">
          <span data-i18n="channelProbeEnable">Enable scheduled channel speed test (every 12h)</span>
        </label>
        <button class="btn btn-sm" id="channelProbeTriggerBtn" onclick="triggerChannelProbe()" data-i18n="channelProbeTrigger">Probe now</button>
        <button class="btn btn-sm" onclick="loadChannelProbe()" data-i18n="channelProbeRefresh">Refresh probe status</button>
      </div>
      <div id="channelProbeStatus" style="font-size:0.85rem;color:var(--text-secondary);line-height:1.6"></div>
    </div>

    <!-- Live Output Strategy -->
    <div class="section">
      <div class="section-title" data-i18n="liveStrategyTitle">Live Output Strategy</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="liveDisabledCheck" onchange="saveLiveDisabled()">
          <span data-i18n="liveToggleLabel">Disable live aggregation (skip live merge, output empty lives)</span>
        </label>
        <span class="status-text" id="liveDisabledStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div id="liveStrategyOptions" style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex-wrap:wrap">
          <input type="checkbox" id="ignoreAggregatedLivesCheck" onchange="saveIgnoreAggregatedLives()">
          <span data-i18n="ignoreAggregatedLivesLabel">Ignore live sources inside subscription configs (only use manually added live sources)</span>
          <span class="status-text" id="ignoreAggregatedLivesStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
        </label>
        <div>
          <div class="form-label" style="margin-bottom:6px" data-i18n="liveMergeModeTitle">Live merge mode</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button id="liveMergeSeparated" class="btn btn-sm active" onclick="setLiveMergeMode('separated')" data-i18n="liveMergeSeparated">Separated (group by source)</button>
            <button id="liveMergeMerged" class="btn btn-sm" onclick="setLiveMergeMode('merged')" data-i18n="liveMergeMerged">Merged (deduplicate channels)</button>
            <span class="status-text" id="liveMergeModeStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
          </div>
          <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:4px" data-i18n="liveMergeModeDesc">Separated keeps every source as its own group; merged combines channels by name and removes duplicates.</div>
        </div>
      </div>
      <div id="liveStrategyHint" style="margin-top:8px;font-size:0.8rem;color:var(--text-secondary)"></div>
    </div>
  </div>

  <!-- Search Quota Tab -->
  <div class="tab-panel" id="panelSearchQuota">
    <div class="section">
      <div class="section-title" data-i18n="sqSelected">Active Search Sources</div>
      <div id="sqSelectedInfo" style="margin-bottom:8px;font-size:0.8rem;color:var(--text-secondary)"></div>
      <div id="sqQualityGrades" style="margin-bottom:8px;font-size:0.8rem;color:var(--text-secondary)"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <input id="sqSourceFilter" class="nt-input" style="width:220px" placeholder="Search source name or key..." data-i18n-placeholder="sqSourceFilterPh" oninput="renderSearchSources()">
        <select id="sqGradeFilter" class="nt-input" style="width:190px" onchange="renderSearchSources()">
          <option value="all" data-i18n="sqFilterAll">All grades</option>
          <option value="excellent" data-i18n="sqExcellent">Excellent</option>
          <option value="good" data-i18n="sqGood">Good</option>
          <option value="usable" data-i18n="sqUsable">Usable</option>
          <option value="credential-ready" data-i18n="sqCredentialReady">Credential-ready</option>
          <option value="untestable" data-i18n="sqUntestable">Client final check only</option>
          <option value="blocked" data-i18n="sqBlocked">Blocked</option>
        </select>
        <span id="sqSourceFilterCount" style="font-size:0.75rem;color:var(--text-secondary)"></span>
      </div>
      <div id="sqSelectedTable">
        <div style="color:var(--text-secondary);font-size:0.85rem" data-i18n="sqNoData">Run aggregation to see results</div>
      </div>
    </div>
  </div>

  <!-- Cloud Tab -->
  <div class="tab-panel" id="panelCloud">
    <div class="section">
      <div class="section-title" data-i18n="cloudLogin">Cloud Login</div>
      <div class="credential-help" data-i18n="cloudLoginDesc"></div>
      <div id="cloudLoginGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:10px"></div>
    </div>

    <div class="section">
      <div class="section-title" data-i18n="cloudManualPaste">Manual Credential Paste</div>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:0 0 140px">
          <label class="form-label" data-i18n="cloudPlatform">Platform</label>
          <select id="manualPlatform" class="nt-input" style="width:100%"></select>
        </div>
        <div style="flex:1;min-width:200px">
          <label class="form-label" data-i18n="cloudCredentialValue">Credential (cookie / token / JSON)</label>
          <input id="manualCredValue" class="nt-input" style="width:100%" placeholder="cookie=xxx; token=yyy">
        </div>
        <button class="btn btn-sm" onclick="manualPasteCredential()" data-i18n="save">Save</button>
      </div>
      <div id="manualPasteStatus" class="status-text" style="margin-top:6px"></div>
      <div class="cloud-helper-info" style="margin-top:12px;font-size:0.8rem;color:var(--text-secondary);background:rgba(255,255,255,0.03);padding:10px;border-radius:4px;border-left:3px solid var(--accent);line-height:1.5" data-i18n="cloudManualPasteHelp"></div>
    </div>
  </div>

  <!-- Settings Tab -->
  <div class="tab-panel" id="panelSettings">

    <div class="section">
      <div class="section-title" data-i18n="credentialDistributionTitle">Credential Distribution &amp; Client Authentication</div>
      <div class="credential-help" data-i18n="credentialDistributionDesc"></div>

      <div class="credential-policy-box" style="margin-top:10px">
        <div class="credential-inline">
          <strong style="font-size:0.85rem;color:var(--text-bright)" data-i18n="credentialDefaultPolicy">Root-link default credential policy</strong>
          <select id="credentialDefaultMode" class="nt-input" style="width:auto;min-width:180px" onchange="renderCredentialDistribution()">
            <option value="none" data-i18n="credentialModeNone">Do not distribute</option>
            <option value="all" data-i18n="credentialModeAll">Distribute all</option>
            <option value="selected" data-i18n="credentialModeSelected">Distribute selected only</option>
          </select>
          <label class="credential-inline" style="font-size:0.82rem;color:var(--text-secondary)">
            <input type="checkbox" id="credentialRequireAuth" onchange="renderCredentialDistribution()">
            <span data-i18n="credentialRequireAuth">Require auth code for clients</span>
          </label>
          <label class="credential-inline" style="font-size:0.82rem;color:var(--text-secondary)" title="Applies only when the credential mode is none">
            <input type="checkbox" id="credentialStripUpstreamEntries" onchange="renderCredentialDistribution()">
            <span data-i18n="credentialStripUpstreamEntries">Also remove upstream cloud-login entries</span>
          </label>
          <button class="btn btn-sm" onclick="saveCredentialDistribution()" data-i18n="save">Save</button>
          <button class="btn btn-sm" onclick="copyClientLink(window.location.origin + '/')" data-i18n="credentialCopyRoot">Copy root link</button>
          <span class="credential-status" id="credentialDistributionStatus"></span>
        </div>
        <div id="credentialDefaultPlatforms" class="credential-platform-grid"></div>
        <div class="credential-help">
          <span data-i18n="credentialPolicyHint"></span>
          <strong id="credentialRootLinkHint" style="display:block;margin-top:6px;color:var(--text-bright)"></strong>
        </div>
      </div>

      <div class="credential-policy-box" style="margin-top:12px">
        <div class="credential-inline" style="justify-content:space-between">
          <div>
            <strong style="font-size:0.85rem;color:var(--text-bright)" data-i18n="credentialAuthCodes">Client auth codes</strong>
            <div class="credential-help" data-i18n="credentialAuthCodesDesc"></div>
          </div>
          <button class="btn btn-sm" onclick="addCredentialAuthCode()" data-i18n="credentialAddCode">+ Add auth code</button>
        </div>
        <div id="credentialAuthList" class="credential-auth-list"></div>
      </div>

      <div class="credential-help" data-i18n="credentialSecurityHint"></div>
    </div>
    <!-- Storage Diagnostics -->
    <div class="section">
      <div class="section-title" data-i18n="storageStatus">存储状态</div>
      <div id="storageDiagnostics" style="white-space:pre-wrap;font-family:var(--mono);font-size:0.78rem;line-height:1.6;color:var(--text-secondary);min-height:1.6em">加载中...</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button class="btn btn-sm" onclick="loadStorageDiagnostics()" data-i18n="refresh">刷新</button>
      </div>
      <div style="margin-top:6px;font-size:0.78rem;color:var(--text-dim);line-height:1.5" data-i18n="storageStatusDesc">显示远端持久化状态。Render 的本地 SQLite 只作为缓存，关键配置必须成功写入远端 KV 才算保存。</div>
    </div>

    <!-- Cron Interval -->
    <div class="section">
      <div class="section-title" data-i18n="cronInterval">Source Aggregation Schedule</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="cronSelect" class="nt-input" style="width:auto;min-width:160px">
          <option value="60" data-i18n-text="cronEvery1h">Every 1 hour</option>
          <option value="180" data-i18n-text="cronEvery3h">Every 3 hours</option>
          <option value="360" data-i18n-text="cronEvery6h">Every 6 hours</option>
          <option value="720" data-i18n-text="cronEvery12h">Every 12 hours</option>
          <option value="1440" data-i18n-text="cronEveryDay">Once a day</option>
        </select>
        <button class="btn btn-sm" id="cronSaveBtn" onclick="saveCronInterval()" data-i18n="save">Save</button>
        <span class="status-text" id="cronStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <div class="section">
      <div class="section-title" data-i18n="speedTestToggle">Media Site Speed Test</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="speedTestCheck" onchange="saveSpeedTest()" checked>
          <span data-i18n="speedTestLabel">Enable site speed test and unreachable filtering</span>
        </label>
        <span class="status-text" id="speedTestStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary)" data-i18n="speedTestDesc">When disabled, all sites are kept without testing reachability</div>
    </div>

    <div class="section">
      <div class="section-title" data-i18n="edgeProxies">Edge Function Proxies</div>
      <div style="margin-bottom:6px;font-size:0.8rem;color:var(--text-secondary)" data-i18n="edgeProxiesDesc">Configure edge function URLs for proxy fallback (fetch retry + image CDN). Local Docker mode only.</div>
      <div class="nt-grid">
        <div>
          <label class="form-label">Cloudflare Worker URL</label>
          <input type="text" id="edgeCfUrl" class="nt-input" placeholder="https://tvbox.example.com">
        </div>
        <div>
          <label class="form-label">Vercel Proxy URL</label>
          <input type="text" id="edgeVercelUrl" class="nt-input" placeholder="https://fetch.example.com">
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button class="btn btn-sm" onclick="saveEdgeProxies()" data-i18n="save">Save</button>
        <span class="status-text" id="edgeProxiesStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <div class="section">
      <div class="section-title" data-i18n="searchQuota">应用端搜索配额</div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <label class="form-label" style="margin:0" data-i18n="maxSearchable">可搜索源上限</label>
        <input type="number" id="maxSearchableInput" class="nt-input" style="width:90px" min="0" max="1000" value="0">
        <label class="form-label" style="margin:0" data-i18n="maxParses">解析器上限</label>
        <input type="number" id="maxParsesInput" class="nt-input" style="width:90px" min="0" max="1000" value="0">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.85rem">
          <input type="checkbox" id="retainCredentialSourcesInput">
          <span data-i18n="retainCredentialSources">保留凭证/JAR 源</span>
        </label>
        <button class="btn btn-sm" id="searchQuotaSaveBtn" onclick="saveSearchQuota()" data-i18n="save">保存</button>
        <button class="btn btn-sm" onclick="applyRecommendedQuota()" data-i18n="qualityUseRecommended">填入推荐值</button>
        <span class="status-text" id="searchQuotaStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <!-- Internal safety values: hidden from normal use and kept for backward compatibility. -->
      <input type="hidden" id="maxQuickSearchInput" value="0">
      <input type="hidden" id="maxStartupQuickSearchInput" value="0">
      <input type="hidden" id="startupSiteLimitInput" value="0">
      <input type="hidden" id="autoSearchLimitInput">
      <input type="hidden" id="sortSearchBySpeedInput">
      <input type="hidden" id="leanStartupInput">
      <input type="hidden" id="startupModeInput" value="lean">
      <input type="hidden" id="pruneDeadParsesInput">
      <div id="searchQuotaStats" style="margin-top:8px;font-size:0.8rem;color:var(--text-secondary);line-height:1.6"></div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-secondary)" data-i18n="searchQuotaDesc">只影响下发到应用端的数据：可搜索源上限和解析器上限，0 表示不限制。JS 地址源始终排除；置顶源不参与截断。可在“搜索”页管理置顶源。</div>
      <div style="margin-top:4px;font-size:0.8rem;color:var(--text-secondary)" data-i18n="qualityGradeDesc">质量分级（后台分块测速，不影响应用端启动速度）：优 ≤1000ms、良 1001-3000ms、可用 3001-6000ms。前端凭证会用于服务端真实 HTTP 探测；只有确实探测成功且达到优/良/可用的凭证源，才进入对应测速等级。凭证已保存但未成功验证、或 JAR/客户端专用源，保留为“凭证就绪/客户端登录”，不会伪装成已测速；凭证探测失败会回退到“凭证就绪”，不会永久判死。超时和不可用不进入候选池。</div>
    </div>

    <div class="section">
      <div class="section-title" data-i18n="qualitySchedule">搜索源质量分级</div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;cursor:pointer">
          <input type="checkbox" id="qualityEnabledInput">
          <span data-i18n="qualityEnabled">启用定时分级</span>
        </label>
        <label class="form-label" style="margin:0" data-i18n="qualityTimes">时间点</label>
        <input type="text" id="qualityTimesInput" class="nt-input" style="width:210px" placeholder="04:30, 16:30" data-i18n-placeholder="qualityTimesPh">
        <label class="form-label" style="margin:0" data-i18n="qualityRepeatDays">候选池重排周期（天）</label>
        <input type="number" id="qualityRepeatDaysInput" class="nt-input" style="width:80px" min="1" max="30" value="1">
        <label class="form-label" style="margin:0" data-i18n="qualityFullRepeatDays">全量分级周期（天）</label>
        <input type="number" id="qualityFullRepeatDaysInput" class="nt-input" style="width:80px" min="1" max="365" value="7">
        <span id="qualityTimezoneLabel" style="font-size:0.8rem;color:var(--text-secondary)">时区：北京时间（UTC+8）</span>
        <button class="btn btn-sm" onclick="saveQualitySchedule()" data-i18n="save">保存</button>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <button class="btn btn-sm" id="qualityRunCandidateBtn" onclick="runQualityNow('candidate')" data-i18n="qualityRunCandidate">重测候选池</button>
        <button class="btn btn-sm" id="qualityRunFullBtn" onclick="runQualityNow('full')" data-i18n="qualityRunFull">全量重测</button>
        <button class="btn btn-sm" onclick="refreshQualityReport()" data-i18n="qualityRefresh">刷新分级状态</button>
        <span class="status-text" id="qualityScheduleStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="margin-top:8px;font-size:0.8rem;color:var(--text-secondary)" data-i18n="qualityScheduleDesc">分级在后台异步执行，点击后立即返回，不会阻塞网页或其他请求。日常只重测服务端可探测的候选池（优/良/可用）；凭证就绪源中只有可真实 HTTP 探测的会重测，JAR/客户端专用源保留但不参与服务端重测。到达全量周期或候选池为空时自动全量分级。Cloudflare 和 Node/Render 都按小分片执行并在分片间让出事件循环；Node/Render 异常重启后会从已保存游标继续。</div>
      <div id="qualityDynamicStats" style="margin-top:10px;font-size:0.82rem;color:var(--text-secondary);line-height:1.7"></div>
    </div>
    <div class="section">
      <div class="section-title" data-i18n="nameTransform">Name Transform</div>
      <div class="nt-grid">
        <div>
          <label class="form-label" data-i18n="ntPrefix">Prefix</label>
          <input type="text" id="ntPrefix" class="nt-input" placeholder="e.g. 【RioTV】" data-i18n-placeholder="ntPrefixPh">
        </div>
        <div>
          <label class="form-label" data-i18n="ntSuffix">Suffix</label>
          <input type="text" id="ntSuffix" class="nt-input" placeholder="e.g.  · Curated" data-i18n-placeholder="ntSuffixPh">
        </div>
      </div>
      <div style="margin-bottom:10px">
        <label class="form-label" data-i18n="ntPromoReplace">Promo Replacement (empty = delete)</label>
        <input type="text" id="ntPromoReplace" class="nt-input" placeholder="e.g. Premium" data-i18n-placeholder="ntPromoReplacePh">
      </div>
      <div style="margin-bottom:10px">
        <label class="form-label" data-i18n="ntExtraPatterns">Extra Clean Patterns (one regex per line)</label>
        <textarea id="ntExtraPatterns" class="nt-textarea" placeholder="e.g. sponsor[：:]\\S+" data-i18n-placeholder="ntExtraPatternsPh"></textarea>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" id="ntSaveBtn" onclick="saveNameTransform()" data-i18n="save">Save</button>
        <span class="status-text" id="ntStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- 相似去重配置 -->
    <div class="section">
      <div class="section-title" data-i18n="dedupConfigTitle">Similar Name Dedup</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="similarDedupCheck" onchange="saveDedupConfig()" checked>
          <span data-i18n="similarDedupLabel">Enable similar-name dedup (keep fastest)</span>
        </label>
      </div>
      <div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="form-label" style="margin:0" data-i18n="dedupThreshold">Threshold</label>
        <input type="range" id="dedupThreshold" min="50" max="100" value="85" style="width:120px" oninput="$('dedupThresholdVal').textContent=this.value+'%'">
        <span id="dedupThresholdVal" style="font-family:var(--mono);font-size:0.8rem">85%</span>
        <button class="btn btn-sm" onclick="saveDedupConfig()" data-i18n="save">Save</button>
        <span class="status-text" id="dedupStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- 分组排序 -->
    <div class="section">
      <div class="section-title" data-i18n="groupOrderTitle">Site Group Order</div>
      <div style="margin-bottom:10px;display:flex;gap:10px;align-items:center">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="groupOrderEnabled" onchange="saveGroupOrder()">
          <span data-i18n="groupOrderEnabled">Enable group ordering</span>
        </label>
        <select id="groupOrderUnmatched" class="nt-input" style="width:auto;min-width:120px" onchange="saveGroupOrder()">
          <option value="after">Unmatched → after</option>
          <option value="before">Unmatched → before</option>
        </select>
        <span class="status-text" id="groupOrderStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div id="groupOrderRules"></div>
      <button class="btn btn-sm" onclick="addGroupRule()" style="margin-top:8px" data-i18n="groupOrderAdd">+ Add Rule</button>
    </div>

    <!-- 背景设置 -->
    <div class="section">
      <div class="section-title" data-i18n="bgSettingsTitle">Background Settings</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <select id="bgType" class="nt-input" style="width:auto;min-width:120px" onchange="onBgTypeChange()">
          <option value="default">Default</option>
          <option value="image">Image URL</option>
          <option value="solid">Solid Color</option>
          <option value="gradient">Gradient</option>
        </select>
      </div>
      <div id="bgImageGroup" style="display:none;margin-bottom:10px">
        <input type="text" id="bgImageUrl" class="nt-input" placeholder="https://example.com/bg.jpg">
      </div>
      <div id="bgSolidGroup" style="display:none;margin-bottom:10px">
        <input type="color" id="bgSolidColor" value="#0a0e14" style="width:50px;height:30px;border:none;cursor:pointer">
      </div>
      <div id="bgGradientGroup" style="display:none;margin-bottom:10px">
        <input type="text" id="bgGradient" class="nt-input" placeholder="linear-gradient(180deg, #0a0e14, #1a2030)">
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-sm" onclick="saveBgSettings()" data-i18n="save">Save</button>
        <span class="status-text" id="bgStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- 智能 Base URL -->
    <div class="section">
      <div class="section-title" data-i18n="smartBaseUrlTitle">Smart Base URL</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="smartBaseUrlCheck" onchange="saveSmartBaseUrl()">
          <span data-i18n="smartBaseUrlLabel">Auto-detect client host for JAR/image URLs (LAN only, set DMZ=0 to allow public)</span>
        </label>
        <span class="status-text" id="smartBaseUrlStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
    </div>

    <!-- 站点验活 -->
    <div class="section">
      <div class="section-title" data-i18n="siteProbeTitle">Site Content Probe &amp; Auto Clean</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <label class="form-label" style="margin:0" data-i18n="probeDepthLabel">Probe depth:</label>
        <select id="probeDepthSelect" class="nt-input" style="width:auto;min-width:140px" onchange="saveProbeDepth()">
          <option value="deep" data-i18n-text="probeDeep">Deep (validate content)</option>
          <option value="shallow" data-i18n-text="probeShallow">Shallow (HTTP only)</option>
        </select>
        <span class="status-text" id="probeDepthStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="autoCleanCheck" onchange="saveAutoClean()">
          <span data-i18n="autoCleanLabel">Auto-blacklist after 5 consecutive failures (max 5/run)</span>
        </label>
        <span class="status-text" id="autoCleanStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
      </div>
      <div style="margin-top:6px;font-size:0.8rem;color:var(--text-dim)" data-i18n="siteProbeDesc">Deep mode checks type0/type1 content validity. Failed sites get [⚠] marker after 3 failures.</div>
    </div>
  </div>

  <!-- Agg Logs Tab -->
  <div class="tab-panel" id="panelAggLogs">
    <div class="section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap">
        <div class="section-title" style="margin:0" data-i18n="liveLogsTitle">Live Logs</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="status-text" id="liveLogsStatus" style="font-family:var(--mono);font-size:0.75rem"></span>
          <button class="btn btn-sm" onclick="connectLiveLogs()" data-i18n="connectLogs">Connect</button>
          <button class="btn btn-sm btn-danger" onclick="disconnectLiveLogs()" data-i18n="disconnectLogs">Disconnect</button>
        </div>
      </div>
      <div id="liveLogsBox" class="live-log-box"></div>
    </div>
    <div class="section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="section-title" style="margin:0" data-i18n="aggLogsTitle">Aggregation Logs</div>
        <button class="btn btn-sm" onclick="clearAggLogs()" data-i18n="clearLogs">Clear All</button>
      </div>
      <div id="aggLogsList" style="font-size:0.85rem"></div>
    </div>
  </div>

  <div class="footer">
    <span data-i18n="footer">TVBox Source Aggregator &middot; Admin Console</span>
  </div>
</div>

<script>
${sharedUi}

// --- i18n ---
const translations = {
  en: {
    loginTitle:'Admin Access', loginSubtitle:'TVBox Aggregator Management',
    invalidToken:'Invalid token', enterToken:'Enter admin token', login:'Login',
    connectionFailed:'Connection failed',
    headerLabel:'Admin Console', navConfigEditor:'Config Editor', navDashboard:'Dashboard',
    tabSources:'Sources', tabMacCMS:'MacCMS', tabLive:'Live', tabSettings:'Settings', tabAggLogs:'Logs',
    aggLogsTitle:'Aggregation Logs', clearLogs:'Clear All', liveLogsTitle:'Live Logs', connectLogs:'Connect', disconnectLogs:'Disconnect',
    dedupConfigTitle:'Similar Name Dedup', similarDedupLabel:'Enable similar-name dedup (keep fastest)', dedupThreshold:'Threshold',
    groupOrderTitle:'Site Group Order', groupOrderEnabled:'Enable group ordering', groupOrderAdd:'+ Add Rule',
    bgSettingsTitle:'Background Settings',
    addSource:'Add Source', editSource:'Edit Source', edit:'Edit', cancel:'Cancel', updating:'Updating...', sourceUpdated:'Source updated', aggregation:'Aggregation', sourcesList:'Sources',
    addMacCMS:'Add MacCMS Source', editMacCMS:'Edit MacCMS Source', macCMSSourceUpdated:'MacCMS source updated', macCMSSources:'MacCMS Sources',
    addLiveSource:'Add Live Source', editLiveSource:'Edit Live Source', liveSourceUpdated:'Live source updated', liveSources:'Live Sources',
    liveImportExport:'Live Import / Export', liveImportPlaceholder:'One live source per line: Name URL / URL Name / URL only; a single URL accepts a live source, TVBox config, or remote config.', liveListHelp:'One live source per line. Supports “Name URL”, “URL Name”, or URL only. A single URL expands when it returns a TVBox config; otherwise it is imported as a live source. Legacy JSON and remote config URLs are also supported. Import merges by default and duplicate URLs are skipped.', liveImport:'Import Live Sources', liveExport:'Export Live Sources', liveImporting:'Importing...', liveImported:'Live sources imported', liveImportDuplicates:'duplicates skipped', liveImportParseFailed:'Failed to import live sources',
    nameOptional:'Name (optional)', configJsonUrl:'TVBox config JSON URL',
    mcKeyPh:'Key (e.g. hongniuzy)', mcNamePh:'Name', mcApiPh:'MacCMS API URL',
    liveNamePh:'Name (e.g. iptv365)', liveUrlPh:'m3u/txt URL',
    add:'Add', adding:'Adding...', batchImport:'Batch Import / Restore',
    mcBatchPlaceholder:'One MacCMS source per line: Name API URL / API URL Name / URL only; legacy JSON array is also accepted.',
    mcListHelp:'One MacCMS source per line. Supports “Name API URL”, “API URL Name”, or URL only. A unique key is generated when omitted. Import merges by default and duplicate key/API entries are skipped.',
    submitBatch:'Import / Restore',refresh:'Refresh', aggregateNow:'Aggregate now', aggregateNowRunning:'Aggregating...', running:'Running...', remove:'Remove', test:'Test',
    loadingStatus:'Loading...',
    lastUpdate:'Last update: ', neverUpdated:'No successful update yet', updateFailed:'Recent aggregation failed: ',
    failedLoadStatus:'Failed to load status',
    noSources:'No sources configured. Add one above.',
    noMacCMS:'No MacCMS sources. Add one above.',
    noLives:'No live sources. Add one above.',
    failedLoad:'Failed to load sources',
    failedLoadMacCMS:'Failed to load MacCMS sources',
    failedLoadLives:'Failed to load live sources',
    sourceAdded:'Source added', sourceRemoved:'Source removed',
    networkError:'Network error', testing:'Testing...',
    valid:'Valid', invalidUnreachable:'Invalid / Unreachable',
    liveSourceAdded:'Live source added', removed:'Removed', disabledStatus:'Disabled', enable:'Enable', disable:'Disable', sourceDisabled:'Source disabled', sourceEnabled:'Source enabled',
    invalidJson:'Invalid JSON', mustBeArray:'Must be a JSON array',
    allFieldsRequired:'All fields required', importFailed:'Import failed',
    aggregationStarted:'Aggregation started', aggregationCompleted:'Aggregation completed', aggregationAlreadyRunning:'Aggregation is already running', refreshTimedOut:'Aggregation is taking too long and may be stuck; status will keep updating', refreshFailed:'Refresh failed',
    importConfig:'Batch Import', backupRestore:'Source Backup & Restore', backupHelp:'Download Backup saves all movie sources. Restore replaces the current list, so download a backup first.', import:'Import', importing:'Importing...', restoreBackup:'Restore Backup', restoring:'Restoring...', chooseBackup:'Choose backup file', restoreFileLoaded:'Loaded backup:', restoreBackupConfirm:'Replace all current sources with this backup? This cannot be undone.', restored:'Backup restored', restoreFailed:'Restore failed', restoreInvalidJson:'This is not a valid source backup JSON file.',
    importPlaceholder:'One source per line: Name URL / URL Name / URL only; legacy JSON or remote config URL is also accepted.',
    sourceListHelp:'One source per line. Supports “Name URL”, “URL Name”, or URL only. A single URL without a name is still fetched as a remote TVBox config. Import merges by default and duplicate URLs are skipped.',
    importMulti:'Multi-repo detected', importSingle:'Single config detected',
    importAdded:'added', importDuplicates:'duplicates', importInvalid:'invalid', importParseFailed:'Failed to parse',
    exportConfig:'Download Backup', export:'Download Backup', exporting:'Exporting...', exported:'Backup downloaded', exportFailed:'Export failed',
    nameTransform:'Name Transform', ntPrefix:'Prefix', ntSuffix:'Suffix',
    ntPromoReplace:'Promo Replacement (empty = delete)', ntExtraPatterns:'Extra Clean Patterns (one regex per line)',
    ntPrefixPh:'e.g. 【RioTV】', ntSuffixPh:'e.g.  · Curated',
    ntPromoReplacePh:'e.g. Premium', ntExtraPatternsPh:'e.g. sponsor[：:]\\\\S+',
    cronInterval:'Source Aggregation Schedule',
    speedTestToggle:'Media Site Speed Test', speedTestLabel:'Enable speed testing and remove unreachable media sites during aggregation', speedTestDesc:'This tests media-site API endpoints during aggregation. It is separate from search-quality grading and site-content probing.',
    edgeProxies:'Edge Function Proxies', edgeProxiesDesc:'Configure edge function URLs for proxy fallback (fetch retry + image CDN). Local Docker mode only.',
    storageStatus:'Storage Status', storageStatusDesc:'Shows remote persistence health. Render local SQLite is only a cache; critical settings count as saved only after the remote KV write succeeds.',
    storageMode:'Mode', storageRemoteConfigured:'Remote KV configured', storageNamespace:'Namespace (masked)', storageRemoteTimeout:'Remote timeout', storageLastRead:'Last remote read', storageLastWrite:'Last remote write', storagePendingWrites:'Pending writes', storageCoolingDown:'Remote cooling down', storageLastError:'Last remote error', storageSkippedLocalWrites:'Local-only writes skipped', storageLastSkippedKey:'Last local-only key', yes:'Yes', no:'No',
    refreshing:'Refreshing...', loading:'Loading...',
    cronEvery1h:'Every 1 hour', cronEvery3h:'Every 3 hours', cronEvery6h:'Every 6 hours',
    cronEvery12h:'Every 12 hours', cronEveryDay:'Once a day',
    save:'Save', saving:'Saving...', saved:'Saved', saveFailed:'Save failed',
    noHealthData:'No data yet', healthFails:'Fails',
    healthLastOk:'Last OK',
    qualitySchedule:'Search Quality Grading',
    qualityEnabled:'Enable scheduled grading',
    qualityTimes:'Times', qualityTimesPh:'e.g. 04:30, 16:30', qualityRepeatDays:'Candidate pool refresh (days)', qualityFullRepeatDays:'Full grading interval (days)',
    qualityRunCandidate:'Retest candidate pool', qualityRunFull:'Full re-grade', qualityRunNow:'Run now', qualityRefresh:'Refresh grading status', qualityStatusLabel:'Status', qualityStatusMode:'mode',
    qualityScheduleDesc:'Grading runs asynchronously in the background and returns immediately, so the page and other requests are never blocked. Daily runs refresh the candidate pool and also preflight sources that cannot be tested as a simple HTTP API: fetch/decode config or API responses (GET, then POST fallback), inject distributable frontend credentials, verify AList APIs, and download JARs for ZIP/MD5/structure checks. Only actual Java execution and final media playback remain client-side. When the full-grading interval is reached or the candidate pool is empty, a full grading run happens automatically. Both Cloudflare and Node/Render run in small chunks and yield between chunks; Node/Render resumes from the saved cursor after a restart.',
    qualityGradeDesc:'Quality grades (probed in chunks in the background, no impact on client startup): excellent <=1000ms, good 1001-3000ms, usable 3001-6000ms. For sources that cannot be speed-probed as a simple HTTP API, the server simulates TVBox client behavior: it fetches/decodes config or API responses (with POST fallback), injects saved distributable credentials, verifies AList /api/fs/list responses, and downloads JARs for ZIP/MD5/structure checks. Only actual Java execution and final media playback remain client-side. Timeout and unusable are never served. Normally set only two values: searchable-source limit and parser limit; the page shows actual counts, preflight coverage, grade breakdown and recommended values.',
    qualityNoSnapshot:'No grading result yet. Run grading once to build the quality pool.',
    qualityStateIdle:'idle', qualityStateRunning:'running', qualityStateDone:'done', qualityStateError:'error',
    qualityLastRun:'Last run', qualityNextRun:'Next run', qualityLastFullRun:'Last full run', qualityNextFullRun:'Next full run', qualityNever:'never',
    qualityGradesTitle:'Quality grades', qualityRecommended:'Recommended', qualityRecSearchable:'searchable limit', qualityRecParses:'parser limit', sqCumulative:'cumulative', qualityUseRecommended:'Fill recommended values', qualityRecommendedApplied:'Recommended values filled in; click Save in Search Quota.', qualityActualCounts:'Current actual counts', sqStatsUsablePool:'usable pool',
    qualityTimesHint:'Uses the timezone configured by QUALITY_TIMEZONE (default Asia/Shanghai, UTC+8). Comma-separated HH:MM, up to 12 per day. Candidate pool refresh re-tests HTTP speed sources and reruns server-side preflight for config/API/credential/AList/JAR-structure sources every N days. Full grading re-grades all searchable sources every N days.',
    qualityRunningNote:'Grading is running in the background; you can keep using the page.',
    qualityStarted:'Grading started', qualityAlreadyRunning:'Grading already running', qualityModeCandidate:'candidate pool grading/refresh', qualityModeFull:'full grading', qualityCoverage:'coverage', qualityTestable:'testable', qualityProbed:'probed', qualityNotProbed:'not probed', qualityUntestable:'untestable', qualityCredentialReady:'credential-ready', qualityCredentialPartial:'credential partial/invalid', qualityCredentialMissing:'credential missing', qualityPreflightVerified:'server config verified', qualityPreflightCredentialReady:'server credential verified', qualityPreflightAListVerified:'AList verified', qualityPreflightJarVerified:'JAR downloaded and verified', qualityClientFinalOnly:'client final check only', qualityRunCandidateStarted:'Candidate pool grading started (background)', qualityRunFullStarted:'Full grading started (background)',
    qualityScheduleSaved:'Schedule saved', qualityReportRefreshed:'Report refreshed',
    searchQuota:'Client Search Quota',
    maxSearchable:'Searchable sources', maxQuickSearch:'Quick-search sources', maxStartupQuickSearch:'Startup quick-search sources', startupSiteLimit:'Startup source count', maxParses:'Parser limit', retainCredentialSources:'Retain credential/JAR sources', autoSearchLimit:'Auto safe limit', searchQuotaDesc:'This only controls what is served to clients: searchable-source limit and parser limit. Searchable sources = 0 serves every searchable source that passed quality filtering; above 0 keeps them in quality order excellent > good > usable > credential-ready > untestable. Timeout and unusable sources are never served. Untestable means the server has completed config/API/credential/AList/JAR-structure preflight but final Java execution or media playback still needs the client; it does not mean the source was skipped. Parser limit defaults to 3; 0 means unlimited. When "Retain credential/JAR sources" is checked, the searchable-source limit applies only to testable excellent/good/usable sources; credential-ready and client-final-only sources are retained in addition and do not consume the limit. Quick-search and startup quick-search limits default to 0 (unlimited); non-zero values are explicit advanced caps.', sortSearchBySpeed:'Sort by speed', sortSearchBySpeedDesc:'Uses existing site speed-test results to put faster sources first; no extra network requests. Pinned sources stay first.', leanStartup:'Lean startup', leanStartupDesc:'Removes remote JAR/extension sites from the root startup config to shorten TVBox startup; pinned sources are kept.', maxStartupQuickSearchDesc:'Quick-search cap used by the root startup config; 0 means unlimited. Full config remains available at /config-full.json.', startupOptimizationDesc:'Quick-search and root-startup limits default to unlimited. The root address may still be trimmed by the searchable-source limit; /config-full.json contains the full searchable set.', startupMode:'Startup mode', startupModeLean:'Lean', startupModeFull:'Full', startupModeDesc:'Lean serves a trimmed config at the root address for faster startup. Full is still available at /config-full.json.', pruneDeadParses:'Prune dead parsers', pruneDeadParsesDesc:'Probes parser endpoints and removes confirmed failures/timeouts so clients do not wait for each dead parser during startup.',
    tabSearchQuota:'Search',
    sqSelected:'Active Search Sources', sqQuality:'Quality grades', sqExcellent:'Excellent', sqGood:'Good', sqUsable:'Usable', sqCredentialReady:'Credential-ready', sqUntestable:'Client final check only', sqTimeout:'Timeout', sqUnusable:'Unusable', sqPoolTotal:'Candidate pool', sqNoData:'Run aggregation to see results',
    sqStatsCurrent:'Current actual counts', sqStatsSearchable:'searchable', sqStatsQuick:'quick-search', sqStatsQuickLimit:'auto cap', sqStatsPool:'candidate pool', sqStatsParsers:'Parsers', sqStatsKept:'kept', sqStatsProbed:'probed', sqStatsRemoved:'removed', sqStatsLimit:'limit', sqStatsUnlimited:'unlimited', sqStatsQuality:'Quality grades', sqStatsNoData:'Run aggregation to show quality grades and parser counts.',
    sqKey:'Key', sqName:'Name', sqSource:'Source', sqReason:'Reason', sqGrade:'Grade', sqSpeedStatus:'Speed / Status', sqAction:'Action',
    sqPin:'Pin', sqUnpin:'Unpin',
    sqBlock:'Block', sqUnblock:'Unblock', sqBlocked:'Blocked', sqBlockedDesc:'Blocked sources are excluded from all client outputs but remain here so they can be restored.', sqSourceFilterPh:'Search source name or key...', sqFilterAll:'All grades', sqFilterMatched:'Matched', sqFilterNoMatch:'No matching sources',
    sqPinned:'Pinned', sqPinnedDesc:'Drag to reorder. Top sources are searched first in TVBox.', sqOtherSources:'Candidate Sources', sqCandidateDesc:'Candidate sources passed quality filtering and are eligible for distribution. Pinned sources are searched first; blocked sources stay in this list but are excluded from every client output.', sqExcludedSources:'Not Selected', sqExcludedDesc:'Searchable sources outside the quality candidate pool (JS URL, timeout, unusable, or not selected) are not distributed to clients.', sqReasonJsUrlExcluded:'JS URL excluded', sqReasonTimeout:'Timeout', sqReasonUnusable:'Unusable', sqReasonNotInPool:'Not in quality pool', sqReasonNotCandidate:'Not a candidate',
    sqHttp:'http', sqMainJar:'main jar', sqIndepJar:'indep jar', sqLeanRemoved:'lean-removed',
    channelProbeTitle:'Channel Speed Probe (Node/Docker)',
    channelProbeEnable:'Enable scheduled channel speed test (every 12h)',
    channelProbeTrigger:'Probe now', channelProbeRefresh:'Refresh probe status',
    channelProbeIdle:'Idle', channelProbeRunning:'Running', channelProbeDone:'Completed', channelProbeError:'Error',
    channelProbeState:'State', channelProbeProgress:'Progress', channelProbeCoverage:'Coverage',
    channelProbeChannels:'Channels', channelProbeDuration:'Duration', channelProbeFinished:'Finished at',
    channelProbeStarted:'Probe started', channelProbeDisabledFirst:'Enable probe first', channelProbeAlreadyRunning:'Already running',
    channelProbeCfOnly:'Only Node/Docker supports channel probing',
    liveStrategyTitle:'Live Output Strategy', liveToggleTitle:'Live Feature Toggle', liveToggleLabel:'Disable live aggregation (skip live merge, output empty lives)',
    liveStrategyDisabledHint:'Live aggregation is disabled. The options below are inactive until it is enabled again.',
    ignoreAggregatedLivesTitle:'Ignore Aggregated Lives', ignoreAggregatedLivesLabel:'Ignore live sources inside subscription configs (only use manually added live sources)',
    liveMergeModeTitle:'Live merge mode', liveMergeSeparated:'Separated (group by source)', liveMergeMerged:'Merged (deduplicate channels)', liveMergeModeDesc:'Separated keeps every source as its own group; merged combines channels by name and removes duplicates.',
    smartBaseUrlTitle:'Smart Base URL', smartBaseUrlLabel:'Auto-detect client host for JAR/image URLs (LAN only, set DMZ=0 to allow public)',
    siteProbeTitle:'Site Content Probe & Auto Clean', probeDepthLabel:'Probe depth:',
    probeDeep:'Deep (validate content)', probeShallow:'Shallow (HTTP only)',
    autoCleanLabel:'Auto-blacklist after 5 consecutive failures (max 5/run)',
    siteProbeDesc:'Deep mode checks type0/type1 content validity. Failed sites get [⚠] marker after 3 failures.',
    credentialDistributionTitle:'Credential Distribution & Client Authentication',
    credentialDistributionDesc:'Choose what the root link may distribute, then optionally create per-client auth codes. Auth codes live only in the URL path, so the client enters an ordinary /auth/<code>/ link and never a query parameter. When credentials are not distributed, the client can still scan the QR code and log in locally.',
    credentialDefaultPolicy:'Root-link default credential policy',
    credentialModeNone:'Do not distribute credentials',
    credentialModeAll:'Distribute all saved credentials',
    credentialModeSelected:'Distribute selected platforms only',
    credentialRequireAuth:'Require an auth code; root link returns 401',
    credentialStripUpstreamEntries:'Also remove upstream cloud-login entries in no-credential mode',
    credentialPolicyHint:'The root policy applies only when authentication is off. Each auth code below can independently distribute none, all, or selected credentials. In selected mode, leaving every platform unchecked distributes no credentials.',
    credentialAuthCodes:'Client auth codes',
    credentialAuthCodesDesc:'Create one code per client or group. The client uses the shown /auth/&lt;code&gt;/ URL and never appends a query parameter; each code has its own credential policy.',
    credentialAddCode:'+ Add auth code',
    credentialNoCodes:'No auth codes yet. The root link uses the default policy above.',
    credentialCodeLabel:'Name / note',
    credentialCodeValue:'Auth code',
    credentialCodeMode:'Credential policy',
    credentialCodeEnabled:'Enabled',
    credentialCopyRoot:'Copy root link',
    credentialCopyAuth:'Copy authenticated link',
    credentialCopied:'Copied',
    credentialDelete:'Delete',
    credentialRootLinkHint:'Root link status',
    credentialSaved:'Credential distribution and auth codes saved',
    credentialRootRequired:'Enable at least one auth code before requiring authentication.',
    credentialCodeInvalid:'Auth code must be 1-64 characters: letters, numbers, underscore or hyphen.',
    credentialSelectedSummary:'Selected',
    credentialSelectedEmptyShort:'Selected: none (no credentials)',
    credentialSelectedEmpty:'No platform is selected. This auth code will distribute no credentials; the client can still log in locally.',
    credentialDefaultLabel:'Default client',
    cloudLoginDesc:'Log in here once; choose whether to distribute the saved credential in Settings. If a platform is not distributed, clients can still scan the QR code and log in themselves.',
    cloudManualPasteHelp:'<strong>💡 Manual login:</strong><br>' +
      '• <strong>Tianyi</strong>: Web QR is unstable. Sign in at <a href="https://h5.cloud.189.cn" target="_blank" style="color:var(--accent)">h5.cloud.189.cn</a> on a phone browser, copy the Cookie header value, select Tianyi above and paste.<br>' +
      '• <strong>123Pan</strong>: Third-party QR login is restricted. Generate a WebDAV password in 123Pan Web -> Tool Center -> Third-Party Mount, select 123Pan above and paste.',
    credentialSecurityHint:'Security: links with an auth code grant access to the selected credentials. Use HTTPS, do not publish auth-code links, and rotate a code if it leaks. Disabling a code immediately stops it from working.',
    footer:'TVBox Source Aggregator &middot; Admin Console',
  },
  zh: {
    loginTitle:'管理登录', loginSubtitle:'TVBox 聚合器管理',
    invalidToken:'无效的令牌', enterToken:'请输入管理令牌', login:'登录',
    connectionFailed:'连接失败',
    headerLabel:'管理控制台', navConfigEditor:'配置编辑', navDashboard:'仪表盘',
    tabSources:'源', tabMacCMS:'MacCMS', tabLive:'直播', tabSettings:'设置', tabAggLogs:'日志',
    aggLogsTitle:'聚合日志', clearLogs:'清空', liveLogsTitle:'实时日志', connectLogs:'连接', disconnectLogs:'断开',
    dedupConfigTitle:'相似名称去重', similarDedupLabel:'启用相似名称去重（保留最快）', dedupThreshold:'阈值',
    groupOrderTitle:'站点分组排序', groupOrderEnabled:'启用分组排序', groupOrderAdd:'+ 添加规则',
    bgSettingsTitle:'背景设置',
    addSource:'添加源', editSource:'修改源', edit:'修改', cancel:'取消', updating:'修改中...', sourceUpdated:'源已修改', aggregation:'聚合', sourcesList:'源列表',
    addMacCMS:'添加 MacCMS 源', editMacCMS:'修改 MacCMS 源', macCMSSourceUpdated:'MacCMS 源已修改', macCMSSources:'MacCMS 源列表',
    addLiveSource:'添加直播源', editLiveSource:'修改直播源', liveSourceUpdated:'直播源已修改', liveSources:'直播源列表',
    liveImportExport:'直播导入 / 导出', liveImportPlaceholder:'每行一个直播源：源名 URL / URL 源名 / 仅 URL；单行 URL 兼容直播源、TVBox 配置和远程配置。', liveListHelp:'每行一个直播源，支持“源名 URL”“URL 源名”或仅 URL；单行 URL 若返回 TVBox 配置会展开，否则直接作为直播源导入。也兼容旧版 JSON 和远程配置 URL。导入默认合并，重复 URL 会跳过。', liveImport:'导入直播源', liveExport:'导出直播源', liveImporting:'导入中...', liveImported:'直播源已导入', liveImportDuplicates:'条重复已跳过', liveImportParseFailed:'导入直播源失败',
    nameOptional:'名称（可选）', configJsonUrl:'TVBox 配置 JSON 地址',
    mcKeyPh:'Key（如 hongniuzy）', mcNamePh:'名称', mcApiPh:'MacCMS API 地址',
    liveNamePh:'名称（如 iptv365）', liveUrlPh:'m3u/txt 地址',
    add:'添加', adding:'添加中...', batchImport:'批量导入 / 恢复',
    mcBatchPlaceholder:'每行一个 MacCMS 源：源名 API URL / API URL 源名 / 仅 URL；也可粘贴旧版 JSON 数组。',
    mcListHelp:'每行一个 MacCMS 源，支持“源名 API URL”“API URL 源名”或仅 URL；缺少 key 时自动生成唯一 key。导入默认合并，重复 key/API 会跳过。',
    submitBatch:'导入 / 恢复',refresh:'刷新', aggregateNow:'立即聚合', aggregateNowRunning:'聚合中...', running:'运行中...', remove:'删除', test:'测试',
    loadingStatus:'加载中...',
    lastUpdate:'上次更新: ', neverUpdated:'暂无成功更新时间', updateFailed:'最近聚合失败：',
    failedLoadStatus:'获取状态失败',
    noSources:'暂无源。请在上方添加。',
    noMacCMS:'暂无 MacCMS 源。请在上方添加。',
    noLives:'暂无直播源。请在上方添加。',
    failedLoad:'加载源失败',
    failedLoadMacCMS:'加载 MacCMS 源失败',
    failedLoadLives:'加载直播源失败',
    sourceAdded:'源已添加', sourceRemoved:'源已删除',
    networkError:'网络错误', testing:'测试中...',
    valid:'有效', invalidUnreachable:'无效/不可达',
    liveSourceAdded:'直播源已添加', removed:'已删除', disabledStatus:'已关闭', enable:'启用', disable:'关闭', sourceDisabled:'源已关闭', sourceEnabled:'源已启用',
    invalidJson:'无效的 JSON', mustBeArray:'必须是 JSON 数组',
    allFieldsRequired:'所有字段必填', importFailed:'导入失败',
    aggregationStarted:'聚合已开始', aggregationCompleted:'聚合已完成', aggregationAlreadyRunning:'聚合正在运行', refreshTimedOut:'聚合耗时过长，可能已卡住；状态会继续更新', refreshFailed:'刷新失败',
    importConfig:'批量导入', backupRestore:'源备份与恢复', backupHelp:'下载备份会保存全部影视源；恢复备份会覆盖当前列表，操作前请先下载备份。', import:'导入', importing:'导入中...', restoreBackup:'恢复备份', restoring:'恢复中...', chooseBackup:'选择备份文件', restoreFileLoaded:'已载入备份：', restoreBackupConfirm:'恢复将覆盖当前全部影视源配置，且无法撤销。确定继续吗？', restored:'备份已恢复', restoreFailed:'恢复失败', restoreInvalidJson:'这不是有效的源备份 JSON 文件。',
    importPlaceholder:'每行一个源：源名 URL / URL 源名 / 仅 URL；也可粘贴旧版 JSON 或远程配置 URL。',
    sourceListHelp:'每行一个源，支持“源名 URL”“URL 源名”或仅 URL；仅 URL 的单行仍按远程 TVBox 配置抓取。导入默认合并，重复 URL 会跳过。',
    importMulti:'检测到多仓', importSingle:'检测到单仓',
    importAdded:'已添加', importDuplicates:'重复跳过', importInvalid:'无效', importParseFailed:'解析失败',
    exportConfig:'下载备份', export:'下载备份', exporting:'导出中...', exported:'备份已下载', exportFailed:'导出失败',
    nameTransform:'名称定制', ntPrefix:'前缀', ntSuffix:'后缀',
    ntPromoReplace:'推广替换文字（留空则删除）', ntExtraPatterns:'额外清洗正则（每行一条）',
    ntPrefixPh:'如 【RioTV】', ntSuffixPh:'如  · 精选',
    ntPromoReplacePh:'如 精选推荐', ntExtraPatternsPh:'如 sponsor[：:]\\\\S+',
    cronInterval:'源聚合计划',
    speedTestToggle:'影视站点测速', speedTestLabel:'聚合时测速并剔除不可达的影视站点', speedTestDesc:'这里测试的是影视站点 API；与下方的搜索源质量分级、站点内容验活不是同一项任务。',
    edgeProxies:'边缘函数代理', edgeProxiesDesc:'配置边缘函数 URL，用于本地 Docker 模式的请求代理回退和图片 CDN 加速',
    storageStatus:'存储状态', storageStatusDesc:'显示远端持久化状态。Render 的本地 SQLite 只作为缓存，关键配置必须成功写入远端 KV 才算保存。',
    storageMode:'模式', storageRemoteConfigured:'已配置远端 KV', storageNamespace:'命名空间（已脱敏）', storageRemoteTimeout:'远端超时', storageLastRead:'最近远端读取', storageLastWrite:'最近远端写入', storagePendingWrites:'待同步写入', storageCoolingDown:'远端冷却中', storageLastError:'最近远端错误', storageSkippedLocalWrites:'已跳过本地缓存写入', storageLastSkippedKey:'最近跳过键', yes:'是', no:'否',
    refreshing:'刷新中...', loading:'加载中...',
    cronEvery1h:'每 1 小时', cronEvery3h:'每 3 小时', cronEvery6h:'每 6 小时',
    cronEvery12h:'每 12 小时', cronEveryDay:'每天一次',
    save:'保存', saving:'保存中...', saved:'已保存', saveFailed:'保存失败',
    noHealthData:'暂无数据', healthFails:'失败',
    healthLastOk:'最后成功',
    qualitySchedule:'搜索源质量分级',
    qualityEnabled:'启用定时分级',
    qualityTimes:'执行时间', qualityTimesPh:'例如 04:30, 16:30', qualityRepeatDays:'候选池重排周期（天）', qualityFullRepeatDays:'全量分级周期（天）',
    qualityRunCandidate:'重测候选池', qualityRunFull:'全量重测', qualityRunNow:'立即执行', qualityRefresh:'刷新分级状态', qualityStatusLabel:'状态', qualityStatusMode:'模式',
    qualityScheduleDesc:'分级在后台异步执行，点击后立即返回，不会阻塞网页或其他请求。日常会重测候选池，并对无法用普通 HTTP API 测速的源执行服务端预检：真实请求并解码配置/API（GET 失败时 POST 回退）、按规则注入前端凭证、验证 AList 接口，以及下载 JAR 做 ZIP/MD5/结构校验。只有 Java 实际执行和最终媒体播放留给客户端。到达全量周期或候选池为空时自动全量分级。Cloudflare 和 Node/Render 都按小分片执行并在分片间让出事件循环；Node/Render 异常重启后会从已保存游标继续。',
    qualityGradeDesc:'质量分级（后台分块测速，不影响应用端启动速度）：优 ≤1000ms；良 1001-3000ms；可用 3001-6000ms。对无法直接用普通 HTTP API 测速的源，服务端会模拟 TVBox 客户端行为：真实请求并解码配置/API（必要时 POST 回退）、按规则注入前端保存的凭证、验证 AList 接口，以及下载 JAR 做 ZIP/MD5/结构校验。只有 Java 实际执行和最终媒体播放需要客户端完成。超时和不可用不进入候选池，凭证内容不会输出。日常只需填写可搜索源上限和解析器上限；页面会显示实际数量、预检覆盖、分级统计和推荐值。',
    qualityNoSnapshot:'尚无分级结果，先执行一次分级以建立质量池。',
    qualityStateIdle:'空闲', qualityStateRunning:'运行中', qualityStateDone:'已完成', qualityStateError:'错误',
    qualityLastRun:'上次执行', qualityNextRun:'下次执行', qualityLastFullRun:'上次全量', qualityNextFullRun:'下次全量', qualityNever:'从未',
    qualityGradesTitle:'质量分级', qualityRecommended:'推荐值', qualityRecSearchable:'可搜索源上限', qualityRecParses:'解析器上限', sqCumulative:'累计', qualityUseRecommended:'填入推荐值', qualityRecommendedApplied:'已填入推荐值，请点击搜索配额中的保存。', qualityActualCounts:'当前实际数量', sqStatsUsablePool:'可用池',
    qualityTimesHint:'按 QUALITY_TIMEZONE 配置的时区执行（默认 Asia/Shanghai，北京时间 UTC+8）。用英文逗号分隔的 HH:MM 时间点，每天最多 12 个。候选池重排周期表示每隔 N 天重测一次 HTTP 测速候选源，并重新执行配置/API/凭证/AList/JAR 结构的服务端预检；全量分级周期表示每隔 N 天对所有可搜索源做一次完整分级。',
    qualityRunningNote:'分级正在后台运行，可继续使用本页面。',
    qualityStarted:'分级已开始', qualityAlreadyRunning:'分级已在运行', qualityModeCandidate:'候选池分级/重排', qualityModeFull:'全量分级', qualityCoverage:'覆盖率', qualityTestable:'可测试', qualityProbed:'已探测', qualityNotProbed:'未探测', qualityUntestable:'不可测试', qualityCredentialReady:'凭证就绪', qualityCredentialPartial:'凭证部分有效/无效', qualityCredentialMissing:'凭证缺失', qualityPreflightVerified:'服务端配置已验证', qualityPreflightCredentialReady:'服务端凭证已验证', qualityPreflightAListVerified:'AList 已验证', qualityPreflightJarVerified:'JAR 已下载校验', qualityClientFinalOnly:'仅客户端最终确认', qualityRunCandidateStarted:'候选池分级已开始（后台运行）', qualityRunFullStarted:'全量分级已开始（后台运行）',
    qualityScheduleSaved:'计划已保存', qualityReportRefreshed:'报告已刷新',
    searchQuota:'应用端搜索配额',
    maxSearchable:'可搜索源上限', maxQuickSearch:'快速搜索源上限', maxStartupQuickSearch:'启动快速源上限', startupSiteLimit:'启动源数量', maxParses:'解析器上限', retainCredentialSources:'保留凭证/JAR 源', autoSearchLimit:'自动安全配额', searchQuotaDesc:'这里只影响下发到应用端的数量：可搜索源上限和解析器上限。可搜索源上限填 0 表示下发全部通过质量筛选的搜索源；填写大于 0 时，按“优 > 良 > 可用 > 凭证就绪 > 仅客户端最终确认”的质量顺序保留，超时和不可用不会下发。“仅客户端最终确认”表示服务端已完成配置、接口、凭证、AList 或 JAR 结构预检，但 Java 执行或最终播放仍需客户端确认，并不是被服务端跳过。解析器上限默认推荐 3；填 0 表示不限制。勾选“保留凭证/JAR 源”后，可搜索源上限只限制优/良/可用等可测速源；凭证就绪和仅客户端最终确认的源会额外保留，不挤占可搜索源上限。快速搜索源和启动快速源默认 0（不限制）；填写大于 0 时才作为高级上限显式生效。', sortSearchBySpeed:'按测速速度排序', sortSearchBySpeedDesc:'复用现有站点测速结果，将较快的源排在前面；不会额外发起测速请求。置顶源始终最前。', leanStartup:'轻量启动', leanStartupDesc:'根配置启动阶段去掉远程 JAR/扩展站点，缩短影视仓/TVBox 启动时间；置顶源仍保留。', maxStartupQuickSearchDesc:'根地址启动配置使用的快速搜索上限；0 表示不限制。完整配置仍可通过 /config-full.json 获取。', startupOptimizationDesc:'快速搜索源和根地址启动源默认不限制；根地址仍会受可搜索源上限裁剪，/config-full.json 保留完整搜索源。', startupMode:'启动模式', startupModeLean:'轻量', startupModeFull:'完整', startupModeDesc:'轻量模式在根地址返回裁剪后的启动配置以加快启动；完整配置仍可通过 /config-full.json 获取。', pruneDeadParses:'剔除失效解析器', pruneDeadParsesDesc:'主动探测解析器地址并剔除确认超时或失效的项，避免客户端启动时逐个等待死解析器。',
    tabSearchQuota:'搜索',
    sqSelected:'活跃搜索源', sqQuality:'质量分级', sqExcellent:'优', sqGood:'良', sqUsable:'可用', sqCredentialReady:'凭证就绪', sqUntestable:'仅客户端最终确认', sqTimeout:'超时', sqUnusable:'不可用', sqPoolTotal:'候选池', sqNoData:'执行聚合后查看结果',
    sqStatsCurrent:'当前实际数量', sqStatsSearchable:'可搜索源', sqStatsQuick:'快速搜索', sqStatsQuickLimit:'自动上限', sqStatsPool:'候选池', sqStatsParsers:'解析器', sqStatsKept:'最终保留', sqStatsProbed:'探测', sqStatsRemoved:'剔除', sqStatsLimit:'上限', sqStatsUnlimited:'不限制', sqStatsQuality:'质量分级', sqStatsNoData:'执行聚合后显示质量分级和解析器数量。',
    sqKey:'Key', sqName:'名称', sqSource:'来源', sqReason:'原因', sqGrade:'等级', sqSpeedStatus:'速度 / 状态', sqAction:'操作',
    sqPin:'置顶', sqUnpin:'取消置顶',
    sqBlock:'屏蔽', sqUnblock:'取消屏蔽', sqBlocked:'已屏蔽', sqBlockedDesc:'屏蔽源不会下发到任何客户端，但仍保留在管理列表中，可随时恢复。可按名称/Key 搜索，并按质量等级或“已屏蔽”筛选。', sqSourceFilterPh:'搜索源名称或 Key...', sqFilterAll:'全部等级', sqFilterMatched:'匹配', sqFilterNoMatch:'没有匹配的源',
    sqPinned:'置顶源', sqPinnedDesc:'上下移动排序，排在前面的源在 TVBox 搜索时优先执行', sqOtherSources:'候选源', sqCandidateDesc:'通过质量筛选、可参与下发的候选源。置顶源优先搜索；屏蔽后仍保留在此列表，但不会下发到任何客户端。', sqExcludedSources:'未入选源', sqExcludedDesc:'可搜索但未进入质量候选池的源（如 JS URL、超时、不可用或未入选），不会下发到客户端。', sqReasonJsUrlExcluded:'JS URL 已排除', sqReasonTimeout:'超时', sqReasonUnusable:'不可用', sqReasonNotInPool:'不在质量池', sqReasonNotCandidate:'非候选源',
    sqHttp:'HTTP', sqMainJar:'主 JAR', sqIndepJar:'独立 JAR', sqLeanRemoved:'轻量剔除',
    channelProbeTitle:'频道级测速（仅 Node/Docker）',
    channelProbeEnable:'启用定时频道测速（每 12 小时）',
    channelProbeTrigger:'立即测速', channelProbeRefresh:'刷新测速状态',
    channelProbeIdle:'空闲', channelProbeRunning:'运行中', channelProbeDone:'已完成', channelProbeError:'失败',
    channelProbeState:'状态', channelProbeProgress:'进度', channelProbeCoverage:'覆盖率',
    channelProbeChannels:'频道数', channelProbeDuration:'耗时', channelProbeFinished:'完成时间',
    channelProbeStarted:'测速已启动', channelProbeDisabledFirst:'请先启用测速', channelProbeAlreadyRunning:'已在运行',
    channelProbeCfOnly:'仅 Node/Docker 支持频道级测速',
    liveStrategyTitle:'直播输出策略', liveToggleTitle:'直播功能', liveToggleLabel:'禁用直播聚合（跳过直播合并，输出空 lives）',
    liveStrategyDisabledHint:'直播聚合已禁用；重新启用前，下面的忽略直播源和合并模式选项不会生效。',
    ignoreAggregatedLivesTitle:'忽略配置中的直播源', ignoreAggregatedLivesLabel:'忽略第三方订阅配置自带的直播源（仅保留手动添加的直播源）',
    liveMergeModeTitle:'直播合并模式', liveMergeSeparated:'分离模式（按源分类）', liveMergeMerged:'合并模式（去重混合）', liveMergeModeDesc:'分离模式：每个直播源独立展示，用源名前缀区分。合并模式：所有源的频道按名称去重合并为统一列表。',
    smartBaseUrlTitle:'智能地址响应', smartBaseUrlLabel:'根据客户端访问地址自动生成资源链接（仅局域网，设置 DMZ=0 允许公网）',
    siteProbeTitle:'站点内容验活与自动清理', probeDepthLabel:'验活深度：',
    probeDeep:'深度（验证内容有效性）', probeShallow:'浅层（仅 HTTP 可达）',
    autoCleanLabel:'连续失败 5 次自动屏蔽（每次最多 5 个）',
    siteProbeDesc:'深度模式会检查 type0/type1 站点是否返回有效内容。连续失败 3 次的站点会被标记 [⚠]。',
    credentialDistributionTitle:'凭证分发与客户端鉴权',
    credentialDistributionDesc:'先设置根链接默认可分发的凭证，再按需创建一个或多个鉴权码。鉴权码只放在 URL 路径中，应用端直接输入普通的 /auth/<鉴权码>/ 链接，不需要在链接后追加查询参数。不下发凭证时，应用端仍可自行扫码登录网盘。',
    credentialDefaultPolicy:'根链接默认凭证策略',
    credentialModeNone:'不下发凭证',
    credentialModeAll:'下发全部已保存凭证',
    credentialModeSelected:'仅下发选中平台',
    credentialRequireAuth:'强制鉴权（根链接返回 401）',
    credentialStripUpstreamEntries:'不下发凭证时同时移除上游自带网盘登录入口',
    credentialPolicyHint:'根链接策略仅在未启用强制鉴权时生效；下面每个鉴权码都能独立设置“不下发 / 全部下发 / 选择平台下发”。选择“仅下发选中平台”但未勾选任何平台时，等同于不下发任何凭证。',
    credentialAuthCodes:'客户端鉴权码',
    credentialAuthCodesDesc:'可给不同应用端或用户组分别建码。应用端填写卡片上生成的 /auth/<鉴权码>/ 链接，该链接的凭证策略与根链接互不影响。',
    credentialAddCode:'+ 添加鉴权码',
    credentialNoCodes:'还没有鉴权码；根链接将使用上面的默认策略。',
    credentialCodeLabel:'名称 / 备注',
    credentialCodeValue:'鉴权码',
    credentialCodeMode:'凭证策略',
    credentialCodeEnabled:'启用',
    credentialCopyRoot:'复制根链接',
    credentialCopyAuth:'复制鉴权链接',
    credentialDelete:'删除',
    credentialSaved:'凭证分发与鉴权码已保存',
    credentialRootRequired:'启用强制鉴权前，至少需要保留一个启用的鉴权码。',
    credentialCodeInvalid:'鉴权码需为 1-64 位字母、数字、下划线或连字符。',
    credentialSelectedSummary:'已选',
    credentialSelectedEmptyShort:'已选：无（不下发凭证）',
    credentialSelectedEmpty:'未勾选任何平台，此鉴权码不会下发任何凭证；应用端仍可自行扫码登录。',
    credentialRootLinkHint:'根链接状态',
    credentialCopied:'已复制',
    credentialDefaultLabel:'默认客户端',
    cloudLoginDesc:'在这里登录一次即可，已保存凭证可在“设置”页选择是否下发。未下发的平台，应用端仍可自行扫码登录。',
    cloudManualPasteHelp:'<strong>💡 手动配置指引：</strong><br>' +
      '• <strong>天翼云盘</strong>：扫码容易失效。用手机浏览器登录 <a href="https://h5.cloud.189.cn" target="_blank" style="color:var(--accent)">h5.cloud.189.cn</a>，复制 Cookie 请求头值，在上方选择“天翼云盘”后粘贴。<br>' +
      '• <strong>123网盘</strong>：第三方扫码登录受限。请在 123网盘官网“工具中心 → 第三方挂载”生成 WebDAV 授权密码，在上方选择“123 网盘”后粘贴。',
    credentialSecurityHint:'安全提示：带鉴权码的链接能够取得所选择的凭证。请使用 HTTPS，不要公开鉴权链接；如链接泄露，立即删除或停用对应鉴权码。',
    footer:'TVBox 源聚合器 &middot; 管理控制台',
  }
};

function t(key) { const l = getLang(); return translations[l]?.[key] || translations.en[key] || key; }

function doToggleLang() {
  const next = getLang() === 'zh' ? 'en' : 'zh';
  localStorage.setItem('lang', next);
  applyLang(translations, next);
  loadAll();
  updateLiveStrategyState();
}

// --- Auth ---
const auth = initAuth('loginInput', 'loginError', 'loginOverlay', 'mainContent', '/admin/sources', loadAll);

// --- Tab switching / lazy loading ---
const tabLoaders = {
  sources: async () => { await loadSourceHealth(); await Promise.all([loadSources(), loadStatus()]); },
  maccms: () => loadMacCMS(),
  live: () => Promise.all([loadLives(), loadLiveDisabled(), loadLiveMergeMode(), loadIgnoreAggregatedLives(), loadChannelProbe()]),
  searchQuota: () => Promise.all([loadSearchQuota(), loadQualityReport()]),
  cloud: () => loadCloudCredentials(),
  settings: () => Promise.all([loadCredentialDistribution(), loadNameTransform(), loadBgSettings(), loadCronInterval(), loadSpeedTest(), loadEdgeProxies(), loadDedupConfig(), loadGroupOrder(), loadStorageDiagnostics(), loadSmartBaseUrl(), loadProbeDepth(), loadAutoClean()]),
  aggLogs: () => loadAggLogs(),
};
const loadedTabs = new Set();
const loadingTabs = new Map();

async function ensureTabLoaded(tab) {
  if (loadedTabs.has(tab)) return;
  if (loadingTabs.has(tab)) return loadingTabs.get(tab);
  const loader = tabLoaders[tab];
  if (!loader) return;
  const promise = Promise.resolve()
    .then(loader)
    .then(() => { loadedTabs.add(tab); })
    .catch(err => console.warn('[admin] failed to load tab:', tab, err))
    .finally(() => { loadingTabs.delete(tab); });
  loadingTabs.set(tab, promise);
  return promise;
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => {
    const id = 'panel' + tab.charAt(0).toUpperCase() + tab.slice(1);
    p.classList.toggle('active', p.id === id);
  });
  ensureTabLoaded(tab);
}

// --- Source health ---
let healthMap = {};

async function loadSourceHealth() {
  try {
    const res = await fetch('/source-status');
    const records = await res.json();
    healthMap = {};
    records.forEach(r => { healthMap[r.url] = r; });
  } catch {
    healthMap = {};
  }
}

// --- Load data ---
function loadAll() {
  // Render the admin shell immediately; all other tabs are fetched on first access.
  loadedTabs.clear();
  loadingTabs.clear();
  return ensureTabLoaded('sources');
}

async function loadStatus() {
  try {
    const res = await fetch('/status-data');
    const d = await res.json();
    const stats = d.sites + ' sites, ' + d.parses + ' parses, ' + d.lives + ' lives' + (d.liveSourceCount ? ', ' + d.liveSourceCount + ' live sources' : '') + (d.dirty ? ' | pending refresh' : '');
    const dateValue = d.lastUpdate && d.lastUpdate !== 'never' ? new Date(d.lastUpdate) : null;
    if (dateValue && !Number.isNaN(dateValue.getTime())) {
      const fmt = dateValue.toLocaleString('zh-CN', {
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit',
        hour12: false
      });
      $('aggStatus').textContent = t('lastUpdate') + fmt + ' | ' + stats;
      $('aggStatus').className = 'status-text';
    } else {
      $('aggStatus').textContent = t('neverUpdated') + ' | ' + stats + (d.lastUpdateError ? ' | ' + t('updateFailed') + d.lastUpdateError : '');
      $('aggStatus').className = 'status-text error';
    }
  } catch {
    $('aggStatus').textContent = t('failedLoadStatus');
    $('aggStatus').className = 'status-text error';
  }
}

async function loadSources() {
  const list = $('sourceList');
  try {
    const res = await auth.authFetch('/admin/sources');
    const sources = await res.json();
    $('sourceCount').textContent = sources.length;
    $('badgeSources').textContent = sources.length;

    if (sources.length === 0) {
      list.innerHTML = '<div class="empty">' + t('noSources') + '</div>';
      return;
    }

    list.innerHTML = sources.map(s => {
      const h = healthMap[s.url];
      const level = s.disabled ? 'disabled' : (!h ? 'unknown'
        : h.consecutiveFailures >= 5 ? 'error'
        : h.consecutiveFailures >= 3 ? 'warn' : 'ok');
      const tip = s.disabled ? t('disabledStatus') : (!h ? t('noHealthData')
        : h.latestStatus + ' | ' + t('healthFails') + ': ' + h.consecutiveFailures +
          (h.lastSuccessTime ? ' | ' + t('healthLastOk') + ': ' + new Date(h.lastSuccessTime).toLocaleString() : ''));

      return \`<div class="source-item" \${s.disabled ? 'style="opacity:0.6"' : ''}>
        <span class="source-health-dot \${level}" data-tooltip="\${esc(tip)}"></span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name || 'Unnamed')}\${s.configKey ? ' 🔑' : ''}</div>
          <div class="source-url">\${esc(s.url)}</div>
        </div>
        <div class="source-actions" style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="toggleSource('\${esc(s.url)}', \${!s.disabled})">\${s.disabled ? t('enable') : t('disable')}</button>
          <button class="btn btn-sm" onclick="startEditSource('\${esc(s.name || \'\')}', '\${esc(s.url)}', '\${esc(s.configKey || \'\')}')">\${t('edit')}</button>
          <button class="btn btn-sm btn-danger" onclick="removeSource('\${esc(s.url)}')">\${t('remove')}</button>
        </div>
      </div>\`;
    }).join('');
  } catch {
    list.innerHTML = '<div class="empty">' + t('failedLoad') + '</div>';
  }
}

async function toggleSource(url, disabled) {
  try {
    const res = await auth.authFetch('/admin/sources/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, disabled })
    });
    if (res.ok) {
      toast(disabled ? t('sourceDisabled') : t('sourceEnabled'));
      loadSources();
    } else {
      const d = await res.json();
      toast(d.error || 'Failed', 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }
}

let editingOldUrl = null;

function startEditSource(name, url, configKey) {
  editingOldUrl = url;
  $('addName').value = name;
  $('addUrl').value = url;
  $('addConfigKey').value = configKey;

  const titleEl = $('sourceFormTitle');
  if (titleEl) {
    titleEl.dataset.i18n = 'editSource';
    titleEl.textContent = t('editSource');
  }

  const buttonsEl = $('sourceFormButtons');
  if (buttonsEl) {
    buttonsEl.innerHTML = '<button class="btn" id="addBtn" onclick="addSource()" data-i18n="save">' + t('save') + '</button> ' +
      '<button class="btn secondary" onclick="cancelEditSource()" data-i18n="cancel">' + t('cancel') + '</button>';
  }
  $('addName').focus();
}

function cancelEditSource() {
  editingOldUrl = null;
  $('addName').value = '';
  $('addUrl').value = '';
  $('addConfigKey').value = '';

  const titleEl = $('sourceFormTitle');
  if (titleEl) {
    titleEl.dataset.i18n = 'addSource';
    titleEl.textContent = t('addSource');
  }

  const buttonsEl = $('sourceFormButtons');
  if (buttonsEl) {
    buttonsEl.innerHTML = '<button class="btn" id="addBtn" onclick="addSource()" data-i18n="add">' + t('add') + '</button>';
  }
}

// --- Add source ---
async function addSource() {
  const url = $('addUrl').value.trim();
  if (!url) { $('addUrl').focus(); return; }
  const name = $('addName').value.trim() || '';
  const configKey = $('addConfigKey').value.trim() || '';

  const btn = $('addBtn');
  const isEdit = editingOldUrl !== null;
  btn.textContent = isEdit ? t('updating') : t('adding');
  btn.className = 'btn loading';

  try {
    const payload = isEdit ? { oldUrl: editingOldUrl, name, url } : { name, url };
    if (configKey) payload.configKey = configKey;
    const res = await auth.authFetch('/admin/sources', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (res.ok) {
      toast(isEdit ? t('sourceUpdated') : t('sourceAdded'));
      if (isEdit) {
        cancelEditSource();
      } else {
        $('addUrl').value = '';
        $('addName').value = '';
        $('addConfigKey').value = '';
      }
      loadSources();
    } else {
      toast(d.error || (isEdit ? t('saveFailed') : t('failedLoad')), 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }

  const finalBtn = $('addBtn');
  if (finalBtn) {
    finalBtn.textContent = editingOldUrl !== null ? t('save') : t('add');
    finalBtn.className = 'btn';
  }
}

// --- Remove source ---
async function removeSource(url) {
  try {
    const res = await auth.authFetch('/admin/sources', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (res.ok) {
      toast(t('sourceRemoved'));
      loadSources();
    } else {
      const d = await res.json();
      toast(d.error || t('remove'), 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }
}

// --- MacCMS ---
async function loadMacCMS() {
  const list = $('mcList');
  try {
    const res = await auth.authFetch('/admin/maccms');
    const sources = await res.json();
    $('mcCount').textContent = sources.length;
    $('badgeMacCMS').textContent = sources.length;

    if (sources.length === 0) {
      list.innerHTML = '<div class="empty">' + t('noMacCMS') + '</div>';
      return;
    }

    list.innerHTML = sources.map(s => \`
      <div class="source-item" \${s.disabled ? 'style="opacity:0.6"' : ''}>
        <span class="source-tag manual">\${esc(s.key)}</span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name)}</div>
          <div class="source-url">\${esc(s.api)}</div>
        </div>
        <div class="source-actions" style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="toggleMC('\${esc(s.key)}', \${!s.disabled})">\${s.disabled ? t('enable') : t('disable')}</button>
          <button class="btn btn-sm" onclick="startEditMC('\${esc(s.key)}', '\${esc(s.name)}', '\${esc(s.api)}')">\${t('edit')}</button>
          <button class="btn btn-sm" onclick="validateMC('\${esc(s.api)}')">\${t('test')}</button>
          <button class="btn btn-sm btn-danger" onclick="removeMC('\${esc(s.key)}')">\${t('remove')}</button>
        </div>
      </div>
    \`).join('');
  } catch {
    list.innerHTML = '<div class="empty">' + t('failedLoadMacCMS') + '</div>';
  }
}

async function toggleMC(key, disabled) {
  try {
    const res = await auth.authFetch('/admin/maccms/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, disabled })
    });
    if (res.ok) {
      toast(disabled ? t('sourceDisabled') : t('sourceEnabled'));
      loadMacCMS();
    } else {
      const d = await res.json();
      toast(d.error || 'Failed', 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }
}

let editingMCOldKey = null;

function startEditMC(key, name, api) {
  editingMCOldKey = key;
  $('mcKey').value = key;
  $('mcName').value = name;
  $('mcApi').value = api;

  const titleEl = $('mcFormTitle');
  if (titleEl) {
    titleEl.dataset.i18n = 'editMacCMS';
    titleEl.textContent = t('editMacCMS');
  }

  const buttonsEl = $('mcFormButtons');
  if (buttonsEl) {
    buttonsEl.innerHTML = '<button class="btn" id="mcAddBtn" onclick="addMacCMS()" data-i18n="save">' + t('save') + '</button> ' +
      '<button class="btn secondary" onclick="cancelEditMC()" data-i18n="cancel">' + t('cancel') + '</button>';
  }
  $('mcKey').focus();
}

function cancelEditMC() {
  editingMCOldKey = null;
  $('mcKey').value = '';
  $('mcName').value = '';
  $('mcApi').value = '';

  const titleEl = $('mcFormTitle');
  if (titleEl) {
    titleEl.dataset.i18n = 'addMacCMS';
    titleEl.textContent = t('addMacCMS');
  }

  const buttonsEl = $('mcFormButtons');
  if (buttonsEl) {
    buttonsEl.innerHTML = '<button class="btn" id="mcAddBtn" onclick="addMacCMS()" data-i18n="add">' + t('add') + '</button>';
  }
}

// --- Add MacCMS ---
async function addMacCMS() {
  const key = $('mcKey').value.trim();
  const name = $('mcName').value.trim();
  const api = $('mcApi').value.trim();
  if (!key || !name || !api) { toast(t('allFieldsRequired'), 'error'); return; }

  const btn = $('mcAddBtn');
  const isEdit = editingMCOldKey !== null;
  btn.textContent = isEdit ? t('updating') : t('adding');
  btn.className = 'btn loading';

  try {
    const payload = isEdit ? { oldKey: editingMCOldKey, key, name, api } : { key, name, api };
    const res = await auth.authFetch('/admin/maccms', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (res.ok) {
      toast(isEdit ? t('macCMSSourceUpdated') : 'Added ' + (d.added || 1) + ' MacCMS source(s)');
      if (isEdit) {
        cancelEditMC();
      } else {
        $('mcKey').value = '';
        $('mcName').value = '';
        $('mcApi').value = '';
      }
      loadMacCMS();
    } else {
      toast(d.error || (isEdit ? t('saveFailed') : 'Failed'), 'error');
    }
  } catch { toast(t('networkError'), 'error'); }

  const finalBtn = $('mcAddBtn');
  if (finalBtn) {
    finalBtn.textContent = editingMCOldKey !== null ? t('save') : t('add');
    finalBtn.className = 'btn';
  }
}

async function removeMC(key) {
  try {
    const res = await auth.authFetch('/admin/maccms', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    if (res.ok) { toast('Removed'); loadMacCMS(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch { toast(t('networkError'), 'error'); }
}

async function validateMC(api) {
  toast(t('testing'));
  try {
    const res = await auth.authFetch('/admin/maccms/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api })
    });
    const d = await res.json();
    toast(d.valid ? t('valid') : t('invalidUnreachable'), d.valid ? 'success' : 'error');
  } catch { toast(t('networkError'), 'error'); }
}

async function batchImportMacCMS() {
  const input = $('mcBatchInput').value.trim();
  if (!input) { $('mcBatchInput').focus(); return; }

  const btn = $('mcBatchBtn');
  const result = $('mcBatchResult');
  btn.textContent = t('importing');
  btn.className = 'btn btn-sm loading';
  result.textContent = '';

  try {
    const res = await auth.authFetch('/admin/maccms/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mode: 'merge' })
    });
    const d = await res.json();
    if (res.ok) {
      result.textContent = d.added + ' ' + t('importAdded') + (d.duplicates > 0 ? ', ' + d.duplicates + ' ' + t('importDuplicates') : '') + (Array.isArray(d.invalid) && d.invalid.length > 0 ? ', ' + d.invalid.length + ' ' + t('importInvalid') : '');
      result.className = 'status-text success';
      if (d.added > 0) {
        $('mcBatchInput').value = '';
        loadMacCMS();
      }
    } else {
      result.textContent = d.error || t('importFailed');
      result.className = 'status-text error';
    }
  } catch {
    result.textContent = t('networkError');
    result.className = 'status-text error';
  }

  btn.textContent = t('submitBatch');
  btn.className = 'btn btn-sm';
}

async function exportMacCMS() {
  const btn = $('mcExportBtn');
  const result = $('mcBatchResult');
  btn.textContent = t('exporting');
  btn.className = 'btn btn-sm loading';
  result.textContent = '';

  try {
    const res = await auth.authFetch('/admin/maccms/export');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('exportFailed'));
    const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : null);
    if (!items) throw new Error(t('exportFailed'));
    downloadJson(exportFilename('maccms-sources'), Array.isArray(data) ? data : data);
    result.textContent = t('exported') + ' (' + items.length + ')';
    result.className = 'status-text success';
  } catch (err) {
    const message = err instanceof Error ? err.message : t('exportFailed');
    result.textContent = message;
    result.className = 'status-text error';
  }

  btn.textContent = t('export');
  btn.className = 'btn btn-sm';
}

// --- Live Sources ---
async function loadLives() {
  const list = $('liveList');
  try {
    const res = await auth.authFetch('/admin/lives');
    const entries = await res.json();
    $('liveCount').textContent = entries.length;
    $('badgeLive').textContent = entries.length;

    if (entries.length === 0) {
      list.innerHTML = '<div class="empty">' + t('noLives') + '</div>';
      return;
    }

    list.innerHTML = entries.map(s => \`
      <div class="source-item" \${s.disabled ? 'style="opacity:0.6"' : ''}>
        <span class="source-tag manual">LIVE</span>
        <div class="source-info">
          <div class="source-name">\${esc(s.name || 'Unnamed')}</div>
          <div class="source-url">\${esc(s.url)}</div>
        </div>
        <div class="source-actions" style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="toggleLive('\${esc(s.url)}', \${!s.disabled})">\${s.disabled ? t('enable') : t('disable')}</button>
          <button class="btn btn-sm" onclick="startEditLive('\${esc(s.name || \'\')}', '\${esc(s.url)}')">\${t('edit')}</button>
          <button class="btn btn-sm btn-danger" onclick="removeLive('\${esc(s.url)}')">\${t('remove')}</button>
        </div>
      </div>
    \`).join('');
  } catch {
    list.innerHTML = '<div class="empty">' + t('failedLoadLives') + '</div>';
  }
}

async function toggleLive(url, disabled) {
  try {
    const res = await auth.authFetch('/admin/lives/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, disabled })
    });
    if (res.ok) {
      toast(disabled ? t('sourceDisabled') : t('sourceEnabled'));
      loadLives();
    } else {
      const d = await res.json();
      toast(d.error || 'Failed', 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }
}

let editingLiveOldUrl = null;

function startEditLive(name, url) {
  editingLiveOldUrl = url;
  $('liveName').value = name;
  $('liveUrl').value = url;

  const titleEl = $('liveFormTitle');
  if (titleEl) {
    titleEl.dataset.i18n = 'editLiveSource';
    titleEl.textContent = t('editLiveSource');
  }

  const buttonsEl = $('liveFormButtons');
  if (buttonsEl) {
    buttonsEl.innerHTML = '<button class="btn" id="liveAddBtn" onclick="addLive()" data-i18n="save">' + t('save') + '</button> ' +
      '<button class="btn secondary" onclick="cancelEditLive()" data-i18n="cancel">' + t('cancel') + '</button>';
  }
  $('liveName').focus();
}

function cancelEditLive() {
  editingLiveOldUrl = null;
  $('liveName').value = '';
  $('liveUrl').value = '';

  const titleEl = $('liveFormTitle');
  if (titleEl) {
    titleEl.dataset.i18n = 'addLiveSource';
    titleEl.textContent = t('addLiveSource');
  }

  const buttonsEl = $('liveFormButtons');
  if (buttonsEl) {
    buttonsEl.innerHTML = '<button class="btn" id="liveAddBtn" onclick="addLive()" data-i18n="add">' + t('add') + '</button>';
  }
}

// --- Add live source ---
async function addLive() {
  const url = $('liveUrl').value.trim();
  if (!url) { $('liveUrl').focus(); return; }
  const name = $('liveName').value.trim() || '';

  const btn = $('liveAddBtn');
  const isEdit = editingLiveOldUrl !== null;
  btn.textContent = isEdit ? t('updating') : t('adding');
  btn.className = 'btn loading';

  try {
    const payload = isEdit ? { oldUrl: editingLiveOldUrl, name, url } : { name, url };
    const res = await auth.authFetch('/admin/lives', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (res.ok) {
      toast(isEdit ? t('liveSourceUpdated') : t('liveSourceAdded'));
      if (isEdit) {
        cancelEditLive();
      } else {
        $('liveUrl').value = '';
        $('liveName').value = '';
      }
      loadLives();
    } else {
      toast(d.error || (isEdit ? t('saveFailed') : 'Failed to add'), 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  }

  const finalBtn = $('liveAddBtn');
  if (finalBtn) {
    finalBtn.textContent = editingLiveOldUrl !== null ? t('save') : t('add');
    finalBtn.className = 'btn';
  }
}

async function removeLive(url) {
  try {
    const res = await auth.authFetch('/admin/lives', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (res.ok) { toast(t('removed')); loadLives(); }
    else { const d = await res.json(); toast(d.error || 'Failed', 'error'); }
  } catch { toast(t('networkError'), 'error'); }
}

// --- Import Config ---
async function importConfig() {
  const input = $('importInput').value.trim();
  if (!input) { $('importInput').focus(); return; }

  const btn = $('importBtn');
  const result = $('importResult');
  btn.textContent = t('importing');
  btn.className = 'btn btn-sm loading';
  result.textContent = '';

  try {
    const res = await auth.authFetch('/admin/sources/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mode: 'merge' })
    });
    const d = await res.json();
    if (res.ok) {
      const typeLabel = d.type === 'multi' ? t('importMulti') : d.type === 'list' || d.type === 'backup' ? t('importConfig') : t('importSingle');
      result.textContent = typeLabel + ': ' + d.added + ' ' + t('importAdded') + (d.duplicates > 0 ? ', ' + d.duplicates + ' ' + t('importDuplicates') : '') + (Array.isArray(d.invalid) && d.invalid.length > 0 ? ', ' + d.invalid.length + ' ' + t('importInvalid') : '');
      result.className = 'status-text success';
      if (d.added > 0) {
        $('importInput').value = '';
        loadSources();
      }
    } else {
      result.textContent = d.error || t('importParseFailed');
      result.className = 'status-text error';
    }
  } catch {
    result.textContent = t('networkError');
    result.className = 'status-text error';
  }

  btn.textContent = t('import');
  btn.className = 'btn btn-sm';
}

// --- Restore Config (replace mode) ---
function loadRestoreFile(input) {
  const file = input && input.files && input.files[0];
  const nameEl = $('restoreFileName');
  const result = $('importResult');
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('importInput').value = typeof reader.result === 'string' ? reader.result : '';
    if (nameEl) nameEl.textContent = t('restoreFileLoaded') + ' ' + file.name;
    result.textContent = '';
    result.className = 'status-text';
  };
  reader.onerror = () => {
    if (nameEl) nameEl.textContent = '';
    result.textContent = t('restoreFailed');
    result.className = 'status-text error';
  };
  reader.readAsText(file, 'utf-8');
  input.value = '';
}

async function restoreSources() {
  const input = $('importInput').value.trim();
  if (!input) { $('importInput').focus(); return; }
  let parsed;
  try { parsed = JSON.parse(input); } catch {
    $('importResult').textContent = t('restoreInvalidJson');
    $('importResult').className = 'status-text error';
    return;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'tvbox-sources' || !Array.isArray(parsed.items)) {
    $('importResult').textContent = t('restoreInvalidJson');
    $('importResult').className = 'status-text error';
    return;
  }
  if (!window.confirm(t('restoreBackupConfirm'))) return;
  const btn = $('restoreBtn');
  const result = $('importResult');
  btn.textContent = t('restoring');
  btn.className = 'btn btn-sm loading';
  result.textContent = '';
  result.className = 'status-text';
  try {
    const res = await auth.authFetch('/admin/sources/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mode: 'replace' })
    });
    const d = await res.json();
    if (res.ok) {
      result.textContent = t('restored') + ': ' + d.added + ' ' + t('importAdded') + (d.duplicates > 0 ? ', ' + d.duplicates + ' ' + t('importDuplicates') : '') + (Array.isArray(d.invalid) && d.invalid.length > 0 ? ', ' + d.invalid.length + ' ' + t('importInvalid') : '');
      result.className = 'status-text success';
      $('importInput').value = '';
      const nameEl = $('restoreFileName');
      if (nameEl) nameEl.textContent = '';
      await loadSources();
      await loadSourceHealth();
      toast(t('restored'));
    } else {
      result.textContent = d.error || t('restoreFailed');
      result.className = 'status-text error';
    }
  } catch {
    result.textContent = t('networkError');
    result.className = 'status-text error';
  }
  btn.textContent = t('restoreBackup');
  btn.className = 'btn btn-sm';
}

// --- Import / Export helpers ---
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFilename(prefix) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate());
  return prefix + '-' + stamp + '.json';
}

async function exportConfig() {
  const btn = $('exportBtn');
  const result = $('importResult');
  if (btn) {
    btn.textContent = t('exporting');
    btn.className = 'btn btn-sm loading';
  }
  if (result) result.textContent = '';

  try {
    const res = await auth.authFetch('/admin/sources/export');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('exportFailed'));
    const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : null);
    if (!items) throw new Error(t('exportFailed'));
    downloadJson(exportFilename('tvbox-sources'), Array.isArray(data) ? data : data);
    if (result) {
      result.textContent = t('exported') + ' (' + items.length + ')';
      result.className = 'status-text success';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : t('exportFailed');
    if (result) {
      result.textContent = message;
      result.className = 'status-text error';
    }
  }

  if (btn) {
    btn.textContent = t('export');
    btn.className = 'btn btn-sm';
  }
}

async function importLives() {
  const input = $('liveImportInput').value.trim();
  if (!input) { $('liveImportInput').focus(); return; }

  const btn = $('liveImportBtn');
  const result = $('liveImportResult');
  btn.textContent = t('liveImporting');
  btn.className = 'btn btn-sm loading';
  result.textContent = '';

  try {
    const res = await auth.authFetch('/admin/lives/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mode: 'merge' })
    });
    const d = await res.json();
    if (res.ok) {
      result.textContent = d.added + ' ' + t('importAdded') + (d.duplicates > 0 ? ', ' + d.duplicates + ' ' + t('liveImportDuplicates') : '') + (Array.isArray(d.invalid) && d.invalid.length > 0 ? ', ' + d.invalid.length + ' ' + t('importInvalid') : '');
      result.className = 'status-text success';
      if (d.added > 0) {
        $('liveImportInput').value = '';
        loadLives();
      }
    } else {
      result.textContent = d.error || t('liveImportParseFailed');
      result.className = 'status-text error';
    }
  } catch {
    result.textContent = t('networkError');
    result.className = 'status-text error';
  }

  btn.textContent = t('liveImport');
  btn.className = 'btn btn-sm';
}

async function exportLives() {
  const btn = $('liveExportBtn');
  const result = $('liveImportResult');
  btn.textContent = t('exporting');
  btn.className = 'btn btn-sm loading';
  result.textContent = '';

  try {
    const res = await auth.authFetch('/admin/lives/export');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('exportFailed'));
    const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : null);
    if (!items) throw new Error(t('exportFailed'));
    downloadJson(exportFilename('live-sources'), Array.isArray(data) ? data : data);
    result.textContent = t('exported') + ' (' + items.length + ')';
    result.className = 'status-text success';
  } catch (err) {
    const message = err instanceof Error ? err.message : t('exportFailed');
    result.textContent = message;
    result.className = 'status-text error';
  }

  btn.textContent = t('liveExport');
  btn.className = 'btn btn-sm';
}

// --- Storage Diagnostics ---
function fmtStorageTime(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}
async function loadStorageDiagnostics() {
  const box = $('storageDiagnostics');
  if (!box) return;
  box.textContent = t('loading');
  try {
    const res = await auth.authFetch('/admin/storage-diagnostics');
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || t('failedLoadStatus'));
    const lines = [];
    lines.push(t('storageMode') + ': ' + (d.mode || 'direct'));
    lines.push(t('storageRemoteConfigured') + ': ' + (d.remoteConfigured ? t('yes') : t('no')));
    if (d.namespace) lines.push(t('storageNamespace') + ': ' + String(d.namespace));
    if (d.remoteTimeoutMs) lines.push(t('storageRemoteTimeout') + ': ' + String(d.remoteTimeoutMs) + ' ms');
    lines.push(t('storageLastRead') + ': ' + fmtStorageTime(d.lastRemoteReadAt));
    lines.push(t('storageLastWrite') + ': ' + fmtStorageTime(d.lastRemoteWriteAt));
    lines.push(t('storagePendingWrites') + ': ' + String(d.pendingWrites ?? 0));
    lines.push(t('storageCoolingDown') + ': ' + (d.remoteCoolingDown ? t('yes') : t('no')));
    if (d.skippedLocalOnlyWrites !== undefined) lines.push(t('storageSkippedLocalWrites') + ': ' + String(d.skippedLocalOnlyWrites));
    if (d.lastSkippedLocalOnlyKey) lines.push(t('storageLastSkippedKey') + ': ' + String(d.lastSkippedLocalOnlyKey));
    if (d.lastRemoteError) lines.push(t('storageLastError') + ': ' + String(d.lastRemoteError));
    box.textContent = lines.join(String.fromCharCode(10));
    box.className = d.lastRemoteError || d.remoteCoolingDown ? 'status-text error' : '';
  } catch (err) {
    box.textContent = (err && err.message) ? err.message : t('failedLoadStatus');
    box.className = 'status-text error';
  }
}
// --- Name Transform ---
async function loadNameTransform() {
  try {
    const res = await auth.authFetch('/admin/name-transform');
    if (!res.ok) return;
    const d = await res.json();
    $('ntPrefix').value = d.prefix || '';
    $('ntSuffix').value = d.suffix || '';
    $('ntPromoReplace').value = d.promoReplacement || '';
    $('ntExtraPatterns').value = (d.extraCleanPatterns || []).join('\\n');
  } catch {}
}

async function saveNameTransform() {
  const btn = $('ntSaveBtn');
  const status = $('ntStatus');
  btn.textContent = t('saving');
  btn.className = 'btn loading';
  status.textContent = '';

  const extraRaw = $('ntExtraPatterns').value.trim();
  const extraCleanPatterns = extraRaw ? extraRaw.split('\\n').map(s => s.trim()).filter(Boolean) : [];

  try {
    const res = await auth.authFetch('/admin/name-transform', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix: $('ntPrefix').value || '',
        suffix: $('ntSuffix').value || '',
        promoReplacement: $('ntPromoReplace').value || '',
        extraCleanPatterns
      })
    });
    const d = await res.json();
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      status.textContent = d.error || t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }

  btn.textContent = t('save');
  btn.className = 'btn';
  setTimeout(() => { status.textContent = ''; }, 3000);
}

// --- Cron Interval ---
async function loadCronInterval() {
  try {
    const res = await auth.authFetch('/admin/cron-interval');
    if (!res.ok) return;
    const d = await res.json();
    $('cronSelect').value = String(d.interval || 1440);
  } catch {}
}

async function saveCronInterval() {
  const btn = $('cronSaveBtn');
  const status = $('cronStatus');
  btn.textContent = t('saving');
  btn.className = 'btn btn-sm loading';
  status.textContent = '';

  try {
    const res = await auth.authFetch('/admin/cron-interval', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval: parseInt($('cronSelect').value) })
    });
    const d = await res.json();
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      status.textContent = d.error || t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }

  btn.textContent = t('save');
  btn.className = 'btn btn-sm';
  setTimeout(() => { status.textContent = ''; }, 3000);
}

// --- Speed Test Toggle ---
async function loadSpeedTest() {
  try {
    const res = await auth.authFetch('/admin/speed-test');
    if (res.ok) {
      const d = await res.json();
      $('speedTestCheck').checked = d.enabled;
    }
  } catch {}
}

async function saveSpeedTest() {
  const status = $('speedTestStatus');
  const enabled = $('speedTestCheck').checked;
  status.textContent = '';

  try {
    const res = await auth.authFetch('/admin/speed-test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      const d = await res.json();
      status.textContent = d.error || t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }

  setTimeout(() => { status.textContent = ''; }, 3000);
}

// --- Channel Probe (Node/Docker) ---
async function loadChannelProbe() {
  const box = $('channelProbeStatus');
  try {
    const res = await auth.authFetch('/admin/channel-probe/status');
    if (res.status === 404) {
      $('channelProbeSection').style.display = 'none';
      return;
    }
    if (!res.ok) {
      box.textContent = t('channelProbeCfOnly');
      return;
    }
    const d = await res.json();
    $('channelProbeCheck').checked = !!d.enabled;
    const s = d.status || {};
    const stateLabel = { idle: t('channelProbeIdle'), running: t('channelProbeRunning'), done: t('channelProbeDone'), error: t('channelProbeError') }[s.state] || s.state || '-';
    const lines = [];
    lines.push(t('channelProbeState') + ': ' + stateLabel + (d.running ? ' ⏳' : ''));
    if (s.totalUrls) {
      lines.push(t('channelProbeProgress') + ': ' + (s.probed || 0) + ' / ' + s.totalUrls + ' | ' + t('channelProbeCoverage') + ': ' + (s.coverage || 0) + '% | ' + t('channelProbeChannels') + ': ' + (s.totalChannels || 0));
    }
    if (s.durationMs) {
      lines.push(t('channelProbeDuration') + ': ' + (s.durationMs / 1000).toFixed(1) + 's');
    }
    if (s.finishedAt) {
      lines.push(t('channelProbeFinished') + ': ' + new Date(s.finishedAt).toLocaleString());
    }
    if (s.error) {
      lines.push('⚠️ ' + s.error);
    }
    box.innerHTML = lines.map(l => '<div>' + l.replace(/</g,'&lt;') + '</div>').join('');
  } catch {
    box.textContent = t('networkError');
  }
}

async function toggleChannelProbe() {
  const enabled = $('channelProbeCheck').checked;
  try {
    await auth.authFetch('/admin/channel-probe/toggle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    toast(t('saved'));
    loadChannelProbe();
  } catch {
    toast(t('networkError'), 'error');
  }
}

async function triggerChannelProbe() {
  const btn = $('channelProbeTriggerBtn');
  btn.disabled = true;
  try {
    const res = await auth.authFetch('/admin/channel-probe/trigger', { method: 'POST' });
    const d = await res.json();
    if (res.ok) {
      toast(t('channelProbeStarted'));
      setTimeout(loadChannelProbe, 500);
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch {
    toast(t('networkError'), 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Edge Proxies ---
async function loadEdgeProxies() {
  try {
    const res = await auth.authFetch('/admin/edge-proxies');
    if (res.ok) {
      const d = await res.json();
      $('edgeCfUrl').value = d.cf || '';
      $('edgeVercelUrl').value = d.vercel || '';
    }
  } catch {}
}

async function saveEdgeProxies() {
  const status = $('edgeProxiesStatus');
  try {
    const res = await auth.authFetch('/admin/edge-proxies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cf: $('edgeCfUrl').value.trim(), vercel: $('edgeVercelUrl').value.trim() })
    });
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      status.textContent = t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
}


// --- Search Quota ---
let sqPinnedKeys = new Set();
let sqBlockedKeys = new Set();

async function loadSearchQuota() {
  try {
    const res = await auth.authFetch('/admin/search-quota');
    if (!res.ok) return;
    const d = await res.json();
    $('maxSearchableInput').value = d.maxSearchable ?? 0;
    // 保留实际值再原样回传，避免后台只改其他字段时把快速搜索上限重置。
    $('maxQuickSearchInput').value = d.maxQuickSearch ?? 0;
    $('maxStartupQuickSearchInput').value = d.maxStartupQuickSearch ?? 0;
    $('startupSiteLimitInput').value = d.startupSiteLimit ?? 0;
    $('maxParsesInput').value = d.maxParses ?? 0;
    $('retainCredentialSourcesInput').checked = d.retainCredentialSources === true;
    $('autoSearchLimitInput').checked = false;
    $('sortSearchBySpeedInput').checked = true;
    $('leanStartupInput').checked = true;
    $('startupModeInput').value = 'lean';
    $('pruneDeadParsesInput').checked = true;
    sqPinnedKeys = new Set(d.pinnedKeys || []);
    sqBlockedKeys = new Set(d.blockedKeys || []);
    loadSearchQuotaReport();
  } catch {}
}
async function saveSearchQuota() {
  const status = $('searchQuotaStatus');
  status.textContent = '';
  const data = {
    maxSearchable: parseInt($('maxSearchableInput').value) || 0,
    maxQuickSearch: parseInt($('maxQuickSearchInput').value) || 0,
    maxStartupQuickSearch: parseInt($('maxStartupQuickSearchInput').value) || 0,
    startupSiteLimit: parseInt($('startupSiteLimitInput').value) || 0,
    maxParses: parseInt($('maxParsesInput').value) || 0,
    retainCredentialSources: $('retainCredentialSourcesInput').checked,
    autoLimit: false,
    sortBySpeed: true,
    leanStartup: true,
    startupMode: 'lean',
    pruneDeadParses: true,
    pinnedKeys: [...sqPinnedKeys],
    blockedKeys: [...sqBlockedKeys],
  };
  try {
    const res = await auth.authFetch('/admin/search-quota', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      status.textContent = t('saved');
      status.className = 'status-text success';
    } else {
      status.textContent = t('saveFailed');
      status.className = 'status-text error';
    }
  } catch {
    status.textContent = t('networkError');
    status.className = 'status-text error';
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
}

async function loadSearchQuotaReport() {
  try {
    const res = await auth.authFetch('/admin/search-quota/report');
    if (!res.ok) return;
    const d = await res.json();
    if (d.searchable == null) return;

    // 显示 Search 页签
    $('tabSearchQuota').style.display = '';
    $('sqSelectedInfo').textContent = d.totalSites + ' sites → ' + d.jsExcluded + ' JS excluded → ' + d.searchable + ' searchable' + (d.truncated > 0 ? ' (' + d.truncated + ' truncated)' : '') + (typeof d.quickSearchable === 'number' ? ', ' + d.quickSearchable + ' quick' + (d.quickTruncated > 0 ? ' (' + d.quickTruncated + ' limited)' : '') : '') + (d.pinnedCount > 0 ? ', ' + d.pinnedCount + ' pinned' : '') + (d.leanRemoved > 0 ? ', ' + d.leanRemoved + ' ' + t('sqLeanRemoved') : '') + (typeof d.parseRemoved === 'number' && d.parseRemoved > 0 ? ', ' + d.parseRemoved + ' dead parses pruned' : '') + (typeof d.parseKept === 'number' ? ', ' + d.parseKept + ' parsers kept' + (d.parseTruncated > 0 ? ' (' + d.parseTruncated + ' limited)' : '') : '') + (d.speedParsed ? ', speed-sorted' : d.speedSorted ? ', speed-sorted' : '');
    $('badgeSearchQuota').textContent = d.searchable;

    const q = d.qualityGrades;
    if (q) {
      const credentialReady = q.credentialReady || { count: 0, cumulative: 0 }; const untestableCount = q.untestable ? q.untestable.count : 0; const untestableCumulative = q.untestable ? q.untestable.cumulative : 0; const qualityText = t('sqQuality') + ': ' + t('sqExcellent') + ' ' + q.excellent.count + ' (' + q.excellent.cumulative + ') / ' + t('sqGood') + ' ' + q.good.count + ' (' + q.good.cumulative + ') / ' + t('sqUsable') + ' ' + q.usable.count + ' (' + q.usable.cumulative + ') / ' + t('sqCredentialReady') + ' ' + credentialReady.count + ' (' + credentialReady.cumulative + ') / ' + t('sqUntestable') + ' ' + untestableCount + ' (' + untestableCumulative + ') / ' + t('sqTimeout') + ' ' + q.timeout.count + ' (' + q.timeout.cumulative + ') / ' + t('sqUnusable') + ' ' + q.unusable.count + ' · ' + t('sqPoolTotal') + ': ' + q.poolTotal;
      $('sqQualityGrades').textContent = qualityText;
      const stats = $('searchQuotaStats');
      if (stats) {
        const quickCount = typeof d.quickSearchable === 'number' ? d.quickSearchable : 0;
        const quickLimit = typeof d.maxQuickSearch === 'number' && d.maxQuickSearch > 0 ? ' (' + t('sqStatsQuickLimit') + ' ' + d.maxQuickSearch + ')' : '';
        const parserText = typeof d.parseKept === 'number'
          ? t('sqStatsParsers') + ': ' + t('sqStatsKept') + ' ' + d.parseKept + (typeof d.parseProbed === 'number' ? ', ' + t('sqStatsProbed') + ' ' + d.parseProbed : '') + (typeof d.parseRemoved === 'number' && d.parseRemoved > 0 ? ', ' + t('sqStatsRemoved') + ' ' + d.parseRemoved : '') + (typeof d.parseLimit === 'number' && d.parseLimit > 0 ? ', ' + t('sqStatsLimit') + ' ' + d.parseLimit : ', ' + t('sqStatsUnlimited'))
          : t('sqStatsParsers') + ': ' + t('sqStatsNoData');
        stats.textContent = t('sqStatsCurrent') + ': ' + t('sqStatsSearchable') + ' ' + d.searchable + ' · ' + t('sqStatsPool') + ' ' + q.poolTotal + ' · ' + t('sqStatsQuick') + ' ' + quickCount + quickLimit + '. ' + parserText + '. ' + t('sqStatsQuality') + ': ' + t('sqExcellent') + ' ' + q.excellent.count + ', ' + t('sqGood') + ' ' + q.good.count + ', ' + t('sqUsable') + ' ' + q.usable.count + ', ' + t('sqCredentialReady') + ' ' + credentialReady.count + ', ' + t('sqUntestable') + ' ' + untestableCount + ', ' + t('sqTimeout') + ' ' + q.timeout.count + ', ' + t('sqUnusable') + ' ' + q.unusable.count + '.';
      }
    } else {
      $('sqQualityGrades').textContent = '';
      const stats = $('searchQuotaStats');
      if (stats) stats.textContent = t('sqStatsNoData');
    }

    // 加载站点列表
    const cfgRes = await auth.authFetch('/admin/config-data');
    if (!cfgRes.ok) return;
    const cfg = await cfgRes.json();
    const allSites = Array.isArray(cfg.sites) ? cfg.sites : [];
    const rawCandidateKeys = Array.isArray(cfg.searchQuality && cfg.searchQuality.candidateKeys)
      ? cfg.searchQuality.candidateKeys
      : allSites.filter(s => s.candidate === true).map(s => s.key);
    sqCandidateCount = typeof (cfg.searchQuality && cfg.searchQuality.candidateCount) === 'number'
      ? cfg.searchQuality.candidateCount
      : rawCandidateKeys.length;
    if (rawCandidateKeys.length > 0) {
      const candidateKeys = new Set(rawCandidateKeys);
      sqAllSites = allSites.filter(s => candidateKeys.has(s.key));
      sqExcludedSites = allSites.filter(s => s.searchable === 1 && !candidateKeys.has(s.key));
    } else {
      // 质量池尚未生成时按旧口径展示可搜索源，避免把所有源都误判为“未入选”。
      sqAllSites = allSites.filter(s => s.searchable === 1);
      sqExcludedSites = [];
    }
    renderSearchSources();
  } catch {}
}

// --- Search Quality Grading ---
function fmtLocalTime(iso, timezone) {
  if (!iso) return t('qualityNever');
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return t('qualityNever');
  const tz = timezone || qualityScheduleCache?.timezone || 'Asia/Shanghai';
  try {
    return d.toLocaleString(getLang() === 'zh' ? 'zh-CN' : 'en-US', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
  } catch {
    return d.toLocaleString(getLang() === 'zh' ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
  }
}

function qualityStateLabel(state) {
  if (state === 'running') return t('qualityStateRunning');
  if (state === 'done') return t('qualityStateDone');
  if (state === 'error') return t('qualityStateError');
  return t('qualityStateIdle');
}

let qualityScheduleCache = null;
let qualityReportCache = null;
let qualityPollTimer = null;

function qualityModeLabel(mode) {
  return mode === 'full' ? t('qualityModeFull') : t('qualityModeCandidate');
}

function setQualityButtonsRunning(running) {
  const candidateBtn = $('qualityRunCandidateBtn');
  const fullBtn = $('qualityRunFullBtn');
  if (candidateBtn) candidateBtn.disabled = !!running;
  if (fullBtn) fullBtn.disabled = !!running;
}

async function loadQualityReport() {
  try {
    const res = await auth.authFetch('/admin/quality-report');
    if (!res.ok) return;
    const d = await res.json();
    qualityReportCache = d;
    qualityScheduleCache = d.schedule || null;
    renderQualitySchedule(d.schedule);
    renderQualityStats(d);
    if (sqAllSites.length > 0) renderSearchSources();
    if (d.status && d.status.state === 'running') startQualityPolling();
    else setQualityButtonsRunning(false);
  } catch {}
}

function startQualityPolling() {
  if (qualityPollTimer) return;
  setQualityButtonsRunning(true);

  const poll = async function () {
    qualityPollTimer = null;
    try {
      const res = await auth.authFetch('/admin/quality-status');
      if (!res.ok) {
        setQualityButtonsRunning(false);
        return;
      }
      const d = await res.json();
      const prev = qualityReportCache || {};
      qualityReportCache = Object.assign({}, prev, {
        snapshot: d.snapshot,
        schedule: d.schedule,
        status: d.status,
      });
      qualityScheduleCache = d.schedule || qualityScheduleCache;
      renderQualitySchedule(d.schedule);
      renderQualityStats(qualityReportCache);
      renderSearchSources();

      if (d.status && d.status.state === 'running') {
        qualityPollTimer = setTimeout(poll, 2000);
        return;
      }

      setQualityButtonsRunning(false);
      const status = $('qualityScheduleStatus');
      if (status && d.status && d.status.state === 'done') {
        status.textContent = t('qualityStateDone') + (d.status.mode ? ' · ' + qualityModeLabel(d.status.mode) : '');
        status.className = 'status-text success';
      } else if (status && d.status && d.status.state === 'error') {
        status.textContent = t('qualityStateError') + (d.status.error ? ': ' + d.status.error : '');
        status.className = 'status-text error';
      }
      loadSearchQuotaReport();
    } catch {
      qualityPollTimer = setTimeout(poll, 5000);
    }
  };

  poll();
}

function refreshQualityReport() {
  const el = $('qualityScheduleStatus');
  loadQualityReport().then(function () {
    if (el) { el.textContent = t('qualityReportRefreshed'); el.className = 'status-text success'; setTimeout(function(){ el.textContent = ''; }, 3000); }
  });
}

function qualityTimezoneLabel(timezone) {
  const tz = timezone || 'Asia/Shanghai';
  if (tz === 'Asia/Shanghai') return getLang() === 'zh' ? '时区：北京时间（UTC+8）' : 'Timezone: Beijing time (UTC+8)';
  return getLang() === 'zh' ? ('时区：' + tz) : ('Timezone: ' + tz);
}

function renderQualitySchedule(schedule) {
  if (!schedule) return;
  qualityScheduleCache = schedule;
  $('qualityEnabledInput').checked = schedule.enabled !== false;
  $('qualityTimesInput').value = (schedule.times || []).join(', ');
  $('qualityRepeatDaysInput').value = schedule.repeatDays || 1;
  $('qualityFullRepeatDaysInput').value = schedule.fullRepeatDays || 7;
  const tzLabel = $('qualityTimezoneLabel');
  if (tzLabel) tzLabel.textContent = qualityTimezoneLabel(schedule.timezone);
}

function applyRecommendedQuota() {
  const d = qualityReportCache;
  if (!d) return;
  const maxSearch = d.recommendedMaxSearchable ?? d.snapshot?.recommendedMaxSearchable ?? 0;
  const maxParses = d.recommendedMaxParses ?? d.snapshot?.recommendedMaxParses ?? 3;
  const searchInput = $('maxSearchableInput');
  const parseInput = $('maxParsesInput');
  if (searchInput) searchInput.value = String(maxSearch);
  if (parseInput) parseInput.value = String(maxParses);
  const status = $('qualityScheduleStatus');
  if (status) {
    status.textContent = t('qualityRecommendedApplied');
    status.className = 'status-text success';
    setTimeout(function () { status.textContent = ''; }, 5000);
  }
}

async function saveQualitySchedule() {
  const status = $('qualityScheduleStatus');
  if (status) status.textContent = '';
  const times = $('qualityTimesInput').value.split(',').map(function (v) { return v.trim(); }).filter(function (v) { return v.length > 0; });
  const data = {
    enabled: $('qualityEnabledInput').checked,
    times: times,
    repeatDays: parseInt($('qualityRepeatDaysInput').value) || 1,
    fullRepeatDays: parseInt($('qualityFullRepeatDaysInput').value) || 7,
  };
  try {
    const res = await auth.authFetch('/admin/quality-schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      const d = await res.json();
      renderQualitySchedule(d);
      if (status) { status.textContent = t('qualityScheduleSaved'); status.className = 'status-text success'; }
      loadQualityReport();
    } else if (status) {
      status.textContent = t('saveFailed'); status.className = 'status-text error';
    }
  } catch {
    if (status) { status.textContent = t('networkError'); status.className = 'status-text error'; }
  }
  setTimeout(function () { if (status) status.textContent = ''; }, 3000);
}

async function runQualityNow(mode) {
  mode = mode === 'full' ? 'full' : 'candidate';
  const status = $('qualityScheduleStatus');
  setQualityButtonsRunning(true);
  if (status) {
    status.textContent = mode === 'full' ? t('qualityRunFullStarted') : t('qualityRunCandidateStarted');
    status.className = 'status-text success';
  }
  try {
    const res = await auth.authFetch('/admin/quality/run?mode=' + encodeURIComponent(mode), { method: 'POST' });
    if (res.ok) {
      const d = await res.json();
      if (status) {
        status.textContent = d.alreadyRunning
          ? t('qualityAlreadyRunning')
          : (mode === 'full' ? t('qualityRunFullStarted') : t('qualityRunCandidateStarted'));
        status.className = 'status-text success';
      }
      const prev = qualityReportCache || {};
      qualityReportCache = Object.assign({}, prev, {
        status: d.status || { state: 'running', mode: mode },
      });
      renderQualityStats(qualityReportCache);
      startQualityPolling();
      return;
    }
    if (status) { status.textContent = t('saveFailed'); status.className = 'status-text error'; }
  } catch {
    if (status) { status.textContent = t('networkError'); status.className = 'status-text error'; }
  }
  setQualityButtonsRunning(false);
}

function renderQualityStats(d) {
  const box = $('qualityDynamicStats');
  if (!box) return;
  const snap = d.snapshot;
  const sched = d.schedule;
  const st = d.status || { state: 'idle' };
  const running = st.state === 'running';
  setQualityButtonsRunning(running);
  let html = '';
  const stateColor = running ? 'var(--accent)' : (st.state === 'error' ? 'var(--red)' : 'var(--text-secondary)');
  html += '<div>' + t('qualityStatusLabel') + ': <span style="color:' + stateColor + '">' + qualityStateLabel(st.state) + '</span>';
  if (st.mode) html += ' · ' + t('qualityStatusMode') + ': ' + qualityModeLabel(st.mode);
  if (running && typeof st.cursor === 'number' && typeof st.total === 'number' && st.total > 0) {
    const pct = Math.min(100, Math.round((st.cursor / st.total) * 100));
    html += ' · ' + st.cursor + ' / ' + st.total + ' (' + pct + '%)';
  }
  if (st.error) html += ' · ' + escHtml(st.error);
  html += '</div>';
  if (sched) {
    html += '<div>' + t('qualityLastRun') + ': ' + fmtLocalTime(sched.lastRunAt, sched.timezone) + ' · ' + t('qualityNextRun') + ': ' + fmtLocalTime(sched.nextRunAt, sched.timezone) + (sched.enabled === false ? ' · ' + t('qualityStateIdle') : '') + '</div>';
    html += '<div>' + t('qualityLastRun') + ' (' + t('qualityModeFull') + '): ' + fmtLocalTime(sched.lastFullRunAt, sched.timezone) + ' · ' + t('qualityNextFullRun') + ': ' + fmtLocalTime(sched.nextFullRunAt, sched.timezone) + '</div>';
  }
  const actual = d.actual || {};
  const countText = function (value) { return typeof value === 'number' && isFinite(value) ? String(value) : '-'; };
  const parserLimitText = typeof actual.parserLimit === 'number' && actual.parserLimit > 0
    ? String(actual.parserLimit)
    : t('sqStatsUnlimited');
  html += '<div><strong>' + t('qualityActualCounts') + '</strong>: ' + t('sqStatsSearchable') + ' ' + countText(actual.searchable)
    + ' · ' + t('sqStatsParsers') + ' ' + t('sqStatsKept') + ' ' + countText(actual.parsers) + ' (' + t('sqStatsLimit') + ' ' + parserLimitText + ')'
    + ' · ' + t('sqStatsPool') + ' ' + countText(actual.candidatePool) + ' / ' + t('sqStatsUsablePool') + ' ' + countText(actual.usablePool) + '</div>';

  if (!snap || !snap.grades) {
    html += '<div>' + t('qualityNoSnapshot') + '</div>';
    box.innerHTML = html;
    return;
  }
  const g = snap.grades;
  const bucket = function (name) { return g[name] || { count: 0, cumulative: 0 }; };
  const ex = bucket('excellent');
  const good = bucket('good');
  const usable = bucket('usable');
  const credentialReady = bucket('credentialReady');
  const timeout = bucket('timeout');
  const unusable = bucket('unusable');
  const th = snap.thresholds || { excellentMaxMs: 1000, goodMaxMs: 3000, usableMaxMs: 6000 };
  html += '<div style="margin-top:4px"><strong>' + t('qualityGradesTitle') + '</strong></div>';
  const untestable = g.untestable || { count: 0, cumulative: 0 }; html += '<div>' + t('sqExcellent') + ': ' + ex.count + ' (<= ' + th.excellentMaxMs + 'ms, ' + t('sqCumulative') + ' ' + ex.cumulative + ') · ' + t('sqGood') + ': ' + good.count + ' (' + th.excellentMaxMs + '-' + th.goodMaxMs + 'ms, ' + t('sqCumulative') + ' ' + good.cumulative + ') · ' + t('sqUsable') + ': ' + usable.count + ' (' + th.goodMaxMs + '-' + (th.usableMaxMs || 6000) + 'ms, ' + t('sqCumulative') + ' ' + usable.cumulative + ') · ' + t('sqCredentialReady') + ': ' + credentialReady.count + ' (' + t('sqCumulative') + ' ' + credentialReady.cumulative + ') · ' + t('sqUntestable') + ': ' + untestable.count + ' (' + t('sqCumulative') + ' ' + untestable.cumulative + ') · ' + t('sqTimeout') + ': ' + timeout.count + ' (' + t('sqCumulative') + ' ' + timeout.cumulative + ') · ' + t('sqUnusable') + ': ' + unusable.count + '</div>';
  const coverage = snap.coverage || {};
  const testable = typeof coverage.testable === 'number' ? coverage.testable : 0;
  const probed = typeof coverage.probed === 'number' ? coverage.probed : 0;
  const coveragePct = testable > 0 ? Math.min(100, Math.round((probed / testable) * 100)) : 0;
  html += '<div>' + t('qualityCoverage') + ': ' + coveragePct + '% · ' + t('qualityTestable') + ' ' + countText(coverage.testable) + ' · ' + t('qualityProbed') + ' ' + countText(coverage.probed) + ' · ' + t('qualityNotProbed') + ' ' + countText(coverage.notProbed) + ' · ' + t('qualityUntestable') + ' ' + countText(coverage.untestable) + ' · ' + t('qualityCredentialReady') + ' ' + countText(coverage.credentialReady) + ' · ' + t('qualityCredentialPartial') + ' ' + countText(coverage.credentialPartial) + ' · ' + t('qualityCredentialMissing') + ' ' + countText(coverage.credentialMissing) + '</div>';
  html += '<div>' + t('qualityPreflightVerified') + ' ' + countText(coverage.preflightVerified) + ' · ' + t('qualityPreflightCredentialReady') + ' ' + countText(coverage.preflightCredentialReady) + ' · ' + t('qualityPreflightAListVerified') + ' ' + countText(coverage.preflightAListVerified) + ' · ' + t('qualityPreflightJarVerified') + ' ' + countText(coverage.preflightJarVerified) + ' · ' + t('qualityClientFinalOnly') + ' ' + countText(coverage.clientFinalOnly) + '</div>';
  html += '<div>' + t('sqPoolTotal') + ': ' + g.poolTotal + ' · ' + t('sqQuality') + ' ' + snap.graded + '/' + snap.total + ' · ' + fmtLocalTime(snap.updatedAt, sched?.timezone) + '</div>';
  const recSearch = d.recommendedMaxSearchable ?? snap.recommendedMaxSearchable ?? 0;
  const recParse = d.recommendedMaxParses ?? snap.recommendedMaxParses ?? 3;
  html += '<div>' + t('qualityRecommended') + ': ' + t('qualityRecSearchable') + ' ' + recSearch + ' · ' + t('qualityRecParses') + ' ' + recParse + '</div>';
  html += '<div style="margin-top:2px">' + t('qualityTimesHint') + '</div>';
  box.innerHTML = html;
}

let sqAllSites = [];
let sqExcludedSites = [];
let sqCandidateCount = 0;
let sqSearchRenderPending = false;
let sqLastRenderedHtml = '';
const sqScrollPositions = { pinned: null, candidate: null, excluded: null };

function captureSearchTableScroll() {
  document.querySelectorAll('.sq-table-wrap[data-sq-scroll]').forEach(function(el) {
    const key = el.getAttribute('data-sq-scroll');
    if (key) sqScrollPositions[key] = { top: el.scrollTop, left: el.scrollLeft };
  });
}

function restoreSearchTableScroll() {
  document.querySelectorAll('.sq-table-wrap[data-sq-scroll]').forEach(function(el) {
    const pos = sqScrollPositions[el.getAttribute('data-sq-scroll')];
    if (pos) {
      el.scrollTop = pos.top;
      el.scrollLeft = pos.left;
    }
  });
}

function bindSearchTableScroll() {
  document.querySelectorAll('.sq-table-wrap[data-sq-scroll]').forEach(function(el) {
    if (el.dataset.sqScrollBound === '1') return;
    el.dataset.sqScrollBound = '1';
    let scrollingTimer = null;
    const markScrolling = function() {
      sqSearchRenderPending = true;
      if (scrollingTimer) clearTimeout(scrollingTimer);
      scrollingTimer = setTimeout(function() {
        scrollingTimer = null;
        sqSearchRenderPending = false;
        renderSearchSources();
      }, 180);
    };
    el.addEventListener('scroll', markScrolling, { passive: true });
    el.addEventListener('pointerdown', function() { sqSearchRenderPending = true; }, { passive: true });
    el.addEventListener('pointerup', function() {
      setTimeout(function() {
        sqSearchRenderPending = false;
        renderSearchSources();
      }, 180);
    }, { passive: true });
    el.addEventListener('pointercancel', function() {
      sqSearchRenderPending = false;
      renderSearchSources();
    }, { passive: true });
  });
}

function qualityEntryByKey() {
  const map = new Map();
  const snap = qualityReportCache && qualityReportCache.snapshot ? qualityReportCache.snapshot : null;
  if (!snap || !Array.isArray(snap.entries)) return map;
  for (const entry of snap.entries) {
    if (entry && typeof entry.key === 'string') map.set(entry.key, entry);
  }
  return map;
}

function qualityGradeLabel(grade) {
  if (grade === 'excellent') return t('sqExcellent');
  if (grade === 'good') return t('sqGood');
  if (grade === 'usable') return t('sqUsable');
  if (grade === 'credential-ready') return t('sqCredentialReady');
  if (grade === 'untestable') return t('sqUntestable');
  if (grade === 'timeout') return t('sqTimeout');
  if (grade === 'unusable') return t('sqUnusable');
  return '-';
}

function qualityCandidateReasonLabel(reason) {
  if (reason === 'js-url-excluded') return t('sqReasonJsUrlExcluded');
  if (reason === 'timeout') return t('sqReasonTimeout');
  if (reason === 'unusable') return t('sqReasonUnusable');
  if (reason === 'not-in-quality-pool') return t('sqReasonNotInPool');
  return t('sqReasonNotCandidate');
}

function qualityGradeColor(grade) {
  if (grade === 'excellent') return 'var(--green)';
  if (grade === 'good') return 'var(--primary)';
  if (grade === 'usable') return 'var(--accent)';
  if (grade === 'credential-ready') return 'var(--text-secondary)';
  if (grade === 'untestable') return 'var(--text-secondary)';
  if (grade === 'timeout') return 'var(--red)';
  if (grade === 'unusable') return 'var(--red)';
  return 'var(--text-secondary)';
}

function preflightStatusLabel(status) {
  if (status === 'verified') return t('qualityPreflightVerified');
  if (status === 'credential-ready') return t('qualityPreflightCredentialReady');
  if (status === 'alist-verified') return t('qualityPreflightAListVerified');
  if (status === 'client-jar-verified') return t('qualityPreflightJarVerified');
  if (status === 'client-jar-unverified') return t('qualityClientFinalOnly');
  if (status === 'credential-invalid') return t('sqCredentialReady');
  return '-';
}

function qualitySpeedLabel(entry) {
  if (!entry) return '-';
  if (typeof entry.speedMs === 'number' && isFinite(entry.speedMs)) return entry.speedMs + 'ms';
  if (entry.preflight && entry.preflight.status) {
    const status = preflightStatusLabel(entry.preflight.status);
    if (status && status !== '-') return status;
  }
  return '-';
}

function renderSearchSources() {
  if (sqSearchRenderPending) return;
  captureSearchTableScroll();
  const pinnedArr = [...sqPinnedKeys];
  const qualityMap = qualityEntryByKey();
  const input = $('sqSourceFilter');
  const select = $('sqGradeFilter');
  const query = input ? String(input.value || '').trim().toLowerCase() : '';
  const gradeFilter = select ? String(select.value || 'all') : 'all';
  const matches = function(s) {
    const entry = qualityMap.get(s.key);
    if (gradeFilter === 'blocked') {
      if (!sqBlockedKeys.has(s.key)) return false;
    } else if (gradeFilter !== 'all') {
      if (!entry || entry.grade !== gradeFilter) return false;
    }
    if (!query) return true;
    return String(s.key || '').toLowerCase().includes(query)
      || String(s.name || '').toLowerCase().includes(query);
  };

  const pinnedFiltered = pinnedArr.filter(key => {
    const site = sqAllSites.find(s => s.key === key) || { key: key, name: key };
    return matches(site);
  });
  const candidateSites = sqAllSites;
  const unpinnedAll = candidateSites.filter(s => !sqPinnedKeys.has(s.key)).filter(matches);
  const visibleLimit = 1000;
  const unpinned = unpinnedAll.slice(0, visibleLimit);

  const count = $('sqSourceFilterCount');
  if (count) {
    count.textContent = (query || gradeFilter !== 'all')
      ? t('sqFilterMatched') + ': ' + (pinnedFiltered.length + unpinnedAll.length)
      : '';
  }

  let html = '';
  if (pinnedFiltered.length > 0) {
    html += '<div style="margin-bottom:12px"><strong style="color:var(--primary)">' + t('sqPinned') + ' (' + pinnedFiltered.length + ')</strong>';
    html += ' <span style="font-size:0.75rem;color:var(--text-secondary)">— ' + t('sqPinnedDesc') + '</span></div>';
    html += '<div class="sq-table-wrap is-pinned" data-sq-scroll="pinned"><table class="sq-table">';
    html += '<thead><tr><th style="width:30px">#</th><th>' + t('sqKey') + '</th><th>' + t('sqName') + '</th><th>' + t('sqGrade') + '</th><th>' + t('sqSpeedStatus') + '</th><th style="width:190px;text-align:right">' + t('sqAction') + '</th></tr></thead><tbody>';
    pinnedFiltered.forEach(function(key) {
      const s = sqAllSites.find(item => item.key === key) || { key: key, name: key };
      const entry = qualityMap.get(key);
      const grade = entry ? entry.grade : null;
      const i = pinnedArr.indexOf(key);
      html += '<tr style="border-bottom:1px solid var(--border);background:var(--bg-hover)">';
      html += '<td style="padding:4px;width:30px;color:var(--text-secondary)">' + (i + 1) + '</td>';
      html += '<td style="padding:4px;font-family:var(--mono);font-size:0.75rem">' + escHtml(s.key) + '</td>';
      html += '<td style="padding:4px">' + escHtml(s.name || s.key) + '</td>';
      html += '<td style="padding:4px;white-space:nowrap;color:' + qualityGradeColor(grade) + '">' + qualityGradeLabel(grade) + '</td>';
      html += '<td style="padding:4px;white-space:nowrap;font-family:var(--mono);font-size:0.75rem">' + qualitySpeedLabel(entry) + '</td>';
      html += '<td style="padding:4px;width:190px;text-align:right;white-space:nowrap">';
      if (i > 0) html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem" onclick="movePinned(' + i + ',-1)">▲</button> ';
      if (i < pinnedArr.length - 1) html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem" onclick="movePinned(' + i + ',1)">▼</button> ';
      html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem;color:var(--red)" onclick="togglePin(&quot;' + escHtml(key) + '&quot;)">' + t('sqUnpin') + '</button> ';
      html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem;color:var(--red)" onclick="toggleBlocked(&quot;' + escHtml(key) + '&quot;)">' + t('sqBlock') + '</button>';
      html += '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  html += '<div style="margin-top:16px;margin-bottom:8px"><strong>' + t('sqOtherSources') + ' (' + (sqCandidateCount || candidateSites.length) + ')</strong></div>';
  html += '<div style="margin-bottom:6px;font-size:0.75rem;color:var(--text-secondary)">' + t('sqCandidateDesc') + '</div>';
  html += '<div class="sq-table-wrap" data-sq-scroll="candidate"><table class="sq-table">';
  html += '<thead><tr><th>' + t('sqKey') + '</th><th>' + t('sqName') + '</th><th>' + t('sqGrade') + '</th><th>' + t('sqSpeedStatus') + '</th><th style="width:120px;text-align:right">' + t('sqAction') + '</th></tr></thead><tbody>';
  unpinned.forEach(function(s) {
    const isBlocked = sqBlockedKeys.has(s.key);
    const entry = qualityMap.get(s.key);
    const grade = entry ? entry.grade : null;
    html += '<tr style="border-bottom:1px solid var(--border)' + (isBlocked ? ';opacity:0.55;text-decoration:line-through' : '') + '">';
    html += '<td style="padding:4px;font-family:var(--mono);font-size:0.75rem">' + escHtml(s.key) + '</td>';
    html += '<td style="padding:4px">' + escHtml(s.name || s.key) + (isBlocked ? ' <span style="color:var(--red);font-size:0.7rem">' + t('sqBlocked') + '</span>' : '') + '</td>';
    html += '<td style="padding:4px;white-space:nowrap;color:' + qualityGradeColor(grade) + '">' + qualityGradeLabel(grade) + '</td>';
    html += '<td style="padding:4px;white-space:nowrap;font-family:var(--mono);font-size:0.75rem">' + qualitySpeedLabel(entry) + '</td>';
    html += '<td style="padding:4px;width:120px;text-align:right;white-space:nowrap">';
    if (!isBlocked) html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem" onclick="togglePin(&quot;' + escHtml(s.key) + '&quot;)">' + t('sqPin') + '</button> ';
    html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem;color:var(--red)" onclick="toggleBlocked(&quot;' + escHtml(s.key) + '&quot;)">' + (isBlocked ? t('sqUnblock') : t('sqBlock')) + '</button>';
    html += '</td>';
    html += '</tr>';
  });
  if (unpinnedAll.length > visibleLimit) html += '<tr><td colspan="5" style="padding:4px;color:var(--text-secondary)">... +' + (unpinnedAll.length - visibleLimit) + ' more</td></tr>';
  if (unpinnedAll.length === 0) html += '<tr><td colspan="5" style="padding:8px;color:var(--text-secondary)">' + t('sqFilterNoMatch') + '</td></tr>';
  html += '</tbody></table></div>';

  const excludedFiltered = sqExcludedSites.filter(matches);
  if (excludedFiltered.length > 0) {
    const excludedVisible = excludedFiltered.slice(0, visibleLimit);
    html += '<div style="margin-top:20px;margin-bottom:8px"><strong>' + t('sqExcludedSources') + ' (' + excludedFiltered.length + ')</strong></div>';
    html += '<div style="margin-bottom:6px;font-size:0.75rem;color:var(--text-secondary)">' + t('sqExcludedDesc') + '</div>';
    html += '<div class="sq-table-wrap" data-sq-scroll="excluded"><table class="sq-table">';
    html += '<thead><tr><th>' + t('sqKey') + '</th><th>' + t('sqName') + '</th><th>' + t('sqReason') + '</th><th>' + t('sqSpeedStatus') + '</th><th style="width:120px;text-align:right">' + t('sqAction') + '</th></tr></thead><tbody>';
    excludedVisible.forEach(function(s) {
      const isBlocked = sqBlockedKeys.has(s.key);
      const entry = qualityMap.get(s.key);
      const grade = entry ? entry.grade : null;
      html += '<tr style="border-bottom:1px solid var(--border)' + (isBlocked ? ';opacity:0.55;text-decoration:line-through' : '') + '">';
      html += '<td style="padding:4px;font-family:var(--mono);font-size:0.75rem">' + escHtml(s.key) + '</td>';
      html += '<td style="padding:4px">' + escHtml(s.name || s.key) + (isBlocked ? ' <span style="color:var(--red);font-size:0.7rem">' + t('sqBlocked') + '</span>' : '') + '</td>';
      html += '<td style="padding:4px;white-space:nowrap;color:var(--text-secondary)">' + escHtml(qualityCandidateReasonLabel(s.candidateReason)) + '</td>';
      html += '<td style="padding:4px;white-space:nowrap;font-family:var(--mono);font-size:0.75rem">' + qualitySpeedLabel(entry) + '</td>';
      html += '<td style="padding:4px;width:120px;text-align:right;white-space:nowrap">';
      html += '<button class="btn btn-sm" style="padding:1px 6px;font-size:0.7rem;color:var(--red)" onclick="toggleBlocked(&quot;' + escHtml(s.key) + '&quot;)">' + (isBlocked ? t('sqUnblock') : t('sqBlock')) + '</button>';
      html += '</td></tr>';
    });
    if (excludedFiltered.length > visibleLimit) html += '<tr><td colspan="5" style="padding:4px;color:var(--text-secondary)">... +' + (excludedFiltered.length - visibleLimit) + ' more</td></tr>';
    html += '</tbody></table></div>';
  }

  // Polling should not replace an unchanged table. Replacing it would reset
  // scroll position and interrupt a scrollbar drag even when nothing changed.
  if (html === sqLastRenderedHtml) return;
  sqLastRenderedHtml = html;
  $('sqSelectedTable').innerHTML = html;
  // Restore first: setting scrollTop before binding avoids treating the
  // programmatic restore as a user scroll and re-rendering in a loop.
  restoreSearchTableScroll();
  bindSearchTableScroll();
}
async function movePinned(index, direction) {
  const arr = [...sqPinnedKeys];
  const target = index + direction;
  if (target < 0 || target >= arr.length) return;
  [arr[index], arr[target]] = [arr[target], arr[index]];
  try {
    const res = await auth.authFetch('/admin/search-quota/pinned', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: arr }),
    });
    if (res.ok) {
      const d = await res.json();
      sqPinnedKeys = new Set(d.pinnedKeys);
      renderSearchSources();
    }
  } catch {}
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function togglePin(key) {
  if (sqBlockedKeys.has(key)) return;
  const isPinned = sqPinnedKeys.has(key);
  try {
    const res = await auth.authFetch('/admin/search-quota/pinned', {
      method: isPinned ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [key] }),
    });
    if (res.ok) {
      const d = await res.json();
      sqPinnedKeys = new Set(d.pinnedKeys);
      renderSearchSources();
    }
  } catch {}
}

async function toggleBlocked(key) {
  const next = new Set(sqBlockedKeys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  try {
    const res = await auth.authFetch('/admin/search-quota', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockedKeys: [...next] }),
    });
    if (res.ok) {
      const d = await res.json();
      sqBlockedKeys = new Set(d.blockedKeys || []);
      sqPinnedKeys = new Set(d.pinnedKeys || []);
      renderSearchSources();
    }
  } catch {}
}

// --- Refresh ---
function setRefreshButtonState(running) {
  const btn = $('refreshBtn');
  if (!btn) return;
  btn.textContent = running ? t('aggregateNowRunning') : t('aggregateNow');
  btn.className = running ? 'btn btn-sm loading' : 'btn btn-sm';
  btn.disabled = running;
}

async function pollAggregationStatus() {
  let attempts = 0;
  const poll = async () => {
    attempts += 1;
    try {
      const res = await auth.authFetch('/admin/aggregation-status');
      if (!res.ok) throw new Error('status unavailable');
      const status = await res.json();
      if (status.running) {
        const elapsed = Math.round((status.elapsedMs || 0) / 1000);
        const phase = status.phase ? ' (' + status.phase + ', ' + elapsed + 's)' : ' (' + elapsed + 's)';
        const btn = $('refreshBtn');
        if (btn) btn.textContent = t('aggregateNowRunning') + phase;
        if (attempts < 600) setTimeout(poll, 2000);
        return;
      }
      setRefreshButtonState(false);
      await loadStatus();
      const result = status.lastResult || status;
      if (result.timedOut) toast(t('refreshTimedOut'), 'error');
      else if (result.completed) toast(t('aggregationCompleted'));
      else if (result.message) toast(result.message, 'error');
      else toast(t('refreshFailed'), 'error');
      return;
    } catch {
      if (attempts < 5) {
        setTimeout(poll, 2000);
      } else {
        setRefreshButtonState(false);
      }
    }
  };
  void poll();
}

async function triggerRefresh() {
  setRefreshButtonState(true);

  try {
    const res = await auth.authFetch('/refresh', { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.status === 409 || d.skipped) {
      toast(t('aggregationAlreadyRunning'));
      void pollAggregationStatus();
      return;
    }
    if (!res.ok || !d.success) {
      setRefreshButtonState(false);
      toast(d.error || t('refreshFailed'), 'error');
      return;
    }
    if (d.started || d.timedOut) {
      toast(t('aggregationStarted'));
      void pollAggregationStatus();
      return;
    }
    setRefreshButtonState(false);
    toast(d.completed ? t('aggregationCompleted') : t('refreshFailed'), d.completed ? 'success' : 'error');
    setTimeout(loadStatus, 1000);
  } catch {
    setRefreshButtonState(false);
    toast(t('networkError'), 'error');
  }
}

// --- Cloud Credentials ---
const PLATFORM_NAMES = {
  aliyun:'阿里云盘', bilibili:'Bilibili', quark:'夸克网盘', uc:'UC 网盘', uc_tv:'UC TV',
  pan115:'115 网盘', tianyi:'天翼云盘', baidu:'百度网盘', pan123:'123 网盘',
  thunder:'迅雷', pikpak:'PikPak'
};
const QR_PLATFORMS = ['bilibili','aliyun','quark','uc','uc_tv','pan115','baidu'];
const MANUAL_ONLY_PLATFORMS = ['pan123','tianyi'];
const PW_PLATFORMS = ['pan123','tianyi','thunder','pikpak'];
let cloudCredentials = {};

let credentialDistribution = {
  requireAuth: false,
  defaultCredentialMode: 'all',
  defaultPlatforms: [],
  authCodes: [],
};
let credentialPlatforms = Object.keys(PLATFORM_NAMES);

function newCredentialAuthCode() {
  const bytes = new Uint8Array(12);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
  const now = new Date().toISOString();
  return {
    id: 'auth_' + random,
    label: t('credentialDefaultLabel') + ' ' + (credentialDistribution.authCodes.length + 1),
    code: random,
    enabled: true,
    credentialMode: 'none',
    platforms: [],
    createdAt: now,
    updatedAt: now,
  };
}

function platformCheckboxes(container, selected, onchange) {
  if (!container) return;
  const selectedSet = new Set(Array.isArray(selected) ? selected : []);
  container.innerHTML = '';
  for (const platform of credentialPlatforms) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedSet.has(platform);
    cb.onchange = () => onchange(platform, cb.checked);
    const span = document.createElement('span');
    span.textContent = PLATFORM_NAMES[platform] || platform;
    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  }
}

function syncCredentialDistributionForm() {
  const mode = $('credentialDefaultMode');
  const requireAuth = $('credentialRequireAuth');
  if (mode) mode.value = credentialDistribution.defaultCredentialMode || 'all';
  if (requireAuth) requireAuth.checked = credentialDistribution.requireAuth === true;
  const stripUpstream = $('credentialStripUpstreamEntries');
  if (stripUpstream) stripUpstream.checked = credentialDistribution.stripUpstreamCredentialEntries === true;
  renderCredentialDistribution();
}

function renderCredentialDistribution() {
  const modeEl = $('credentialDefaultMode');
  const requireEl = $('credentialRequireAuth');
  if (!modeEl || !requireEl) return;

  credentialDistribution.defaultCredentialMode = modeEl.value;
  credentialDistribution.requireAuth = requireEl.checked;
  const stripUpstreamEl = $('credentialStripUpstreamEntries');
  if (stripUpstreamEl) credentialDistribution.stripUpstreamCredentialEntries = stripUpstreamEl.checked;

  const defaultBox = $('credentialDefaultPlatforms');
  if (defaultBox) {
    defaultBox.style.display = modeEl.value === 'selected' ? 'grid' : 'none';
    if (modeEl.value === 'selected') {
      platformCheckboxes(defaultBox, credentialDistribution.defaultPlatforms, (platform, checked) => {
        const set = new Set(credentialDistribution.defaultPlatforms || []);
        if (checked) set.add(platform); else set.delete(platform);
        credentialDistribution.defaultPlatforms = credentialPlatforms.filter((p) => set.has(p));
      });
    }
  }

  const rootHint = $('credentialRootLinkHint');
  if (rootHint) {
    const rootPolicy = {
      none: t('credentialModeNone'),
      all: t('credentialModeAll'),
      selected: t('credentialModeSelected'),
    }[modeEl.value] || modeEl.value;
    const rootState = requireEl.checked ? t('credentialRequireAuth') : rootPolicy;
    rootHint.textContent = t('credentialRootLinkHint') + ': ' + rootState;
  }

  const list = $('credentialAuthList');
  if (!list) return;
  list.innerHTML = '';
  const codes = Array.isArray(credentialDistribution.authCodes) ? credentialDistribution.authCodes : [];
  if (codes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'credential-help';
    empty.textContent = t('credentialNoCodes');
    list.appendChild(empty);
  }

  codes.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'credential-auth-card';
    const top = document.createElement('div');
    top.className = 'credential-inline';
    top.style.justifyContent = 'space-between';

    const title = document.createElement('div');
    title.className = 'credential-inline';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = item.enabled !== false;
    enabled.onchange = () => { item.enabled = enabled.checked; item.updatedAt = new Date().toISOString(); };
    const titleText = document.createElement('strong');
    titleText.style.color = 'var(--text-bright)';
    titleText.textContent = item.label || ('Auth ' + (index + 1));
    title.appendChild(enabled);
    title.appendChild(titleText);
    const summary = document.createElement('span');
    summary.className = 'credential-pill';
    summary.textContent = credentialModeSummary(item);
    if (item.credentialMode === 'selected' && !(item.platforms || []).length) summary.className = 'credential-pill credential-pill-warning';
    title.appendChild(summary);

    const remove = document.createElement('button');
    remove.className = 'btn btn-sm btn-danger';
    remove.textContent = t('credentialDelete');
    remove.onclick = () => {
      credentialDistribution.authCodes.splice(index, 1);
      renderCredentialDistribution();
    };
    top.appendChild(title);
    top.appendChild(remove);
    card.appendChild(top);

    const grid = document.createElement('div');
    grid.className = 'credential-auth-grid';

    const labelWrap = document.createElement('div');
    const labelTitle = document.createElement('label');
    labelTitle.className = 'form-label';
    labelTitle.textContent = t('credentialCodeLabel');
    const labelInput = document.createElement('input');
    labelInput.className = 'nt-input';
    labelInput.value = item.label || '';
    labelInput.oninput = () => { item.label = labelInput.value; item.updatedAt = new Date().toISOString(); if (titleText) titleText.textContent = labelInput.value || ('Auth ' + (index + 1)); };
    labelWrap.appendChild(labelTitle);
    labelWrap.appendChild(labelInput);

    const codeWrap = document.createElement('div');
    const codeTitle = document.createElement('label');
    codeTitle.className = 'form-label';
    codeTitle.textContent = t('credentialCodeValue');
    const codeInput = document.createElement('input');
    codeInput.className = 'nt-input';
    codeInput.value = item.code || '';
    codeInput.oninput = () => { item.code = codeInput.value.trim(); item.updatedAt = new Date().toISOString(); };
    codeWrap.appendChild(codeTitle);
    codeWrap.appendChild(codeInput);

    const modeWrap = document.createElement('div');
    const modeTitle = document.createElement('label');
    modeTitle.className = 'form-label';
    modeTitle.textContent = t('credentialCodeMode');
    const modeSelect = document.createElement('select');
    modeSelect.className = 'nt-input';
    for (const value of ['none', 'all', 'selected']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'none' ? t('credentialModeNone') : value === 'all' ? t('credentialModeAll') : t('credentialModeSelected');
      modeSelect.appendChild(option);
    }
    modeSelect.value = item.credentialMode || 'none';
    modeSelect.onchange = () => {
      item.credentialMode = modeSelect.value;
      item.updatedAt = new Date().toISOString();
      renderCredentialDistribution();
    };
    modeWrap.appendChild(modeTitle);
    modeWrap.appendChild(modeSelect);

    grid.appendChild(labelWrap);
    grid.appendChild(codeWrap);
    grid.appendChild(modeWrap);
    card.appendChild(grid);

    const platformBox = document.createElement('div');
    platformBox.className = 'credential-platform-grid';
    platformBox.style.display = item.credentialMode === 'selected' ? 'grid' : 'none';
    if (item.credentialMode === 'selected') {
      platformCheckboxes(platformBox, item.platforms, (platform, checked) => {
        const set = new Set(item.platforms || []);
        if (checked) set.add(platform); else set.delete(platform);
        item.platforms = credentialPlatforms.filter((p) => set.has(p));
        item.updatedAt = new Date().toISOString();
      });
    }
    card.appendChild(platformBox);
    if (item.credentialMode === 'selected' && !(item.platforms || []).length) {
      const warning = document.createElement('div');
      warning.className = 'credential-help credential-help-warning';
      warning.textContent = t('credentialSelectedEmpty');
      card.appendChild(warning);
    }

    const actions = document.createElement('div');
    actions.className = 'credential-auth-actions';
    const copyAuth = document.createElement('button');
    copyAuth.className = 'btn btn-sm';
    copyAuth.textContent = t('credentialCopyAuth');
    copyAuth.onclick = () => copyClientLink(window.location.origin + '/auth/' + encodeURIComponent(item.code || '') + '/');
    actions.appendChild(copyAuth);
    card.appendChild(actions);

    list.appendChild(card);
  });

  const status = $('credentialDistributionStatus');
  if (status) status.textContent = requireEl.checked ? t('credentialRequireAuth') : t('credentialDefaultPolicy');
}

function credentialModeSummary(item) {
  if (item.credentialMode === 'none') return t('credentialModeNone');
  if (item.credentialMode === 'all') return t('credentialModeAll');
  const names = (item.platforms || []).map((platform) => PLATFORM_NAMES[platform] || platform).join(', ');
  return names ? t('credentialSelectedSummary') + ': ' + names : t('credentialSelectedEmptyShort');
}

function addCredentialAuthCode() {
  if (!Array.isArray(credentialDistribution.authCodes)) credentialDistribution.authCodes = [];
  credentialDistribution.authCodes.push(newCredentialAuthCode());
  renderCredentialDistribution();
}

function copyClientLink(link) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => toast(t('credentialCopied') + ': ' + link, 'success')).catch(() => {});
  } else {
    window.prompt(t('credentialCopyAuth'), link);
  }
}

async function loadCredentialDistribution() {
  try {
    const res = await auth.authFetch('/admin/credential-distribution');
    if (!res.ok) return;
    const data = await res.json();
    credentialDistribution = {
      requireAuth: data.requireAuth === true,
      defaultCredentialMode: data.defaultCredentialMode || 'all',
      defaultPlatforms: Array.isArray(data.defaultPlatforms) ? data.defaultPlatforms : [],
      authCodes: Array.isArray(data.authCodes) ? data.authCodes : [],
      stripUpstreamCredentialEntries: data.stripUpstreamCredentialEntries === true,
    };
    syncCredentialDistributionForm();
  } catch {}
}

async function saveCredentialDistribution() {
  const status = $('credentialDistributionStatus');
  if (!status) return;
  const modeEl = $('credentialDefaultMode');
  const requireEl = $('credentialRequireAuth');
  if (!modeEl || !requireEl) return;
  credentialDistribution.defaultCredentialMode = modeEl.value;
  credentialDistribution.requireAuth = requireEl.checked;
  const stripUpstreamEl = $('credentialStripUpstreamEntries');
  if (stripUpstreamEl) credentialDistribution.stripUpstreamCredentialEntries = stripUpstreamEl.checked;
  if (credentialDistribution.defaultCredentialMode !== 'selected') credentialDistribution.defaultPlatforms = [];
  if (credentialDistribution.requireAuth && !(credentialDistribution.authCodes || []).some((item) => item.enabled !== false)) {
    toast(t('credentialRootRequired'), 'error');
    return;
  }
  for (const item of credentialDistribution.authCodes || []) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(item.code || '')) {
      toast(t('credentialCodeInvalid'), 'error');
      return;
    }
  }
  status.textContent = t('saving');
  try {
    const res = await auth.authFetch('/admin/credential-distribution', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentialDistribution),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('saveFailed'));
    credentialDistribution = {
      requireAuth: data.requireAuth === true,
      defaultCredentialMode: data.defaultCredentialMode || 'all',
      defaultPlatforms: Array.isArray(data.defaultPlatforms) ? data.defaultPlatforms : [],
      authCodes: Array.isArray(data.authCodes) ? data.authCodes : [],
      stripUpstreamCredentialEntries: data.stripUpstreamCredentialEntries === true,
    };
    syncCredentialDistributionForm();
    status.textContent = t('saved');
    toast(t('credentialSaved'), 'success');
  } catch (e) {
    status.textContent = '';
    toast((e && e.message ? e.message : e), 'error');
  }
}

async function loadCloudCredentials() {
  try {
    const res = await auth.authFetch('/admin/cloud-credentials');
    if (!res.ok) return;
    const data = await res.json();
    cloudCredentials = data.credentials || {};
    renderCloudCards();
    renderPlatformSelect();
  } catch {}
}

function cloudCardState(platform) {
  const cred = cloudCredentials[platform];
  const isLoggedIn = cred && cred.hasCredential;
  const statusClass = isLoggedIn ? (cred.status === 'expired' ? 'expired' : 'valid') : 'none';
  const statusText = isLoggedIn ? (cred.status === 'expired' ? 'EXPIRED' : 'ACTIVE') : 'NOT SET';
  const timeStr = cred?.obtainedAt ? new Date(cred.obtainedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '';
  return { cred, isLoggedIn, statusClass, statusText, timeStr };
}

function renderCloudCards() {
  const grid = $('cloudLoginGrid');
  grid.innerHTML = '';

  // UC Web Cookie and UC TV Token are different credential protocols.
  // Keep them as two explicit actions inside one UC card so neither value is
  // mistaken for the other while the UI stays compact.
  const ucCard = document.createElement('div');
  ucCard.className = 'cloud-card';
  const ucEntries = [
    { platform: 'uc', label: 'UC 网盘（Cookie）', button: '扫码登录' },
    { platform: 'uc_tv', label: 'UC TV（Token）', button: '扫码登录' },
  ];
  ucCard.innerHTML =
    '<div class="cloud-card-header">' +
      '<span class="cloud-card-name">UC</span>' +
    '</div>' +
    ucEntries.map((entry) => {
      const state = cloudCardState(entry.platform);
      return '<div class="cloud-card-row">' +
        '<div class="cloud-card-row-info">' +
          '<span class="cloud-card-row-name">' + entry.label + '</span>' +
          '<span class="cloud-card-row-status ' + state.statusClass + '">' + state.statusText + (state.timeStr ? ' · ' + state.timeStr : '') + '</span>' +
        '</div>' +
        '<div class="cloud-card-actions">' +
          '<button class="btn btn-sm" onclick="startQRLogin(\\'' + entry.platform + '\\')">' + entry.button + '</button>' +
          (state.isLoggedIn ? '<button class="btn btn-sm btn-danger" onclick="logoutPlatform(\\'' + entry.platform + '\\')">退出</button>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  grid.appendChild(ucCard);

  const allPlatforms = [...new Set([...QR_PLATFORMS, ...MANUAL_ONLY_PLATFORMS, ...PW_PLATFORMS])]
    .filter((platform) => platform !== 'uc' && platform !== 'uc_tv');

  for (const p of allPlatforms) {
    const cred = cloudCredentials[p];
    const isLoggedIn = cred && cred.hasCredential;
    const statusClass = isLoggedIn ? (cred.status === 'expired' ? 'expired' : 'valid') : 'none';
    const statusText = isLoggedIn ? (cred.status === 'expired' ? 'EXPIRED' : 'ACTIVE') : 'NOT SET';
    const isQR = QR_PLATFORMS.includes(p);
    const isManualOnly = MANUAL_ONLY_PLATFORMS.includes(p);
    const timeStr = cred?.obtainedAt ? new Date(cred.obtainedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '';

    const card = document.createElement('div');
    card.className = 'cloud-card';
    card.innerHTML =
      '<div class="cloud-card-header">' +
        '<span class="cloud-card-name">' + (PLATFORM_NAMES[p]||p) + '</span>' +
        '<span class="cloud-badge ' + statusClass + '">' + statusText + '</span>' +
      '</div>' +
      (timeStr ? '<div class="cloud-card-time">' + timeStr + '</div>' : '') +
      '<div class="cloud-card-actions">' +
        (isQR ? '<button class="btn btn-sm" onclick="startQRLogin(\\''+p+'\\')">Scan QR</button>' :
         isManualOnly ? '<button class="btn btn-sm" onclick="focusManualCredential(\\''+p+'\\')">Manual</button>' :
                '<button class="btn btn-sm" onclick="showPasswordLogin(\\''+p+'\\')">Login</button>') +
        (isLoggedIn ? '<button class="btn btn-sm btn-danger" onclick="logoutPlatform(\\''+p+'\\')">Logout</button>' : '') +
      '</div>';
    grid.appendChild(card);
  }
}

function renderPlatformSelect() {
  const sel = $('manualPlatform');
  sel.innerHTML = '';
  for (const [k,v] of Object.entries(PLATFORM_NAMES)) {
    const opt = document.createElement('option');
    opt.value = k; opt.textContent = v;
    sel.appendChild(opt);
  }
}

let qrPollTimer = null;

async function startQRLogin(platform) {
  try {
    const res = await auth.authFetch('/admin/cloud-login/' + platform + '/qr', { method: 'POST' });
    if (!res.ok) { const e = await res.json(); toast(e.error || 'QR failed', 'error'); return; }
    const data = await res.json();
    showQRModal(platform, data.qrUrl, data.token, data.qrKind);
  } catch (e) {
    toast('QR generate failed: ' + e.message, 'error');
  }
}

function showQRModal(platform, qrUrl, token, qrKind) {
  closeQRModal();
  if (!qrUrl) { toast('QR generate failed: empty QR URL', 'error'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'qr-modal-overlay';
  overlay.id = 'qrModalOverlay';
  overlay.onclick = function(e) { if(e.target===overlay) closeQRModal(); };

  const rawQrUrl = String(qrUrl || '').trim();
  const isImageDataUrl = /^data:image\\//i.test(rawQrUrl);
  const looksLikeBase64Image = !isImageDataUrl
    && rawQrUrl.length > 2048
    && /^[A-Za-z0-9+/\\r\\n]+={0,2}$/.test(rawQrUrl)
    && /^(iVBORw0KGgo|\\/9j\\/|R0lGOD)/.test(rawQrUrl);
  const qrImgUrl = qrKind === 'image' || isImageDataUrl || looksLikeBase64Image
    ? (isImageDataUrl ? rawQrUrl : 'data:image/png;base64,' + rawQrUrl.replace(/\\s+/g, ''))
    : '/qr.svg?data=' + encodeURIComponent(rawQrUrl) + '&_=' + Date.now();

  overlay.innerHTML =
    '<div class="qr-modal">' +
    '<h3>' + (PLATFORM_NAMES[platform]||platform) + ' - Scan QR</h3>' +
    '<img src="' + escHtml(qrImgUrl) + '" alt="QR Code" width="250" height="250" loading="eager" decoding="sync" onerror="this.style.display=\\'none\\';document.getElementById(\\'qrPollStatus\\').textContent=\\'QR image failed to load. Close and try again.\\';document.getElementById(\\'qrPollStatus\\').className=\\'qr-status expired\\';">' +
    '<div class="qr-status" id="qrPollStatus">Waiting for scan...</div>' +
    '<div style="margin-top:14px;display:flex;gap:8px;justify-content:center">' +
    '<button class="btn btn-sm" onclick="closeQRModal()">Cancel</button>' +
    '</div></div>';

  document.body.appendChild(overlay);
  startQRPolling(platform, token);
}

function startQRPolling(platform, token) {
  if (qrPollTimer) clearInterval(qrPollTimer);
  let attempts = 0;
  const maxAttempts = 120; // 4 minutes at 2s intervals

  qrPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) { closeQRModal(); toast('QR expired', 'error'); return; }

    try {
      const res = await auth.authFetch('/admin/cloud-login/' + platform + '/poll?token=' + encodeURIComponent(token));
      const data = await res.json();
      const statusEl = $('qrPollStatus');
      if (!statusEl) { clearInterval(qrPollTimer); return; }

      if (data.status === 'confirmed') {
        statusEl.className = 'qr-status confirmed';
        statusEl.textContent = 'Login successful!';
        clearInterval(qrPollTimer);
        setTimeout(() => { closeQRModal(); loadCloudCredentials(); toast(PLATFORM_NAMES[platform] + ' logged in', 'success'); }, 1000);
      } else if (data.status === 'scanned') {
        statusEl.className = 'qr-status scanned';
        statusEl.textContent = 'Scanned, waiting for confirmation...';
      } else if (data.status === 'expired') {
        statusEl.className = 'qr-status expired';
        statusEl.textContent = 'QR expired. Close and try again.';
        clearInterval(qrPollTimer);
      } else if (data.status === 'error') {
        statusEl.className = 'qr-status expired';
        statusEl.textContent = data.message || 'Error';
        clearInterval(qrPollTimer);
      }
    } catch {}
  }, 2000);
}

function closeQRModal() {
  if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
  const overlay = $('qrModalOverlay');
  if (overlay) overlay.remove();
}

async function showPasswordLogin(platform) {
  const username = prompt(PLATFORM_NAMES[platform] + ' - Username/Email:');
  if (!username) return;
  const password = prompt(PLATFORM_NAMES[platform] + ' - Password:');
  if (!password) return;

  try {
    const res = await auth.authFetch('/admin/cloud-login/' + platform + '/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.success) {
      toast(PLATFORM_NAMES[platform] + ' saved', 'success');
      loadCloudCredentials();
    } else {
      toast(data.message || 'Login failed', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function logoutPlatform(platform) {
  if (!confirm('Logout ' + (PLATFORM_NAMES[platform]||platform) + '?')) return;
  try {
    const res = await auth.authFetch('/admin/cloud-credentials/' + platform, { method: 'DELETE' });
    if (res.ok) {
      toast('Logged out', 'success');
      loadCloudCredentials();
    }
  } catch {}
}

async function manualPasteCredential() {
  const platform = $('manualPlatform').value;
  const rawValue = $('manualCredValue').value.trim();
  if (!rawValue) { toast('Please enter credential value', 'error'); return; }

  // 智能解析：尝试 JSON，否则按 cookie string 处理
  let credential;
  try {
    credential = JSON.parse(rawValue);
    if (typeof credential !== 'object') throw 0;
  } catch {
    // 账号密码平台
    if (PW_PLATFORMS.includes(platform) && rawValue.includes(':')) {
      const [u, ...rest] = rawValue.split(':');
      credential = { username: u, password: rest.join(':') };
    } else {
      credential = { cookie: rawValue };
    }
  }

  try {
    const res = await auth.authFetch('/admin/cloud-credentials/' + platform, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    if (res.ok) {
      $('manualCredValue').value = '';
      toast(PLATFORM_NAMES[platform] + ' saved', 'success');
      loadCloudCredentials();
    } else {
      const e = await res.json();
      toast(e.error || 'Save failed', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}



// ─── 去重配置 ──────────────────────────────────────────────
async function loadDedupConfig() {
  try {
    const res = await auth.authFetch('/admin/dedup-config');
    const cfg = await res.json();
    $('similarDedupCheck').checked = cfg.similarDedup !== false;
    const pct = Math.round((cfg.similarDedupThreshold || 0.85) * 100);
    $('dedupThreshold').value = pct;
    $('dedupThresholdVal').textContent = pct + '%';
  } catch {}
}
async function saveDedupConfig() {
  try {
    const cfg = {
      similarDedup: $('similarDedupCheck').checked,
      similarDedupThreshold: parseInt($('dedupThreshold').value) / 100,
    };
    const res = await auth.authFetch('/admin/dedup-config', {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(cfg)
    });
    if (res.ok) { $('dedupStatus').textContent = '✓'; setTimeout(() => $('dedupStatus').textContent = '', 2000); }
  } catch {}
}

// ─── 分组排序 ──────────────────────────────────────────────
let groupRules = [];
async function loadGroupOrder() {
  try {
    const res = await auth.authFetch('/admin/group-order');
    const cfg = await res.json();
    $('groupOrderEnabled').checked = cfg.enabled;
    $('groupOrderUnmatched').value = cfg.unmatchedPosition || 'after';
    groupRules = cfg.rules || [];
    renderGroupRules();
  } catch {}
}
function renderGroupRules() {
  const container = $('groupOrderRules');
  if (groupRules.length === 0) { container.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">No rules yet</div>'; return; }
  let html = '';
  groupRules.forEach((rule, i) => {
    html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;padding:6px 8px;background:var(--surface-2);border-radius:4px">';
    html += '<span style="font-family:var(--mono);font-size:0.8rem;min-width:20px;color:var(--text-dim)">#' + (i+1) + '</span>';
    html += '<input type="text" value="' + esc(rule.name) + '" onchange="updateGroupRule(' + i + ',\\'name\\',this.value)" class="nt-input" style="width:80px" placeholder="Name">';
    html += '<input type="text" value="' + esc(rule.keywords.join(',')) + '" onchange="updateGroupRule(' + i + ',\\'keywords\\',this.value)" class="nt-input" style="flex:1" placeholder="Keywords (comma-separated)">';
    if (i > 0) html += '<button class="btn btn-sm" onclick="moveGroupRule(' + i + ',-1)">▲</button>';
    if (i < groupRules.length - 1) html += '<button class="btn btn-sm" onclick="moveGroupRule(' + i + ',1)">▼</button>';
    html += '<button class="btn btn-sm" style="color:var(--red)" onclick="removeGroupRule(' + i + ')">✕</button>';
    html += '</div>';
  });
  container.innerHTML = html;
}
function addGroupRule() {
  groupRules.push({ name: '', keywords: [] });
  renderGroupRules();
}
function removeGroupRule(i) { groupRules.splice(i, 1); renderGroupRules(); saveGroupOrder(); }
function moveGroupRule(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= groupRules.length) return;
  [groupRules[i], groupRules[j]] = [groupRules[j], groupRules[i]];
  renderGroupRules(); saveGroupOrder();
}
function updateGroupRule(i, field, value) {
  if (field === 'name') groupRules[i].name = value;
  else if (field === 'keywords') groupRules[i].keywords = value.split(',').map(s => s.trim()).filter(Boolean);
  saveGroupOrder();
}
async function saveGroupOrder() {
  try {
    const cfg = {
      enabled: $('groupOrderEnabled').checked,
      unmatchedPosition: $('groupOrderUnmatched').value,
      rules: groupRules,
    };
    const res = await auth.authFetch('/admin/group-order', {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(cfg)
    });
    if (res.ok) { $('groupOrderStatus').textContent = '✓'; setTimeout(() => $('groupOrderStatus').textContent = '', 2000); }
  } catch {}
}

// ─── 背景设置 ──────────────────────────────────────────────
function onBgTypeChange() {
  const t = $('bgType').value;
  $('bgImageGroup').style.display = t === 'image' ? 'block' : 'none';
  $('bgSolidGroup').style.display = t === 'solid' ? 'block' : 'none';
  $('bgGradientGroup').style.display = t === 'gradient' ? 'block' : 'none';
}
async function loadBgSettings() {
  try {
    const res = await auth.authFetch('/admin/bg-settings');
    if (!res.ok) return;
    const cfg = await res.json();
    $('bgType').value = cfg.type || 'default';
    if (cfg.imageUrl) $('bgImageUrl').value = cfg.imageUrl;
    if (cfg.solidColor) $('bgSolidColor').value = cfg.solidColor;
    if (cfg.gradient) $('bgGradient').value = cfg.gradient;
    onBgTypeChange();
  } catch {}
}
async function saveBgSettings() {
  try {
    const cfg = {
      type: $('bgType').value,
      imageUrl: $('bgImageUrl').value,
      solidColor: $('bgSolidColor').value,
      gradient: $('bgGradient').value,
    };
    const res = await auth.authFetch('/admin/bg-settings', {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(cfg)
    });
    if (res.ok) {
      $('bgStatus').textContent = '✓'; setTimeout(() => $('bgStatus').textContent = '', 2000);
      loadBgFromServer();
loadVersion();
    }
  } catch {}
}

// ─── 聚合日志 ──────────────────────────────────────────────
async function loadAggLogs() {
  try {
    const res = await auth.authFetch('/admin/agg-logs?limit=20&compact=1');
    const data = await res.json();
    const logs = data.logs || [];
    if (logs.length === 0) {
      $('aggLogsList').innerHTML = '<div style="color:var(--text-dim)">No aggregation logs yet.</div>';
      return;
    }
    let html = '';
    logs.forEach(log => {
      const status = log.success ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--red)">✕</span>';
      const time = new Date(log.startTime).toLocaleString();
      const dur = (log.durationMs / 1000).toFixed(1) + 's';
      html += '<div style="padding:8px;margin-bottom:6px;background:var(--surface-2);border-radius:4px;border-left:3px solid ' + (log.success ? 'var(--green)' : 'var(--red)') + '">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
      html += '<span>' + status + ' ' + time + '</span>';
      html += '<span style="font-family:var(--mono);font-size:0.8rem;color:var(--text-dim)">' + dur + '</span>';
      html += '</div>';
      html += '<div style="font-size:0.8rem;color:var(--text-dim);margin-top:4px">';
      html += 'Sources: ' + log.okSources + '/' + log.totalSources + ' OK';
      html += ' &middot; Sites: ' + log.finalSiteCount + ' &middot; Parses: ' + log.finalParseCount + ' &middot; Lives: ' + log.finalLiveCount;
      html += '</div>';
      const addedCount = log.addedSiteCount != null ? log.addedSiteCount : (log.addedSites ? log.addedSites.length : 0);
      const removedCount = log.removedSiteCount != null ? log.removedSiteCount : (log.removedSites ? log.removedSites.length : 0);
      const failedCount = log.failedSourceCount != null ? log.failedSourceCount : (log.failedSources ? log.failedSources.length : 0);
      if (addedCount > 0) {
        const shown = (log.addedSites || []).map(s => s.name || s.key).join(', ');
        html += '<div style="font-size:0.8rem;color:var(--green);margin-top:2px">+ ' + esc(shown) + (log.addedTruncated ? ' … +' + (addedCount - (log.addedSites || []).length) + ' more' : '') + '</div>';
      }
      if (removedCount > 0) {
        const shown = (log.removedSites || []).map(s => s.name || s.key).join(', ');
        html += '<div style="font-size:0.8rem;color:var(--red);margin-top:2px">- ' + esc(shown) + (log.removedTruncated ? ' … +' + (removedCount - (log.removedSites || []).length) + ' more' : '') + '</div>';
      }
      if (failedCount > 0) {
        const shown = (log.failedSources || []).map(s => s.name).join(', ');
        html += '<div style="font-size:0.75rem;color:var(--amber);margin-top:2px">Failed: ' + esc(shown) + (log.failedTruncated ? ' … +' + (failedCount - (log.failedSources || []).length) + ' more' : '') + '</div>';
      }
      if (log.errorMessage) {
        html += '<div style="font-size:0.75rem;color:var(--red);margin-top:2px">Error: ' + esc(log.errorMessage) + '</div>';
      }
      html += '</div>';
    });
    $('aggLogsList').innerHTML = html;
  } catch {}
}
async function clearAggLogs() {
  if (!confirm('Clear all aggregation logs?')) return;
  await auth.authFetch('/admin/agg-logs', { method: 'DELETE' });
  loadAggLogs();
}

function focusManualCredential(platform) {
  const sel = $('manualPlatform');
  const input = $('manualCredValue');
  if (sel) sel.value = platform;
  if (input) input.focus();
  toast((PLATFORM_NAMES[platform] || platform) + ' uses manual credential paste');
}

let liveLogsAbort = null;
function appendLiveLog(entry) {
  const box = $('liveLogsBox');
  if (!box) return;
  const line = entry.ts + ' ' + String(entry.level || '').toUpperCase().padEnd(8) + ' [' + entry.scope + '] ' + entry.message;
  box.textContent += line + '\\n';
  if (box.textContent.length > 80000) box.textContent = box.textContent.slice(-60000);
  box.scrollTop = box.scrollHeight;
}
async function connectLiveLogs() {
  disconnectLiveLogs();
  const status = $('liveLogsStatus');
  const box = $('liveLogsBox');
  if (box) box.textContent = '';
  liveLogsAbort = new AbortController();
  if (status) status.textContent = 'connecting';
  try {
    const res = await fetch('/admin/logs', {
      headers: { 'Authorization': 'Bearer ' + auth.getToken() },
      signal: liveLogsAbort.signal
    });
    if (!res.ok || !res.body) {
      if (status) status.textContent = 'failed';
      return;
    }
    if (status) status.textContent = 'connected';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const frames = pending.split('\\n\\n');
      pending = frames.pop() || '';
      for (const frame of frames) {
        const dataLines = frame.split('\\n').filter(line => line.startsWith('data:'));
        if (dataLines.length === 0) continue;
        const data = dataLines.map(line => line.slice(5).trimStart()).join('\\n');
        try { appendLiveLog(JSON.parse(data)); } catch {}
      }
    }
  } catch {
    if (status && liveLogsAbort) status.textContent = 'disconnected';
  } finally {
    liveLogsAbort = null;
  }
}
function disconnectLiveLogs() {
  if (liveLogsAbort) {
    liveLogsAbort.abort();
    liveLogsAbort = null;
  }
  const status = $('liveLogsStatus');
  if (status) status.textContent = '';
}

// ─── 直播禁用 ──────────────
async function loadLiveDisabled() {
  try {
    const r = await auth.authFetch('/admin/live-disabled');
    const d = await r.json();
    $('liveDisabledCheck').checked = d.disabled;
    updateLiveStrategyState();
  } catch {}
}
function updateLiveStrategyState() {
  const disabled = !!$('liveDisabledCheck')?.checked;
  const options = $('liveStrategyOptions');
  if (options) {
    options.querySelectorAll('input, button').forEach((el) => { el.disabled = disabled; });
  }
  const hint = $('liveStrategyHint');
  if (hint) hint.textContent = disabled ? t('liveStrategyDisabledHint') : '';
}
async function saveLiveDisabled() {
  const disabled = $('liveDisabledCheck').checked;
  const status = $('liveDisabledStatus');
  try {
    const res = await auth.authFetch('/admin/live-disabled', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({disabled}) });
    if (!res.ok) throw new Error('save failed');
    updateLiveStrategyState();
    status.textContent = '✓';
    setTimeout(() => status.textContent = '', 2000);
  } catch {
    await loadLiveDisabled();
    status.textContent = t('saveFailed');
    status.className = 'status-text error';
    setTimeout(() => { status.textContent = ''; status.className = 'status-text'; }, 3000);
  }
}

// ─── 忽略第三方直播源 ───────
async function loadIgnoreAggregatedLives() {
  try {
    const r = await auth.authFetch('/admin/ignore-aggregated-lives');
    const d = await r.json();
    $('ignoreAggregatedLivesCheck').checked = d.ignore;
  } catch {}
}
async function saveIgnoreAggregatedLives() {
  const ignore = $('ignoreAggregatedLivesCheck').checked;
  await auth.authFetch('/admin/ignore-aggregated-lives', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ignore}) });
  $('ignoreAggregatedLivesStatus').textContent = '✓';
  setTimeout(() => $('ignoreAggregatedLivesStatus').textContent = '', 2000);
}

// ─── 直播合并模式 ──────────
async function loadLiveMergeMode() {
  try {
    const r = await auth.authFetch('/admin/live-merge-mode');
    const d = await r.json();
    const mode = d.mode || 'separated';
    $('liveMergeSeparated').classList.toggle('active', mode === 'separated');
    $('liveMergeMerged').classList.toggle('active', mode === 'merged');
    updateLiveStrategyState();
  } catch {}
}
async function setLiveMergeMode(mode) {
  $('liveMergeSeparated').classList.toggle('active', mode === 'separated');
  $('liveMergeMerged').classList.toggle('active', mode === 'merged');
  $('liveMergeModeStatus').textContent = '⏳';
  try {
    await auth.authFetch('/admin/live-merge-mode', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({mode}) });
    $('liveMergeModeStatus').textContent = '✓ 已切换并刷新';
    setTimeout(() => $('liveMergeModeStatus').textContent = '', 3000);
  } catch(e) {
    $('liveMergeModeStatus').textContent = '✗ 失败';
  }
}

// ─── 智能 Base URL ──────────
async function loadSmartBaseUrl() {
  try {
    const r = await auth.authFetch('/admin/smart-base-url');
    const d = await r.json();
    $('smartBaseUrlCheck').checked = d.enabled;
  } catch {}
}
async function saveSmartBaseUrl() {
  const enabled = $('smartBaseUrlCheck').checked;
  await auth.authFetch('/admin/smart-base-url', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({enabled}) });
  $('smartBaseUrlStatus').textContent = '✓';
  setTimeout(() => $('smartBaseUrlStatus').textContent = '', 2000);
}

// ─── 验活深度 ────────────────
async function loadProbeDepth() {
  try {
    const r = await auth.authFetch('/admin/site-probe-depth');
    const d = await r.json();
    $('probeDepthSelect').value = d.depth || 'deep';
  } catch {}
}
async function saveProbeDepth() {
  const depth = $('probeDepthSelect').value;
  await auth.authFetch('/admin/site-probe-depth', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({depth}) });
  $('probeDepthStatus').textContent = '✓';
  setTimeout(() => $('probeDepthStatus').textContent = '', 2000);
}

// ─── 自动清理 ────────────────
async function loadAutoClean() {
  try {
    const r = await auth.authFetch('/admin/site-auto-clean');
    const d = await r.json();
    $('autoCleanCheck').checked = d.enabled;
  } catch {}
}
async function saveAutoClean() {
  const enabled = $('autoCleanCheck').checked;
  await auth.authFetch('/admin/site-auto-clean', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({enabled}) });
  $('autoCleanStatus').textContent = '✓';
  setTimeout(() => $('autoCleanStatus').textContent = '', 2000);
}

// ─── Init shell (data loads on tab activation) ───────
applyTheme(getTheme());
initThemeDropdown();
loadBgFromServer();
loadVersion();
applyLang(translations, getLang());
</script>
</body>
</html>`;
