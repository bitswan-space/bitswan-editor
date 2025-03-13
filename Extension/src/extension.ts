import * as vscode from 'vscode';

import {AutomationItem, DirectoryTreeDataProvider, FolderItem, GitOpsItem} from './views/bitswan_pre';

// Import commands from the new command modules
import * as automationCommands from './commands/automations';
import * as workspaceCommands from './commands/workspaces';
import * as deploymentCommands from './commands/deployments';

// Defining logging channel
export let outputChannel: vscode.OutputChannel;

// Map to track output channels
export const outputChannelsMap = new Map<string, vscode.OutputChannel>();

// Store the refresh interval ID
let automationRefreshInterval: NodeJS.Timer | undefined;

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

    // Create sidebar tree for browsing deployments
    const directoryTreeDataProvider = new DirectoryTreeDataProvider(context);
    vscode.window.createTreeView('bitswan', {
        treeDataProvider: directoryTreeDataProvider,
        showCollapseAll: true
    });

    vscode.window.registerTreeDataProvider('bitswan', directoryTreeDataProvider);

    // Register commands using the new command modules
    let deployCommand = vscode.commands.registerCommand('bitswan.deployPipeline', 
        async (item: FolderItem) => deploymentCommands.deployCommand(context, directoryTreeDataProvider, item));
    
    let addGitOpsCommand = vscode.commands.registerCommand('bitswan.addGitOps', 
        async () => workspaceCommands.addGitOpsCommand(context, directoryTreeDataProvider));
    
    let editGitOpsCommand = vscode.commands.registerCommand('bitswan.editGitOps', 
        async (item: GitOpsItem) => workspaceCommands.editGitOpsCommand(context, directoryTreeDataProvider, item));
    
    let deleteGitOpsCommand = vscode.commands.registerCommand('bitswan.deleteGitOps', 
        async (item: GitOpsItem) => workspaceCommands.deleteGitOpsCommand(context, directoryTreeDataProvider, item));
    
    let activateGitOpsCommand = vscode.commands.registerCommand('bitswan.activateGitOps', 
        async (item: GitOpsItem) => workspaceCommands.activateGitOpsCommand(context, directoryTreeDataProvider, item));
    
    let refreshAutomationsCommand = vscode.commands.registerCommand('bitswan.refreshAutomations', 
        async () => automationCommands.refreshAutomationsCommand(context, directoryTreeDataProvider));
    
    let startAutomationCommand = vscode.commands.registerCommand('bitswan.startAutomation', 
        async (item: AutomationItem) => automationCommands.startAutomationCommand(context, directoryTreeDataProvider, item));
    
    let stopAutomationCommand = vscode.commands.registerCommand('bitswan.stopAutomation', 
        async (item: AutomationItem) => automationCommands.stopAutomationCommand(context, directoryTreeDataProvider, item));
    
    let restartAutomationCommand = vscode.commands.registerCommand('bitswan.restartAutomation', 
        async (item: AutomationItem) => automationCommands.restartAutomationCommand(context, directoryTreeDataProvider, item));
    
    let showAutomationLogsCommand = vscode.commands.registerCommand('bitswan.showAutomationLogs', 
        async (item: AutomationItem) => automationCommands.showAutomationLogsCommand(context, directoryTreeDataProvider, item));
    
    let activateAutomationCommand = vscode.commands.registerCommand('bitswan.activateAutomation', 
        async (item: AutomationItem) => automationCommands.activateAutomationCommand(context, directoryTreeDataProvider, item));
    
    let deactivateAutomationCommand = vscode.commands.registerCommand('bitswan.deactivateAutomation', 
        async (item: AutomationItem) => automationCommands.deactivateAutomationCommand(context, directoryTreeDataProvider, item));
    
    let deleteAutomationCommand = vscode.commands.registerCommand('bitswan.deleteAutomation', 
        async (item: AutomationItem) => automationCommands.deleteAutomationCommand(context, directoryTreeDataProvider, item));

    // Register all commands
    context.subscriptions.push(deployCommand);
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

    // Refresh the tree view when files change in the workspace
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(() => directoryTreeDataProvider.refresh());
    watcher.onDidDelete(() => directoryTreeDataProvider.refresh());
    watcher.onDidChange(() => directoryTreeDataProvider.refresh());

    const activeGitOpsInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (activeGitOpsInstance) {
        workspaceCommands.activateGitOpsCommand(context, directoryTreeDataProvider, activeGitOpsInstance);
    }

    context.subscriptions.push(watcher);

    outputChannel.appendLine('Tree view provider registered');
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
