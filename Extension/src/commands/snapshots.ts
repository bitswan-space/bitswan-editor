import * as vscode from 'vscode';
import { GitOpsItem } from '../views/workspaces_view';
import { SnapshotsViewProvider, SnapshotItem, StageGroupItem } from '../views/snapshots_view';
import { StageItem } from '../views/unified_business_processes_view';
import {
    createSnapshot,
    cloneSnapshot,
    deleteSnapshot,
    estimateSnapshotSize,
    resumeSnapshotTarget,
} from '../lib';
import { snapshotState } from '../services/snapshot_state';
import { setRefreshPaused, outputChannel } from '../extension';
import { SnapshotTask } from '../types';

const VALID_STAGES = ['dev', 'staging', 'production'] as const;
type ValidStage = (typeof VALID_STAGES)[number];

function humanSize(bytes: number): string {
    if (bytes === 0) { return '0 B'; }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function getActiveInstance(context: vscode.ExtensionContext): GitOpsItem | undefined {
    return context.globalState.get<GitOpsItem>('activeGitOpsInstance');
}

/**
 * Poll the in-memory snapshot state until the task reaches a terminal state.
 * Returns the final task or undefined if it times out.
 */
async function waitForTask(taskId: string, timeoutMs = 300_000): Promise<SnapshotTask | undefined> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
        const check = () => {
            const task = snapshotState.getTask(taskId);
            if (task && (task.status === 'success' || task.status === 'error')) {
                resolve(task);
                return;
            }
            if (Date.now() > deadline) {
                resolve(undefined);
                return;
            }
            setTimeout(check, 500);
        };
        check();
    });
}

export async function createSnapshotCommand(
    context: vscode.ExtensionContext,
    provider: SnapshotsViewProvider,
    item?: StageItem | StageGroupItem | any,
): Promise<void> {
    const activeInstance = getActiveInstance(context);
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance selected');
        return;
    }

    // Determine source stage from the tree item or ask
    let stage: string | undefined;
    if (item instanceof StageItem) {
        stage = item.stage === 'live-dev' ? 'dev' : item.stage;
    } else if (item instanceof StageGroupItem) {
        stage = item.stage;
    } else {
        stage = await vscode.window.showQuickPick(
            [...VALID_STAGES],
            { placeHolder: 'Select the stage to snapshot' },
        );
    }
    if (!stage) { return; }

    // For production: show size estimate and confirm
    if (stage === 'production') {
        try {
            const sizes = await estimateSnapshotSize(activeInstance.url, activeInstance.secret, stage);
            const total = humanSize(sizes.total);
            const confirmed = await vscode.window.showWarningMessage(
                `Snapshot production stage? Estimated size: ${total} (Postgres: ${humanSize(sizes.postgres)}, CouchDB: ${humanSize(sizes.couchdb)}, MinIO: ${humanSize(sizes.minio)})`,
                { modal: true },
                'Snapshot',
            );
            if (confirmed !== 'Snapshot') { return; }
        } catch {
            // Estimate failed — proceed anyway
        }
    }

    const name = await vscode.window.showInputBox({
        prompt: 'Snapshot name (optional)',
        placeHolder: 'Leave blank for no name',
    });
    if (name === undefined) { return; } // ESC

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Snapshotting ${stage}…`, cancellable: false },
        async (progress) => {
            setRefreshPaused(true);
            try {
                const { task_id } = await createSnapshot(activeInstance.url, activeInstance.secret, stage!, name || undefined);
                const disposable = snapshotState.attachToProgress(task_id, progress);
                try {
                    const task = await waitForTask(task_id);
                    if (!task || task.status !== 'success') {
                        vscode.window.showErrorMessage(`Snapshot failed: ${task?.error ?? 'unknown error'}`);
                    } else {
                        vscode.window.showInformationMessage(`Snapshot of ${stage} created.`);
                        provider.refresh();
                    }
                } finally {
                    disposable.dispose();
                }
            } catch (err: any) {
                outputChannel.appendLine(`Snapshot create error: ${err.message}`);
                vscode.window.showErrorMessage(`Snapshot create failed: ${err.message}`);
            } finally {
                setRefreshPaused(false);
            }
        },
    );
}

export async function cloneSnapshotCommand(
    context: vscode.ExtensionContext,
    provider: SnapshotsViewProvider,
    item?: SnapshotItem,
): Promise<void> {
    const activeInstance = getActiveInstance(context);
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance selected');
        return;
    }

    if (!item || !(item instanceof SnapshotItem)) {
        vscode.window.showErrorMessage('Select a snapshot to clone');
        return;
    }

    const targetStage = await vscode.window.showQuickPick(
        [...VALID_STAGES],
        { placeHolder: 'Clone into which stage?' },
    );
    if (!targetStage) { return; }

    // Warn that target will briefly stop
    const confirmStop = await vscode.window.showWarningMessage(
        `Clone "${item.snapshot.snapshot_id}" into ${targetStage}? Automations in ${targetStage} will be briefly stopped during restore.`,
        { modal: true },
        'Clone',
    );
    if (confirmStop !== 'Clone') { return; }

    let confirmProduction = false;
    if (targetStage === 'production') {
        const second = await vscode.window.showWarningMessage(
            'You are about to overwrite PRODUCTION data. This cannot be undone.',
            { modal: true },
            'I understand, proceed',
        );
        if (second !== 'I understand, proceed') { return; }
        confirmProduction = true;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Cloning snapshot into ${targetStage}…`, cancellable: false },
        async (progress) => {
            setRefreshPaused(true);
            try {
                const { task_id } = await cloneSnapshot(
                    activeInstance.url,
                    activeInstance.secret,
                    item.snapshot.snapshot_id,
                    targetStage,
                    confirmProduction,
                );
                const disposable = snapshotState.attachToProgress(task_id, progress);
                try {
                    const task = await waitForTask(task_id);
                    if (!task) {
                        vscode.window.showErrorMessage('Clone timed out');
                    } else if (task.status === 'error') {
                        // Offer "Resume target" if there were partial failures
                        const failedServices = Object.entries(task.per_service_errors ?? {})
                            .filter(([, v]) => v !== null)
                            .map(([k]) => k);
                        const msg = failedServices.length
                            ? `Clone partially failed (${failedServices.join(', ')}). Target stage is stopped.`
                            : `Clone failed: ${task.error}`;
                        const action = failedServices.length
                            ? await vscode.window.showErrorMessage(msg, 'Resume target')
                            : (vscode.window.showErrorMessage(msg), undefined);
                        if (action === 'Resume target') {
                            try {
                                await resumeSnapshotTarget(activeInstance.url, activeInstance.secret, task_id);
                                vscode.window.showInformationMessage('Target automations restarted.');
                            } catch (resumeErr: any) {
                                vscode.window.showErrorMessage(`Resume failed: ${resumeErr.message}`);
                            }
                        }
                    } else {
                        vscode.window.showInformationMessage(`Clone into ${targetStage} completed.`);
                    }
                    provider.refresh();
                } finally {
                    disposable.dispose();
                }
            } catch (err: any) {
                outputChannel.appendLine(`Snapshot clone error: ${err.message}`);
                vscode.window.showErrorMessage(`Clone failed: ${err.message}`);
            } finally {
                setRefreshPaused(false);
            }
        },
    );
}

export async function deleteSnapshotCommand(
    context: vscode.ExtensionContext,
    provider: SnapshotsViewProvider,
    item?: SnapshotItem,
): Promise<void> {
    const activeInstance = getActiveInstance(context);
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance selected');
        return;
    }

    if (!item || !(item instanceof SnapshotItem)) {
        vscode.window.showErrorMessage('Select a snapshot to delete');
        return;
    }

    const label = item.snapshot.name ?? item.snapshot.snapshot_id;
    const confirmed = await vscode.window.showWarningMessage(
        `Delete snapshot "${label}"? This cannot be undone.`,
        { modal: true },
        'Delete',
    );
    if (confirmed !== 'Delete') { return; }

    try {
        await deleteSnapshot(activeInstance.url, activeInstance.secret, item.snapshot.snapshot_id);
        vscode.window.showInformationMessage(`Snapshot "${label}" deleted.`);
        provider.refresh();
    } catch (err: any) {
        outputChannel.appendLine(`Snapshot delete error: ${err.message}`);
        vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
    }
}
