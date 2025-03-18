import * as vscode from 'vscode';

export class AutomationsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const activeInstance = this.context.globalState.get<any>('activeGitOpsInstance');
        if (!activeInstance) {
            return [];
        }

        if (element instanceof StatusCategory) {
            return element.items;
        }

        const automations = this.context.globalState.get<any[]>('automations', []);
        const automationItems = automations.map(automation => 
            new AutomationItem(
                automation.name,
                automation.state,
                automation.status,
                automation.deploymentId,
                automation.active
            )
        );

        const statusMap: { [key: string]: AutomationItem[] } = {};
        automationItems.forEach(automation => {
            const status = automation.active ? 'Active' : 'Inactive';
            if (!statusMap[status]) {
                statusMap[status] = [];
            }
            statusMap[status].push(automation);
        });

        return Object.keys(statusMap).map(status => 
            new StatusCategory(status, statusMap[status])
        );
    }
} 

export class AutomationItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly state: string,
        public readonly status: string,
        public readonly deploymentId: string,
        public readonly active: boolean = false
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.name}`;
        this.description = `${this.status ?? ''}`;
        this.contextValue = this.getContextValue();
        this.iconPath = this.statusIcon(state);
    }

    public urlSlug(): string {
        return this.name
    }

    private getContextValue(): string {
        const status = this.active ? 'active' : 'inactive';
        return `automation,${status},${this.state ?? 'exited'}`;
    }

    private statusIcon(status?: string): vscode.ThemeIcon {
        switch (status) {
            // created - gray filled circle
            case 'created': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.gray'));
            // running - green filled circle
            case 'running': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.green'));
            case 'paused': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.orange'));
            case 'restarting': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.orange'));
            case 'exited': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.red'));
            case 'removing': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.red'));
            case 'dead': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.red'));
            default: return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.red'));
        }
    }
}

export class StatusCategory extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly items: AutomationItem[],
    ) {
        super(name, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'statusCategory';
    }
}