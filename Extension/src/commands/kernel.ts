import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import axios, { AxiosError } from "axios";
import { outputChannel } from "../extension";
import { getDeployDetails } from "../deploy_details";
import { getPipelineConfigContent } from "./jupyter-server";
import { logHttpError } from "../lib";

export async function updateKernelStatusContext(
  context: vscode.ExtensionContext,
  deploymentId: string,
  isRunning: boolean
) {
  // Update general context for menu - this is what the menu checks
  await vscode.commands.executeCommand('setContext', 'bitswan.kernelRunning', isRunning);
  // Also update deployment-specific context for tracking
  await vscode.commands.executeCommand(
    "setContext",
    `bitswan.kernelRunning.${deploymentId}`,
    isRunning
  );
  console.log(`Updated kernel context: bitswan.kernelRunning = ${isRunning} for ${deploymentId}`);
}

export async function checkAndUpdateKernelStatus(
  context: vscode.ExtensionContext,
  deploymentId: string
): Promise<boolean> {
  const details = await getDeployDetails(context);
  if (!details) {
    await updateKernelStatusContext(context, deploymentId, false);
    return false;
  }

  try {
    const statusResponse = await axios.get(
      `${details.deployUrl}/jupyter/kernels/${deploymentId}`,
      {
        headers: {
          Authorization: `Bearer ${details.deploySecret}`,
        },
      }
    );

    const kernelStatus = statusResponse.data;
    const isRunning = kernelStatus.running === true;
    await updateKernelStatusContext(context, deploymentId, isRunning);
    return isRunning;
  } catch (error: any) {
    if (error.response?.status === 404) {
      await updateKernelStatusContext(context, deploymentId, false);
      return false;
    }
    // On error, assume not running
    await updateKernelStatusContext(context, deploymentId, false);
    return false;
  }
}

export async function startBitswanKernel(
  context: vscode.ExtensionContext,
  item: any
) {
  // This function only starts the kernel
  const details = await getDeployDetails(context);
  if (!details) {
    vscode.window.showErrorMessage("No deployment details found");
    return;
  }

  const notebookUri = item?.notebookUri || vscode.window.activeNotebookEditor?.notebook.uri;
  if (!notebookUri) {
    vscode.window.showErrorMessage("No notebook found");
    return;
  }

  const notebookDoc = await vscode.workspace.openTextDocument(notebookUri);
  const automationName = path.dirname(notebookDoc.uri.fsPath).split("/").pop() || "";

  if (!automationName) {
    vscode.window.showErrorMessage("Could not determine automation name from notebook path");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Starting Bitswan Kernel",
      cancellable: false,
    },
    async () => {
      const notebookPath = notebookDoc.uri.fsPath;
      await startKernelInternal(details, automationName, notebookPath, context);
    }
  );
}

async function startKernelInternal(deployDetails: any, automationName: string, notebookPath: string, context: vscode.ExtensionContext) {
  const notebookDoc = vscode.workspace.notebookDocuments.find(
    (doc) => doc.uri.fsPath === notebookPath || doc.uri.path === notebookPath
  );
  
  if (!notebookDoc) {
    vscode.window.showErrorMessage("Notebook not found");
    return;
  }

  const pipelinesConfContent = getPipelineConfigContent(notebookDoc) || "";
  if (!pipelinesConfContent) {
    vscode.window.showErrorMessage("pipelines.conf not found");
    return;
  }

  // Calculate relative path
  let relativePath = "";
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    try {
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const automationDirectoryPath = path.dirname(notebookPath);
      
      let workspaceMountPoint = workspaceRoot;
      if (workspaceRoot.endsWith(path.sep + "workspace") || workspaceRoot.endsWith("/workspace") || workspaceRoot.endsWith("\\workspace")) {
        workspaceMountPoint = workspaceRoot;
      } else {
        const workspaceSubdir = path.join(workspaceRoot, "workspace");
        if (automationDirectoryPath.startsWith(workspaceSubdir + path.sep) || automationDirectoryPath === workspaceSubdir) {
          workspaceMountPoint = workspaceSubdir;
        }
      }
      
      if (automationDirectoryPath.startsWith(workspaceMountPoint + path.sep) || automationDirectoryPath === workspaceMountPoint) {
        relativePath = path.relative(workspaceMountPoint, automationDirectoryPath).replace(/\\/g, "/");
        if (!relativePath.startsWith("/")) {
          relativePath = "/" + relativePath;
        }
      }
    } catch (error) {
      console.error("Error calculating relative path:", error);
    }
  }

  const params = new URLSearchParams();
  params.append("relative_path", relativePath);
  params.append("pipelines_conf_content", pipelinesConfContent);

  try {
    const response = await axios.post(
      `${deployDetails.deployUrl}/jupyter/kernels/${automationName}/start`,
      params,
      {
        headers: {
          Authorization: `Bearer ${deployDetails.deploySecret}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (response.status === 200) {
      const connection = response.data.connection;
      const config = response.data.config;
      
      vscode.window.showInformationMessage("Bitswan Kernel started");
      
      // Log configuration to output channel
      const secretGroups = config?.secret_groups || "none";
      const preImage = config?.pre_image || "unknown";
      const pipelinesConf = config?.pipelines_conf_content || "";
      
      outputChannel.appendLine(`Starting kernel with pre image "${preImage}", secret groups "${secretGroups}", and config:`);
      if (pipelinesConf) {
        // Indent the pipelines.conf content
        const lines = pipelinesConf.split('\n');
        for (const line of lines) {
          outputChannel.appendLine(`  ${line}`);
        }
      } else {
        outputChannel.appendLine(`  (no pipelines.conf content)`);
      }
      outputChannel.show(true);
      
      // Update context after starting - use multiple approaches to ensure it sticks
      await vscode.commands.executeCommand('setContext', 'bitswan.kernelRunning', true);
      await vscode.commands.executeCommand('setContext', `bitswan.kernelRunning.${automationName}`, true);
      // Also update via the helper function
      await updateKernelStatusContext(context, automationName, true);
      console.log(`Updated kernel context to true after starting for ${automationName}`);
      
      // Update Jupyter server records for connection
      const currentServerRecords = context.globalState.get<any>(
        "bitswanJupyterServerRecords"
      ) || {};
      
      await context.globalState.update("bitswanJupyterServerRecords", {
        ...currentServerRecords,
        [automationName]: {
          url: connection.url,
          token: connection.token,
          automationName,
          deploymentId: automationName,
        },
      });
    }
  } catch (error: any) {
    const errorMessage = error.response?.data?.detail || error.message || "Unknown error";
    vscode.window.showErrorMessage(`Failed to start kernel: ${errorMessage}`);
    logHttpError(error, "Start Kernel", outputChannel);
  }
}

export async function stopBitswanKernel(
  context: vscode.ExtensionContext,
  item: any
) {
  // This function only stops the kernel
  const details = await getDeployDetails(context);
  if (!details) {
    vscode.window.showErrorMessage("No deployment details found");
    return;
  }

  const notebookUri = item?.notebookUri || vscode.window.activeNotebookEditor?.notebook.uri;
  if (!notebookUri) {
    vscode.window.showErrorMessage("No notebook found");
    return;
  }

  const notebookDoc = await vscode.workspace.openTextDocument(notebookUri);
  const automationName = path.dirname(notebookDoc.uri.fsPath).split("/").pop() || "";

  if (!automationName) {
    vscode.window.showErrorMessage("Could not determine automation name from notebook path");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Stopping Bitswan Kernel",
      cancellable: false,
    },
    async () => {
      try {
        await axios.post(
          `${details.deployUrl}/jupyter/kernels/${automationName}/stop`,
          {},
          {
            headers: {
              Authorization: `Bearer ${details.deploySecret}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          }
        );
        vscode.window.showInformationMessage("Bitswan Kernel stopped");
        // Update context after stopping
        await updateKernelStatusContext(context, automationName, false);
        // Verify with backend to ensure accuracy
        await checkAndUpdateKernelStatus(context, automationName);
      } catch (error: any) {
        const errorMessage = error.response?.data?.detail || error.message || "Unknown error";
        vscode.window.showErrorMessage(`Failed to stop kernel: ${errorMessage}`);
        logHttpError(error, "Stop Kernel", outputChannel);
      }
    }
  );
}

