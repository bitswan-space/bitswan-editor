import * as vscode from 'vscode';

export class WorkspacesViewProvider implements vscode.TreeDataProvider<GitOpsItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<GitOpsItem | undefined | null | void> = new vscode.EventEmitter<GitOpsItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<GitOpsItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: GitOpsItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: GitOpsItem): Promise<GitOpsItem[]> {
        if (element) {
            return [];
        }

        const instances = this.context.globalState.get<any[]>('gitopsInstances', []);
        const activeInstance = this.context.globalState.get<GitOpsItem>('activeGitOpsInstance');

        return instances.map(instance => {
            const isActive = activeInstance && activeInstance.url === instance.url;
            return new GitOpsItem(
                instance.name,
                instance.url,
                instance.secret,
                isActive
            );
        });
    }
} 

export class GitOpsItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly url: string,
        public readonly secret: string,
        public readonly active: boolean = false
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.name}`;
        this.description = this.active ? '(active)' : '';
        this.contextValue = 'gitops';
        this.iconPath = new vscode.ThemeIcon('cloud');
    }
}