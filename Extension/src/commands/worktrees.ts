import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import axios from 'axios';
import urlJoin from 'proper-url-join';
import { getDeployDetails } from '../deploy_details';
import { getAutomations, deleteAutomation } from '../lib';
import { WorktreesViewProvider } from '../views/worktrees_view';

const WORKSPACE_DIR = '/workspace/workspace';
const WORKTREES_DIR = '/workspace/workspace/worktrees';

function runGit(args: string[], cwd: string = WORKSPACE_DIR): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        cp.execFile('git', args, { cwd }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr.trim() || err.message));
            } else {
                resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
            }
        });
    });
}

export async function deleteWorktreeCommand(
    context: vscode.ExtensionContext,
    item: { name: string },
    worktreesProvider: WorktreesViewProvider,
): Promise<void> {
    if (!item?.name) {
        vscode.window.showErrorMessage('No worktree selected.');
        return;
    }

    const confirmation = await vscode.window.showWarningMessage(
        `Delete worktree "${item.name}"? This action cannot be undone.`,
        { modal: true },
        'Delete'
    );
    if (confirmation !== 'Delete') {
        return;
    }

    try {
        const details = await getDeployDetails(context);

        // Stop all live-dev deployments for this worktree
        if (details) {
            try {
                const automationsUrl = urlJoin(details.deployUrl, 'automations').toString();
                const automations = await getAutomations(automationsUrl, details.deploySecret);
                const wtDeployments = automations.filter((a: any) => {
                    const relPath = a.relative_path || a.relativePath || '';
                    return relPath.startsWith(`worktrees/${item.name}/`);
                });
                for (const dep of wtDeployments) {
                    const depId = dep.deployment_id || dep.deploymentId;
                    try {
                        const deleteUrl = urlJoin(details.deployUrl, 'automations', depId).toString();
                        await deleteAutomation(deleteUrl, details.deploySecret);
                    } catch { /* best effort */ }
                }
            } catch { /* best effort — continue with deletion */ }
        }

        // Close any agent terminal sessions for this worktree
        const terminalPrefix = `Agent: ${item.name}`;
        for (const terminal of vscode.window.terminals) {
            if (terminal.name === terminalPrefix || terminal.name.startsWith(terminalPrefix)) {
                terminal.dispose();
            }
        }

        if (details) {
            try {
                const url = urlJoin(details.deployUrl, 'worktrees', item.name);
                await axios.delete(url, {
                    headers: { Authorization: `Bearer ${details.deploySecret}` },
                });
                vscode.window.showInformationMessage(`Worktree "${item.name}" deleted.`);
                worktreesProvider.refresh();
                return;
            } catch (apiErr: any) {
                if (apiErr?.response?.status !== 404) {
                    const msg = apiErr?.response?.data?.detail || apiErr?.message || apiErr;
                    vscode.window.showErrorMessage(`Failed to delete worktree: ${msg}`);
                    return;
                }
            }
        }

        // Fallback: local git
        const worktreePath = path.join(WORKTREES_DIR, item.name);
        await runGit(['worktree', 'remove', worktreePath, '--force']);
        await runGit(['branch', '-D', item.name]).catch(() => {});
        vscode.window.showInformationMessage(`Worktree "${item.name}" deleted.`);
        worktreesProvider.refresh();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to delete worktree: ${error?.message || error}`);
    }
}
