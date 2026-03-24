import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const REQUIREMENTS_FILENAME = 'testable-requirements.toml';
const WORKSPACE_DIR = '/workspace/workspace';
const WORKTREES_DIR = '/workspace/workspace/worktrees';

interface Requirement {
    id: string;
    description: string;
    status: 'pass' | 'fail' | 'pending';
    notes: string; // kept for backwards compat in TOML, but merged into description for display
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
    const reqs: Requirement[] = [];
    let current: Partial<Requirement> | null = null;

    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (line === '[[requirement]]') {
            if (current && current.id) {
                reqs.push({
                    id: current.id,
                    description: current.description || '',
                    status: (current.status as any) || 'pending',
                    notes: current.notes || '',
                });
            }
            current = {};
            continue;
        }
        if (!current) { continue; }

        const match = line.match(/^(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"$/);
        if (match) {
            const key = match[1];
            const value = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            (current as any)[key] = value;
        }
    }
    if (current && current.id) {
        reqs.push({
            id: current.id,
            description: current.description || '',
            status: (current.status as any) || 'pending',
            notes: current.notes || '',
        });
    }
    return reqs;
}

function serializeRequirementsToml(reqs: Requirement[]): string {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return reqs.map(r => [
        '[[requirement]]',
        `id = "${esc(r.id)}"`,
        `description = "${esc(r.description)}"`,
        `status = "${esc(r.status)}"`,
        `notes = "${esc(r.notes)}"`,
    ].join('\n')).join('\n\n') + '\n';
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
        const groups: { group: string; label: string; key: string; dirPath: string }[] = [];
        this.bpMap.clear();

        // 1. Workspace (current branch)
        if (fs.existsSync(WORKSPACE_DIR)) {
            const branch = getCurrentBranch(WORKSPACE_DIR);
            const bps = this._findBPsUnder(WORKSPACE_DIR, 4);
            for (const dirPath of bps) {
                const rel = path.relative(WORKSPACE_DIR, dirPath);
                const key = `workspace:${rel}`;
                groups.push({ group: `Workspace (${branch})`, label: rel, key, dirPath });
                this.bpMap.set(key, dirPath);
            }
        }

        // 2. Each worktree
        if (fs.existsSync(WORKTREES_DIR)) {
            let wtEntries: fs.Dirent[];
            try { wtEntries = fs.readdirSync(WORKTREES_DIR, { withFileTypes: true }); } catch { wtEntries = []; }
            for (const wtEntry of wtEntries) {
                if (!wtEntry.isDirectory() || wtEntry.name.startsWith('.')) { continue; }
                const wtPath = path.join(WORKTREES_DIR, wtEntry.name);
                const bps = this._findBPsUnder(wtPath, 4);
                for (const dirPath of bps) {
                    const rel = path.relative(wtPath, dirPath);
                    const key = `worktree:${wtEntry.name}:${rel}`;
                    groups.push({ group: `Worktree: ${wtEntry.name}`, label: rel, key, dirPath });
                    this.bpMap.set(key, dirPath);
                }
            }
        }

        this.postMessage({ type: 'businessProcesses', groups });
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
        :root {
            color-scheme: light dark;
            font-family: var(--vscode-font-family, sans-serif);
            --status-pass: #3fb950;
            --status-fail: #f85149;
            --status-pending: #d29922;
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
        .controls {
            display: flex; align-items: center; gap: 12px;
            padding: 8px 16px;
            border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
            flex-shrink: 0; flex-wrap: wrap;
        }
        .controls label { font-size: 12px; color: var(--vscode-descriptionForeground); }
        .controls select {
            padding: 4px 8px; min-width: 280px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
            border-radius: 4px; font-size: 12px;
        }
        .content { flex: 1; overflow-y: auto; padding: 16px; }
        .add-form {
            display: flex; gap: 8px; margin-bottom: 16px; align-items: flex-end;
        }
        .add-form textarea {
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
            border-radius: 6px; font-size: 12px; font-family: inherit;
            flex: 1; min-height: 60px; resize: vertical;
        }
        .add-form button, .btn {
            padding: 6px 14px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 6px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer; font-size: 12px; white-space: nowrap;
        }
        .btn:hover { opacity: 0.9; }
        .req-card {
            border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
            border-radius: 8px; padding: 12px 16px; margin-bottom: 10px;
            background: var(--vscode-editor-background);
        }
        .req-card:hover {
            border-color: var(--vscode-focusBorder, rgba(128,128,128,0.5));
        }
        .req-card-header {
            display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
        }
        .req-id {
            font-weight: 600; font-size: 12px;
            color: var(--vscode-descriptionForeground);
            min-width: 60px;
        }
        .status-badge {
            display: inline-block; padding: 2px 10px; border-radius: 10px;
            font-size: 11px; font-weight: 600; text-transform: uppercase; cursor: pointer;
            user-select: none;
        }
        .status-badge.pass { background: var(--status-pass); color: #fff; }
        .status-badge.fail { background: var(--status-fail); color: #fff; }
        .status-badge.pending { background: var(--status-pending); color: #fff; }
        .req-description {
            font-size: 13px; line-height: 1.5; white-space: pre-wrap;
            cursor: text; padding: 4px 0; min-height: 20px;
        }
        .req-description:hover {
            background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08));
            border-radius: 4px;
        }
        .req-description textarea {
            width: 100%; min-height: 60px; padding: 6px 8px;
            background: var(--vscode-input-background); color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-focusBorder, rgba(128,128,128,0.4));
            border-radius: 6px; font-size: 13px; font-family: inherit;
            line-height: 1.5; resize: vertical;
        }
        .req-card-footer {
            display: flex; justify-content: flex-end; margin-top: 8px;
        }
        .delete-btn {
            padding: 2px 10px; border: none; border-radius: 4px;
            font-size: 11px; cursor: pointer;
            background: transparent; color: var(--vscode-descriptionForeground);
        }
        .delete-btn:hover { background: var(--status-fail); color: #fff; }
        .placeholder { padding: 48px 16px; text-align: center; color: var(--vscode-descriptionForeground); }
    </style>
</head>
<body>
    <div class="header"><h2>Testable Requirements</h2></div>
    <div class="controls">
        <label>Business Process:</label>
        <select id="bpSelect"><option value="">Select a business process...</option></select>
    </div>
    <div class="content">
        <div class="add-form" id="addForm" style="display:none;">
            <textarea id="newDescription" placeholder="Describe the requirement..." rows="2"></textarea>
            <button class="btn" id="addBtn">Add</button>
        </div>
        <div id="reqList"></div>
        <div class="placeholder" id="placeholder">Select a business process to view its testable requirements.</div>
    </div>
    <script>
        var vscodeApi = acquireVsCodeApi();
        var bpSelect = document.getElementById('bpSelect');
        var addForm = document.getElementById('addForm');
        var reqList = document.getElementById('reqList');
        var placeholder = document.getElementById('placeholder');
        var newDescription = document.getElementById('newDescription');
        var addBtn = document.getElementById('addBtn');

        var currentKey = '';
        var requirements = [];
        var editingId = null;

        function cycleStatus(s) {
            var order = ['pending', 'pass', 'fail'];
            return order[(order.indexOf(s) + 1) % order.length];
        }

        function renderRequirements() {
            reqList.innerHTML = '';
            if (!currentKey) {
                addForm.style.display = 'none';
                placeholder.style.display = 'block';
                return;
            }
            addForm.style.display = 'flex';
            placeholder.style.display = 'none';

            if (requirements.length === 0) {
                reqList.innerHTML = '<div class="placeholder" style="padding:24px;">No requirements yet. Add one above.</div>';
                return;
            }

            requirements.forEach(function(req) {
                var card = document.createElement('div');
                card.className = 'req-card';

                // Header: ID + status badge
                var header = document.createElement('div');
                header.className = 'req-card-header';
                var idSpan = document.createElement('span');
                idSpan.className = 'req-id';
                idSpan.textContent = req.id;
                header.appendChild(idSpan);

                var badge = document.createElement('span');
                badge.className = 'status-badge ' + (req.status || 'pending');
                badge.textContent = req.status || 'pending';
                badge.title = 'Click to cycle: pending > pass > fail';
                badge.addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'updateRequirement', key: currentKey,
                        requirement: Object.assign({}, req, { status: cycleStatus(req.status || 'pending') }) });
                });
                header.appendChild(badge);
                card.appendChild(header);

                // Description (click to edit)
                var desc = document.createElement('div');
                desc.className = 'req-description';
                desc.textContent = req.description || '';
                desc.addEventListener('click', function() {
                    if (editingId === req.id) return;
                    editingId = req.id;
                    var ta = document.createElement('textarea');
                    ta.value = req.description || '';
                    desc.textContent = '';
                    desc.appendChild(ta);
                    ta.focus();
                    function commit() {
                        editingId = null;
                        var val = ta.value;
                        if (val !== (req.description || '')) {
                            vscodeApi.postMessage({ type: 'updateRequirement', key: currentKey,
                                requirement: Object.assign({}, req, { description: val }) });
                        } else { desc.textContent = req.description || ''; }
                    }
                    ta.addEventListener('blur', commit);
                    ta.addEventListener('keydown', function(e) {
                        if (e.key === 'Escape') { editingId = null; desc.textContent = req.description || ''; }
                    });
                });
                card.appendChild(desc);

                // Footer: delete
                var footer = document.createElement('div');
                footer.className = 'req-card-footer';
                var delBtn = document.createElement('button');
                delBtn.className = 'delete-btn';
                delBtn.textContent = 'Delete';
                delBtn.addEventListener('click', function() {
                    vscodeApi.postMessage({ type: 'deleteRequirement', key: currentKey, requirementId: req.id });
                });
                footer.appendChild(delBtn);
                card.appendChild(footer);

                reqList.appendChild(card);
            });
        }

        bpSelect.addEventListener('change', function() {
            currentKey = bpSelect.value;
            requirements = [];
            if (currentKey) { vscodeApi.postMessage({ type: 'loadRequirements', key: currentKey }); }
            renderRequirements();
        });

        addBtn.addEventListener('click', function() {
            var desc = newDescription.value.trim();
            if (!desc) return;
            vscodeApi.postMessage({
                type: 'addRequirement', key: currentKey,
                requirement: { description: desc, status: 'pending', notes: '' },
            });
            newDescription.value = '';
        });

        newDescription.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                addBtn.click();
            }
        });

        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg || !msg.type) return;
            switch (msg.type) {
                case 'businessProcesses':
                    var currentVal = bpSelect.value;
                    bpSelect.innerHTML = '<option value="">Select a business process...</option>';
                    var groups = msg.groups || [];
                    var groupNames = [];
                    groups.forEach(function(item) {
                        if (groupNames.indexOf(item.group) === -1) groupNames.push(item.group);
                    });
                    groupNames.forEach(function(gName) {
                        var optgroup = document.createElement('optgroup');
                        optgroup.label = gName;
                        groups.filter(function(item) { return item.group === gName; }).forEach(function(item) {
                            var opt = document.createElement('option');
                            opt.value = item.key;
                            opt.textContent = item.label;
                            if (item.key === currentVal) opt.selected = true;
                            optgroup.appendChild(opt);
                        });
                        bpSelect.appendChild(optgroup);
                    });
                    break;
                case 'requirements':
                    if (msg.key === currentKey) {
                        requirements = msg.requirements || [];
                        renderRequirements();
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
