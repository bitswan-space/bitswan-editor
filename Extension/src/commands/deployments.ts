import * as vscode from 'vscode';
import * as path from 'path';
import urlJoin from 'proper-url-join';

import { getDeployStatus } from '../lib';
import { GitopsClient } from '../services/gitops_client';
import { getDeployDetails } from '../deploy_details';
import { outputChannel } from '../extension';
import { getAutomationDeployConfig, checkImageDirectoryPreflight } from '../utils/automationImageBuilder';
import { deployState } from '../services/deploy_state';

/**
 * Workspace-relative path of `folderPath`, with `worktrees/<name>/` re-prefixed
 * when the source lives inside a worktree. Matches the `relative_path` shape
 * gitops uses across `automations` events and `/automations/start-deploy`.
 */
function workspaceRelativePath(workspaceRoot: string, folderPath: string): { relative_path: string; worktree?: string } {
    const rel = path.relative(workspaceRoot, folderPath);
    if (rel.startsWith('worktrees/')) {
        const parts = rel.split('/');
        return { relative_path: rel, worktree: parts[1] };
    }
    return { relative_path: rel };
}

export async function deployCommandAbstract(
    context: vscode.ExtensionContext,
    folderPath: string,
    itemSet: string,
) {
    if (itemSet !== 'automations') {
        // Image-build flow was removed — gitops builds images during deploy.
        vscode.window.showErrorMessage(`Unsupported deploy itemSet: ${itemSet}`);
        return;
    }

    outputChannel.appendLine(`Deploying automation: ${folderPath}`);

    const details = await getDeployDetails(context);
    if (!details) {
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }

    const folderName = path.basename(folderPath);

    let ignorePatterns: string[] | undefined;
    try {
        const automationConfig = getAutomationDeployConfig(folderPath);
        ignorePatterns = automationConfig.ignore;
        if (ignorePatterns && ignorePatterns.length > 0) {
            outputChannel.appendLine(`Ignore patterns from config: ${ignorePatterns.join(', ')}`);
        }
    } catch (configError: any) {
        vscode.window.showErrorMessage(`Syntax error in automation.toml: ${configError.message}`);
        return;
    }

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
        title: `Deploying ${folderName}`,
        cancellable: false
    }, async (progress, _token) => {
        try {
            const { relative_path, worktree } = workspaceRelativePath(workspaceFolders[0].uri.fsPath, folderPath);
            outputChannel.appendLine(`Starting deploy: relative_path=${relative_path}${worktree ? `, worktree=${worktree}` : ''}`);

            progress.report({ increment: 20, message: 'Starting deploy on gitops...' });

            const client = new GitopsClient(details.deployUrl, details.deploySecret);
            const result = await client.startDeploy({
                relative_path,
                stage: 'dev',
                ...(worktree ? { worktree } : {}),
            });

            if (!result.ok || !result.body || typeof result.body !== 'object') {
                throw new Error(`Failed to start deploy: HTTP ${result.status}`);
            }
            const body = result.body as { task_id?: string; deployment_id?: string };
            const taskId = body.task_id;
            const deploymentId = body.deployment_id;
            if (!taskId || !deploymentId) {
                throw new Error('Gitops /start-deploy did not return task_id and deployment_id');
            }

            deployState.markDeploying(deploymentId, taskId);
            progress.report({ increment: 30, message: 'Building and deploying...' });

            const waitResult = await waitForDeployCompletion(deploymentId, taskId, progress, details, 240_000);

            if (waitResult.outcome === 'completed') {
                progress.report({ increment: 100, message: 'Successfully deployed automation to dev stage' });
                vscode.window.showInformationMessage('Successfully deployed automation to dev stage');
                // SSE will push the fresh `automations` snapshot to update views.
            } else {
                throw new Error(waitResult.error || `Deployment ${waitResult.outcome}`);
            }
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            outputChannel.appendLine(`Deploy error: ${errorMessage}`);
            vscode.window.showErrorMessage(`Deployment error: ${errorMessage}`);
        }
    });
}


export async function deployFromToolbarCommand(
    context: vscode.ExtensionContext,
    item: vscode.Uri,
    itemSet: string,
) {
    return deployCommandAbstract(context, path.dirname(item.path), itemSet);
}

export async function deployFromNotebookToolbarCommand(
    context: vscode.ExtensionContext,
    item: any,
    itemSet: string,
) {
    return deployCommandAbstract(context, path.dirname(item.notebookEditor.notebookUri.path), itemSet);
}

/**
 * Entry point for the dashboard panel's deploy button. The caller passes a
 * `{ resourceUri }`-shaped object so we don't need a tree-item class.
 */
export async function deployCommand(
    context: vscode.ExtensionContext,
    item: { resourceUri: vscode.Uri },
    itemSet: string,
) {
    return deployCommandAbstract(context, item.resourceUri.fsPath, itemSet);
}

/**
 * Start a live-dev deployment via gitops `/automations/start-deploy` (stage=live-dev).
 * Gitops mounts the source from the bind-mounted workspace, builds the
 * runtime image if a `image/` Dockerfile is present, and runs the container
 * with auto-reload enabled.
 */
export async function startLiveDevServerCommand(
    context: vscode.ExtensionContext,
    folderPath: string,
    worktreeName?: string
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

    let ignorePatterns: string[] | undefined;
    try {
        ignorePatterns = getAutomationDeployConfig(folderPath).ignore;
    } catch (configError: any) {
        vscode.window.showErrorMessage(`Syntax error in automation.toml: ${configError.message}`);
        return;
    }
    if (ignorePatterns && ignorePatterns.length > 0) {
        outputChannel.appendLine(`Ignore patterns from config: ${ignorePatterns.join(', ')}`);
    }

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
            if (token.isCancellationRequested) { return; }

            const { relative_path, worktree: detectedWt } = workspaceRelativePath(workspaceFolders[0].uri.fsPath, folderPath);
            const worktree = worktreeName || detectedWt;

            progress.report({ increment: 30, message: 'Starting live-dev on gitops...' });

            const client = new GitopsClient(details.deployUrl, details.deploySecret);
            const result = await client.startDeploy({
                relative_path,
                stage: 'live-dev',
                ...(worktree ? { worktree } : {}),
            });

            if (!result.ok || !result.body || typeof result.body !== 'object') {
                throw new Error(`Failed to start live-dev: HTTP ${result.status}`);
            }
            const body = result.body as { task_id?: string; deployment_id?: string };
            const taskId = body.task_id;
            const deploymentId = body.deployment_id;
            if (!taskId || !deploymentId) {
                throw new Error('Gitops /start-deploy did not return task_id and deployment_id');
            }

            deployState.markDeploying(deploymentId, taskId);
            progress.report({ increment: 30, message: 'Building and starting container...' });

            const waitResult = await waitForDeployCompletion(deploymentId, taskId, progress, details, 240_000);

            if (waitResult.outcome === 'completed') {
                progress.report({ increment: 100, message: 'Live dev server started!' });
                vscode.window.showInformationMessage(
                    `Live dev server started for ${folderName}. Changes to source files will auto-reload.`
                );
                // SSE pushes the fresh `automations` snapshot.
            } else {
                throw new Error(waitResult.error || `Failed to start live dev server: ${waitResult.outcome}`);
            }
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            outputChannel.appendLine(`Live dev server error: ${errorMessage}`);
            vscode.window.showErrorMessage(`Failed to start live dev server: ${errorMessage}`);
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
