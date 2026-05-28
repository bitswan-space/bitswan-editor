import * as vscode from 'vscode';
import { GitOpsItem, WorkspacesViewProvider } from '../views/workspaces_view';
import { UnifiedImagesViewProvider, OrphanedImagesViewProvider } from '../views/unified_images_view';
import { setSseClient } from '../extension';
import { GitOpsSSEClient } from '../services/sse_client';

export async function addGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: WorkspacesViewProvider) {
    const name = await vscode.window.showInputBox({
        prompt: 'Enter GitOps instance name',
        placeHolder: 'e.g., Production GitOps',
        ignoreFocusOut: true
    });
    if (!name) return;

    const url = await vscode.window.showInputBox({
        prompt: 'Enter GitOps URL',
        placeHolder: 'https://gitops.example.com',
        ignoreFocusOut: true
    });
    if (!url) return;

    const secret = await vscode.window.showInputBox({
        prompt: 'Enter GitOps secret token',
        password: true,
        ignoreFocusOut: true
    });
    if (!secret) return;

    const instances = context.globalState.get<any[]>('gitopsInstances', []);
    instances.push({ name, url, secret });
    await context.globalState.update('gitopsInstances', instances);
    treeDataProvider.refresh();
}

export async function editGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: WorkspacesViewProvider, item: GitOpsItem) {
    const instances = context.globalState.get<any[]>('gitopsInstances', []);
    const index = instances.findIndex(i => i.name === item.name);
    if (index === -1) return;

    const url = await vscode.window.showInputBox({
        prompt: 'Enter new GitOps URL',
        value: item.url,
        ignoreFocusOut: true
    });
    if (!url) return;

    const secret = await vscode.window.showInputBox({
        prompt: 'Enter new GitOps secret token',
        password: true,
        ignoreFocusOut: true
    });
    if (!secret) return;

    instances[index] = { ...instances[index], url, secret };
    await context.globalState.update('gitopsInstances', instances);
    // Clear active instance if it was edited
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (activeInstance && activeInstance.url === item.url) {
        await context.globalState.update('activeGitOpsInstance', instances[index]);
    }
    treeDataProvider.refresh();
}

export async function deleteGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: WorkspacesViewProvider, item: GitOpsItem) {
    const instances = context.globalState.get<any[]>('gitopsInstances', []);
    await context.globalState.update('gitopsInstances', 
        instances.filter(i => i.name !== item.name)
    );
    // Clear active instance if it was deleted
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (activeInstance && activeInstance.url === item.url) {
        await context.globalState.update('activeGitOpsInstance', undefined);
    }
    treeDataProvider.refresh();
}

export async function activateGitOpsCommand(
    context: vscode.ExtensionContext,
    treeDataProvider: WorkspacesViewProvider,
    item: GitOpsItem,
    unifiedImagesProvider?: UnifiedImagesViewProvider,
    orphanedImagesProvider?: OrphanedImagesViewProvider,
) {
    setSseClient(undefined);
    await context.globalState.update('activeGitOpsInstance', item);

    // SSE is the sole source of automations/images/processes/worktrees state.
    // Gitops sends the initial snapshot on connect.
    if (unifiedImagesProvider && orphanedImagesProvider) {
        const client = new GitOpsSSEClient(context, unifiedImagesProvider, orphanedImagesProvider);
        setSseClient(client);
        client.connect(item.url, item.secret);
    }

    treeDataProvider.refresh();
}