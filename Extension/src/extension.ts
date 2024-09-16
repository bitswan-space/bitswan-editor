import * as vscode from 'vscode';
import * as path from 'path';
import JSZip from 'jszip';
import axios from 'axios';

import { getDeployDetails } from './deploy_details';
import { BitswanPREViewProvider } from './views/bitswan_pre';

async function _deployCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || path.extname(editor.document.fileName) !== '.ipynb') {
        vscode.window.showErrorMessage('Please open a Jupyter notebook before deploying.');
        return;
    }

    const notebookPath = editor.document.uri.fsPath;
    const details = await getDeployDetails(notebookPath);
    if (!details) {
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deploying notebook",
        cancellable: false
    }, async (progress, token) => {
        try {
            const deployUrl = new URL(path.join(details.deployUrl, "__jupyter-deploy-pipeline/"));
            deployUrl.searchParams.append("secret", details.deploySecret);
            deployUrl.searchParams.append("restart", "true");

            progress.report({ increment: 0, message: "Packing for deployment..." });
            const zip = new JSZip();
            zip.file('main.ipynb', details.notebookJson);
            const zipContents = await zip.generateAsync({ type: 'nodebuffer' });

            progress.report({ increment: 50, message: "Uploading to server..." });
            const response = await axios.post(deployUrl.toString(), zipContents, {
                headers: { 'Content-Type': 'application/zip' },
            });

            if (response.status === 200) {
                const status = response.data.status;
                progress.report({ increment: 100, message: `Deployment successful: ${status}` });
                vscode.window.showInformationMessage(`Deployment status: ${status}`);
            } else {
                throw new Error(`Deployment failed with status ${response.status}`);
            }
        } catch (error: any) {
            let errorMessage: string;
            if (error.response) {
                errorMessage = `Server responded with status ${error.response.status}`;
            } else if (error.request) {
                errorMessage = 'No response received from server';
            } else {
                errorMessage = error.message;
            }
            vscode.window.showErrorMessage(`Deployment error: ${errorMessage}`);
            throw error; // Re-throw to ensure the progress notification closes
        }
    });
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new BitswanPREViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(BitswanPREViewProvider.viewType, provider)
    );

    let deployCommand = vscode.commands.registerCommand('extension.deployCurrentNotebook', _deployCommand);

    context.subscriptions.push(deployCommand);

    // Listen for changes in the active text editor
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
        provider.updateView();
    }));

    // Listen for changes in text document
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
            provider.updateView();
        }
    }));

    // Listen for changes in the opened editors
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
        provider.updateView();
    }));
}



export function deactivate() { }
