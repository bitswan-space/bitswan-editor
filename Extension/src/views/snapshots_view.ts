import * as vscode from 'vscode';
import { Snapshot } from '../types';

function humanSize(bytes: number): string {
    if (bytes === 0) { return '0 B'; }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function relativeTime(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffMin = Math.round(diffMs / 60_000);
    if (diffMin < 1) { return 'just now'; }
    if (diffMin < 60) { return `${diffMin}m ago`; }
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) { return `${diffH}h ago`; }
    return `${Math.round(diffH / 24)}d ago`;
}

export class StageGroupItem extends vscode.TreeItem {
    constructor(public readonly stage: string) {
        super(stage, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'stage-group';
        this.iconPath = new vscode.ThemeIcon('server-environment');
    }
}

export class SnapshotItem extends vscode.TreeItem {
    constructor(public readonly snapshot: Snapshot) {
        const label = snapshot.name ?? snapshot.snapshot_id;
        super(label, vscode.TreeItemCollapsibleState.None);

        const size = humanSize(snapshot.sizes_bytes?.total ?? 0);
        const time = relativeTime(snapshot.created_at);
        this.description = `${time} · ${size}`;

        this.tooltip = [
            `ID: ${snapshot.snapshot_id}`,
            `Stage: ${snapshot.source_stage}`,
            `Created: ${snapshot.created_at}`,
            `Size: ${size}`,
            `Postgres: ${humanSize(snapshot.sizes_bytes?.postgres ?? 0)}`,
            `CouchDB: ${humanSize(snapshot.sizes_bytes?.couchdb ?? 0)}`,
            `MinIO: ${humanSize(snapshot.sizes_bytes?.minio ?? 0)}`,
        ].join('\n');

        this.contextValue = 'snapshot';
        this.iconPath = new vscode.ThemeIcon('database');
        this.id = `snap:${snapshot.snapshot_id}`;
    }
}

type SnapshotTreeItem = StageGroupItem | SnapshotItem;

export class SnapshotsViewProvider implements vscode.TreeDataProvider<SnapshotTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SnapshotTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _snapshots: Snapshot[] = [];

    setSnapshots(snapshots: Snapshot[]): void {
        this._snapshots = snapshots;
        this._onDidChangeTreeData.fire();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SnapshotTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SnapshotTreeItem): SnapshotTreeItem[] {
        if (!element) {
            // Root: one node per stage that has snapshots
            const stages = [...new Set(this._snapshots.map((s) => s.source_stage))];
            stages.sort();
            return stages.map((s) => new StageGroupItem(s));
        }

        if (element instanceof StageGroupItem) {
            return this._snapshots
                .filter((s) => s.source_stage === element.stage)
                .map((s) => new SnapshotItem(s));
        }

        return [];
    }
}
