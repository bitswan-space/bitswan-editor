import * as vscode from "vscode";

export async function jumpToCell() {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) {
        vscode.window.showWarningMessage("No active notebook editor");
        return;
    }

    const cellCount = editor.notebook.cellCount;
    const input = await vscode.window.showInputBox({
        prompt: `Enter cell number (1-${cellCount})`,
        validateInput: (value) => {
            const num = parseInt(value, 10);
            if (isNaN(num) || num < 1 || num > cellCount) {
                return `Enter a number between 1 and ${cellCount}`;
            }
            return undefined;
        },
    });

    if (input === undefined) {
        return; // cancelled
    }

    const cellIndex = parseInt(input, 10) - 1; // convert 1-based to 0-based
    const range = new vscode.NotebookRange(cellIndex, cellIndex + 1);
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
    // Select the cell
    editor.selections = [range];
}
