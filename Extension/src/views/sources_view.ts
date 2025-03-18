import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Representation of folder.
 */
export class FolderItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly resourceUri: vscode.Uri
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.name}`;
        this.description = path.extname(this.name);
        this.contextValue = 'folder';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

export abstract class BaseSourcesViewProvider implements vscode.TreeDataProvider<FolderItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<FolderItem | undefined | null | void> = new vscode.EventEmitter<FolderItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<FolderItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(protected context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: FolderItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: FolderItem): Promise<FolderItem[]> {
        if (!vscode.workspace.workspaceFolders) {
            return Promise.resolve([]);
        }

        const workspacePath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath);

        if (!element) {
            // Root level - show folders that contain the marker file
            return Promise.resolve(this.getFoldersWithMarker(workspacePath));
        }

        return Promise.resolve([]);
    }

    protected abstract getMarkerFileName(): string;

    protected getFoldersWithMarker(folderPath: string): FolderItem[] {
        let results: FolderItem[] = [];

        // Read all entries in current directory
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });

        // If the current directory contains a file named .bitswan-ignore, skip it
        if (entries.some(entry => entry.isFile() && entry.name === '.bitswan-ignore')) {
            return results;
        }

        // Check if current directory has the marker file
        if (fs.existsSync(path.join(folderPath, this.getMarkerFileName()))) {
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
