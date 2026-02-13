import * as vscode from 'vscode';
import * as path from 'path';

import { AutomationItem } from './views/automations_view';
import { ImageItem } from './views/unified_images_view';
import { FolderItem } from './views/sources_view';
import { GitOpsItem } from './views/workspaces_view';
import { BusinessProcessItem, AutomationSourceFileItem } from './views/unified_business_processes_view';
import { AutomationSourceItem, StageItem } from './views/unified_business_processes_view';

// Import commands from the new command modules
import * as imageCommands from './commands/images';
import * as automationCommands from './commands/automations';
import * as itemCommands from './commands/items';
import * as workspaceCommands from './commands/workspaces';
import * as deploymentCommands from './commands/deployments';
import * as businessProcessCommands from './commands/business_processes';
import * as promotionCommands from './commands/promotions';

// Import view providers
import { AutomationSourcesViewProvider } from './views/automation_sources_view';
import { WorkspacesViewProvider } from './views/workspaces_view';
import { AutomationsViewProvider } from './views/automations_view';
import { UnifiedImagesViewProvider, OrphanedImagesViewProvider } from './views/unified_images_view';
import { UnifiedBusinessProcessesViewProvider } from './views/unified_business_processes_view';
import { openAutomationTemplates } from './views/templates_gallery';
import { SecretsTreeViewProvider, SecretsEditorPanel, SecretGroupItem } from './views/secrets_view';
import { activateAutomation, deactivateAutomation, deleteAutomation, restartAutomation, startAutomation, stopAutomation, deleteImage, setGitOpsOutputChannel, getServiceStatus } from './lib';
import { getDeployDetails } from './deploy_details';
import { Jupyter } from '@vscode/jupyter-extension';
import { getJupyterServers } from './commands/jupyter-server';
import { startBitswanKernel, stopBitswanKernel, checkAndUpdateKernelStatus, updateKernelStatusContext } from './commands/kernel';
import * as filesystemCommands from './commands/filesystem';

// Defining logging channel
export let outputChannel: vscode.OutputChannel;

// GitOps network logging channels
export let gitopsOutputChannel: vscode.OutputChannel;
export let gitopsPollingOutputChannel: vscode.OutputChannel;

// Map to track output channels
export const outputChannelsMap = new Map<string, vscode.OutputChannel>();

// Store the refresh interval IDs
export let automationRefreshInterval: NodeJS.Timer | undefined;
export let imageRefreshInterval: NodeJS.Timer | undefined;

export function setAutomationRefreshInterval(interval: NodeJS.Timer | undefined) {
    if (automationRefreshInterval) {
        clearInterval(automationRefreshInterval);
    }
    automationRefreshInterval = interval;
}

export function setImageRefreshInterval(interval: NodeJS.Timer | undefined) {
    if (imageRefreshInterval) {
        clearInterval(imageRefreshInterval);
    }
    imageRefreshInterval = interval;
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
    const automationSourcesProvider = new AutomationSourcesViewProvider(context);
    const workspacesProvider = new WorkspacesViewProvider(context);
    const automationsProvider = new AutomationsViewProvider(context);
    const unifiedImagesProvider = new UnifiedImagesViewProvider(context);
    const orphanedImagesProvider = new OrphanedImagesViewProvider(context);
    const unifiedBusinessProcessesProvider = new UnifiedBusinessProcessesViewProvider(context);
    const secretsTreeProvider = new SecretsTreeViewProvider(context);

    // Register Business Processes views
    vscode.window.createTreeView('bitswan-unified-business-processes', {
        treeDataProvider: unifiedBusinessProcessesProvider,
    });

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

    let deployFromToolbarCommand = vscode.commands.registerCommand('bitswan.deployAutomationFromToolbar', 
        async (item: string) => deploymentCommands.deployFromNotebookToolbarCommand(context, item, "automations", unifiedBusinessProcessesProvider, unifiedImagesProvider, orphanedImagesProvider));
    
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
        async (item: FolderItem | AutomationSourceItem) => {
            if (!item) {
                vscode.window.showErrorMessage('No automation selected. Please click the deploy button on a specific automation.');
                return;
            }
            // Convert AutomationSourceItem to FolderItem if needed
            const folderItem = item instanceof AutomationSourceItem
                ? new FolderItem(item.name, item.resourceUri)
                : item;
            return deploymentCommands.deployCommand(context, automationSourcesProvider, folderItem, "automations", unifiedBusinessProcessesProvider, unifiedImagesProvider, orphanedImagesProvider);
        });

    let startLiveDevServerCommand = vscode.commands.registerCommand('bitswan.startLiveDevServer',
        async (item: FolderItem | AutomationSourceItem | StageItem) => {
            if (!item) {
                vscode.window.showErrorMessage('No automation selected. Please click the live dev button on a specific automation.');
                return;
            }
            let folderPath: string;
            if (item instanceof StageItem) {
                // StageItem has sourceUri which points to the automation source directory
                if (!item.sourceUri) {
                    vscode.window.showErrorMessage('Cannot determine source path for this stage');
                    return;
                }
                folderPath = item.sourceUri.fsPath;
            } else if (item instanceof AutomationSourceItem) {
                folderPath = item.resourceUri.fsPath;
            } else {
                folderPath = item.resourceUri.fsPath;
            }
            return deploymentCommands.startLiveDevServerCommand(context, folderPath, unifiedBusinessProcessesProvider);
        });

    let buildImageFromToolbarCommand = vscode.commands.registerCommand('bitswan.buildImageFromToolbar', 
        async (item: vscode.Uri) => deploymentCommands.deployFromToolbarCommand(context, item, "images", unifiedBusinessProcessesProvider, unifiedImagesProvider, orphanedImagesProvider));
 
    let buildImageCommand = vscode.commands.registerCommand('bitswan.buildImage', 
        async (item: FolderItem) => deploymentCommands.deployCommand(context, automationSourcesProvider, item, "images", unifiedBusinessProcessesProvider, unifiedImagesProvider, orphanedImagesProvider));
    
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
                automationsProvider,
                unifiedBusinessProcessesProvider,
                unifiedImagesProvider,
                orphanedImagesProvider
            );
        });
    
    let refreshAutomationsCommand = vscode.commands.registerCommand('bitswan.refreshAutomations', 
        async () => automationCommands.refreshAutomationsCommand(context, automationsProvider));

    let refreshImagesCommand = vscode.commands.registerCommand('bitswan.refreshImages', 
        async () => {
            await imageCommands.refreshImagesCommand(context, unifiedImagesProvider);
            await imageCommands.refreshImagesCommand(context, orphanedImagesProvider);
        });

    let refreshBusinessProcessesCommand = vscode.commands.registerCommand('bitswan.refreshBusinessProcesses', 
        async () => {
            console.log('[DEBUG] refreshBusinessProcessesCommand called');
            await businessProcessCommands.refreshBusinessProcessesCommand(context, unifiedBusinessProcessesProvider);
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
 
    let openExternalUrlCommand = vscode.commands.registerCommand(
        "bitswan.openExternalUrl",
        async (item: AutomationItem | StageItem) => {
            const automationItem = item instanceof StageItem && item.automation ? item.automation : item as AutomationItem;
            const url = automationItem.automationUrl;
            if (!url) {
                vscode.window.showWarningMessage(`No URL available for ${automationItem.name}`);
                return;
            }
            try {
                await vscode.env.openExternal(vscode.Uri.parse(url));
                vscode.window.showInformationMessage(`Opened ${automationItem.name} in browser`);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open URL: ${url}`);
            }
        },
    );
    
    let startAutomationCommand = vscode.commands.registerCommand('bitswan.startAutomation', 
        async (item: AutomationItem | StageItem) => {
            const automationItem = item instanceof StageItem && item.automation ? item.automation : item as AutomationItem;
            return itemCommands.makeItemCommand({
                title: `Starting Automation ${automationItem.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'start',
                apiFunction: startAutomation,
                successProgress: `Automation ${automationItem.name} started successfully`,
                successMessage: `Automation ${automationItem.name} started successfully`,
                errorMessage: `Failed to start automation ${automationItem.name}:`,
                errorLogPrefix: 'Automation Start Error:'
            })(context, automationsProvider, automationItem);
        });
    
    let stopAutomationCommand = vscode.commands.registerCommand('bitswan.stopAutomation', 
        async (item: AutomationItem | StageItem) => {
            const automationItem = item instanceof StageItem && item.automation ? item.automation : item as AutomationItem;
            return itemCommands.makeItemCommand({
                title: `Stopping Automation ${automationItem.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'stop',
                apiFunction: stopAutomation,
                successProgress: `Automation ${automationItem.name} stopped successfully`,
                successMessage: `Automation ${automationItem.name} stopped successfully`,
                errorMessage: `Failed to stop automation ${automationItem.name}:`,
                errorLogPrefix: 'Automation Stop Error:'
            })(context, automationsProvider, automationItem);
        });
    
    let restartAutomationCommand = vscode.commands.registerCommand('bitswan.restartAutomation',     
        async (item: AutomationItem | StageItem) => {
            const automationItem = item instanceof StageItem && item.automation ? item.automation : item as AutomationItem;
            return itemCommands.makeItemCommand({
                title: `Restarting Automation ${automationItem.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'restart',
                apiFunction: restartAutomation,
                successProgress: `Automation ${automationItem.name} restarted successfully`,
                successMessage: `Automation ${automationItem.name} restarted successfully`,
                errorMessage: `Failed to restart automation ${automationItem.name}:`,
                errorLogPrefix: 'Automation Restart Error:'
            })(context, automationsProvider, automationItem);
        });
    
    let showAutomationLogsCommand = vscode.commands.registerCommand('bitswan.showAutomationLogs', 
        async (item: AutomationItem | StageItem) => {
            if (item instanceof StageItem && item.automation) {
                await automationCommands.showAutomationLogsCommand(context, automationsProvider, item.automation);
            } else if (item instanceof AutomationItem) {
                await automationCommands.showAutomationLogsCommand(context, automationsProvider, item);
            }
        });

    let jumpToSourceCommand = vscode.commands.registerCommand('bitswan.jumpToSource', 
        async (item: AutomationItem) => automationCommands.jumpToSourceCommand(context, item));

    let openProcessReadmeCommand = vscode.commands.registerCommand('bitswan.openProcessReadme', 
        async (item: BusinessProcessItem) => {
            const readmePath = path.join(item.resourceUri.fsPath, 'README.md');
            try {
                const uri = vscode.Uri.file(readmePath);
                await vscode.window.showTextDocument(uri);
            } catch (error) {
                vscode.window.showErrorMessage(`Could not open README.md: ${error}`);
            }
        });

    let openAutomationTemplatesCommand = vscode.commands.registerCommand('bitswan.openAutomationTemplates',
        async (businessProcessName?: string) => openAutomationTemplates(context, businessProcessName));

    let openDevelopmentGuideCommand = vscode.commands.registerCommand('bitswan.openDevelopmentGuide',
        async () => businessProcessCommands.openDevelopmentGuideCommand(context));

    let createBusinessProcessCommand = vscode.commands.registerCommand('bitswan.createBusinessProcess',
        async () => businessProcessCommands.createBusinessProcessCommand(context, unifiedBusinessProcessesProvider));

    let promoteToDevCommand = vscode.commands.registerCommand('bitswan.promoteToDev',
        async (item: StageItem | any) => {
            if (!item || (typeof item !== 'object')) {
                vscode.window.showErrorMessage('Invalid item selected for promotion');
                return;
            }
            // Check if it looks like a StageItem with sourceUri
            if (!('stage' in item) || !('sourceUri' in item) || !item.sourceUri) {
                vscode.window.showErrorMessage('Cannot promote: source path not available');
                return;
            }
            // Use the deploy flow to calculate fresh checksum from current source files
            return deploymentCommands.deployCommandAbstract(
                context,
                item.sourceUri.fsPath,
                'automations',
                null,
                unifiedBusinessProcessesProvider,
                unifiedImagesProvider,
                orphanedImagesProvider
            );
        });

    let promoteToStagingCommand = vscode.commands.registerCommand('bitswan.promoteToStaging',
        async (item: StageItem | any) => {
            if (!item || (typeof item !== 'object')) {
                vscode.window.showErrorMessage('Invalid item selected for promotion');
                return;
            }
            // Check if it looks like a StageItem (has stage and deploymentId properties)
            if (!('stage' in item) || !('deploymentId' in item)) {
                vscode.window.showErrorMessage('Invalid item selected for promotion');
                return;
            }
            return promotionCommands.promoteStageCommand(context, item as StageItem, 'staging', unifiedBusinessProcessesProvider);
        });

    let promoteToProductionCommand = vscode.commands.registerCommand('bitswan.promoteToProduction',
        async (item: StageItem | any) => {
            if (!item || (typeof item !== 'object')) {
                vscode.window.showErrorMessage('Invalid item selected for promotion');
                return;
            }
            // Check if it looks like a StageItem (has stage and deploymentId properties)
            if (!('stage' in item) || !('deploymentId' in item)) {
                vscode.window.showErrorMessage('Invalid item selected for promotion');
                return;
            }
            return promotionCommands.promoteStageCommand(context, item as StageItem, 'production', unifiedBusinessProcessesProvider);
        });

    let openPromotionManagerCommand = vscode.commands.registerCommand('bitswan.openPromotionManager',
        async (item: AutomationSourceItem) => promotionCommands.openPromotionManagerCommand(context, item.name));

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
        async (item: ImageItem) => imageCommands.showImageLogsCommand(context, orphanedImagesProvider, item));

    let openImageDetailsCommand = vscode.commands.registerCommand('bitswan.openImageDetails',
        async (item: ImageItem) => imageCommands.openImageDetailsCommand(context, item));


    let activateAutomationCommand = vscode.commands.registerCommand('bitswan.activateAutomation', 
        async (item: AutomationItem | StageItem) => {
            const automationItem = item instanceof StageItem && item.automation ? item.automation : item as AutomationItem;
            return itemCommands.makeItemCommand({
                title: `Activating Automation ${automationItem.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'activate',
                apiFunction: activateAutomation,
                successProgress: `Automation ${automationItem.name} activated successfully`,
                successMessage: `Automation ${automationItem.name} activated successfully`,
                errorMessage: `Failed to activate automation ${automationItem.name}:`,
                errorLogPrefix: 'Automation Activate Error:'
            })(context, automationsProvider, automationItem);
        });
    
    let deactivateAutomationCommand = vscode.commands.registerCommand('bitswan.deactivateAutomation', 
        async (item: AutomationItem | StageItem) => {
            const automationItem = item instanceof StageItem && item.automation ? item.automation : item as AutomationItem;
            return itemCommands.makeItemCommand({
                title: `Deactivating Automation ${automationItem.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: 'deactivate',
                apiFunction: deactivateAutomation,
                successProgress: `Automation ${automationItem.name} deactivated successfully`,
                successMessage: `Automation ${automationItem.name} deactivated successfully`,
                errorMessage: `Failed to deactivate automation ${automationItem.name}:`,
                errorLogPrefix: 'Automation Deactivate Error:'
            })(context, automationsProvider, automationItem);
        });
    
    let deleteAutomationCommand = vscode.commands.registerCommand('bitswan.deleteAutomation',
        async (item: AutomationItem | StageItem) => {
            const automationItem = item instanceof StageItem && item.automation ? item.automation : item as AutomationItem;
            // Only require confirmation prompt for production deployments
            const requirePrompt = !(item instanceof StageItem) || item.stage === 'production';
            return itemCommands.makeItemCommand({
                title: `Deleting Automation ${automationItem.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: '',
                apiFunction: deleteAutomation,
                successProgress: `Automation ${automationItem.name} deleted successfully`,
                successMessage: `Automation ${automationItem.name} deleted successfully`,
                errorMessage: `Failed to delete automation ${automationItem.name}:`,
                errorLogPrefix: 'Automation Delete Error:',
                prompt: requirePrompt
            })(context, automationsProvider, automationItem);
        });

    let createAutomationFileCommand = vscode.commands.registerCommand(
        'bitswan.createAutomationFile',
        async (item: AutomationSourceItem | AutomationSourceFileItem | StageItem) =>
            filesystemCommands.createAutomationFileCommand(context, item)
    );

    let createAutomationFolderCommand = vscode.commands.registerCommand(
        'bitswan.createAutomationFolder',
        async (item: AutomationSourceItem | AutomationSourceFileItem | StageItem) =>
            filesystemCommands.createAutomationFolderCommand(context, item)
    );

    let renameAutomationResourceCommand = vscode.commands.registerCommand(
        'bitswan.renameAutomationResource',
        async (item: AutomationSourceItem | AutomationSourceFileItem | StageItem) =>
            filesystemCommands.renameAutomationResourceCommand(context, item)
    );

    let deleteAutomationResourceCommand = vscode.commands.registerCommand(
        'bitswan.deleteAutomationResource',
        async (item: AutomationSourceItem | AutomationSourceFileItem | StageItem) =>
            filesystemCommands.deleteAutomationResourceCommand(context, item)
    );

    let revealAutomationResourceCommand = vscode.commands.registerCommand(
        'bitswan.revealAutomationResource',
        async (item: AutomationSourceItem | AutomationSourceFileItem | StageItem) =>
            filesystemCommands.revealAutomationResourceCommand(context, item)
    );

    let openAutomationTerminalCommand = vscode.commands.registerCommand(
        'bitswan.openAutomationTerminal',
        async (item: AutomationSourceItem | AutomationSourceFileItem | StageItem) =>
            filesystemCommands.openAutomationTerminalCommand(context, item)
    );

    let deleteImageCommand = vscode.commands.registerCommand('bitswan.deleteImage', 
        async (item: ImageItem) => {
            if (!item) {
                vscode.window.showErrorMessage('No image selected');
                return;
            }
            const provider = item.owner === 'orphanedImages'
                ? orphanedImagesProvider
                : unifiedImagesProvider;
            await itemCommands.makeItemCommand({
                title: `Removing image ${item.name}`,
                initialProgress: 'Sending request to GitOps...',
                urlPath: '',
                apiFunction: deleteImage,
                successProgress: `Image ${item.name} deleted successfully`,
                successMessage: `Image ${item.name} deleted successfully`,
                errorMessage: `Failed to delete image ${item.name}:`,
                errorLogPrefix: 'Image Delete Error:',
                prompt: false 
            })(context, provider, item);
            if (item.owner === 'businessProcesses') {
                unifiedBusinessProcessesProvider.refresh();
            }
        });

    let deleteOrphanedImageCommand = vscode.commands.registerCommand('bitswan.deleteOrphanedImage', 
        async (item: ImageItem) => itemCommands.makeItemCommand({
            title: `Removing image ${item.name}`,
            initialProgress: 'Sending request to GitOps...',
            urlPath: '',
            apiFunction: deleteImage,
            successProgress: `Image ${item.name} deleted successfully`,
            successMessage: `Image ${item.name} deleted successfully`,
            errorMessage: `Failed to delete image ${item.name}:`,
            errorLogPrefix: 'Image Delete Error:',
            prompt: false 
        })(context, orphanedImagesProvider, item));

    let copyImageTagCommand = vscode.commands.registerCommand('bitswan.copyImageTag', 
        async (item: ImageItem) => {
            try {
                await vscode.env.clipboard.writeText(item.name);
                vscode.window.showInformationMessage(`Copied image tag: ${item.name}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to copy image tag: ${error}`);
            }
        });
 
    
    // Helper to map automation stage to service realm
    const serviceStageFor = (stage: string): string => {
        if (stage === 'live-dev') { return 'dev'; }
        return stage;
    };

    let openCouchDBAdminCommand = vscode.commands.registerCommand('bitswan.openCouchDBAdmin',
        async (item: StageItem) => {
            if (!item?.stage) { vscode.window.showErrorMessage('No stage selected'); return; }
            const details = await getDeployDetails(context);
            if (!details) { return; }
            const svcStage = serviceStageFor(item.stage);
            try {
                const status = await getServiceStatus(details.deployUrl, details.deploySecret, 'couchdb', svcStage, true);
                const adminUi = status?.connection_info?.admin_ui;
                if (!adminUi) {
                    vscode.window.showWarningMessage(`CouchDB is not enabled or has no admin UI for stage "${item.stage}"`);
                    return;
                }
                await vscode.env.openExternal(vscode.Uri.parse(adminUi));
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to get CouchDB status: ${err.message || err}`);
            }
        });

    let openKafkaUICommand = vscode.commands.registerCommand('bitswan.openKafkaUI',
        async (item: StageItem) => {
            if (!item?.stage) { vscode.window.showErrorMessage('No stage selected'); return; }
            const details = await getDeployDetails(context);
            if (!details) { return; }
            const svcStage = serviceStageFor(item.stage);
            try {
                const status = await getServiceStatus(details.deployUrl, details.deploySecret, 'kafka', svcStage, true);
                const uiUrl = status?.connection_info?.ui_url;
                if (!uiUrl) {
                    vscode.window.showWarningMessage(`Kafka UI is not enabled or has no URL for stage "${item.stage}"`);
                    return;
                }
                await vscode.env.openExternal(vscode.Uri.parse(uiUrl));
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to get Kafka status: ${err.message || err}`);
            }
        });

    let copyCouchDBPasswordCommand = vscode.commands.registerCommand('bitswan.copyCouchDBPassword',
        async (item: StageItem) => {
            if (!item?.stage) { vscode.window.showErrorMessage('No stage selected'); return; }
            const details = await getDeployDetails(context);
            if (!details) { return; }
            const svcStage = serviceStageFor(item.stage);
            try {
                const status = await getServiceStatus(details.deployUrl, details.deploySecret, 'couchdb', svcStage, true);
                const password = status?.connection_info?.password;
                if (!password) {
                    vscode.window.showWarningMessage(`CouchDB is not enabled for stage "${item.stage}"`);
                    return;
                }
                await vscode.env.clipboard.writeText(password);
                vscode.window.showInformationMessage('CouchDB admin password copied to clipboard');
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to get CouchDB status: ${err.message || err}`);
            }
        });

    let copyKafkaPasswordCommand = vscode.commands.registerCommand('bitswan.copyKafkaPassword',
        async (item: StageItem) => {
            if (!item?.stage) { vscode.window.showErrorMessage('No stage selected'); return; }
            const details = await getDeployDetails(context);
            if (!details) { return; }
            const svcStage = serviceStageFor(item.stage);
            try {
                const status = await getServiceStatus(details.deployUrl, details.deploySecret, 'kafka', svcStage, true);
                const password = status?.connection_info?.ui_password;
                if (!password) {
                    vscode.window.showWarningMessage(`Kafka is not enabled for stage "${item.stage}"`);
                    return;
                }
                await vscode.env.clipboard.writeText(password);
                vscode.window.showInformationMessage('Kafka UI password copied to clipboard');
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to get Kafka status: ${err.message || err}`);
            }
        });

    // Register all commands
    context.subscriptions.push(deployCommand);
    context.subscriptions.push(startLiveDevServerCommand);
    context.subscriptions.push(deployFromToolbarCommand);
    context.subscriptions.push(startKernelCommand);
    context.subscriptions.push(stopKernelCommand);
    context.subscriptions.push(buildImageCommand);
    context.subscriptions.push(buildImageFromToolbarCommand);
    context.subscriptions.push(addGitOpsCommand);
    context.subscriptions.push(editGitOpsCommand);
    context.subscriptions.push(deleteGitOpsCommand);
    context.subscriptions.push(activateGitOpsCommand);
    context.subscriptions.push(refreshAutomationsCommand);
    context.subscriptions.push(refreshImagesCommand);
    context.subscriptions.push(refreshBusinessProcessesCommand);
    context.subscriptions.push(refreshSecretsCommand);
    context.subscriptions.push(createSecretGroupCommand);
    context.subscriptions.push(openSecretGroupCommand);
    context.subscriptions.push(renameSecretGroupCommand);
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
    context.subscriptions.push(createAutomationFileCommand);
    context.subscriptions.push(createAutomationFolderCommand);
    context.subscriptions.push(renameAutomationResourceCommand);
    context.subscriptions.push(deleteAutomationResourceCommand);
    context.subscriptions.push(revealAutomationResourceCommand);
    context.subscriptions.push(openAutomationTerminalCommand);
    context.subscriptions.push(deleteImageCommand);
    context.subscriptions.push(deleteOrphanedImageCommand);
    context.subscriptions.push(copyImageTagCommand);
    context.subscriptions.push(jumpToSourceCommand);
    context.subscriptions.push(openProcessReadmeCommand);
    context.subscriptions.push(openAutomationTemplatesCommand);
    context.subscriptions.push(openDevelopmentGuideCommand);
    context.subscriptions.push(createBusinessProcessCommand);
    context.subscriptions.push(promoteToDevCommand);
    context.subscriptions.push(promoteToStagingCommand);
    context.subscriptions.push(promoteToProductionCommand);
    context.subscriptions.push(openPromotionManagerCommand);
    context.subscriptions.push(openCouchDBAdminCommand);
    context.subscriptions.push(openKafkaUICommand);
    context.subscriptions.push(copyCouchDBPasswordCommand);
    context.subscriptions.push(copyKafkaPasswordCommand);

    // Refresh the tree views when files change in the workspace
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(() => automationSourcesProvider.refresh());
    watcher.onDidCreate(() => unifiedImagesProvider.refresh());
    watcher.onDidCreate(() => orphanedImagesProvider.refresh());
    watcher.onDidDelete(() => automationSourcesProvider.refresh());
    watcher.onDidDelete(() => unifiedImagesProvider.refresh());
    watcher.onDidDelete(() => orphanedImagesProvider.refresh());
    watcher.onDidChange(() => automationSourcesProvider.refresh());
    watcher.onDidChange(() => unifiedImagesProvider.refresh());
    watcher.onDidChange(() => orphanedImagesProvider.refresh());
    

    const activeGitOpsInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');

    if (process.env.BITSWAN_DEPLOY_URL && process.env.BITSWAN_DEPLOY_SECRET) {
        const activeGitOpsInstance = new GitOpsItem(
            'Active GitOps Instance',
            process.env.BITSWAN_DEPLOY_URL,
            process.env.BITSWAN_DEPLOY_SECRET,
            true
        );
        workspaceCommands.activateGitOpsCommand(
            context,
            workspacesProvider,
            activeGitOpsInstance,
            automationsProvider,
            unifiedBusinessProcessesProvider,
            unifiedImagesProvider,
            orphanedImagesProvider
        );
        automationsProvider.refresh();
    } else if (activeGitOpsInstance) {
        workspaceCommands.activateGitOpsCommand(
            context,
            workspacesProvider,
            activeGitOpsInstance,
            automationsProvider,
            unifiedBusinessProcessesProvider,
            unifiedImagesProvider,
            orphanedImagesProvider
        );
        automationsProvider.refresh();
    }

    context.subscriptions.push(watcher);

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
}

/**
 * This method is called when the extension is deactivated
 */
export function deactivate() {
    // Clean up the refresh intervals
    if (automationRefreshInterval) {
        clearInterval(automationRefreshInterval);
        automationRefreshInterval = undefined;
        outputChannel.appendLine('Stopped automatic refresh of automations');
    }

    if (imageRefreshInterval) {
        clearInterval(imageRefreshInterval);
        imageRefreshInterval = undefined;
        outputChannel.appendLine('Stopped automatic refresh of images');
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
