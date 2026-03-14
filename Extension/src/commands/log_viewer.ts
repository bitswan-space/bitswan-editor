import * as vscode from 'vscode';
import axios from 'axios';
import urlJoin from 'proper-url-join';
import { GitOpsItem } from '../views/workspaces_view';
import { InspectPanel } from './inspect_panel';

export interface StageInfo {
    stage: string;        // 'live-dev' | 'dev' | 'staging' | 'production'
    deploymentId: string; // e.g., "my-automation-dev"
    deployed: boolean;    // whether this stage has a running automation
}

/** Manages a full-window webview panel that streams automation logs via SSE. */
export class LogViewerPanel {
    private static panels = new Map<string, LogViewerPanel>();

    private panel: vscode.WebviewPanel;
    private abortController: AbortController | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;
    private tailLines: number;
    private deploymentId: string;
    private currentStage: string;
    private stages: StageInfo[];

    private constructor(
        private readonly baseSourceName: string,
        deploymentId: string,
        currentStage: string,
        stages: StageInfo[],
        private readonly gitopsUrl: string,
        private readonly secret: string,
    ) {
        this.deploymentId = deploymentId;
        this.currentStage = currentStage;
        this.stages = stages;
        this.tailLines = 200;

        this.panel = vscode.window.createWebviewPanel(
            'bitswan-log-viewer',
            `Logs: ${baseSourceName}${currentStage ? ` (${currentStage})` : ''}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        this.panel.webview.html = buildLogViewerHtml(baseSourceName, stages, currentStage);

        this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));

        this.panel.onDidDispose(() => {
            this.disposed = true;
            this.disconnect();
            LogViewerPanel.panels.delete(this.baseSourceName);
        });

        this.connect();
    }

    static open(
        baseSourceName: string,
        deploymentId: string,
        currentStage: string,
        stages: StageInfo[],
        gitopsUrl: string,
        secret: string,
    ): LogViewerPanel {
        const existing = LogViewerPanel.panels.get(baseSourceName);
        if (existing && !existing.disposed) {
            if (currentStage && existing.currentStage !== currentStage) {
                existing.switchStage(deploymentId, currentStage);
            }
            existing.panel.reveal(vscode.ViewColumn.Active);
            return existing;
        }
        const viewer = new LogViewerPanel(baseSourceName, deploymentId, currentStage, stages, gitopsUrl, secret);
        LogViewerPanel.panels.set(baseSourceName, viewer);
        return viewer;
    }

    private switchStage(newDeploymentId: string, newStage: string) {
        this.deploymentId = newDeploymentId;
        this.currentStage = newStage;
        this.postMessage({ type: 'clear' });
        this.postMessage({ type: 'stageChanged', stage: newStage });
        this.connect();
        this.panel.title = `Logs: ${this.baseSourceName}${newStage ? ` (${newStage})` : ''}`;
    }

    /* ---- SSE streaming ---- */

    private async connect(retryCount = 0) {
        if (this.disposed) { return; }
        this.disconnect();

        this.postMessage({ type: 'status', status: retryCount > 0 ? 'reconnecting' : 'connecting' });

        const streamUrl = urlJoin(
            this.gitopsUrl, 'automations', this.deploymentId, 'logs', 'stream',
        ).toString();

        const controller = new AbortController();
        this.abortController = controller;

        // Guard: only act if this controller is still current (not replaced by a newer connect/disconnect)
        const isCurrent = () => !this.disposed && this.abortController === controller;

        try {
            const response = await axios.get(streamUrl, {
                headers: { Authorization: `Bearer ${this.secret}` },
                params: { lines: this.tailLines },
                responseType: 'stream',
                signal: controller.signal,
            });

            if (!isCurrent()) { return; }

            this.postMessage({ type: 'status', status: 'connected' });

            const stream = response.data as NodeJS.ReadableStream;
            let buffer = '';

            stream.on('data', (chunk: Buffer) => {
                if (!isCurrent()) { return; }
                buffer += chunk.toString();
                const parts = buffer.split('\n\n');
                buffer = parts.pop() || '';

                for (const part of parts) {
                    if (!part.trim()) { continue; }
                    this.handleSSEMessage(part);
                }
            });

            stream.on('end', () => {
                if (isCurrent()) {
                    this.scheduleReconnect(retryCount);
                }
            });

            stream.on('error', (_err: Error) => {
                if (isCurrent()) {
                    this.scheduleReconnect(retryCount);
                }
            });
        } catch (err: any) {
            if (axios.isCancel(err) || !isCurrent()) { return; }
            this.scheduleReconnect(retryCount);
        }
    }

    private scheduleReconnect(previousRetries: number) {
        if (this.disposed) { return; }
        const delay = Math.min(1000 * Math.pow(2, previousRetries), 30000);
        this.postMessage({ type: 'status', status: 'reconnecting' });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.postMessage({ type: 'clear' });
            this.connect(previousRetries + 1);
        }, delay);
    }

    private disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    private handleSSEMessage(raw: string) {
        let eventType = 'message';
        let data = '';

        for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
                data += line.slice(6);
            } else if (line.startsWith(': ')) {
                // comment / keepalive — ignore
                return;
            }
        }

        if (!data) { return; }

        try {
            const parsed = JSON.parse(data);
            this.postMessage({ type: `sse:${eventType}`, ...parsed });
        } catch {
            this.postMessage({ type: `sse:${eventType}`, raw: data });
        }
    }

    /* ---- Webview message handling ---- */

    private onMessage(msg: any) {
        if (!msg || !msg.type) { return; }

        switch (msg.type) {
            case 'requestMoreLines': {
                this.tailLines = Math.min(this.tailLines * 5, 10000);
                this.postMessage({ type: 'clear' });
                this.connect();
                break;
            }
            case 'copySuccess':
                vscode.window.showInformationMessage('Logs copied to clipboard');
                break;
            case 'copyFailure':
                vscode.window.showErrorMessage(`Failed to copy logs: ${msg.message || 'Unknown error'}`);
                break;
            case 'searchNotFound':
                if (msg.query) {
                    vscode.window.showWarningMessage(`"${msg.query}" not found in logs`);
                }
                break;
            case 'switchStage': {
                const stageInfo = this.stages.find(s => s.stage === msg.stage);
                if (stageInfo && stageInfo.deployed) {
                    this.switchStage(stageInfo.deploymentId, stageInfo.stage);
                }
                break;
            }
            case 'requestInspect':
                InspectPanel.open(this.deploymentId, this.gitopsUrl, this.secret);
                break;
        }
    }

    private postMessage(msg: any) {
        if (!this.disposed) {
            this.panel.webview.postMessage(msg);
        }
    }
}

/* ---- Utility ---- */

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

function buildLogViewerHtml(automationName: string, stages: StageInfo[], currentStage: string): string {
    const stageDisplayNames: Record<string, string> = {
        'live-dev': 'Live Dev',
        'dev': 'Dev',
        'staging': 'Staging',
        'production': 'Production',
    };

    const stageChipsHtml = stages.map(s => {
        const displayName = stageDisplayNames[s.stage] || s.stage;
        const classes = ['stage-chip'];
        if (s.stage === currentStage) { classes.push('active'); }
        if (!s.deployed) { classes.push('disabled'); }
        return `<button class="${classes.join(' ')}" data-stage="${escapeHtml(s.stage)}">${escapeHtml(displayName)}</button>`;
    }).join('\n            ');

    const showStageBar = stages.length > 1;
    return /* html */ `
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
            margin: 0; padding: 0;
            font-size: 13px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            display: flex; flex-direction: column;
            height: 100vh; overflow: hidden;
        }

        /* Header bar */
        .header {
            display: flex; align-items: center; gap: 12px;
            padding: 8px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            flex-shrink: 0;
        }
        .header h2 { margin: 0; font-size: 14px; white-space: nowrap; }
        .status-dot {
            width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        }
        .status-dot.connected    { background: #3fb950; }
        .status-dot.connecting   { background: #d29922; }
        .status-dot.reconnecting { background: #d29922; animation: pulse 1s infinite; }
        .status-dot.disconnected { background: #f85149; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        .status-text { font-size: 11px; color: var(--vscode-descriptionForeground); }
        .replica-count { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: auto; }

        /* Controls bar */
        .controls {
            display: flex; align-items: center; gap: 8px;
            padding: 6px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            flex-shrink: 0; flex-wrap: wrap;
        }
        .controls input {
            padding: 3px 8px; min-width: 160px;
            border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-size: 12px;
        }
        .controls button {
            padding: 3px 10px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
            color: var(--vscode-button-secondaryForeground, inherit);
            cursor: pointer; font-size: 12px; white-space: nowrap;
        }
        .controls button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .controls label {
            font-size: 12px; display: flex; align-items: center; gap: 4px;
            cursor: pointer; user-select: none;
        }
        .spacer { flex: 1; }

        /* Worker filter bar */
        .filter-bar {
            display: none; /* hidden until replicas > 1 */
            align-items: center; gap: 6px;
            padding: 4px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            flex-shrink: 0; flex-wrap: wrap;
            font-size: 12px;
        }
        .filter-bar.visible { display: flex; }
        .filter-bar .filter-label {
            color: var(--vscode-descriptionForeground);
            margin-right: 2px;
        }
        .filter-chip {
            padding: 2px 10px;
            border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.4));
            border-radius: 12px;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer; font-size: 11px; white-space: nowrap;
        }
        .filter-chip:hover {
            background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15));
        }
        .filter-chip.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }
        .log-line.filtered { display: none; }

        /* Stage bar */
        .stage-bar {
            display: flex; align-items: center; gap: 6px;
            padding: 4px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            flex-shrink: 0; flex-wrap: wrap;
            font-size: 12px;
        }
        .stage-bar .stage-label {
            color: var(--vscode-descriptionForeground);
            margin-right: 2px;
        }
        .stage-chip {
            padding: 2px 10px;
            border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.4));
            border-radius: 12px;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer; font-size: 11px; white-space: nowrap;
        }
        .stage-chip:hover:not(.disabled) {
            background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15));
        }
        .stage-chip.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }
        .stage-chip.disabled {
            opacity: 0.4;
            cursor: default;
        }

        /* Log area */
        #logArea {
            flex: 1; overflow-y: auto; overflow-x: auto;
            padding: 8px 16px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 12px);
            line-height: 1.45;
            white-space: pre;
            tab-size: 4;
        }
        .log-line { min-height: 1.45em; }
        .log-line .highlight {
            background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,0.3));
        }
    </style>
</head>
<body>
    <div class="header">
        <span id="statusDot" class="status-dot connecting"></span>
        <h2>${escapeHtml(automationName)}</h2>
        <span id="statusText" class="status-text">Connecting...</span>
        <span id="replicaCount" class="replica-count"></span>
    </div>
    ${showStageBar ? `<div class="stage-bar">
        <span class="stage-label">Stage:</span>
        ${stageChipsHtml}
    </div>` : ''}
    <div class="controls">
        <input id="searchInput" type="text" placeholder="Search logs..." />
        <button id="searchBtn">Find</button>
        <div class="spacer"></div>
        <label><input id="autoScrollToggle" type="checkbox" checked /> Auto-scroll</label>
        <button id="loadMoreBtn">Load More</button>
        <button id="inspectBtn">Inspect</button>
        <button id="copyBtn" class="primary">Copy All</button>
    </div>
    <div id="filterBar" class="filter-bar">
        <span class="filter-label">Worker:</span>
    </div>
    <div id="logArea"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const logArea = document.getElementById('logArea');
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const replicaCount = document.getElementById('replicaCount');
        const filterBar = document.getElementById('filterBar');
        const searchInput = document.getElementById('searchInput');
        const autoScrollToggle = document.getElementById('autoScrollToggle');

        const MAX_LINES = 10000;
        let lineCount = 0;
        let searchIndex = -1;
        let lastQuery = '';
        let activeFilter = null; // null = all, number = specific replica index
        let totalReplicas = 0;

        function appendLine(text, replica) {
            const div = document.createElement('div');
            div.className = 'log-line';
            div.textContent = text;
            if (replica !== undefined && replica !== null) {
                div.dataset.replica = String(replica);
            }
            // Hide if filtered out
            if (activeFilter !== null && replica !== undefined && replica !== activeFilter) {
                div.classList.add('filtered');
            }
            logArea.appendChild(div);
            lineCount++;

            // Trim oldest lines if over limit
            while (lineCount > MAX_LINES && logArea.firstChild) {
                logArea.removeChild(logArea.firstChild);
                lineCount--;
            }

            if (autoScrollToggle.checked && !div.classList.contains('filtered')) {
                logArea.scrollTop = logArea.scrollHeight;
            }
        }

        function buildFilterChips(count) {
            totalReplicas = count;
            // Clear existing chips (keep the label)
            while (filterBar.children.length > 1) {
                filterBar.removeChild(filterBar.lastChild);
            }
            // "All" chip
            const allChip = document.createElement('button');
            allChip.className = 'filter-chip active';
            allChip.textContent = 'All';
            allChip.addEventListener('click', () => setFilter(null));
            filterBar.appendChild(allChip);
            // Per-worker chips
            for (let i = 0; i < count; i++) {
                const chip = document.createElement('button');
                chip.className = 'filter-chip';
                chip.textContent = 'Worker ' + i;
                chip.dataset.replica = String(i);
                chip.addEventListener('click', () => setFilter(i));
                filterBar.appendChild(chip);
            }
            filterBar.classList.add('visible');
        }

        function setFilter(replicaIndex) {
            activeFilter = replicaIndex;
            // Update chip active states
            filterBar.querySelectorAll('.filter-chip').forEach(chip => {
                if (replicaIndex === null) {
                    chip.classList.toggle('active', chip.textContent === 'All');
                } else {
                    chip.classList.toggle('active', chip.dataset.replica === String(replicaIndex));
                }
            });
            // Apply filter to existing lines
            logArea.querySelectorAll('.log-line').forEach(line => {
                const lr = line.dataset.replica;
                if (replicaIndex === null || lr === undefined) {
                    line.classList.remove('filtered');
                } else {
                    line.classList.toggle('filtered', lr !== String(replicaIndex));
                }
            });
            if (autoScrollToggle.checked) {
                logArea.scrollTop = logArea.scrollHeight;
            }
        }

        function setStatus(status) {
            statusDot.className = 'status-dot ' + status;
            const labels = {
                connected: 'Connected',
                connecting: 'Connecting...',
                reconnecting: 'Reconnecting...',
                disconnected: 'Disconnected'
            };
            statusText.textContent = labels[status] || status;
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (!msg || !msg.type) return;

            switch (msg.type) {
                case 'status':
                    setStatus(msg.status);
                    break;
                case 'clear':
                    logArea.innerHTML = '';
                    lineCount = 0;
                    activeFilter = null;
                    totalReplicas = 0;
                    filterBar.classList.remove('visible');
                    break;
                case 'sse:metadata':
                    if (msg.replicas !== undefined) {
                        replicaCount.textContent = msg.replicas > 1
                            ? msg.replicas + ' replicas'
                            : '1 replica';
                        if (msg.replicas > 1) {
                            buildFilterChips(msg.replicas);
                        }
                    }
                    break;
                case 'sse:log':
                    if (msg.line !== undefined) {
                        appendLine(msg.line, msg.replica);
                    }
                    break;
                case 'sse:error':
                    appendLine('[ERROR] ' + (msg.message || JSON.stringify(msg)), msg.replica);
                    break;
                case 'sse:end':
                    setStatus('disconnected');
                    break;
                case 'stageChanged':
                    document.querySelectorAll('.stage-chip').forEach(chip => {
                        chip.classList.toggle('active', chip.dataset.stage === msg.stage);
                    });
                    break;
            }
        });

        /* Search */
        function performSearch() {
            const query = searchInput.value.trim();
            if (!query) return;

            // Clear previous highlights
            logArea.querySelectorAll('.highlight').forEach(el => {
                el.replaceWith(el.textContent);
            });

            const lines = logArea.querySelectorAll('.log-line:not(.filtered)');
            const matches = [];
            const lowerQuery = query.toLowerCase();

            lines.forEach((line) => {
                const text = line.textContent || '';
                if (text.toLowerCase().includes(lowerQuery)) {
                    matches.push(line);
                }
            });

            if (matches.length === 0) {
                vscode.postMessage({ type: 'searchNotFound', query });
                return;
            }

            // Cycle through matches
            if (query !== lastQuery) {
                searchIndex = 0;
                lastQuery = query;
            } else {
                searchIndex = (searchIndex + 1) % matches.length;
            }

            const target = matches[searchIndex];
            // Highlight the match text
            const text = target.textContent || '';
            const idx = text.toLowerCase().indexOf(lowerQuery);
            if (idx >= 0) {
                const before = document.createTextNode(text.substring(0, idx));
                const span = document.createElement('span');
                span.className = 'highlight';
                span.textContent = text.substring(idx, idx + query.length);
                const after = document.createTextNode(text.substring(idx + query.length));
                target.textContent = '';
                target.appendChild(before);
                target.appendChild(span);
                target.appendChild(after);
            }
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }

        document.getElementById('searchBtn').addEventListener('click', performSearch);
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') performSearch();
        });

        /* Load more */
        document.getElementById('loadMoreBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'requestMoreLines' });
        });

        /* Copy all (visible lines only) */
        document.getElementById('copyBtn').addEventListener('click', async () => {
            const lines = logArea.querySelectorAll('.log-line:not(.filtered)');
            const text = Array.from(lines).map(l => l.textContent).join('\\n');
            try {
                await navigator.clipboard.writeText(text);
                vscode.postMessage({ type: 'copySuccess' });
            } catch (err) {
                vscode.postMessage({ type: 'copyFailure', message: String(err) });
            }
        });

        /* Inspect */
        document.getElementById('inspectBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'requestInspect' });
        });

        /* Stage chip click handlers */
        document.querySelectorAll('.stage-chip:not(.disabled)').forEach(chip => {
            chip.addEventListener('click', () => {
                if (chip.classList.contains('active')) return;
                const stage = chip.dataset.stage;
                vscode.postMessage({ type: 'switchStage', stage });
            });
        });
    </script>
</body>
</html>
    `;
}
