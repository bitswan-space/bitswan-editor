import * as vscode from 'vscode';
import * as path from 'path';
import FormData from "form-data"
import JSZip from 'jszip';
import fs from 'fs';


import { getDeployDetails } from './deploy_details';
import {DirectoryTreeDataProvider, FolderItem, GitOpsItem} from './views/bitswan_pre';
import { activateDeployment, deploy, zip2stream, zipDirectory } from './lib';

// Defining logging channel
export let outputChannel: vscode.OutputChannel;

/**
 * This is Deploy Command which is registered as a Visual Studio code command
 */
async function _deployCommand(context: vscode.ExtensionContext, folderItemOrPath: FolderItem | string | undefined) {
    outputChannel.appendLine(`Deploying pipeline: ${folderItemOrPath}`);
    let pipelineConfPath: string | undefined;

    // create folder path out of provided argument. Its either folder, folder's path or it is not defined
    if (folderItemOrPath instanceof FolderItem) {
        const pipelinePathExists = path.join(folderItemOrPath.resourceUri.fsPath, 'pipelines.conf');
        if (fs.existsSync(pipelinePathExists)) {
            pipelineConfPath = path.join(folderItemOrPath.resourceUri.fsPath, 'pipelines.conf');
        }
    } else if (typeof folderItemOrPath === 'string') {
        pipelineConfPath = folderItemOrPath;
    } else {
        let editor = vscode.window.activeTextEditor;
        if (editor && path.extname(editor.document.fileName) === '.conf') {
            pipelineConfPath = editor.document.uri.fsPath;
        }
    }

    if (!pipelineConfPath) {
        vscode.window.showErrorMessage('Unable to determine pipeline config path. Please select a pipeline config from the tree view or open one in the editor.');
        return;
    }

    // get deployURL and deploySecret
    const details = await getDeployDetails(context);
    if (!details) {
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }

    const folderName = path.basename(path.dirname(pipelineConfPath));

    outputChannel.appendLine(`Folder name: ${folderName}`);

    // deployment of pipeline
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deploying pipeline",
        cancellable: false
    }, async (progress, _token) => {
        try {
            const form = new FormData();
            const normalizedFolderName = folderName.replace(/\//g, '-');
            const deployUrl = new URL(path.join(details.deployUrl, "create", normalizedFolderName));

            outputChannel.appendLine(`Deploy URL: ${deployUrl.toString()}`);

            progress.report({ increment: 0, message: "Packing for deployment..." });

            // Zip the pipeline config folder and add it to the form
            let zip = await zipDirectory(path.dirname(pipelineConfPath!), '', JSZip(), outputChannel);
            const workspacePath = path.join(workspaceFolders[0].uri.fsPath, 'workspace')
            const bitswanLibPath = path.join(workspacePath, 'bitswan_lib')
            if (fs.existsSync(bitswanLibPath)) {
                zip = await zipDirectory(bitswanLibPath, '', zip, outputChannel);
                outputChannel.appendLine(`bitswan_lib found at ${bitswanLibPath}`);
            } else {
                outputChannel.appendLine(`Error. bitswan_lib not found at ${bitswanLibPath}`);
            }
            const stream = await zip2stream(zip);
            form.append('file', stream, {
                filename: 'deployment.zip',
                contentType: 'application/zip',
            });

            progress.report({ increment: 50, message: "Uploading to server " + deployUrl.toString() });

            const success = await deploy(deployUrl.toString(), form, details.deploySecret);

            if (success) {
                progress.report({ increment: 100, message: "Deployment successful" });
                vscode.window.showInformationMessage(`Deployment successful`);
            } else {
                throw new Error(`Deployment failed`);
            }
            progress.report({ increment: 50, message: "Activating deployment..." });

            const activationSuccess = await activateDeployment(path.join(details.deployUrl, "deploy").toString(), details.deploySecret);
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

async function _addGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider) {
    const name = await vscode.window.showInputBox({
        prompt: 'Enter GitOps instance name',
        placeHolder: 'e.g., Production GitOps',
        ignoreFocusOut: true
    });
    if (!name) return;

    const url = await vscode.window.showInputBox({
        prompt: 'Enter GitOps URL',
        placeHolder: 'https://gitops.example.com',
        ignoreFocusOut: true
    });
    if (!url) return;

    const secret = await vscode.window.showInputBox({
        prompt: 'Enter GitOps secret token',
        password: true,
        ignoreFocusOut: true
    });
    if (!secret) return;

    const instances = context.globalState.get<any[]>('gitopsInstances', []);
    instances.push({ name, url, secret });
    await context.globalState.update('gitopsInstances', instances);
    treeDataProvider.refresh();
}

async function _editGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: GitOpsItem) {
    const instances = context.globalState.get<any[]>('gitopsInstances', []);
    const index = instances.findIndex(i => i.name === item.label);
    if (index === -1) return;

    const url = await vscode.window.showInputBox({
        prompt: 'Enter new GitOps URL',
        value: item.url,
        ignoreFocusOut: true
    });
    if (!url) return;

    const secret = await vscode.window.showInputBox({
        prompt: 'Enter new GitOps secret token',
        password: true,
        ignoreFocusOut: true
    });
    if (!secret) return;

    instances[index] = { ...instances[index], url, secret };
    await context.globalState.update('gitopsInstances', instances);
    // Clear active instance if it was edited
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (activeInstance && activeInstance.url === item.url) {
        await context.globalState.update('activeGitOpsInstance', instances[index]);
    }
    treeDataProvider.refresh();
}

async function _deleteGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: GitOpsItem) {
    const instances = context.globalState.get<any[]>('gitopsInstances', []);
    await context.globalState.update('gitopsInstances', 
        instances.filter(i => i.name !== item.label)
    );
    // Clear active instance if it was deleted
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (activeInstance && activeInstance.url === item.url) {
        await context.globalState.update('activeGitOpsInstance', undefined
        );
    }
    treeDataProvider.refresh();
}

async function _activateGitOpsCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, item: GitOpsItem) {
    await context.globalState.update('activeGitOpsInstance', item);
    treeDataProvider.refresh();
}

/**
 * This method is called by VSC when extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {

    // Create and show output channel immediately
    outputChannel = vscode.window.createOutputChannel('BitSwan');
    outputChannel.show(true); // true forces the output channel to take focus

    outputChannel.appendLine('=====================================');
    outputChannel.appendLine('BitSwan Extension Activation Start');
    outputChannel.appendLine(`Activation Time: ${new Date().toISOString()}`);
    outputChannel.appendLine('=====================================');

    // Add console.log for debugging in Debug Console
    console.log('BitSwan Extension Activating - Debug Console Test');

    // Create sidebar tree for browsing deployments
    const directoryTreeDataProvider = new DirectoryTreeDataProvider(context);
    vscode.window.createTreeView('bitswan', {
        treeDataProvider: directoryTreeDataProvider,
        showCollapseAll: true
    });



    vscode.window.registerTreeDataProvider('bitswan', directoryTreeDataProvider);
    // bind deployment to a command
    let deployCommand = vscode.commands.registerCommand('bitswan.deployPipeline', async (item: FolderItem) => _deployCommand(context, item));
    let addGitOpsCommand = vscode.commands.registerCommand('bitswan.addGitOps', async () => _addGitOpsCommand(context, directoryTreeDataProvider));
    let editGitOpsCommand = vscode.commands.registerCommand('bitswan.editGitOps', async (item: GitOpsItem) => _editGitOpsCommand(context, directoryTreeDataProvider, item));
    let deleteGitOpsCommand = vscode.commands.registerCommand('bitswan.deleteGitOps', async (item: GitOpsItem) => _deleteGitOpsCommand(context, directoryTreeDataProvider, item));
    let activateGitOpsCommand = vscode.commands.registerCommand('bitswan.activateGitOps', async (item: GitOpsItem) => _activateGitOpsCommand(context, directoryTreeDataProvider, item));

    context.subscriptions.push(deployCommand);
    context.subscriptions.push(addGitOpsCommand);
    context.subscriptions.push(editGitOpsCommand);
    context.subscriptions.push(deleteGitOpsCommand);
    context.subscriptions.push(activateGitOpsCommand);


    // Refresh the tree view when files change in the workspace
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(() => directoryTreeDataProvider.refresh());
    watcher.onDidDelete(() => directoryTreeDataProvider.refresh());
    watcher.onDidChange(() => directoryTreeDataProvider.refresh());

    context.subscriptions.push(watcher);

    outputChannel.appendLine('Tree view provider registered');
}
