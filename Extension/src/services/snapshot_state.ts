import * as vscode from 'vscode';
import { SnapshotTask } from '../types';

type SnapshotStateListener = (task: SnapshotTask) => void;

/**
 * Tracks in-flight snapshot operations and broadcasts progress to UI
 * consumers (progress reporters, tree views).
 *
 * Parallel to deploy_state.ts — driven by `snapshot_progress` SSE events.
 */
export class SnapshotStateTracker {
    private _tasks = new Map<string, SnapshotTask>();
    private _listeners = new Set<SnapshotStateListener>();
    private _onChangeEmitter = new vscode.EventEmitter<void>();
    readonly onChange = this._onChangeEmitter.event;

    applyProgress(task: SnapshotTask): void {
        this._tasks.set(task.task_id, task);
        this._notifyListeners(task);
        this._onChangeEmitter.fire();
    }

    getTask(taskId: string): SnapshotTask | undefined {
        return this._tasks.get(taskId);
    }

    getActive(): SnapshotTask[] {
        return [...this._tasks.values()].filter(
            (t) => t.status === 'pending' || t.status === 'running',
        );
    }

    /**
     * Wire a `vscode.Progress` reporter to the named task.
     * Fires the reporter each time the task advances a step.
     * Returns a `vscode.Disposable` that stops listening.
     */
    attachToProgress(
        taskId: string,
        reporter: vscode.Progress<{ message?: string; increment?: number }>,
    ): vscode.Disposable {
        const disposable = this.addListener((task) => {
            if (task.task_id !== taskId) {
                return;
            }
            const msg = task.step
                ? `${task.step.replace(/_/g, ' ')}${task.message ? ': ' + task.message : ''}`
                : task.message;
            reporter.report({ message: msg });
        });
        return disposable;
    }

    addListener(cb: SnapshotStateListener): vscode.Disposable {
        this._listeners.add(cb);
        return new vscode.Disposable(() => this._listeners.delete(cb));
    }

    private _notifyListeners(task: SnapshotTask): void {
        for (const listener of this._listeners) {
            try {
                listener(task);
            } catch {
                // ignore listener errors
            }
        }
    }

    dispose(): void {
        this._onChangeEmitter.dispose();
        this._listeners.clear();
        this._tasks.clear();
    }
}

export const snapshotState = new SnapshotStateTracker();
