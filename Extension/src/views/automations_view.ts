import * as vscode from 'vscode';

/**
 * Plain data carrier for a deployed automation, used by command handlers as
 * a typed payload (no longer rendered in a tree view). It still extends
 * `vscode.TreeItem` so callers that do `instanceof AutomationItem` keep
 * working — the tree-item bits are unused.
 */
export class AutomationItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly state: string,
        public readonly status: string,
        public readonly deploymentId: string,
        public readonly active: boolean = false,
        public readonly automationUrl: string,
        public readonly relativePath: string
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);
    }

    public urlSlug(): string {
        return this.name;
    }
}
