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
            console.log(`[Templates] No 'name' field found in ${filePath}`);
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
    } catch (error) {
        console.error(`[Templates] Error reading template.toml from ${filePath}:`, error);
        return null;
    }
}

function discoverTemplates(rootDir: string): TemplateInfo[] {
    const results: TemplateInfo[] = [];
    try {
        if (!fs.existsSync(rootDir)) {
            console.log(`[Templates] Directory does not exist: ${rootDir}`);
            return results;
        }
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        console.log(`[Templates] Scanning directory ${rootDir}, found ${entries.length} entries`);
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                console.log(`[Templates] Skipping non-directory: ${entry.name}`);
                continue;
            }
            const dirPath = path.join(rootDir, entry.name);
            const templateToml = path.join(dirPath, 'template.toml');
            console.log(`[Templates] Checking ${dirPath} for template.toml`);
            if (fs.existsSync(templateToml)) {
                console.log(`[Templates] Found template.toml in ${dirPath}`);
                const info = readTemplateToml(templateToml);
                if (info) {
                    console.log(`[Templates] Successfully parsed template: ${info.id} - ${info.name}`);
                    results.push(info);
                } else {
                    console.log(`[Templates] Failed to parse template.toml in ${dirPath}`);
                }
            } else {
                console.log(`[Templates] No template.toml found in ${dirPath}`);
            }
        }
    } catch (error) {
        console.error(`[Templates] Error discovering templates in ${rootDir}:`, error);
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
        html, body { height: 100vh; margin: 0; padding: 0; overflow: hidden; }
        body { font-family: var(--vscode-font-family); padding: 16px; display: flex; flex-direction: column; box-sizing: border-box; }
        h1 { font-size: 16px; margin: 0 0 12px; }
        .content { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
        .tile { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; cursor: pointer; background: var(--vscode-editor-background); }
        .tile:hover { outline: 1px solid var(--vscode-focusBorder); }
        .icon { height: 48px; display: flex; align-items: center; justify-content: center; }
        .icon svg { width: 40px; height: 40px; }
        .name { margin-top: 8px; font-weight: 600; }
        .desc { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
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
            ${templates.length ? `<div class="grid">${tiles}</div>` : `<p class="empty">No templates found in ${TEMPLATES_ROOT}.</p>`}
        </div>
        <div class="note">You can add your own templates by placing them in the <a href="#" id="templates-link"><code>templates</code></a> directory.</div>
        <script>
            const vscodeApi = acquireVsCodeApi();
            document.querySelectorAll('.tile').forEach(el => {
                el.addEventListener('click', () => {
                    const id = el.getAttribute('data-id');
                    vscodeApi.postMessage({ type: 'templateSelected', id });
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

export function openAutomationTemplates(context: vscode.ExtensionContext, businessProcessName?: string) {
    const panel = vscode.window.createWebviewPanel(
        'bitswanAutomationTemplates',
        'Create Automation',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    // Discover templates from both the default templates root and workspace templates directory
    // Use a Map to deduplicate by ID, with workspace templates taking precedence
    const templatesMap = new Map<string, TemplateInfo>();
    
    // First, add templates from the default location
    const defaultTemplates = discoverTemplates(TEMPLATES_ROOT);
    console.log(`[Templates] Found ${defaultTemplates.length} templates in ${TEMPLATES_ROOT}`);
    for (const template of defaultTemplates) {
        templatesMap.set(template.id, template);
    }
    
    // Then, add templates from workspace templates directory (these will override defaults with same ID)
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const workspaceTemplatesDir = path.join(workspaceRoot, 'templates');
        console.log(`[Templates] Checking workspace templates directory: ${workspaceTemplatesDir}`);
        console.log(`[Templates] Directory exists: ${fs.existsSync(workspaceTemplatesDir)}`);
        if (fs.existsSync(workspaceTemplatesDir)) {
            const workspaceTemplates = discoverTemplates(workspaceTemplatesDir);
            console.log(`[Templates] Found ${workspaceTemplates.length} templates in workspace templates directory`);
            for (const template of workspaceTemplates) {
                console.log(`[Templates] Adding workspace template: ${template.id} - ${template.name}`);
                templatesMap.set(template.id, template);
            }
        }
    } else {
        console.log(`[Templates] No workspace folders found`);
    }
    
    const templates = Array.from(templatesMap.values());
    console.log(`[Templates] Total templates after merge: ${templates.length}`);
    panel.webview.html = renderHtml(templates, businessProcessName);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message?.type === 'revealTemplatesDirectory') {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('No workspace folder is open.');
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const templatesDir = path.join(workspaceRoot, 'templates');

            // Create directory if it doesn't exist
            if (!fs.existsSync(templatesDir)) {
                try {
                    fs.mkdirSync(templatesDir, { recursive: true });
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to create templates directory: ${String(error)}`);
                    return;
                }
            }

            // Reveal the templates directory in the file explorer
            const templatesUri = vscode.Uri.file(templatesDir);
            await vscode.commands.executeCommand('revealInExplorer', templatesUri);
            return;
        }

        if (message?.type !== 'templateSelected') return;

        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const bpRel = businessProcessName || '';
        const businessProcessPath = path.join(workspaceRoot, bpRel);

        const templateId: string = message.id;
        
        // Check if template exists in workspace templates directory first, otherwise use default location
        let templateDir: string;
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const workspaceTemplateDir = path.join(workspaceRoot, 'templates', templateId);
            if (fs.existsSync(workspaceTemplateDir) && fs.existsSync(path.join(workspaceTemplateDir, 'template.toml'))) {
                templateDir = workspaceTemplateDir;
            } else {
                templateDir = path.join(TEMPLATES_ROOT, templateId);
            }
        } else {
            templateDir = path.join(TEMPLATES_ROOT, templateId);
        }

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


