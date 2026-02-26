import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import FormData from 'form-data';
import JSZip from 'jszip';
import urlJoin from 'proper-url-join';
import axios from 'axios';

import { FolderItem } from '../views/sources_view';
import { activateDeployment, deploy, zip2stream, zipDirectory, createStreamingZip, uploadAsset, uploadAssetStream, promoteAutomation, calculateGitTreeHash, calculateMergedGitTreeHash, getImages, getAutomations, getDeployStatus, DeployResponse } from '../lib';
import { getDeployDetails } from '../deploy_details';
import { outputChannel } from '../extension';
import { AutomationSourcesViewProvider } from '../views/automation_sources_view';
import { UnifiedBusinessProcessesViewProvider } from '../views/unified_business_processes_view';
import { UnifiedImagesViewProvider, OrphanedImagesViewProvider } from '../views/unified_images_view';
import { sanitizeName } from '../utils/nameUtils';
import { refreshAutomationsCommand } from './automations';
import { ensureAutomationImageReady, getAutomationDeployConfig, checkImageDirectoryPreflight } from '../utils/automationImageBuilder';
import { deployState } from '../services/deploy_state';

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

    // Read automation config early so we have ignore patterns for pre-flight and image build
    let ignorePatterns: string[] | undefined;
    if (itemSet === "automations") {
        const automationConfig = getAutomationDeployConfig(folderPath);
        ignorePatterns = automationConfig.ignore;
        if (ignorePatterns && ignorePatterns.length > 0) {
            outputChannel.appendLine(`Ignore patterns from config: ${ignorePatterns.join(', ')}`);
        }

        // Pre-flight check on image/ directory
        const preflightWarning = checkImageDirectoryPreflight(folderPath, ignorePatterns);
        if (preflightWarning) {
            const choice = await vscode.window.showWarningMessage(
                preflightWarning,
                { modal: true },
                'Continue Anyway'
            );
            if (choice !== 'Continue Anyway') {
                return;
            }
        }
    }

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
                checksum = calculateGitTreeHash(folderPath, outputChannel);
                outputChannel.appendLine(`Calculated checksum: ${checksum}`);
            } catch (error: any) {
                outputChannel.appendLine(`Warning: Failed to calculate git tree hash: ${error.message}`);
                throw new Error(`Failed to calculate checksum: ${error.message}`);
            }

            if (itemSet === "automations") {
                progress.report({ increment: 5, message: "Preparing automation image..." });
                let imageBuildResult: Awaited<ReturnType<typeof ensureAutomationImageReady>> = null;
                try {
                    imageBuildResult = await ensureAutomationImageReady(details, folderPath, outputChannel, ignorePatterns);
                } catch (imageError: any) {
                    throw new Error(`Failed to prepare automation image: ${imageError.message || imageError}`);
                }

                // Recalculate checksum with ignore patterns
                checksum = calculateGitTreeHash(folderPath, outputChannel, ignorePatterns);

                // Check if bitswan_lib exists - this determines if we need to merge directories
                const workspacePath = path.join(workspaceFolders[0].uri.fsPath, 'workspace');
                const bitswanLibPath = path.join(workspacePath, 'bitswan_lib');
                const hasBitswanLib = fs.existsSync(bitswanLibPath);

                // Build the list of directories to merge (bitswan_lib overrides automation files)
                const dirsToMerge = hasBitswanLib ? [folderPath, bitswanLibPath] : [folderPath];

                if (hasBitswanLib) {
                    outputChannel.appendLine(`bitswan_lib found at ${bitswanLibPath}`);
                } else {
                    outputChannel.appendLine(`No bitswan_lib found at ${bitswanLibPath}`);
                }

                // Calculate merged checksum without copying files
                if (hasBitswanLib) {
                    progress.report({ increment: 5, message: "Calculating merged checksum..." });
                    checksum = calculateMergedGitTreeHash(dirsToMerge, outputChannel, ignorePatterns);
                }

                // Check if asset already exists BEFORE doing any file operations
                progress.report({ increment: 10, message: "Checking if asset already exists..." });
                let assetExists = false;
                try {
                    const automationsUrl = urlJoin(details.deployUrl, "automations").toString();
                    const automations = await getAutomations(automationsUrl, details.deploySecret);

                    assetExists = automations.some((automation: any) =>
                        automation.version_hash === checksum || automation.versionHash === checksum
                    );

                    if (assetExists) {
                        outputChannel.appendLine(`Asset with checksum ${checksum} already exists, skipping upload`);
                        progress.report({ increment: 50, message: "Asset already exists, skipping upload" });
                    }
                } catch (error: any) {
                    outputChannel.appendLine(`Warning: Failed to check asset existence: ${error.message}, proceeding with upload`);
                }

                // Only create zip if we actually need to upload - stream directly from source, no copying
                if (!assetExists) {
                    progress.report({ increment: 10, message: "Packing..." });
                    outputChannel.appendLine(`Creating streaming zip from ${dirsToMerge.length} directories...`);

                    // Create true streaming zip - files are compressed as the stream is consumed
                    const stream = createStreamingZip(dirsToMerge, outputChannel, ignorePatterns);
                    outputChannel.appendLine(`Streaming zip created, starting upload...`);

                    progress.report({ increment: 40, message: "Uploading asset..." });
                    // Use the streaming upload endpoint that handles chunked transfer encoding
                    const streamUploadUrl = urlJoin(details.deployUrl, "automations", "assets", "upload-stream").toString();
                    outputChannel.appendLine(`Starting streaming upload to ${streamUploadUrl}...`);

                    const uploadResult = await uploadAssetStream(streamUploadUrl, stream, checksum, details.deploySecret);
                    outputChannel.appendLine(`Upload completed, response: ${JSON.stringify(uploadResult)}`);

                    if (!uploadResult || uploadResult.error) {
                        throw new Error(`Failed to upload asset: ${uploadResult?.error || 'No response'}`);
                    }

                    if (!uploadResult.checksum) {
                        throw new Error(`Failed to upload asset: missing checksum in response`);
                    }

                    if (uploadResult.checksum !== checksum) {
                        outputChannel.appendLine(`Warning: Server checksum (${uploadResult.checksum}) differs from calculated checksum (${checksum})`);
                    }
                    outputChannel.appendLine(`Asset uploaded with checksum: ${checksum}`);
                }

                // For automations, use the promotion workflow
                const relativePath = path.relative(workspaceFolders[0].uri.fsPath, folderPath);

                // Guard: check if already deploying
                const devDeploymentId = `${normalizedFolderName}-dev`;
                if (deployState.isDeploying(devDeploymentId)) {
                    vscode.window.showWarningMessage(`Deployment ${devDeploymentId} is already in progress`);
                    return;
                }

                progress.report({ increment: 75, message: "Deploying to dev stage..." });

                // Deploy to dev stage with -dev suffix
                const devDeployUrl = urlJoin(details.deployUrl, "automations", devDeploymentId, "deploy").toString();
                const deployResult = await promoteAutomation(devDeployUrl, details.deploySecret, checksum, 'dev', relativePath);

                if (deployResult.alreadyDeploying) {
                    vscode.window.showWarningMessage(`Deployment ${devDeploymentId} is already in progress`);
                    return;
                }

                if (deployResult.success && deployResult.task_id) {
                    // Optimistically mark as deploying and wait for SSE completion
                    deployState.markDeploying(devDeploymentId, deployResult.task_id);

                    const result = await waitForDeployCompletion(
                        devDeploymentId, deployResult.task_id, progress, details, 120_000
                    );

                    if (result.outcome === 'completed') {
                        progress.report({ increment: 100, message: `Successfully deployed automation to dev stage` });
                        vscode.window.showInformationMessage(`Successfully deployed automation to dev stage`);
                        const providerForRefresh = (businessProcessesProvider || treeDataProvider);
                        if (providerForRefresh) {
                            await refreshAutomationsCommand(context, providerForRefresh as any);
                        }
                    } else {
                        throw new Error(result.error || `Deployment to dev stage ${result.outcome}`);
                    }
                } else if (deployResult.success) {
                    // Legacy 200 response path
                    progress.report({ increment: 100, message: `Successfully deployed automation to dev stage` });
                    vscode.window.showInformationMessage(`Successfully deployed automation to dev stage`);
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
                const stream = zip2stream(zip);
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

    // Read automation config before withProgress so we have ignore patterns for pre-flight
    const automationConfig = getAutomationDeployConfig(folderPath);
    const ignorePatterns = automationConfig.ignore;
    if (ignorePatterns && ignorePatterns.length > 0) {
        outputChannel.appendLine(`Ignore patterns from config: ${ignorePatterns.join(', ')}`);
    }

    // Pre-flight check on image/ directory
    const preflightWarning = checkImageDirectoryPreflight(folderPath, ignorePatterns);
    if (preflightWarning) {
        const choice = await vscode.window.showWarningMessage(
            preflightWarning,
            { modal: true },
            'Continue Anyway'
        );
        if (choice !== 'Continue Anyway') {
            return;
        }
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Starting live dev server for ${folderName}`,
        cancellable: true
    }, async (progress, token) => {
        try {
            progress.report({ increment: 20, message: "Preparing automation image..." });

            if (token.isCancellationRequested) { return; }

            // Build image if needed
            const imageResult = await ensureAutomationImageReady(details, folderPath, outputChannel, ignorePatterns);
            // imageResult is null if no image folder exists, which is fine

            if (token.isCancellationRequested) { return; }

            progress.report({ increment: 50, message: "Reading automation config..." });

            // Get relative path for source mounting
            const relativePath = path.relative(workspaceFolders[0].uri.fsPath, folderPath);

            outputChannel.appendLine(`Live-dev config: image=${automationConfig.image}, expose=${automationConfig.expose}, port=${automationConfig.port}, mountPath=${automationConfig.mountPath}, secretGroups=${automationConfig.secretGroups?.join(',') || 'none'}, automationId=${automationConfig.automationId || 'none'}, auth=${automationConfig.auth ?? false}`);

            if (token.isCancellationRequested) { return; }

            progress.report({ increment: 70, message: "Starting live dev server..." });

            // Deploy to live-dev stage
            // For live-dev, we use a placeholder checksum since the source is mounted directly
            // and changes are reflected immediately without redeployment
            const liveDevDeploymentId = `${normalizedFolderName}-live-dev`;

            if (deployState.isDeploying(liveDevDeploymentId)) {
                vscode.window.showWarningMessage(`Deployment ${liveDevDeploymentId} is already in progress`);
                return;
            }

            const deployUrl = urlJoin(details.deployUrl, "automations", liveDevDeploymentId, "deploy").toString();
            const deployResult = await promoteAutomation(deployUrl, details.deploySecret, 'live-dev', 'live-dev', relativePath, {
                image: automationConfig.image,
                expose: automationConfig.expose,
                port: automationConfig.port,
                mountPath: automationConfig.mountPath,
                secretGroups: automationConfig.secretGroups,
                automationId: automationConfig.automationId,
                auth: automationConfig.auth,
                services: automationConfig.services,
            });

            if (deployResult.alreadyDeploying) {
                vscode.window.showWarningMessage(`Deployment ${liveDevDeploymentId} is already in progress`);
                return;
            }

            if (deployResult.success && deployResult.task_id) {
                deployState.markDeploying(liveDevDeploymentId, deployResult.task_id);

                const result = await waitForDeployCompletion(
                    liveDevDeploymentId, deployResult.task_id, progress, details, 120_000
                );

                if (result.outcome === 'completed') {
                    progress.report({ increment: 100, message: "Live dev server started!" });
                    vscode.window.showInformationMessage(
                        `Live dev server started for ${folderName}. Changes to source files will auto-reload.`
                    );
                    if (businessProcessesProvider) {
                        await refreshAutomationsCommand(context, businessProcessesProvider);
                    }
                } else {
                    throw new Error(result.error || `Failed to start live dev server: ${result.outcome}`);
                }
            } else if (deployResult.success) {
                progress.report({ increment: 100, message: "Live dev server started!" });
                vscode.window.showInformationMessage(
                    `Live dev server started for ${folderName}. Changes to source files will auto-reload.`
                );
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

export interface DeployWaitResult {
    outcome: 'completed' | 'failed' | 'timeout';
    error?: string;
}

/**
 * Wait for a deploy task to complete by listening to deployState events
 * AND polling GET /deploy-status/{taskId} every few seconds as a fallback.
 */
export async function waitForDeployCompletion(
    deploymentId: string,
    taskId: string,
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    details: { deployUrl: string; deploySecret: string },
    timeoutMs: number = 120_000,
): Promise<DeployWaitResult> {
    const statusUrl = urlJoin(details.deployUrl, "automations", "deploy-status", taskId).toString();

    return new Promise<DeployWaitResult>((resolve) => {
        let settled = false;

        function settle(outcome: 'completed' | 'failed' | 'timeout', error?: string) {
            if (settled) { return; }
            settled = true;
            clearTimeout(deadlineTimer);
            clearInterval(pollTimer);
            listener.dispose();
            resolve({ outcome, error });
        }

        // Hard deadline
        const deadlineTimer = setTimeout(() => settle('timeout'), timeoutMs);

        // Poll every 3 seconds as a robust fallback for missed SSE events
        const pollTimer = setInterval(async () => {
            if (settled) { return; }
            try {
                const status = await getDeployStatus(statusUrl, details.deploySecret);
                if (!status) { return; }
                if (status.message) {
                    progress.report({ message: status.message });
                }
                if (status.status === 'completed') {
                    settle('completed');
                } else if (status.status === 'failed') {
                    settle('failed', status.error || status.message || undefined);
                }
            } catch {
                // Ignore poll errors, will retry on next interval
            }
        }, 3000);

        // Primary mechanism: listen for SSE deploy_progress events
        const listener = deployState.addListener((event) => {
            if (settled) { return; }
            if (event.deployment_id !== deploymentId) { return; }

            // Relay step messages to the progress notification
            if (event.message) {
                progress.report({ message: event.message });
            }

            if (event.status === 'completed') {
                settle('completed');
            } else if (event.status === 'failed') {
                settle('failed', event.error || event.message || undefined);
            }
        });
    });
}
