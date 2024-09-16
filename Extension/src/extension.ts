import * as vscode from 'vscode';
import * as path from 'path';
import JSZip from 'jszip';
import axios from 'axios';

import { getDeployDetails } from './deploy_details';
import { BitswanPREViewProvider } from './views/bitswan_pre';

export function activate(context: vscode.ExtensionContext) {
    const provider = new BitswanPREViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(BitswanPREViewProvider.viewType, provider)
    );

    let deployCommand = vscode.commands.registerCommand('extension.deployCurrentNotebook', async () => {
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

        try {
            const deployUrl = new URL(path.join(details.deployUrl, "__jupyter-deploy-pipeline/"));
            deployUrl.searchParams.append("secret", details.deploySecret);
            deployUrl.searchParams.append("restart", "true");

            vscode.window.showInformationMessage('Packing for deployment...');

            const zip = new JSZip();
            zip.file('main.ipynb', details.notebookJson);
            const zipContents = await zip.generateAsync({ type: 'nodebuffer' });

            vscode.window.showInformationMessage('Uploading to server...');

            const response = await axios.post(deployUrl.toString(), zipContents, {
                headers: { 'Content-Type': 'application/zip' },
            });

            if (response.status === 200) {
                const status = response.data.status;
                vscode.window.showInformationMessage(`Deployment status: ${status}`);
            } else {
                vscode.window.showErrorMessage('Deployment failed. Please try again.');
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Deployment error: ${error.message}`);
        }
    });

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
