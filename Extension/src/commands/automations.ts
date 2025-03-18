import * as vscode from 'vscode';
import * as path from 'path';
import { AutomationItem } from  '../views/automations_view';
import { GitOpsItem } from '../views/workspaces_view';
import { getAutomationLogs, getAutomations } from '../lib';
import { outputChannel, outputChannelsMap } from '../extension';
import { AutomationsViewProvider } from '../views/automations_view';
import { ImagesViewProvider } from '../views/images_view';

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