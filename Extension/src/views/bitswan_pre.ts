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

export class NotebookItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly resourceUri: vscode.Uri
  ) {
    super(label, collapsibleState);
    this.tooltip = `${this.label}`;
    this.description = path.extname(this.label);
    this.iconPath = {
      light: path.join(__filename, '..', '..', 'resources', 'light', 'notebook.svg'),
      dark: path.join(__filename, '..', '..', 'resources', 'dark', 'notebook.svg')
    };
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
        new DeploymentItem('Deployments', vscode.TreeItemCollapsibleState.Collapsed)
      ]);
    } else if (element instanceof DeploymentItem) {
      // Deployments section
      return Promise.resolve(this.getNotebooks());
    } else {
      // Leaf nodes (notebooks)
      return Promise.resolve([]);
    }
  }

  private getNotebooks(): NotebookItem[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }
    const cwd = workspaceFolders[0].uri.fsPath;
    const files = fs.readdirSync(cwd);
    return files
      .filter(file => path.extname(file) === '.ipynb')
      .map(file => {
        const filePath = path.join(cwd, file);
        return new NotebookItem(
          file,
          vscode.TreeItemCollapsibleState.None,
          vscode.Uri.file(filePath)
        );
      });
  }
}
