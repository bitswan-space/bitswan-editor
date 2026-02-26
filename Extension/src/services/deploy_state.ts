import * as vscode from 'vscode';

export interface DeployProgressEvent {
    task_id: string;
    deployment_id: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    step: string | null;
    message: string;
    error: string | null;
}

type DeployListener = (event: DeployProgressEvent) => void;

/**
 * Tracks in-flight deploys so the UI can guard against double-clicks
 * and show real-time progress from SSE deploy_progress events.
 */
export class DeployStateTracker {
    private _deployingDeployments = new Map<string, DeployProgressEvent>();
    private _listeners = new Set<DeployListener>();
    private _onChangeEmitter = new vscode.EventEmitter<void>();
    readonly onChange = this._onChangeEmitter.event;

    isDeploying(deploymentId: string): boolean {
        return this._deployingDeployments.has(deploymentId);
    }

    getTaskId(deploymentId: string): string | undefined {
        return this._deployingDeployments.get(deploymentId)?.task_id;
    }

    /** Called by SSE client when a deploy_progress event arrives. */
    handleDeployProgress(event: DeployProgressEvent): void {
        if (event.status === 'completed' || event.status === 'failed') {
            this._deployingDeployments.delete(event.deployment_id);
        } else {
            this._deployingDeployments.set(event.deployment_id, event);
        }
        this._notifyListeners(event);
        this._onChangeEmitter.fire();
    }

    /** Optimistically mark a deployment as deploying before the first SSE event arrives. */
    markDeploying(deploymentId: string, taskId: string): void {
        const event: DeployProgressEvent = {
            task_id: taskId,
            deployment_id: deploymentId,
            status: 'pending',
            step: null,
            message: 'Starting deployment...',
            error: null,
        };
        this._deployingDeployments.set(deploymentId, event);
        this._notifyListeners(event);
        this._onChangeEmitter.fire();
    }

    addListener(cb: DeployListener): vscode.Disposable {
        this._listeners.add(cb);
        return new vscode.Disposable(() => this._listeners.delete(cb));
    }

    private _notifyListeners(event: DeployProgressEvent): void {
        for (const listener of this._listeners) {
            try {
                listener(event);
            } catch {
                // Ignore listener errors
            }
        }
    }

    dispose(): void {
        this._onChangeEmitter.dispose();
        this._listeners.clear();
        this._deployingDeployments.clear();
    }
}

/** Singleton instance shared across the extension. */
export const deployState = new DeployStateTracker();
