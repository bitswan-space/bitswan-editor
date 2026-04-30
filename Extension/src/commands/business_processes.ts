import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export async function openDevelopmentGuideCommand(context: vscode.ExtensionContext) {
    try {
        const guidePath = path.join(context.extensionPath, 'DEVELOPMENT_GUIDE.md');
        if (!fs.existsSync(guidePath)) {
            vscode.window.showErrorMessage(`Development Guide not found at: ${guidePath}`);
            return;
        }
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(guidePath));
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to open Development Guide: ${error}`);
    }
}
