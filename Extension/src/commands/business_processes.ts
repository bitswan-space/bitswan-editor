import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { UnifiedBusinessProcessesViewProvider } from '../views/unified_business_processes_view';

export async function refreshBusinessProcessesCommand(context: vscode.ExtensionContext, treeDataProvider: UnifiedBusinessProcessesViewProvider) {
    console.log('[DEBUG] refreshBusinessProcessesCommand function called');
    // For business processes, we just need to refresh the tree data provider
    // since business processes are determined by the file system structure
    treeDataProvider.refresh();
    console.log('[DEBUG] refreshBusinessProcessesCommand completed');
}

export async function openDevelopmentGuideCommand(context: vscode.ExtensionContext) {
    try {
        // Get the extension path
        const extensionPath = context.extensionPath;
        const guidePath = path.join(extensionPath, 'DEVELOPMENT_GUIDE.md');

        // Check if file exists
        if (!fs.existsSync(guidePath)) {
            vscode.window.showErrorMessage(`Development Guide not found at: ${guidePath}`);
            return;
        }

        // Create URI for the file
        const uri = vscode.Uri.file(guidePath);

        // Open the file as a rendered markdown preview (read-only)
        await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to open Development Guide: ${error}`);
    }
}

export async function createBusinessProcessCommand(
    context: vscode.ExtensionContext,
    treeDataProvider: UnifiedBusinessProcessesViewProvider
) {
    // Get workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }

    // Prompt for business process name
    const name = await vscode.window.showInputBox({
        prompt: 'Enter the name for the new business process',
        placeHolder: 'my-business-process',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Name cannot be empty';
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                return 'Name can only contain letters, numbers, hyphens, and underscores';
            }
            return null;
        }
    });

    if (!name) {
        return; // User cancelled
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const businessProcessPath = path.join(workspacePath, name);

    // Check if directory already exists
    if (fs.existsSync(businessProcessPath)) {
        vscode.window.showErrorMessage(`Directory "${name}" already exists`);
        return;
    }

    try {
        // Create the directory
        fs.mkdirSync(businessProcessPath, { recursive: true });

        // Create process.toml with a new UUID
        const processId = randomUUID();
        const processTomlContent = `process-id = "${processId}"\n`;
        fs.writeFileSync(path.join(businessProcessPath, 'process.toml'), processTomlContent);

        // Create README.md
        const readmeContent = `# ${name}\n\nDescribe your business process here.\n`;
        const readmePath = path.join(businessProcessPath, 'README.md');
        fs.writeFileSync(readmePath, readmeContent);

        // Refresh the tree view
        treeDataProvider.refresh();

        // Open the README.md file
        const readmeUri = vscode.Uri.file(readmePath);
        await vscode.window.showTextDocument(readmeUri);

        vscode.window.showInformationMessage(`Business process "${name}" created successfully`);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create business process: ${error}`);
    }
}
