import * as vscode from 'vscode';

export class ImagesViewProvider implements vscode.TreeDataProvider<ImageItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ImageItem | undefined | null | void> = new vscode.EventEmitter<ImageItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ImageItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ImageItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ImageItem): Promise<ImageItem[]> {
        const activeInstance = this.context.globalState.get<any>('activeGitOpsInstance');
        if (!activeInstance) {
            return [];
        }

        const instances = this.context.globalState.get<any[]>('images', []);

        return instances.map(instance => {
            return new ImageItem(
                instance.tag,
                instance.created,
                instance.size,
            );
        });
    }
} 

export class ImageItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly buildTime: string,
        public readonly size: string,
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.name} ${this.buildTime}`;
        this.contextValue = 'image';
        this.iconPath = new vscode.ThemeIcon('circuit-board');
    }

    public urlSlug(): string {
        // The name is an image like internal/foo:bar the url slug is foo:bar
        return this.name.split('/')[1];
    }
}