import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeName } from '../utils/nameUtils';
import { getDeployDetails } from '../deploy_details';
import { GitopsClient } from '../services/gitops_client';

type TemplateInfo = {
    id: string;
    name: string;
    shortDescription: string;
    iconSvg: string;
};

type TemplateGroupInfo = {
    id: string;
    name: string;
    shortDescription: string;
    iconSvg: string;
    automations: string[];
};

function worktreeFromBpRel(bpRel: string): string {
    if (!bpRel.startsWith('worktrees/')) { return ''; }
    const parts = bpRel.split('/');
    return parts[1] || '';
}

function bpInScopeFromBpRel(bpRel: string, worktree: string): string {
    if (!worktree) { return bpRel; }
    const prefix = `worktrees/${worktree}/`;
    return bpRel.startsWith(prefix) ? bpRel.slice(prefix.length) : bpRel;
}

function renderHtml(templates: TemplateInfo[], groups: TemplateGroupInfo[], businessProcessName?: string): string {
    const templateTiles = templates.map(t => `
        <div class="tile" data-id="${t.id}" data-type="template">
            <div class="icon">${t.iconSvg || ''}</div>
            <div class="name">${t.name}</div>
            <div class="desc">${t.shortDescription}</div>
        </div>
    `).join('');

    const groupTiles = groups.map(g => `
        <div class="tile" data-id="${g.id}" data-type="group">
            <div class="icon">${g.iconSvg || ''}</div>
            <div class="name">${g.name}</div>
            <div class="desc">${g.shortDescription}</div>
            <div class="badge">${g.automations.length} automations</div>
        </div>
    `).join('');

    const headerSuffix = businessProcessName ? ` — ${businessProcessName}` : '';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' vscode-resource:; img-src data:; script-src 'unsafe-inline';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Create Automation</title>
    <style>
        html, body { height: 100vh; margin: 0; padding: 0; overflow: hidden; }
        body { font-family: var(--vscode-font-family); padding: 16px; display: flex; flex-direction: column; box-sizing: border-box; }
        h1 { font-size: 16px; margin: 0 0 12px; }
        h2 { font-size: 14px; margin: 24px 0 12px; color: var(--vscode-descriptionForeground); }
        h2:first-of-type { margin-top: 0; }
        .content { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
        .tile { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; cursor: pointer; background: var(--vscode-editor-background); }
        .tile:hover { outline: 1px solid var(--vscode-focusBorder); }
        .icon { height: 48px; display: flex; align-items: center; justify-content: center; }
        .icon svg { width: 40px; height: 40px; }
        .name { margin-top: 8px; font-weight: 600; }
        .desc { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
        .badge { margin-top: 8px; font-size: 11px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); padding: 2px 6px; border-radius: 10px; display: inline-block; }
        .empty { color: var(--vscode-descriptionForeground); }
        .note { flex-shrink: 0; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4; text-align: center; opacity: 0.6; }
        .note code { background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 3px; font-size: 10px; }
        .note a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
        .note a:hover { text-decoration: underline; }
    </style>
    </head>
    <body>
        <div class="content">
            <h1>Create Automation${headerSuffix}</h1>
            ${groups.length ? `
                <h2>Automation Groups</h2>
                <div class="grid">${groupTiles}</div>
            ` : ''}
            ${templates.length ? `
                <h2>Templates</h2>
                <div class="grid">${templateTiles}</div>
            ` : ''}
            ${!templates.length && !groups.length ? `<p class="empty">No templates available from gitops.</p>` : ''}
        </div>
        <div class="note">You can add your own templates by placing them in the <a href="#" id="templates-link"><code>templates</code></a> directory.</div>
        <script>
            const vscodeApi = acquireVsCodeApi();
            document.querySelectorAll('.tile').forEach(el => {
                el.addEventListener('click', () => {
                    const id = el.getAttribute('data-id');
                    const type = el.getAttribute('data-type');
                    vscodeApi.postMessage({ type: type === 'group' ? 'groupSelected' : 'templateSelected', id });
                });
            });
            document.getElementById('templates-link').addEventListener('click', (e) => {
                e.preventDefault();
                vscodeApi.postMessage({ type: 'revealTemplatesDirectory' });
            });
        </script>
    </body>
</html>`;
}

export async function openAutomationTemplates(context: vscode.ExtensionContext, businessProcessName?: string) {
    const panel = vscode.window.createWebviewPanel(
        'bitswanAutomationTemplates',
        'Create Automation',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const details = await getDeployDetails(context);
    if (!details) {
        vscode.window.showErrorMessage('No GitOps instance configured.');
        panel.dispose();
        return;
    }

    const client = new GitopsClient(details.deployUrl, details.deploySecret);
    const listResult = await client.getTemplates();
    let templates: TemplateInfo[] = [];
    let groups: TemplateGroupInfo[] = [];
    if (listResult.ok && listResult.body && typeof listResult.body === 'object') {
        const body = listResult.body as { templates?: TemplateInfo[]; groups?: TemplateGroupInfo[] };
        templates = Array.isArray(body.templates) ? body.templates : [];
        groups = Array.isArray(body.groups) ? body.groups : [];
    } else {
        vscode.window.showWarningMessage(`Failed to fetch templates from gitops: HTTP ${listResult.status}`);
    }
    panel.webview.html = renderHtml(templates, groups, businessProcessName);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message?.type === 'revealTemplatesDirectory') {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('No workspace folder is open.');
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const templatesDir = path.join(workspaceRoot, 'templates');

            if (!fs.existsSync(templatesDir)) {
                try {
                    fs.mkdirSync(templatesDir, { recursive: true });
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to create templates directory: ${String(error)}`);
                    return;
                }
            }

            const templatesUri = vscode.Uri.file(templatesDir);
            await vscode.commands.executeCommand('revealInExplorer', templatesUri);
            return;
        }

        if (message?.type === 'groupSelected') {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('No workspace folder is open.');
                return;
            }

            const bpRel = businessProcessName || '';
            const worktree = worktreeFromBpRel(bpRel);
            const bp = bpInScopeFromBpRel(bpRel, worktree);
            const groupId: string = message.id;

            const result = await client.createAutomationFromTemplate({
                group_id: groupId,
                bp,
                ...(worktree ? { worktree } : {}),
            });

            if (!result.ok) {
                const detail = (result.body as any)?.detail || `HTTP ${result.status}`;
                vscode.window.showErrorMessage(`Failed to create automation group: ${detail}`);
                return;
            }

            const created = ((result.body as any)?.created || []) as Array<{ name: string; relative_path: string }>;
            const names = created.map(c => c.name).join(', ');
            vscode.window.showInformationMessage(`Created ${created.length} automations: ${names}`);
            panel.dispose();
            return;
        }

        if (message?.type !== 'templateSelected') { return; }

        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const bpRel = businessProcessName || '';
        const worktree = worktreeFromBpRel(bpRel);
        const bp = bpInScopeFromBpRel(bpRel, worktree);
        const templateId: string = message.id;

        const nameInput = await vscode.window.showInputBox({
            title: 'New Automation Name',
            prompt: 'Enter a name for your new automation',
            placeHolder: 'my-automation',
            validateInput: (value) => {
                const sanitized = sanitizeName(value || '');
                if (!value || !sanitized) { return 'Please enter a valid name (letters, numbers, dashes).'; }
                return undefined;
            }
        });
        if (!nameInput) { return; }

        const result = await client.createAutomationFromTemplate({
            template_id: templateId,
            name: nameInput,
            bp,
            ...(worktree ? { worktree } : {}),
        });

        if (!result.ok) {
            const detail = (result.body as any)?.detail || `HTTP ${result.status}`;
            vscode.window.showErrorMessage(`Failed to create automation: ${detail}`);
            return;
        }

        const created = ((result.body as any)?.created || []) as Array<{ name: string; relative_path: string }>;
        if (created.length === 0) {
            vscode.window.showInformationMessage('Automation created.');
            panel.dispose();
            return;
        }

        // Open the first .ipynb in the new automation directory, if any.
        const newRel = created[0].relative_path;
        const newDir = path.join(workspaceRoot, newRel);
        let notebookPath = path.join(newDir, 'main.ipynb');
        if (!fs.existsSync(notebookPath)) {
            try {
                const files = fs.readdirSync(newDir);
                const firstIpynb = files.find(f => f.toLowerCase().endsWith('.ipynb'));
                if (firstIpynb) { notebookPath = path.join(newDir, firstIpynb); }
            } catch { /* ignore — gitops watcher may not have updated the local FS view yet */ }
        }
        if (fs.existsSync(notebookPath)) {
            const uri = vscode.Uri.file(notebookPath);
            try {
                await vscode.commands.executeCommand('vscode.openWith', uri, 'jupyter-notebook');
            } catch {
                await vscode.window.showTextDocument(uri);
            }
        } else {
            vscode.window.showInformationMessage('Automation created, but no notebook found to open.');
        }

        panel.dispose();
    });
}
