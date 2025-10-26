import * as vscode from 'vscode';
import { AutomationItem } from '../views/automations_view';
import { getAutomationLogs, getAutomations } from '../lib';
import { AutomationsViewProvider } from '../views/automations_view';
import { showLogsCommand, refreshItemsCommand } from './items';

export async function showAutomationLogsCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider, item: AutomationItem) {
    return showLogsCommand(context, treeDataProvider, item, {
        entityType: 'automation',
        getLogsFunction: getAutomationLogs
    });
}

export async function refreshAutomationsCommand(context: vscode.ExtensionContext, treeDataProvider: { refresh(): void }) {
    return refreshItemsCommand(context, treeDataProvider, {
        entityType: 'automation',
        getItemsFunction: getAutomations
    });
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