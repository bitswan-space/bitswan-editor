import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import FormData from 'form-data';
import JSZip from 'jszip';
import urlJoin from 'proper-url-join';
import axios from 'axios';

import { FolderItem } from '../views/sources_view';
import { activateDeployment, deploy, zip2stream, zipDirectory, uploadAsset, promoteAutomation, calculateGitTreeHash, getImages, getAutomations } from '../lib';
import { getDeployDetails } from '../deploy_details';
import { outputChannel } from '../extension';
import { AutomationSourcesViewProvider } from '../views/automation_sources_view';
import { UnifiedBusinessProcessesViewProvider } from '../views/unified_business_processes_view';
import { UnifiedImagesViewProvider, OrphanedImagesViewProvider } from '../views/unified_images_view';
import { sanitizeName } from '../utils/nameUtils';
import { refreshAutomationsCommand } from './automations';
import { ensureAutomationImageReady } from '../utils/automationImageBuilder';

/**
 * Recursively copies all files and directories from srcDir to destDir, preserving the directory structure.
 * Equivalent to `cp -r srcDir/* destDir/`
 */
function copyDirectoryRecursive(srcDir: string, destDir: string): void {
    if (!fs.existsSync(srcDir)) {
        return;
    }
    
    fs.mkdirSync(destDir, { recursive: true });
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    
    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        
        if (entry.isDirectory()) {
            // Recursively copy subdirectory, preserving structure
            copyDirectoryRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
            // Copy file to corresponding location in destDir
            const data = fs.readFileSync(srcPath);
            fs.writeFileSync(destPath, data);
        }
    }
}

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
            let checksum: string; // calculate checksum after bitswan_lib added to automation source

            try {
                checksum = await calculateGitTreeHash(folderPath, outputChannel);
                outputChannel.appendLine(`Calculated checksum: ${checksum}`);
            } catch (error: any) {
                outputChannel.appendLine(`Warning: Failed to calculate git tree hash: ${error.message}`);
                throw new Error(`Failed to calculate checksum: ${error.message}`);
            }

            if (itemSet === "automations") {
                progress.report({ increment: 5, message: "Preparing automation image..." });
                let imageBuildResult: Awaited<ReturnType<typeof ensureAutomationImageReady>> = null;
                try {
                    imageBuildResult = await ensureAutomationImageReady(details, folderPath, outputChannel);
                } catch (imageError: any) {
                    throw new Error(`Failed to prepare automation image: ${imageError.message || imageError}`);
                }

                // Create temporary directory to pack contents before checksum calculation
                const tmpDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bitswan-deploy-'));
                let tmpDirCreated = true;
                
                try {
                    // Copy folderPath contents to temporary directory (recursively)
                    outputChannel.appendLine(`Copying ${folderPath} to temporary directory...`);
                    copyDirectoryRecursive(folderPath, tmpDirPath);
                    
                    // Copy bitswanLibPath contents to temporary directory (recursively) if it exists
                    const workspacePath = path.join(workspaceFolders[0].uri.fsPath, 'workspace');
                    const bitswanLibPath = path.join(workspacePath, 'bitswan_lib');
                    if (fs.existsSync(bitswanLibPath)) {
                        outputChannel.appendLine(`bitswan_lib found at ${bitswanLibPath}`);
                        outputChannel.appendLine(`Copying bitswan_lib from ${bitswanLibPath} to temporary directory...`);
                        copyDirectoryRecursive(bitswanLibPath, tmpDirPath);
                    } else {
                        outputChannel.appendLine(`Warning. No bitswan_lib found at ${bitswanLibPath}`);
                    }

                    // Calculate checksum on the temporary directory (which contains what will be in the archive)
                    progress.report({ increment: 10, message: "Calculating checksum..." });
                    try {
                        checksum = await calculateGitTreeHash(tmpDirPath, outputChannel);
                        outputChannel.appendLine(`Calculated checksum: ${checksum}`);
                    } catch (error: any) {
                        outputChannel.appendLine(`Warning: Failed to calculate git tree hash: ${error.message}`);
                        throw new Error(`Failed to calculate checksum: ${error.message}`);
                    }

                // For automations, check if asset already exists by looking at the automations list
                progress.report({ increment: 10, message: "Checking if asset already exists..." });
                let assetExists = false;
                try {
                    // Get the automations list from the server
                    const automationsUrl = urlJoin(details.deployUrl, "automations").toString();
                    const automations = await getAutomations(automationsUrl, details.deploySecret);
                    
                    // Check if any automation uses this checksum (which means the asset exists)
                    assetExists = automations.some((automation: any) => 
                        automation.version_hash === checksum || automation.versionHash === checksum
                    );
                    
                    if (assetExists) {
                        outputChannel.appendLine(`Asset with checksum ${checksum} already exists, skipping upload`);
                        progress.report({ increment: 30, message: "Asset already exists, skipping upload" });
                    }
                } catch (error: any) {
                    // If check fails, proceed with upload
                    outputChannel.appendLine(`Warning: Failed to check asset existence: ${error.message}, proceeding with upload`);
                }

                    if (!assetExists) {
                        progress.report({ increment: 20, message: "Packing..." });

                        // Zip the temporary directory (which contains the flattened contents)
                        const zip = await zipDirectory(tmpDirPath, '', JSZip(), outputChannel);
                        const stream = await zip2stream(zip);
                        form.append('file', stream, {
                            filename: 'deployment.zip',
                            contentType: 'application/zip',
                        });
                        // Add checksum to form
                        form.append('checksum', checksum);

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
                    }
                } finally {
                    // Clean up temporary directory
                    if (tmpDirCreated && fs.existsSync(tmpDirPath)) {
                        try {
                            fs.rmSync(tmpDirPath, { recursive: true, force: true });
                            outputChannel.appendLine(`Cleaned up temporary directory: ${tmpDirPath}`);
                        } catch (cleanupError: any) {
                            outputChannel.appendLine(`Warning: Failed to clean up temporary directory: ${cleanupError.message}`);
                        }
                    }
                }

                // For automations, use the promotion workflow
                const relativePath = path.relative(workspaceFolders[0].uri.fsPath, folderPath);

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
                // For images, check if image already exists by looking at the images list
                progress.report({ increment: 10, message: "Checking if image already exists..." });
                let imageExists = false;
                try {
                    // Get the images list from the server
                    const imagesUrl = urlJoin(details.deployUrl, "images").toString();
                    const images = await getImages(imagesUrl, details.deploySecret);
                    
                    // Check if an image with the expected tag exists
                    const expectedTag = `internal/${normalizedFolderName}:sha${checksum}`;
                    imageExists = images.some((img: any) => img.tag === expectedTag);
                    
                    if (imageExists) {
                        outputChannel.appendLine(`Image with checksum ${checksum} already exists, skipping upload`);
                        progress.report({ increment: 100, message: "Image already exists, skipping upload" });
                        vscode.window.showInformationMessage("Image already exists, skipping upload");
                        
                        // Refresh image views
                        if (unifiedImagesProvider && orphanedImagesProvider) {
                            unifiedImagesProvider.refresh();
                            orphanedImagesProvider.refresh();
                        }
                        return;
                    }
                } catch (error: any) {
                    // If check fails, proceed with upload
                    outputChannel.appendLine(`Warning: Failed to check image existence: ${error.message}, proceeding with upload`);
                }

                // Image doesn't exist, proceed with upload
                progress.report({ increment: 20, message: "Packing..." });

                // Zip the pipeline config folder and add it to the form
                let zip = await zipDirectory(folderPath, '', JSZip(), outputChannel);
                const stream = await zip2stream(zip);
                form.append('file', stream, {
                    filename: 'deployment.zip',
                    contentType: 'application/zip',
                });
                // Add checksum to form
                form.append('checksum', checksum);

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

/**
 * Start a live dev server for an automation.
 * This deploys the automation with stage="live-dev" which:
 * - Mounts source code directly from the workspace for live editing
 * - Runs with auto-reload enabled (hot module replacement for frontend, uvicorn --reload for backend)
 */
export async function startLiveDevServerCommand(
    context: vscode.ExtensionContext,
    folderPath: string,
    businessProcessesProvider?: UnifiedBusinessProcessesViewProvider
) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }

    const details = await getDeployDetails(context);
    if (!details) {
        vscode.window.showErrorMessage('No deploy details configured');
        return;
    }

    const folderName = path.basename(folderPath);
    const normalizedFolderName = sanitizeName(folderName);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Starting live dev server for ${folderName}`,
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ increment: 10, message: "Preparing automation..." });

            // Build image if needed
            const imageResult = await ensureAutomationImageReady(details, folderPath, outputChannel);
            // imageResult is null if no image folder exists, which is fine

            progress.report({ increment: 30, message: "Calculating checksum..." });

            // Calculate checksum
            const checksum = await calculateGitTreeHash(folderPath);

            // Check if asset exists, upload if not
            progress.report({ increment: 40, message: "Checking asset..." });
            const assetsUrl = urlJoin(details.deployUrl, "automations", "assets").toString();
            try {
                const response = await axios.get(assetsUrl, {
                    headers: { 'Authorization': `Bearer ${details.deploySecret}` }
                });
                const assets = response.data;
                const assetExists = assets.some((asset: any) => asset.checksum === checksum);

                if (!assetExists) {
                    progress.report({ increment: 50, message: "Uploading asset..." });

                    // Create temp directory and copy source
                    const tmpDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bitswan-live-dev-'));
                    copyDirectoryRecursive(folderPath, tmpDirPath);

                    // Zip and upload
                    const zip = await zipDirectory(tmpDirPath, '', JSZip(), outputChannel);
                    const stream = await zip2stream(zip);

                    // Create form data for upload
                    const form = new FormData();
                    form.append('file', stream, {
                        filename: 'deployment.zip',
                        contentType: 'application/zip',
                    });
                    form.append('checksum', checksum);

                    const uploadUrl = urlJoin(details.deployUrl, "automations", "assets", "upload").toString();
                    await uploadAsset(uploadUrl, form, details.deploySecret);

                    // Cleanup temp directory
                    fs.rmSync(tmpDirPath, { recursive: true, force: true });
                }
            } catch (error: any) {
                outputChannel.appendLine(`Warning: Could not check/upload asset: ${error.message}`);
            }

            progress.report({ increment: 70, message: "Starting live dev server..." });

            // Get relative path for source mounting
            const relativePath = path.relative(workspaceFolders[0].uri.fsPath, folderPath);

            // Deploy to live-dev stage
            const liveDevDeploymentId = `${normalizedFolderName}-live-dev`;
            const deployUrl = urlJoin(details.deployUrl, "automations", liveDevDeploymentId, "deploy").toString();
            const success = await promoteAutomation(deployUrl, details.deploySecret, checksum, 'live-dev', relativePath);

            if (success) {
                progress.report({ increment: 100, message: "Live dev server started!" });
                vscode.window.showInformationMessage(
                    `Live dev server started for ${folderName}. Changes to source files will auto-reload.`
                );

                // Refresh the view
                if (businessProcessesProvider) {
                    await refreshAutomationsCommand(context, businessProcessesProvider);
                }
            } else {
                throw new Error('Failed to start live dev server');
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to start live dev server: ${error.message}`);
            outputChannel.appendLine(`Live dev server error: ${error.message}`);
        }
    });
}
