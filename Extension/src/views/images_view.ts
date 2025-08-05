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

        const imageItems = instances.map(instance => {
            return new ImageItem(
                instance.tag,
                instance.created,
                instance.size,
                instance.building || false,
            );
        });

        // Sort images: building images first, then by name
        return imageItems.sort((a, b) => {
            // Building images come first
            if (a.building && !b.building) {
                return -1;
            }
            if (!a.building && b.building) {
                return 1;
            }
            // If both have same building status, sort by name
            return a.name.localeCompare(b.name);
        });
    }
} 

export class ImageItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly buildTime: string | null,
        public readonly size: string,
        public readonly building: boolean = false,
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);
        
        // Handle tooltip and display based on building status
        if (this.building) {
            this.tooltip = `${this.name} (Building...)`;
            this.description = 'Building...';
            this.iconPath = new vscode.ThemeIcon('sync~spin');
        } else {
            this.tooltip = `${this.name} ${this.buildTime || 'Unknown build time'}`;
            this.iconPath = new vscode.ThemeIcon('circuit-board');
        }
        
        this.contextValue = 'image';
    }

    public urlSlug(): string {
        // The name is an image like internal/foo:bar the url slug is foo:bar
        return this.name.split('/')[1];
    }
}