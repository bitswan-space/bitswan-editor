import * as vscode from 'vscode';
import * as path from 'path';
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

export async function jumpToSourceCommand(context: vscode.ExtensionContext, automationItem: AutomationItem) {
    if (automationItem.relativePath) {
        let targetPath = automationItem.relativePath;

        // If the path is relative, resolve it against the workspace root
        if (!path.isAbsolute(targetPath)) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                targetPath = path.join(workspaceFolders[0].uri.fsPath, targetPath);
            }
        }
        
        const uri = vscode.Uri.file(targetPath);
        try {
            await vscode.commands.executeCommand('revealInExplorer', uri);
            return;
        } catch (error) {
            vscode.window.showErrorMessage(`Could not reveal folder in Explorer`);
            return;
        }
    }
}