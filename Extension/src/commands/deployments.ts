import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import FormData from 'form-data';
import JSZip from 'jszip';

import { DirectoryTreeDataProvider, FolderItem } from '../views/bitswan_pre';
import { activateDeployment, deploy, zip2stream, zipDirectory } from '../lib';
import { getDeployDetails } from '../deploy_details';
import { outputChannel } from '../extension';

export async function deployCommand(context: vscode.ExtensionContext, treeDataProvider: DirectoryTreeDataProvider, folderItemOrPath: FolderItem | string | undefined) {
    outputChannel.appendLine(`Deploying pipeline: ${folderItemOrPath}`);
    let pipelineDeploymentPath: string | undefined;

    // create folder path out of provided argument. Its either folder, folder's path or it is not defined
    if (folderItemOrPath instanceof FolderItem) {
        const pipelinePathExists = path.join(folderItemOrPath.resourceUri.fsPath, 'pipelines.conf');
        if (fs.existsSync(pipelinePathExists)) {
            pipelineDeploymentPath = path.join(folderItemOrPath.resourceUri.fsPath, 'pipelines.conf');
        }
    } else if (typeof folderItemOrPath === 'string') {
        pipelineDeploymentPath = folderItemOrPath;
    } else {
        let editor = vscode.window.activeTextEditor;
        if (editor && (path.extname(editor.document.fileName) === '.conf' || path.extname(editor.document.fileName) === '.ipynb')) {
            pipelineDeploymentPath = editor.document.uri.fsPath;
        }
    }

    outputChannel.appendLine(`Pipeline deployment path: ${pipelineDeploymentPath}`);

    if (!pipelineDeploymentPath) {
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

    const folderName = path.basename(path.dirname(pipelineDeploymentPath));

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
            const deployUrl = new URL(path.join(details.deployUrl, "automations", normalizedFolderName));

            outputChannel.appendLine(`Deploy URL: ${deployUrl.toString()}`);

            progress.report({ increment: 0, message: "Packing for deployment..." });

            // Zip the pipeline config folder and add it to the form
            let zip = await zipDirectory(path.dirname(pipelineDeploymentPath as string), '', JSZip(), outputChannel);
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
                progress.report({ increment: 100, message: "Succesfully uploaded automation on GitOps" });
                vscode.window.showInformationMessage(`Succesfully uploaded automation on GitOps`);
            } else {
                throw new Error(`Failed to upload automation on GitOps`);
            }
            progress.report({ increment: 50, message: "Activating deployment..." });

            const activationSuccess = await activateDeployment(path.join(details.deployUrl,"automations", normalizedFolderName, "deploy").toString(), details.deploySecret);
            if (activationSuccess) {
                progress.report({ increment: 100, message: `Succesfully activated automation on GitOps` });
                vscode.window.showInformationMessage(`Succesfully activated automation on GitOps`);
                treeDataProvider.refresh();
            } else {
                throw new Error(`Failed to activate automation on GitOps`);
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