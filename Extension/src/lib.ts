import axios, { AxiosError } from 'axios';

import FormData from 'form-data';
import JSZip from 'jszip';
import { JupyterServerRequestResponse } from "./types";
import { Readable } from 'stream';
import path from 'path';
import vscode from 'vscode';

export const zipDirectory = async (dirPath: string, relativePath: string = '', zipFile: JSZip = new JSZip(), outputChannel: vscode.OutputChannel) => {

  const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
  for (const [name, type] of entries) {
    const fullPath = path.join(dirPath, name);
    const zipPath = path.join(relativePath, name);

    if (type === vscode.FileType.Directory) {
      await zipDirectory(fullPath, zipPath, zipFile, outputChannel);
    } else {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
      outputChannel.appendLine(`Adding file ${fullPath}`);
      zipFile.file(zipPath, content);
    }
  }

  return zipFile;
};


export const zip2stream = async (zipFile: JSZip) => {
  const stream = new Readable();

  stream.push(await zipFile.generateAsync({ type: 'nodebuffer' }));
  stream.push(null);

  return stream;

}


export const deploy = async (deployUrl: string, form: FormData, secret: string) => {
  const response = await axios.post(deployUrl, form, {
    headers: {
      'Content-Type': 'multipart/form-data',
      'Authorization': `Bearer ${secret}`
    },
  });

  return response.status == 200;
}

export const activateDeployment = async (deployUrl: string, secret: string) => {
  const response = await axios.post(
    deployUrl,
    {},
    {
      headers: {
        'Authorization': `Bearer ${secret}`,
      },
    }
  );

  return response.status == 200;
}

export const getAutomations = async (
  automationsUrl: string,
  secret: string,
) => {
  const response = await axios.get(automationsUrl, {
    headers: {
      Authorization: `Bearer ${secret}`,
    },
  });

  if (response.status == 200) {

    if (!Array.isArray(response.data)) {
      console.warn("[getAutomations] Unexpected response format:", response.data);
      return [];
    }

    const automations = response.data;
    automations.forEach((a) => {
      a.deploymentId = a.deployment_id;
      a.automationUrl = a.automation_url;
      a.relativePath = a.relative_path;
    });
    return automations;
  } else {
    throw new Error(`Failed to get automations from GitOps`);
  }
};

export const getImages = async (imagesUrl: string, secret: string) => {
  const response = await axios.get(
    imagesUrl, {
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  if (response.status == 200) {
    return response.data;
  } else {
    throw new Error(`Failed to get images from GitOps`);
  }
}

export const restartAutomation = async (automationUrl: string, secret: string) => {
  const response = await axios.post(
    automationUrl,
    {},
    {
      headers: {
        'Authorization': `Bearer ${secret}`,
      },
    }
  );

  return response.status == 200;
}

export const startAutomation = async (automationUrl: string, secret: string) => {
  const response = await axios.post(
    automationUrl,
    {},
    {
      headers: {
        'Authorization': `Bearer ${secret}`,
      },
    }
  );

  return response.status == 200;
}

export const stopAutomation = async (automationUrl: string, secret: string) => {
  const response = await axios.post(
    automationUrl,
    {},
    {
      headers: {
        'Authorization': `Bearer ${secret}`,
      },
    }
  );

  return response.status == 200;
}

export const getAutomationLogs = async (automationUrl: string, secret: string) => {
  const response = await axios.get(automationUrl, {
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  return response.data;
}

export const getImageLogs = async (imageUrl: string, secret: string) => {
  const response = await axios.get(imageUrl, {
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  return response.data;
}

export const activateAutomation = async (automationUrl: string, secret: string) => {
  const response = await axios.post(automationUrl, {}, {
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  return response.status == 200;
}

export const deactivateAutomation = async (automationUrl: string, secret: string) => {
  const response = await axios.post(automationUrl, {}, {
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  return response.status == 200;
}

export const deleteAutomation = async (automationUrl: string, secret: string) => {
  const response = await axios.delete(automationUrl, {
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  return response.status == 200;
}

export const deleteImage = async (imageUrl: string, secret: string) => {
  const response = await axios.delete(imageUrl, {
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  return response.status == 200;
};

export const startJupyterServerRequest = async (
  jupyterServerUrl: string,
  secret: string,
  automationName: string,
  preImage: string,
  sessionId: string,
  automationDirectoryPath: string
) => {
  const params = new URLSearchParams();
  params.append("automation_name", automationName);
  params.append("pre_image", preImage);
  params.append("session_id", sessionId)
  params.append("automation_directory_path", automationDirectoryPath)

  const response = await axios.post<JupyterServerRequestResponse>(
    jupyterServerUrl,
    params,
    {
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    }
  );

  console.log(
    "jupyter-server:start-jupyter-server-request-response",
    response.data
  );

  return response;
};


export const heartbeatJupyterServer = async (
  jupyterServerHeartBeatUrl: string,
  secret: string,
  jupyterServers: {
    automation_directory_path: string;
    automation_name: string;
    session_id: string;
    pre_image: string;
    token: string;
  }[]
) => {

  const heartbeatRequestPayload = {
    servers: jupyterServers,
  }

  try {
    const response = await axios.post(jupyterServerHeartBeatUrl, heartbeatRequestPayload, {
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
    });
    console.log("jupyter-server:heartbeat:response-body", response.data)
    return response
  } catch (error) {

    console.error("jupyter-server:heartbeat:error-sresponse-body",(error as AxiosError).toJSON())
    console.error("jupyter-server:heartbeat:error-sresponse-body", error)
  }

}
