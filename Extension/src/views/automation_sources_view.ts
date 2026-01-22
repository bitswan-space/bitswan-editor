import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BaseSourcesViewProvider, FolderItem } from './sources_view';

export class AutomationSourcesViewProvider extends BaseSourcesViewProvider {
    constructor(context: vscode.ExtensionContext) {
        super(context);
    }

    protected getMarkerFileName(): string {
        // This is still used as a fallback, but we override getFoldersWithMarker
        return 'pipelines.conf';
    }

    /**
     * Returns the list of marker files to detect automations.
     * Priority: automation.toml (new format) > pipelines.conf (legacy format)
     */
    protected getMarkerFileNames(): string[] {
        return ['automation.toml', 'pipelines.conf'];
    }

    /**
     * Override to check for multiple marker files.
     * A folder is considered an automation if it contains either
     * automation.toml or pipelines.conf.
     */
    protected getFoldersWithMarker(folderPath: string): FolderItem[] {
        let results: FolderItem[] = [];

        // Read all entries in current directory
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });

        // If the current directory contains a file named .bitswan-ignore, skip it
        if (entries.some(entry => entry.isFile() && entry.name === '.bitswan-ignore')) {
            return results;
        }

        // Check if current directory has any of the marker files
        const markerFiles = this.getMarkerFileNames();
        const hasMarker = markerFiles.some(marker =>
            fs.existsSync(path.join(folderPath, marker))
        );

        if (hasMarker) {
            // Only add if it's not the workspace root
            if (folderPath !== vscode.workspace.workspaceFolders![0].uri.fsPath) {
                const relativePath = path.relative(vscode.workspace.workspaceFolders![0].uri.fsPath, folderPath);
                results.push(new FolderItem(
                    relativePath,
                    vscode.Uri.file(folderPath)
                ));
            }
        }

        // Recursively check subdirectories
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const fullPath = path.join(folderPath, entry.name);
                results = results.concat(this.getFoldersWithMarker(fullPath));
            }
        }

        return results;
    }
}
