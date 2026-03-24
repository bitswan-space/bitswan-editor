import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import urlJoin from 'proper-url-join';
import { getDeployDetails } from '../deploy_details';
import { WorktreeItem, WorktreesViewProvider } from '../views/worktrees_view';
import { getUserEmail } from '../services/user_info';

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

export async function createWorktreeCommand(
    context: vscode.ExtensionContext,
    worktreesProvider: WorktreesViewProvider
): Promise<void> {
    const branchName = await vscode.window.showInputBox({
        prompt: 'Enter branch name for the new worktree',
        placeHolder: 'feature-my-feature',
        validateInput: (value) => {
            if (!value) { return 'Branch name is required'; }
            if (!/^[a-zA-Z0-9][a-zA-Z0-9\-]*$/.test(value)) {
                return 'Branch name must be alphanumeric with hyphens only';
            }
            return null;
        },
    });
    if (!branchName) {
        return;
    }

    try {
        // Try gitops API first
        const details = await getDeployDetails(context);
        if (details) {
            try {
                const url = urlJoin(details.deployUrl, 'worktrees', 'create');
                await axios.post(url, { branch_name: branchName }, {
                    headers: { Authorization: `Bearer ${details.deploySecret}` },
                });
                vscode.window.showInformationMessage(`Worktree created for branch "${branchName}".`);
                worktreesProvider.refresh();
                return;
            } catch (apiErr: any) {
                // If 404, the gitops server doesn't have the worktrees routes yet — fall through to local git
                if (apiErr?.response?.status !== 404) {
                    const msg = apiErr?.response?.data?.detail || apiErr?.message || apiErr;
                    vscode.window.showErrorMessage(`Failed to create worktree: ${msg}`);
                    return;
                }
            }
        }

        // Fallback: local git operations
        // Detect current branch as base
        const { stdout: baseBranch } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);

        // Ensure worktrees directory exists
        if (!fs.existsSync(WORKTREES_DIR)) {
            fs.mkdirSync(WORKTREES_DIR, { recursive: true });
        }

        const worktreePath = path.join(WORKTREES_DIR, branchName);
        if (fs.existsSync(worktreePath)) {
            vscode.window.showErrorMessage(`Worktree "${branchName}" already exists.`);
            return;
        }

        // Create branch from current HEAD
        await runGit(['branch', branchName, baseBranch]);

        // Create worktree
        await runGit(['worktree', 'add', worktreePath, branchName]);

        // Copy CLAUDE.md template if available
        const claudeTemplate = '/etc/bitswan/CLAUDE.md';
        const claudeInWorkspace = path.join(WORKSPACE_DIR, 'CLAUDE.md');
        const claudeDest = path.join(worktreePath, 'CLAUDE.md');
        if (!fs.existsSync(claudeDest)) {
            if (fs.existsSync(claudeTemplate)) {
                fs.copyFileSync(claudeTemplate, claudeDest);
            } else if (fs.existsSync(claudeInWorkspace)) {
                fs.copyFileSync(claudeInWorkspace, claudeDest);
            }
        }

        vscode.window.showInformationMessage(`Worktree created for branch "${branchName}" (based on ${baseBranch}).`);
        worktreesProvider.refresh();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create worktree: ${error?.message || error}`);
    }
}

export async function deleteWorktreeCommand(
    context: vscode.ExtensionContext,
    item: WorktreeItem,
    worktreesProvider: WorktreesViewProvider
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



export async function openAgentTerminalCommand(
    context: vscode.ExtensionContext,
    item: WorktreeItem
): Promise<void> {
    if (!item?.name) {
        vscode.window.showErrorMessage('No worktree selected.');
        return;
    }

    const worktreeName = item.name;
    const workspaceName = process.env.HOSTNAME?.replace('-editor', '') || 'workspace';
    const agentHost = `${workspaceName}-coding-agent`;

    // Check if the coding agent container is reachable
    const reachable = await new Promise<boolean>((resolve) => {
        cp.exec(`getent hosts ${agentHost}`, (err) => resolve(!err));
    });

    if (!reachable) {
        // Try to start the agent automatically via gitops
        const started = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Starting coding agent container...',
            cancellable: false,
        }, async (progress) => {
            const details = await getDeployDetails(context);
            if (!details) { return false; }

            try {
                const url = urlJoin(details.deployUrl, 'worktrees', 'coding-agent', 'ensure');
                await axios.post(url, {}, {
                    headers: { Authorization: `Bearer ${details.deploySecret}` },
                    timeout: 120000,
                });
            } catch (err: any) {
                const msg = err?.response?.data?.detail || err?.message || err;
                vscode.window.showErrorMessage(`Failed to start coding agent: ${msg}`);
                return false;
            }

            // Wait for SSH to become reachable (up to 30s)
            progress.report({ message: 'Waiting for SSH to become ready...' });
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const ready = await new Promise<boolean>((resolve) => {
                    cp.exec(`getent hosts ${agentHost}`, (err) => resolve(!err));
                });
                if (ready) { return true; }
            }

            vscode.window.showErrorMessage('Coding agent started but SSH is not reachable yet. Try again in a few seconds.');
            return false;
        });

        if (!started) { return; }
    }

    const userEmail = await getUserEmail(context) || 'unknown';

    const loggedChoice = await vscode.window.showQuickPick(
        [
            { label: 'Yes', description: 'Record the session for playback', picked: true },
            { label: 'No', description: 'Do not record the session' },
        ],
        { placeHolder: 'Start as logged session?' }
    );
    if (!loggedChoice) {
        return;
    }
    const logged = loggedChoice.label === 'Yes';

    const terminal = vscode.window.createTerminal({
        name: `Agent: ${worktreeName}`,
        shellPath: '/usr/bin/ssh',
        shellArgs: [
            '-i', '/workspace/.ssh/id_ed25519',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'SendEnv=SSH_USER_EMAIL SSH_LOGGED SSH_WORKTREE',
            `agent@${agentHost}`,
        ],
        env: {
            SSH_USER_EMAIL: userEmail,
            SSH_LOGGED: logged ? 'true' : 'false',
            SSH_WORKTREE: worktreeName,
        },
    });
    terminal.show(true);
}

export async function viewWorktreeDiffCommand(
    context: vscode.ExtensionContext,
    item: WorktreeItem
): Promise<void> {
    if (!item?.name) {
        vscode.window.showErrorMessage('No worktree selected.');
        return;
    }

    try {
        // Try gitops API first
        const details = await getDeployDetails(context);
        if (details) {
            try {
                const url = urlJoin(details.deployUrl, 'worktrees', item.name, 'diff');
                const response = await axios.get(url, {
                    headers: { Authorization: `Bearer ${details.deploySecret}` },
                });
                const diffContent = typeof response.data?.diff === 'string' ? response.data.diff : (typeof response.data === 'string' ? response.data : '');
                if (!diffContent.trim()) {
                    vscode.window.showInformationMessage(`Worktree "${item.name}" has no uncommitted changes.`);
                } else {
                    const doc = await vscode.workspace.openTextDocument({ content: diffContent, language: 'diff' });
                    await vscode.window.showTextDocument(doc, { preview: true });
                }
                return;
            } catch (apiErr: any) {
                if (apiErr?.response?.status !== 404) {
                    const msg = apiErr?.response?.data?.detail || apiErr?.message || apiErr;
                    vscode.window.showErrorMessage(`Failed to get worktree diff: ${msg}`);
                    return;
                }
            }
        }

        // Fallback: local git — diff the worktree against current HEAD
        const worktreePath = path.join(WORKTREES_DIR, item.name);
        const { stdout: diffContent } = await runGit(['diff', 'HEAD', '--', '.'], worktreePath);
        if (!diffContent.trim()) {
            vscode.window.showInformationMessage(`Worktree "${item.name}" has no uncommitted changes.`);
        } else {
            const doc = await vscode.workspace.openTextDocument({ content: diffContent, language: 'diff' });
            await vscode.window.showTextDocument(doc, { preview: true });
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to get worktree diff: ${error?.message || error}`);
    }
}
