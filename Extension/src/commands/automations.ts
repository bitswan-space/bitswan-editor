import * as vscode from 'vscode';
import { AutomationItem } from '../views/automations_view';
import { getAutomations } from '../lib';
import { AutomationsViewProvider } from '../views/automations_view';
import { refreshItemsCommand, RefreshOptions } from './items';
import { GitOpsItem } from '../views/workspaces_view';
import { LogViewerPanel, StageInfo } from './log_viewer';
export interface StageContext {
    baseSourceName: string;
    currentStage: string;
    stages: StageInfo[];
}

export async function showAutomationLogsCommand(
    context: vscode.ExtensionContext,
    _treeDataProvider: AutomationsViewProvider,
    item: AutomationItem,
    stageContext?: StageContext
) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    if (stageContext) {
        LogViewerPanel.open(
            stageContext.baseSourceName,
            item.name,
            stageContext.currentStage,
            stageContext.stages,
            activeInstance.url,
            activeInstance.secret,
        );
    } else {
        // Legacy path: single automation, no stage switching
        LogViewerPanel.open(
            item.name,
            item.name,
            '',
            [],
            activeInstance.url,
            activeInstance.secret,
        );
    }
}

export async function refreshAutomationsCommand(context: vscode.ExtensionContext, treeDataProvider: { refresh(): void; refreshAutomations?(): void }, options?: RefreshOptions) {
    return refreshItemsCommand(context, treeDataProvider, {
        entityType: 'automation',
        getItemsFunction: getAutomations
    }, options);
}

export async function jumpToSourceCommand(context: vscode.ExtensionContext, item: any) {
    // For AutomationSourceItem, use the resourceUri directly
    if (item.resourceUri) {
        try {
            await vscode.commands.executeCommand('revealInExplorer', item.resourceUri);
            return;
        } catch (error) {
            vscode.window.showErrorMessage(`Could not reveal folder in Explorer`);
            return;
        }
    }
}