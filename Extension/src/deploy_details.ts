import * as vscode from 'vscode';
import * as fs from 'fs';

export interface DeployDetails {
  notebookJson: string;
  deploySecret: string;
  deployUrl: string;
}

export async function getDeployDetails(notebookPath: string): Promise<DeployDetails | null> {
  try {
    const notebookContents = await fs.promises.readFile(notebookPath, 'utf8');
    const notebookJson = JSON.parse(notebookContents);

    let deploySecret = process.env.BITSWAN_DEPLOY_SECRET;
    let deployUrl = process.env.BITSWAN_DEPLOY_URL;

    if (!deployUrl) {
      deployUrl = await vscode.window.showInputBox({
        prompt: 'Please enter your BITSWAN_DEPLOY_URL',
        ignoreFocusOut: true
      });
      if (!deployUrl) {
        vscode.window.showErrorMessage('BITSWAN_DEPLOY_URL is required for deployment.');
        return null;
      }
    }

    if (!deploySecret) {
      deploySecret = await vscode.window.showInputBox({
        prompt: 'Please enter your BITSWAN_DEPLOY_SECRET',
        password: true,
        ignoreFocusOut: true
      });
      if (!deploySecret) {
        vscode.window.showErrorMessage('BITSWAN_DEPLOY_SECRET is required for deployment.');
        return null;
      }
    }

    return {
      notebookJson: JSON.stringify(notebookJson, null, 2),
      deploySecret,
      deployUrl
    };
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error reading notebook: ${error.message}`);
    return null;
  }
}
