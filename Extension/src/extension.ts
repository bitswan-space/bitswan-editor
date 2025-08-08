import * as automationCommands from "./commands/automations";
import * as deploymentCommands from "./commands/deployments";
// Import commands from the new command modules
import * as imageCommands from "./commands/images";
import * as itemCommands from "./commands/items";
import * as vscode from "vscode";
import * as workspaceCommands from "./commands/workspaces";

import {
  activateAutomation,
  deactivateAutomation,
  deleteAutomation,
  deleteImage,
  restartAutomation,
  startAutomation,
  stopAutomation,
} from "./lib";
import {
  getJupyterServers,
  notebookInitializationFlow,
  startJupyterServer,
} from "./commands/jupyter-server";

import { AutomationItem } from "./views/automations_view";
// Import view providers
import { AutomationSourcesViewProvider } from "./views/automation_sources_view";
import { AutomationsViewProvider } from "./views/automations_view";
import { FolderItem } from "./views/sources_view";
import { GitOpsItem } from "./views/workspaces_view";
import { ImageItem } from "./views/images_view";
import { ImageSourcesViewProvider } from "./views/image_sources_view";
import { ImagesViewProvider } from "./views/images_view";
import { Jupyter } from "@vscode/jupyter-extension";
import { WorkspacesViewProvider } from "./views/workspaces_view";

// Defining logging channel
export let outputChannel: vscode.OutputChannel;

// Map to track output channels
export const outputChannelsMap = new Map<string, vscode.OutputChannel>();

// Store the refresh interval ID
export let automationRefreshInterval: NodeJS.Timer | undefined;

export function setAutomationRefreshInterval(
  interval: NodeJS.Timer | undefined
) {
  if (automationRefreshInterval) {
    clearInterval(automationRefreshInterval);
  }
  automationRefreshInterval = interval;
}

/**
 * This method is called by VSC when extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {
  // Create and show output channel immediately
  outputChannel = vscode.window.createOutputChannel("BitSwan");
  outputChannel.show(true); // true forces the output channel to take focus

  outputChannel.appendLine("=====================================");
  outputChannel.appendLine("BitSwan Extension Activation Start");
  outputChannel.appendLine(`Activation Time: ${new Date().toISOString()}`);
  outputChannel.appendLine("=====================================");

  // Add console.log for debugging in Debug Console
  console.log("BitSwan Extension Activating - Debug Console Test");

  if (process.env.BITSWAN_DEPLOY_URL || process.env.BITSWAN_DEPLOY_SECRET) {
    vscode.commands.executeCommand("bitswan-workspaces.removeView");
  }

  const jupyterExt =
    vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  if (!jupyterExt) {
    throw new Error("Jupyter Extension not installed");
  }
  if (!jupyterExt.isActive) {
    jupyterExt.activate();
  }

  notebookInitializationFlow(context);

  jupyterExt.exports.createJupyterServerCollection(
    `${context.extension.id}:lab`,
    "Bitswan Jupyter Server",
    {
      provideJupyterServers: () => getJupyterServers(context),
      resolveJupyterServer: (server) => server,
    }
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(async (doc) => {
      await startJupyterServer(context, doc);
    })
  );

  // Create view providers
  const automationSourcesProvider = new AutomationSourcesViewProvider(context);
  const workspacesProvider = new WorkspacesViewProvider(context);
  const automationsProvider = new AutomationsViewProvider(context);
  const imageSourcesProvider = new ImageSourcesViewProvider(context);
  const imagesProvider = new ImagesViewProvider(context);

  // Register views
  vscode.window.createTreeView("bitswan-automation-sources", {
    treeDataProvider: automationSourcesProvider,
  });

  vscode.window.createTreeView("bitswan-workspaces", {
    treeDataProvider: workspacesProvider,
  });

  vscode.window.createTreeView("bitswan-automations", {
    treeDataProvider: automationsProvider,
  });

  vscode.window.createTreeView("bitswan-image-sources", {
    treeDataProvider: imageSourcesProvider,
  });

  vscode.window.createTreeView("bitswan-images", {
    treeDataProvider: imagesProvider,
  });

  let deployFromToolbarCommand = vscode.commands.registerCommand(
    "bitswan.deployAutomationFromToolbar",
    async (item: string) =>
      deploymentCommands.deployFromNotebookToolbarCommand(
        context,
        item,
        "automations"
      )
  );

  // Register commands using the new command modules
  let deployCommand = vscode.commands.registerCommand(
    "bitswan.deployAutomation",
    async (item: FolderItem) =>
      deploymentCommands.deployCommand(
        context,
        automationSourcesProvider,
        item,
        "automations"
      )
  );

  let buildImageFromToolbarCommand = vscode.commands.registerCommand(
    "bitswan.buildImageFromToolbar",
    async (item: vscode.Uri) =>
      deploymentCommands.deployFromToolbarCommand(context, item, "images")
  );

  let buildImageCommand = vscode.commands.registerCommand(
    "bitswan.buildImage",
    async (item: FolderItem) =>
      deploymentCommands.deployCommand(
        context,
        automationSourcesProvider,
        item,
        "images"
      )
  );

  let addGitOpsCommand = vscode.commands.registerCommand(
    "bitswan.addGitOps",
    async () => workspaceCommands.addGitOpsCommand(context, workspacesProvider)
  );

  let editGitOpsCommand = vscode.commands.registerCommand(
    "bitswan.editGitOps",
    async (item: GitOpsItem) =>
      workspaceCommands.editGitOpsCommand(context, workspacesProvider, item)
  );

  let deleteGitOpsCommand = vscode.commands.registerCommand(
    "bitswan.deleteGitOps",
    async (item: GitOpsItem) =>
      workspaceCommands.deleteGitOpsCommand(context, workspacesProvider, item)
  );

  let activateGitOpsCommand = vscode.commands.registerCommand(
    "bitswan.activateGitOps",
    async (item: GitOpsItem) => {
      await workspaceCommands.activateGitOpsCommand(
        context,
        workspacesProvider,
        item,
        automationsProvider
      ); // Refresh automations when GitOps instance is activated
    }
  );

  let refreshAutomationsCommand = vscode.commands.registerCommand(
    "bitswan.refreshAutomations",
    async () =>
      automationCommands.refreshAutomationsCommand(context, automationsProvider)
  );

  let refreshImagesCommand = vscode.commands.registerCommand(
    "bitswan.refreshImages",
    async () => imageCommands.refreshImagesCommand(context, imagesProvider)
  );

  let openExternalUrlCommand = vscode.commands.registerCommand(
    "bitswan.openExternalUrl",
    async (item: AutomationItem) => {
      const url = item.automationUrl;
      try {
        await vscode.env.openExternal(vscode.Uri.parse(url));
        vscode.window.showInformationMessage(`Opened ${item.name} in browser`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open URL: ${url}`);
      }
    }
  );

  let startAutomationCommand = vscode.commands.registerCommand(
    "bitswan.startAutomation",
    async (item: AutomationItem) =>
      itemCommands.makeItemCommand({
        title: `Starting Automation ${item.name}`,
        initialProgress: "Sending request to GitOps...",
        urlPath: "start",
        apiFunction: startAutomation,
        successProgress: `Automation ${item.name} started successfully`,
        successMessage: `Automation ${item.name} started successfully`,
        errorMessage: `Failed to start automation ${item.name}:`,
        errorLogPrefix: "Automation Start Error:",
      })(context, automationsProvider, item)
  );

  let stopAutomationCommand = vscode.commands.registerCommand(
    "bitswan.stopAutomation",
    async (item: AutomationItem) =>
      itemCommands.makeItemCommand({
        title: `Stopping Automation ${item.name}`,
        initialProgress: "Sending request to GitOps...",
        urlPath: "stop",
        apiFunction: stopAutomation,
        successProgress: `Automation ${item.name} stopped successfully`,
        successMessage: `Automation ${item.name} stopped successfully`,
        errorMessage: `Failed to stop automation ${item.name}:`,
        errorLogPrefix: "Automation Stop Error:",
      })(context, automationsProvider, item)
  );

  let restartAutomationCommand = vscode.commands.registerCommand(
    "bitswan.restartAutomation",
    async (item: AutomationItem) =>
      itemCommands.makeItemCommand({
        title: `Restarting Automation ${item.name}`,
        initialProgress: "Sending request to GitOps...",
        urlPath: "restart",
        apiFunction: restartAutomation,
        successProgress: `Automation ${item.name} restarted successfully`,
        successMessage: `Automation ${item.name} restarted successfully`,
        errorMessage: `Failed to restart automation ${item.name}:`,
        errorLogPrefix: "Automation Restart Error:",
      })(context, automationsProvider, item)
  );

  let showAutomationLogsCommand = vscode.commands.registerCommand(
    "bitswan.showAutomationLogs",
    async (item: AutomationItem) =>
      automationCommands.showAutomationLogsCommand(
        context,
        automationsProvider,
        item
      )
  );

  let jumpToSourceCommand = vscode.commands.registerCommand(
    "bitswan.jumpToSource",
    async (item: AutomationItem) =>
      automationCommands.jumpToSourceCommand(context, item)
  );

  let showImageLogsCommand = vscode.commands.registerCommand(
    "bitswan.showImageLogs",
    async (item: ImageItem) =>
      imageCommands.showImageLogsCommand(context, imagesProvider, item)
  );

  let activateAutomationCommand = vscode.commands.registerCommand(
    "bitswan.activateAutomation",
    async (item: AutomationItem) =>
      itemCommands.makeItemCommand({
        title: `Activating Automation ${item.name}`,
        initialProgress: "Sending request to GitOps...",
        urlPath: "activate",
        apiFunction: activateAutomation,
        successProgress: `Automation ${item.name} activated successfully`,
        successMessage: `Automation ${item.name} activated successfully`,
        errorMessage: `Failed to activate automation ${item.name}:`,
        errorLogPrefix: "Automation Activate Error:",
      })(context, automationsProvider, item)
  );

  let deactivateAutomationCommand = vscode.commands.registerCommand(
    "bitswan.deactivateAutomation",
    async (item: AutomationItem) =>
      itemCommands.makeItemCommand({
        title: `Deactivating Automation ${item.name}`,
        initialProgress: "Sending request to GitOps...",
        urlPath: "deactivate",
        apiFunction: deactivateAutomation,
        successProgress: `Automation ${item.name} deactivated successfully`,
        successMessage: `Automation ${item.name} deactivated successfully`,
        errorMessage: `Failed to deactivate automation ${item.name}:`,
        errorLogPrefix: "Automation Deactivate Error:",
      })(context, automationsProvider, item)
  );

  let deleteAutomationCommand = vscode.commands.registerCommand(
    "bitswan.deleteAutomation",
    async (item: AutomationItem) =>
      itemCommands.makeItemCommand({
        title: `Deleting Automation ${item.name}`,
        initialProgress: "Sending request to GitOps...",
        urlPath: "",
        apiFunction: deleteAutomation,
        successProgress: `Automation ${item.name} deleted successfully`,
        successMessage: `Automation ${item.name} deleted successfully`,
        errorMessage: `Failed to delete automation ${item.name}:`,
        errorLogPrefix: "Automation Delete Error:",
        prompt: true,
      })(context, automationsProvider, item)
  );

  let deleteImageCommand = vscode.commands.registerCommand(
    "bitswan.deleteImage",
    async (item: ImageItem) =>
      itemCommands.makeItemCommand({
        title: `Removing image ${item.name}`,
        initialProgress: "Sending request to GitOps...",
        urlPath: "",
        apiFunction: deleteImage,
        successProgress: `Image ${item.name} deleted successfully`,
        successMessage: `Image ${item.name} deleted successfully`,
        errorMessage: `Failed to delete image ${item.name}:`,
        errorLogPrefix: "Image Delete Error:",
        prompt: false,
      })(context, imagesProvider, item)
  );

  // Register all commands
  context.subscriptions.push(deployCommand);
  context.subscriptions.push(deployFromToolbarCommand);
  context.subscriptions.push(buildImageCommand);
  context.subscriptions.push(buildImageFromToolbarCommand);
  context.subscriptions.push(addGitOpsCommand);
  context.subscriptions.push(editGitOpsCommand);
  context.subscriptions.push(deleteGitOpsCommand);
  context.subscriptions.push(activateGitOpsCommand);
  context.subscriptions.push(refreshAutomationsCommand);
  context.subscriptions.push(refreshImagesCommand);
  context.subscriptions.push(openExternalUrlCommand);
  context.subscriptions.push(restartAutomationCommand);
  context.subscriptions.push(startAutomationCommand);
  context.subscriptions.push(stopAutomationCommand);
  context.subscriptions.push(showAutomationLogsCommand);
  context.subscriptions.push(activateAutomationCommand);
  context.subscriptions.push(deactivateAutomationCommand);
  context.subscriptions.push(deleteAutomationCommand);
  context.subscriptions.push(deleteImageCommand);

  // Register all commands
  context.subscriptions.push(deployCommand);
  context.subscriptions.push(deployFromToolbarCommand);
  context.subscriptions.push(buildImageCommand);
  context.subscriptions.push(buildImageFromToolbarCommand);
  context.subscriptions.push(addGitOpsCommand);
  context.subscriptions.push(editGitOpsCommand);
  context.subscriptions.push(deleteGitOpsCommand);
  context.subscriptions.push(activateGitOpsCommand);
  context.subscriptions.push(refreshAutomationsCommand);
  context.subscriptions.push(refreshImagesCommand);
  context.subscriptions.push(openExternalUrlCommand);
  context.subscriptions.push(restartAutomationCommand);
  context.subscriptions.push(startAutomationCommand);
  context.subscriptions.push(stopAutomationCommand);
  context.subscriptions.push(showAutomationLogsCommand);
  context.subscriptions.push(activateAutomationCommand);
  context.subscriptions.push(deactivateAutomationCommand);
  context.subscriptions.push(deleteAutomationCommand);
  context.subscriptions.push(deleteImageCommand);
  context.subscriptions.push(jumpToSourceCommand);

  // Refresh the tree views when files change in the workspace
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidCreate(() => automationSourcesProvider.refresh());
  watcher.onDidCreate(() => imageSourcesProvider.refresh());
  watcher.onDidDelete(() => automationSourcesProvider.refresh());
  watcher.onDidDelete(() => imageSourcesProvider.refresh());
  watcher.onDidChange(() => automationSourcesProvider.refresh());
  watcher.onDidChange(() => imageSourcesProvider.refresh());

  const activeGitOpsInstance = context.globalState.get<GitOpsItem>(
    "activeGitOpsInstance"
  );
  if (activeGitOpsInstance) {
    workspaceCommands.activateGitOpsCommand(
      context,
      workspacesProvider,
      activeGitOpsInstance,
      automationsProvider
    );
    automationsProvider.refresh();
  } else if (
    process.env.BITSWAN_DEPLOY_URL &&
    process.env.BITSWAN_DEPLOY_SECRET
  ) {
    const activeGitOpsInstance = new GitOpsItem(
      "Active GitOps Instance",
      process.env.BITSWAN_DEPLOY_URL,
      process.env.BITSWAN_DEPLOY_SECRET,
      true
    );
    workspaceCommands.activateGitOpsCommand(
      context,
      workspacesProvider,
      activeGitOpsInstance,
      automationsProvider
    );
    automationsProvider.refresh();
  }

  context.subscriptions.push(watcher);

  outputChannel.appendLine("Tree views registered");
}

/**
 * This method is called when the extension is deactivated
 */
export function deactivate() {
  // Clean up the refresh interval
  if (automationRefreshInterval) {
    clearInterval(automationRefreshInterval);
    automationRefreshInterval = undefined;
    outputChannel.appendLine("Stopped automatic refresh of automations");
  }

  // Clean up output channels
  outputChannel.appendLine("Cleaning up output channels...");

  // Dispose all output channels in the map
  outputChannelsMap.forEach((channel, name) => {
    outputChannel.appendLine(`Disposing output channel: ${name}`);
    channel.dispose();
  });

  // Clear the map
  outputChannelsMap.clear();

  // Dispose the main output channel
  outputChannel.appendLine("BitSwan Extension Deactivated");
  outputChannel.dispose();
}
