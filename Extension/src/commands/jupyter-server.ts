import * as configparserModule from "configparser";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { heartbeatJupyterServer, startJupyterServerRequest } from "../lib";

import { BitswanJupyterServerRecords } from "../types";
import { GitOpsItem } from "../views/workspaces_view";
import { JUPYTER_SERVER_RECORDS_KEY } from "../constants";

const ConfigParser = configparserModule.default || configparserModule;

export async function notebookInitializationFlow(
  context: vscode.ExtensionContext
) {
  for (const nbDoc of vscode.workspace.notebookDocuments) {
    await startJupyterServer(context, nbDoc);
    startUpJupyterServerHeartbeat(context);
  }
}

export function getPipelineConfig(doc: vscode.NotebookDocument) {
  const parentDir = path.dirname(doc.uri.fsPath);
  const pipelinesConfPath = path.join(parentDir, "pipelines.conf");

  if (fs.existsSync(pipelinesConfPath)) {
    console.log("jupyter-server:pipelines-conf-found", pipelinesConfPath);
    const config = new ConfigParser();

    try {
      config.read(pipelinesConfPath);
    } catch (error) {
      console.error("jupyter-server:pipelines-conf-read-error", error);
      return null;
    }

    console.log("jupyter-server:pipelines-conf-parsed", config.sections());

    return config;
  }

  console.log("jupyter-server:pipelines-conf-not-found", pipelinesConfPath);
  return null;
}

export async function startJupyterServer(
  context: vscode.ExtensionContext,
  notebook: vscode.NotebookDocument
) {
  console.log("jupyter-server:start");

  // get active gitops instance from global state
  const activeGitOpsInstance = context.globalState.get<GitOpsItem>(
    "activeGitOpsInstance"
  );
  if (!activeGitOpsInstance) {
    console.log("jupyter-server:no-active-gitops-instance");

    vscode.window.showErrorMessage("No active GitOps instance");
    return;
  }

  console.log("jupyter-server:active-gitops-instance", activeGitOpsInstance);

  const automationName =
    path.dirname(notebook.uri.fsPath).split("/").pop() || "";

  console.log("jupyter-server:automation-name", automationName);

  const pipelineConfig = getPipelineConfig(notebook);
  if (!pipelineConfig) {
    console.log("jupyter-server:no-pipeline-config");
    vscode.window.showErrorMessage("No pipeline config found");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Starting Jupyter Server",
      cancellable: false,
    },
    async (progress, _token) => {
      console.log("jupyter-server:start-jupyter-server-request");

      const preImage = pipelineConfig.get("deployment", "pre");
      console.log("jupyter-server:pre-image", preImage);

      if (!preImage) {
        console.log("jupyter-server:no-pre-image");
        vscode.window.showErrorMessage("No pre image found");
        return;
      }

      // dynamic import to avoid static import conflict with vscode
      const { nanoid } = await import("nanoid");
      const sessionId = nanoid()

      const response = await startJupyterServerRequest(
        `${activeGitOpsInstance.url}/jupyter/start`,
        activeGitOpsInstance.secret,
        automationName,
        preImage,
        sessionId
      );
      if (response.status === 200) {
        console.log("jupyter-server:start-jupyter-server-request-success");

        const serverInfo = response.data.server_info;

        console.log("jupyter-server:server-info", serverInfo);

        const currentServerRecords =
          context.globalState.get<BitswanJupyterServerRecords>(
            JUPYTER_SERVER_RECORDS_KEY
          );

        context.globalState.update(JUPYTER_SERVER_RECORDS_KEY, {
          ...currentServerRecords,
          [`${serverInfo.pre}-${automationName}`]: {
            ...serverInfo,
            automationName,
            sessionId,
          },
        });

        console.log("jupyter-server:update-jupyter-server-records");

        vscode.window.showInformationMessage("Jupyter Server started");
      } else {
        console.log("jupyter-server:start-jupyter-server-request-error");

        vscode.window.showErrorMessage("Failed to start Jupyter Server");
      }
    }
  );
}

export async function getJupyterServers(context: vscode.ExtensionContext) {
  const serverRecords = context.globalState.get<BitswanJupyterServerRecords>(
    JUPYTER_SERVER_RECORDS_KEY
  );

  console.log("jupyter-server:server-records", serverRecords);

  const servers = Object.values(serverRecords ?? {});

  console.log("jupyter-server:servers", servers);

  const jupyterServers = servers.map((server) => {
    return {
      id: `${server.pre}-${server.automationName}`,
      label: `${server.automationName} Jupyter Server`,
      connectionInformation: {
        baseUrl: vscode.Uri.parse(server.url),
        token: server.token,
      },
    };
  });

  console.log("jupyter-server:jupyter-servers", jupyterServers);

  return jupyterServers;
}


export async function startUpJupyterServerHeartbeat(context: vscode.ExtensionContext) {
  const intervalId = setInterval(async () => {
    const serverRecords = context.globalState.get<BitswanJupyterServerRecords>(
      JUPYTER_SERVER_RECORDS_KEY
    );

    const activeGitOpsInstance = context.globalState.get<GitOpsItem>(
      "activeGitOpsInstance"
    );
    if (!activeGitOpsInstance) {
      console.log("jupyter-server:no-active-gitops-instance");
      return;
    }

    const jupyterServers = Object.values(serverRecords ?? {}).map((server) => {
      return {
        automation_name: server.automationName,
        session_id: server.sessionId,
        pre_image: server.pre,
        token: server.token,
      };
    });

    const response = await heartbeatJupyterServer(
      `${activeGitOpsInstance.url}/jupyter/heartbeat`,
      activeGitOpsInstance.secret,
      jupyterServers
    );

    console.log("jupyter-server:heartbeat-jupyter-server-response", response);

    if (response?.status == 200) {
      console.log("jupyter-server:heartbeat-jupyter-server-success");
    } else {
      console.log("jupyter-server:heartbeat-jupyter-server-error");
    }
  }, 30000);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(intervalId);
    },
  });
}
