import * as vscode from 'vscode';
import * as path from 'path';

import { AutomationItem } from './views/automations_view';
import { ImageItem } from './views/unified_images_view';
import { GitOpsItem } from './views/workspaces_view';

// Import commands from the new command modules
import * as imageCommands from './commands/images';
import * as automationCommands from './commands/automations';
import * as itemCommands from './commands/items';
import * as workspaceCommands from './commands/workspaces';
import * as deploymentCommands from './commands/deployments';
import * as businessProcessCommands from './commands/business_processes';
import * as promotionCommands from './commands/promotions';

// Import view providers
import { WorkspacesViewProvider } from './views/workspaces_view';
import { UnifiedImagesViewProvider, OrphanedImagesViewProvider } from './views/unified_images_view';
import { openAutomationTemplates } from './views/templates_gallery';
import { SecretsTreeViewProvider, SecretsEditorPanel, SecretGroupItem } from './views/secrets_view';
import { activateAutomation, deactivateAutomation, deleteAutomation, restartAutomation, startAutomation, stopAutomation, deleteImage, setGitOpsOutputChannel, getServiceStatus } from './lib';
import { getDeployDetails } from './deploy_details';
import { Jupyter } from '@vscode/jupyter-extension';
import { getJupyterServers } from './commands/jupyter-server';
import { startBitswanKernel, stopBitswanKernel, checkAndUpdateKernelStatus, updateKernelStatusContext } from './commands/kernel';
import { initUserInfo, getUserEmail } from './services/user_info';
import { deleteWorktreeCommand as deleteWorktreeCmd } from './commands/worktrees';
import { DashboardPanel } from './views/dashboard_panel';
import { BackupsPanel } from './views/backups_view';

// Defining logging channel
export let outputChannel: vscode.OutputChannel;

// GitOps network logging channels
export let gitopsOutputChannel: vscode.OutputChannel;
export let gitopsPollingOutputChannel: vscode.OutputChannel;

// Map to track output channels
export const outputChannelsMap = new Map<string, vscode.OutputChannel>();

// SSE client reference for lifecycle management
import { GitOpsSSEClient } from './services/sse_client';
export let sseClient: GitOpsSSEClient | undefined;
export function setSseClient(client: GitOpsSSEClient | undefined) {
    if (sseClient) {
        sseClient.disconnect();
    }
    sseClient = client;
}

/**
 * This method is called by VSC when extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {
    // Create and show output channel immediately
    outputChannel = vscode.window.createOutputChannel('BitSwan');
    
    // Initialize kernel running context to false
    vscode.commands.executeCommand('setContext', 'bitswan.kernelRunning', false);
    outputChannel.show(true); // true forces the output channel to take focus

    // Create GitOps network logging channels
    gitopsOutputChannel = vscode.window.createOutputChannel('BitSwan Gitops');
    gitopsPollingOutputChannel = vscode.window.createOutputChannel('BitSwan Gitops Polling');

    // Initialize GitOps network logging interceptors
    setGitOpsOutputChannel(gitopsOutputChannel, gitopsPollingOutputChannel);

    outputChannel.appendLine('=====================================');
    outputChannel.appendLine('BitSwan Extension Activation Start');
    outputChannel.appendLine(`Activation Time: ${new Date().toISOString()}`);
    outputChannel.appendLine('=====================================');

    // Add console.log for debugging in Debug Console
    console.log('BitSwan Extension Activating - Debug Console Test');

    // Eagerly fetch the authenticated user's email from the OAuth2 proxy
    initUserInfo(context);

    if (process.env.BITSWAN_DEPLOY_URL || process.env.BITSWAN_DEPLOY_SECRET) {
        vscode.commands.executeCommand('bitswan-workspaces.removeView');
    }

    const jupyterExt =
      vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    if (!jupyterExt) {
      throw new Error("Jupyter Extension not installed");
    }
    if (!jupyterExt.isActive) {
      jupyterExt.activate();
    }

    jupyterExt.exports.createJupyterServerCollection(
      `${context.extension.id}:lab`,
      "Bitswan Jupyter Server(s)",
      {
        provideJupyterServers: () => getJupyterServers(context),
        resolveJupyterServer: (server) => server,
      }
    );


    // Create view providers
    const workspacesProvider = new WorkspacesViewProvider(context);
    const unifiedImagesProvider = new UnifiedImagesViewProvider(context);
    const orphanedImagesProvider = new OrphanedImagesViewProvider(context);
    const secretsTreeProvider = new SecretsTreeViewProvider(context);

    // The activitybar "Bitswan Workspace" container only hosts the
    // bitswan-workspaces welcome view, whose welcome content is a single link
    // ("Open Bitswan Workspace panel") that opens the dashboard panel.
    vscode.window.createTreeView('bitswan-workspaces', {
        treeDataProvider: workspacesProvider,
    });

    // Register Images views
    vscode.window.createTreeView('bitswan-unified-images', {
        treeDataProvider: unifiedImagesProvider,
    });

    vscode.window.createTreeView('bitswan-orphaned-images', {
        treeDataProvider: orphanedImagesProvider,
    });

    vscode.window.createTreeView('bitswan-secrets-manager', {
        treeDataProvider: secretsTreeProvider,
    });

    context.subscriptions.push(secretsTreeProvider);

    // Dashboard / panel commands. The dashboard handles worktree creation
    // inline; only deletion still goes through a registered command.
    context.subscriptions.push(
        vscode.commands.registerCommand('bitswan.deleteWorktree', (item) => deleteWorktreeCmd(context, item)),
        vscode.commands.registerCommand('bitswan.openRequirementsEditor', () => DashboardPanel.createOrShow(context)),
        vscode.commands.registerCommand('bitswan.openBackups', () => BackupsPanel.createOrShow(context)),
    );

    let deployFromToolbarCommand = vscode.commands.registerCommand('bitswan.deployAutomationFromToolbar',
        async (item: any) => deploymentCommands.deployFromNotebookToolbarCommand(context, item, "automations"));
    
    let startKernelCommand = vscode.commands.registerCommand('bitswan.startBitswanKernel',
        async (item: any) => await startBitswanKernel(context, item));
    
    let stopKernelCommand = vscode.commands.registerCommand('bitswan.stopBitswanKernel',
        async (item: any) => await stopBitswanKernel(context, item));
    
    // Check kernel status when notebooks are opened or when active editor changes
    const updateKernelContextForNotebook = async (notebook: vscode.NotebookDocument) => {
        if (notebook.uri.fsPath.endsWith('.ipynb')) {
            const automationName = path.dirname(notebook.uri.fsPath).split("/").pop() || "";
            if (automationName) {
                const isRunning = await checkAndUpdateKernelStatus(context, automationName);
                // Also set a general context variable for the menu
                await vscode.commands.executeCommand('setContext', 'bitswan.kernelRunning', isRunning);
            }
        }
    };
    
    context.subscriptions.push(
        vscode.workspace.onDidOpenNotebookDocument(updateKernelContextForNotebook)
    );
    
    // Also update when active notebook editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveNotebookEditor(async (e) => {
            if (e?.notebook) {
                await updateKernelContextForNotebook(e.notebook);
            }
        })
    );
    
    // Also check for already open notebooks (async wrapper)
    (async () => {
        for (const notebook of vscode.workspace.notebookDocuments) {
            if (notebook.uri.fsPath.endsWith('.ipynb')) {
                const automationName = path.dirname(notebook.uri.fsPath).split("/").pop() || "";
                if (automationName) {
                    const isRunning = await checkAndUpdateKernelStatus(context, automationName);
                    await vscode.commands.executeCommand('setContext', 'bitswan.kernelRunning', isRunning);
                }
            }
        }
    })();

    // Register commands using the new command modules
    let deployCommand = vscode.commands.registerCommand('bitswan.deployAutomation',
        async (item: { resourceUri: vscode.Uri }) => {
            if (!item?.resourceUri) {
                vscode.window.showErrorMessage('No automation selected.');
                return;
            }
            return deploymentCommands.deployCommand(context, item, 'automations');
        });

    let addGitOpsCommand = vscode.commands.registerCommand('bitswan.addGitOps',
        async () => workspaceCommands.addGitOpsCommand(context, workspacesProvider));
    
    let editGitOpsCommand = vscode.commands.registerCommand('bitswan.editGitOps', 
        async (item: GitOpsItem) => workspaceCommands.editGitOpsCommand(context, workspacesProvider, item));
    
    let deleteGitOpsCommand = vscode.commands.registerCommand('bitswan.deleteGitOps', 
        async (item: GitOpsItem) => workspaceCommands.deleteGitOpsCommand(context, workspacesProvider, item));
    
    let activateGitOpsCommand = vscode.commands.registerCommand('bitswan.activateGitOps',
        async (item: GitOpsItem) => {
            await workspaceCommands.activateGitOpsCommand(
                context,
                workspacesProvider,
                item,
                unifiedImagesProvider,
                orphanedImagesProvider,
            );
        });
    
    let refreshAutomationsCommand = vscode.commands.registerCommand('bitswan.refreshAutomations',
        async () => automationCommands.refreshAutomationsCommand(context, { refresh: () => DashboardPanel.currentPanel?.onAutomationsChanged() }));

    let refreshImagesCommand = vscode.commands.registerCommand('bitswan.refreshImages', 
        async () => {
            await imageCommands.refreshImagesCommand(context, unifiedImagesProvider);
            await imageCommands.refreshImagesCommand(context, orphanedImagesProvider);
        });

    let refreshSecretsCommand = vscode.commands.registerCommand('bitswan.refreshSecrets',
        async () => secretsTreeProvider.refresh());

    let createSecretGroupCommand = vscode.commands.registerCommand('bitswan.createSecretGroup',
        async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter a name for the secret group',
                placeHolder: 'e.g. staging',
                validateInput: (value) => {
                    if (!value || !value.trim()) {
                        return 'Group name is required';
                    }
                    if (!/^[A-Za-z0-9._-]+$/.test(value.trim())) {
                        return 'Group names may only include letters, numbers, ".", "_" or "-"';
                    }
                    return null;
                }
            });
            if (!name) {
                return;
            }
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder found');
                return;
            }
            const workspaceRoot = path.dirname(workspaceFolder);
            const secretsDir = path.join(workspaceRoot, 'secrets');
            const normalized = name.trim();
            const filePath = path.join(secretsDir, normalized);
            try {
                const { promises: fs } = await import('fs');
                await fs.access(filePath);
                vscode.window.showErrorMessage(`Secret group "${name.trim()}" already exists.`);
                return;
            } catch (error: any) {
                if (error?.code !== 'ENOENT') {
                    throw error;
                }
            }
            try {
                const { promises: fs } = await import('fs');
                await fs.mkdir(secretsDir, { recursive: true });
                const header = `# Managed by BitSwan Secrets Manager (${new Date().toISOString()})\n`;
                await fs.writeFile(filePath, header, 'utf8');
                secretsTreeProvider.refresh();
                SecretsEditorPanel.createOrShow(context, normalized, name.trim());
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create secret group: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        });

    let openSecretGroupCommand = vscode.commands.registerCommand('bitswan.openSecretGroup',
        async (item: SecretGroupItem) => {
            if (!item) {
                return;
            }
            const displayName = item.label;
            SecretsEditorPanel.createOrShow(context, item.id, displayName);
        });

    let renameSecretGroupCommand = vscode.commands.registerCommand('bitswan.renameSecretGroup',
        async (item: SecretGroupItem) => {
            if (!item) {
                return;
            }
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder found');
                return;
            }
            const workspaceRoot = path.dirname(workspaceFolder);
            const secretsDir = path.join(workspaceRoot, 'secrets');
            const oldFilePath = path.join(secretsDir, item.id);
            const oldDisplayName = item.label;

            const newName = await vscode.window.showInputBox({
                prompt: 'Enter a new name for the secret group',
                value: oldDisplayName,
                validateInput: (value) => {
                    if (!value || !value.trim()) {
                        return 'Group name is required';
                    }
                    if (value.trim() === oldDisplayName) {
                        return 'New name must be different from the current name';
                    }
                    if (!/^[A-Za-z0-9._-]+$/.test(value.trim())) {
                        return 'Group names may only include letters, numbers, ".", "_" or "-"';
                    }
                    return null;
                }
            });
            if (!newName || newName.trim() === oldDisplayName) {
                return;
            }

            const newFilePath = path.join(secretsDir, newName.trim());
            try {
                const { promises: fs } = await import('fs');
                // Check if new name already exists
                try {
                    await fs.access(newFilePath);
                    vscode.window.showErrorMessage(`Secret group "${newName.trim()}" already exists.`);
                    return;
                } catch (error: any) {
                    if (error?.code !== 'ENOENT') {
                        throw error;
                    }
                }
                // Rename the file
                await fs.rename(oldFilePath, newFilePath);
                secretsTreeProvider.refresh();
                // Close old panel if open and open new one
                SecretsEditorPanel.closePanel(item.id);
                SecretsEditorPanel.createOrShow(context, newName.trim(), newName.trim());
                vscode.window.showInformationMessage(`Renamed secret group from "${oldDisplayName}" to "${newName.trim()}".`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to rename secret group: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        });

    let deleteSecretGroupCommand = vscode.commands.registerCommand('bitswan.deleteSecretGroup',
        async (item: SecretGroupItem) => {
            if (!item) {
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Delete secret group "${item.label}"? This cannot be undone.`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') {
                return;
            }

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder found');
                return;
            }
            const workspaceRoot = path.dirname(workspaceFolder);
            const filePath = path.join(workspaceRoot, 'secrets', item.id);

            try {
                const { promises: fs } = await import('fs');
                await fs.unlink(filePath);
                SecretsEditorPanel.closePanel(item.id);
                secretsTreeProvider.refresh();
                vscode.window.showInformationMessage(`Deleted secret group "${item.label}".`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete secret group: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        });

    let openExternalUrlCommand = vscode.commands.registerCommand(
        "bitswan.openExternalUrl",
        async (item: AutomationItem) => {
            if (!item) { return; }
            const url = item.automationUrl;
            if (!url) {
                vscode.window.showWarningMessage(`No URL available for ${item.name}`);
                return;
            }
            try {
                await vscode.env.openExternal(vscode.Uri.parse(url));
                vscode.window.showInformationMessage(`Opened ${item.name} in browser`);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open URL: ${url}`);
            }
        },
    );

    let startAutomationCommand = vscode.commands.registerCommand('bitswan.startAutomation',
        async (item: AutomationItem) => {
            if (!item) { return; }
            return itemCommands.makeItemCommand({
                title: `Starting Automation ${item.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'start',
                entityGroup: 'automations',
                apiFunction: startAutomation,
                successProgress: `Automation ${item.name} started successfully`,
                successMessage: `Automation ${item.name} started successfully`,
                errorMessage: `Failed to start automation ${item.name}:`,
                errorLogPrefix: 'Automation Start Error:'
            })(context, item);
        });

    let stopAutomationCommand = vscode.commands.registerCommand('bitswan.stopAutomation',
        async (item: AutomationItem) => {
            if (!item) { return; }
            return itemCommands.makeItemCommand({
                title: `Stopping Automation ${item.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'stop',
                entityGroup: 'automations',
                apiFunction: stopAutomation,
                successProgress: `Automation ${item.name} stopped successfully`,
                successMessage: `Automation ${item.name} stopped successfully`,
                errorMessage: `Failed to stop automation ${item.name}:`,
                errorLogPrefix: 'Automation Stop Error:'
            })(context, item);
        });

    let restartAutomationCommand = vscode.commands.registerCommand('bitswan.restartAutomation',
        async (item: AutomationItem) => {
            if (!item) { return; }
            return itemCommands.makeItemCommand({
                title: `Restarting Automation ${item.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'restart',
                entityGroup: 'automations',
                apiFunction: restartAutomation,
                successProgress: `Automation ${item.name} restarted successfully`,
                successMessage: `Automation ${item.name} restarted successfully`,
                errorMessage: `Failed to restart automation ${item.name}:`,
                errorLogPrefix: 'Automation Restart Error:'
            })(context, item);
        });

    let showAutomationLogsCommand = vscode.commands.registerCommand('bitswan.showAutomationLogs',
        async (item: AutomationItem) => {
            if (!item) { return; }
            await automationCommands.showAutomationLogsCommand(context, item);
        });

    let jumpToSourceCommand = vscode.commands.registerCommand('bitswan.jumpToSource',
        async (item: AutomationItem) => { if (!item) { return; } return automationCommands.jumpToSourceCommand(context, item); });

    let openAutomationTemplatesCommand = vscode.commands.registerCommand('bitswan.openAutomationTemplates',
        async (businessProcessName?: string) => openAutomationTemplates(context, businessProcessName));

    let openDevelopmentGuideCommand = vscode.commands.registerCommand('bitswan.openDevelopmentGuide',
        async () => businessProcessCommands.openDevelopmentGuideCommand(context));

    let promoteToStagingCommand = vscode.commands.registerCommand('bitswan.promoteToStaging',
        async (item: promotionCommands.PromoteStageItem) => {
            if (!item || typeof item !== 'object' || !('stage' in item) || !('deploymentId' in item)) {
                vscode.window.showErrorMessage('Invalid item selected for promotion');
                return;
            }
            return promotionCommands.promoteStageCommand(context, item, 'staging');
        });

    let promoteToProductionCommand = vscode.commands.registerCommand('bitswan.promoteToProduction',
        async (item: promotionCommands.PromoteStageItem) => {
            if (!item || typeof item !== 'object' || !('stage' in item) || !('deploymentId' in item)) {
                vscode.window.showErrorMessage('Invalid item selected for promotion');
                return;
            }
            return promotionCommands.promoteStageCommand(context, item, 'production');
        });

    let openPromotionManagerCommand = vscode.commands.registerCommand('bitswan.openPromotionManager',
        async (item: { name: string }) => { if (!item) { return; } return promotionCommands.openPromotionManagerCommand(context, item.name); });

    let showImageLogsCommand = vscode.commands.registerCommand('bitswan.showImageLogs', 
        async (item: ImageItem) => {
            if (!item) {
                vscode.window.showErrorMessage('No image selected');
                return;
            }
            const provider = item.owner === 'orphanedImages'
                ? orphanedImagesProvider
                : unifiedImagesProvider;
            await imageCommands.showImageLogsCommand(context, provider, item);
        });

    let showOrphanedImageLogsCommand = vscode.commands.registerCommand('bitswan.showOrphanedImageLogs',
        async (item: ImageItem) => { if (!item) { return; } return imageCommands.showImageLogsCommand(context, orphanedImagesProvider, item); });

    let openImageDetailsCommand = vscode.commands.registerCommand('bitswan.openImageDetails',
        async (item: ImageItem) => { if (!item) { return; } return imageCommands.openImageDetailsCommand(context, item); });


    let activateAutomationCommand = vscode.commands.registerCommand('bitswan.activateAutomation',
        async (item: AutomationItem) => {
            if (!item) { return; }
            return itemCommands.makeItemCommand({
                title: `Activating Automation ${item.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'activate',
                entityGroup: 'automations',
                apiFunction: activateAutomation,
                successProgress: `Automation ${item.name} activated successfully`,
                successMessage: `Automation ${item.name} activated successfully`,
                errorMessage: `Failed to activate automation ${item.name}:`,
                errorLogPrefix: 'Automation Activate Error:'
            })(context, item);
        });

    let deactivateAutomationCommand = vscode.commands.registerCommand('bitswan.deactivateAutomation',
        async (item: AutomationItem) => {
            if (!item) { return; }
            return itemCommands.makeItemCommand({
                title: `Deactivating Automation ${item.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'deactivate',
                entityGroup: 'automations',
                apiFunction: deactivateAutomation,
                successProgress: `Automation ${item.name} deactivated successfully`,
                successMessage: `Automation ${item.name} deactivated successfully`,
                errorMessage: `Failed to deactivate automation ${item.name}:`,
                errorLogPrefix: 'Automation Deactivate Error:'
            })(context, item);
        });

    let deleteAutomationCommand = vscode.commands.registerCommand('bitswan.deleteAutomation',
        async (item: AutomationItem) => {
            if (!item) {
                vscode.window.showErrorMessage('No automation selected.');
                return;
            }
            const choice = await vscode.window.showWarningMessage(
                `Remove automation "${item.name}"? This deletes the deployment.`,
                { modal: true },
                'Remove',
            );
            if (choice !== 'Remove') { return; }
            return itemCommands.makeItemCommand({
                title: `Deleting Automation ${item.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: '',
                entityGroup: 'automations',
                apiFunction: deleteAutomation,
                successProgress: `Automation ${item.name} deleted successfully`,
                successMessage: `Automation ${item.name} deleted successfully`,
                errorMessage: `Failed to delete automation ${item.name}:`,
                errorLogPrefix: 'Automation Delete Error:',
            })(context, item);
        });

    let deleteImageCommand = vscode.commands.registerCommand('bitswan.deleteImage',
        async (item: ImageItem) => {
            if (!item) {
                vscode.window.showErrorMessage('No image selected');
                return;
            }
            await itemCommands.makeItemCommand({
                title: `Removing image ${item.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: '',
                entityGroup: 'images',
                apiFunction: deleteImage,
                successProgress: `Image ${item.name} deleted successfully`,
                successMessage: `Image ${item.name} deleted successfully`,
                errorMessage: `Failed to delete image ${item.name}:`,
                errorLogPrefix: 'Image Delete Error:',
                prompt: false,
            })(context, item);
        });

    let deleteOrphanedImageCommand = vscode.commands.registerCommand('bitswan.deleteOrphanedImage',
        async (item: ImageItem) => itemCommands.makeItemCommand({
            title: `Removing image ${item.name}`,
            initialProgress: 'Sending request to GitOps...',
            urlPath: '',
            entityGroup: 'images',
            apiFunction: deleteImage,
            successProgress: `Image ${item.name} deleted successfully`,
            successMessage: `Image ${item.name} deleted successfully`,
            errorMessage: `Failed to delete image ${item.name}:`,
            errorLogPrefix: 'Image Delete Error:',
            prompt: false,
        })(context, item));

    let copyImageTagCommand = vscode.commands.registerCommand('bitswan.copyImageTag',
        async (item: ImageItem) => {
            try {
                await vscode.env.clipboard.writeText(item.name);
                vscode.window.showInformationMessage(`Copied image tag: ${item.name}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to copy image tag: ${error}`);
            }
        });

    // Per-stage service helpers (CouchDB / Kafka / PostgreSQL / MinIO).
    // The BP-sidebar context-menu entries that used to trigger these were
    // removed; the commands themselves are kept (callable via
    // `vscode.commands.executeCommand` with `{ stage }`) so a future UI can
    // re-wire them without re-implementing the gitops calls.
    type ServiceTarget = { stage?: string };
    const serviceStageFor = (stage: string): string => stage === 'live-dev' ? 'dev' : stage;

    const openServiceUi = async (
        item: ServiceTarget,
        serviceType: 'couchdb' | 'kafka' | 'postgres' | 'minio',
        uiField: 'admin_ui' | 'ui_url',
        label: string,
    ): Promise<void> => {
        if (!item?.stage) { vscode.window.showErrorMessage('No stage selected'); return; }
        const details = await getDeployDetails(context);
        if (!details) { return; }
        const svcStage = serviceStageFor(item.stage);
        try {
            const status = await getServiceStatus(details.deployUrl, details.deploySecret, serviceType, svcStage, true);
            const url = status?.connection_info?.[uiField];
            if (!url) {
                vscode.window.showWarningMessage(`${label} is not enabled or has no UI for stage "${item.stage}"`);
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to get ${label} status: ${err.message || err}`);
        }
    };

    const copyServicePassword = async (
        item: ServiceTarget,
        serviceType: 'couchdb' | 'kafka' | 'postgres' | 'minio',
        passwordField: 'password' | 'ui_password',
        label: string,
        copiedMessage: string,
    ): Promise<void> => {
        if (!item?.stage) { vscode.window.showErrorMessage('No stage selected'); return; }
        const details = await getDeployDetails(context);
        if (!details) { return; }
        const svcStage = serviceStageFor(item.stage);
        try {
            const status = await getServiceStatus(details.deployUrl, details.deploySecret, serviceType, svcStage, true);
            const password = status?.connection_info?.[passwordField];
            if (!password) {
                vscode.window.showWarningMessage(`${label} is not enabled for stage "${item.stage}"`);
                return;
            }
            await vscode.env.clipboard.writeText(password);
            vscode.window.showInformationMessage(copiedMessage);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to get ${label} status: ${err.message || err}`);
        }
    };

    let openCouchDBAdminCommand = vscode.commands.registerCommand('bitswan.openCouchDBAdmin',
        (item: ServiceTarget) => openServiceUi(item, 'couchdb', 'admin_ui', 'CouchDB'));

    let openKafkaUICommand = vscode.commands.registerCommand('bitswan.openKafkaUI',
        (item: ServiceTarget) => openServiceUi(item, 'kafka', 'ui_url', 'Kafka UI'));

    let copyCouchDBPasswordCommand = vscode.commands.registerCommand('bitswan.copyCouchDBPassword',
        (item: ServiceTarget) => copyServicePassword(item, 'couchdb', 'password', 'CouchDB', 'CouchDB admin password copied to clipboard'));

    let copyKafkaPasswordCommand = vscode.commands.registerCommand('bitswan.copyKafkaPassword',
        (item: ServiceTarget) => copyServicePassword(item, 'kafka', 'ui_password', 'Kafka', 'Kafka UI password copied to clipboard'));

    let openPostgresAdminCommand = vscode.commands.registerCommand('bitswan.openPostgresAdmin',
        (item: ServiceTarget) => openServiceUi(item, 'postgres', 'admin_ui', 'PostgreSQL'));

    let copyPostgresPasswordCommand = vscode.commands.registerCommand('bitswan.copyPostgresPassword',
        (item: ServiceTarget) => copyServicePassword(item, 'postgres', 'password', 'PostgreSQL', 'PostgreSQL admin password copied to clipboard'));

    let openMinioConsoleCommand = vscode.commands.registerCommand('bitswan.openMinioConsole',
        (item: ServiceTarget) => openServiceUi(item, 'minio', 'admin_ui', 'MinIO'));

    let copyMinioPasswordCommand = vscode.commands.registerCommand('bitswan.copyMinioPassword',
        (item: ServiceTarget) => copyServicePassword(item, 'minio', 'password', 'MinIO', 'MinIO root password copied to clipboard'));

    // Register all commands
    context.subscriptions.push(deployCommand);
    context.subscriptions.push(deployFromToolbarCommand);
    context.subscriptions.push(startKernelCommand);
    context.subscriptions.push(stopKernelCommand);
    context.subscriptions.push(addGitOpsCommand);
    context.subscriptions.push(editGitOpsCommand);
    context.subscriptions.push(deleteGitOpsCommand);
    context.subscriptions.push(activateGitOpsCommand);
    context.subscriptions.push(refreshAutomationsCommand);
    context.subscriptions.push(refreshImagesCommand);
    context.subscriptions.push(refreshSecretsCommand);
    context.subscriptions.push(createSecretGroupCommand);
    context.subscriptions.push(openSecretGroupCommand);
    context.subscriptions.push(renameSecretGroupCommand);
    context.subscriptions.push(deleteSecretGroupCommand);
    context.subscriptions.push(openExternalUrlCommand);
    context.subscriptions.push(restartAutomationCommand);
    context.subscriptions.push(startAutomationCommand);
    context.subscriptions.push(stopAutomationCommand);
    context.subscriptions.push(showAutomationLogsCommand);
    context.subscriptions.push(showImageLogsCommand);
    context.subscriptions.push(showOrphanedImageLogsCommand);
    context.subscriptions.push(openImageDetailsCommand);
    context.subscriptions.push(activateAutomationCommand);
    context.subscriptions.push(deactivateAutomationCommand);
    context.subscriptions.push(deleteAutomationCommand);
    context.subscriptions.push(deleteImageCommand);
    context.subscriptions.push(deleteOrphanedImageCommand);
    context.subscriptions.push(copyImageTagCommand);
    context.subscriptions.push(jumpToSourceCommand);
    context.subscriptions.push(openAutomationTemplatesCommand);
    context.subscriptions.push(openDevelopmentGuideCommand);
    context.subscriptions.push(promoteToStagingCommand);
    context.subscriptions.push(promoteToProductionCommand);
    context.subscriptions.push(openCouchDBAdminCommand);
    context.subscriptions.push(openKafkaUICommand);
    context.subscriptions.push(copyCouchDBPasswordCommand);
    context.subscriptions.push(copyKafkaPasswordCommand);
    context.subscriptions.push(openPostgresAdminCommand);
    context.subscriptions.push(copyPostgresPasswordCommand);
    context.subscriptions.push(openMinioConsoleCommand);
    context.subscriptions.push(copyMinioPasswordCommand);
    context.subscriptions.push(openPromotionManagerCommand);

    const activeGitOpsInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');

    if (process.env.BITSWAN_DEPLOY_URL && process.env.BITSWAN_DEPLOY_SECRET) {
        const envInstance = new GitOpsItem(
            'Active GitOps Instance',
            process.env.BITSWAN_DEPLOY_URL,
            process.env.BITSWAN_DEPLOY_SECRET,
            true
        );
        workspaceCommands.activateGitOpsCommand(
            context,
            workspacesProvider,
            envInstance,
            unifiedImagesProvider,
            orphanedImagesProvider,
        );
    } else if (activeGitOpsInstance) {
        workspaceCommands.activateGitOpsCommand(
            context,
            workspacesProvider,
            activeGitOpsInstance,
            unifiedImagesProvider,
            orphanedImagesProvider,
        );
    }

    outputChannel.appendLine('Tree views registered');

    // Handle vscode:// URI to open BitSwan sidebar from external links
    const uriHandler: vscode.UriHandler = {
        handleUri: async (uri: vscode.Uri) => {
            try {
                if (uri.path === '/open') {
                    const params = new URLSearchParams(uri.query);
                    const target = params.get('target');
                    if (target === 'sidebar') {
                        await vscode.commands.executeCommand('workbench.view.extension.bitswan-business-processes');
                        outputChannel.appendLine('Focused BitSwan sidebar via URI handler');
                        return;
                    }
                }
                outputChannel.appendLine(`Unhandled URI: ${uri.toString()}`);
            } catch (err) {
                outputChannel.appendLine(`URI handler error: ${String(err)}`);
            }
        }
    };
    context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

    // Auto-open the Dashboard on startup, after user info has been fetched
    getUserEmail(context).finally(() => {
        DashboardPanel.createOrShow(context);
    });
}

/**
 * This method is called when the extension is deactivated
 */
export function deactivate() {
    // Clean up SSE client
    if (sseClient) {
        sseClient.disconnect();
        sseClient = undefined;
        outputChannel.appendLine('Disconnected SSE client');
    }

    // Clean up output channels
    outputChannel.appendLine('Cleaning up output channels...');
    
    // Dispose all output channels in the map
    outputChannelsMap.forEach((channel, name) => {
        outputChannel.appendLine(`Disposing output channel: ${name}`);
        channel.dispose();
    });
    
    // Clear the map
    outputChannelsMap.clear();
    
    // Dispose the GitOps output channel
    if (gitopsOutputChannel) {
        gitopsOutputChannel.appendLine('BitSwan GitOps Extension Deactivated');
        gitopsOutputChannel.dispose();
    }
    
    // Dispose the main output channel
    outputChannel.appendLine('BitSwan Extension Deactivated');
    outputChannel.dispose();
}
