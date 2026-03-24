import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as toml from '@iarna/toml';

const REQUIREMENTS_FILENAME = 'testable-requirements.toml';
const WORKSPACE_DIR = '/workspace/workspace';
const WORKTREES_DIR = '/workspace/workspace/worktrees';

interface Requirement {
    id: string;
    description: string;
    status: 'pass' | 'fail' | 'pending';
    parent: string; // parent requirement ID, "" = root level
}

interface BPEntry {
    /** Display label, e.g. "MyProcess" or "worktree:feature-x/MyProcess" */
    label: string;
    /** Group name for the optgroup: "workspace" or worktree name */
    group: string;
    /** Absolute path to the business process directory */
    dirPath: string;
    /** Unique key sent to/from the webview */
    key: string;
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
    } catch {
        return [];
    }
}

function serializeRequirementsToml(reqs: Requirement[]): string {
    const data = {
        requirement: reqs.map(r => ({
            id: r.id,
            parent: r.parent,
            description: r.description,
            status: r.status,
        })),
    };
    return toml.stringify(data as any);
}

function getCurrentBranch(cwd: string): string {
    try {
        return cp.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).toString().trim();
    } catch {
        return 'current branch';
    }
}

export class RequirementsPanel {
    private static currentPanel: RequirementsPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private disposed = false;
    /** Map from key → absolute dir path for quick lookup */
    private bpMap = new Map<string, string>();

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;

        this.panel = vscode.window.createWebviewPanel(
            'bitswan-requirements-editor',
            'Testable Requirements',
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
            RequirementsPanel.currentPanel = undefined;
        });
    }

    public static createOrShow(context: vscode.ExtensionContext): void {
        if (RequirementsPanel.currentPanel && !RequirementsPanel.currentPanel.disposed) {
            RequirementsPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        RequirementsPanel.currentPanel = new RequirementsPanel(context);
    }

    private async onMessage(msg: any): Promise<void> {
        if (!msg || !msg.type) { return; }
        switch (msg.type) {
            case 'ready':
                await this.loadBusinessProcesses();
                break;
            case 'loadRequirements':
                await this.loadRequirements(msg.key);
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
        }
    }

    // ---- Discovery ----

    /** Recursively find directories containing process.toml under `root`, up to `maxDepth`. */
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

        // 1. Main workspace
        if (fs.existsSync(WORKSPACE_DIR)) {
            const bps = this._findBPsUnder(WORKSPACE_DIR, 4);
            const bpEntries: { key: string; label: string }[] = [];
            for (const dirPath of bps) {
                const rel = path.relative(WORKSPACE_DIR, dirPath);
                const key = `workspace:${rel}`;
                bpEntries.push({ key, label: rel });
                this.bpMap.set(key, dirPath);
            }
            workspaces.push({ name: 'Main', bps: bpEntries });
        }

        // 2. Each worktree
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
                if (bpEntries.length > 0) {
                    workspaces.push({ name: wtEntry.name, bps: bpEntries });
                }
            }
        }

        this.postMessage({ type: 'structure', workspaces });
    }

    // ---- File I/O ----

    private _resolveDir(key: string): string | null {
        return this.bpMap.get(key) || null;
    }

    private _readLocalReqs(dirPath: string): Requirement[] {
        const filePath = path.join(dirPath, REQUIREMENTS_FILENAME);
        if (!fs.existsSync(filePath)) { return []; }
        try { return parseRequirementsToml(fs.readFileSync(filePath, 'utf-8')); }
        catch { return []; }
    }

    private _writeLocalReqs(dirPath: string, reqs: Requirement[]): void {
        fs.writeFileSync(path.join(dirPath, REQUIREMENTS_FILENAME), serializeRequirementsToml(reqs), 'utf-8');
    }

    // ---- CRUD ----

    private async loadRequirements(key: string): Promise<void> {
        if (!key) {
            this.postMessage({ type: 'requirements', key: '', requirements: [] });
            return;
        }
        const dirPath = this._resolveDir(key);
        if (!dirPath) {
            this.postMessage({ type: 'requirements', key, requirements: [] });
            return;
        }
        this.postMessage({ type: 'requirements', key, requirements: this._readLocalReqs(dirPath) });
    }

    private async addRequirement(key: string, requirement: Omit<Requirement, 'id'>): Promise<void> {
        const dirPath = this._resolveDir(key);
        if (!dirPath) { return; }
        const existing = this._readLocalReqs(dirPath);
        const maxNum = existing.reduce((max, r) => {
            const m = r.id.match(/\d+$/);
            return m ? Math.max(max, parseInt(m[0], 10)) : max;
        }, 0);
        const newId = 'REQ-' + (maxNum + 1).toString().padStart(3, '0');
        existing.push({ id: newId, ...requirement } as Requirement);
        this._writeLocalReqs(dirPath, existing);
        vscode.window.showInformationMessage(`Requirement ${newId} added.`);
        await this.loadRequirements(key);
    }

    private async updateRequirement(key: string, requirement: Requirement): Promise<void> {
        const dirPath = this._resolveDir(key);
        if (!dirPath || !requirement?.id) { return; }
        const existing = this._readLocalReqs(dirPath);
        const idx = existing.findIndex(r => r.id === requirement.id);
        if (idx >= 0) {
            existing[idx] = requirement;
            this._writeLocalReqs(dirPath, existing);
        }
        await this.loadRequirements(key);
    }

    private async deleteRequirement(key: string, requirementId: string): Promise<void> {
        if (!key || !requirementId) { return; }
        const confirmation = await vscode.window.showWarningMessage(
            `Delete requirement "${requirementId}"?`, { modal: true }, 'Delete'
        );
        if (confirmation !== 'Delete') { return; }
        const dirPath = this._resolveDir(key);
        if (!dirPath) { return; }
        const filtered = this._readLocalReqs(dirPath).filter(r => r.id !== requirementId);
        this._writeLocalReqs(dirPath, filtered);
        vscode.window.showInformationMessage(`Requirement ${requirementId} deleted.`);
        await this.loadRequirements(key);
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
        :root { color-scheme: light dark; font-family: var(--vscode-font-family, sans-serif);
            --status-pass: #3fb950; --status-fail: #f85149; --status-pending: #d29922; --border: var(--vscode-editorWidget-border, rgba(128,128,128,0.3)); }
        * { box-sizing: border-box; }
        body { margin:0; padding:0; font-size:13px; color:var(--vscode-foreground); background:var(--vscode-editor-background); display:flex; flex-direction:column; height:100vh; overflow:hidden; }
        .header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border); flex-shrink:0; }
        .header h2 { margin:0; font-size:16px; }
        /* Tabs */
        .tab-bar { display:flex; border-bottom:2px solid var(--border); flex-shrink:0; padding:0 8px; }
        .tab { padding:8px 16px; cursor:pointer; font-size:12px; font-weight:500; border-bottom:2px solid transparent; margin-bottom:-2px; color:var(--vscode-descriptionForeground); }
        .tab:hover { color:var(--vscode-foreground); }
        .tab.active { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder, #007acc); }
        .subtab-bar { display:flex; border-bottom:1px solid var(--border); flex-shrink:0; padding:0 8px; background:var(--vscode-sideBar-background, rgba(128,128,128,0.05)); }
        .subtab { padding:6px 14px; cursor:pointer; font-size:11px; border-bottom:2px solid transparent; margin-bottom:-1px; color:var(--vscode-descriptionForeground); }
        .subtab:hover { color:var(--vscode-foreground); }
        .subtab.active { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder, #007acc); }
        /* Content */
        .content { flex:1; overflow-y:auto; padding:12px 16px; }
        .btn { padding:6px 14px; border:1px solid var(--vscode-button-border, transparent); border-radius:6px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); cursor:pointer; font-size:12px; white-space:nowrap; }
        .btn:hover { opacity:0.9; }
        .btn-sm { padding:2px 8px; font-size:11px; border-radius:4px; }
        .btn-ghost { background:transparent; color:var(--vscode-descriptionForeground); border:none; }
        .btn-ghost:hover { background:var(--status-fail); color:#fff; }
        /* Tree cards */
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
        .req-desc { font-size:12px; line-height:1.4; white-space:pre-wrap; cursor:text; padding:4px 0 2px; min-height:16px; }
        .req-desc:hover { background:var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); border-radius:4px; }
        .req-desc textarea { width:100%; min-height:40px; padding:4px 6px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-focusBorder); border-radius:4px; font-size:12px; font-family:inherit; resize:vertical; }
        .req-actions { display:flex; gap:6px; align-items:center; margin-left:auto; }
        .req-children { margin-left:20px; margin-top:4px; }
        .add-child-btn { display:block; margin:4px auto 0; padding:1px 12px; border:1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.4)); border-radius:4px; background:transparent; color:var(--vscode-descriptionForeground); cursor:pointer; font-size:11px; }
        .add-child-btn:hover { border-color:var(--vscode-focusBorder); color:var(--vscode-foreground); }
        .add-root-btn { display:block; margin:8px auto; padding:4px 16px; border:1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.4)); border-radius:6px; background:transparent; color:var(--vscode-descriptionForeground); cursor:pointer; font-size:12px; }
        .add-root-btn:hover { border-color:var(--vscode-focusBorder); color:var(--vscode-foreground); }
        .placeholder { padding:32px 16px; text-align:center; color:var(--vscode-descriptionForeground); }
        .keyhints { display:flex; flex-wrap:wrap; gap:12px; padding:6px 16px; border-top:1px solid var(--border); flex-shrink:0; font-size:11px; color:var(--vscode-descriptionForeground); }
        .keyhints kbd { padding:1px 5px; border:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.4)); border-radius:3px; font-size:10px; font-family:inherit; background:var(--vscode-sideBar-background, rgba(128,128,128,0.1)); }
        .mode-indicator { padding:4px 16px; border-top:1px solid var(--border); flex-shrink:0; font-size:11px; font-weight:600; color:var(--vscode-descriptionForeground); text-align:center; }
        .mode-indicator.editing { color:var(--vscode-focusBorder, #007acc); }
        .mode-indicator.adding { color:var(--status-pending); }
    </style>
</head>
<body>
    <div class="header"><h2>Testable Requirements</h2></div>
    <div class="tab-bar" id="tabBar"></div>
    <div class="subtab-bar" id="subtabBar"></div>
    <div class="content" id="content">
        <div class="placeholder" id="placeholder">Loading...</div>
    </div>
    <div class="keyhints" id="keyhints"></div>
    <div class="mode-indicator" id="modeIndicator"></div>
    <script>
        var vscodeApi = acquireVsCodeApi();
        var tabBar = document.getElementById('tabBar');
        var subtabBar = document.getElementById('subtabBar');
        var content = document.getElementById('content');
        var keyhints = document.getElementById('keyhints');
        var modeIndicator = document.getElementById('modeIndicator');

        var structure = [];
        var currentWsIdx = 0;
        var currentBpKey = '';
        var requirements = [];
        var mode = 'navigate'; // 'navigate' | 'editing' | 'adding'

        function cycleStatus(s) { var o=['pending','pass','fail']; return o[(o.indexOf(s)+1)%o.length]; }

        function setMode(m) {
            mode = m;
            modeIndicator.className = 'mode-indicator' + (m === 'editing' ? ' editing' : m === 'adding' ? ' adding' : '');
            if (m === 'navigate') {
                modeIndicator.textContent = 'NAVIGATE';
                keyhints.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> Siblings</span><span><kbd>→</kbd> First child</span><span><kbd>←</kbd> Parent</span><span><kbd>Enter</kbd> Edit</span><span><kbd>Space</kbd> Cycle status</span><span><kbd>N</kbd> New sibling</span><span><kbd>C</kbd> New child</span><span><kbd>Delete</kbd> Remove</span>';
            } else if (m === 'editing') {
                modeIndicator.textContent = 'EDITING';
                keyhints.innerHTML = '<span><kbd>Enter</kbd> Save</span><span><kbd>Shift+Enter</kbd> Newline</span><span><kbd>Esc</kbd> Cancel</span>';
            } else if (m === 'adding') {
                modeIndicator.textContent = 'ADDING';
                keyhints.innerHTML = '<span><kbd>Enter</kbd> Add</span><span><kbd>Shift+Enter</kbd> Newline</span><span><kbd>Esc</kbd> Cancel</span>';
            }
        }

        function buildTree(reqs) {
            var map = {}; var roots = [];
            reqs.forEach(function(r) { map[r.id] = { req: r, children: [] }; });
            reqs.forEach(function(r) {
                if (r.parent && map[r.parent]) { map[r.parent].children.push(map[r.id]); }
                else { roots.push(map[r.id]); }
            });
            return roots;
        }

        // Tree navigation helpers — cards store data-parent and data-req-id
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

        function renderTabs() {
            tabBar.innerHTML = '';
            structure.forEach(function(ws, idx) {
                var tab = document.createElement('div');
                tab.className = 'tab' + (idx === currentWsIdx ? ' active' : '');
                tab.textContent = ws.name;
                tab.addEventListener('click', function() { currentWsIdx = idx; currentBpKey = ''; renderSubtabs(); renderContent(); });
                tabBar.appendChild(tab);
            });
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
                    requirements = [];
                    vscodeApi.postMessage({ type: 'loadRequirements', key: bp.key });
                    renderSubtabs();
                    renderContent();
                });
                subtabBar.appendChild(tab);
            });
            if (!currentBpKey && ws.bps.length > 0) {
                currentBpKey = ws.bps[0].key;
                vscodeApi.postMessage({ type: 'loadRequirements', key: currentBpKey });
                renderSubtabs();
            }
        }

        function showAddInput(parentId, afterElement) {
            var existing = document.querySelector('.add-input-row');
            if (existing) existing.remove();
            setMode('adding');

            var row = document.createElement('div');
            row.className = 'add-input-row';
            row.style.cssText = 'display:flex; gap:6px; margin:6px 0; align-items:flex-start;';
            var ta = document.createElement('textarea');
            ta.style.cssText = 'flex:1; padding:6px 8px; min-height:36px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-focusBorder); border-radius:4px; font-size:12px; font-family:inherit; resize:vertical;';
            ta.placeholder = parentId ? 'Child requirement...' : 'New requirement...';
            function submit() {
                var desc = ta.value.trim();
                if (desc) {
                    vscodeApi.postMessage({ type: 'addRequirement', key: currentBpKey, requirement: { description: desc, status: 'pending', parent: parentId } });
                }
                row.remove();
                setMode('navigate');
            }
            ta.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
                else if (e.key === 'Escape') { row.remove(); setMode('navigate'); }
            });
            row.appendChild(ta);

            // For sibling insertion, place after the entire .req-node wrapper
            // (which includes children), not just after the card
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
                setMode('navigate');
                card.focus();
            }
            editTa.addEventListener('blur', commit);
            editTa.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editTa.blur(); }
                else if (e.key === 'Escape') { desc.textContent = node.req.description || ''; setMode('navigate'); card.focus(); }
            });
        }

        function renderContent() {
            content.innerHTML = '';
            setMode('navigate');
            if (!currentBpKey) {
                content.innerHTML = '<div class="placeholder">Select a business process tab above.</div>';
                return;
            }
            if (requirements.length === 0) {
                content.innerHTML = '<div class="placeholder">No requirements yet. Press <kbd>N</kbd> to add one.</div>';
            } else {
                var tree = buildTree(requirements);
                var list = document.createElement('div');
                renderTree(tree, list);
                content.appendChild(list);
            }
            var addRoot = mkEl('button', 'add-root-btn', '+ Add Requirement');
            addRoot.addEventListener('click', function() { showAddInput('', addRoot); });
            content.appendChild(addRoot);
        }

        function mkEl(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

        function renderTree(nodes, container) {
            nodes.forEach(function(node) {
                var wrapper = mkEl('div', 'req-node');
                var card = mkEl('div', 'req-card');
                card.setAttribute('tabindex', '0');
                card.setAttribute('data-req-id', node.req.id);
                card.setAttribute('data-parent', node.req.parent || '');
                card._node = node; // stash for keyboard handler

                // Header
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

                // Description
                var desc = mkEl('div', 'req-desc');
                desc.textContent = node.req.description || '';
                desc.addEventListener('click', function() { startEdit(card, node); });
                card.appendChild(desc);

                // + button
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

        // Global keyboard handler for card navigation
        document.addEventListener('keydown', function(e) {
            if (mode !== 'navigate') return;
            var card = document.activeElement;
            var isCard = card && card.classList && card.classList.contains('req-card');

            if (!isCard && currentBpKey) {
                // N with no card focused: add root
                if (e.key === 'n' || e.key === 'N') {
                    e.preventDefault();
                    var addRoot = content.querySelector('.add-root-btn');
                    if (addRoot) showAddInput('', addRoot);
                }
                return;
            }
            if (!isCard) return;

            var node = card._node;
            if (!node) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                var sibs = getSiblings(card);
                var idx = sibs.indexOf(card);
                if (idx < sibs.length - 1) focusCard(sibs[idx + 1]);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                var sibs = getSiblings(card);
                var idx = sibs.indexOf(card);
                if (idx > 0) focusCard(sibs[idx - 1]);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                var kids = getChildren(card);
                if (kids.length > 0) focusCard(kids[0]);
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                var parent = getParentCard(card);
                if (parent) focusCard(parent);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                startEdit(card, node);
            } else if (e.key === ' ') {
                e.preventDefault();
                vscodeApi.postMessage({ type: 'updateRequirement', key: currentBpKey,
                    requirement: Object.assign({}, node.req, { status: cycleStatus(node.req.status || 'pending') }) });
            } else if (e.key === 'n' || e.key === 'N') {
                e.preventDefault();
                showAddInput(node.req.parent || '', card);
            } else if (e.key === 'c' || e.key === 'C') {
                e.preventDefault();
                showAddInput(node.req.id, card.querySelector('.add-child-btn') || card);
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                vscodeApi.postMessage({ type: 'deleteRequirement', key: currentBpKey, requirementId: node.req.id });
            }
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
                case 'requirements':
                    if (msg.key === currentBpKey) {
                        requirements = msg.requirements || [];
                        renderContent();
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
