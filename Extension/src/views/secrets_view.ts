import * as path from 'path';
import * as vscode from 'vscode';
import { promises as fs } from 'fs';

interface SecretGroupSummary {
    id: string;
    label: string;
    keys: string[];
}

type FeedbackLevel = 'info' | 'error';

// Tree view provider for the sidebar
export class SecretsTreeViewProvider implements vscode.TreeDataProvider<SecretGroupItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SecretGroupItem | undefined | null | void> = new vscode.EventEmitter<SecretGroupItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SecretGroupItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private readonly secretsDir: string;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
            throw new Error('No workspace folder found');
        }
        const workspaceRoot = path.dirname(workspaceFolder);
        this.secretsDir = path.join(workspaceRoot, 'secrets');
        this.registerWatchers();
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SecretGroupItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SecretGroupItem): Promise<SecretGroupItem[]> {
        if (element) {
            return [];
        }

        try {
            await fs.mkdir(this.secretsDir, { recursive: true });
            const entries = await fs.readdir(this.secretsDir, { withFileTypes: true });
            const files = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.'));
            const groups: SecretGroupItem[] = [];
            for (const file of files) {
                const secrets = await this.readOptionalSecrets(file.name);
                groups.push(new SecretGroupItem(
                    file.name,
                    file.name,
                    Object.keys(secrets).length
                ));
            }
            return groups.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    private async readOptionalSecrets(groupId: string): Promise<Record<string, string>> {
        try {
            const filePath = path.join(this.secretsDir, groupId);
            const content = await fs.readFile(filePath, 'utf8');
            return this.parseEnv(content);
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return {};
            }
            throw error;
        }
    }

    private parseEnv(content: string): Record<string, string> {
        const result: Record<string, string> = {};
        const lines = content.split(/\r?\n/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) {
                continue;
            }
            const equalsIndex = rawLine.indexOf('=');
            if (equalsIndex === -1) {
                continue;
            }
            const key = rawLine.slice(0, equalsIndex).trim();
            let value = rawLine.slice(equalsIndex + 1).trim();
            if (value.startsWith('"') && value.endsWith('"')) {
                try {
                    value = JSON.parse(value);
                } catch {
                    value = value.slice(1, -1);
                }
            } else if (value.startsWith("'") && value.endsWith("'")) {
                value = value.slice(1, -1);
            }
            result[key] = value;
        }
        return result;
    }

    private registerWatchers() {
        const pattern = new vscode.RelativePattern(this.secretsDir, '*');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.disposables.push(
            watcher,
            watcher.onDidCreate(() => this.refresh()),
            watcher.onDidDelete(() => this.refresh()),
            watcher.onDidChange(() => this.refresh())
        );
    }
}

export class SecretGroupItem extends vscode.TreeItem {
    constructor(
        public readonly id: string,
        public readonly label: string,
        public readonly secretCount: number
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.label} (${this.secretCount} secrets)`;
        this.description = `${this.secretCount}`;
        this.contextValue = 'secretGroup';
        this.iconPath = new vscode.ThemeIcon('key');
        this.command = {
            command: 'bitswan.openSecretGroup',
            title: 'Open Secret Group',
            arguments: [this]
        };
    }
}

// Webview panel provider for editing secrets
export class SecretsEditorPanel {
    private static panels = new Map<string, vscode.WebviewPanel>();

    public static createOrShow(context: vscode.ExtensionContext, groupId: string, groupLabel: string) {
        const panelKey = groupId;
        const existing = this.panels.get(panelKey);
        if (existing) {
            existing.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'secretsEditor',
            `Secrets: ${groupLabel}`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        const provider = new SecretsEditorProvider(context, groupId, groupLabel);
        panel.webview.html = provider.getHtml(panel.webview);
        panel.webview.onDidReceiveMessage(async (message) => {
            try {
                await provider.handleMessage(message, panel);
            } catch (error) {
                const friendly = error instanceof Error ? error.message : 'Unexpected error';
                vscode.window.showErrorMessage(friendly);
            }
        });

        panel.onDidDispose(() => {
            this.panels.delete(panelKey);
        });

        this.panels.set(panelKey, panel);
        provider.refresh(panel.webview);
    }

    public static closePanel(groupId: string) {
        const panel = this.panels.get(groupId);
        if (panel) {
            panel.dispose();
            this.panels.delete(groupId);
        }
    }
}

class SecretsEditorProvider {
    private readonly secretsDir: string;
    private readonly groupId: string;
    private readonly groupLabel: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        groupId: string,
        groupLabel: string
    ) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
            throw new Error('No workspace folder found');
        }
        const workspaceRoot = path.dirname(workspaceFolder);
        this.secretsDir = path.join(workspaceRoot, 'secrets');
        this.groupId = groupId;
        this.groupLabel = groupLabel;
    }

    async handleMessage(message: any, panel: vscode.WebviewPanel) {
        switch (message?.type) {
            case 'ready':
                await this.refresh(panel.webview);
                return;
            case 'createSecret':
                await this.createSecret(message.key, message.value);
                await this.refresh(panel.webview);
                return;
            case 'setSecret':
                await this.setSecret(message.key, message.value);
                await this.refresh(panel.webview);
                return;
            case 'deleteSecret':
                await this.deleteSecret(message.key);
                await this.refresh(panel.webview);
                return;
            case 'copySecret':
                await this.copySecret(message.key);
                return;
            default:
                console.warn('[SecretsEditor] Unhandled message', message);
        }
    }

    async refresh(webview: vscode.Webview) {
        const secrets = await this.readSecrets();
        const keys = Object.keys(secrets).sort((a, b) => a.localeCompare(b));
        webview.postMessage({
            type: 'state',
            payload: { keys, secrets },
        });
    }

    private async createSecret(rawKey: string, value: string) {
        const key = this.normalizeSecretKey(rawKey);
        const data = await this.readSecrets();
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            throw new Error(`Secret "${key}" already exists. Use Set to update.`);
        }
        data[key] = this.normalizeSecretValue(value);
        await this.writeSecrets(data);
        vscode.window.showInformationMessage(`Added secret "${key}".`);
    }

    private async setSecret(rawKey: string, value: string) {
        const key = this.normalizeSecretKey(rawKey);
        const data = await this.readSecrets();
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
            throw new Error(`Secret "${key}" does not exist.`);
        }
        data[key] = this.normalizeSecretValue(value);
        await this.writeSecrets(data);
        vscode.window.showInformationMessage(`Updated secret "${key}".`);
    }

    private async deleteSecret(rawKey: string) {
        const key = this.normalizeSecretKey(rawKey);
        const data = await this.readSecrets();
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
            throw new Error(`Secret "${key}" does not exist.`);
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Remove secret "${key}" from ${this.groupLabel}?`,
            { modal: true },
            'Remove'
        );
        if (confirmation !== 'Remove') {
            return;
        }

        delete data[key];
        await this.writeSecrets(data);
        vscode.window.showInformationMessage(`Removed secret "${key}".`);
    }

    private async copySecret(rawKey: string) {
        const key = this.normalizeSecretKey(rawKey);
        const data = await this.readSecrets();
        const value = data[key];
        if (typeof value === 'undefined') {
            throw new Error(`Secret "${key}" not found.`);
        }
        await vscode.env.clipboard.writeText(value);
        vscode.window.showInformationMessage(`Copied "${key}" to clipboard.`);
    }

    private async readSecrets(): Promise<Record<string, string>> {
        const filePath = this.getGroupPath();
        try {
            const content = await fs.readFile(filePath, 'utf8');
            return this.parseEnv(content);
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return {};
            }
            throw error;
        }
    }

    private async writeSecrets(data: Record<string, string>) {
        const filePath = this.getGroupPath();
        const serialized = this.serializeEnv(data);
        await fs.writeFile(filePath, serialized, 'utf8');
    }

    private getGroupPath(): string {
        return path.join(this.secretsDir, this.groupId);
    }

    private parseEnv(content: string): Record<string, string> {
        const result: Record<string, string> = {};
        const lines = content.split(/\r?\n/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) {
                continue;
            }
            const equalsIndex = rawLine.indexOf('=');
            if (equalsIndex === -1) {
                continue;
            }
            const key = rawLine.slice(0, equalsIndex).trim();
            let value = rawLine.slice(equalsIndex + 1).trim();
            if (value.startsWith('"') && value.endsWith('"')) {
                try {
                    value = JSON.parse(value);
                } catch {
                    value = value.slice(1, -1);
                }
            } else if (value.startsWith("'") && value.endsWith("'")) {
                value = value.slice(1, -1);
            }
            result[key] = value;
        }
        return result;
    }

    private serializeEnv(data: Record<string, string>): string {
        const entries = Object.entries(data).sort((a, b) => a[0].localeCompare(b[0]));
        const lines = ['# Managed by BitSwan Secrets Manager'];
        for (const [key, value] of entries) {
            lines.push(`${key}=${this.formatValue(value)}`);
        }
        return lines.join('\n') + '\n';
    }

    private formatValue(value: string): string {
        if (value === '') {
            return '""';
        }
        if (/[ \t#"'`]/.test(value) || value.includes('=')) {
            return JSON.stringify(value);
        }
        return value;
    }

    private normalizeSecretKey(rawKey: string | undefined): string {
        const key = (rawKey ?? '').trim();
        if (!key) {
            throw new Error('Secret name is required.');
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error('Secret names must start with a letter or underscore and contain only letters, numbers, or underscores.');
        }
        return key;
    }

    private normalizeSecretValue(rawValue: string | undefined): string {
        if (typeof rawValue !== 'string') {
            throw new Error('Secret value is required.');
        }
        return rawValue.replace(/\r\n/g, '\n');
    }

    getHtml(webview: vscode.Webview): string {
        const nonce = this.getNonce();
        const csp = [
            "default-src 'none'",
            `style-src 'unsafe-inline' ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            color-scheme: light dark;
            --panel-bg: var(--vscode-editor-background);
            --panel-border: var(--vscode-panel-border, rgba(255,255,255,0.1));
            --text: var(--vscode-foreground);
            --muted: var(--vscode-descriptionForeground);
            --accent: var(--vscode-button-background);
            --danger: var(--vscode-testing-iconFailed, #f14c4c);
        }
        body {
            margin: 0;
            padding: 16px;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            color: var(--text);
            background: var(--panel-bg);
        }
        .container {
            display: flex;
            flex-direction: column;
            gap: 16px;
            max-width: 800px;
            margin: 0 auto;
        }
        h1 {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
        }
        form {
            display: flex;
            gap: 8px;
        }
        .value-input-container {
            flex: 1;
            display: flex;
            gap: 4px;
            align-items: center;
        }
        .toggle-visibility {
            background: transparent;
            border: 1px solid var(--panel-border);
            padding: 6px;
            min-width: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            border-radius: 4px;
            color: var(--muted);
        }
        .toggle-visibility:hover {
            background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.1));
            color: var(--text);
        }
        .toggle-visibility svg {
            width: 16px;
            height: 16px;
            fill: currentColor;
        }
        input[type="text"],
        input[type="password"] {
            flex: 1;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 4px;
        }
        button.icon-button {
            background: transparent;
            border: 1px solid var(--panel-border);
            padding: 6px;
            min-width: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        button.icon-button:hover {
            background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.1));
        }
        button {
            border: none;
            border-radius: 4px;
            padding: 6px 10px;
            cursor: pointer;
            background: var(--accent);
            color: var(--vscode-button-foreground);
        }
        button.destructive {
            background: var(--danger);
            color: #fff;
        }
        button.secondary {
            background: transparent;
            color: var(--text);
            border: 1px solid var(--panel-border);
        }
        .secrets {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .secret-row {
            padding: 8px 10px;
            border-radius: 6px;
            border: 1px solid var(--panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
        }
        .secret-key {
            font-weight: 600;
        }
        .secret-actions {
            display: flex;
            gap: 6px;
        }
        .secret-actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .inline-edit {
            display: flex;
            gap: 6px;
            margin-top: 6px;
            align-items: center;
        }
        .inline-edit .value-input-container {
            flex: 1;
        }
        .placeholder {
            padding: 24px 0;
            text-align: center;
            color: var(--muted);
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Secrets: ${this.groupLabel}</h1>
        <form id="secret-form">
            <input type="text" name="key" placeholder="SECRET_NAME" autocomplete="off" />
            <div class="value-input-container">
                <input type="password" name="value" placeholder="Secret value" autocomplete="new-password" />
                <button type="button" class="toggle-visibility icon-button" title="Toggle visibility">
                    <svg class="eye-open" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                    <svg class="eye-closed" style="display:none" viewBox="0 0 24 24"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>
                </button>
                <button type="button" id="generate-secret" class="icon-button" title="Generate random secret">🎲</button>
            </div>
            <button type="submit">Add Secret</button>
        </form>
        <div class="secrets" id="secrets-list"></div>
    </div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            const secretForm = document.getElementById('secret-form');
            const secretsList = document.getElementById('secrets-list');
            const generateSecretBtn = document.getElementById('generate-secret');

            function generateRandomSecret() {
                const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
                const array = new Uint8Array(32);
                crypto.getRandomValues(array);
                let secret = '';
                for (let i = 0; i < 32; i++) {
                    secret += charset[array[i] % charset.length];
                }
                return secret;
            }

            function updateToggleIcon(btn, isVisible) {
                if (!btn) return;
                const eyeOpen = btn.querySelector('.eye-open');
                const eyeClosed = btn.querySelector('.eye-closed');
                if (eyeOpen && eyeClosed) {
                    eyeOpen.style.display = isVisible ? 'none' : 'block';
                    eyeClosed.style.display = isVisible ? 'block' : 'none';
                }
            }

            function toggleVisibility(btn) {
                const container = btn.closest('.value-input-container');
                const input = container ? container.querySelector('input[name="value"]') : null;
                if (input) {
                    const isPassword = input.type === 'password';
                    input.type = isPassword ? 'text' : 'password';
                    updateToggleIcon(btn, isPassword);
                }
            }

            const formToggleBtn = secretForm.querySelector('.toggle-visibility');
            if (formToggleBtn) {
                formToggleBtn.addEventListener('click', function() {
                    toggleVisibility(this);
                });
            }

            generateSecretBtn.addEventListener('click', () => {
                const valueInput = secretForm.querySelector('input[name="value"]');
                const toggleBtn = secretForm.querySelector('.toggle-visibility');
                if (valueInput) {
                    valueInput.value = generateRandomSecret();
                    valueInput.type = 'text';
                    updateToggleIcon(toggleBtn, true);
                    setTimeout(() => {
                        valueInput.type = 'password';
                        updateToggleIcon(toggleBtn, false);
                    }, 1000);
                }
            });

            let state = {
                keys: [],
                secrets: {},
                editingKey: null,
            };

            vscode.postMessage({ type: 'ready' });

            window.addEventListener('message', event => {
                const { type, payload } = event.data;
                if (type === 'state') {
                    state.keys = payload.keys;
                    state.secrets = payload.secrets;
                    state.editingKey = null;
                    render();
                }
            });

            secretForm.addEventListener('submit', event => {
                event.preventDefault();
                const keyInput = secretForm.key;
                const valueInput = secretForm.value;
                const key = keyInput.value.trim();
                const value = valueInput.value;
                if (!key || !value) {
                    return;
                }
                vscode.postMessage({
                    type: 'createSecret',
                    key,
                    value,
                });
                keyInput.value = '';
                valueInput.value = '';
            });

            secretsList.addEventListener('click', event => {
                const target = event.target.closest('[data-action]');
                if (!target) {
                    return;
                }
                const action = target.dataset.action;
                const key = target.dataset.key;
                if (!key) {
                    return;
                }
                if (action === 'copy-secret') {
                    vscode.postMessage({ type: 'copySecret', key });
                } else if (action === 'edit-secret') {
                    state.editingKey = key;
                    render();
                    const input = secretsList.querySelector('.inline-edit input[name="value"]');
                    if (input) {
                        input.focus();
                    }
                } else if (action === 'delete-secret') {
                    vscode.postMessage({ type: 'deleteSecret', key });
                } else if (action === 'cancel-edit') {
                    state.editingKey = null;
                    render();
                }
            });

            secretsList.addEventListener('submit', event => {
                const form = event.target.closest('.inline-edit');
                if (!form) {
                    return;
                }
                event.preventDefault();
                const key = form.dataset.key;
                const valueInput = form.querySelector('input[name="value"]');
                if (!key || !valueInput) {
                    return;
                }
                const value = valueInput.value;
                if (!value) {
                    return;
                }
                vscode.postMessage({
                    type: 'setSecret',
                    key,
                    value,
                });
                state.editingKey = null;
                render();
            });

            function render() {
                secretsList.innerHTML = '';
                if (!state.keys.length) {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'placeholder';
                    placeholder.textContent = 'No secrets yet. Add one above.';
                    secretsList.appendChild(placeholder);
                    return;
                }

                state.keys.forEach(key => {
                    const row = document.createElement('div');
                    row.className = 'secret-row';

                    const meta = document.createElement('div');
                    const title = document.createElement('div');
                    title.className = 'secret-key';
                    title.textContent = key;
                    meta.appendChild(title);

                    const actions = document.createElement('div');
                    actions.className = 'secret-actions';

                    const copyBtn = document.createElement('button');
                    copyBtn.dataset.action = 'copy-secret';
                    copyBtn.dataset.key = key;
                    copyBtn.textContent = 'Copy';

                    const setBtn = document.createElement('button');
                    setBtn.dataset.action = 'edit-secret';
                    setBtn.dataset.key = key;
                    setBtn.textContent = 'Set';

                    const deleteBtn = document.createElement('button');
                    deleteBtn.dataset.action = 'delete-secret';
                    deleteBtn.dataset.key = key;
                    deleteBtn.className = 'destructive';
                    deleteBtn.textContent = 'Delete';

                    actions.appendChild(copyBtn);
                    actions.appendChild(setBtn);
                    actions.appendChild(deleteBtn);

                    row.appendChild(meta);
                    row.appendChild(actions);
                    secretsList.appendChild(row);

                    if (state.editingKey === key) {
                        const form = document.createElement('form');
                        form.className = 'inline-edit';
                        form.dataset.key = key;

                        const inputContainer = document.createElement('div');
                        inputContainer.className = 'value-input-container';

                        const input = document.createElement('input');
                        input.type = 'password';
                        input.name = 'value';
                        input.placeholder = 'Enter new value';
                        input.autocomplete = 'new-password';

                        const toggleBtn = document.createElement('button');
                        toggleBtn.type = 'button';
                        toggleBtn.className = 'toggle-visibility icon-button';
                        toggleBtn.title = 'Toggle visibility';
                        toggleBtn.innerHTML = '<svg class="eye-open" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg><svg class="eye-closed" style="display:none" viewBox="0 0 24 24"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>';
                        toggleBtn.addEventListener('click', function() {
                            toggleVisibility(this);
                        });

                        inputContainer.appendChild(input);
                        inputContainer.appendChild(toggleBtn);

                        const saveBtn = document.createElement('button');
                        saveBtn.type = 'submit';
                        saveBtn.textContent = 'Save';

                        const cancelBtn = document.createElement('button');
                        cancelBtn.type = 'button';
                        cancelBtn.dataset.action = 'cancel-edit';
                        cancelBtn.className = 'secondary';
                        cancelBtn.textContent = 'Cancel';

                        form.appendChild(inputContainer);
                        form.appendChild(saveBtn);
                        form.appendChild(cancelBtn);
                        secretsList.appendChild(form);
                    }
                });
            }
        })();
    </script>
</body>
</html>`;
    }

    private getNonce(): string {
        const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 32; i++) {
            result += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        return result;
    }
}
