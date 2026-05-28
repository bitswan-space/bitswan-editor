import * as vscode from 'vscode';
import urlJoin from 'proper-url-join';
import axios from 'axios';
import { getDeployDetails } from '../deploy_details';
import { deleteAutomation } from '../lib';

/**
 * Delete a worktree via gitops. Gitops handles the full teardown (git worktree
 * remove, branch -D, postgres cleanup, etc.); SSE then broadcasts the updated
 * `worktrees` snapshot to refresh the dashboard.
 */
export async function deleteWorktreeCommand(
    context: vscode.ExtensionContext,
    item: { name: string },
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

    const details = await getDeployDetails(context);
    if (!details) {
        vscode.window.showErrorMessage('No GitOps instance configured.');
        return;
    }

    try {
        // Stop any live-dev deployments rooted in this worktree, using the
        // SSE-cached automations snapshot.
        const automations = context.globalState.get<any[]>('automations', []);
        const wtDeployments = automations.filter((a: any) => {
            const relPath = a.relative_path || a.relativePath || '';
            return relPath.startsWith(`worktrees/${item.name}/`);
        });
        for (const dep of wtDeployments) {
            const depId = dep.deployment_id || dep.deploymentId;
            if (!depId) { continue; }
            try {
                const deleteUrl = urlJoin(details.deployUrl, 'automations', depId).toString();
                await deleteAutomation(deleteUrl, details.deploySecret);
            } catch { /* best effort */ }
        }

        // Close any agent terminals associated with this worktree.
        const terminalPrefix = `Agent: ${item.name}`;
        for (const terminal of vscode.window.terminals) {
            if (terminal.name === terminalPrefix || terminal.name.startsWith(terminalPrefix)) {
                terminal.dispose();
            }
        }

        const url = urlJoin(details.deployUrl, 'worktrees', item.name);
        await axios.delete(url, {
            headers: { Authorization: `Bearer ${details.deploySecret}` },
        });
        vscode.window.showInformationMessage(`Worktree "${item.name}" deleted.`);
    } catch (error: any) {
        const msg = error?.response?.data?.detail || error?.message || String(error);
        vscode.window.showErrorMessage(`Failed to delete worktree: ${msg}`);
    }
}
