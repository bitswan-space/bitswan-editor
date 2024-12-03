import * as vscode from 'vscode';
import * as path from 'path';
import JSZip from 'jszip';
import axios from 'axios';
import FormData from "form-data"
import { Readable } from 'stream';


import { getDeployDetails } from './deploy_details';
import { NotebookTreeDataProvider, NotebookItem, FolderItem } from './views/bitswan_pre';

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

    const folderName = path.basename(path.dirname(notebookPath));

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deploying notebook",
        cancellable: false
    }, async (progress, token) => {
        try {
            const deployUrl = new URL(path.join(details.deployUrl, "create", folderName));

            progress.report({ increment: 0, message: "Packing for deployment..." });
            const zip = new JSZip();
            zip.file('main.ipynb', details.notebookJson);
            if (details.confFile) {
                zip.file('pipelines.conf', details.confFile);
            }

            const zipContents = await zip.generateAsync({ type: 'nodebuffer' });
            const readableStream = new Readable();
            readableStream.push(zipContents);
            readableStream.push(null);

            const form = new FormData();
            form.append('file', readableStream, {
                filename: 'deployment.zip',
                contentType: 'application/zip',
            });

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                const workspacePath = workspaceFolders[0].uri.fsPath;
                const bitswanLibPath = path.join(workspacePath, 'bitswan_lib');
                
                if (await vscode.workspace.fs.stat(vscode.Uri.file(bitswanLibPath)).then(() => true, () => false)) {
                    outputChannel.appendLine(`Found bitswan_lib folder at: ${bitswanLibPath}`);
                    const libZip = new JSZip();
                    
                    const readDir = async (dirPath: string, relativePath: string = '') => {
                        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
                        for (const [name, type] of entries) {
                            const fullPath = path.join(dirPath, name);
                            const zipPath = path.join(relativePath, name);
                            
                            if (type === vscode.FileType.Directory) {
                                await readDir(fullPath, zipPath);
                            } else {
                                const content = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
                                libZip.file(zipPath, content);
                            }
                        }
                    };
                    
                    await readDir(bitswanLibPath);
                    const libZipContents = await libZip.generateAsync({ type: 'nodebuffer' });
                    
                    form.append('lib', new Readable({
                        read() {
                            this.push(libZipContents);
                            this.push(null);
                        }
                    }), {
                        filename: 'lib.zip',
                        contentType: 'application/zip',
                    });
                }
            }

            progress.report({ increment: 50, message: "Uploading to server " + deployUrl.toString() });

            const response = await axios.post(deployUrl.toString(), form, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            outputChannel.appendLine(`Deploy response: ${JSON.stringify(response.data)}`);

            if (response.status === 200) {
                const status = response.data.status;
                progress.report({ increment: 100, message: `Deployment successful: ${status}` });
                vscode.window.showInformationMessage(`Deployment successful`);
            } else {
                throw new Error(`Deployment failed with status ${response.status}`);
            }

            progress.report({ increment: 50, message: "Activating deployment..." });

            const activateUrl = new URL(path.join(details.deployUrl, "deploy"));
            const activationResponse = await axios.get(activateUrl.toString());

            if (activationResponse.status === 200) {
                const status = activationResponse.data.status;
                progress.report({ increment: 100, message: `Container deployment successful: ${status}` });
                vscode.window.showInformationMessage(`Container deployment successful`);
            } else {
                throw new Error(`Container deployment failed with status ${response.status}`);
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

    console.log("activate");

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
