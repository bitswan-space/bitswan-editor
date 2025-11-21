import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import FormData from 'form-data';
import JSZip from 'jszip';
import urlJoin from 'proper-url-join';

import { FolderItem } from '../views/sources_view';
import { activateDeployment, deploy, zip2stream, zipDirectory, uploadAsset, promoteAutomation, calculateGitTreeHash } from '../lib';
import { getDeployDetails } from '../deploy_details';
import { outputChannel } from '../extension';
import { AutomationSourcesViewProvider } from '../views/automation_sources_view';
import { UnifiedBusinessProcessesViewProvider } from '../views/unified_business_processes_view';
import { UnifiedImagesViewProvider, OrphanedImagesViewProvider } from '../views/unified_images_view';
import { sanitizeName } from '../utils/nameUtils';
import { refreshAutomationsCommand } from './automations';

export async function deployCommandAbstract(
    context: vscode.ExtensionContext, 
    folderPath: string, 
    itemSet: string, 
    treeDataProvider: AutomationSourcesViewProvider | null,
    businessProcessesProvider?: UnifiedBusinessProcessesViewProvider,
    unifiedImagesProvider?: UnifiedImagesViewProvider,
    orphanedImagesProvider?: OrphanedImagesViewProvider
) {
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
        // Declare deployUrl outside try block so it's accessible in catch block
        let deployUrl: string | undefined;
        try {
            const form = new FormData();
            // The folder name must be all lowercase and have any characters not allowed in image tags removed
            const normalizedFolderName = sanitizeName(folderName);
            deployUrl = urlJoin(details.deployUrl, itemSet, normalizedFolderName).toString();

            outputChannel.appendLine(messages[itemSet]["url"] + `: ${deployUrl}`);

            progress.report({ increment: 0, message: "Calculating checksum..." });

            // Calculate git tree hash for the directory
            let checksum: string;
            try {
                checksum = await calculateGitTreeHash(folderPath, outputChannel);
                outputChannel.appendLine(`Calculated checksum: ${checksum}`);
            } catch (error: any) {
                outputChannel.appendLine(`Warning: Failed to calculate git tree hash: ${error.message}`);
                throw new Error(`Failed to calculate checksum: ${error.message}`);
            }

            progress.report({ increment: 20, message: "Packing..." });

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
            // Add checksum to form
            form.append('checksum', checksum);

            if (itemSet === "automations") {
                // For automations, use the promotion workflow
                const relativePath = path.relative(workspaceFolders[0].uri.fsPath, folderPath);
                
                progress.report({ increment: 50, message: "Uploading asset..." });

                // Upload asset with pre-calculated checksum
                const assetsUploadUrl = urlJoin(details.deployUrl, "automations", "assets", "upload").toString();
                const uploadResult = await uploadAsset(assetsUploadUrl, form, details.deploySecret);
                
                if (!uploadResult || !uploadResult.checksum) {
                    throw new Error("Failed to upload asset");
                }

                // Verify the checksum matches
                if (uploadResult.checksum !== checksum) {
                    outputChannel.appendLine(`Warning: Server checksum (${uploadResult.checksum}) differs from calculated checksum (${checksum})`);
                }
                outputChannel.appendLine(`Asset uploaded with checksum: ${checksum}`);

                progress.report({ increment: 75, message: "Deploying to dev stage..." });

                // Deploy to dev stage with -dev suffix
                const devDeploymentId = `${normalizedFolderName}-dev`;
                const devDeployUrl = urlJoin(details.deployUrl, "automations", devDeploymentId, "deploy").toString();
                const activationSuccess = await promoteAutomation(devDeployUrl, details.deploySecret, checksum, 'dev', relativePath);
                
                if (activationSuccess) {
                    progress.report({ increment: 100, message: `Successfully deployed automation to dev stage` });
                    vscode.window.showInformationMessage(`Successfully deployed automation to dev stage`);
                    // Immediately refetch automations and refresh the unified view
                    const providerForRefresh = (businessProcessesProvider || treeDataProvider);
                    if (providerForRefresh) {
                        await refreshAutomationsCommand(context, providerForRefresh as any);
                    }
                } else {
                    throw new Error(`Failed to deploy automation to dev stage`);
                }
            } else {
                // For images, use the workflow with checksum
                progress.report({ increment: 50, message: "Uploading to server " + deployUrl });

                const success = await deploy(deployUrl, form, details.deploySecret, outputChannel);

                if (success) {
                    progress.report({ increment: 100, message: "Succesfully uploaded "+messages[itemSet]["item"]+" to GitOps" });
                    vscode.window.showInformationMessage("Succesfully uploaded "+messages[itemSet]["item"]+" to GitOps");
                    
                    // Refresh image views if this was an image build
                    if (itemSet === "images" && unifiedImagesProvider && orphanedImagesProvider) {
                        unifiedImagesProvider.refresh();
                        orphanedImagesProvider.refresh();
                    }
                } else {
                    throw new Error("Failed to upload "+messages[itemSet]["item"]+" to GitOps");
                }
            }

        } catch (error: any) {
            let errorMessage: string;
            if (error.response) {
                const status = error.response.status;
                // Log full error details for 500 errors
                if (status >= 500) {
                    outputChannel.appendLine("=".repeat(60));
                    outputChannel.appendLine(`Deployment Error (${status})`);
                    outputChannel.appendLine("=".repeat(60));
                    outputChannel.appendLine(`URL: ${deployUrl || details.deployUrl}`);
                    outputChannel.appendLine(`Status: ${status} ${error.response.statusText}`);
                    outputChannel.appendLine(`Response Data:`);
                    outputChannel.appendLine(JSON.stringify(error.response.data, null, 2));
                    outputChannel.appendLine(`Response Headers:`);
                    outputChannel.appendLine(JSON.stringify(error.response.headers, null, 2));
                    outputChannel.appendLine("=".repeat(60));
                    outputChannel.show(true);
                } else {
                    outputChannel.appendLine(`Error response data: ${JSON.stringify(error.response.data)}`);
                }
                errorMessage = `Server responded with status ${status}`;
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


export async function deployFromToolbarCommand(
    context: vscode.ExtensionContext, 
    item: vscode.Uri, 
    itemSet: string,
    businessProcessesProvider?: UnifiedBusinessProcessesViewProvider,
    unifiedImagesProvider?: UnifiedImagesViewProvider,
    orphanedImagesProvider?: OrphanedImagesViewProvider
) {
    deployCommandAbstract(context, path.dirname(item.path), itemSet, null, businessProcessesProvider, unifiedImagesProvider, orphanedImagesProvider);
}

export async function deployFromNotebookToolbarCommand(
    context: vscode.ExtensionContext, 
    item: any, 
    itemSet: string,
    businessProcessesProvider?: UnifiedBusinessProcessesViewProvider,
    unifiedImagesProvider?: UnifiedImagesViewProvider,
    orphanedImagesProvider?: OrphanedImagesViewProvider
) {
    deployCommandAbstract(context, path.dirname(item.notebookEditor.notebookUri.path), itemSet, null, businessProcessesProvider, unifiedImagesProvider, orphanedImagesProvider);
}

export async function deployCommand(
    context: vscode.ExtensionContext, 
    treeDataProvider: AutomationSourcesViewProvider, 
    folderItem: FolderItem, 
    itemSet: string,
    businessProcessesProvider?: UnifiedBusinessProcessesViewProvider,
    unifiedImagesProvider?: UnifiedImagesViewProvider,
    orphanedImagesProvider?: OrphanedImagesViewProvider
) {
    var item : string = folderItem.resourceUri.fsPath;
    deployCommandAbstract(context, item, itemSet, treeDataProvider, businessProcessesProvider, unifiedImagesProvider, orphanedImagesProvider);
}
