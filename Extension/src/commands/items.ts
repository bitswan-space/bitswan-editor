import * as vscode from 'vscode';
import * as path from 'path';
import urlJoin from 'proper-url-join';
import { AutomationsViewProvider} from '../views/automations_view';
import { ImageItem, UnifiedImagesViewProvider, OrphanedImagesViewProvider } from '../views/unified_images_view';
import { AutomationItem } from '../views/automations_view';
import { GitOpsItem } from '../views/workspaces_view';
import { outputChannel, outputChannelsMap } from '../extension';
import { refreshAutomationsCommand } from './automations';
import { refreshImagesCommand } from './images';

export function makeItemCommand(
    commandConfig: {
        title: string;
        initialProgress: string;
        urlPath: string;
        apiFunction: (url: string, secret: string) => Promise<boolean>;
        successProgress: string;
        successMessage: string;
        errorMessage: string;
        errorLogPrefix: string;
        prompt?: boolean;
    }
) {
    return async function (context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider | UnifiedImagesViewProvider | OrphanedImagesViewProvider, item: AutomationItem | ImageItem) {
        const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
        if (!activeInstance) {
            vscode.window.showErrorMessage('No active GitOps instance');
            return;
        }

        if (commandConfig.prompt) {
            const confirmName = await vscode.window.showInputBox({
                prompt: `Type "${item.name}" to confirm the action`,
                placeHolder: item.name,
                validateInput: (value) => {
                    return value === item.name ? null : 'Name does not match';
                }
            });

            if (!confirmName || confirmName !== item.name) {
                return;
            }
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: commandConfig.title,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 25, message: commandConfig.initialProgress });

                var group="";
                if (treeDataProvider instanceof AutomationsViewProvider) {
                    var group = "automations";
                } else if (treeDataProvider instanceof UnifiedImagesViewProvider || treeDataProvider instanceof OrphanedImagesViewProvider) {
                    var group = "images";
                }

                const url = urlJoin(activeInstance.url, group, item.urlSlug(), commandConfig.urlPath).toString();
                outputChannel.appendLine(`${commandConfig.title}: ${item.name} at URL: ${url}`);
                const response = await commandConfig.apiFunction(url, activeInstance.secret);

                if (response) {
                    progress.report({ increment: 100, message: commandConfig.successProgress });
                    vscode.window.showInformationMessage(commandConfig.successMessage);
                    if (treeDataProvider instanceof AutomationsViewProvider) {
                        refreshAutomationsCommand(context, treeDataProvider);
                    } else if (treeDataProvider instanceof UnifiedImagesViewProvider || treeDataProvider instanceof OrphanedImagesViewProvider) {
                        refreshImagesCommand(context, treeDataProvider);
                    }
                    treeDataProvider.refresh();
                } else {
                    vscode.window.showErrorMessage(`${commandConfig.errorMessage} ${item.name}`);
                }

            } catch (error: any) {
                let errorMessage = error.message || 'Unknown error occurred';
                outputChannel.appendLine(`${commandConfig.errorLogPrefix}: ${errorMessage}`);
                vscode.window.showErrorMessage(`${commandConfig.errorMessage}: ${errorMessage}`);
            }
        });
    }
}

export async function showLogsCommand<T extends AutomationItem | ImageItem>(
    context: vscode.ExtensionContext, 
    treeDataProvider: AutomationsViewProvider | UnifiedImagesViewProvider | OrphanedImagesViewProvider, 
    item: T,
    config: {
        entityType: string;
        getLogsFunction: (url: string, secret: string) => Promise<any>;
    }
) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    try {
        outputChannel.appendLine(`Fetching logs for ${config.entityType}: ${item.name}`);

        // Determine the correct URL path based on entity type
        let logsUri: string;
        if (config.entityType === 'image build process') {
            // For images, extract the tag from the name
            const imageTag = item.name.split('/')[1];
            logsUri = urlJoin(activeInstance.url, "images", imageTag, "logs").toString();
        } else {
            // For automations or other entities
            logsUri = urlJoin(activeInstance.url, config.entityType + 's', item.name, "logs").toString();
        }

        const logsResponse = await config.getLogsFunction(logsUri, activeInstance.secret);

        if (!logsResponse) {
            throw new Error('Failed to fetch logs from server');
        }

        // Create a dedicated output channel for this entity's logs
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
        logChannel.appendLine(`Logs for ${config.entityType}: ${item.name}`);
        logChannel.appendLine(`Fetched at: ${new Date().toISOString()}`);
        logChannel.appendLine('='.repeat(80));
        logChannel.appendLine('');

        // Handle the specific JSON response format
        if (typeof logsResponse === 'object' && Array.isArray(logsResponse.logs)) {
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

export async function refreshItemsCommand(
    context: vscode.ExtensionContext, 
    treeDataProvider: AutomationsViewProvider | UnifiedImagesViewProvider | OrphanedImagesViewProvider,
    config: {
        entityType: string;
        getItemsFunction: (url: string, secret: string) => Promise<any>;
    }
) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    try {
        const items = await config.getItemsFunction(
            (urlJoin(activeInstance.url, config.entityType + 's', { trailingSlash: true }).toString()),
            activeInstance.secret
        );
        await context.globalState.update(config.entityType + 's', items);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to get ${config.entityType}s from GitOps: ${error.message}`);
        await context.globalState.update(config.entityType + 's', []);
    }

    treeDataProvider.refresh();
}
