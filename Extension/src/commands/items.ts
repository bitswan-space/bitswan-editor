import * as vscode from 'vscode';
import urlJoin from 'proper-url-join';
import { ImageItem, UnifiedImagesViewProvider, OrphanedImagesViewProvider } from '../views/unified_images_view';
import { AutomationItem } from '../views/automations_view';
import { GitOpsItem } from '../views/workspaces_view';
import { outputChannel, outputChannelsMap } from '../extension';

export interface RefreshOptions {
    silent?: boolean;
}

/**
 * Build a command handler that POSTs to `<base>/<entityGroup>/<itemSlug>/<urlPath>`
 * and surfaces progress/notifications. SSE drives view refreshes — this no longer
 * needs a tree-view provider.
 */
export function makeItemCommand(
    commandConfig: {
        title: string;
        initialProgress: string;
        urlPath: string;
        entityGroup: 'automations' | 'images';
        apiFunction: (url: string, secret: string) => Promise<boolean>;
        successProgress: string;
        successMessage: string;
        errorMessage: string;
        errorLogPrefix: string;
        prompt?: boolean;
    }
) {
    return async function (context: vscode.ExtensionContext, item: AutomationItem | ImageItem) {
        const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
        if (!activeInstance) {
            vscode.window.showErrorMessage('No active GitOps instance');
            return;
        }

        if (commandConfig.prompt) {
            const confirmName = await vscode.window.showInputBox({
                prompt: `Type "${item.name}" to confirm the action`,
                placeHolder: item.name,
                validateInput: (value) => value === item.name ? null : 'Name does not match',
            });
            if (!confirmName || confirmName !== item.name) {
                return;
            }
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: commandConfig.title,
            cancellable: false,
        }, async (progress) => {
            try {
                progress.report({ increment: 25, message: commandConfig.initialProgress });

                const url = urlJoin(activeInstance.url, commandConfig.entityGroup, item.urlSlug(), commandConfig.urlPath).toString();
                outputChannel.appendLine(`${commandConfig.title}: ${item.name} at URL: ${url}`);
                const response = await commandConfig.apiFunction(url, activeInstance.secret);

                if (response) {
                    progress.report({ increment: 100, message: commandConfig.successProgress });
                    vscode.window.showInformationMessage(commandConfig.successMessage);
                } else {
                    vscode.window.showErrorMessage(`${commandConfig.errorMessage} ${item.name}`);
                }
            } catch (error: any) {
                const errorMessage = error.message || 'Unknown error occurred';
                outputChannel.appendLine(`${commandConfig.errorLogPrefix}: ${errorMessage}`);
                vscode.window.showErrorMessage(`${commandConfig.errorMessage}: ${errorMessage}`);
            }
        });
    };
}

export async function showLogsCommand<T extends AutomationItem | ImageItem>(
    context: vscode.ExtensionContext,
    _treeDataProvider: UnifiedImagesViewProvider | OrphanedImagesViewProvider | undefined,
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

        let logsUri: string;
        if (config.entityType === 'image build process') {
            const imageTag = item.name.split('/')[1];
            logsUri = urlJoin(activeInstance.url, "images", imageTag, "logs").toString();
        } else {
            logsUri = urlJoin(activeInstance.url, config.entityType + 's', item.name, "logs").toString();
        }

        const logsResponse = await config.getLogsFunction(logsUri, activeInstance.secret);

        if (!logsResponse) {
            throw new Error('Failed to fetch logs from server');
        }

        const logChannelName = `BitSwan: ${item.name} Logs`;

        let logChannel: vscode.OutputChannel;
        if (outputChannelsMap.has(logChannelName)) {
            outputChannel.appendLine(`Using existing output channel: ${logChannelName}`);
            logChannel = outputChannelsMap.get(logChannelName)!;
            logChannel.clear();
        } else {
            outputChannel.appendLine(`Creating new output channel: ${logChannelName}`);
            logChannel = vscode.window.createOutputChannel(logChannelName);
            outputChannelsMap.set(logChannelName, logChannel);
        }

        logChannel.appendLine('='.repeat(80));
        logChannel.appendLine(`Logs for ${config.entityType}: ${item.name}`);
        logChannel.appendLine(`Fetched at: ${new Date().toISOString()}`);
        logChannel.appendLine('='.repeat(80));
        logChannel.appendLine('');

        if (typeof logsResponse === 'object' && Array.isArray(logsResponse.logs)) {
            logsResponse.logs.forEach((logLine: string) => {
                logChannel.appendLine(logLine);
            });
        } else if (typeof logsResponse === 'string') {
            logChannel.appendLine(logsResponse);
        } else {
            logChannel.appendLine(JSON.stringify(logsResponse, null, 2));
        }

        logChannel.show(true);
        outputChannel.appendLine(`Logs for ${item.name} displayed successfully`);
    } catch (error: any) {
        const errorMessage = error.message || 'Unknown error occurred';
        outputChannel.appendLine(`Error fetching logs: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to fetch logs: ${errorMessage}`);
    }
}

/**
 * Force-refresh an entity list from REST (instead of relying on SSE). Used by
 * explicit "refresh" buttons; SSE keeps the cached state in sync otherwise.
 */
export async function refreshItemsCommand(
    context: vscode.ExtensionContext,
    treeDataProvider: { refresh(): void; refreshAutomations?(): void } | undefined,
    config: {
        entityType: string;
        getItemsFunction: (url: string, secret: string) => Promise<any>;
    },
    options?: RefreshOptions
) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        if (!options?.silent) {
            vscode.window.showErrorMessage('No active GitOps instance');
        }
        return;
    }

    try {
        const items = await config.getItemsFunction(
            urlJoin(activeInstance.url, config.entityType + 's', { trailingSlash: true }).toString(),
            activeInstance.secret,
        );

        if (options?.silent) {
            const current = context.globalState.get(config.entityType + 's', []);
            if (JSON.stringify(current) === JSON.stringify(items)) {
                return;
            }
        }

        await context.globalState.update(config.entityType + 's', items);
    } catch (error: any) {
        if (!options?.silent) {
            vscode.window.showErrorMessage(`Failed to get ${config.entityType}s from GitOps: ${error.message}`);
        }
        return;
    }

    if (treeDataProvider) {
        if (config.entityType === 'automation' && treeDataProvider.refreshAutomations) {
            treeDataProvider.refreshAutomations();
        } else {
            treeDataProvider.refresh();
        }
    }
}
