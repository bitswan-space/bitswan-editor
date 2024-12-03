import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class DeploymentItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.contextValue = 'deployment';
    }
}

export class FolderItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly resourceUri: vscode.Uri
    ) {
        super(label, collapsibleState);
        this.contextValue = 'folder';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

export class NotebookItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly resourceUri: vscode.Uri
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.label}`;
        this.description = path.extname(this.label);
        this.iconPath = new vscode.ThemeIcon('notebook');
        this.contextValue = 'notebook';
    }
}

export class NotebookTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private outputChannel = vscode.window.createOutputChannel('BITSWAN');

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (!element) {
            // Root level
            return Promise.resolve([
                new DeploymentItem('Deployments', vscode.TreeItemCollapsibleState.Expanded)
            ]);
        } else if (element instanceof DeploymentItem) {
            const folders = this.getFolders();
            return Promise.resolve(folders);
        } else if (element instanceof FolderItem) {
            // Folder - show notebooks
            return Promise.resolve(this.getNotebooksInFolder(element.resourceUri.fsPath));
        } else {
            // Leaf nodes (notebooks)
            return Promise.resolve([]);
        }
    }

    private getFolders(): FolderItem[] {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return [];
        }
        const cwd = workspaceFolders[0].uri.fsPath;
        return this.findFoldersRecursively(cwd);
    }

    private findFoldersRecursively(dirPath: string): FolderItem[] {
        let results: FolderItem[] = [];
        
        // Read all entries in current directory
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        // Check if current directory has main.ipynb
        if (fs.existsSync(path.join(dirPath, 'main.ipynb'))) {
            // Only add if it's not the workspace root
            if (dirPath !== vscode.workspace.workspaceFolders![0].uri.fsPath) {
                const relativePath = path.relative(vscode.workspace.workspaceFolders![0].uri.fsPath, dirPath);
                results.push(new FolderItem(
                    relativePath,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    vscode.Uri.file(dirPath)
                ));
            }
        }

        // Recursively check subdirectories
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const fullPath = path.join(dirPath, entry.name);
                results = results.concat(this.findFoldersRecursively(fullPath));
            }
        }

        return results;
    }

    private getNotebooksInFolder(folderPath: string): NotebookItem[] {
        const notebookPath = path.join(folderPath, 'main.ipynb');
        if (fs.existsSync(notebookPath)) {
            return [new NotebookItem('main.ipynb', vscode.Uri.file(notebookPath))];
        }
        return [];
    }
}
