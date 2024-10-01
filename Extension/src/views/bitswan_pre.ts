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
            // Deployments section - show folders
            return Promise.resolve(this.getFolders());
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
        const folders = fs.readdirSync(cwd, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory() && fs.existsSync(path.join(cwd, dirent.name, 'main.ipynb')))
            .map(dirent => new FolderItem(
                dirent.name,
                vscode.TreeItemCollapsibleState.Collapsed,
                vscode.Uri.file(path.join(cwd, dirent.name))
            ));

        return folders;
    }


    private getNotebooksInFolder(folderPath: string): NotebookItem[] {
        const notebookPath = path.join(folderPath, 'main.ipynb');
        if (fs.existsSync(notebookPath)) {
            return [new NotebookItem('main.ipynb', vscode.Uri.file(notebookPath))];
        }
        return [];
    }
}
