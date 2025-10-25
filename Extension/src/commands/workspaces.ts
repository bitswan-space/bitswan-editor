import * as vscode from 'vscode';
import * as path from 'path';
import urlJoin from 'proper-url-join';
import { GitOpsItem } from '../views/workspaces_view';
import { getAutomations } from '../lib';
import { WorkspacesViewProvider } from '../views/workspaces_view';
import { AutomationsViewProvider } from '../views/automations_view';
import { UnifiedImagesViewProvider, OrphanedImagesViewProvider } from '../views/unified_images_view';
import { outputChannel, setAutomationRefreshInterval, setImageRefreshInterval } from '../extension';
import { refreshAutomationsCommand } from './automations';
import { refreshImagesCommand } from './images';

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
    automationsProvider?: { refresh(): void },
    unifiedImagesProvider?: UnifiedImagesViewProvider,
    orphanedImagesProvider?: OrphanedImagesViewProvider
) {
    // Clear any existing refresh intervals
    setAutomationRefreshInterval(undefined);
    setImageRefreshInterval(undefined);

    await context.globalState.update('activeGitOpsInstance', item);
    try {
        const automations = await getAutomations(urlJoin(item.url, 'automations', { trailingSlash: true }).toString(), item.secret);
        await context.globalState.update('automations', automations);

        // Set up automatic refresh every 10 seconds for automations
        if (automationsProvider) {
            setAutomationRefreshInterval(setInterval(async () => {
                await refreshAutomationsCommand(context, automationsProvider);
            }, 10000));
        }

        // Set up automatic refresh every 15 seconds for images
        if (unifiedImagesProvider && orphanedImagesProvider) {
            setImageRefreshInterval(setInterval(async () => {
                await refreshImagesCommand(context, unifiedImagesProvider);
                await refreshImagesCommand(context, orphanedImagesProvider);
            }, 15000));
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to get automations from GitOps: ${error.message}`);
        await context.globalState.update('automations', []);
    }

    treeDataProvider.refresh();
} 