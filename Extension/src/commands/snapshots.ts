import * as vscode from 'vscode';
import { SnapshotsViewProvider, SnapshotItem } from '../views/snapshots_view';

export async function createSnapshotCommand(
    _context: vscode.ExtensionContext,
    _provider: SnapshotsViewProvider,
    _item?: any,
): Promise<void> {
    // Full implementation in commit 8
    vscode.window.showInformationMessage('Snapshot create — coming soon');
}

export async function cloneSnapshotCommand(
    _context: vscode.ExtensionContext,
    _provider: SnapshotsViewProvider,
    _item?: SnapshotItem,
): Promise<void> {
    // Full implementation in commit 8
    vscode.window.showInformationMessage('Snapshot clone — coming soon');
}

export async function deleteSnapshotCommand(
    _context: vscode.ExtensionContext,
    _provider: SnapshotsViewProvider,
    _item?: SnapshotItem,
): Promise<void> {
    // Full implementation in commit 8
    vscode.window.showInformationMessage('Snapshot delete — coming soon');
}
