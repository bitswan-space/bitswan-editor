import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import FormData from 'form-data';
import JSZip from 'jszip';
import urlJoin from 'proper-url-join';

import { FolderItem } from '../views/sources_view';
import { activateDeployment, deploy, zip2stream, zipDirectory } from '../lib';
import { getDeployDetails } from '../deploy_details';
import { outputChannel } from '../extension';
import { AutomationSourcesViewProvider } from '../views/automation_sources_view';
import { ImageSourcesViewProvider } from '../views/image_sources_view';

export async function deployCommandAbstract(context: vscode.ExtensionContext, folderPath: string, itemSet: string, treeDataProvider: AutomationSourcesViewProvider | ImageSourcesViewProvider | null) {
    var messages: { [key: string]: { [key: string]: string } } = {
        "automations": {
            "deploy": "Deploying automation",
            "url": "Deploy URL:",
            "item;": "automation"
        },
        "images": {
            "deploy": "Building image",
            "url": "Build URL:",
            "item": "image"
        }
    }


    outputChannel.appendLine(messages[itemSet]["deploy"] + `: ${folderPath}`);

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



    // folderName is the name of the folder immediately containing the item being deployed so /bar/foo → foo
    const folderName = path.basename(folderPath);

    // deployment of pipeline
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: messages[itemSet]["deploy"] ,
        cancellable: false
    }, async (progress, _token) => {
        try {
            const form = new FormData();
            // The folder name must be all lowercase and have any characters not allowed in image tags removed
            const normalizedFolderName = folderName.toLowerCase().replace(/[^a-z0-9\-]/g, '')
                                                                 .replace(/^[,\.\-]+/g, '');
            const deployUrl = urlJoin(details.deployUrl, itemSet, normalizedFolderName);

            outputChannel.appendLine(messages[itemSet]["url"] + `: ${deployUrl.toString()}`);

            progress.report({ increment: 0, message: "Packing..." });

            // Zip the pipeline config folder and add it to the form
            let zip = await zipDirectory(folderPath, '', JSZip(), outputChannel);
            const workspacePath = path.join(workspaceFolders[0].uri.fsPath, 'workspace')
            if (itemSet === "automations") {
                const bitswanLibPath = path.join(workspacePath, 'bitswan_lib')
                if (fs.existsSync(bitswanLibPath)) {
                    zip = await zipDirectory(bitswanLibPath, '', zip, outputChannel);
                    outputChannel.appendLine(`bitswan_lib found at ${bitswanLibPath}`);
                } else {
                    outputChannel.appendLine(`Warning. No bitswan_lib found at ${bitswanLibPath}`);
                }
            }
            const stream = await zip2stream(zip);
            form.append('file', stream, {
                filename: 'deployment.zip',
                contentType: 'application/zip',
            });

            // Send relative path
            if (itemSet === "automations") {
                const relativePath = path.relative(workspaceFolders[0].uri.fsPath, folderPath);
                form.append('relative_path', relativePath);
            }

            progress.report({ increment: 50, message: "Uploading to server " + deployUrl.toString() });

            const success = await deploy(deployUrl.toString(), form, details.deploySecret);

            if (success) {
                progress.report({ increment: 100, message: "Succesfully uploaded "+messages[itemSet]["item"]+" to GitOps" });
                vscode.window.showInformationMessage("Succesfully uploaded "+messages[itemSet]["item"]+" to GitOps");
            } else {
                throw new Error("Failed to upload "+messages[itemSet]["item"]+" to GitOps");
            }

            if (itemSet === "automations") {
                progress.report({ increment: 50, message: "Activating deployment..." });

                const activationSuccess = await activateDeployment(urlJoin(details.deployUrl,"automations", normalizedFolderName, "deploy").toString(), details.deploySecret);
                if (activationSuccess) {
                    progress.report({ increment: 100, message: `Succesfully activated automation on GitOps` });
                    vscode.window.showInformationMessage(`Succesfully activated automation on GitOps`);
                    if (treeDataProvider) {
                        treeDataProvider.refresh();
                    }
                } else {
                    throw new Error(`Failed to activate automation on GitOps`);
                }
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


export async function deployFromToolbarCommand(context: vscode.ExtensionContext, item: vscode.Uri, itemSet: string) {
    deployCommandAbstract(context, path.dirname(item.path), itemSet, null);
}

export async function deployFromNotebookToolbarCommand(context: vscode.ExtensionContext, item: any, itemSet: string) {
    deployCommandAbstract(context, path.dirname(item.notebookEditor.notebookUri.path), itemSet, null);
}

export async function deployCommand(context: vscode.ExtensionContext, treeDataProvider: AutomationSourcesViewProvider, folderItem: FolderItem, itemSet: string) {
    var item : string = folderItem.resourceUri.fsPath;
    deployCommandAbstract(context, item, itemSet, treeDataProvider);
}
