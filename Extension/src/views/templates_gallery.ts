import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeName } from '../utils/nameUtils';

type TemplateInfo = {
    id: string;
    name: string;
    shortDescription: string;
    iconSvg: string;
};

const TEMPLATES_ROOT = '/home/coder/workspace/examples';

function readTemplateToml(filePath: string): TemplateInfo | null {
    try {
        const content = fs.readFileSync(filePath, 'utf8');

        const nameMatch = content.match(/\bname\s*=\s*"([^"]+)"/);
        const shortDescMatch = content.match(/\bshort_description\s*=\s*"""([\s\S]*?)"""/);
        const iconMatch = content.match(/\bicon\s*=\s*"""([\s\S]*?)"""/);

        if (!nameMatch) {
            return null;
        }

        const name = nameMatch[1].trim();
        const shortDescription = (shortDescMatch?.[1] || '').trim();
        const iconSvg = (iconMatch?.[1] || '').trim();

        return {
            id: path.basename(path.dirname(filePath)),
            name,
            shortDescription,
            iconSvg,
        };
    } catch {
        return null;
    }
}

function discoverTemplates(rootDir: string): TemplateInfo[] {
    const results: TemplateInfo[] = [];
    try {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dirPath = path.join(rootDir, entry.name);
            const templateToml = path.join(dirPath, 'template.toml');
            if (fs.existsSync(templateToml)) {
                const info = readTemplateToml(templateToml);
                if (info) results.push(info);
            }
        }
    } catch {
        // ignore
    }
    return results;
}

function renderHtml(templates: TemplateInfo[], businessProcessName?: string): string {
    const tiles = templates.map(t => `
        <div class="tile" data-id="${t.id}">
            <div class="icon">${t.iconSvg || ''}</div>
            <div class="name">${t.name}</div>
            <div class="desc">${t.shortDescription}</div>
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
        body { font-family: var(--vscode-font-family); margin: 0; padding: 16px; }
        h1 { font-size: 16px; margin: 0 0 12px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
        .tile { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; cursor: pointer; background: var(--vscode-editor-background); }
        .tile:hover { outline: 1px solid var(--vscode-focusBorder); }
        .icon { height: 48px; display: flex; align-items: center; justify-content: center; }
        .icon svg { width: 40px; height: 40px; }
        .name { margin-top: 8px; font-weight: 600; }
        .desc { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
        .empty { color: var(--vscode-descriptionForeground); }
    </style>
    </head>
    <body>
        <h1>Create Automation${headerSuffix}</h1>
        ${templates.length ? `<div class="grid">${tiles}</div>` : `<p class="empty">No templates found in ${TEMPLATES_ROOT}.</p>`}
        <script>
            const vscodeApi = acquireVsCodeApi();
            document.querySelectorAll('.tile').forEach(el => {
                el.addEventListener('click', () => {
                    const id = el.getAttribute('data-id');
                    vscodeApi.postMessage({ type: 'templateSelected', id });
                });
            });
        </script>
    </body>
</html>`;
}

export function openAutomationTemplates(context: vscode.ExtensionContext, businessProcessName?: string) {
    const panel = vscode.window.createWebviewPanel(
        'bitswanAutomationTemplates',
        'Create Automation',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const templates = discoverTemplates(TEMPLATES_ROOT);
    panel.webview.html = renderHtml(templates, businessProcessName);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message?.type !== 'templateSelected') return;

        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const bpRel = businessProcessName || '';
        const businessProcessPath = path.join(workspaceRoot, bpRel);

        const templateId: string = message.id;
        const templateDir = path.join(TEMPLATES_ROOT, templateId);

        // Prompt for name
        const nameInput = await vscode.window.showInputBox({
            title: 'New Automation Name',
            prompt: 'Enter a name for your new automation',
            placeHolder: 'my-automation',
            validateInput: (value) => {
                const sanitized = sanitizeName(value || '');
                if (!value || !sanitized) return 'Please enter a valid name (letters, numbers, dashes).';
                return undefined;
            }
        });
        if (!nameInput) return; // cancelled

        const folderName = sanitizeName(nameInput);
        const targetDir = path.join(businessProcessPath, folderName);

        try {
            if (fs.existsSync(targetDir)) {
                vscode.window.showErrorMessage(`A folder named "${folderName}" already exists in this Business Process.`);
                return;
            }

            // Recursively copy template excluding template.toml
            copyDirectory(templateDir, targetDir, (p) => path.basename(p) !== 'template.toml');

            // Refresh sidebar
            await vscode.commands.executeCommand('bitswan.refreshBusinessProcesses');

            // Open main.ipynb (or first .ipynb) in editor
            let notebookPath = path.join(targetDir, 'main.ipynb');
            if (!fs.existsSync(notebookPath)) {
                try {
                    const files = fs.readdirSync(targetDir);
                    const firstIpynb = files.find(f => f.toLowerCase().endsWith('.ipynb'));
                    if (firstIpynb) notebookPath = path.join(targetDir, firstIpynb);
                } catch {}
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
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to create automation: ${String(err)}`);
        }
    });
}

function copyDirectory(src: string, dest: string, includePredicate: (fullPath: string) => boolean) {
    const stat = fs.statSync(src);
    if (!stat.isDirectory()) throw new Error('Template source is not a directory');

    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (!includePredicate(srcPath)) continue;
        if (entry.isDirectory()) {
            copyDirectory(srcPath, destPath, includePredicate);
        } else if (entry.isFile()) {
            const data = fs.readFileSync(srcPath);
            fs.writeFileSync(destPath, data);
        }
    }
}


