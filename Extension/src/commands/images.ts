import * as vscode from 'vscode';
import urlJoin from 'proper-url-join';
import { ImageItem } from '../views/unified_images_view';
import { getImageLogs, getImages } from '../lib';
import { UnifiedImagesViewProvider, OrphanedImagesViewProvider } from '../views/unified_images_view';
import { showLogsCommand, refreshItemsCommand, RefreshOptions } from './items';
import { GitOpsItem } from '../views/workspaces_view';

export async function showImageLogsCommand(context: vscode.ExtensionContext, treeDataProvider: any, item: ImageItem) {
    return showLogsCommand(context, treeDataProvider, item, {
        entityType: 'image build process',
        getLogsFunction: getImageLogs
    });
}

export async function refreshImagesCommand(context: vscode.ExtensionContext, treeDataProvider: any, options?: RefreshOptions) {
    return refreshItemsCommand(context, treeDataProvider, {
        entityType: 'image',
        getItemsFunction: getImages
    }, options);
}

export async function openImageDetailsCommand(context: vscode.ExtensionContext, item: ImageItem) {
    if (!item) {
        vscode.window.showErrorMessage('No image selected');
        return;
    }

    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'bitswan-image-details',
        `Image: ${item.name}`,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    let logsContent = 'No logs available for this image.';

    try {
        const logsUri = urlJoin(activeInstance.url, 'images', item.urlSlug(), 'logs').toString();
        const logsResponse = await getImageLogs(logsUri, activeInstance.secret);
        logsContent = formatLogsResponse(logsResponse);
    } catch (error: any) {
        const message = error?.message ?? String(error);
        logsContent = `Failed to fetch logs: ${message}`;
    }

    panel.webview.html = buildImageDetailsHtml(item, logsContent);

    panel.webview.onDidReceiveMessage((message) => {
        if (!message || !message.type) {
            return;
        }

        switch (message.type) {
            case 'copySuccess':
                vscode.window.showInformationMessage('Build logs copied to clipboard');
                break;
            case 'copyFailure':
                vscode.window.showErrorMessage(`Failed to copy logs: ${message.message || 'Unknown error'}`);
                break;
            case 'searchNotFound':
                if (message.query) {
                    vscode.window.showWarningMessage(`"${message.query}" not found in logs`);
                }
                break;
            default:
                break;
        }
    });
}

const formatLogsResponse = (logsResponse: any): string => {
    if (!logsResponse) {
        return 'No logs available.';
    }

    if (typeof logsResponse === 'string') {
        return logsResponse;
    }

    if (Array.isArray(logsResponse)) {
        return logsResponse.join('\n');
    }

    if (Array.isArray(logsResponse.logs)) {
        return logsResponse.logs.join('\n');
    }

    return JSON.stringify(logsResponse, null, 2);
};

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const formatDate = (value?: string | null): string => {
    if (!value) {
        return 'Unknown';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const humanReadableBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return `${bytes}`;
    }
    if (bytes === 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 2)} ${units[exponent]}`;
};

const formatSize = (value?: string | number | null): string => {
    if (value === undefined || value === null || value === '') {
        return 'Unknown';
    }

    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isNaN(numeric)) {
        return humanReadableBytes(numeric);
    }

    return String(value);
};

function buildImageDetailsHtml(item: ImageItem, logs: string): string {
    const metadata = item.metadata ?? {};
    const detailRows = [
        { label: 'Tag', value: item.name },
        { label: 'Source Folder', value: item.sourceName ?? 'Unknown' },
        { label: 'Build Time', value: formatDate(item.buildTime || metadata.created) },
        { label: 'Size', value: formatSize(metadata.size ?? item.size) },
        { label: 'Owner', value: item.owner }
    ]
        .map(detail => `
            <div class="detail">
                <span>${escapeHtml(detail.label)}</span>
                <p>${escapeHtml(String(detail.value))}</p>
            </div>
        `)
        .join('');

    const escapedLogs = escapeHtml(logs);

    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        :root {
            color-scheme: light dark;
            font-family: var(--vscode-font-family, sans-serif);
        }
        body {
            margin: 0;
            padding: 0;
            font-size: 13px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .container {
            padding: 16px 24px 24px;
            max-width: 960px;
            margin: 0 auto;
        }
        h2 {
            margin-top: 0;
            font-size: 20px;
        }
        .details-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 12px;
            margin-bottom: 24px;
        }
        .detail {
            padding: 12px;
            border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.1));
            border-radius: 6px;
            background: var(--vscode-editorWidget-background, rgba(255,255,255,0.02));
        }
        .detail span {
            display: block;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .detail p {
            margin: 0;
            font-size: 13px;
            word-break: break-all;
        }
        .logs-section {
            margin-top: 16px;
        }
        .logs-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            gap: 8px;
            flex-wrap: wrap;
        }
        .logs-header h3 {
            margin: 0;
            font-size: 16px;
        }
        .logs-actions {
            display: flex;
            gap: 8px;
            align-items: center;
            flex-wrap: wrap;
        }
        .logs-actions input {
            padding: 4px 8px;
            min-width: 160px;
            border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.2));
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        .logs-actions button {
            padding: 4px 10px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.1));
            color: var(--vscode-button-secondaryForeground, inherit);
            cursor: pointer;
        }
        .logs-actions button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        textarea {
            width: 100%;
            min-height: 320px;
            resize: vertical;
            border-radius: 6px;
            border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.1));
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 12px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 12px);
            line-height: 1.4;
            box-sizing: border-box;
            white-space: pre;
        }
    </style>
</head>
<body>
    <div class="container">
        <h2>${escapeHtml(item.name)}</h2>
        <div class="details-grid">
            ${detailRows}
        </div>
        <section class="logs-section">
            <div class="logs-header">
                <h3>Build Logs</h3>
                <div class="logs-actions">
                    <input id="searchInput" type="text" placeholder="Search logs..." />
                    <button id="searchBtn">Search</button>
                    <button id="copyLogsBtn" class="primary">Copy Logs</button>
                </div>
            </div>
            <textarea id="logsBox" readonly spellcheck="false">${escapedLogs}</textarea>
        </section>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const textarea = document.getElementById('logsBox');
        const searchInput = document.getElementById('searchInput');
        const searchBtn = document.getElementById('searchBtn');
        const copyBtn = document.getElementById('copyLogsBtn');
        let lastIndex = -1;

        function performSearch() {
            const query = searchInput.value.trim();
            if (!query) {
                lastIndex = -1;
                return;
            }

            const text = textarea.value;
            const lowerText = text.toLowerCase();
            const lowerQuery = query.toLowerCase();

            let nextIndex = lowerText.indexOf(lowerQuery, lastIndex + 1);
            if (nextIndex === -1) {
                nextIndex = lowerText.indexOf(lowerQuery);
            }

            if (nextIndex === -1) {
                vscode.postMessage({ type: 'searchNotFound', query });
                return;
            }

            textarea.focus();
            textarea.setSelectionRange(nextIndex, nextIndex + query.length);
            const ratio = nextIndex / Math.max(text.length, 1);
            textarea.scrollTop = ratio * (textarea.scrollHeight - textarea.clientHeight);
            lastIndex = nextIndex;
        }

        searchBtn.addEventListener('click', performSearch);
        searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                performSearch();
            }
        });

        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(textarea.value);
                vscode.postMessage({ type: 'copySuccess' });
            } catch (error) {
                vscode.postMessage({ type: 'copyFailure', message: error?.message || String(error) });
            }
        });
    </script>
</body>
</html>
    `;
}
