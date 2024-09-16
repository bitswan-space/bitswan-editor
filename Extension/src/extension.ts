import * as vscode from 'vscode';
import * as path from 'path';
import JSZip from 'jszip';
import axios from 'axios';

import { getDeployDetails } from './deploy_details';
import { NotebookTreeDataProvider, NotebookItem, FolderItem } from './views/bitswan_pre';

async function _deployCommand(notebookItemOrPath: NotebookItem | string | undefined) {
    let notebookPath: string | undefined;

    if (notebookItemOrPath instanceof NotebookItem) {
        notebookPath = notebookItemOrPath.resourceUri.fsPath;
    } else if (typeof notebookItemOrPath === 'string') {
        notebookPath = notebookItemOrPath;
    } else {
        let editor = vscode.window.activeTextEditor;
        if (editor && path.extname(editor.document.fileName) === '.ipynb') {
            notebookPath = editor.document.uri.fsPath;
        }
    }

    if (!notebookPath) {
        vscode.window.showErrorMessage('Unable to determine notebook path. Please select a notebook from the tree view or open one in the editor.');
        return;
    }

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
                vscode.window.showInformationMessage(`Deployment successful`);
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
            return;
        }
    });
}

export function activate(context: vscode.ExtensionContext) {
    const notebookTreeDataProvider = new NotebookTreeDataProvider();
    vscode.window.createTreeView('bitswanPRE', {
        treeDataProvider: notebookTreeDataProvider,
        showCollapseAll: true
    });

    vscode.window.registerTreeDataProvider('bitswanPRE', notebookTreeDataProvider);
    let deployCommand = vscode.commands.registerCommand('bitswanPRE.deployNotebook', async (item: NotebookItem | FolderItem) => _deployCommand(item));

    context.subscriptions.push(deployCommand);

    // Refresh the tree view when files change in the workspace
    const watcher = vscode.workspace.createFileSystemWatcher('**/main.ipynb');
    watcher.onDidCreate(() => notebookTreeDataProvider.refresh());
    watcher.onDidDelete(() => notebookTreeDataProvider.refresh());
    watcher.onDidChange(() => notebookTreeDataProvider.refresh());

    context.subscriptions.push(watcher);
}

export function deactivate() { }
