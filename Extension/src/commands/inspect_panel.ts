import * as vscode from 'vscode';
import axios from 'axios';
import urlJoin from 'proper-url-join';
import { GitOpsItem } from '../views/workspaces_view';

/** Manages a webview panel that displays Docker container inspect data. */
export class InspectPanel {
    private static panels = new Map<string, InspectPanel>();

    private panel: vscode.WebviewPanel;
    private disposed = false;
    private inspectData: any = null;

    private constructor(
        private readonly deploymentId: string,
        private readonly gitopsUrl: string,
        private readonly secret: string,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'bitswan-inspect-panel',
            `Inspect: ${deploymentId}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        this.panel.webview.html = buildLoadingHtml(deploymentId);

        this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));

        this.panel.onDidDispose(() => {
            this.disposed = true;
            InspectPanel.panels.delete(this.deploymentId);
        });

        this.fetchInspectData();
    }

    static open(
        deploymentId: string,
        gitopsUrl: string,
        secret: string,
    ): InspectPanel {
        const existing = InspectPanel.panels.get(deploymentId);
        if (existing && !existing.disposed) {
            existing.panel.reveal(vscode.ViewColumn.Active);
            return existing;
        }
        const panel = new InspectPanel(deploymentId, gitopsUrl, secret);
        InspectPanel.panels.set(deploymentId, panel);
        return panel;
    }

    /* ---- Data fetching ---- */

    private async fetchInspectData() {
        const inspectUrl = urlJoin(
            this.gitopsUrl, 'automations', this.deploymentId, 'inspect',
        ).toString();

        try {
            const response = await axios.get(inspectUrl, {
                headers: { Authorization: `Bearer ${this.secret}` },
            });
            this.inspectData = response.data;
            this.panel.webview.html = buildInspectHtml(this.deploymentId, this.inspectData);
        } catch (err: any) {
            const message = err?.response?.data?.message || err?.message || 'Unknown error';
            this.panel.webview.html = buildErrorHtml(this.deploymentId, message);
        }
    }

    /* ---- Webview message handling ---- */

    private onMessage(msg: any) {
        if (!msg || !msg.type) { return; }

        switch (msg.type) {
            case 'refresh':
                this.panel.webview.html = buildLoadingHtml(this.deploymentId);
                this.fetchInspectData();
                break;
            case 'copySuccess':
                vscode.window.showInformationMessage('Inspect data copied to clipboard');
                break;
            case 'copyFailure':
                vscode.window.showErrorMessage(`Failed to copy inspect data: ${msg.message || 'Unknown error'}`);
                break;
        }
    }
}

/* ---- HTML builders ---- */

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const SENSITIVE_PATTERNS = /PASSWORD|SECRET|TOKEN|KEY/i;

function maskSensitiveValue(envEntry: string): string {
    const eqIdx = envEntry.indexOf('=');
    if (eqIdx === -1) { return envEntry; }
    const key = envEntry.substring(0, eqIdx);
    const value = envEntry.substring(eqIdx + 1);
    if (SENSITIVE_PATTERNS.test(key)) {
        return `${key}=****`;
    }
    return envEntry;
}

function buildBaseStyles(): string {
    return `
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
        .header {
            display: flex; align-items: center; gap: 12px;
            padding: 8px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            flex-shrink: 0;
        }
        .header h2 { margin: 0; font-size: 14px; white-space: nowrap; }
        .controls {
            display: flex; align-items: center; gap: 8px;
            padding: 6px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            flex-shrink: 0;
        }
        .spacer { flex: 1; }
        button {
            padding: 3px 10px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
            color: var(--vscode-button-secondaryForeground, inherit);
            cursor: pointer; font-size: 12px; white-space: nowrap;
        }
        button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .tab-bar {
            display: flex; gap: 0; flex-shrink: 0;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            padding: 0 16px;
        }
        .tab-bar.hidden { display: none; }
        .tab {
            padding: 6px 16px;
            border: none; border-bottom: 2px solid transparent;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer; font-size: 12px;
            border-radius: 0;
        }
        .tab:hover {
            background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15));
        }
        .tab.active {
            border-bottom-color: var(--vscode-focusBorder, #007acc);
            color: var(--vscode-foreground);
        }
        .content {
            flex: 1; overflow-y: auto; padding: 16px;
        }
        .container-panel { display: none; }
        .container-panel.active { display: block; }
        .section { margin-bottom: 20px; }
        .section h3 {
            margin: 0 0 8px 0; font-size: 13px;
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            padding-bottom: 4px;
        }
        table {
            width: 100%; border-collapse: collapse;
            font-size: 12px;
        }
        td, th {
            padding: 3px 8px; text-align: left;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
            vertical-align: top;
        }
        th {
            width: 180px;
            color: var(--vscode-descriptionForeground);
            font-weight: normal;
        }
        td {
            font-family: var(--vscode-editor-font-family, monospace);
            word-break: break-all;
        }
        .loading {
            display: flex; align-items: center; justify-content: center;
            height: 100%; font-size: 14px;
            color: var(--vscode-descriptionForeground);
        }
        .error-message {
            padding: 20px;
            color: var(--vscode-errorForeground, #f85149);
        }
    `;
}

function buildLoadingHtml(deploymentId: string): string {
    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>${buildBaseStyles()}</style>
</head>
<body>
    <div class="header">
        <h2>Inspect: ${escapeHtml(deploymentId)}</h2>
    </div>
    <div class="loading">Loading inspect data...</div>
</body>
</html>`;
}

function buildErrorHtml(deploymentId: string, errorMessage: string): string {
    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>${buildBaseStyles()}</style>
</head>
<body>
    <div class="header">
        <h2>Inspect: ${escapeHtml(deploymentId)}</h2>
    </div>
    <div class="controls">
        <div class="spacer"></div>
        <button id="refreshBtn">Refresh</button>
    </div>
    <div class="error-message">
        <strong>Error fetching inspect data:</strong><br/>
        ${escapeHtml(errorMessage)}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });
    </script>
</body>
</html>`;
}

function buildInspectHtml(deploymentId: string, data: any): string {
    const containers = Array.isArray(data) ? data : [data];
    const multipleContainers = containers.length > 1;

    let tabBarHtml = '';
    if (multipleContainers) {
        tabBarHtml = '<div class="tab-bar">';
        containers.forEach((c: any, i: number) => {
            const shortId = (c.Id || '').substring(0, 12);
            const activeClass = i === 0 ? ' active' : '';
            tabBarHtml += `<button class="tab${activeClass}" data-index="${i}">${escapeHtml(shortId || `Container ${i}`)}</button>`;
        });
        tabBarHtml += '</div>';
    } else {
        tabBarHtml = '<div class="tab-bar hidden"></div>';
    }

    let panelsHtml = '';
    containers.forEach((c: any, i: number) => {
        const activeClass = i === 0 ? ' active' : '';
        panelsHtml += `<div class="container-panel${activeClass}" data-index="${i}">`;
        panelsHtml += buildContainerSections(c);
        panelsHtml += '</div>';
    });

    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>${buildBaseStyles()}</style>
</head>
<body>
    <div class="header">
        <h2>Inspect: ${escapeHtml(deploymentId)}</h2>
    </div>
    <div class="controls">
        <div class="spacer"></div>
        <button id="refreshBtn">Refresh</button>
        <button id="copyBtn" class="primary">Copy Raw JSON</button>
    </div>
    ${tabBarHtml}
    <div class="content">
        ${panelsHtml}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const rawJson = ${JSON.stringify(JSON.stringify(data, null, 2))};

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const idx = tab.dataset.index;
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.container-panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                const panel = document.querySelector('.container-panel[data-index="' + idx + '"]');
                if (panel) { panel.classList.add('active'); }
            });
        });

        // Refresh
        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        // Copy Raw JSON
        document.getElementById('copyBtn').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(rawJson);
                vscode.postMessage({ type: 'copySuccess' });
            } catch (err) {
                vscode.postMessage({ type: 'copyFailure', message: String(err) });
            }
        });
    </script>
</body>
</html>`;
}

function buildContainerSections(c: any): string {
    let html = '';

    // Overview
    html += buildOverviewSection(c);

    // Network
    html += buildNetworkSection(c);

    // Mounts
    html += buildMountsSection(c);

    // Environment
    html += buildEnvironmentSection(c);

    // Labels
    html += buildLabelsSection(c);

    // Resource Limits
    html += buildResourceLimitsSection(c);

    return html;
}

function buildOverviewSection(c: any): string {
    const name = c.Name || 'N/A';
    const shortId = (c.Id || '').substring(0, 12) || 'N/A';
    const image = c.Config?.Image || 'N/A';
    const created = c.Created || 'N/A';
    const status = c.State?.Status || 'N/A';
    const running = c.State?.Running !== undefined ? String(c.State.Running) : 'N/A';
    const startedAt = c.State?.StartedAt || 'N/A';

    return `
    <div class="section">
        <h3>Overview</h3>
        <table>
            <tr><th>Name</th><td>${escapeHtml(String(name))}</td></tr>
            <tr><th>ID</th><td>${escapeHtml(String(shortId))}</td></tr>
            <tr><th>Image</th><td>${escapeHtml(String(image))}</td></tr>
            <tr><th>Created</th><td>${escapeHtml(String(created))}</td></tr>
            <tr><th>Status</th><td>${escapeHtml(String(status))}</td></tr>
            <tr><th>Running</th><td>${escapeHtml(String(running))}</td></tr>
            <tr><th>Started At</th><td>${escapeHtml(String(startedAt))}</td></tr>
        </table>
    </div>`;
}

function buildNetworkSection(c: any): string {
    const networkSettings = c.NetworkSettings || {};
    const networks = networkSettings.Networks || {};
    const networkNames = Object.keys(networks);

    if (networkNames.length === 0 && !networkSettings.IPAddress && !c.NetworkSettings?.Ports) {
        return `
    <div class="section">
        <h3>Network</h3>
        <p style="color: var(--vscode-descriptionForeground); font-size: 12px;">No network information available</p>
    </div>`;
    }

    let rows = '';

    // IP addresses from networks
    const ipAddresses: string[] = [];
    for (const netName of networkNames) {
        const net = networks[netName];
        if (net.IPAddress) {
            ipAddresses.push(`${net.IPAddress} (${netName})`);
        }
    }
    if (networkSettings.IPAddress && ipAddresses.length === 0) {
        ipAddresses.push(networkSettings.IPAddress);
    }
    if (ipAddresses.length > 0) {
        rows += `<tr><th>IP Addresses</th><td>${ipAddresses.map(ip => escapeHtml(ip)).join('<br/>')}</td></tr>`;
    }

    // Exposed ports
    const ports = networkSettings.Ports || {};
    const portEntries = Object.keys(ports);
    if (portEntries.length > 0) {
        const portStrings = portEntries.map(p => {
            const bindings = ports[p];
            if (bindings && Array.isArray(bindings) && bindings.length > 0) {
                return bindings.map((b: any) => `${b.HostIp || '0.0.0.0'}:${b.HostPort} -> ${p}`).join(', ');
            }
            return p;
        });
        rows += `<tr><th>Ports</th><td>${portStrings.map(s => escapeHtml(s)).join('<br/>')}</td></tr>`;
    }

    // Network names
    if (networkNames.length > 0) {
        rows += `<tr><th>Networks</th><td>${networkNames.map(n => escapeHtml(n)).join('<br/>')}</td></tr>`;
    }

    return `
    <div class="section">
        <h3>Network</h3>
        <table>${rows}</table>
    </div>`;
}

function buildMountsSection(c: any): string {
    const mounts = c.Mounts || [];
    if (mounts.length === 0) {
        return `
    <div class="section">
        <h3>Mounts</h3>
        <p style="color: var(--vscode-descriptionForeground); font-size: 12px;">No mounts</p>
    </div>`;
    }

    let rows = '';
    for (const m of mounts) {
        const source = m.Source || 'N/A';
        const dest = m.Destination || 'N/A';
        const mode = m.Mode || 'default';
        rows += `<tr><td>${escapeHtml(source)} -&gt; ${escapeHtml(dest)}</td><td>${escapeHtml(mode)}</td></tr>`;
    }

    return `
    <div class="section">
        <h3>Mounts</h3>
        <table>
            <tr><th style="width:auto">Source -&gt; Destination</th><th style="width:80px">Mode</th></tr>
            ${rows}
        </table>
    </div>`;
}

function buildEnvironmentSection(c: any): string {
    const envVars: string[] = c.Config?.Env || [];
    if (envVars.length === 0) {
        return `
    <div class="section">
        <h3>Environment</h3>
        <p style="color: var(--vscode-descriptionForeground); font-size: 12px;">No environment variables</p>
    </div>`;
    }

    let rows = '';
    for (const env of envVars) {
        const masked = maskSensitiveValue(env);
        const eqIdx = masked.indexOf('=');
        const key = eqIdx >= 0 ? masked.substring(0, eqIdx) : masked;
        const value = eqIdx >= 0 ? masked.substring(eqIdx + 1) : '';
        rows += `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`;
    }

    return `
    <div class="section">
        <h3>Environment</h3>
        <table>${rows}</table>
    </div>`;
}

function buildLabelsSection(c: any): string {
    const labels = c.Config?.Labels || {};
    const labelKeys = Object.keys(labels);
    if (labelKeys.length === 0) {
        return `
    <div class="section">
        <h3>Labels</h3>
        <p style="color: var(--vscode-descriptionForeground); font-size: 12px;">No labels</p>
    </div>`;
    }

    let rows = '';
    for (const key of labelKeys.sort()) {
        rows += `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(labels[key]))}</td></tr>`;
    }

    return `
    <div class="section">
        <h3>Labels</h3>
        <table>${rows}</table>
    </div>`;
}

function buildResourceLimitsSection(c: any): string {
    const hostConfig = c.HostConfig || {};
    const memory = hostConfig.Memory;
    const nanoCpus = hostConfig.NanoCpus;
    const cpuShares = hostConfig.CpuShares;

    const hasLimits = (memory && memory > 0) || (nanoCpus && nanoCpus > 0) || (cpuShares && cpuShares > 0);

    if (!hasLimits) {
        return `
    <div class="section">
        <h3>Resource Limits</h3>
        <p style="color: var(--vscode-descriptionForeground); font-size: 12px;">No resource limits configured</p>
    </div>`;
    }

    let rows = '';
    if (memory && memory > 0) {
        const memMB = (memory / (1024 * 1024)).toFixed(1);
        rows += `<tr><th>Memory</th><td>${escapeHtml(String(memMB))} MB (${escapeHtml(String(memory))} bytes)</td></tr>`;
    }
    if (nanoCpus && nanoCpus > 0) {
        const cpus = (nanoCpus / 1e9).toFixed(2);
        rows += `<tr><th>CPUs (NanoCpus)</th><td>${escapeHtml(String(cpus))} CPUs (${escapeHtml(String(nanoCpus))} nano)</td></tr>`;
    }
    if (cpuShares && cpuShares > 0) {
        rows += `<tr><th>CPU Shares</th><td>${escapeHtml(String(cpuShares))}</td></tr>`;
    }

    return `
    <div class="section">
        <h3>Resource Limits</h3>
        <table>${rows}</table>
    </div>`;
}
