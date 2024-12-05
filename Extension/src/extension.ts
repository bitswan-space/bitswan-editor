import * as vscode from 'vscode';
import * as path from 'path';
import FormData from "form-data"


import { getDeployDetails } from './deploy_details';
import { NotebookTreeDataProvider, NotebookItem, FolderItem } from './views/bitswan_pre';
import { activateDeployment, deploy, zip2stream, zipBsLib, zipDirectory } from './lib';

let outputChannel: vscode.OutputChannel;

async function _deployCommand(notebookItemOrPath: NotebookItem | string | undefined) {
    outputChannel.appendLine(`Deploying notebook: ${notebookItemOrPath}`);
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

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }

    const folderName = path.basename(path.dirname(notebookPath));

    outputChannel.appendLine(`Folder name: ${folderName}`);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deploying notebook",
        cancellable: false
    }, async (progress, token) => {
        try {
            const form = new FormData();
            const normalizedFolderName = folderName.replace(/\//g, '-');
            const deployUrl = new URL(path.join(details.deployUrl, "create", normalizedFolderName));

            outputChannel.appendLine(`Deploy URL: ${deployUrl.toString()}`);

            progress.report({ increment: 0, message: "Packing for deployment..." });

            // Zip the notebook folder and add it to the form
            const zip = await zipDirectory(path.dirname(notebookPath));
            const stream = await zip2stream(zip);
            form.append('file', stream, {
                filename: 'deployment.zip',
                contentType: 'application/zip',
            });

            // Zip bitswan lib folder and add it to the form
            const bzLibZip = await zipBsLib(workspaceFolders[0].uri.fsPath);
            const libStream = await zip2stream(bzLibZip);

            progress.report({ increment: 25, message: "Zipping bitswan lib..." });
            form.append('lib', libStream, {
                filename: 'lib.zip',
                contentType: 'application/zip',
            });

            progress.report({ increment: 50, message: "Uploading to server " + deployUrl.toString() });

            const success = await deploy(deployUrl.toString(), form);

            if (success) {
                progress.report({ increment: 100, message: "Deployment successful" });
                vscode.window.showInformationMessage(`Deployment successful`);
            } else {
                throw new Error(`Deployment failed`);
            }
            progress.report({ increment: 50, message: "Activating deployment..." });

            const activationSuccess = await activateDeployment(path.join(details.deployUrl, "deploy").toString());
            if (activationSuccess) {
                progress.report({ increment: 100, message: `Container deployment successful` });
                vscode.window.showInformationMessage(`Container deployment successful`);
            } else {
                throw new Error(`Container deployment failed`);
            }
        } catch (error: any) {
            let errorMessage: string;
            if (error.response) {
                outputChannel.appendLine(`Error response data: ${JSON.stringify(error.response.data)}`);
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
    // Create and show output channel immediately
    outputChannel = vscode.window.createOutputChannel('BitswanPRE');
    outputChannel.show(true); // true forces the output channel to take focus

    outputChannel.appendLine('=====================================');
    outputChannel.appendLine('BitswanPRE Extension Activation Start');
    outputChannel.appendLine(`Activation Time: ${new Date().toISOString()}`);
    outputChannel.appendLine('=====================================');

    // Add console.log for debugging in Debug Console
    console.log('BitswanPRE Extension Activating - Debug Console Test');

    const notebookTreeDataProvider = new NotebookTreeDataProvider();
    vscode.window.createTreeView('bitswanPRE', {
        treeDataProvider: notebookTreeDataProvider,
        showCollapseAll: true
    });

    vscode.window.registerTreeDataProvider('bitswanPRE', notebookTreeDataProvider);
    let deployCommand = vscode.commands.registerCommand('bitswanPRE.deployNotebook', async (item: NotebookItem | FolderItem) => _deployCommand(item));

    context.subscriptions.push(deployCommand);

    // Refresh the tree view when files change in the workspace
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(() => notebookTreeDataProvider.refresh());
    watcher.onDidDelete(() => notebookTreeDataProvider.refresh());
    watcher.onDidChange(() => notebookTreeDataProvider.refresh());

    context.subscriptions.push(watcher);

    outputChannel.appendLine('Tree view provider registered');
}

export function deactivate() { }
