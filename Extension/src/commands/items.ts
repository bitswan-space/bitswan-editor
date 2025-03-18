import * as vscode from 'vscode';
import * as path from 'path';
import { AutomationsViewProvider} from '../views/automations_view';
import { ImageItem, ImagesViewProvider } from '../views/images_view';
import { AutomationItem } from '../views/automations_view';
import { GitOpsItem } from '../views/workspaces_view';
import { outputChannel } from '../extension';
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
    return async function (context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider | ImagesViewProvider, item: AutomationItem | ImageItem) {
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
                } else if (treeDataProvider instanceof ImagesViewProvider) {
                    var group = "images";
                }

                const url = path.join(activeInstance.url, group, item.urlSlug(), commandConfig.urlPath).toString();
                outputChannel.appendLine(`${commandConfig.title}: ${item.name} at URL: ${url}`);
                const response = await commandConfig.apiFunction(url, activeInstance.secret);
                
                if (response) {
                    progress.report({ increment: 100, message: commandConfig.successProgress });
                    vscode.window.showInformationMessage(commandConfig.successMessage);
                    if (treeDataProvider instanceof AutomationsViewProvider) {
                        refreshAutomationsCommand(context, treeDataProvider);
                    } else if (treeDataProvider instanceof ImagesViewProvider) {
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