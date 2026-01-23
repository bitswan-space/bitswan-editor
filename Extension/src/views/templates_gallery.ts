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

type TemplateGroupInfo = {
    id: string;
    name: string;
    shortDescription: string;
    iconSvg: string;
    automations: string[]; // subdirectory names
};

const TEMPLATES_ROOT = '/workspace/examples';

function readGroupToml(filePath: string): TemplateGroupInfo | null {
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

        // Find automation subdirectories (those with automation.toml or pipelines.conf)
        const groupDir = path.dirname(filePath);
        const automations: string[] = [];
        try {
            const entries = fs.readdirSync(groupDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const subDir = path.join(groupDir, entry.name);
                if (fs.existsSync(path.join(subDir, 'automation.toml')) ||
                    fs.existsSync(path.join(subDir, 'pipelines.conf'))) {
                    automations.push(entry.name);
                }
            }
        } catch (e) {
            console.error(`[Templates] Error reading group subdirectories: ${e}`);
        }

        if (automations.length === 0) {
            console.log(`[Templates] No automations found in group ${groupDir}`);
            return null;
        }

        return {
            id: path.basename(groupDir),
            name,
            shortDescription,
            iconSvg,
            automations,
        };
    } catch (error) {
        console.error(`[Templates] Error reading group.toml from ${filePath}:`, error);
        return null;
    }
}

function discoverTemplateGroups(rootDir: string): TemplateGroupInfo[] {
    const results: TemplateGroupInfo[] = [];
    try {
        if (!fs.existsSync(rootDir)) {
            return results;
        }
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dirPath = path.join(rootDir, entry.name);
            const groupToml = path.join(dirPath, 'group.toml');
            if (fs.existsSync(groupToml)) {
                console.log(`[Templates] Found group.toml in ${dirPath}`);
                const info = readGroupToml(groupToml);
                if (info) {
                    console.log(`[Templates] Successfully parsed group: ${info.id} - ${info.name} with ${info.automations.length} automations`);
                    results.push(info);
                }
            }
        }
    } catch (error) {
        console.error(`[Templates] Error discovering template groups in ${rootDir}:`, error);
    }
    return results;
}

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
            ${!templates.length && !groups.length ? `<p class="empty">No templates found in ${TEMPLATES_ROOT}.</p>` : ''}
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

export function openAutomationTemplates(context: vscode.ExtensionContext, businessProcessName?: string) {
    const panel = vscode.window.createWebviewPanel(
        'bitswanAutomationTemplates',
        'Create Automation',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    // Discover templates and groups from both the default templates root and workspace templates directory
    // Use Maps to deduplicate by ID, with workspace templates/groups taking precedence
    const templatesMap = new Map<string, TemplateInfo>();
    const groupsMap = new Map<string, TemplateGroupInfo>();

    // First, add templates and groups from the default location
    const defaultTemplates = discoverTemplates(TEMPLATES_ROOT);
    const defaultGroups = discoverTemplateGroups(TEMPLATES_ROOT);
    console.log(`[Templates] Found ${defaultTemplates.length} templates and ${defaultGroups.length} groups in ${TEMPLATES_ROOT}`);
    for (const template of defaultTemplates) {
        templatesMap.set(template.id, template);
    }
    for (const group of defaultGroups) {
        groupsMap.set(group.id, group);
    }

    // Then, add templates and groups from workspace templates directory (these will override defaults with same ID)
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const workspaceTemplatesDir = path.join(workspaceRoot, 'templates');
        console.log(`[Templates] Checking workspace templates directory: ${workspaceTemplatesDir}`);
        console.log(`[Templates] Directory exists: ${fs.existsSync(workspaceTemplatesDir)}`);
        if (fs.existsSync(workspaceTemplatesDir)) {
            const workspaceTemplates = discoverTemplates(workspaceTemplatesDir);
            const workspaceGroups = discoverTemplateGroups(workspaceTemplatesDir);
            console.log(`[Templates] Found ${workspaceTemplates.length} templates and ${workspaceGroups.length} groups in workspace templates directory`);
            for (const template of workspaceTemplates) {
                console.log(`[Templates] Adding workspace template: ${template.id} - ${template.name}`);
                templatesMap.set(template.id, template);
            }
            for (const group of workspaceGroups) {
                console.log(`[Templates] Adding workspace group: ${group.id} - ${group.name}`);
                groupsMap.set(group.id, group);
            }
        }
    } else {
        console.log(`[Templates] No workspace folders found`);
    }

    const templates = Array.from(templatesMap.values());
    const groups = Array.from(groupsMap.values());
    console.log(`[Templates] Total templates after merge: ${templates.length}, groups: ${groups.length}`);
    panel.webview.html = renderHtml(templates, groups, businessProcessName);

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

        if (message?.type === 'groupSelected') {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('No workspace folder is open.');
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const bpRel = businessProcessName || '';
            const businessProcessPath = path.join(workspaceRoot, bpRel);

            const groupId: string = message.id;
            const group = groupsMap.get(groupId);
            if (!group) {
                vscode.window.showErrorMessage(`Group not found: ${groupId}`);
                return;
            }

            // Find group directory
            let groupDir: string;
            const workspaceGroupDir = path.join(workspaceRoot, 'templates', groupId);
            if (fs.existsSync(workspaceGroupDir) && fs.existsSync(path.join(workspaceGroupDir, 'group.toml'))) {
                groupDir = workspaceGroupDir;
            } else {
                groupDir = path.join(TEMPLATES_ROOT, groupId);
            }

            // Prompt for group name prefix
            const nameInput = await vscode.window.showInputBox({
                title: 'New Automation Group Name',
                prompt: `Enter a prefix for your automations (will create: ${group.automations.map(a => `{prefix}-${a}`).join(', ')})`,
                placeHolder: 'my-app',
                validateInput: (value) => {
                    const sanitized = sanitizeName(value || '');
                    if (!value || !sanitized) return 'Please enter a valid name (letters, numbers, dashes).';
                    return undefined;
                }
            });
            if (!nameInput) return; // cancelled

            const prefix = sanitizeName(nameInput);

            // Check that none of the target directories already exist
            const targetDirs: { name: string; src: string; dest: string }[] = [];
            for (const automationName of group.automations) {
                const folderName = `${prefix}-${automationName}`;
                const destDir = path.join(businessProcessPath, folderName);
                if (fs.existsSync(destDir)) {
                    vscode.window.showErrorMessage(`A folder named "${folderName}" already exists in this Business Process.`);
                    return;
                }
                targetDirs.push({
                    name: folderName,
                    src: path.join(groupDir, automationName),
                    dest: destDir
                });
            }

            try {
                // Copy each automation in the group
                for (const { src, dest } of targetDirs) {
                    copyDirectory(src, dest, () => true);
                }

                // Refresh sidebar
                await vscode.commands.executeCommand('bitswan.refreshBusinessProcesses');

                vscode.window.showInformationMessage(`Created ${targetDirs.length} automations: ${targetDirs.map(t => t.name).join(', ')}`);
                panel.dispose();
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to create automation group: ${String(err)}`);
            }
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


