import * as vscode from 'vscode';

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  }

  public showDeploymentProgress(message: string) {
    this.statusBarItem.text = `$(sync~spin) ${message}`;
    this.statusBarItem.show();
  }

  public showDeploymentSuccess() {
    this.statusBarItem.text = `$(check) Deployment successful`;
    this.statusBarItem.show();
    setTimeout(() => this.statusBarItem.hide(), 5000);
  }

  public showDeploymentFailure() {
    this.statusBarItem.text = `$(error) Deployment failed`;
    this.statusBarItem.show();
    setTimeout(() => this.statusBarItem.hide(), 5000);
  }
}
