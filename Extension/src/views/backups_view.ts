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

        tabBar.addEventListener('click', function(e) {
            var tab = e.target.closest('.tab');
            if (!tab) return;
            currentTab = tab.dataset.tab;
            tabBar.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            render();
            if (currentTab === 'snapshots') vscodeApi.postMessage({ type: 'loadSnapshots' });
            if (currentTab === 'config') vscodeApi.postMessage({ type: 'loadConfig' });
        });

        function render() {
            if (currentTab === 'config') renderConfig();
            else if (currentTab === 'snapshots') renderSnapshots();
            else if (currentTab === 'key') renderKey();
        }

        function renderConfig() {
            var c = configData || {};
            content.innerHTML = '<div id="statusMsg">' + statusMsg + '</div>' +
                '<div class="field"><label>S3 Endpoint</label><input id="s3Endpoint" value="' + (c.s3_endpoint||'') + '" placeholder="https://s3.amazonaws.com"></div>' +
                '<div class="field"><label>S3 Bucket</label><input id="s3Bucket" value="' + (c.s3_bucket||'') + '" placeholder="my-backups"></div>' +
                '<div class="field"><label>Access Key</label><input id="s3AccessKey" value="' + (c.s3_access_key||'') + '"></div>' +
                '<div class="field"><label>Secret Key</label><input id="s3SecretKey" type="password" value="" placeholder="' + (c.configured ? '(unchanged)' : '') + '"></div>' +
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
                html += '<div class="placeholder">No snapshots found.</div>';
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
            document.getElementById('deleteS3Btn').addEventListener('click', function() {
                if (confirm('Delete the encryption key from S3? The local copy will remain so backups can still run. If this server is lost and you have not downloaded the key, all backups become unrecoverable.')) {
                    vscodeApi.postMessage({ type: 'deleteKeyFromS3' });
                }
            });
        }

        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg || !msg.type) return;
            statusMsg = '';
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
                    statusMsg = '<div class="success">Backup completed: ' + JSON.stringify(msg.data) + '</div>';
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
                    render();
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
