import * as vscode from 'vscode';

import { AutomationItem } from './views/automations_view';
import { FolderItem } from './views/sources_view';
import { GitOpsItem } from './views/workspaces_view';

// Import commands from the new command modules
import * as automationCommands from './commands/automations';
import * as workspaceCommands from './commands/workspaces';
import * as deploymentCommands from './commands/deployments';

// Import view providers
import { AutomationSourcesViewProvider } from './views/automation_sources_view';
import { WorkspacesViewProvider } from './views/workspaces_view';
import { AutomationsViewProvider } from './views/automations_view';
import { ImageSourcesViewProvider } from './views/image_sources_view';
import { ImagesViewProvider } from './views/images_view';
import { activateAutomation, deactivateAutomation, deleteAutomation, restartAutomation, startAutomation, stopAutomation } from './lib';

// Defining logging channel
export let outputChannel: vscode.OutputChannel;

// Map to track output channels
export const outputChannelsMap = new Map<string, vscode.OutputChannel>();

// Store the refresh interval ID
export let automationRefreshInterval: NodeJS.Timer | undefined;

export function setAutomationRefreshInterval(interval: NodeJS.Timer | undefined) {
    if (automationRefreshInterval) {
        clearInterval(automationRefreshInterval);
    }
    automationRefreshInterval = interval;
}

/**
 * This method is called by VSC when extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {
    // Create and show output channel immediately
    outputChannel = vscode.window.createOutputChannel('BitSwan');
    outputChannel.show(true); // true forces the output channel to take focus

    outputChannel.appendLine('=====================================');
    outputChannel.appendLine('BitSwan Extension Activation Start');
    outputChannel.appendLine(`Activation Time: ${new Date().toISOString()}`);
    outputChannel.appendLine('=====================================');

    // Add console.log for debugging in Debug Console
    console.log('BitSwan Extension Activating - Debug Console Test');

    if (process.env.BITSWAN_DEPLOY_URL || process.env.BITSWAN_DEPLOY_SECRET) {
        vscode.commands.executeCommand('bitswan-workspaces.removeView');
    }

    // Create view providers
    const deploymentsProvider = new AutomationSourcesViewProvider(context);
    const workspacesProvider = new WorkspacesViewProvider(context);
    const automationsProvider = new AutomationsViewProvider(context);
    const imageSourcesProvider = new ImageSourcesViewProvider(context);
    const imagesProvider = new ImagesViewProvider(context);

    // Register views
    vscode.window.createTreeView('bitswan-deployments', {
        treeDataProvider: deploymentsProvider,
    });

    vscode.window.createTreeView('bitswan-workspaces', {
        treeDataProvider: workspacesProvider,
    });

    vscode.window.createTreeView('bitswan-automations', {
        treeDataProvider: automationsProvider,
    });

    vscode.window.createTreeView('bitswan-image-sources', {
        treeDataProvider: imageSourcesProvider,
    });

    vscode.window.createTreeView('bitswan-images', {
        treeDataProvider: imagesProvider,
    });

    // Register commands using the new command modules
    let deployCommand = vscode.commands.registerCommand('bitswan.deployPipeline', 
        async (item: FolderItem) => deploymentCommands.deployCommand(context, deploymentsProvider, item, "automations"));

    let buildImageCommand = vscode.commands.registerCommand('bitswan.buildImage', 
        async (item: FolderItem) => deploymentCommands.deployCommand(context, deploymentsProvider, item, "images"));
    
    let addGitOpsCommand = vscode.commands.registerCommand('bitswan.addGitOps', 
        async () => workspaceCommands.addGitOpsCommand(context, workspacesProvider));
    
    let editGitOpsCommand = vscode.commands.registerCommand('bitswan.editGitOps', 
        async (item: GitOpsItem) => workspaceCommands.editGitOpsCommand(context, workspacesProvider, item));
    
    let deleteGitOpsCommand = vscode.commands.registerCommand('bitswan.deleteGitOps', 
        async (item: GitOpsItem) => workspaceCommands.deleteGitOpsCommand(context, workspacesProvider, item));
    
    let activateGitOpsCommand = vscode.commands.registerCommand('bitswan.activateGitOps', 
        async (item: GitOpsItem) => {
            await workspaceCommands.activateGitOpsCommand(context, workspacesProvider, item, automationsProvider); // Refresh automations when GitOps instance is activated
        });
    
    let refreshAutomationsCommand = vscode.commands.registerCommand('bitswan.refreshAutomations', 
        async () => automationCommands.refreshAutomationsCommand(context, automationsProvider));
    
    let startAutomationCommand = vscode.commands.registerCommand('bitswan.startAutomation', 
        async (item: AutomationItem) => automationCommands.makeAutomationCommand({
            title: `Starting Automation ${item.name}`,
            initialProgress: 'Sending request to GitOps...',
            urlPath: 'start',
            apiFunction: startAutomation,
            successProgress: `Automation ${item.name} started successfully`,
            successMessage: `Automation ${item.name} started successfully`,
            errorMessage: `Failed to start automation ${item.name}:`,
            errorLogPrefix: 'Automation Start Error:'
        })(context, automationsProvider, item));
    
    let stopAutomationCommand = vscode.commands.registerCommand('bitswan.stopAutomation', 
        async (item: AutomationItem) => automationCommands.makeAutomationCommand({
            title: `Stopping Automation ${item.name}`,
            initialProgress: 'Sending request to GitOps...',
            urlPath: 'stop',
            apiFunction: stopAutomation,
            successProgress: `Automation ${item.name} stopped successfully`,
            successMessage: `Automation ${item.name} stopped successfully`,
            errorMessage: `Failed to stop automation ${item.name}:`,
            errorLogPrefix: 'Automation Stop Error:'
        })(context, automationsProvider, item));
    
    let restartAutomationCommand = vscode.commands.registerCommand('bitswan.restartAutomation',     
        async (item: AutomationItem) => automationCommands.makeAutomationCommand({
            title: `Restarting Automation ${item.name}`,
            initialProgress: 'Sending request to GitOps...',
            urlPath: 'restart',
            apiFunction: restartAutomation,
            successProgress: `Automation ${item.name} restarted successfully`,
            successMessage: `Automation ${item.name} restarted successfully`,
            errorMessage: `Failed to restart automation ${item.name}:`,
            errorLogPrefix: 'Automation Restart Error:'
        })(context, automationsProvider, item));
    
    let showAutomationLogsCommand = vscode.commands.registerCommand('bitswan.showAutomationLogs', 
        async (item: AutomationItem) => automationCommands.showAutomationLogsCommand(context, automationsProvider, item));

    let activateAutomationCommand = vscode.commands.registerCommand('bitswan.activateAutomation', 
        async (item: AutomationItem) => automationCommands.makeAutomationCommand({
            title: `Activating Automation ${item.name}`,
            initialProgress: 'Sending request to GitOps...',
            urlPath: 'activate',
            apiFunction: activateAutomation,
            successProgress: `Automation ${item.name} activated successfully`,
            successMessage: `Automation ${item.name} activated successfully`,
            errorMessage: `Failed to activate automation ${item.name}:`,
            errorLogPrefix: 'Automation Activate Error:'
        })(context, automationsProvider, item));
    
    let deactivateAutomationCommand = vscode.commands.registerCommand('bitswan.deactivateAutomation', 
        async (item: AutomationItem) => automationCommands.makeAutomationCommand({
            title: `Deactivating Automation ${item.name}`,
            initialProgress: 'Sending request to GitOps...',
            urlPath: 'deactivate',
            apiFunction: deactivateAutomation,
            successProgress: `Automation ${item.name} deactivated successfully`,
            successMessage: `Automation ${item.name} deactivated successfully`,
            errorMessage: `Failed to deactivate automation ${item.name}:`,
            errorLogPrefix: 'Automation Deactivate Error:'
        })(context, automationsProvider, item));
    
    let deleteAutomationCommand = vscode.commands.registerCommand('bitswan.deleteAutomation', 
        async (item: AutomationItem) => automationCommands.makeAutomationCommand({
            title: `Deleting Automation ${item.name}`,
            initialProgress: 'Sending request to GitOps...',
            urlPath: '',
            apiFunction: deleteAutomation,
            successProgress: `Automation ${item.name} deleted successfully`,
            successMessage: `Automation ${item.name} deleted successfully`,
            errorMessage: `Failed to delete automation ${item.name}:`,
            errorLogPrefix: 'Automation Delete Error:',
            prompt: true
        })(context, automationsProvider, item));
    
    // Register all commands
    context.subscriptions.push(deployCommand);
    context.subscriptions.push(buildImageCommand);
    context.subscriptions.push(addGitOpsCommand);
    context.subscriptions.push(editGitOpsCommand);
    context.subscriptions.push(deleteGitOpsCommand);
    context.subscriptions.push(activateGitOpsCommand);
    context.subscriptions.push(refreshAutomationsCommand);
    context.subscriptions.push(restartAutomationCommand);
    context.subscriptions.push(startAutomationCommand);
    context.subscriptions.push(stopAutomationCommand);
    context.subscriptions.push(showAutomationLogsCommand);
    context.subscriptions.push(activateAutomationCommand);
    context.subscriptions.push(deactivateAutomationCommand);
    context.subscriptions.push(deleteAutomationCommand);

    // Refresh the tree views when files change in the workspace
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(() => deploymentsProvider.refresh());
    watcher.onDidDelete(() => deploymentsProvider.refresh());
    watcher.onDidChange(() => deploymentsProvider.refresh());

    const activeGitOpsInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (activeGitOpsInstance) {
        workspaceCommands.activateGitOpsCommand(context, workspacesProvider, activeGitOpsInstance, automationsProvider);
        automationsProvider.refresh();
    } else if (process.env.BITSWAN_DEPLOY_URL && process.env.BITSWAN_DEPLOY_SECRET) {
        const activeGitOpsInstance = new GitOpsItem(
            'Active GitOps Instance',
            process.env.BITSWAN_DEPLOY_URL,
            process.env.BITSWAN_DEPLOY_SECRET,
            true
        );
        workspaceCommands.activateGitOpsCommand(context, workspacesProvider, activeGitOpsInstance, automationsProvider);
        automationsProvider.refresh();
    }

    context.subscriptions.push(watcher);

    outputChannel.appendLine('Tree views registered');
}

/**
 * This method is called when the extension is deactivated
 */
export function deactivate() {
    // Clean up the refresh interval
    if (automationRefreshInterval) {
        clearInterval(automationRefreshInterval);
        automationRefreshInterval = undefined;
        outputChannel.appendLine('Stopped automatic refresh of automations');
    }

    // Clean up output channels
    outputChannel.appendLine('Cleaning up output channels...');
    
    // Dispose all output channels in the map
    outputChannelsMap.forEach((channel, name) => {
        outputChannel.appendLine(`Disposing output channel: ${name}`);
        channel.dispose();
    });
    
    // Clear the map
    outputChannelsMap.clear();
    
    // Dispose the main output channel
    outputChannel.appendLine('BitSwan Extension Deactivated');
    outputChannel.dispose();
}
