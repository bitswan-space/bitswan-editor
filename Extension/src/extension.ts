import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import axios from 'axios';

interface DeployDetails {
    notebookJson: string;
    deploySecret: string;
    deployUrl: string;
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new DeploymentViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DeploymentViewProvider.viewType, provider)
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

async function getDeployDetails(notebookPath: string): Promise<DeployDetails | null> {
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


class DeploymentViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'bitswanPRE';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        this.updateView();

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'deployNotebook':
                    vscode.commands.executeCommand('extension.deployCurrentNotebook');
                    break;
            }
        });
    }

    public updateView() {
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview(this._view.webview);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

        const currentNotebook = this._getCurrentNotebookName();
        const buttonText = currentNotebook ? `Deploy ${currentNotebook}` : 'Open Jupyter to deploy';
        const isDisabled = !currentNotebook;

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleResetUri}" rel="stylesheet">
                <link href="${styleVSCodeUri}" rel="stylesheet">
                <link href="${styleMainUri}" rel="stylesheet">
                <title>Deploy Notebook</title>
            </head>
            <body>
                <button id="deployButton" class="deploy-button" ${isDisabled ? 'disabled' : ''}>${buttonText}</button>
                <script>
                    const vscode = acquireVsCodeApi();
                    const deployButton = document.getElementById('deployButton');
                    deployButton.addEventListener('click', () => {
                        if (!deployButton.hasAttribute('disabled')) {
                            vscode.postMessage({ type: 'deployNotebook' });
                        }
                    });
                </script>
            </body>
            </html>`;
    }

    private _getCurrentNotebookName(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        if (editor && path.extname(editor.document.fileName) === '.ipynb') {
            return path.basename(editor.document.fileName);
        }
        return undefined;
    }
}

export function deactivate() { }
