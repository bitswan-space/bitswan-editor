import * as configparserModule from "configparser";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { outputChannel } from "../extension";
import { getDeployDetails } from "../deploy_details";
import axios from "axios";

const ConfigParser = configparserModule.default || configparserModule;

// Heartbeat and tracking removed - no longer needed

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

export function getPipelineConfigContent(doc: vscode.NotebookDocument): string | null {
  const parentDir = path.dirname(doc.uri.fsPath);
  const pipelinesConfPath = path.join(parentDir, "pipelines.conf");

  if (fs.existsSync(pipelinesConfPath)) {
    try {
      const content = fs.readFileSync(pipelinesConfPath, "utf-8");
      console.log("jupyter-server:pipelines-conf-content-read", pipelinesConfPath);
      return content;
    } catch (error) {
      console.error("jupyter-server:pipelines-conf-content-read-error", error);
      return null;
    }
  }

  console.log("jupyter-server:pipelines-conf-not-found", pipelinesConfPath);
  return null;
}

// startJupyterServer function removed - now using toggleBitswanKernel in kernel.ts

export async function getJupyterServers(context: vscode.ExtensionContext) {
  const details = await getDeployDetails(context);
  if (!details) {
    return [];
  }

  try {
    const response = await axios.get(
      `${details.deployUrl}/jupyter/kernels`,
      {
        headers: {
          Authorization: `Bearer ${details.deploySecret}`,
        },
      }
    );

    const kernels = response.data;
    console.log("jupyter-server:kernels", kernels);

    const jupyterServers = kernels
      .filter((kernel: any) => kernel.running && kernel.connection)
      .map((kernel: any) => {
        const baseUrl = vscode.Uri.parse(kernel.connection.url);
        console.log("jupyter-server:creating-server-connection", {
          id: kernel.deployment_id,
          url: kernel.connection.url,
          parsedUrl: baseUrl.toString(),
          hasToken: !!kernel.connection.token
        });
        
        return {
          id: kernel.deployment_id,
          label: `${kernel.deployment_id} Bitswan Kernel`,
          connectionInformation: {
            baseUrl: baseUrl,
            token: kernel.connection.token,
          },
        };
      });

    console.log("jupyter-server:jupyter-servers", jupyterServers);
    return jupyterServers;
  } catch (error: any) {
    console.error("jupyter-server:error-getting-kernels", error);
    return [];
  }
}


// Heartbeat and tracking functions removed - no longer needed
