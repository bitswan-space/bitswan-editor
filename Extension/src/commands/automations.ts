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

export async function refreshAutomationsCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationsViewProvider) {
    return refreshItemsCommand(context, treeDataProvider, {
        entityType: 'automation',
        getItemsFunction: getAutomations
    });
}
