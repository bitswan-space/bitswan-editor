import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as toml from '@iarna/toml';
import axios from 'axios';
import { getUserEmail } from '../services/user_info';
import { getDeployDetails } from '../deploy_details';
import { AutomationItem } from './automations_view';

const REQUIREMENTS_FILENAME = 'testable-requirements.toml';
const WORKSPACE_DIR = '/workspace/workspace';
const WORKTREES_DIR = '/workspace/workspace/worktrees';
const SESSIONS_DIR = '/workspace/agent-sessions';

interface Requirement {
    id: string;
    description: string;
    status: 'pass' | 'fail' | 'pending' | 'retest' | 'proposed';
    parent: string;
}

interface AutomationInfo {
    name: string;
    deploymentId: string;
    state: string;
    url: string;
    relativePath: string;
    icon: string;
}

function inferAutomationIcon(autoDir: string): string {
    const configPath = path.join(autoDir, 'automation.toml');
    if (!fs.existsSync(configPath)) { return '\u{1F4E6}'; } // 📦
    try {
        const data = toml.parse(fs.readFileSync(configPath, 'utf-8')) as any;
        const dep = data.deployment || {};
        const hasExposeTo = !!dep.expose_to || !!data.expose_to;
        const hasExpose = dep.expose === true;
        const hasKafka = !!(data.services?.kafka?.enabled);
        const image = (dep.image || '').toLowerCase();
        const dirName = path.basename(autoDir).toLowerCase();
        const isFrontend = image.includes('frontend') || dirName.includes('frontend');

        if (hasExposeTo) { return '\u{1F512}'; }                    // 🔒 internal frontend (OAuth protected)
        if (hasExpose && isFrontend) { return '\u{1F310}'; }        // 🌐 public frontend
        if (hasExpose) { return '\u{2699}\u{FE0F}'; }               // ⚙️ backend (exposed API)
        if (hasKafka) { return '\u{26A1}'; }                         // ⚡ kafka/streaming
        return '\u{1F4E6}';                                          // 📦 default
    } catch {
        return '\u{1F4E6}';
    }
}

function parseRequirementsToml(content: string): Requirement[] {
    try {
        const data = toml.parse(content) as any;
        const raw: any[] = data.requirement || [];
        return raw.map(r => ({
            id: String(r.id || ''),
            description: String(r.description || ''),
            status: (r.status as any) || 'pending',
            parent: String(r.parent || ''),
        }));
    } catch { return []; }
}

function serializeRequirementsToml(reqs: Requirement[]): string {
    const data = { requirement: reqs.map(r => ({ id: r.id, parent: r.parent, description: r.description, status: r.status })) };
    return toml.stringify(data as any);
}

interface ActiveSession {
    worktree: string;
    userEmail: string;
    terminalName: string;
}

const activeSessions: ActiveSession[] = [];

export class DashboardPanel {
    private static currentPanel: DashboardPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private disposed = false;
    private bpMap = new Map<string, string>();
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private currentKey = '';

    private playerJsUri: vscode.Uri | undefined;
    private playerCssUri: vscode.Uri | undefined;
    private codiconFontUri: vscode.Uri | undefined;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;

        const asciinemaDir = vscode.Uri.file(
            path.join(context.extensionPath, 'node_modules', 'asciinema-player', 'dist', 'bundle')
        );

        // Codicon font from code-server
        const codiconDir = vscode.Uri.file('/usr/lib/code-server/lib/vscode/out/media');

        this.panel = vscode.window.createWebviewPanel(
            'bitswan-workspace',
            'Workspace',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [asciinemaDir, codiconDir],
            },
        );

        this.playerJsUri = this.panel.webview.asWebviewUri(vscode.Uri.file(
            path.join(context.extensionPath, 'node_modules', 'asciinema-player', 'dist', 'bundle', 'asciinema-player.min.js')
        ));
        this.playerCssUri = this.panel.webview.asWebviewUri(vscode.Uri.file(
            path.join(context.extensionPath, 'node_modules', 'asciinema-player', 'dist', 'bundle', 'asciinema-player.css')
        ));
        this.codiconFontUri = this.panel.webview.asWebviewUri(
            vscode.Uri.file('/usr/lib/code-server/lib/vscode/out/media/codicon.ttf')
        );

        this.panel.webview.html = this._getHtmlForWebview();

        this.panel.webview.onDidReceiveMessage(
            (msg) => this.onMessage(msg),
            undefined,
            context.subscriptions,
        );

        this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/testable-requirements.toml');
        this.fileWatcher.onDidChange(() => this._reloadCurrentKey());
        this.fileWatcher.onDidCreate(() => this._reloadCurrentKey());

        // Watch for new automations (automation.toml creation)
        const autoWatcher = vscode.workspace.createFileSystemWatcher('**/automation.toml');
        autoWatcher.onDidCreate(() => this._reloadCurrentKey());
        context.subscriptions.push(autoWatcher);

        this.panel.onDidDispose(() => {
            this.disposed = true;
            if (this.fileWatcher) { this.fileWatcher.dispose(); }
            DashboardPanel.currentPanel = undefined;
        });
    }

    public static createOrShow(context: vscode.ExtensionContext): void {
        if (DashboardPanel.currentPanel && !DashboardPanel.currentPanel.disposed) {
            DashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        DashboardPanel.currentPanel = new DashboardPanel(context);
    }

    private async onMessage(msg: any): Promise<void> {
        if (!msg || !msg.type) { return; }
        switch (msg.type) {
            case 'ready':
                await this.loadBusinessProcesses();
                this.sendActiveSessions();
                this.postMessage({ type: 'anonMode', enabled: this.context.globalState.get<boolean>('agentAnonMode', false) });
                break;
            case 'loadBP':
                await this.loadBPContent(msg.key);
                break;
            case 'addRequirement':
                await this.addRequirement(msg.key, msg.requirement);
                break;
            case 'updateRequirement':
                await this.updateRequirement(msg.key, msg.requirement);
                break;
            case 'deleteRequirement':
                await this.deleteRequirement(msg.key, msg.requirementId);
                break;
            case 'openUrl':
                if (msg.url) {
                    vscode.env.openExternal(vscode.Uri.parse(msg.url));
                }
                break;
            case 'startLiveDev': {
                if (msg.relativePath && msg.worktree) {
                    try {
                        const { startLiveDev } = require('../lib');
                        const details = await getDeployDetails(this.context);
                        if (details) {
                            const result = await startLiveDev(details.deployUrl, details.deploySecret, msg.relativePath, msg.worktree);
                            if (result.success) {
                                vscode.window.showInformationMessage(`Live dev started for ${msg.name || 'automation'}`);
                                // Refresh after deploy completes
                                setTimeout(() => this._reloadCurrentKey(), 5000);
                            } else {
                                vscode.window.showErrorMessage('Failed to start live dev');
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to start live dev: ${err.message}`);
                    }
                }
                break;
            }
            case 'showLogs':
                if (msg.deploymentId) {
                    const automations = this.context.globalState.get<any[]>('automations', []);
                    const auto = automations?.find(a =>
                        (a.deployment_id || a.deploymentId) === msg.deploymentId
                    );
                    if (auto) {
                        const item = new AutomationItem(
                            auto.name || auto.deployment_id,
                            auto.state,
                            auto.status,
                            auto.deployment_id || auto.deploymentId,
                            auto.active,
                            auto.automation_url || auto.automationUrl,
                            auto.relative_path || auto.relativePath,
                        );
                        vscode.commands.executeCommand('bitswan.showAutomationLogs', item);
                    }
                }
                break;
            case 'restartAutomation':
                if (msg.deploymentId) {
                    const automations2 = this.context.globalState.get<any[]>('automations', []);
                    const auto2 = automations2?.find(a =>
                        (a.deployment_id || a.deploymentId) === msg.deploymentId
                    );
                    if (auto2) {
                        const item2 = new AutomationItem(
                            auto2.name || auto2.deployment_id,
                            auto2.state,
                            auto2.status,
                            auto2.deployment_id || auto2.deploymentId,
                            auto2.active,
                            auto2.automation_url || auto2.automationUrl,
                            auto2.relative_path || auto2.relativePath,
                        );
                        vscode.commands.executeCommand('bitswan.restartAutomation', item2);
                    }
                }
                break;
            case 'openCodingAgent':
                await this.openCodingAgentTerminal(msg.worktree, msg.bpPath);
                break;
            case 'openTerminal':
                await this.openPlainTerminal(msg.worktree, msg.bpPath);
                break;
            case 'createWorktree':
                await this.createWorktree();
                break;
            case 'createBusinessProcess':
                await this.createBusinessProcess(msg.worktree);
                break;
            case 'createAutomation':
                await this.createAutomation(msg.worktree, msg.bpPath);
                break;
            case 'mergeWorktree':
                await this.mergeWorktree(msg.worktree);
                break;
            case 'focusTerminal': {
                const t = vscode.window.terminals.find(t => t.name === msg.terminalName);
                if (t) { t.show(true); }
                break;
            }
            case 'toggleAnon': {
                const current = this.context.globalState.get<boolean>('agentAnonMode', false);
                await this.context.globalState.update('agentAnonMode', !current);
                this.postMessage({ type: 'anonMode', enabled: !current });
                break;
            }
            case 'playSession': {
                if (msg.castFile) {
                    try {
                        const fullPath = path.join(SESSIONS_DIR, msg.castFile);
                        const castContent = fs.readFileSync(fullPath, 'utf8');
                        this.postMessage({ type: 'castData', castFile: msg.castFile, data: castContent });
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to load recording: ${err.message}`);
                    }
                }
                break;
            }
        }
    }

    // ---- Discovery ----

    private _findBPsUnder(root: string, maxDepth: number): string[] {
        const results: string[] = [];
        const walk = (dir: string, depth: number) => {
            if (depth > maxDepth) { return; }
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
                const fullPath = path.join(dir, entry.name);
                if (fs.existsSync(path.join(fullPath, 'process.toml'))) {
                    results.push(fullPath);
                }
                walk(fullPath, depth + 1);
            }
        };
        walk(root, 0);
        return results;
    }

    private async loadBusinessProcesses(): Promise<void> {
        this.bpMap.clear();
        const workspaces: { name: string; bps: { key: string; label: string }[] }[] = [];

        // Only show worktrees — no Main tab
        if (fs.existsSync(WORKTREES_DIR)) {
            let wtEntries: fs.Dirent[];
            try { wtEntries = fs.readdirSync(WORKTREES_DIR, { withFileTypes: true }); } catch { wtEntries = []; }
            for (const wtEntry of wtEntries) {
                if (!wtEntry.isDirectory() || wtEntry.name.startsWith('.') || wtEntry.name === 'worktrees') { continue; }
                const wtPath = path.join(WORKTREES_DIR, wtEntry.name);
                const bps = this._findBPsUnder(wtPath, 4);
                const bpEntries: { key: string; label: string }[] = [];
                for (const dirPath of bps) {
                    const rel = path.relative(wtPath, dirPath);
                    const key = `worktree:${wtEntry.name}:${rel}`;
                    bpEntries.push({ key, label: rel });
                    this.bpMap.set(key, dirPath);
                }
                // Always include the worktree even if it has no BPs yet
                workspaces.push({ name: wtEntry.name, bps: bpEntries });
            }
        }

        this.postMessage({ type: 'structure', workspaces });
    }

    // ---- Load BP content ----

    private async loadBPContent(key: string): Promise<void> {
        this.currentKey = key;
        const dirPath = this.bpMap.get(key);
        if (!dirPath) {
            this.postMessage({ type: 'bpContent', key, requirements: [], automations: [], readme: '', worktree: '', bpPath: '' });
            return;
        }

        // Requirements
        const requirements = this._readLocalReqs(dirPath);

        // README
        let readme = '';
        const readmePath = path.join(dirPath, 'README.md');
        if (fs.existsSync(readmePath)) {
            try { readme = fs.readFileSync(readmePath, 'utf-8'); } catch { /* */ }
        }

        // Automations — match by relative_path
        const allAutomations = this.context.globalState.get<any[]>('automations', []);
        const automations: AutomationInfo[] = [];

        // Find automation dirs under this BP
        const automationDirs = this._findAutomationDirsUnder(dirPath);
        for (const autoDir of automationDirs) {
            const autoName = path.basename(autoDir);
            const relFromWorkspace = path.relative(WORKSPACE_DIR, autoDir);
            // Find matching automation from global state
            const match = allAutomations?.find(a => {
                const aPath = a.relative_path || a.relativePath || '';
                return aPath === relFromWorkspace || aPath.endsWith('/' + relFromWorkspace);
            });
            automations.push({
                name: autoName,
                deploymentId: match ? (match.deployment_id || match.deploymentId || '') : '',
                state: match ? (match.state || 'not deployed') : 'not deployed',
                url: match ? (match.automation_url || match.automationUrl || '') : '',
                relativePath: relFromWorkspace,
                icon: inferAutomationIcon(autoDir),
            });
        }

        // Parse key to get worktree and bpPath
        let worktree = '';
        let bpPath = '';
        if (key.startsWith('worktree:')) {
            const parts = key.split(':');
            worktree = parts[1] || '';
            bpPath = parts.slice(2).join(':');
        } else if (key.startsWith('workspace:')) {
            bpPath = key.substring('workspace:'.length);
        }

        // Agent sessions for this worktree
        const sessions = worktree ? this._scanSessions(worktree) : [];

        this.postMessage({ type: 'bpContent', key, requirements, automations, readme, worktree, bpPath, sessions });
    }

    private _scanSessions(worktree: string): { timestamp: string; userEmail: string; worktree: string; castFile: string; logged: boolean }[] {
        if (!fs.existsSync(SESSIONS_DIR)) { return []; }
        const sessions: { timestamp: string; userEmail: string; worktree: string; castFile: string; logged: boolean }[] = [];
        try {
            const entries = fs.readdirSync(SESSIONS_DIR);
            for (const e of entries) {
                if (!e.endsWith('.meta.json')) { continue; }
                try {
                    const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, e), 'utf8'));
                    if ((meta.worktree || '') === worktree) {
                        const baseName = e.replace('.meta.json', '');
                        const castFile = baseName + '.cast';
                        const hasCast = fs.existsSync(path.join(SESSIONS_DIR, castFile));
                        sessions.push({
                            timestamp: meta.timestamp || meta.started_at || '',
                            userEmail: meta.user_email || meta.userEmail || '',
                            worktree: meta.worktree || '',
                            castFile: hasCast ? castFile : '',
                            logged: meta.logged !== false,
                        });
                    }
                } catch { /* skip */ }
            }
        } catch { /* */ }
        sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return sessions.slice(0, 20);
    }

    private _findAutomationDirsUnder(bpDir: string): string[] {
        const results: string[] = [];
        const walk = (dir: string, depth: number) => {
            if (depth > 3) { return; }
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'image') { continue; }
                const fullPath = path.join(dir, entry.name);
                if (fs.existsSync(path.join(fullPath, 'automation.toml'))) {
                    results.push(fullPath);
                }
                walk(fullPath, depth + 1);
            }
        };
        walk(bpDir, 0);
        return results;
    }

    // ---- File I/O ----

    private _readLocalReqs(dirPath: string): Requirement[] {
        const filePath = path.join(dirPath, REQUIREMENTS_FILENAME);
        if (!fs.existsSync(filePath)) { return []; }
        try { return parseRequirementsToml(fs.readFileSync(filePath, 'utf-8')); }
        catch { return []; }
    }

    private _writeLocalReqs(dirPath: string, reqs: Requirement[]): void {
        fs.writeFileSync(path.join(dirPath, REQUIREMENTS_FILENAME), serializeRequirementsToml(reqs), 'utf-8');
    }

    // ---- Requirements CRUD ----

    private async addRequirement(key: string, requirement: Omit<Requirement, 'id'>): Promise<void> {
        const dirPath = this.bpMap.get(key);
        if (!dirPath) { return; }
        const existing = this._readLocalReqs(dirPath);
        const maxNum = existing.reduce((max, r) => {
            const m = r.id.match(/\d+$/);
            return m ? Math.max(max, parseInt(m[0], 10)) : max;
        }, 0);
        const prefix = requirement.status === 'proposed' ? 'AI-' : 'REQ-';
        const newId = prefix + (maxNum + 1).toString().padStart(3, '0');
        existing.push({ id: newId, ...requirement } as Requirement);
        this._writeLocalReqs(dirPath, existing);
        await this.loadBPContent(key);
    }

    private async updateRequirement(key: string, requirement: Requirement): Promise<void> {
        const dirPath = this.bpMap.get(key);
        if (!dirPath || !requirement?.id) { return; }
        const existing = this._readLocalReqs(dirPath);
        const idx = existing.findIndex(r => r.id === requirement.id);
        if (idx >= 0) {
            existing[idx] = requirement;
            this._writeLocalReqs(dirPath, existing);
        }
        await this.loadBPContent(key);
    }

    private async deleteRequirement(key: string, requirementId: string): Promise<void> {
        if (!key || !requirementId) { return; }
        const confirmation = await vscode.window.showWarningMessage(
            `Delete requirement "${requirementId}"?`, { modal: true }, 'Delete'
        );
        if (confirmation !== 'Delete') { return; }
        const dirPath = this.bpMap.get(key);
        if (!dirPath) { return; }
        const filtered = this._readLocalReqs(dirPath).filter(r => r.id !== requirementId);
        this._writeLocalReqs(dirPath, filtered);
        await this.loadBPContent(key);
    }

    private _reloadCurrentKey(): void {
        if (!this.disposed && this.currentKey) {
            this.loadBPContent(this.currentKey);
        }
    }

    // ---- Terminals ----

    /**
     * Ensure the coding agent container is running, auto-starting it if needed.
     * Returns the agent hostname, or null if it couldn't be started.
     */
    private async ensureAgentRunning(): Promise<string | null> {
        const workspaceName = process.env.HOSTNAME?.replace('-editor', '') || 'workspace';
        const agentHost = `${workspaceName}-coding-agent`;

        const isReachable = () => new Promise<boolean>(resolve => {
            cp.exec(`getent hosts ${agentHost}`, (err) => resolve(!err));
        });

        if (await isReachable()) { return agentHost; }

        const started = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Starting coding agent container...',
            cancellable: false,
        }, async (progress) => {
            const details = await getDeployDetails(this.context);
            if (!details) { return false; }
            try {
                await axios.post(
                    `${details.deployUrl}/worktrees/coding-agent/ensure`,
                    {},
                    { headers: { Authorization: `Bearer ${details.deploySecret}` }, timeout: 120000 },
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to start coding agent: ${err?.response?.data?.detail || err?.message}`);
                return false;
            }
            progress.report({ message: 'Waiting for SSH to become ready...' });
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 2000));
                if (await isReachable()) { return true; }
            }
            vscode.window.showErrorMessage('Coding agent started but SSH is not reachable yet.');
            return false;
        });

        return started ? agentHost : null;
    }

    /**
     * Open an SSH terminal to the coding agent container.
     * @param name - Terminal tab name
     * @param worktree - Worktree name
     * @param autoCmd - Command to run on the remote (via SSH_AUTO_CMD). If empty, drops to shell.
     */
    private async openSSHTerminal(name: string, worktree: string, autoCmd: string): Promise<vscode.Terminal | null> {
        const agentHost = await this.ensureAgentRunning();
        if (!agentHost) { return null; }

        const userEmail = await getUserEmail(this.context) || 'unknown';
        const anon = this.context.globalState.get<boolean>('agentAnonMode', false);
        const logged = anon ? 'false' : 'true';

        // Write a temp script to avoid quoting issues
        const tmpDir = '/tmp/bitswan-terminals';
        if (!fs.existsSync(tmpDir)) { fs.mkdirSync(tmpDir, { recursive: true }); }
        const scriptPath = path.join(tmpDir, `agent-${Date.now()}.sh`);
        const scriptLines = [
            `export SSH_USER_EMAIL="${userEmail}"`,
            `export SSH_LOGGED="${logged}"`,
            `export SSH_WORKTREE="${worktree}"`,
        ];
        if (autoCmd) {
            const b64 = Buffer.from(autoCmd).toString('base64');
            scriptLines.push(`export SSH_AUTO_CMD="$(echo ${b64} | base64 -d)"`);
        }
        scriptLines.push(`exec ssh -t -i /workspace/.ssh/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o 'SendEnv=SSH_USER_EMAIL SSH_LOGGED SSH_WORKTREE SSH_AUTO_CMD' agent@${agentHost}`);
        fs.writeFileSync(scriptPath, scriptLines.join('\n') + '\n');

        const terminal = vscode.window.createTerminal({
            name,
            shellPath: '/usr/bin/env',
            shellArgs: ['bash', scriptPath],
        });
        terminal.show(true);

        // Track active session
        const termName = terminal.name;
        activeSessions.push({ worktree, userEmail, terminalName: termName });
        this.sendActiveSessions();

        const disposable = vscode.window.onDidCloseTerminal(t => {
            if (t.name === termName) {
                const idx = activeSessions.findIndex(s => s.terminalName === termName);
                if (idx >= 0) { activeSessions.splice(idx, 1); }
                if (DashboardPanel.currentPanel) {
                    DashboardPanel.currentPanel.sendActiveSessions();
                    DashboardPanel.currentPanel._reloadCurrentKey();
                }
                disposable.dispose();
            }
        });

        // Refresh sessions after meta.json is created by the agent container
        setTimeout(() => this._reloadCurrentKey(), 5000);
        return terminal;
    }

    private async openCodingAgentTerminal(worktree: string, bpPath: string): Promise<void> {
        if (worktree) {
            const cdPath = `/workspace/worktrees/${worktree}/${bpPath}`;
            const autoCmd = `cd ${cdPath} && mkdir -p ~/.claude && echo '{"skipDangerousModePermissionPrompt":true}' > ~/.claude/settings.json && exec claude --dangerously-skip-permissions`;
            await this.openSSHTerminal(`Claude: ${worktree}/${bpPath}`, worktree, autoCmd);
        } else {
            const cdPath = path.join(WORKSPACE_DIR, bpPath);
            const terminal = vscode.window.createTerminal({ name: `Claude: ${bpPath}`, cwd: cdPath });
            terminal.show(true);
            terminal.sendText(`mkdir -p ~/.claude && echo '{"skipDangerousModePermissionPrompt":true}' > ~/.claude/settings.json && exec claude --dangerously-skip-permissions`);
        }
    }

    private async openPlainTerminal(worktree: string, bpPath: string): Promise<void> {
        if (worktree) {
            const cdPath = `/workspace/worktrees/${worktree}/${bpPath}`;
            await this.openSSHTerminal(`Terminal: ${worktree}/${bpPath}`, worktree, `cd ${cdPath} && exec bash`);
        } else {
            const terminal = vscode.window.createTerminal({ name: `Terminal: ${bpPath}`, cwd: path.join(WORKSPACE_DIR, bpPath) });
            terminal.show(true);
        }
    }

    // ---- Create flows ----

    private async createWorktree(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Worktree branch name',
            placeHolder: 'e.g. feature-login',
            validateInput: (v) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v) ? null : 'Letters, numbers, hyphens and underscores only',
        });
        if (!name) { return; }

        try {
            // Try GitOps API first
            const details = await getDeployDetails(this.context);
            if (details) {
                await axios.post(
                    `${details.deployUrl}/worktrees/create`,
                    { branch_name: name },
                    { headers: { Authorization: `Bearer ${details.deploySecret}` } },
                );
            }
        } catch {
            // Fallback: create locally
            const wtPath = path.join(WORKTREES_DIR, name);
            if (!fs.existsSync(wtPath)) {
                fs.mkdirSync(wtPath, { recursive: true });
            }
        }

        vscode.window.showInformationMessage(`Worktree "${name}" created.`);
        await this.loadBusinessProcesses();
    }

    private async createBusinessProcess(worktree: string): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Business process name',
            placeHolder: 'e.g. user-management',
            validateInput: (v) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v) ? null : 'Letters, numbers, hyphens and underscores only',
        });
        if (!name) { return; }

        const bpDir = path.join(WORKTREES_DIR, worktree, name);
        fs.mkdirSync(bpDir, { recursive: true });

        // Create process.toml
        const processId = require('crypto').randomUUID();
        fs.writeFileSync(
            path.join(bpDir, 'process.toml'),
            `process-id = "${processId}"\n`,
            'utf-8',
        );

        // Create README.md
        fs.writeFileSync(
            path.join(bpDir, 'README.md'),
            `# ${name}\n\nDescribe this business process here.\n`,
            'utf-8',
        );

        vscode.window.showInformationMessage(`Business process "${name}" created in worktree "${worktree}".`);
        await this.loadBusinessProcesses();
    }

    private async createAutomation(worktree: string, bpPath: string): Promise<void> {
        // Pass relative path from workspace root so the templates gallery
        // places the new automation in the correct worktree BP directory
        const relPath = `worktrees/${worktree}/${bpPath}`;
        const bpDir = path.join(WORKSPACE_DIR, relPath);
        if (!fs.existsSync(bpDir)) {
            vscode.window.showErrorMessage(`Business process directory not found: ${bpDir}`);
            return;
        }

        vscode.commands.executeCommand('bitswan.openAutomationTemplates', relPath);
    }

    private async mergeWorktree(worktree: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Merge worktree "${worktree}" into the main branch?`,
            { modal: true },
            'Merge',
        );
        if (confirm !== 'Merge') { return; }

        const details = await getDeployDetails(this.context);
        if (!details) { return; }

        try {
            // First commit any uncommitted changes
            try {
                await axios.post(
                    `${details.deployUrl}/agent/worktrees/${worktree}/vcs/commit`,
                    { message: 'Pre-merge commit' },
                    { headers: { Authorization: `Bearer ${details.deploySecret}` } },
                );
            } catch { /* may fail if nothing to commit — that's fine */ }

            // Start rebase-and-merge
            const result = await axios.post(
                `${details.deployUrl}/agent/worktrees/${worktree}/rebase-and-merge`,
                {},
                {
                    headers: { Authorization: `Bearer ${details.deploySecret}` },
                    validateStatus: () => true,
                },
            );

            const data = result.data;

            if (data.status === 'merged' || data.status === 'success') {
                // Merge succeeded — ask to delete worktree
                const merged_into = data.merged_into || 'main';
                const deleteConfirm = await vscode.window.showInformationMessage(
                    `Worktree "${worktree}" merged into ${merged_into}. Delete the worktree?`,
                    'Delete Worktree',
                    'Keep',
                );
                if (deleteConfirm === 'Delete Worktree') {
                    try {
                        await axios.delete(
                            `${details.deployUrl}/worktrees/${worktree}`,
                            { headers: { Authorization: `Bearer ${details.deploySecret}` } },
                        );
                        vscode.window.showInformationMessage(`Worktree "${worktree}" deleted.`);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to delete worktree: ${err.message}`);
                    }
                }
                await this.loadBusinessProcesses();
            } else if (data.status === 'conflicts') {
                // Conflicts — launch Claude to resolve
                const conflictedFiles = (data.conflicted_files || []).join(', ');
                vscode.window.showWarningMessage(
                    `Merge has conflicts in: ${conflictedFiles}. Launching Claude to resolve.`,
                );
                await this.launchMergeConflictAgent(worktree, data.conflicted_files || []);
            } else {
                vscode.window.showErrorMessage(
                    `Merge failed: ${data.detail || data.message || JSON.stringify(data)}`,
                );
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Merge failed: ${err.message}`);
        }
    }

    private async launchMergeConflictAgent(worktree: string, conflictedFiles: string[]): Promise<void> {
        const wtPath = `/workspace/worktrees/${worktree}`;
        const conflictList = conflictedFiles.map(f => `  - ${f}`).join('\n');
        const claudePrompt = [
            `A rebase-and-merge is in progress for worktree "${worktree}" and there are conflicts.`,
            ``,
            `Conflicted files:`,
            conflictList,
            ``,
            `Please:`,
            `1. Open each conflicted file and resolve the conflict markers (<<<<<<<, =======, >>>>>>>)`,
            `2. After resolving ALL conflicts, run: bitswan-coding-agent vcs rebase-continue`,
            `3. If more conflicts arise, repeat`,
            `4. Once the merge is complete, tell the user it's done`,
        ].join('\\n');

        const autoCmd = `cd ${wtPath} && mkdir -p ~/.claude && echo '{"skipDangerousModePermissionPrompt":true}' > ~/.claude/settings.json && exec claude --dangerously-skip-permissions -p "${claudePrompt}"`;
        await this.openSSHTerminal(`Merge: ${worktree}`, worktree, autoCmd);
    }

    private sendActiveSessions(): void {
        this.postMessage({ type: 'activeSessions', sessions: activeSessions });
    }

    private postMessage(msg: any): void {
        if (!this.disposed) { this.panel.webview.postMessage(msg); }
    }

    // ---- HTML ----

    private _getHtmlForWebview(): string {
        return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        @font-face { font-family: codicon; src: url(${this.codiconFontUri}); }
        .codicon { font-family: codicon; font-size: 14px; line-height: 1; display: inline-block; }
        .codicon-output::before { content: "\\eb9d"; }
        .codicon-debug-restart::before { content: "\\ead2"; }
        .codicon-debug-start::before { content: "\\ead3"; }
        .codicon-link-external::before { content: "\\eb14"; }
        :root { color-scheme: light dark; font-family: var(--vscode-font-family, sans-serif);
            --status-pass: #3fb950; --status-fail: #f85149; --status-pending: #d29922; --status-retest: #a371f7; --status-proposed: #768390; --border: var(--vscode-editorWidget-border, rgba(128,128,128,0.3)); }
        * { box-sizing: border-box; }
        body { margin:0; padding:0; font-size:13px; color:var(--vscode-foreground); background:var(--vscode-editor-background); display:flex; flex-direction:column; height:100vh; overflow:hidden; }
        .header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border); flex-shrink:0; }
        .header h2 { margin:0; font-size:16px; }
        .tab-label { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:var(--vscode-descriptionForeground); padding:6px 8px 6px 0; white-space:nowrap; }
        .tab-bar { display:flex; border-bottom:2px solid var(--border); flex-shrink:0; padding:0 8px; }
        .tab { padding:8px 16px; cursor:pointer; font-size:12px; font-weight:500; border-bottom:2px solid transparent; margin-bottom:-2px; color:var(--vscode-descriptionForeground); }
        .tab:hover { color:var(--vscode-foreground); }
        .tab.active { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder, #007acc); }
        .subtab-bar { display:flex; border-bottom:1px solid var(--border); flex-shrink:0; padding:0 8px; background:var(--vscode-sideBar-background, rgba(128,128,128,0.05)); }
        .subtab { padding:6px 14px; cursor:pointer; font-size:11px; border-bottom:2px solid transparent; margin-bottom:-1px; color:var(--vscode-descriptionForeground); }
        .subtab:hover { color:var(--vscode-foreground); }
        .subtab.active { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder, #007acc); }
        .content { flex:1; overflow-y:auto; padding:12px 16px; }
        .placeholder { padding:32px 16px; text-align:center; color:var(--vscode-descriptionForeground); }

        /* Sections */
        .section { margin-bottom:20px; }
        .section-title { font-size:13px; font-weight:600; margin-bottom:8px; color:var(--vscode-descriptionForeground); text-transform:uppercase; letter-spacing:0.5px; }

        /* Action cards row */
        .action-cards { display:flex; gap:10px; flex-wrap:wrap; }
        .action-card { flex:1; min-width:140px; padding:16px; border:1px solid var(--border); border-radius:8px; cursor:pointer; text-align:center; transition: border-color 0.15s; }
        .action-card:hover { border-color:var(--vscode-focusBorder, #007acc); }
        .action-card .card-icon { font-size:24px; margin-bottom:6px; }
        .action-card .card-label { font-size:12px; font-weight:600; }
        .action-card .card-desc { font-size:11px; color:var(--vscode-descriptionForeground); margin-top:2px; }

        /* Automation cards */
        .auto-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:12px; }
        .auto-card { display:flex; flex-direction:column; border:1px solid var(--border); border-radius:10px; transition: border-color 0.15s, box-shadow 0.15s; overflow:hidden; }
        .auto-card:hover { border-color:var(--vscode-focusBorder, #007acc); box-shadow:0 2px 8px rgba(0,0,0,0.1); }
        .auto-card-top { padding:16px; position:relative; }
        .auto-card-top.clickable { cursor:pointer; }
        .auto-card-top.clickable:hover { background:var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
        .auto-card-link-icon { position:absolute; top:12px; right:12px; font-size:12px; color:var(--vscode-descriptionForeground); }
        .auto-card-icon { font-size:28px; margin-bottom:10px; text-align:center; }
        .auto-card-name { font-weight:600; font-size:14px; margin-bottom:4px; }
        .auto-card-state { display:inline-block; font-size:10px; padding:2px 8px; border-radius:10px; text-transform:uppercase; font-weight:600; letter-spacing:0.3px; margin-bottom:8px; }
        .auto-card-state.running { background:var(--status-pass); color:#fff; }
        .auto-card-state.exited, .auto-card-state.dead { background:var(--status-fail); color:#fff; }
        .auto-card-state.not-deployed { background:var(--status-proposed); color:#fff; }
        .auto-card-actions { display:flex; gap:6px; border-top:1px solid var(--border); padding:10px 16px; }

        /* Buttons */
        .btn { padding:4px 10px; border:1px solid var(--vscode-button-border, transparent); border-radius:4px; background:var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); color:var(--vscode-button-secondaryForeground, var(--vscode-foreground)); cursor:pointer; font-size:11px; }
        .btn:hover { opacity:0.85; }
        .btn-sm { padding:2px 8px; font-size:11px; }
        .btn-primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
        .btn-ghost { background:transparent; color:var(--vscode-descriptionForeground); border:none; }
        .btn-ghost:hover { background:var(--status-fail); color:#fff; }

        /* README */
        .readme { padding:12px; border:1px solid var(--border); border-radius:8px; background:var(--vscode-sideBar-background, rgba(128,128,128,0.05)); font-size:12px; line-height:1.5; white-space:pre-wrap; max-height:200px; overflow-y:auto; }

        /* Requirements (from original) */
        .req-node { margin-bottom:6px; position:relative; }
        .req-card { border:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); border-radius:6px; padding:8px 12px; background:var(--vscode-editor-background); position:relative; outline:none; }
        .req-card:hover, .req-card:focus { border-color:var(--vscode-focusBorder, rgba(128,128,128,0.5)); }
        .req-card:focus { box-shadow:0 0 0 1px var(--vscode-focusBorder, #007acc); }
        .req-card-header { display:flex; align-items:center; gap:8px; }
        .req-id { font-weight:600; font-size:11px; color:var(--vscode-descriptionForeground); }
        .status-badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:10px; font-weight:600; text-transform:uppercase; cursor:pointer; user-select:none; }
        .status-badge.pass { background:var(--status-pass); color:#fff; }
        .status-badge.fail { background:var(--status-fail); color:#fff; }
        .status-badge.pending { background:var(--status-pending); color:#fff; }
        .status-badge.retest { background:var(--status-retest); color:#fff; }
        .status-badge.proposed { background:var(--status-proposed); color:#fff; font-style:italic; }
        .req-desc { font-size:12px; line-height:1.4; white-space:pre-wrap; cursor:text; padding:4px 0 2px; min-height:16px; }
        .req-desc:hover { background:var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); border-radius:4px; }
        .req-desc textarea { width:100%; min-height:40px; padding:4px 6px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-focusBorder); border-radius:4px; font-size:12px; font-family:inherit; resize:vertical; }
        .req-actions { display:flex; gap:6px; align-items:center; margin-left:auto; }
        .req-children { margin-left:20px; margin-top:4px; }
        .add-child-btn { display:block; margin:4px auto 0; padding:1px 12px; border:1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.4)); border-radius:4px; background:transparent; color:var(--vscode-descriptionForeground); cursor:pointer; font-size:11px; }
        .add-child-btn:hover { border-color:var(--vscode-focusBorder); color:var(--vscode-foreground); }
        .add-root-btn { display:block; margin:8px auto; padding:4px 16px; border:1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.4)); border-radius:6px; background:transparent; color:var(--vscode-descriptionForeground); cursor:pointer; font-size:12px; }
        .add-root-btn:hover { border-color:var(--vscode-focusBorder); color:var(--vscode-foreground); }
        .keyhints { display:flex; flex-wrap:wrap; gap:12px; padding:6px 16px; border-top:1px solid var(--border); flex-shrink:0; font-size:11px; color:var(--vscode-descriptionForeground); }
        .keyhints kbd { padding:1px 5px; border:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.4)); border-radius:3px; font-size:10px; font-family:inherit; background:var(--vscode-sideBar-background, rgba(128,128,128,0.1)); }
        #playerWrapper { min-height:400px; }
        #playerWrapper .ap-wrapper { width:100% !important; }
    </style>
    <link rel="stylesheet" type="text/css" href="${this.playerCssUri}" />
</head>
<body>
    <div class="header"><h2>Workspace</h2></div>
    <div style="display:flex; align-items:center; padding:0 8px;">
        <span class="tab-label">Worktrees</span>
        <div class="tab-bar" id="tabBar" style="flex:1;"></div>
    </div>
    <div style="display:flex; align-items:center; padding:0 8px;">
        <span class="tab-label">Business Processes</span>
        <div class="subtab-bar" id="subtabBar" style="flex:1;"></div>
    </div>
    <div class="content" id="content">
        <div class="placeholder" id="placeholder">Loading...</div>
    </div>
    <div class="keyhints" id="keyhints"></div>
    <script>
        var vscodeApi = acquireVsCodeApi();
        var tabBar = document.getElementById('tabBar');
        var subtabBar = document.getElementById('subtabBar');
        var content = document.getElementById('content');
        var keyhints = document.getElementById('keyhints');

        var structure = [];
        var currentWsIdx = 0;
        var currentBpKey = '';
        var bpData = null; // { requirements, automations, readme, worktree, bpPath, sessions }
        var anonMode = false;
        var activeSessionsList = [];

        function renderActiveSessions(container) {
            if (!container) { container = document.getElementById('activeSessions'); }
            if (!container) return;
            container.innerHTML = '';
            var filtered = activeSessionsList.filter(function(s) {
                return !bpData || !bpData.worktree || s.worktree === bpData.worktree;
            });
            if (filtered.length === 0) return;
            filtered.forEach(function(s) {
                var row = mkEl('div', '');
                row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid var(--border); border-radius:6px; margin-bottom:4px;';
                var dot = mkEl('span', '');
                dot.style.cssText = 'width:8px; height:8px; border-radius:50%; background:var(--status-pass); flex-shrink:0;';
                row.appendChild(dot);
                row.appendChild(mkEl('span', '', s.terminalName + ' — ' + s.userEmail));
                var focusBtn = mkEl('button', 'btn btn-sm', 'Focus');
                focusBtn.style.marginLeft = 'auto';
                focusBtn.addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'focusTerminal', terminalName: s.terminalName });
                });
                row.appendChild(focusBtn);
                container.appendChild(row);
            });
        }
        var mode = 'navigate';

        function cycleStatus(s) { var o=['pending','pass','fail','retest','proposed']; return o[(o.indexOf(s)+1)%o.length]; }

        function setMode(m) {
            mode = m;
            if (m === 'navigate') {
                keyhints.innerHTML = '<span><kbd>\\u2191</kbd><kbd>\\u2193</kbd> Siblings</span><span><kbd>\\u2192</kbd> Child</span><span><kbd>\\u2190</kbd> Parent</span><span><kbd>Enter</kbd> Edit</span><span><kbd>Space</kbd> Cycle status</span><span><kbd>N</kbd> New</span><span><kbd>C</kbd> Child</span><span><kbd>Del</kbd> Remove</span>';
            } else if (m === 'editing') {
                keyhints.innerHTML = '<span><kbd>Enter</kbd> Save</span><span><kbd>Shift+Enter</kbd> Newline</span><span><kbd>Esc</kbd> Cancel</span>';
            } else if (m === 'adding') {
                keyhints.innerHTML = '<span><kbd>Enter</kbd> Add</span><span><kbd>Shift+Enter</kbd> Newline</span><span><kbd>Esc</kbd> Cancel</span>';
            }
        }

        function renderTabs() {
            tabBar.innerHTML = '';
            structure.forEach(function(ws, idx) {
                var tab = document.createElement('div');
                tab.className = 'tab' + (idx === currentWsIdx ? ' active' : '');
                tab.textContent = ws.name;
                tab.addEventListener('click', function() { currentWsIdx = idx; currentBpKey = ''; bpData = null; renderTabs(); renderSubtabs(); renderContent(); });
                tabBar.appendChild(tab);
            });
            // "+ New Worktree" tab
            var addWtTab = document.createElement('div');
            addWtTab.className = 'tab';
            addWtTab.textContent = '+';
            addWtTab.title = 'Create new worktree';
            addWtTab.style.cssText = 'font-weight:bold; font-size:16px; padding:4px 12px;';
            addWtTab.addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'createWorktree' });
            });
            tabBar.appendChild(addWtTab);
        }

        function getActiveWorktree() {
            var ws = structure[currentWsIdx];
            return ws ? ws.name : '';
        }

        function renderSubtabs() {
            subtabBar.innerHTML = '';
            var ws = structure[currentWsIdx];
            if (!ws) return;
            ws.bps.forEach(function(bp) {
                var tab = document.createElement('div');
                tab.className = 'subtab' + (bp.key === currentBpKey ? ' active' : '');
                tab.textContent = bp.label;
                tab.addEventListener('click', function() {
                    currentBpKey = bp.key;
                    bpData = null;
                    vscodeApi.postMessage({ type: 'loadBP', key: bp.key });
                    renderSubtabs();
                    renderContent();
                });
                subtabBar.appendChild(tab);
            });
            // "+ New Business Process" subtab
            var addBpTab = document.createElement('div');
            addBpTab.className = 'subtab';
            addBpTab.textContent = '+';
            addBpTab.title = 'Create new business process';
            addBpTab.style.cssText = 'font-weight:bold; font-size:14px; padding:4px 12px;';
            addBpTab.addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'createBusinessProcess', worktree: getActiveWorktree() });
            });
            subtabBar.appendChild(addBpTab);

            if (!currentBpKey && ws.bps.length > 0) {
                currentBpKey = ws.bps[0].key;
                vscodeApi.postMessage({ type: 'loadBP', key: currentBpKey });
                renderSubtabs();
            }
        }

        function mkEl(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

        function renderContent() {
            content.innerHTML = '';
            setMode('navigate');
            if (!currentBpKey) {
                content.innerHTML = '<div class="placeholder">Select a business process tab above.</div>';
                return;
            }
            if (!bpData) {
                content.innerHTML = '<div class="placeholder">Loading...</div>';
                return;
            }

            // Action cards (Coding Agent + Terminal) — only for worktrees
            {
                var actionsSection = mkEl('div', 'section');
                actionsSection.appendChild(mkEl('div', 'section-title', 'Actions'));
                var actionsRow = mkEl('div', 'action-cards');

                var agentCard = mkEl('div', 'action-card');
                agentCard.innerHTML = '<div class="card-icon">\\u{1F916}</div><div class="card-label">Coding Agent</div><div class="card-desc">Launch Claude in this BP</div>';
                agentCard.addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'openCodingAgent', worktree: bpData.worktree, bpPath: bpData.bpPath });
                });
                actionsRow.appendChild(agentCard);

                var termCard = mkEl('div', 'action-card');
                termCard.innerHTML = '<div class="card-icon">\\u{1F4BB}</div><div class="card-label">Terminal</div><div class="card-desc">Plain shell in this BP</div>';
                termCard.addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'openTerminal', worktree: bpData.worktree, bpPath: bpData.bpPath });
                });
                actionsRow.appendChild(termCard);

                if (bpData.worktree) {
                    var mergeCard = mkEl('div', 'action-card');
                    mergeCard.innerHTML = '<div class="card-icon">\\u{1F500}</div><div class="card-label">Merge</div><div class="card-desc">Merge worktree into main</div>';
                    mergeCard.addEventListener('click', function() {
                        vscodeApi.postMessage({ type: 'mergeWorktree', worktree: bpData.worktree });
                    });
                    actionsRow.appendChild(mergeCard);
                }

                actionsSection.appendChild(actionsRow);
                content.appendChild(actionsSection);
            }

            // Automations
            {
                var autoSection = mkEl('div', 'section');
                autoSection.appendChild(mkEl('div', 'section-title', 'Automations'));
                var autoCards = mkEl('div', 'auto-cards');

                if (bpData.automations) {
                    bpData.automations.forEach(function(auto) {
                        var card = mkEl('div', 'auto-card');

                        // Top section (clickable if URL exists)
                        var top = mkEl('div', 'auto-card-top' + (auto.url ? ' clickable' : ''));
                        if (auto.url) {
                            top.addEventListener('click', function() {
                                vscodeApi.postMessage({ type: 'openUrl', url: auto.url });
                            });
                            var linkIcon = mkEl('span', 'auto-card-link-icon');
                            linkIcon.innerHTML = '<span class="codicon codicon-link-external"></span>';
                            top.appendChild(linkIcon);
                        }
                        top.appendChild(mkEl('div', 'auto-card-icon', auto.icon || '\\u{1F4E6}'));
                        top.appendChild(mkEl('div', 'auto-card-name', auto.name));
                        var stateClass = (auto.state || 'not-deployed').replace(/\\s+/g, '-').toLowerCase();
                        top.appendChild(mkEl('span', 'auto-card-state ' + stateClass, auto.state || 'not deployed'));
                        card.appendChild(top);

                        // Action buttons at bottom
                        var actions = mkEl('div', 'auto-card-actions');
                        if (auto.deploymentId) {
                            var logsBtn = mkEl('button', 'btn', '');
                            logsBtn.innerHTML = '<span class="codicon codicon-output"></span> Logs';
                            logsBtn.addEventListener('click', function() {
                                vscodeApi.postMessage({ type: 'showLogs', deploymentId: auto.deploymentId });
                            });
                            actions.appendChild(logsBtn);

                            var restartBtn = mkEl('button', 'btn', '');
                            restartBtn.innerHTML = '<span class="codicon codicon-debug-restart"></span> Restart';
                            restartBtn.addEventListener('click', function() {
                                vscodeApi.postMessage({ type: 'restartAutomation', deploymentId: auto.deploymentId });
                            });
                            actions.appendChild(restartBtn);
                        } else if (bpData.worktree) {
                            var startBtn = mkEl('button', 'btn btn-primary', '');
                            startBtn.innerHTML = '<span class="codicon codicon-debug-start"></span> Start Live Dev';
                            startBtn.addEventListener('click', function() {
                                vscodeApi.postMessage({ type: 'startLiveDev', relativePath: auto.relativePath, worktree: bpData.worktree, name: auto.name });
                            });
                            actions.appendChild(startBtn);
                        }
                        card.appendChild(actions);

                        autoCards.appendChild(card);
                    });
                }

                // "+ New Automation" card
                if (bpData.worktree) {
                    var newAutoCard = mkEl('div', 'auto-card');
                    newAutoCard.style.cssText = 'border-style:dashed; text-align:center; display:flex; align-items:center; justify-content:center; min-height:80px;';
                    newAutoCard.innerHTML = '<div><div style="font-size:20px; margin-bottom:4px;">+</div><div class="auto-card-name">New Automation</div></div>';
                    newAutoCard.addEventListener('click', function() {
                        vscodeApi.postMessage({ type: 'createAutomation', worktree: bpData.worktree, bpPath: bpData.bpPath });
                    });
                    autoCards.appendChild(newAutoCard);
                }

                autoSection.appendChild(autoCards);
                content.appendChild(autoSection);
            }

            // README
            if (bpData.readme) {
                var readmeSection = mkEl('div', 'section');
                readmeSection.appendChild(mkEl('div', 'section-title', 'README'));
                var readmeDiv = mkEl('div', 'readme');
                readmeDiv.textContent = bpData.readme;
                readmeSection.appendChild(readmeDiv);
                content.appendChild(readmeSection);
            }

            // Agent Sessions
            if (bpData.worktree) {
                var sessSection = mkEl('div', 'section');
                var sessHeader = mkEl('div', '');
                sessHeader.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;';
                sessHeader.appendChild(mkEl('div', 'section-title', 'Agent Sessions'));

                // Recording toggle
                var toggleLabel = mkEl('label', '');
                toggleLabel.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; color:var(--vscode-descriptionForeground); cursor:pointer;';
                var toggleCb = document.createElement('input');
                toggleCb.type = 'checkbox';
                toggleCb.checked = !anonMode;
                toggleCb.addEventListener('change', function() {
                    vscodeApi.postMessage({ type: 'toggleAnon' });
                });
                toggleLabel.appendChild(toggleCb);
                toggleLabel.appendChild(document.createTextNode('Record sessions'));
                sessHeader.appendChild(toggleLabel);
                sessSection.appendChild(sessHeader);

                // Active sessions
                var activeDiv = mkEl('div', '');
                activeDiv.id = 'activeSessions';
                renderActiveSessions(activeDiv);
                sessSection.appendChild(activeDiv);

                // Playback area (hidden by default)
                var playbackArea = mkEl('div', '');
                playbackArea.id = 'playbackArea';
                playbackArea.style.cssText = 'display:none; margin-bottom:12px; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:#000;';
                sessSection.appendChild(playbackArea);

                if (bpData.sessions && bpData.sessions.length > 0) {
                    var sessTable = document.createElement('table');
                    sessTable.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';
                    sessTable.innerHTML = '<thead><tr style="text-align:left; color:var(--vscode-descriptionForeground);"><th style="padding:4px 8px;">Time</th><th style="padding:4px 8px;">User</th><th style="padding:4px 8px;">Recorded</th><th style="padding:4px 8px;"></th></tr></thead>';
                    var tbody = document.createElement('tbody');
                    bpData.sessions.forEach(function(s) {
                        var tr = document.createElement('tr');
                        tr.style.cssText = 'border-top:1px solid var(--border);';
                        var ts = s.timestamp ? new Date(s.timestamp).toLocaleString() : 'Unknown';
                        var recordedIcon = s.logged ? '\\u{1F534}' : '\\u{26AA}';
                        var playCell = '';
                        if (s.castFile) {
                            playCell = '<button class="btn btn-sm play-btn" data-cast="' + s.castFile + '">\\u25B6 Play</button>';
                        }
                        tr.innerHTML = '<td style="padding:4px 8px;">' + ts + '</td><td style="padding:4px 8px;">' + (s.userEmail || 'anonymous') + '</td><td style="padding:4px 8px; text-align:center;">' + recordedIcon + '</td><td style="padding:4px 8px;">' + playCell + '</td>';
                        tbody.appendChild(tr);
                    });
                    sessTable.appendChild(tbody);

                    // Wire up play buttons
                    sessTable.addEventListener('click', function(e) {
                        var btn = e.target;
                        if (btn && btn.classList && btn.classList.contains('play-btn')) {
                            var castFile = btn.getAttribute('data-cast');
                            if (castFile) {
                                vscodeApi.postMessage({ type: 'playSession', castFile: castFile });
                            }
                        }
                    });

                    sessSection.appendChild(sessTable);
                } else {
                    sessSection.appendChild(mkEl('div', 'placeholder', 'No sessions yet.'));
                }

                content.appendChild(sessSection);
            }

            // Requirements
            var reqSection = mkEl('div', 'section');
            reqSection.appendChild(mkEl('div', 'section-title', 'Requirements'));
            if (bpData.requirements.length === 0) {
                reqSection.appendChild(mkEl('div', 'placeholder', 'No requirements yet. Press N to add one.'));
            } else {
                var tree = buildTree(bpData.requirements);
                var list = mkEl('div', '');
                renderTree(tree, list);
                reqSection.appendChild(list);
            }
            var addRoot = mkEl('button', 'add-root-btn', '+ Add Requirement');
            addRoot.addEventListener('click', function() { showAddInput('', addRoot); });
            reqSection.appendChild(addRoot);
            content.appendChild(reqSection);
        }

        // ---- Requirements tree (same logic as before) ----

        function buildTree(reqs) {
            var map = {}; var roots = [];
            reqs.forEach(function(r) { map[r.id] = { req: r, children: [] }; });
            reqs.forEach(function(r) {
                if (r.parent && map[r.parent]) { map[r.parent].children.push(map[r.id]); }
                else { roots.push(map[r.id]); }
            });
            return roots;
        }

        function getSiblings(card) {
            var parentId = card.getAttribute('data-parent') || '';
            return Array.from(content.querySelectorAll('.req-card')).filter(function(c) {
                return (c.getAttribute('data-parent') || '') === parentId;
            });
        }
        function getChildren(card) {
            var id = card.getAttribute('data-req-id');
            return Array.from(content.querySelectorAll('.req-card')).filter(function(c) {
                return c.getAttribute('data-parent') === id;
            });
        }
        function getParentCard(card) {
            var parentId = card.getAttribute('data-parent');
            if (!parentId) return null;
            return content.querySelector('.req-card[data-req-id="' + parentId + '"]');
        }
        function focusCard(card) { if (card) { card.focus(); setMode('navigate'); } }

        function showAddInput(parentId, afterElement) {
            var existing = document.querySelector('.add-input-row');
            if (existing) existing.remove();
            setMode('adding');
            var row = mkEl('div', '');
            row.className = 'add-input-row';
            row.style.cssText = 'display:flex; gap:6px; margin:6px 0; align-items:flex-start;';
            var ta = document.createElement('textarea');
            ta.style.cssText = 'flex:1; padding:6px 8px; min-height:36px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-focusBorder); border-radius:4px; font-size:12px; font-family:inherit; resize:vertical;';
            ta.placeholder = parentId ? 'Child requirement...' : 'New requirement...';
            function submit() {
                var desc = ta.value.trim();
                if (desc) { vscodeApi.postMessage({ type: 'addRequirement', key: currentBpKey, requirement: { description: desc, status: 'pending', parent: parentId } }); }
                row.remove(); setMode('navigate');
            }
            ta.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
                else if (e.key === 'Escape') { row.remove(); setMode('navigate'); }
            });
            row.appendChild(ta);
            var insertTarget = afterElement;
            if (afterElement.classList && afterElement.classList.contains('req-card')) {
                var wrapper = afterElement.closest('.req-node');
                if (wrapper) insertTarget = wrapper;
            }
            insertTarget.insertAdjacentElement('afterend', row);
            ta.focus();
        }

        function startEdit(card, node) {
            setMode('editing');
            var desc = card.querySelector('.req-desc');
            var editTa = document.createElement('textarea');
            editTa.value = node.req.description || '';
            desc.textContent = '';
            desc.appendChild(editTa);
            editTa.focus();
            function commit() {
                if (editTa.value !== (node.req.description || '')) {
                    vscodeApi.postMessage({ type: 'updateRequirement', key: currentBpKey,
                        requirement: Object.assign({}, node.req, { description: editTa.value }) });
                } else { desc.textContent = node.req.description || ''; }
                setMode('navigate'); card.focus();
            }
            editTa.addEventListener('blur', commit);
            editTa.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editTa.blur(); }
                else if (e.key === 'Escape') { desc.textContent = node.req.description || ''; setMode('navigate'); card.focus(); }
            });
        }

        function renderTree(nodes, container) {
            nodes.forEach(function(node) {
                var wrapper = mkEl('div', 'req-node');
                var card = mkEl('div', 'req-card');
                card.setAttribute('tabindex', '0');
                card.setAttribute('data-req-id', node.req.id);
                card.setAttribute('data-parent', node.req.parent || '');
                card._node = node;
                var header = mkEl('div', 'req-card-header');
                header.appendChild(mkEl('span', 'req-id', node.req.id));
                var badge = mkEl('span', 'status-badge ' + (node.req.status || 'pending'), node.req.status || 'pending');
                badge.title = 'Click to cycle status';
                badge.addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'updateRequirement', key: currentBpKey,
                        requirement: Object.assign({}, node.req, { status: cycleStatus(node.req.status || 'pending') }) });
                });
                header.appendChild(badge);
                var actions = mkEl('div', 'req-actions');
                var delBtn = mkEl('button', 'btn-ghost btn-sm', 'Delete');
                delBtn.addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'deleteRequirement', key: currentBpKey, requirementId: node.req.id });
                });
                actions.appendChild(delBtn);
                header.appendChild(actions);
                card.appendChild(header);
                var desc = mkEl('div', 'req-desc');
                desc.textContent = node.req.description || '';
                desc.addEventListener('click', function() { startEdit(card, node); });
                card.appendChild(desc);
                var addChildBtn = mkEl('button', 'add-child-btn', '+');
                (function(id, btn) {
                    btn.addEventListener('click', function(e) { e.stopPropagation(); showAddInput(id, btn); });
                })(node.req.id, addChildBtn);
                card.appendChild(addChildBtn);
                wrapper.appendChild(card);
                if (node.children.length > 0) {
                    var childContainer = mkEl('div', 'req-children');
                    renderTree(node.children, childContainer);
                    wrapper.appendChild(childContainer);
                }
                container.appendChild(wrapper);
            });
        }

        // Keyboard navigation
        document.addEventListener('keydown', function(e) {
            if (mode !== 'navigate') return;
            var card = document.activeElement;
            var isCard = card && card.classList && card.classList.contains('req-card');
            if (!isCard && currentBpKey) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); var first = content.querySelector('.req-card'); if (first) focusCard(first); return; }
                if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); var all = content.querySelectorAll('.req-card'); if (all.length > 0) focusCard(all[all.length - 1]); return; }
                if (e.key === 'n' || e.key === 'N') { e.preventDefault(); var addRoot = content.querySelector('.add-root-btn'); if (addRoot) showAddInput('', addRoot); }
                return;
            }
            if (!isCard) return;
            var node = card._node;
            if (!node) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); var sibs = getSiblings(card); var idx = sibs.indexOf(card); if (idx < sibs.length - 1) focusCard(sibs[idx + 1]); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); var sibs = getSiblings(card); var idx = sibs.indexOf(card); if (idx > 0) focusCard(sibs[idx - 1]); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); var kids = getChildren(card); if (kids.length > 0) focusCard(kids[0]); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); var parent = getParentCard(card); if (parent) focusCard(parent); }
            else if (e.key === 'Enter') { e.preventDefault(); startEdit(card, node); }
            else if (e.key === ' ') { e.preventDefault(); vscodeApi.postMessage({ type: 'updateRequirement', key: currentBpKey, requirement: Object.assign({}, node.req, { status: cycleStatus(node.req.status || 'pending') }) }); }
            else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); showAddInput(node.req.parent || '', card); }
            else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); showAddInput(node.req.id, card.querySelector('.add-child-btn') || card); }
            else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); vscodeApi.postMessage({ type: 'deleteRequirement', key: currentBpKey, requirementId: node.req.id }); }
        });

        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg || !msg.type) return;
            switch (msg.type) {
                case 'structure':
                    structure = msg.workspaces || [];
                    renderTabs();
                    renderSubtabs();
                    renderContent();
                    break;
                case 'bpContent':
                    if (msg.key === currentBpKey) {
                        bpData = msg;
                        renderContent();
                    }
                    break;
                case 'activeSessions':
                    activeSessionsList = msg.sessions || [];
                    renderActiveSessions(null);
                    break;
                case 'anonMode':
                    anonMode = msg.enabled;
                    var cb = document.querySelector('input[type=checkbox]');
                    if (cb) { cb.checked = !anonMode; }
                    break;
                case 'castData':
                    var area = document.getElementById('playbackArea');
                    if (area && msg.data) {
                        area.style.display = 'block';
                        area.innerHTML = '<div style="display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--border); background:var(--vscode-sideBar-background);"><button class="btn btn-sm" id="closePlayer">Back</button><span style="font-size:11px; color:var(--vscode-descriptionForeground);">' + (msg.castFile || 'Playback') + '</span></div><div id="playerWrapper"></div>';
                        document.getElementById('closePlayer').addEventListener('click', function() {
                            area.style.display = 'none';
                            area.innerHTML = '';
                        });
                        try {
                            AsciinemaPlayer.create(
                                { data: msg.data },
                                document.getElementById('playerWrapper'),
                                { autoPlay: true, terminalFontSize: '13px' }
                            );
                        } catch (err) {
                            document.getElementById('playerWrapper').textContent = 'Player error: ' + String(err);
                        }
                    }
                    break;
            }
        });

        vscodeApi.postMessage({ type: 'ready' });
    </script>
    <script src="${this.playerJsUri}"></script>
</body>
</html>
        `;
    }
}
