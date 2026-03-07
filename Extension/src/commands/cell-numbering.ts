import * as vscode from 'vscode';

export class CellNumberProvider implements vscode.NotebookCellStatusBarItemProvider {
    onDidChangeCellStatusBarItems?: vscode.Event<void>;

    provideCellStatusBarItems(
        cell: vscode.NotebookCell
    ): vscode.NotebookCellStatusBarItem[] {
        const item = new vscode.NotebookCellStatusBarItem(
            `Cell ${cell.index + 1}`,
            vscode.NotebookCellStatusBarAlignment.Left
        );
        item.priority = 1000; // High priority to show first
        return [item];
    }
}

export function registerCellNumbering(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.notebooks.registerNotebookCellStatusBarItemProvider(
            'jupyter-notebook',
            new CellNumberProvider()
        )
    );
}
