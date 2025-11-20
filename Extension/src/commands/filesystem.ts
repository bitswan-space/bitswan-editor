import * as vscode from 'vscode';
import * as path from 'path';
import { AutomationSourceItem, AutomationSourceFileItem, StageItem } from '../views/unified_business_processes_view';
import { TextEncoder } from 'util';

type FsNode = AutomationSourceItem | AutomationSourceFileItem | StageItem;

const textEncoder = new TextEncoder();

export async function createAutomationFileCommand(_context: vscode.ExtensionContext, item: FsNode) {
    const targetDir = getDirectoryUri(item);
    if (!targetDir) {
        vscode.window.showErrorMessage('Unable to determine target folder for the new file.');
        return;
    }

    const fileName = await vscode.window.showInputBox({
        prompt: 'Enter new file name',
        placeHolder: 'example.py'
    });
    if (!fileName) {
        return;
    }

    const filePath = path.join(targetDir.fsPath, fileName);
    const fileUri = vscode.Uri.file(filePath);

    try {
        await ensureParentDirectory(fileUri);
        await vscode.workspace.fs.writeFile(fileUri, textEncoder.encode(''));
        await refreshBusinessProcessesTree();
        const document = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(document);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create file: ${error?.message ?? error}`);
    }
}

export async function createAutomationFolderCommand(_context: vscode.ExtensionContext, item: FsNode) {
    const targetDir = getDirectoryUri(item);
    if (!targetDir) {
        vscode.window.showErrorMessage('Unable to determine target folder for the new directory.');
        return;
    }

    const folderName = await vscode.window.showInputBox({
        prompt: 'Enter new folder name',
        placeHolder: 'new-folder'
    });
    if (!folderName) {
        return;
    }

    const folderUri = vscode.Uri.file(path.join(targetDir.fsPath, folderName));

    try {
        await vscode.workspace.fs.createDirectory(folderUri);
        await refreshBusinessProcessesTree();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create folder: ${error?.message ?? error}`);
    }
}

export async function renameAutomationResourceCommand(_context: vscode.ExtensionContext, item: FsNode) {
    const target = getResourceUri(item);
    if (!target) {
        vscode.window.showErrorMessage('Unable to determine the resource to rename.');
        return;
    }

    const currentName = path.basename(target.fsPath);
    const newName = await vscode.window.showInputBox({
        prompt: 'Enter new name',
        value: currentName
    });
    if (!newName || newName === currentName) {
        return;
    }

    const parentDir = path.dirname(target.fsPath);
    const destination = vscode.Uri.file(path.join(parentDir, newName));

    try {
        await vscode.workspace.fs.rename(target, destination, { overwrite: false });
        await refreshBusinessProcessesTree();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to rename resource: ${error?.message ?? error}`);
    }
}

export async function deleteAutomationResourceCommand(_context: vscode.ExtensionContext, item: FsNode) {
    const target = getResourceUri(item);
    if (!target) {
        vscode.window.showErrorMessage('Unable to determine the resource to delete.');
        return;
    }

    const name = path.basename(target.fsPath) || target.fsPath;
    const confirmation = await vscode.window.showWarningMessage(
        `Delete "${name}"? This action cannot be undone.`,
        { modal: true },
        'Delete'
    );

    if (confirmation !== 'Delete') {
        return;
    }

    try {
        await vscode.workspace.fs.delete(target, { recursive: true, useTrash: true });
        await refreshBusinessProcessesTree();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to delete resource: ${error?.message ?? error}`);
    }
}

export async function revealAutomationResourceCommand(_context: vscode.ExtensionContext, item: FsNode) {
    const target = getResourceUri(item);
    if (!target) {
        vscode.window.showErrorMessage('Unable to locate the selected resource.');
        return;
    }

    try {
        await vscode.commands.executeCommand('revealInExplorer', target);
    } catch {
        await vscode.commands.executeCommand('revealFileInOS', target);
    }
}

export async function openAutomationTerminalCommand(_context: vscode.ExtensionContext, item: FsNode) {
    const targetDir = getDirectoryUri(item) ?? getResourceUri(item);
    if (!targetDir) {
        vscode.window.showErrorMessage('Unable to open terminal for the selected resource.');
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: `BitSwan: ${path.basename(targetDir.fsPath) || 'automation'}`,
        cwd: targetDir.fsPath
    });
    terminal.show();
}

function getDirectoryUri(item: FsNode): vscode.Uri | undefined {
    if (item instanceof AutomationSourceFileItem) {
        if (item.isDirectory) {
            return item.resourceUri;
        }
        const parentPath = path.dirname(item.resourceUri.fsPath);
        return vscode.Uri.file(parentPath);
    }

    if (item instanceof AutomationSourceItem) {
        return item.resourceUri;
    }

    if (item instanceof StageItem) {
        return item.sourceUri;
    }

    return undefined;
}

function getResourceUri(item: FsNode): vscode.Uri | undefined {
    if (item instanceof AutomationSourceFileItem || item instanceof AutomationSourceItem) {
        return item.resourceUri;
    }

    if (item instanceof StageItem) {
        return item.sourceUri;
    }

    return undefined;
}

async function ensureParentDirectory(resource: vscode.Uri) {
    const parentDir = vscode.Uri.file(path.dirname(resource.fsPath));
    await vscode.workspace.fs.createDirectory(parentDir);
}

async function refreshBusinessProcessesTree() {
    await vscode.commands.executeCommand('bitswan.refreshBusinessProcesses');
}

