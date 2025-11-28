import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { UnifiedBusinessProcessesViewProvider } from '../views/unified_business_processes_view';

export async function refreshBusinessProcessesCommand(context: vscode.ExtensionContext, treeDataProvider: UnifiedBusinessProcessesViewProvider) {
    console.log('[DEBUG] refreshBusinessProcessesCommand function called');
    // For business processes, we just need to refresh the tree data provider
    // since business processes are determined by the file system structure
    treeDataProvider.refresh();
    console.log('[DEBUG] refreshBusinessProcessesCommand completed');
}

export async function openDevelopmentGuideCommand(context: vscode.ExtensionContext) {
    try {
        // Get the extension path
        const extensionPath = context.extensionPath;
        const guidePath = path.join(extensionPath, 'DEVELOPMENT_GUIDE.md');
        
        // Check if file exists
        if (!fs.existsSync(guidePath)) {
            vscode.window.showErrorMessage(`Development Guide not found at: ${guidePath}`);
            return;
        }
        
        // Create URI for the file
        const uri = vscode.Uri.file(guidePath);
        
        // Open the file as a rendered markdown preview (read-only)
        await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to open Development Guide: ${error}`);
    }
}
