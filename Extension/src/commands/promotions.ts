import * as vscode from 'vscode';
import urlJoin from 'proper-url-join';
import { StageItem } from '../views/unified_business_processes_view';
import { getDeployDetails } from '../deploy_details';
import { promoteAutomation, getAutomationHistory } from '../lib';
import { outputChannel } from '../extension';
import { refreshAutomationsCommand, showAutomationLogsCommand } from './automations';
import { UnifiedBusinessProcessesViewProvider } from '../views/unified_business_processes_view';
import { AutomationItem } from '../views/automations_view';
import { AutomationsViewProvider } from '../views/automations_view';

export async function promoteStageCommand(
    context: vscode.ExtensionContext,
    item: StageItem,
    targetStage: 'dev' | 'staging' | 'production',
    provider: UnifiedBusinessProcessesViewProvider
) {
    if (!item) {
        vscode.window.showErrorMessage('No item selected for promotion');
        return;
    }
    
    if (!item.automation) {
        vscode.window.showErrorMessage(`Cannot promote: ${item.stage} stage is not deployed`);
        return;
    }

    const details = await getDeployDetails(context);
    if (!details) {
        return;
    }

    // Get the checksum from the current automation
    // We need to get it from the history or from the automation itself
    // For now, we'll get it from history
    const historyUrl = urlJoin(details.deployUrl, "automations", item.deploymentId, "history").toString();
    
    try {
        const history = await getAutomationHistory(historyUrl, details.deploySecret, 1, 1);
        const latestEntry = history.items && history.items.length > 0 ? history.items[0] : null;
        
        if (!latestEntry || !latestEntry.checksum) {
            vscode.window.showErrorMessage(`Could not find checksum for ${item.stage} stage`);
            return;
        }

        const checksum = latestEntry.checksum;
        
        // Determine target deployment_id
        const automationSourceName = item.automationSourceName.split('/').pop() || item.automationSourceName;
        const sanitizedSourceName = automationSourceName.toLowerCase().replace(/[^a-z0-9\-]/g, '').replace(/^[,\.\-]+/g, '');
        const targetDeploymentId = targetStage === 'production' 
            ? sanitizedSourceName 
            : `${sanitizedSourceName}-${targetStage}`;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Promoting ${item.stage} to ${targetStage}`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 50, message: `Promoting to ${targetStage}...` });
                
                const deployUrl = urlJoin(details.deployUrl, "automations", targetDeploymentId, "deploy").toString();
                const success = await promoteAutomation(deployUrl, details.deploySecret, checksum, targetStage);
                
                if (success) {
                    progress.report({ increment: 100, message: `Successfully promoted to ${targetStage}` });
                    vscode.window.showInformationMessage(`Successfully promoted ${item.stage} to ${targetStage}`);
                    // Refresh automations and business processes view
                    await refreshAutomationsCommand(context, provider);
                    provider.refresh();
                } else {
                    throw new Error(`Failed to promote to ${targetStage}`);
                }
            } catch (error: any) {
                const errorMessage = error.message || 'Unknown error';
                vscode.window.showErrorMessage(`Failed to promote: ${errorMessage}`);
                outputChannel.appendLine(`Promotion error: ${errorMessage}`);
            }
        });
    } catch (error: any) {
        const errorMessage = error.message || 'Unknown error';
        vscode.window.showErrorMessage(`Failed to get automation history: ${errorMessage}`);
        outputChannel.appendLine(`History error: ${errorMessage}`);
    }
}

export async function openPromotionManagerCommand(
    context: vscode.ExtensionContext,
    automationSourceName: string
) {
    // Create and show webview
    const panel = vscode.window.createWebviewPanel(
        'promotionManager',
        `Promotion Manager - ${automationSourceName.split('/').pop()}`,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    // Get deploy details
    const details = await getDeployDetails(context);
    if (!details) {
        panel.dispose();
        return;
    }

    // Extract sanitized source name
    const sourceName = automationSourceName.split('/').pop() || automationSourceName;
    const sanitizedSourceName = sourceName.toLowerCase().replace(/[^a-z0-9\-]/g, '').replace(/^[,\.\-]+/g, '');
    
    const deploymentIds = {
        dev: `${sanitizedSourceName}-dev`,
        staging: `${sanitizedSourceName}-staging`,
        production: sanitizedSourceName
    };

    const getStageData = () => {
        const automations = context.globalState.get<any[]>('automations', []);
        return {
            dev: automations.find(a => (a.deployment_id || a.deploymentId) === deploymentIds.dev),
            staging: automations.find(a => (a.deployment_id || a.deploymentId) === deploymentIds.staging),
            production: automations.find(a => {
                const id = a.deployment_id || a.deploymentId;
                return id === deploymentIds.production ||
                       (id === sanitizedSourceName && (a.stage === '' || a.stage === 'production' || !a.stage));
            })
        };
    };

    const fetchHistories = async (stageData: { dev: any; staging: any; production: any }) => {
        const histories: { dev: any[] | null; staging: any[] | null; production: any[] | null } = {
            dev: null, staging: null, production: null
        };

        const fetchPromises = Object.entries(deploymentIds).map(async ([stage, deploymentId]) => {
            const stageDataItem = stageData[stage as keyof typeof stageData];
            if (stageDataItem) {
                try {
                    const historyUrl = urlJoin(details.deployUrl, "automations", deploymentId, "history").toString();
                    const history = await getAutomationHistory(historyUrl, details.deploySecret, 1, 20);
                    histories[stage as keyof typeof histories] = history.items || [];
                } catch (error) {
                    histories[stage as keyof typeof histories] = [];
                }
            } else {
                histories[stage as keyof typeof histories] = [];
            }
        });

        await Promise.all(fetchPromises);
        return histories;
    };

    // Function to update the webview content
    const updateWebview = async () => {
        const stageData = getStageData();

        // Render immediately with loading spinners for history sections
        panel.webview.html = getPromotionManagerHtml(
            panel.webview, details, deploymentIds, stageData,
            { dev: null, staging: null, production: null },
            context
        );

        // Fetch all histories in parallel, then re-render with data
        const histories = await fetchHistories(stageData);
        panel.webview.html = getPromotionManagerHtml(panel.webview, details, deploymentIds, stageData, histories, context);
    };

    // Initial load — page appears instantly with loading spinners
    await updateWebview();

    // Set up auto-refresh when automations change (same interval as sidebar)
    const refreshInterval = setInterval(async () => {
        await refreshAutomationsCommand(context, { refresh: () => {} } as any);
        await updateWebview();
    }, 10000);

    // Clean up interval when panel is disposed
    panel.onDidDispose(() => {
        clearInterval(refreshInterval);
    }, null, context.subscriptions);

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.command) {
                case 'promote':
                    await handlePromote(message.fromStage, message.toStage, details, deploymentIds, sanitizedSourceName, context);
                    await updateWebview();
                    break;
                case 'showLogs':
                    await handleShowLogs(message.deploymentId, details, context);
                    break;
                case 'rollback':
                    await handleRollback(message.checksum, message.stage, details, deploymentIds, sanitizedSourceName, context);
                    await updateWebview();
                    break;
                case 'copyChecksum':
                    await vscode.env.clipboard.writeText(message.checksum);
                    vscode.window.showInformationMessage('Checksum copied to clipboard');
                    break;
                case 'openExternalUrl':
                    try {
                        await vscode.env.openExternal(vscode.Uri.parse(message.url));
                        vscode.window.showInformationMessage(`Opened URL in browser`);
                    } catch (err) {
                        vscode.window.showErrorMessage(`Failed to open URL: ${message.url}`);
                    }
                    break;
                case 'refresh':
                    await updateWebview();
                    break;
            }
        },
        undefined,
        context.subscriptions
    );
}

async function handlePromote(
    fromStage: string,
    toStage: string,
    details: { deployUrl: string; deploySecret: string },
    deploymentIds: { dev: string; staging: string; production: string },
    sanitizedSourceName: string,
    context: vscode.ExtensionContext
) {
    const fromDeploymentId = deploymentIds[fromStage as keyof typeof deploymentIds];
    const toDeploymentId = toStage === 'production' ? sanitizedSourceName : deploymentIds[toStage as keyof typeof deploymentIds];
    
    try {
        const historyUrl = urlJoin(details.deployUrl, "automations", fromDeploymentId, "history").toString();
        const history = await getAutomationHistory(historyUrl, details.deploySecret, 1, 1);
        const latestEntry = history.items && history.items.length > 0 ? history.items[0] : null;
        
        if (!latestEntry || !latestEntry.checksum) {
            vscode.window.showErrorMessage(`Could not find checksum for ${fromStage} stage`);
            return;
        }

        const checksum = latestEntry.checksum;
        const deployUrl = urlJoin(details.deployUrl, "automations", toDeploymentId, "deploy").toString();
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Promoting ${fromStage} to ${toStage}`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 50, message: `Promoting to ${toStage}...` });
                const success = await promoteAutomation(deployUrl, details.deploySecret, checksum, toStage);
                
                if (success) {
                    progress.report({ increment: 100, message: `Successfully promoted to ${toStage}` });
                    vscode.window.showInformationMessage(`Successfully promoted ${fromStage} to ${toStage}`);
                    // Refresh automations
                    await refreshAutomationsCommand(context, { refresh: () => {} } as any);
                } else {
                    throw new Error(`Failed to promote to ${toStage}`);
                }
            } catch (error: any) {
                const errorMessage = error.message || 'Unknown error';
                vscode.window.showErrorMessage(`Failed to promote: ${errorMessage}`);
                outputChannel.appendLine(`Promotion error: ${errorMessage}`);
            }
        });
    } catch (error: any) {
        const errorMessage = error.message || 'Unknown error';
        vscode.window.showErrorMessage(`Failed to get automation history: ${errorMessage}`);
        outputChannel.appendLine(`History error: ${errorMessage}`);
    }
}

async function handleShowLogs(
    deploymentId: string,
    details: { deployUrl: string; deploySecret: string },
    context: vscode.ExtensionContext
) {
    // Find the automation item and show logs
    const automations = context.globalState.get<any[]>('automations', []);
    const automation = automations.find(a => (a.deployment_id || a.deploymentId) === deploymentId);
    
    if (automation) {
        const automationItem = new AutomationItem(
            automation.name,
            automation.state,
            automation.status,
            automation.deployment_id || automation.deploymentId,
            automation.active,
            automation.automation_url || automation.automationUrl,
            automation.relative_path || automation.relativePath
        );
        
        const provider = new AutomationsViewProvider(context);
        await showAutomationLogsCommand(context, provider, automationItem);
    } else {
        vscode.window.showWarningMessage(`Automation not found for deployment ${deploymentId}`);
    }
}

async function handleRollback(
    checksum: string,
    stage: string,
    details: { deployUrl: string; deploySecret: string },
    deploymentIds: { dev: string; staging: string; production: string },
    sanitizedSourceName: string,
    context: vscode.ExtensionContext
) {
    const deploymentId = stage === 'production' || !stage ? sanitizedSourceName : deploymentIds[stage as keyof typeof deploymentIds];
    const normalizedStage = stage === 'production' || !stage ? 'production' : stage;
    
    try {
        const deployUrl = urlJoin(details.deployUrl, "automations", deploymentId, "deploy").toString();
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Rolling back to checksum ${checksum.substring(0, 8)}...`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 50, message: `Rolling back...` });
                const success = await promoteAutomation(deployUrl, details.deploySecret, checksum, normalizedStage);
                
                if (success) {
                    progress.report({ increment: 100, message: `Successfully rolled back` });
                    vscode.window.showInformationMessage(`Successfully rolled back to checksum ${checksum.substring(0, 8)}`);
                    // Refresh automations
                    await refreshAutomationsCommand(context, { refresh: () => {} } as any);
                } else {
                    throw new Error(`Failed to rollback`);
                }
            } catch (error: any) {
                const errorMessage = error.message || 'Unknown error';
                vscode.window.showErrorMessage(`Failed to rollback: ${errorMessage}`);
                outputChannel.appendLine(`Rollback error: ${errorMessage}`);
            }
        });
    } catch (error: any) {
        const errorMessage = error.message || 'Unknown error';
        vscode.window.showErrorMessage(`Failed to rollback: ${errorMessage}`);
        outputChannel.appendLine(`Rollback error: ${errorMessage}`);
    }
}

function getPromotionManagerHtml(
    webview: vscode.Webview,
    details: { deployUrl: string; deploySecret: string },
    deploymentIds: { dev: string; staging: string; production: string },
    stageData: { dev: any; staging: any; production: any },
    histories: { dev: any[] | null; staging: any[] | null; production: any[] | null },
    context: vscode.ExtensionContext
): string {
    const webviewUri = (path: string) => {
        return webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', path)).toString();
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Promotion Manager</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .stage-card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            background-color: var(--vscode-editor-background);
        }
        .stage-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .stage-title {
            font-size: 18px;
            font-weight: bold;
        }
        .stage-status {
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
        }
        .status-deployed {
            background-color: var(--vscode-testing-iconPassed);
            color: white;
        }
        .status-not-deployed {
            background-color: var(--vscode-descriptionForeground);
            color: var(--vscode-editor-background);
        }
        .info-section {
            margin: 15px 0;
        }
        .info-row {
            display: flex;
            margin: 8px 0;
        }
        .info-label {
            font-weight: bold;
            width: 120px;
        }
        .info-value {
            flex: 1;
        }
        .button {
            padding: 8px 16px;
            margin: 5px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        .button-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .button-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .button-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .button-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .history-section {
            margin-top: 20px;
            max-height: 300px;
            overflow-y: auto;
        }
        .history-title {
            font-weight: bold;
            margin-top: 15px;
            margin-bottom: 10px;
        }
        .history-item {
            padding: 8px;
            margin: 4px 0;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .history-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .history-item-content {
            flex: 1;
        }
        .history-item-date {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .history-item-message {
            font-size: 13px;
            margin: 4px 0;
        }
        .history-checksum {
            font-family: monospace;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .rollback-button {
            padding: 4px 8px;
            font-size: 11px;
            margin-left: 10px;
        }
        .current-checksum {
            font-family: monospace;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
        }
        .checksum-row {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .copy-checksum-button {
            padding: 4px 8px;
            font-size: 11px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .copy-checksum-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .loading-spinner {
            display: flex;
            align-items: center;
            padding: 16px 0;
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
        }
        .spinner {
            width: 18px;
            height: 18px;
            border: 2px solid var(--vscode-panel-border);
            border-top-color: var(--vscode-button-background);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-right: 10px;
            flex-shrink: 0;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <h1>Promotion Manager</h1>
    
    <div class="stage-card">
        <div class="stage-header">
            <div class="stage-title">Dev</div>
            <span class="stage-status ${stageData.dev ? 'status-deployed' : 'status-not-deployed'}">
                ${stageData.dev ? 'Deployed' : 'Not Deployed'}
            </span>
        </div>
        ${stageData.dev ? `
            <div class="info-section">
                <div class="info-row">
                    <span class="info-label">Status:</span>
                    <span class="info-value">${stageData.dev.status || 'Unknown'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">State:</span>
                    <span class="info-value">${stageData.dev.state || 'Unknown'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Active:</span>
                    <span class="info-value">${stageData.dev.active ? 'Yes' : 'No'}</span>
                </div>
                ${histories.dev !== null && histories.dev.length > 0 && histories.dev[0].checksum ? `
                    <div class="info-row">
                        <span class="info-label">Current Checksum:</span>
                        <div class="info-value checksum-row">
                            <span class="current-checksum">${histories.dev[0].checksum}</span>
                            <button class="copy-checksum-button" onclick="copyChecksum('${histories.dev[0].checksum}')">Copy</button>
                        </div>
                    </div>
                ` : ''}
            </div>
            ${stageData.dev.automationUrl ? `<button class="button button-secondary" onclick="openExternalUrl('${stageData.dev.automationUrl}')">Open External URL</button>` : ''}
            <button class="button button-primary" onclick="promote('dev', 'staging')">Promote to Staging</button>
            <button class="button button-secondary" onclick="showLogs('${deploymentIds.dev}')">Show Logs</button>
            ${histories.dev === null ? `
                <div class="history-section">
                    <div class="history-title">Deployment History</div>
                    <div class="loading-spinner"><div class="spinner"></div>Loading history...</div>
                </div>
            ` : histories.dev.length > 0 ? `
                <div class="history-section">
                    <div class="history-title">Deployment History</div>
                    ${histories.dev.map((item, index) => {
                        const checksum = item.checksum || '';
                        const date = item.date || 'Unknown date';
                        const message = item.message || 'No message';
                        const checksumDisplay = item.checksum || 'N/A';
                        const rollbackButton = index > 0
                            ? `<button class="button button-secondary rollback-button" onclick="event.stopPropagation(); rollback('${checksum}', 'dev')">Rollback</button>`
                            : '<span style="margin-left: 10px; color: var(--vscode-descriptionForeground); font-size: 11px;">Current</span>';
                        return `<div class="history-item" onclick="rollback('${checksum}', 'dev')">
                            <div class="history-item-content">
                                <div class="history-item-date">${date}</div>
                                <div class="history-item-message">${message}</div>
                                <div class="history-checksum">Checksum: ${checksumDisplay}</div>
                            </div>
                            ${rollbackButton}
                        </div>`;
                    }).join('')}
                </div>
            ` : ''}
        ` : '<p>This stage has not been deployed yet.</p>'}
    </div>
    
    <div class="stage-card">
        <div class="stage-header">
            <div class="stage-title">Staging</div>
            <span class="stage-status ${stageData.staging ? 'status-deployed' : 'status-not-deployed'}">
                ${stageData.staging ? 'Deployed' : 'Not Deployed'}
            </span>
        </div>
        ${stageData.staging ? `
            <div class="info-section">
                <div class="info-row">
                    <span class="info-label">Status:</span>
                    <span class="info-value">${stageData.staging.status || 'Unknown'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">State:</span>
                    <span class="info-value">${stageData.staging.state || 'Unknown'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Active:</span>
                    <span class="info-value">${stageData.staging.active ? 'Yes' : 'No'}</span>
                </div>
                ${histories.staging !== null && histories.staging.length > 0 && histories.staging[0].checksum ? `
                    <div class="info-row">
                        <span class="info-label">Current Checksum:</span>
                        <div class="info-value checksum-row">
                            <span class="current-checksum">${histories.staging[0].checksum}</span>
                            <button class="copy-checksum-button" onclick="copyChecksum('${histories.staging[0].checksum}')">Copy</button>
                        </div>
                    </div>
                ` : ''}
            </div>
            ${stageData.staging.automationUrl ? `<button class="button button-secondary" onclick="openExternalUrl('${stageData.staging.automationUrl}')">Open External URL</button>` : ''}
            <button class="button button-primary" onclick="promote('staging', 'production')">Promote to Production</button>
            <button class="button button-secondary" onclick="showLogs('${deploymentIds.staging}')">Show Logs</button>
            ${histories.staging === null ? `
                <div class="history-section">
                    <div class="history-title">Deployment History</div>
                    <div class="loading-spinner"><div class="spinner"></div>Loading history...</div>
                </div>
            ` : histories.staging.length > 0 ? `
                <div class="history-section">
                    <div class="history-title">Deployment History</div>
                    ${histories.staging.map((item, index) => {
                        const checksum = item.checksum || '';
                        const date = item.date || 'Unknown date';
                        const message = item.message || 'No message';
                        const checksumDisplay = item.checksum || 'N/A';
                        const rollbackButton = index > 0
                            ? `<button class="button button-secondary rollback-button" onclick="event.stopPropagation(); rollback('${checksum}', 'staging')">Rollback</button>`
                            : '<span style="margin-left: 10px; color: var(--vscode-descriptionForeground); font-size: 11px;">Current</span>';
                        return `<div class="history-item" onclick="rollback('${checksum}', 'staging')">
                            <div class="history-item-content">
                                <div class="history-item-date">${date}</div>
                                <div class="history-item-message">${message}</div>
                                <div class="history-checksum">Checksum: ${checksumDisplay}</div>
                            </div>
                            ${rollbackButton}
                        </div>`;
                    }).join('')}
                </div>
            ` : ''}
        ` : '<p>This stage has not been deployed yet.</p>'}
    </div>
    
    <div class="stage-card">
        <div class="stage-header">
            <div class="stage-title">Production</div>
            <span class="stage-status ${stageData.production ? 'status-deployed' : 'status-not-deployed'}">
                ${stageData.production ? 'Deployed' : 'Not Deployed'}
            </span>
        </div>
        ${stageData.production ? `
            <div class="info-section">
                <div class="info-row">
                    <span class="info-label">Status:</span>
                    <span class="info-value">${stageData.production.status || 'Unknown'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">State:</span>
                    <span class="info-value">${stageData.production.state || 'Unknown'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Active:</span>
                    <span class="info-value">${stageData.production.active ? 'Yes' : 'No'}</span>
                </div>
                ${histories.production !== null && histories.production.length > 0 && histories.production[0].checksum ? `
                    <div class="info-row">
                        <span class="info-label">Current Checksum:</span>
                        <div class="info-value checksum-row">
                            <span class="current-checksum">${histories.production[0].checksum}</span>
                            <button class="copy-checksum-button" onclick="copyChecksum('${histories.production[0].checksum}')">Copy</button>
                        </div>
                    </div>
                ` : ''}
            </div>
            ${stageData.production.automationUrl ? `<button class="button button-secondary" onclick="openExternalUrl('${stageData.production.automationUrl}')">Open External URL</button>` : ''}
            <button class="button button-secondary" onclick="showLogs('${deploymentIds.production}')">Show Logs</button>
            ${histories.production === null ? `
                <div class="history-section">
                    <div class="history-title">Deployment History</div>
                    <div class="loading-spinner"><div class="spinner"></div>Loading history...</div>
                </div>
            ` : histories.production.length > 0 ? `
                <div class="history-section">
                    <div class="history-title">Deployment History</div>
                    ${histories.production.map((item, index) => {
                        const checksum = item.checksum || '';
                        const date = item.date || 'Unknown date';
                        const message = item.message || 'No message';
                        const checksumDisplay = item.checksum || 'N/A';
                        const rollbackButton = index > 0
                            ? `<button class="button button-secondary rollback-button" onclick="event.stopPropagation(); rollback('${checksum}', 'production')">Rollback</button>`
                            : '<span style="margin-left: 10px; color: var(--vscode-descriptionForeground); font-size: 11px;">Current</span>';
                        return `<div class="history-item" onclick="rollback('${checksum}', 'production')">
                            <div class="history-item-content">
                                <div class="history-item-date">${date}</div>
                                <div class="history-item-message">${message}</div>
                                <div class="history-checksum">Checksum: ${checksumDisplay}</div>
                            </div>
                            ${rollbackButton}
                        </div>`;
                    }).join('')}
                </div>
            ` : ''}
        ` : '<p>This stage has not been deployed yet.</p>'}
    </div>
    
    <div style="margin-top: 40px; padding: 20px; background-color: var(--vscode-textBlockQuote-background); border-left: 4px solid var(--vscode-textBlockQuote-border); border-radius: 4px;">
        <h2 style="margin-top: 0;">Promotion Philosophy</h2>
        <p style="line-height: 1.6; margin-bottom: 0;">
            The promotion workflow follows a staged deployment model designed to ensure quality and stability. 
            Automations are first deployed to the <strong>dev</strong> stage for initial testing and validation. 
            Once verified, they can be promoted to <strong>staging</strong> for more comprehensive testing in an environment 
            that closely mirrors production. Finally, after thorough validation, automations are promoted to <strong>production</strong> 
            for live use. Each stage maintains its own deployment history, allowing you to track changes and roll back to 
            previous versions if needed. This approach minimizes risk by catching issues early and provides a clear audit trail 
            of all deployments across the entire lifecycle.
        </p>
    </div>
    
    <div style="margin-top: 40px; padding: 20px; background-color: var(--vscode-textBlockQuote-background); border-left: 4px solid var(--vscode-textBlockQuote-border); border-radius: 4px;">
        <h2 style="margin-top: 0;">Per-Stage Secret Groups</h2>
        <p style="line-height: 1.6;">
            You can configure different secret groups for each deployment stage to ensure that automations only have access to 
            the secrets appropriate for their environment. This provides an additional layer of security by isolating secrets 
            between development, staging, and production environments.
        </p>
        <p style="line-height: 1.6;">
            In your <code>pipelines.conf</code> file, you can specify stage-specific secret groups:
        </p>
        <pre style="background-color: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; overflow-x: auto; margin: 10px 0;"><code>[secrets]
dev_groups=foodev bardev
staging_groups=foostaging barstaging
production_groups=fooprod barprod
groups=foo bar</code></pre>
        <p style="line-height: 1.6;">
            When an automation is deployed to a specific stage:
        </p>
        <ul style="line-height: 1.8; padding-left: 20px;">
            <li><strong>Dev stage</strong>: Uses <code>dev_groups</code> if specified, otherwise falls back to <code>groups</code></li>
            <li><strong>Staging stage</strong>: Uses <code>staging_groups</code> if specified, otherwise falls back to <code>groups</code></li>
            <li><strong>Production stage</strong>: Uses <code>production_groups</code> if specified, otherwise falls back to <code>groups</code></li>
        </ul>
        <p style="line-height: 1.6; margin-bottom: 0;">
            The <code>groups</code> setting serves as a fallback for all stages when stage-specific groups are not configured. 
            This allows you to have shared secrets across all stages if secret isolation is not needed.
        </p>
        <p style="line-height: 1.6; margin-top: 15px; margin-bottom: 0;">
            <strong>Note:</strong> In Jupyter notebooks, secrets are loaded as if the automation is running in the <strong>dev</strong> stage, 
            meaning <code>dev_groups</code> will be preferred over <code>groups</code> when available. The automation container 
            also receives a <code>BITSWAN_AUTOMATION_STAGE</code> environment variable indicating its current stage.
        </p>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function promote(fromStage, toStage) {
            vscode.postMessage({
                command: 'promote',
                fromStage: fromStage,
                toStage: toStage
            });
        }
        
        function showLogs(deploymentId) {
            vscode.postMessage({
                command: 'showLogs',
                deploymentId: deploymentId
            });
        }
        
        function rollback(checksum, stage) {
            if (!checksum) {
                return;
            }
            vscode.postMessage({
                command: 'rollback',
                checksum: checksum,
                stage: stage
            });
        }
        
        function copyChecksum(checksum) {
            vscode.postMessage({
                command: 'copyChecksum',
                checksum: checksum
            });
        }
        
        function openExternalUrl(url) {
            vscode.postMessage({
                command: 'openExternalUrl',
                url: url
            });
        }
    </script>
</body>
</html>`;
}

