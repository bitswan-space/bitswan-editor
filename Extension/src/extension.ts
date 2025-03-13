import * as vscode from 'vscode';
import * as path from 'path';
import FormData from "form-data"
import JSZip from 'jszip';
import fs from 'fs';


import { getDeployDetails } from './deploy_details';
import {AutomationItem, DirectoryTreeDataProvider, FolderItem, GitOpsItem} from './views/bitswan_pre';
import { activateAutomation, activateDeployment, deactivateAutomation, deploy, getAutomationLogs, getAutomations, restartAutomation, startAutomation, stopAutomation, zip2stream, zipDirectory } from './lib';

// Defining logging channel
export let outputChannel: vscode.OutputChannel;

// Map to track output channels
const outputChannelsMap = new Map<string, vscode.OutputChannel>();

// Store the refresh interval ID
let automationRefreshInterval: NodeJS.Timer | undefined;

/**
 * This is Deploy Command which is registered as a Visual Studio code command
 */
async function _deployCommand(context: vscode.ExtensionContext, folderItemOrPath: FolderItem | string | undefined) {
    outputChannel.appendLine(`Deploying pipeline: ${folderItemOrPath}`);
    let pipelineDeploymentPath: string | undefined;

    // create folder path out of provided argument. Its either folder, folder's path or it is not defined
    if (folderItemOrPath instanceof FolderItem) {
        const pipelinePathExists = path.join(folderItemOrPath.resourceUri.fsPath, 'pipelines.conf');
        if (fs.existsSync(pipelinePathExists)) {
            pipelineDeploymentPath = path.join(folderItemOrPath.resourceUri.fsPath, 'pipelines.conf');
        }
    } else if (typeof folderItemOrPath === 'string') {
        pipelineDeploymentPath = folderItemOrPath;
    } else {
        let editor = vscode.window.activeTextEditor;
        if (editor && (path.extname(editor.document.fileName) === '.conf' || path.extname(editor.document.fileName) === '.ipynb')) {
            pipelineDeploymentPath = editor.document.uri.fsPath;
        }
    }

    outputChannel.appendLine(`Pipeline deployment path: ${pipelineDeploymentPath}`);

    if (!pipelineDeploymentPath) {
        vscode.window.showErrorMessage('Unable to determine pipeline config path. Please select a pipeline config from the tree view or open one in the editor.');
        return;
    }

    // get deployURL and deploySecret
    const details = await getDeployDetails(context);
    if (!details) {
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }

    const folderName = path.basename(path.dirname(pipelineDeploymentPath));

    outputChannel.appendLine(`Folder name: ${folderName}`);

    // deployment of pipeline
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deploying pipeline",
        cancellable: false
    }, async (progress, _token) => {
        try {
            const form = new FormData();
            const normalizedFolderName = folderName.replace(/\//g, '-');
            const deployUrl = new URL(path.join(details.deployUrl, "automations", normalizedFolderName));

            outputChannel.appendLine(`Deploy URL: ${deployUrl.toString()}`);

            progress.report({ increment: 0, message: "Packing for deployment..." });

            // Zip the pipeline config folder and add it to the form
            let zip = await zipDirectory(path.dirname(pipelineDeploymentPath as string), '', JSZip(), outputChannel);
            const workspacePath = path.join(workspaceFolders[0].uri.fsPath, 'workspace')
            const bitswanLibPath = path.join(workspacePath, 'bitswan_lib')
            if (fs.existsSync(bitswanLibPath)) {
                zip = await zipDirectory(bitswanLibPath, '', zip, outputChannel);
                outputChannel.appendLine(`bitswan_lib found at ${bitswanLibPath}`);
            } else {
                outputChannel.appendLine(`Error. bitswan_lib not found at ${bitswanLibPath}`);
            }
            const stream = await zip2stream(zip);
            form.append('file', stream, {
                filename: 'deployment.zip',
                contentType: 'application/zip',
            });

            progress.report({ increment: 50, message: "Uploading to server " + deployUrl.toString() });

            const success = await deploy(deployUrl.toString(), form, details.deploySecret);

            if (success) {
                progress.report({ increment: 100, message: "Succesfully uploaded automation on GitOps" });
                vscode.window.showInformationMessage(`Succesfully uploaded automation on GitOps`);
            } else {
                throw new Error(`Failed to upload automation on GitOps`);
            }
            progress.report({ increment: 50, message: "Activating deployment..." });

            const activationSuccess = await activateDeployment(path.join(details.deployUrl,"automations", normalizedFolderName, "deploy").toString(), details.deploySecret);
            if (activationSuccess) {
                progress.report({ increment: 100, message: `Succesfully activated automation on GitOps` });
                vscode.window.showInformationMessage(`Succesfully activated automation on GitOps`);
            } else {
                throw new Error(`Failed to activate automation on GitOps`);
            }

        } catch (error: any) {
            let errorMessage: string;
            if (error.response) {
                outputChannel.appendLine(`Error response data: ${JSON.stringify(error.response.data)}`);
                errorMessage = `Server responded with status ${error.response.status}`;
            } else if (error.request) {
                errorMessage = 'No response received from server';
            } else {
                errorMessage = error.message;
            }
            vscode.window.showErrorMessage(`Deployment error: ${errorMessage}`);
            return;
        }
    });
}

async function _addGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider) {
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

async function _editGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: GitOpsItem) {
    const instances = context.globalState.get<any[]>('gitopsInstances', []);
    const index = instances.findIndex(i => i.name === item.label);
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

async function _deleteGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: GitOpsItem) {
    const instances = context.globalState.get<any[]>('gitopsInstances', []);
    await context.globalState.update('gitopsInstances', 
        instances.filter(i => i.name !== item.label)
    );
    // Clear active instance if it was deleted
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (activeInstance && activeInstance.url === item.url) {
        // Clear the refresh interval when deleting active GitOps instance
        if (automationRefreshInterval) {
            clearInterval(automationRefreshInterval);
            automationRefreshInterval = undefined;
            outputChannel.appendLine('Stopped automatic refresh of automations');
        }
        await context.globalState.update('activeGitOpsInstance', undefined);
    }
    treeDataProvider.refresh();
}

async function _activateGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: GitOpsItem) {
    // Clear any existing refresh interval
    if (automationRefreshInterval) {
        clearInterval(automationRefreshInterval);
        automationRefreshInterval = undefined;
    }

    await context.globalState.update('activeGitOpsInstance', item);
    try {
        const pres = await getAutomations(path.join(item.url, "automations").toString(), item.secret);
        await context.globalState.update('automations', pres);
        
        // Set up automatic refresh every 10 seconds
        automationRefreshInterval = setInterval(() => {
            _refreshAutomationsCommand(context, treeDataProvider);
        }, 10000);
        
        outputChannel.appendLine('Started automatic refresh of automations (every 10 seconds)');
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to get automations from GitOps: ${error.message}`);
        await context.globalState.update('automations', []);
    }

    treeDataProvider.refresh();
}

async function _refreshAutomationsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    try {
        const automations = await getAutomations(path.join(activeInstance.url, "automations").toString(), activeInstance.secret);
        await context.globalState.update('automations', automations);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to get automations from GitOps: ${error.message}`);
        await context.globalState.update('automations', []);
    }

    treeDataProvider.refresh();
}

async function _restartAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: AutomationItem) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Restarting automation: ${item.name}`,
        cancellable: false
    }, async (progress, _token) => {
        try {
            progress.report({ increment: 0, message: "Sending restart request..." });
            
            const restartUrl = path.join(activeInstance.url, "automations", item.name, "restart").toString();
            outputChannel.appendLine(`Restarting automation: ${item.name} at URL: ${restartUrl}`);
            
            progress.report({ increment: 50, message: "Processing restart request..." });
            
            const restartResponse = await restartAutomation(restartUrl, activeInstance.secret);
            
            if (restartResponse) {
                progress.report({ increment: 100, message: "Restart successful" });
                vscode.window.showInformationMessage(`Automation ${item.name} restarted successfully`);
                _refreshAutomationsCommand(context, treeDataProvider);
                treeDataProvider.refresh();
            } else {
                vscode.window.showErrorMessage(`Failed to restart automation ${item.name}`);
            }
        } catch (error: any) {
            let errorMessage = error.message || 'Unknown error occurred';
            outputChannel.appendLine(`Error restarting automation: ${errorMessage}`);
            vscode.window.showErrorMessage(`Failed to restart automation: ${errorMessage}`);
        }
    });
}

async function _startAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: AutomationItem) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Starting automation: ${item.name}`,
        cancellable: false
    }, async (progress, _token) => {
        try {
            progress.report({ increment: 0, message: "Sending start request..." });

            const startUrl = path.join(activeInstance.url, "automations", item.name, "start").toString();
            outputChannel.appendLine(`Starting automation: ${item.name} at URL: ${startUrl}`);

            const startResponse = await startAutomation(startUrl, activeInstance.secret);

            if (startResponse) {
                progress.report({ increment: 100, message: "Start successful" });
                vscode.window.showInformationMessage(`Automation ${item.name} started successfully`);
                _refreshAutomationsCommand(context, treeDataProvider);
                treeDataProvider.refresh();
            } else {
                vscode.window.showErrorMessage(`Failed to start automation ${item.name}`);
            }
        } catch (error: any) {
            let errorMessage = error.message || 'Unknown error occurred';
            outputChannel.appendLine(`Error starting automation: ${errorMessage}`);
            vscode.window.showErrorMessage(`Failed to start automation: ${errorMessage}`);
        }
    })
}

async function _stopAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: AutomationItem) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Stopping automation: ${item.name}`,
        cancellable: false
    }, async (progress, _token) => {
        try {
            progress.report({ increment: 0, message: "Sending stop request..." });

            const stopUrl = path.join(activeInstance.url, "automations", item.name, "stop").toString();
            outputChannel.appendLine(`Stopping automation: ${item.name} at URL: ${stopUrl}`);
            
            const stopResponse = await stopAutomation(stopUrl, activeInstance.secret);

            if (stopResponse) {
                progress.report({ increment: 100, message: "Stop successful" });
                vscode.window.showInformationMessage(`Automation ${item.name} stopped successfully`);
                _refreshAutomationsCommand(context, treeDataProvider);
                treeDataProvider.refresh();
            } else {
                vscode.window.showErrorMessage(`Failed to stop automation ${item.name}`);
            }
        } catch (error: any) {
            let errorMessage = error.message || 'Unknown error occurred';
            outputChannel.appendLine(`Error stopping automation: ${errorMessage}`);
            vscode.window.showErrorMessage(`Failed to stop automation: ${errorMessage}`);
        }
    })
}

async function _showAutomationLogsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: AutomationItem) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    try {
        outputChannel.appendLine(`Fetching logs for automation: ${item.name}`);
        
        const logsUri = path.join(activeInstance.url, "automations", item.name, "logs").toString();
        const logsResponse = await getAutomationLogs(logsUri, activeInstance.secret);
        
        if (!logsResponse) {
            throw new Error('Failed to fetch logs from server');
        }
        
        // Create a dedicated output channel for this automation's logs
        const logChannelName = `BitSwan: ${item.name} Logs`;
        
        // Check if the channel already exists in our map
        let logChannel: vscode.OutputChannel;
        if (outputChannelsMap.has(logChannelName)) {
            outputChannel.appendLine(`Using existing output channel: ${logChannelName}`);
            logChannel = outputChannelsMap.get(logChannelName)!;
            logChannel.clear(); // Clear existing content
        } else {
            outputChannel.appendLine(`Creating new output channel: ${logChannelName}`);
            logChannel = vscode.window.createOutputChannel(logChannelName);
            outputChannelsMap.set(logChannelName, logChannel);
        }
        
        // Display logs in the output channel
        logChannel.appendLine('='.repeat(80));
        logChannel.appendLine(`Logs for automation: ${item.name}`);
        logChannel.appendLine(`Fetched at: ${new Date().toISOString()}`);
        logChannel.appendLine('='.repeat(80));
        logChannel.appendLine('');
        
        // Handle the specific JSON response format
        if (typeof logsResponse === 'object' && logsResponse.status === 'success' && Array.isArray(logsResponse.logs)) {
            // Join the logs array with newlines
            logsResponse.logs.forEach((logLine: string) => {
                logChannel.appendLine(logLine);
            });
        } else if (typeof logsResponse === 'string') {
            // If the response is a string, display it directly
            logChannel.appendLine(logsResponse);
        } else {
            // If the response is in an unexpected format, stringify it
            logChannel.appendLine(JSON.stringify(logsResponse, null, 2));
        }
        
        // Show the output channel
        logChannel.show(true);
        
        outputChannel.appendLine(`Logs for ${item.name} displayed successfully`);
    } catch (error: any) {
        let errorMessage = error.message || 'Unknown error occurred';
        outputChannel.appendLine(`Error fetching logs: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to fetch logs: ${errorMessage}`);
    }
}

async function _activateAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: AutomationItem) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Activating automation ${item.name}...`,
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 50 });
        
        const activateUrl = path.join(activeInstance.url, "automations", item.name, "activate").toString();
        const activateResponse = await activateAutomation(activateUrl, activeInstance.secret);

        progress.report({ increment: 100 });

        if (activateResponse) {
            vscode.window.showInformationMessage(`Automation ${item.name} activated successfully`);
            _refreshAutomationsCommand(context, treeDataProvider);
            treeDataProvider.refresh();
        } else {
            vscode.window.showErrorMessage(`Failed to activate automation ${item.name}`);
        }
    });
}

async function _deactivateAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: AutomationItem) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Deactivating automation ${item.name}...`,
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 50 });
        
        const deactivateUrl = path.join(activeInstance.url, "automations", item.name, "deactivate").toString();
        const deactivateResponse = await deactivateAutomation(deactivateUrl, activeInstance.secret);

        progress.report({ increment: 100 });

        if (deactivateResponse) {
            vscode.window.showInformationMessage(`Automation ${item.name} deactivated successfully`);
            _refreshAutomationsCommand(context, treeDataProvider);
            treeDataProvider.refresh();
        } else {
            vscode.window.showErrorMessage(`Failed to deactivate automation ${item.name}`);
        }
    });
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

    // Create sidebar tree for browsing deployments
    const directoryTreeDataProvider = new DirectoryTreeDataProvider(context);
    vscode.window.createTreeView('bitswan', {
        treeDataProvider: directoryTreeDataProvider,
        showCollapseAll: true
    });



    vscode.window.registerTreeDataProvider('bitswan', directoryTreeDataProvider);
    // bind deployment to a command
    let deployCommand = vscode.commands.registerCommand('bitswan.deployPipeline', async (item: FolderItem) => _deployCommand(context, item));
    let addGitOpsCommand = vscode.commands.registerCommand('bitswan.addGitOps', async () => _addGitOpsCommand(context, directoryTreeDataProvider));
    let editGitOpsCommand = vscode.commands.registerCommand('bitswan.editGitOps', async (item: GitOpsItem) => _editGitOpsCommand(context, directoryTreeDataProvider, item));
    let deleteGitOpsCommand = vscode.commands.registerCommand('bitswan.deleteGitOps', async (item: GitOpsItem) => _deleteGitOpsCommand(context, directoryTreeDataProvider, item));
    let activateGitOpsCommand = vscode.commands.registerCommand('bitswan.activateGitOps', async (item: GitOpsItem) => _activateGitOpsCommand(context, directoryTreeDataProvider, item));
    let refreshAutomationsCommand = vscode.commands.registerCommand('bitswan.refreshAutomations', async () => { _refreshAutomationsCommand(context, directoryTreeDataProvider) });
    let startAutomationCommand = vscode.commands.registerCommand('bitswan.startAutomation', async (item: AutomationItem) => _startAutomationCommand(context, directoryTreeDataProvider, item));
    let stopAutomationCommand = vscode.commands.registerCommand('bitswan.stopAutomation', async (item: AutomationItem) => _stopAutomationCommand(context, directoryTreeDataProvider, item));
    let restartAutomationCommand = vscode.commands.registerCommand('bitswan.restartAutomation', async (item: AutomationItem) => _restartAutomationCommand(context, directoryTreeDataProvider, item));
    let showAutomationLogsCommand = vscode.commands.registerCommand('bitswan.showAutomationLogs', async (item: AutomationItem) => _showAutomationLogsCommand(context, directoryTreeDataProvider, item));
    let activateAutomationCommand = vscode.commands.registerCommand('bitswan.activateAutomation', async (item: AutomationItem) => _activateAutomationCommand(context, directoryTreeDataProvider, item));
    let deactivateAutomationCommand = vscode.commands.registerCommand('bitswan.deactivateAutomation', async (item: AutomationItem) => _deactivateAutomationCommand(context, directoryTreeDataProvider, item));

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

    // Refresh the tree view when files change in the workspace
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(() => directoryTreeDataProvider.refresh());
    watcher.onDidDelete(() => directoryTreeDataProvider.refresh());
    watcher.onDidChange(() => directoryTreeDataProvider.refresh());

    const activeGitOpsInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (activeGitOpsInstance) {
        _activateGitOpsCommand(context, directoryTreeDataProvider, activeGitOpsInstance);
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
