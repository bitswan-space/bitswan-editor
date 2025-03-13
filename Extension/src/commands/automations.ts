import * as vscode from 'vscode';
import * as path from 'path';
import { AutomationItem } from  '../views/automations_view';
import { GitOpsItem } from '../views/workspaces_view';
import { activateAutomation, deactivateAutomation, deleteAutomation, getAutomationLogs, getAutomations, restartAutomation, startAutomation, stopAutomation } from '../lib';
import { outputChannel, outputChannelsMap } from '../extension';
import { AutomationsViewProvider } from '../views/automations_view';

export async function startAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider, item: AutomationItem) {
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
                refreshAutomationsCommand(context, treeDataProvider);
                treeDataProvider.refresh();
            } else {
                vscode.window.showErrorMessage(`Failed to start automation ${item.name}`);
            }
        } catch (error: any) {
            let errorMessage = error.message || 'Unknown error occurred';
            outputChannel.appendLine(`Error starting automation: ${errorMessage}`);
            vscode.window.showErrorMessage(`Failed to start automation: ${errorMessage}`);
        }
    });
}

export async function stopAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider, item: AutomationItem) {
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
                refreshAutomationsCommand(context, treeDataProvider);
                treeDataProvider.refresh();
            } else {
                vscode.window.showErrorMessage(`Failed to stop automation ${item.name}`);
            }
        } catch (error: any) {
            let errorMessage = error.message || 'Unknown error occurred';
            outputChannel.appendLine(`Error stopping automation: ${errorMessage}`);
            vscode.window.showErrorMessage(`Failed to stop automation: ${errorMessage}`);
        }
    });
}

export async function restartAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider, item: AutomationItem) {
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
                refreshAutomationsCommand(context, treeDataProvider);
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

export async function showAutomationLogsCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider, item: AutomationItem) {
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

export async function activateAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider, item: AutomationItem) {
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
            refreshAutomationsCommand(context, treeDataProvider);
            treeDataProvider.refresh();
        } else {
            vscode.window.showErrorMessage(`Failed to activate automation ${item.name}`);
        }
    });
}

export async function deactivateAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider, item: AutomationItem) {
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
            refreshAutomationsCommand(context, treeDataProvider);
            treeDataProvider.refresh();
        } else {
            vscode.window.showErrorMessage(`Failed to deactivate automation ${item.name}`);
        }
    });
}

export async function deleteAutomationCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider, item: AutomationItem) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    // Prompt user to type the automation name to confirm deletion
    const confirmName = await vscode.window.showInputBox({
        prompt: `Type "${item.name}" to confirm deletion`,
        placeHolder: item.name,
        validateInput: (value) => {
            return value === item.name ? null : 'Name does not match';
        }
    });

    // If user cancelled or typed wrong name, abort
    if (!confirmName || confirmName !== item.name) {
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Deleting automation ${item.name}...`,
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 50 });

        const deleteUrl = path.join(activeInstance.url, "automations", item.name).toString();
        const deleteResponse = await deleteAutomation(deleteUrl, activeInstance.secret);

        progress.report({ increment: 100 });

        if (deleteResponse) {
            vscode.window.showInformationMessage(`Automation ${item.name} deleted successfully`);
            refreshAutomationsCommand(context, treeDataProvider);
            treeDataProvider.refresh();
        } else {
            vscode.window.showErrorMessage(`Failed to delete automation ${item.name}`);
        }
    });
}

export async function refreshAutomationsCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider) {
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