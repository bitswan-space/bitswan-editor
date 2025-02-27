import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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

export class GitOpsItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly url: string,
        public readonly secret: string,
        public readonly active: boolean = false
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.label}`;
        this.description = this.active ? '(active)' : '';
        this.contextValue = 'gitops';
        this.iconPath = new vscode.ThemeIcon('cloud');
    }
}

/**
 * This class is responsible for creation of folder browser within the bitswan extension.
 * It contains function refresh, getTreeItem, getChildren, which are called by VSC.
*/
export class DirectoryTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        // switch based on element
        if (!element) {
            // Root level
            return Promise.resolve([
                new DeploymentItem('Deployments', 'deployment', vscode.TreeItemCollapsibleState.Expanded),
                new DeploymentItem('Gitopses', 'gitopsSection', vscode.TreeItemCollapsibleState.Expanded)
            ]);
        } else if (element instanceof DeploymentItem) {
            // Search folder
            if (element.label === 'Deployments') {
                const folders = this.getFolders();
                return Promise.resolve(folders);
            } else if (element.label === 'Gitopses') {
                const gitopses = this.getGitOpses();
                return Promise.resolve(gitopses);
            }
        } 
        return Promise.resolve([]);
    }

    // This function initiates recursive searching of directories
    private getFolders(): FolderItem[] {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return [];
        }
        const cwd = workspaceFolders[0].uri.fsPath;
        return this.findFoldersRecursively(cwd);
    }

    private getGitOpses(): GitOpsItem[] {
        const gitopsConfig = this.context.globalState.get<any[]>('gitopsInstances', []);
        const activeInstance = this.context.globalState.get<GitOpsItem>('activeGitOpsInstance');
        
        return gitopsConfig.map(instance => 
            new GitOpsItem(instance.name, instance.url, instance.secret, activeInstance && instance.url === activeInstance.url)
        );
    }

    /**
     * Function which recursively searches folder tree.
     * It returns paths of directories which contain pipelines.conf
     */
    private findFoldersRecursively(dirPath: string): FolderItem[] {
        let results: FolderItem[] = [];
        
        // Read all entries in current directory
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        // Check if current directory has pipelines.conf
        if (fs.existsSync(path.join(dirPath, 'pipelines.conf'))) {

            // Only add if it's not the workspace root
            if (dirPath !== vscode.workspace.workspaceFolders![0].uri.fsPath) {
                const relativePath = path.relative(vscode.workspace.workspaceFolders![0].uri.fsPath, dirPath);
                results.push(new FolderItem(
                    relativePath,
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
}
