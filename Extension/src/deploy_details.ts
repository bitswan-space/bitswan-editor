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

    // Get environment variables
    const deploySecret = process.env.BITSWAN_DEPLOY_SECRET;
    const deployUrl = process.env.BITSWAN_DEPLOY_URL;

    if (!deploySecret || !deployUrl) {
      vscode.window.showErrorMessage('Please set BITSWAN_DEPLOY_SECRET and BITSWAN_DEPLOY_URL environment variables.');
      return null;
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
