import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import axios from 'axios';
import urlJoin from 'proper-url-join';
import { getDeployDetails } from '../deploy_details';
import { getUserEmail } from '../services/user_info';

interface SessionMeta {
    fileName: string;
    castFile: string;
    timestamp: string;
    userEmail: string;
    worktree: string;
    logged: boolean;
}

const SESSIONS_DIR = '/workspace/agent-sessions';
const WORKTREES_DIR = '/workspace/worktrees';

/**
 * Start an SSH terminal session to the coding agent for a given worktree.
 * Can be called from the panel or directly.
 */
export async function startAgentSession(
    context: vscode.ExtensionContext,
    worktreeName: string,
): Promise<void> {
    const workspaceName = process.env.HOSTNAME?.replace('-editor', '') || 'workspace';
    const agentHost = `${workspaceName}-coding-agent`;

    // Check if the coding agent container is reachable
    const reachable = await new Promise<boolean>((resolve) => {
        cp.exec(`getent hosts ${agentHost}`, (err) => resolve(!err));
    });

    if (!reachable) {
        const started = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Starting coding agent container...',
            cancellable: false,
        }, async (progress) => {
            const details = await getDeployDetails(context);
            if (!details) { return false; }

            try {
                const url = urlJoin(details.deployUrl, 'worktrees', 'coding-agent', 'ensure');
                await axios.post(url, {}, {
                    headers: { Authorization: `Bearer ${details.deploySecret}` },
                    timeout: 120000,
                });
            } catch (err: any) {
                const msg = err?.response?.data?.detail || err?.message || err;
                vscode.window.showErrorMessage(`Failed to start coding agent: ${msg}`);
                return false;
            }

            progress.report({ message: 'Waiting for SSH to become ready...' });
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const ready = await new Promise<boolean>((resolve) => {
                    cp.exec(`getent hosts ${agentHost}`, (err) => resolve(!err));
                });
                if (ready) { return true; }
            }

            vscode.window.showErrorMessage('Coding agent started but SSH is not reachable yet. Try again in a few seconds.');
            return false;
        });

        if (!started) { return; }
    }

    const userEmail = await getUserEmail(context) || 'unknown';

    const terminal = vscode.window.createTerminal({
        name: `Agent: ${worktreeName}`,
        shellPath: '/usr/bin/ssh',
        shellArgs: [
            '-i', '/workspace/.ssh/id_ed25519',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'SendEnv=SSH_USER_EMAIL SSH_LOGGED SSH_WORKTREE',
            `agent@${agentHost}`,
        ],
        env: {
            SSH_USER_EMAIL: userEmail,
            SSH_LOGGED: 'true',
            SSH_WORKTREE: worktreeName,
        },
    });
    terminal.show(true);
}

export class AgentSessionPanel {
    private static currentPanel: AgentSessionPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private disposed = false;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;

        const asciinemaDir = vscode.Uri.file(
            path.join(context.extensionPath, 'node_modules', 'asciinema-player', 'dist', 'bundle')
        );

        this.panel = vscode.window.createWebviewPanel(
            'bitswan-agent-sessions',
            'Coding Agents',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [asciinemaDir],
            },
        );

        const webview = this.panel.webview;
        const playerJsUri = webview.asWebviewUri(vscode.Uri.file(
            path.join(context.extensionPath, 'node_modules', 'asciinema-player', 'dist', 'bundle', 'asciinema-player.min.js')
        ));
        const playerCssUri = webview.asWebviewUri(vscode.Uri.file(
            path.join(context.extensionPath, 'node_modules', 'asciinema-player', 'dist', 'bundle', 'asciinema-player.css')
        ));

        this.panel.webview.html = this._getHtmlForWebview(playerJsUri, playerCssUri);

        this.panel.webview.onDidReceiveMessage(
            (msg) => this.onMessage(msg),
            undefined,
            context.subscriptions,
        );

        this.panel.onDidDispose(() => {
            this.disposed = true;
            AgentSessionPanel.currentPanel = undefined;
        });

        this.loadAndSendSessions();
    }

    public static createOrShow(context: vscode.ExtensionContext): void {
        if (AgentSessionPanel.currentPanel && !AgentSessionPanel.currentPanel.disposed) {
            AgentSessionPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        AgentSessionPanel.currentPanel = new AgentSessionPanel(context);
    }

    private async onMessage(msg: any): Promise<void> {
        if (!msg || !msg.type) { return; }

        switch (msg.type) {
            case 'ready':
                this.sendWorktrees();
                await this.loadAndSendSessions();
                break;
            case 'loadSessions':
                await this.loadAndSendSessions();
                break;
            case 'startSession': {
                const worktree = msg.worktree;
                if (!worktree) { return; }
                await startAgentSession(this.context, worktree);
                break;
            }
            case 'createWorktree': {
                await vscode.commands.executeCommand('bitswan.createWorktree');
                this.sendWorktrees();
                break;
            }
            case 'playSession': {
                const castPath = msg.castFile;
                if (!castPath) { return; }
                try {
                    const fullPath = path.join(SESSIONS_DIR, castPath);
                    const castContent = fs.readFileSync(fullPath, 'utf8');
                    this.postMessage({
                        type: 'castData',
                        castFile: castPath,
                        data: castContent,
                    });
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to load session recording: ${error?.message || error}`);
                }
                break;
            }
        }
    }

    private sendWorktrees(): void {
        const worktrees: string[] = [];
        if (fs.existsSync(WORKTREES_DIR)) {
            try {
                for (const entry of fs.readdirSync(WORKTREES_DIR, { withFileTypes: true })) {
                    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'worktrees') {
                        worktrees.push(entry.name);
                    }
                }
            } catch { /* ignore */ }
        }
        this.postMessage({ type: 'worktrees', worktrees });
    }

    private async loadAndSendSessions(): Promise<void> {
        const sessions = this.scanSessions();
        this.postMessage({ type: 'sessions', sessions });
    }

    private scanSessions(): SessionMeta[] {
        const sessions: SessionMeta[] = [];
        if (!fs.existsSync(SESSIONS_DIR)) { return sessions; }

        try {
            const entries = fs.readdirSync(SESSIONS_DIR);
            const metaFiles = entries.filter(e => e.endsWith('.meta.json'));

            for (const metaFile of metaFiles) {
                try {
                    const fullPath = path.join(SESSIONS_DIR, metaFile);
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const meta = JSON.parse(content);
                    const baseName = metaFile.replace('.meta.json', '');
                    const castFile = baseName + '.cast';
                    if (!fs.existsSync(path.join(SESSIONS_DIR, castFile))) { continue; }

                    sessions.push({
                        fileName: metaFile,
                        castFile,
                        timestamp: meta.timestamp || meta.started_at || meta.start_time || '',
                        userEmail: meta.user_email || meta.userEmail || '',
                        worktree: meta.worktree || '',
                        logged: meta.logged !== false,
                    });
                } catch { /* skip malformed */ }
            }
        } catch { /* directory read failed */ }

        sessions.sort((a, b) => {
            const ta = new Date(a.timestamp).getTime() || 0;
            const tb = new Date(b.timestamp).getTime() || 0;
            return tb - ta;
        });
        return sessions;
    }

    private postMessage(msg: any): void {
        if (!this.disposed) { this.panel.webview.postMessage(msg); }
    }

    private _getHtmlForWebview(playerJsUri: vscode.Uri, playerCssUri: vscode.Uri): string {
        return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        :root {
            color-scheme: light dark;
            font-family: var(--vscode-font-family, sans-serif);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0; padding: 0; font-size: 13px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            display: flex; flex-direction: column;
            height: 100vh; overflow: hidden;
        }
        .header {
            display: flex; align-items: center; gap: 12px;
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            flex-shrink: 0;
        }
        .header h2 { margin: 0; font-size: 16px; }
        .worktree-buttons {
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0;
        }
        .btn {
            padding: 6px 14px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 6px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer; font-size: 12px; white-space: nowrap;
        }
        .btn:hover { opacity: 0.9; }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
            color: var(--vscode-button-secondaryForeground, inherit);
        }
        .section-label {
            font-size: 11px; font-weight: 600; text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            padding: 12px 16px 4px; letter-spacing: 0.5px;
        }
        .content { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
        table { width: 100%; border-collapse: collapse; }
        th {
            text-align: left; padding: 8px 12px;
            background: var(--vscode-editor-background);
            border-bottom: 2px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            font-size: 12px; font-weight: 600;
            position: sticky; top: 0; z-index: 1;
        }
        td {
            padding: 6px 12px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
            font-size: 12px;
        }
        tr:hover td { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
        .play-btn {
            padding: 3px 10px; border: none; border-radius: 4px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer; font-size: 11px;
        }
        .player-container { display: none; flex-direction: column; flex: 1; min-height: 0; }
        .player-container.active { display: flex; }
        .player-header {
            display: flex; align-items: center; gap: 12px;
            padding: 8px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
        }
        #player-wrapper {
            flex: 1; overflow: auto; padding: 8px;
            min-height: 400px;
        }
        #player-wrapper .ap-wrapper {
            width: 100% !important;
        }
        .session-list { display: block; }
        .session-list.hidden { display: none; }
        .placeholder { padding: 24px 16px; text-align: center; color: var(--vscode-descriptionForeground); }
    </style>
    <link rel="stylesheet" type="text/css" href="${playerCssUri}" />
</head>
<body>
    <div class="header"><h2>Coding Agents</h2></div>

    <div class="worktree-buttons" id="worktreeButtons"></div>

    <div class="content">
        <div class="session-list" id="sessionList">
            <div class="section-label">Session History</div>
            <table>
                <thead>
                    <tr>
                        <th>Timestamp</th>
                        <th>User</th>
                        <th>Worktree</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody id="sessionsBody"></tbody>
            </table>
            <div class="placeholder" id="placeholder">Loading sessions...</div>
        </div>

        <div class="player-container" id="playerContainer">
            <div class="player-header">
                <button class="btn btn-secondary" id="backBtn">Back</button>
                <span id="playerTitle"></span>
            </div>
            <div id="player-wrapper"></div>
        </div>
    </div>

    <script src="${playerJsUri}"></script>
    <script>
        const vscodeApi = acquireVsCodeApi();
        const sessionsBody = document.getElementById('sessionsBody');
        const placeholder = document.getElementById('placeholder');
        const sessionList = document.getElementById('sessionList');
        const playerContainer = document.getElementById('playerContainer');
        const playerWrapper = document.getElementById('player-wrapper');
        const playerTitle = document.getElementById('playerTitle');
        const backBtn = document.getElementById('backBtn');
        const worktreeButtons = document.getElementById('worktreeButtons');

        let allSessions = [];

        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        function renderWorktreeButtons(worktrees) {
            worktreeButtons.innerHTML = '';
            worktrees.forEach(function(wt) {
                var btn = document.createElement('button');
                btn.className = 'btn';
                btn.textContent = wt;
                btn.addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'startSession', worktree: wt });
                });
                worktreeButtons.appendChild(btn);
            });
            var createBtn = document.createElement('button');
            createBtn.className = 'btn btn-secondary';
            createBtn.textContent = '+ New Worktree';
            createBtn.addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'createWorktree' });
            });
            worktreeButtons.appendChild(createBtn);
        }

        function renderSessions() {
            sessionsBody.innerHTML = '';
            if (allSessions.length === 0) {
                placeholder.textContent = 'No recorded sessions yet.';
                placeholder.style.display = 'block';
                return;
            }
            placeholder.style.display = 'none';

            allSessions.forEach(function(session) {
                var tr = document.createElement('tr');
                tr.innerHTML =
                    '<td>' + escapeHtml(session.timestamp || 'N/A') + '</td>' +
                    '<td>' + escapeHtml(session.userEmail || 'N/A') + '</td>' +
                    '<td>' + escapeHtml(session.worktree || 'N/A') + '</td>' +
                    '<td><button class="play-btn" data-cast="' + escapeHtml(session.castFile) + '">Play</button></td>';
                sessionsBody.appendChild(tr);
            });
        }

        sessionsBody.addEventListener('click', function(e) {
            var btn = e.target.closest('.play-btn');
            if (!btn) return;
            var castFile = btn.dataset.cast;
            if (castFile) {
                sessionList.classList.add('hidden');
                playerContainer.classList.add('active');
                playerTitle.textContent = 'Loading...';
                vscodeApi.postMessage({ type: 'playSession', castFile: castFile });
            }
        });

        backBtn.addEventListener('click', function() {
            playerContainer.classList.remove('active');
            sessionList.classList.remove('hidden');
            playerWrapper.innerHTML = '';
        });

        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg || !msg.type) return;
            switch (msg.type) {
                case 'worktrees':
                    renderWorktreeButtons(msg.worktrees || []);
                    break;
                case 'sessions':
                    allSessions = msg.sessions || [];
                    renderSessions();
                    break;
                case 'castData':
                    playerTitle.textContent = msg.castFile || 'Playback';
                    playerWrapper.innerHTML = '';
                    try {
                        AsciinemaPlayer.create(
                            { data: msg.data },
                            playerWrapper,
                            { autoPlay: true, terminalFontSize: '13px' }
                        );
                    } catch (err) {
                        playerWrapper.textContent = 'Player error: ' + String(err);
                    }
                    break;
            }
        });

        vscodeApi.postMessage({ type: 'ready' });
    </script>
</body>
</html>
        `;
    }
}
