import * as vscode from 'vscode';
import { GitOpsItem } from './views/workspaces_view';

/**
 * This is a return interface which is given as a result of getDeployDetails function below.
 */
export interface DeployDetails {
  deploySecret: string;
  deployUrl: string;
}

/**
 * This function checks for deploySecret and deployUrl.
 * Function returns deploySecret and deployUrl.
 */
export async function getDeployDetails(context: vscode.ExtensionContext): Promise<DeployDetails | null> {
  try {
    // get active gitops instance from global state
    const activeGitOpsInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance')

    var deploySecret;
    var deployUrl
    if (activeGitOpsInstance) {
      deploySecret = activeGitOpsInstance.secret;
      deployUrl = activeGitOpsInstance.url;
    }
    else if (process.env.BITSWAN_DEPLOY_SECRET && process.env.BITSWAN_DEPLOY_URL) {
      deploySecret = process.env.BITSWAN_DEPLOY_SECRET;
      deployUrl = process.env.BITSWAN_DEPLOY_URL;
    }

    // ask for deploy url in case there is none defined
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

    // ask for deploy secret in case there is none defined
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
      deploySecret,
      deployUrl,
    };

  } catch (error: any) {
    vscode.window.showErrorMessage(`Error reading pipeline config: ${error.message}`);
    return null;
  }
}
