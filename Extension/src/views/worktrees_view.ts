import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import urlJoin from 'proper-url-join';
import { getDeployDetails } from '../deploy_details';

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

export class WorktreeItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly branch: string,
        public readonly lastCommit: string,
        public readonly hasRequirements: boolean
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);
        this.id = `wt:${name}`;
        this.description = branch;
        this.tooltip = `${name}\nBranch: ${branch}\nLast commit: ${lastCommit}`;
        this.contextValue = 'worktreeItem';
        this.iconPath = new vscode.ThemeIcon('git-branch');

        if (hasRequirements) {
            this.description = `${branch} (has requirements)`;
        }
    }
}

export class WorktreesViewProvider implements vscode.TreeDataProvider<WorktreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<WorktreeItem | undefined | null | void> =
        new vscode.EventEmitter<WorktreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<WorktreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: WorktreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: WorktreeItem): Promise<WorktreeItem[]> {
        if (element) {
            return [];
        }

        // Try gitops API first
        const details = await getDeployDetails(this.context);
        if (details) {
            try {
                const url = urlJoin(details.deployUrl, 'worktrees/');
                const response = await axios.get(url, {
                    headers: { Authorization: `Bearer ${details.deploySecret}` },
                });

                const worktrees: any[] = response.data;
                return worktrees.map((wt: any) => new WorktreeItem(
                    wt.name || 'unknown',
                    wt.branch || 'unknown',
                    wt.commit_message || wt.last_commit || wt.lastCommit || '',
                    wt.has_requirements || wt.hasRequirements || false
                ));
            } catch (apiErr: any) {
                // If 404, fall through to local git
                if (apiErr?.response?.status !== 404) {
                    // For other errors (network, auth), still try local fallback
                }
            }
        }

        // Fallback: list worktrees from local filesystem + git
        return this._getWorktreesFromLocal();
    }

    private async _getWorktreesFromLocal(): Promise<WorktreeItem[]> {
        if (!fs.existsSync(WORKTREES_DIR)) {
            return [];
        }

        const entries = fs.readdirSync(WORKTREES_DIR, { withFileTypes: true });
        const items: WorktreeItem[] = [];

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === 'worktrees') {
                continue;
            }

            const name = entry.name;
            const wtPath = path.join(WORKTREES_DIR, name);
            let branch = name;
            let lastCommit = '';

            try {
                const { stdout: branchOut } = await runGit(
                    ['rev-parse', '--abbrev-ref', 'HEAD'], wtPath
                );
                branch = branchOut || name;
            } catch {
                // ignore
            }

            try {
                const { stdout: logOut } = await runGit(
                    ['log', '-1', '--format=%s'], wtPath
                );
                lastCommit = logOut;
            } catch {
                // ignore
            }

            const hasRequirements = fs.existsSync(
                path.join(wtPath, '.requirements.json')
            );

            items.push(new WorktreeItem(name, branch, lastCommit, hasRequirements));
        }

        return items;
    }
}
