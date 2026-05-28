import * as vscode from 'vscode';
import axios from 'axios';
import urlJoin from 'proper-url-join';
import { getDeployDetails } from '../deploy_details';

export class BackupsPanel {
    private static currentPanel: BackupsPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private disposed = false;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;

        this.panel = vscode.window.createWebviewPanel(
            'bitswan-backups',
            'Backups',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        this.panel.webview.html = this._getHtmlForWebview();

        this.panel.webview.onDidReceiveMessage(
            (msg) => this.onMessage(msg),
            undefined,
            context.subscriptions,
        );

        this.panel.onDidDispose(() => {
            this.disposed = true;
            BackupsPanel.currentPanel = undefined;
        });
    }

    public static createOrShow(context: vscode.ExtensionContext): void {
        if (BackupsPanel.currentPanel && !BackupsPanel.currentPanel.disposed) {
            BackupsPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        BackupsPanel.currentPanel = new BackupsPanel(context);
    }

    private async onMessage(msg: any): Promise<void> {
        if (!msg || !msg.type) { return; }
        const details = await getDeployDetails(this.context);
        if (!details) {
            this.postMessage({ type: 'error', message: 'No deploy details configured' });
            return;
        }
        const baseUrl = details.deployUrl;
        const headers = { Authorization: `Bearer ${details.deploySecret}` };

        try {
            switch (msg.type) {
                case 'ready':
                case 'loadConfig': {
                    const resp = await axios.get(urlJoin(baseUrl, 'backups', 'config'), { headers });
                    this.postMessage({ type: 'config', data: resp.data });
                    break;
                }
                case 'saveConfig': {
                    await axios.post(urlJoin(baseUrl, 'backups', 'config'), msg.config, { headers });
                    this.postMessage({ type: 'configSaved' });
                    const resp = await axios.get(urlJoin(baseUrl, 'backups', 'config'), { headers });
                    this.postMessage({ type: 'config', data: resp.data });
                    break;
                }
                case 'getKey': {
                    const resp = await axios.get(urlJoin(baseUrl, 'backups', 'key'), { headers });
                    this.postMessage({ type: 'key', data: resp.data });
                    break;
                }
                case 'checkKeyS3': {
                    const resp = await axios.get(urlJoin(baseUrl, 'backups', 'key', 's3-status'), { headers });
                    this.postMessage({ type: 'keyS3Status', data: resp.data });
                    break;
                }
                case 'deleteKeyFromS3': {
                    await axios.delete(urlJoin(baseUrl, 'backups', 'key', 's3'), { headers });
                    this.postMessage({ type: 'keyDeletedFromS3' });
                    break;
                }
                case 'uploadKeyToS3': {
                    await axios.post(urlJoin(baseUrl, 'backups', 'key', 'upload-to-s3'), {}, { headers });
                    this.postMessage({ type: 'keyUploadedToS3' });
                    break;
                }
                case 'runBackup': {
                    this.postMessage({ type: 'backupStarted' });
                    const resp = await axios.post(urlJoin(baseUrl, 'backups', 'run'), {}, { headers, timeout: 600000 });
                    this.postMessage({ type: 'backupResult', data: resp.data });
                    break;
                }
                case 'loadSnapshots': {
                    const url = msg.tag
                        ? urlJoin(baseUrl, 'backups', 'snapshots', `?tag=${msg.tag}`)
                        : urlJoin(baseUrl, 'backups', 'snapshots');
                    const resp = await axios.get(url, { headers });
                    this.postMessage({ type: 'snapshots', data: resp.data });
                    break;
                }
                case 'restore': {
                    const resp = await axios.post(
                        urlJoin(baseUrl, 'backups', 'restore', msg.service),
                        { snapshot_id: msg.snapshotId, stage: msg.stage || 'production' },
                        { headers, timeout: 600000 }
                    );
                    this.postMessage({ type: 'restoreResult', data: resp.data });
                    break;
                }

                // ── Stage Snapshots ──────────────────────────────────────────
                case 'loadStageSnapshots': {
                    const resp = await axios.get(urlJoin(baseUrl, 'snapshots'), { headers });
                    this.postMessage({ type: 'stageSnapshots', data: resp.data });
                    break;
                }
                case 'createStageSnapshot': {
                    const body: any = { source_stage: msg.source_stage };
                    if (msg.name) { body.name = msg.name; }
                    if (msg.worktree) { body.worktree = msg.worktree; }
                    const resp = await axios.post(urlJoin(baseUrl, 'snapshots'), body, { headers });
                    this.postMessage({ type: 'stageSnapshotTaskStarted', data: resp.data });
                    break;
                }
                case 'deleteStageSnapshot': {
                    const resp = await axios.delete(urlJoin(baseUrl, 'snapshots', msg.snapshot_id), { headers });
                    this.postMessage({ type: 'stageSnapshotTaskStarted', data: resp.data });
                    break;
                }
                case 'cloneStageSnapshot': {
                    const cloneBody: any = {
                        confirm_destination_is_production: msg.confirm_production ?? false,
                    };
                    if (msg.target_worktree) {
                        cloneBody.target_worktree = msg.target_worktree;
                    } else {
                        cloneBody.target_stage = msg.target_stage;
                    }
                    const resp = await axios.post(
                        urlJoin(baseUrl, 'snapshots', msg.snapshot_id, 'clone'),
                        cloneBody,
                        { headers },
                    );
                    this.postMessage({ type: 'stageSnapshotTaskStarted', data: resp.data });
                    break;
                }
                case 'loadWorktrees': {
                    const resp = await axios.get(urlJoin(baseUrl, 'worktrees'), { headers });
                    // /worktrees returns a list of dicts with `name`. Pass through.
                    this.postMessage({ type: 'worktrees', data: resp.data });
                    break;
                }
                case 'pollStageSnapshotTasks': {
                    const resp = await axios.get(urlJoin(baseUrl, 'snapshots', 'tasks'), { headers });
                    this.postMessage({ type: 'stageSnapshotTasks', data: resp.data });
                    break;
                }
                case 'resumeStageSnapshotTarget': {
                    await axios.post(
                        urlJoin(baseUrl, 'snapshots', 'tasks', msg.task_id, 'resume-target'),
                        {},
                        { headers },
                    );
                    this.postMessage({ type: 'stageSnapshotResumed' });
                    break;
                }
            }
        } catch (err: any) {
            const detail = err?.response?.data?.detail || err?.message || String(err);
            this.postMessage({ type: 'error', message: detail });
        }
    }

    private postMessage(msg: any): void {
        if (!this.disposed) { this.panel.webview.postMessage(msg); }
    }

    private _getHtmlForWebview(): string {
        return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        :root { color-scheme: light dark; font-family: var(--vscode-font-family, sans-serif); }
        * { box-sizing: border-box; }
        body { margin:0; padding:0; font-size:13px; color:var(--vscode-foreground); background:var(--vscode-editor-background); display:flex; flex-direction:column; height:100vh; overflow:hidden; }
        .header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3)); flex-shrink:0; }
        .header h2 { margin:0; font-size:16px; }
        .tab-bar { display:flex; border-bottom:2px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3)); flex-shrink:0; padding:0 8px; }
        .tab { padding:8px 16px; cursor:pointer; font-size:12px; font-weight:500; border-bottom:2px solid transparent; margin-bottom:-2px; color:var(--vscode-descriptionForeground); }
        .tab:hover { color:var(--vscode-foreground); }
        .tab.active { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder, #007acc); }
        .content { flex:1; overflow-y:auto; padding:16px; }
        .field { margin-bottom:12px; }
        .field label { display:block; font-size:11px; font-weight:600; margin-bottom:4px; color:var(--vscode-descriptionForeground); text-transform:uppercase; letter-spacing:0.5px; }
        .field input, .field select { width:100%; padding:6px 8px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, rgba(128,128,128,0.4)); border-radius:6px; font-size:12px; }
        .btn { padding:6px 14px; border:1px solid var(--vscode-button-border, transparent); border-radius:6px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); cursor:pointer; font-size:12px; }
        .btn:hover { opacity:0.9; }
        .btn-danger { background:#f85149; }
        .btn-secondary { background:var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); color:var(--vscode-button-secondaryForeground, inherit); }
        .btn-row { display:flex; gap:8px; margin-top:12px; }
        .warning { background:rgba(248,81,73,0.1); border:1px solid rgba(248,81,73,0.3); border-radius:6px; padding:10px 12px; margin:12px 0; font-size:12px; }
        .success { background:rgba(63,185,80,0.1); border:1px solid rgba(63,185,80,0.3); border-radius:6px; padding:10px 12px; margin:12px 0; font-size:12px; }
        .info { background:rgba(56,132,244,0.1); border:1px solid rgba(56,132,244,0.3); border-radius:6px; padding:10px 12px; margin:12px 0; font-size:12px; }
        table { width:100%; border-collapse:collapse; }
        th { text-align:left; padding:8px 12px; border-bottom:2px solid var(--vscode-editorWidget-border); font-size:12px; font-weight:600; }
        td { padding:6px 12px; border-bottom:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15)); font-size:12px; }
        tr:hover td { background:var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
        .placeholder { padding:24px 16px; text-align:center; color:var(--vscode-descriptionForeground); }
        .key-display { font-family:monospace; background:var(--vscode-input-background); padding:8px 12px; border-radius:6px; word-break:break-all; margin:8px 0; user-select:all; }
        #statusMsg { margin:8px 0; }
    </style>
</head>
<body>
    <div class="header"><h2>Backups</h2></div>
    <div class="tab-bar">
        <div class="tab active" data-tab="snapshots">Snapshots</div>
        <div class="tab" data-tab="stage-snapshots">Stage Snapshots</div>
        <div class="tab" data-tab="config">Configuration</div>
        <div class="tab" data-tab="key">Encryption Key</div>
    </div>
    <div class="content" id="content"></div>
    <script>
        const vscodeApi = acquireVsCodeApi();
        const content = document.getElementById('content');
        const tabBar = document.querySelector('.tab-bar');
        let currentTab = 'snapshots';
        let configData = null;
        let snapshotsData = [];
        let statusMsg = '';

        let stageSnapshotsData = [];
        let stageSnapshotTasks = [];
        let stageSnapshotPollTimer = null;
        let stageSnapshotStatusMsg = '';
        let worktreesList = [];
        let selectedCreateStage = 'dev';
        let selectedCreateWorktree = '';
        const STAGES = ['dev', 'staging', 'production'];

        tabBar.addEventListener('click', function(e) {
            var tab = e.target.closest('.tab');
            if (!tab) return;
            currentTab = tab.dataset.tab;
            tabBar.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            statusMsg = '';
            stageSnapshotStatusMsg = '';
            render();
            if (currentTab === 'snapshots') vscodeApi.postMessage({ type: 'loadSnapshots' });
            if (currentTab === 'config') vscodeApi.postMessage({ type: 'loadConfig' });
            if (currentTab === 'stage-snapshots') {
                vscodeApi.postMessage({ type: 'loadStageSnapshots' });
                vscodeApi.postMessage({ type: 'loadWorktrees' });
                startStageSnapshotPolling();
            } else {
                stopStageSnapshotPolling();
            }
        });

        function startStageSnapshotPolling() {
            stopStageSnapshotPolling();
            stageSnapshotPollTimer = setInterval(function() {
                vscodeApi.postMessage({ type: 'pollStageSnapshotTasks' });
            }, 2000);
        }

        function stopStageSnapshotPolling() {
            if (stageSnapshotPollTimer !== null) {
                clearInterval(stageSnapshotPollTimer);
                stageSnapshotPollTimer = null;
            }
        }

        function humanSize(bytes) {
            if (!bytes || bytes === 0) return '0 B';
            var units = ['B', 'KB', 'MB', 'GB', 'TB'];
            var i = Math.floor(Math.log(bytes) / Math.log(1024));
            return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[Math.min(i, units.length - 1)];
        }

        function relTime(iso) {
            var diffMs = Date.now() - new Date(iso).getTime();
            var diffMin = Math.round(diffMs / 60000);
            if (diffMin < 1) return 'just now';
            if (diffMin < 60) return diffMin + 'm ago';
            var diffH = Math.round(diffMin / 60);
            if (diffH < 24) return diffH + 'h ago';
            return Math.round(diffH / 24) + 'd ago';
        }

        function stepLabel(step) {
            var labels = {
                queued: 'Queued', estimating_size: 'Estimating size', disk_check: 'Checking disk',
                preparing_dir: 'Preparing', backup_postgres: 'Backing up Postgres',
                backup_couchdb: 'Backing up CouchDB', backup_minio: 'Backing up MinIO',
                writing_manifest: 'Writing manifest', stopping_target_automations: 'Stopping automations',
                restore_postgres: 'Restoring Postgres', restore_couchdb: 'Restoring CouchDB',
                restore_minio: 'Restoring MinIO', starting_target_automations: 'Starting automations',
                cleanup_old: 'Cleanup', done: 'Done', failed: 'Failed',
            };
            return labels[step] || step || '';
        }

        function formatBackupResult(data) {
            var services = ['workspace', 'postgres', 'couchdb', 'minio'];
            var allOk = true;
            var rows = '';
            services.forEach(function(svc) {
                var r = data[svc];
                if (!r) return;
                var ok = r.success;
                if (!ok) allOk = false;
                var icon = ok ? '&#10003;' : '&#10007;';
                var cls = ok ? 'color:#3fb950' : 'color:#f85149';
                var label = svc.charAt(0).toUpperCase() + svc.slice(1);
                var detail = (r.output || '').replace(/\\n/g, '\\n').split('\\n').filter(Boolean);
                var summary = detail[detail.length - 1] || '';
                rows += '<tr><td style="' + cls + ';font-weight:600;width:24px">' + icon + '</td>' +
                    '<td style="font-weight:600">' + label + '</td>' +
                    '<td>' + summary + '</td></tr>';
            });
            var ts = data.timestamp ? '<div style="margin-top:8px;font-size:11px;color:var(--vscode-descriptionForeground)">Completed at ' + data.timestamp.replace('T', ' ').substring(0, 19) + ' UTC</div>' : '';
            var cls = allOk ? 'success' : 'warning';
            return '<div class="' + cls + '">' +
                '<div style="font-weight:600;margin-bottom:8px">Backup ' + (allOk ? 'completed successfully' : 'completed with errors') + '</div>' +
                '<table style="border-collapse:collapse">' + rows + '</table>' +
                ts + '</div>';
        }

        function render() {
            if (currentTab === 'config') renderConfig();
            else if (currentTab === 'snapshots') renderSnapshots();
            else if (currentTab === 'stage-snapshots') renderStageSnapshots();
            else if (currentTab === 'key') renderKey();
        }

        function renderStageSnapshots() {
            var activeTasks = stageSnapshotTasks.filter(function(t) {
                return t.status === 'pending' || t.status === 'running';
            });

            var html = '';

            // Active tasks banner
            if (activeTasks.length > 0) {
                html += '<div style="margin-bottom:12px;">';
                activeTasks.forEach(function(t) {
                    var kindLabel = { create: 'Creating', clone: 'Cloning', delete: 'Deleting' }[t.kind] || t.kind;
                    var step = stepLabel(t.step);
                    var msg = t.message ? ' — ' + t.message : '';
                    html += '<div class="info" style="margin-bottom:6px;">' +
                        '<strong>' + kindLabel + '</strong> <code>' + t.snapshot_id + '</code>' +
                        '<span style="float:right;font-size:11px;color:var(--vscode-descriptionForeground)">' + step + '</span>' +
                        (msg ? '<div style="margin-top:4px;font-size:11px">' + msg + '</div>' : '') +
                    '</div>';
                });
                html += '</div>';
            }

            // Failed tasks with errors
            var failedTasks = stageSnapshotTasks.filter(function(t) { return t.status === 'error'; });
            failedTasks.forEach(function(t) {
                var errText = t.error || 'Unknown error';
                var resumeBtn = (t.kind === 'clone' && t.target_stage)
                    ? ' <button class="btn btn-secondary" style="margin-left:8px;font-size:11px;padding:2px 8px" data-resume-task="' + t.task_id + '">Resume automations</button>'
                    : '';
                html += '<div class="warning" style="margin-bottom:8px;">' +
                    '<strong>' + (t.kind || '') + ' failed</strong>: ' + errText + resumeBtn +
                    '</div>';
            });

            // Toolbar
            html += '<div class="btn-row" style="margin-bottom:16px;align-items:center;">';
            html += '<button class="btn" id="ssRefreshBtn">Refresh</button>';
            html += '<select id="ssCreateStage">' +
                STAGES.map(function(s) {
                    var sel = s === selectedCreateStage ? ' selected' : '';
                    return '<option value="' + s + '"' + sel + '>' + s + '</option>';
                }).join('') +
                '</select>';
            // When dev is selected, show a worktree picker. First option is the
            // whole-dev sentinel; selecting any worktree flips the button label.
            if (selectedCreateStage === 'dev' && worktreesList.length > 0) {
                html += '<select id="ssCreateWorktree">' +
                    '<option value="">— Whole dev stage —</option>' +
                    worktreesList.map(function(w) {
                        var sel = w === selectedCreateWorktree ? ' selected' : '';
                        return '<option value="' + escHtml(w) + '"' + sel + '>⎇ ' + escHtml(w) + '</option>';
                    }).join('') +
                    '</select>';
            }
            var createLabel = (selectedCreateStage === 'dev' && selectedCreateWorktree)
                ? 'Snapshot worktree'
                : 'Snapshot stage';
            html += '<button class="btn" id="ssCreateBtn">' + createLabel + '</button>';
            html += '</div>';

            if (stageSnapshotStatusMsg) {
                html += stageSnapshotStatusMsg;
            }

            if (stageSnapshotsData.length === 0 && activeTasks.length === 0) {
                html += '<div class="placeholder">No stage snapshots yet. Select a stage above and click "Snapshot stage".</div>';
            } else {
                // Group by stage; worktree snapshots get their own per-worktree
                // bucket key like "wt:<name>" so they sort apart from raw dev.
                var groups = {};
                stageSnapshotsData.forEach(function(s) {
                    var key;
                    if (s.source_kind === 'worktree') {
                        key = 'wt:' + (s.worktree || 'unknown');
                    } else {
                        key = 'stage:' + (s.source_stage || 'unknown');
                    }
                    if (!groups[key]) { groups[key] = []; }
                    groups[key].push(s);
                });

                // Render stage groups first, then worktree groups
                var stageKeys = Object.keys(groups).filter(function(k) { return k.indexOf('stage:') === 0; }).sort();
                var worktreeKeys = Object.keys(groups).filter(function(k) { return k.indexOf('wt:') === 0; }).sort();

                stageKeys.concat(worktreeKeys).forEach(function(key) {
                    var isWorktree = key.indexOf('wt:') === 0;
                    var displayName = key.split(':')[1];
                    var headerIcon = isWorktree ? '⎇' : '⬡';
                    var headerLabel = isWorktree ? ('worktree ' + displayName) : displayName;

                    html += '<div style="margin-bottom:20px;">';
                    html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--vscode-descriptionForeground);margin-bottom:6px;display:flex;align-items:center;gap:6px;">' +
                        headerIcon + ' ' + escHtml(headerLabel) + '</div>';
                    html += '<table><thead><tr>' +
                        '<th>Name / ID</th><th>Created</th><th>Size</th><th>Actions</th>' +
                        '</tr></thead><tbody>';

                    groups[key].forEach(function(s) {
                        var label = s.name || s.snapshot_id;
                        var shortId = s.snapshot_id;
                        var size = humanSize(s.sizes_bytes && s.sizes_bytes.total ? s.sizes_bytes.total : 0);
                        var time = relTime(s.created_at);
                        var tooltipParts = [
                            'ID: ' + s.snapshot_id,
                            'Postgres: ' + humanSize(s.sizes_bytes && s.sizes_bytes.postgres ? s.sizes_bytes.postgres : 0),
                        ];
                        if (!isWorktree) {
                            tooltipParts.push('CouchDB:  ' + humanSize(s.sizes_bytes && s.sizes_bytes.couchdb ? s.sizes_bytes.couchdb : 0));
                            tooltipParts.push('MinIO:    ' + humanSize(s.sizes_bytes && s.sizes_bytes.minio ? s.sizes_bytes.minio : 0));
                        }
                        var tooltip = tooltipParts.join('&#10;');

                        // Clone target dropdown: worktree-kind → worktree list,
                        // stage-kind → stage list.
                        var dropdownOptions;
                        if (isWorktree) {
                            dropdownOptions = worktreesList.map(function(w) {
                                return '<option value="' + escHtml(w) + '">⎇ ' + escHtml(w) + '</option>';
                            }).join('');
                            if (!dropdownOptions) {
                                dropdownOptions = '<option value="" disabled>no worktrees</option>';
                            }
                        } else {
                            dropdownOptions = STAGES.map(function(st) {
                                return '<option value="' + st + '">' + st + '</option>';
                            }).join('');
                        }

                        html += '<tr>' +
                            '<td title="' + tooltip + '"><strong>' + escHtml(label) + '</strong>' +
                                (s.name ? '<br><span style="font-size:10px;color:var(--vscode-descriptionForeground)">' + escHtml(shortId) + '</span>' : '') +
                            '</td>' +
                            '<td>' + time + '</td>' +
                            '<td>' + size + '</td>' +
                            '<td style="white-space:nowrap;">' +
                                '<select data-clone-target="' + escHtml(s.snapshot_id) + '" data-clone-kind="' + (isWorktree ? 'worktree' : 'stage') + '" style="font-size:11px;padding:2px 4px;margin-right:4px;">' +
                                    dropdownOptions +
                                '</select>' +
                                '<button class="btn btn-secondary" data-clone="' + escHtml(s.snapshot_id) + '" style="font-size:11px;padding:3px 8px;margin-right:4px;">Clone into</button>' +
                                '<button class="btn btn-danger" data-delete="' + escHtml(s.snapshot_id) + '" style="font-size:11px;padding:3px 8px;">Delete</button>' +
                            '</td>' +
                        '</tr>';
                    });
                    html += '</tbody></table></div>';
                });
            }

            content.innerHTML = html;

            // Wire up toolbar
            var refreshBtn = document.getElementById('ssRefreshBtn');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'loadStageSnapshots' });
                    vscodeApi.postMessage({ type: 'loadWorktrees' });
                });
            }

            var stageSelect = document.getElementById('ssCreateStage');
            if (stageSelect) {
                stageSelect.addEventListener('change', function() {
                    selectedCreateStage = stageSelect.value;
                    // Reset worktree selection when leaving dev
                    if (selectedCreateStage !== 'dev') { selectedCreateWorktree = ''; }
                    render();
                });
            }
            var worktreeSelect = document.getElementById('ssCreateWorktree');
            if (worktreeSelect) {
                worktreeSelect.addEventListener('change', function() {
                    selectedCreateWorktree = worktreeSelect.value;
                    render();
                });
            }

            var createBtn = document.getElementById('ssCreateBtn');
            if (createBtn) {
                createBtn.addEventListener('click', function() {
                    var stage = selectedCreateStage;
                    var wt = (stage === 'dev') ? selectedCreateWorktree : '';
                    var promptLabel = wt
                        ? 'Worktree snapshot name (optional, press Enter to skip):'
                        : 'Snapshot name (optional, press Enter to skip):';
                    var name = prompt(promptLabel);
                    if (name === null) { return; } // cancelled
                    var payload = {
                        type: 'createStageSnapshot',
                        source_stage: stage,
                        name: name.trim() || undefined,
                    };
                    if (wt) { payload.worktree = wt; }
                    vscodeApi.postMessage(payload);
                    stageSnapshotStatusMsg = wt
                        ? '<div class="info">Creating snapshot of worktree <strong>' + escHtml(wt) + '</strong>…</div>'
                        : '<div class="info">Creating snapshot of <strong>' + escHtml(stage) + '</strong>…</div>';
                    render();
                    startStageSnapshotPolling();
                });
            }

            // Wire up clone buttons
            content.querySelectorAll('button[data-clone]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var snapId = btn.getAttribute('data-clone');
                    var select = content.querySelector('select[data-clone-target="' + snapId + '"]');
                    var kind = select ? select.getAttribute('data-clone-kind') : 'stage';
                    var target = select ? select.value : '';
                    if (!target) {
                        alert('Pick a target first.');
                        return;
                    }
                    var confirmProd = false;
                    if (kind === 'worktree') {
                        if (!confirm('Clone snapshot into worktree "' + target + '"?\\n\\nLive-dev automations attached to this worktree will be stopped and the worktree database will be overwritten.')) {
                            return;
                        }
                    } else if (target === 'production') {
                        if (!confirm('⚠️ You are about to clone into PRODUCTION.\\n\\nThis will stop all production automations, overwrite their data, then restart them.\\n\\nContinue?')) {
                            return;
                        }
                        confirmProd = true;
                    } else {
                        if (!confirm('Clone snapshot into "' + target + '"?\\n\\nAutomations on that stage will be stopped temporarily.')) {
                            return;
                        }
                    }
                    var msg = {
                        type: 'cloneStageSnapshot',
                        snapshot_id: snapId,
                        confirm_production: confirmProd,
                    };
                    if (kind === 'worktree') {
                        msg.target_worktree = target;
                    } else {
                        msg.target_stage = target;
                    }
                    vscodeApi.postMessage(msg);
                    var targetLabel = kind === 'worktree' ? ('worktree ' + target) : target;
                    stageSnapshotStatusMsg = '<div class="info">Cloning into <strong>' + escHtml(targetLabel) + '</strong>…</div>';
                    render();
                    startStageSnapshotPolling();
                });
            });

            // Wire up delete buttons
            content.querySelectorAll('button[data-delete]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var snapId = btn.getAttribute('data-delete');
                    if (!confirm('Delete snapshot "' + snapId + '"?\\n\\nThis cannot be undone.')) { return; }
                    vscodeApi.postMessage({ type: 'deleteStageSnapshot', snapshot_id: snapId });
                    stageSnapshotStatusMsg = '<div class="info">Deleting snapshot…</div>';
                    render();
                });
            });

            // Wire up resume buttons
            content.querySelectorAll('button[data-resume-task]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var taskId = btn.getAttribute('data-resume-task');
                    vscodeApi.postMessage({ type: 'resumeStageSnapshotTarget', task_id: taskId });
                    stageSnapshotStatusMsg = '<div class="info">Resuming target automations…</div>';
                    render();
                });
            });
        }

        function escHtml(str) {
            return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function renderConfig() {
            var c = configData || {};
            content.innerHTML = '<div id="statusMsg">' + statusMsg + '</div>' +
                '<div class="field"><label>S3 Endpoint</label><input id="s3Endpoint" value="' + (c.s3_endpoint||'') + '" placeholder="https://s3.amazonaws.com"></div>' +
                '<div class="field"><label>S3 Bucket</label><input id="s3Bucket" value="' + (c.s3_bucket||'') + '" placeholder="my-backups"></div>' +
                '<div class="field"><label>Access Key</label><input id="s3AccessKey" value="' + (c.s3_access_key||'') + '"></div>' +
                '<div class="field"><label>Secret Key</label><input id="s3SecretKey" type="password" value="" placeholder="' + (c.configured ? '(unchanged)' : '') + '"></div>' +
                '<div class="field"><label>Region (optional)</label><input id="s3Region" value="' + (c.s3_region||'') + '" placeholder="e.g. nbg1"></div>' +
                '<div class="field"><label>Daily Retention (days)</label><input id="retDaily" type="number" value="' + (c.retention?.daily||30) + '"></div>' +
                '<div class="field"><label>Monthly Retention (months)</label><input id="retMonthly" type="number" value="' + (c.retention?.monthly||12) + '"></div>' +
                '<div class="btn-row">' +
                '<button class="btn" id="saveBtn">Save Configuration</button>' +
                '<button class="btn btn-secondary" id="backupNowBtn">Backup Now</button>' +
                '</div>';
            document.getElementById('saveBtn').addEventListener('click', function() {
                var sk = document.getElementById('s3SecretKey').value;
                vscodeApi.postMessage({ type: 'saveConfig', config: {
                    s3_endpoint: document.getElementById('s3Endpoint').value,
                    s3_bucket: document.getElementById('s3Bucket').value,
                    s3_access_key: document.getElementById('s3AccessKey').value,
                    s3_secret_key: sk || (c.s3_secret_key || ''),
                    s3_region: document.getElementById('s3Region').value,
                    retention_daily: parseInt(document.getElementById('retDaily').value) || 30,
                    retention_monthly: parseInt(document.getElementById('retMonthly').value) || 12,
                }});
            });
            document.getElementById('backupNowBtn').addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'runBackup' });
            });
        }

        function renderSnapshots() {
            var html = '<div class="btn-row" style="margin-bottom:12px;">' +
                '<button class="btn btn-secondary" id="refreshSnap">Refresh</button>' +
                '<select id="tagFilter"><option value="">All</option><option value="workspace">Workspace</option><option value="postgres">Postgres</option><option value="couchdb">CouchDB</option><option value="minio">MinIO</option></select>' +
                '</div><div id="statusMsg">' + statusMsg + '</div>';
            if (snapshotsData.length === 0) {
                html += '<div class="placeholder">No snapshots found.HELLNO</div>';
            } else {
                html += '<table><thead><tr><th>ID</th><th>Time</th><th>Tags</th><th>Action</th></tr></thead><tbody>';
                snapshotsData.forEach(function(s) {
                    var tags = (s.tags||[]).join(', ');
                    var short_id = (s.short_id || s.id || '').substring(0,8);
                    var time = s.time || '';
                    var service = (s.tags||[]).find(t => ['postgres','couchdb','minio','workspace'].includes(t)) || 'workspace';
                    html += '<tr><td>' + short_id + '</td><td>' + time + '</td><td>' + tags + '</td>' +
                        '<td><button class="btn" data-snap="' + (s.short_id||s.id) + '" data-svc="' + service + '">Restore</button></td></tr>';
                });
                html += '</tbody></table>';
            }
            content.innerHTML = html;
            document.getElementById('refreshSnap').addEventListener('click', function() {
                var tag = document.getElementById('tagFilter').value;
                vscodeApi.postMessage({ type: 'loadSnapshots', tag: tag || undefined });
            });
            content.addEventListener('click', function(e) {
                var btn = e.target.closest('button[data-snap]');
                if (!btn) return;
                var svc = btn.dataset.svc;
                var snap = btn.dataset.snap;
                var stage = 'production';
                if (svc !== 'workspace') {
                    stage = prompt('Restore to which stage? (production, dev, staging)', 'production');
                    if (!stage) return;
                }
                vscodeApi.postMessage({ type: 'restore', service: svc, snapshotId: snap, stage: stage });
            });
        }

        function renderKey() {
            content.innerHTML = '<div id="statusMsg">' + statusMsg + '</div>' +
                '<div class="info">The encryption key lives on this server and is also stored on S3 by default. ' +
                'Download it to a password manager for safekeeping. You can delete the S3 copy so a compromised S3 store cannot decrypt backups.</div>' +
                '<div class="btn-row">' +
                '<button class="btn" id="downloadKeyBtn">Download Key</button>' +
                '<button class="btn btn-secondary" id="checkS3Btn">Check S3 Status</button>' +
                '</div>' +
                '<div class="btn-row" style="margin-top:8px;">' +
                '<button class="btn btn-secondary" id="uploadS3Btn">Upload Key to S3</button>' +
                '<button class="btn btn-danger" id="deleteS3Btn">Delete Key from S3</button>' +
                '</div>' +
                '<div id="keyDisplay"></div>';
            document.getElementById('downloadKeyBtn').addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'getKey' });
            });
            document.getElementById('checkS3Btn').addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'checkKeyS3' });
            });
            document.getElementById('uploadS3Btn').addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'uploadKeyToS3' });
            });
            var deleteBtn = document.getElementById('deleteS3Btn');
            deleteBtn.addEventListener('click', function() {
                if (deleteBtn.dataset.armed === 'true') {
                    deleteBtn.dataset.armed = 'false';
                    deleteBtn.textContent = 'Delete Key from S3';
                    vscodeApi.postMessage({ type: 'deleteKeyFromS3' });
                } else {
                    deleteBtn.dataset.armed = 'true';
                    deleteBtn.textContent = 'Click again to confirm deletion';
                    setTimeout(function() {
                        if (deleteBtn.dataset.armed === 'true') {
                            deleteBtn.dataset.armed = 'false';
                            deleteBtn.textContent = 'Delete Key from S3';
                        }
                    }, 5000);
                }
            });
        }

        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg || !msg.type) return;
            switch (msg.type) {
                case 'config':
                    configData = msg.data;
                    if (currentTab === 'config') render();
                    break;
                case 'configSaved':
                    statusMsg = '<div class="success">Configuration saved and repository initialized.</div>';
                    render();
                    break;
                case 'key':
                    var kd = document.getElementById('keyDisplay');
                    if (kd) kd.innerHTML = '<div class="key-display">' + msg.data.key + '</div><div class="info">Copy this key and store it securely. You can delete it from the server after saving it.</div>';
                    break;
                case 'keyS3Status':
                    var kd2 = document.getElementById('keyDisplay');
                    if (kd2) kd2.innerHTML = msg.data.on_s3
                        ? '<div class="success">Key exists on S3.</div>'
                        : '<div class="warning">Key is NOT on S3. Only the local copy exists.</div>';
                    break;
                case 'keyDeletedFromS3':
                    statusMsg = '<div class="warning">Key deleted from S3. Local copy still exists.</div>';
                    render();
                    break;
                case 'keyUploadedToS3':
                    statusMsg = '<div class="success">Key uploaded to S3.</div>';
                    render();
                    break;
                case 'backupStarted':
                    statusMsg = '<div class="info">Backup running... this may take several minutes.</div>';
                    render();
                    break;
                case 'backupResult':
                    statusMsg = formatBackupResult(msg.data);
                    render();
                    break;
                case 'snapshots':
                    snapshotsData = msg.data.snapshots || [];
                    if (currentTab === 'snapshots') render();
                    break;
                case 'restoreResult':
                    statusMsg = '<div class="success">' + msg.data.message + '</div>';
                    render();
                    break;
                case 'error':
                    statusMsg = '<div class="warning">' + msg.message + '</div>';
                    stageSnapshotStatusMsg = '<div class="warning">' + msg.message + '</div>';
                    render();
                    break;

                // ── Stage Snapshots ───────────────────────────────────────────
                case 'stageSnapshots':
                    stageSnapshotsData = msg.data.snapshots || [];
                    stageSnapshotTasks = msg.data.tasks || [];
                    if (currentTab === 'stage-snapshots') { render(); }
                    break;
                case 'stageSnapshotTaskStarted':
                    // Kick off a refresh so the new task appears immediately
                    vscodeApi.postMessage({ type: 'loadStageSnapshots' });
                    break;
                case 'stageSnapshotTasks':
                    stageSnapshotTasks = Array.isArray(msg.data) ? msg.data : [];
                    // When all tasks finish, reload the snapshot list and clear status
                    var anyActive = stageSnapshotTasks.some(function(t) {
                        return t.status === 'pending' || t.status === 'running';
                    });
                    if (!anyActive) {
                        stopStageSnapshotPolling();
                        stageSnapshotStatusMsg = '';
                        vscodeApi.postMessage({ type: 'loadStageSnapshots' });
                    } else if (currentTab === 'stage-snapshots') {
                        render();
                    }
                    break;
                case 'stageSnapshotResumed':
                    stageSnapshotStatusMsg = '<div class="success">Automations restarted.</div>';
                    vscodeApi.postMessage({ type: 'loadStageSnapshots' });
                    break;
                case 'worktrees':
                    worktreesList = (Array.isArray(msg.data) ? msg.data : [])
                        .map(function(w) { return (w && w.name) ? w.name : ''; })
                        .filter(function(n) { return !!n; });
                    if (currentTab === 'stage-snapshots') { render(); }
                    break;
            }
        });

        vscodeApi.postMessage({ type: 'loadSnapshots' });
    </script>
</body>
</html>
        `;
    }
}
