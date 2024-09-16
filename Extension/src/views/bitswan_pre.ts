import * as vscode from 'vscode';
import * as path from 'path';

export class BitswanPREViewProvider implements vscode.WebviewViewProvider {
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
