import * as vscode from 'vscode';
import { getAssetDiff } from '../lib';

export async function openDiffViewerPanel(
    context: vscode.ExtensionContext,
    details: { deployUrl: string; deploySecret: string },
    fromChecksum: string,
    toChecksum: string,
    fromLabel: string,
    toLabel: string
) {
    const panel = vscode.window.createWebviewPanel(
        'assetDiffViewer',
        `Diff: ${fromLabel} → ${toLabel}`,
        vscode.ViewColumn.Two,
        { enableScripts: true }
    );

    let wordDiff = false;

    async function updateContent() {
        panel.webview.html = getDiffHtml(fromLabel, toLabel, fromChecksum, toChecksum, null, wordDiff, false);

        try {
            const result = await getAssetDiff(
                details.deployUrl,
                details.deploySecret,
                fromChecksum,
                toChecksum,
                wordDiff
            );
            panel.webview.html = getDiffHtml(fromLabel, toLabel, fromChecksum, toChecksum, result, wordDiff, false);
        } catch (err: any) {
            panel.webview.html = getDiffHtml(fromLabel, toLabel, fromChecksum, toChecksum, null, wordDiff, true, err.message || 'Unknown error');
        }
    }

    panel.webview.onDidReceiveMessage(
        async (message) => {
            if (message.command === 'toggleWordDiff') {
                wordDiff = !wordDiff;
                await updateContent();
            }
        },
        undefined,
        context.subscriptions
    );

    await updateContent();
}

function getDiffHtml(
    fromLabel: string,
    toLabel: string,
    fromChecksum: string,
    toChecksum: string,
    result: { diff: string; identical: boolean; truncated: boolean } | null,
    wordDiff: boolean,
    isError: boolean,
    errorMessage?: string
): string {
    const shortFrom = fromChecksum.substring(0, 8);
    const shortTo = toChecksum.substring(0, 8);

    let bodyContent: string;

    if (isError) {
        bodyContent = `<div class="error">Error loading diff: ${escapeHtml(errorMessage || 'Unknown error')}</div>`;
    } else if (result === null) {
        bodyContent = `<div class="loading"><div class="spinner"></div>Loading diff...</div>`;
    } else if (result.identical) {
        bodyContent = `<div class="identical">Versions are identical</div>`;
    } else {
        const diffHtml = wordDiff ? renderWordDiff(result.diff) : renderDiff(result.diff);
        const truncationWarning = result.truncated
            ? `<div class="truncation-warning">Diff output was truncated (exceeds 1MB). Some changes may not be shown.</div>`
            : '';
        bodyContent = truncationWarning + `<pre class="diff-content">${diffHtml}</pre>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 16px;
            margin: 0;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header-title {
            font-size: 14px;
            font-weight: bold;
        }
        .header-checksums {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        .toggle-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 2px;
            font-size: 12px;
        }
        .toggle-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .toggle-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .diff-content {
            margin: 0;
            white-space: pre-wrap;
            word-wrap: break-word;
            line-height: 1.5;
        }
        .diff-line-file {
            font-weight: bold;
            color: var(--vscode-foreground);
        }
        .diff-line-hunk {
            color: var(--vscode-textLink-foreground);
        }
        .diff-line-add {
            background-color: var(--vscode-diffEditor-insertedTextBackground);
        }
        .diff-line-del {
            background-color: var(--vscode-diffEditor-removedTextBackground);
        }
        .word-add {
            background-color: var(--vscode-diffEditor-insertedTextBackground);
            font-weight: bold;
        }
        .word-del {
            background-color: var(--vscode-diffEditor-removedTextBackground);
            font-weight: bold;
            text-decoration: line-through;
        }
        .loading {
            display: flex;
            align-items: center;
            gap: 10px;
            color: var(--vscode-descriptionForeground);
            padding: 20px;
        }
        .spinner {
            width: 16px;
            height: 16px;
            border: 2px solid var(--vscode-descriptionForeground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .identical {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 14px;
        }
        .error {
            padding: 20px;
            color: var(--vscode-errorForeground);
        }
        .truncation-warning {
            background-color: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
            padding: 8px 12px;
            margin-bottom: 12px;
            border-radius: 4px;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <div class="header-title">${escapeHtml(fromLabel)} → ${escapeHtml(toLabel)}</div>
            <div class="header-checksums">${shortFrom} → ${shortTo}</div>
        </div>
        <button class="toggle-btn ${wordDiff ? 'active' : ''}" onclick="toggleWordDiff()">
            Word Diff ${wordDiff ? 'ON' : 'OFF'}
        </button>
    </div>
    ${bodyContent}
    <script>
        const vscode = acquireVsCodeApi();
        function toggleWordDiff() {
            vscode.postMessage({ command: 'toggleWordDiff' });
        }
    </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderDiff(diff: string): string {
    return diff.split('\n').map(line => {
        const escaped = escapeHtml(line);
        if (line.startsWith('diff --no-index') || line.startsWith('diff --git')) {
            return `<span class="diff-line-file">${escaped}</span>`;
        } else if (line.startsWith('@@')) {
            return `<span class="diff-line-hunk">${escaped}</span>`;
        } else if (line.startsWith('+')) {
            return `<span class="diff-line-add">${escaped}</span>`;
        } else if (line.startsWith('-')) {
            return `<span class="diff-line-del">${escaped}</span>`;
        }
        return escaped;
    }).join('\n');
}

function renderWordDiff(diff: string): string {
    return diff.split('\n').map(line => {
        const escaped = escapeHtml(line);
        if (line.startsWith('diff --no-index') || line.startsWith('diff --git')) {
            return `<span class="diff-line-file">${escaped}</span>`;
        } else if (line.startsWith('@@')) {
            return `<span class="diff-line-hunk">${escaped}</span>`;
        }
        // Parse word diff markers: {+...+} and [-...-]
        const withMarkers = escaped
            .replace(/\{\+(.+?)\+\}/g, '<span class="word-add">$1</span>')
            .replace(/\[-(.+?)-\]/g, '<span class="word-del">$1</span>');
        return withMarkers;
    }).join('\n');
}
