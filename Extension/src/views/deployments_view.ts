import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class DeploymentsViewProvider implements vscode.TreeDataProvider<FolderItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<FolderItem | undefined | null | void> = new vscode.EventEmitter<FolderItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<FolderItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

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
            // Root level - show folders that contain pipelines.conf
            return Promise.resolve(this.getFoldersWithPipelines(workspacePath));
        }

        return Promise.resolve([]);
    }

    private getFoldersWithPipelines(folderPath: string): FolderItem[] {
        let results: FolderItem[] = [];
        
        // Read all entries in current directory
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        
        // Check if current directory has pipelines.conf
        if (fs.existsSync(path.join(folderPath, 'pipelines.conf'))) {

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
                results = results.concat(this.getFoldersWithPipelines(fullPath));
            }
        }

        return results;
    }
} 

/**
 * Class for creation of folder/section within extension
 */
export class DeploymentItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly contextValue: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.contextValue = contextValue;
    }
}

/**
 * Representation of folder.
 */
export class FolderItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly resourceUri: vscode.Uri
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.label}`;
        this.description = path.extname(this.label);
        this.contextValue = 'folder';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}