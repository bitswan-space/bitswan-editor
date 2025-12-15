import axios, { AxiosError, InternalAxiosRequestConfig, AxiosResponse } from 'axios';

import FormData from 'form-data';
import JSZip from 'jszip';
import { JupyterServerRequestResponse } from "./types";
import { Readable } from 'stream';
import path from 'path';
import vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';

// Set up axios interceptors to log all GitOps network calls
let interceptorsInitialized = false;
let gitopsOutputChannel: vscode.OutputChannel | undefined;

export function setGitOpsOutputChannel(channel: vscode.OutputChannel) {
    gitopsOutputChannel = channel;
    if (!interceptorsInitialized) {
        initializeGitOpsLogging();
    }
}

function initializeGitOpsLogging() {
    if (interceptorsInitialized) {
        return;
    }
    
    // Request interceptor - log outgoing requests
    axios.interceptors.request.use(
        (config: InternalAxiosRequestConfig) => {
            if (gitopsOutputChannel) {
                const timestamp = new Date().toISOString();
                gitopsOutputChannel.appendLine('='.repeat(80));
                gitopsOutputChannel.appendLine(`[${timestamp}] REQUEST`);
                gitopsOutputChannel.appendLine('='.repeat(80));
                gitopsOutputChannel.appendLine(`Method: ${config.method?.toUpperCase() || 'UNKNOWN'}`);
                gitopsOutputChannel.appendLine(`URL: ${config.url || 'N/A'}`);
                gitopsOutputChannel.appendLine(`Base URL: ${config.baseURL || 'N/A'}`);
                gitopsOutputChannel.appendLine(`Full URL: ${config.baseURL ? config.baseURL + config.url : config.url || 'N/A'}`);
                
                if (config.headers) {
                    gitopsOutputChannel.appendLine('Headers:');
                    // Mask the Authorization token for security
                    const headersToLog: any = { ...config.headers };
                    if (headersToLog.Authorization) {
                        const authHeader = headersToLog.Authorization as string;
                        if (authHeader.startsWith('Bearer ')) {
                            headersToLog.Authorization = `Bearer ${authHeader.substring(7, 15)}...`;
                        }
                    }
                    gitopsOutputChannel.appendLine(JSON.stringify(headersToLog, null, 2));
                }
                
                if (config.params) {
                    gitopsOutputChannel.appendLine('Query Parameters:');
                    gitopsOutputChannel.appendLine(JSON.stringify(config.params, null, 2));
                }
                
                if (config.data) {
                    gitopsOutputChannel.appendLine('Request Body:');
                    // Handle FormData specially (form-data package)
                    if (config.data && typeof config.data === 'object' && 'getHeaders' in config.data) {
                        gitopsOutputChannel.appendLine('[FormData - multipart/form-data]');
                        // Try to get form data headers if possible
                        try {
                            const formData = config.data as any;
                            if (typeof formData.getHeaders === 'function') {
                                gitopsOutputChannel.appendLine('FormData Headers:');
                                gitopsOutputChannel.appendLine(JSON.stringify(formData.getHeaders(), null, 2));
                            }
                            // Note: FormData stream content cannot be easily logged without consuming it
                            gitopsOutputChannel.appendLine('[FormData content is a stream and cannot be logged]');
                        } catch (e) {
                            gitopsOutputChannel.appendLine(`[Error accessing FormData: ${e}]`);
                        }
                    } else if (typeof config.data === 'string') {
                        // Try to parse as JSON if possible
                        try {
                            const parsed = JSON.parse(config.data);
                            gitopsOutputChannel.appendLine(JSON.stringify(parsed, null, 2));
                        } catch {
                            gitopsOutputChannel.appendLine(config.data.substring(0, 1000) + (config.data.length > 1000 ? '...' : ''));
                        }
                    } else if (typeof config.data === 'object' && config.data !== null) {
                        try {
                            gitopsOutputChannel.appendLine(JSON.stringify(config.data, null, 2));
                        } catch (e) {
                            gitopsOutputChannel.appendLine(`[Unable to serialize request body: ${e}]`);
                        }
                    } else {
                        gitopsOutputChannel.appendLine(String(config.data));
                    }
                }
                
                gitopsOutputChannel.appendLine('');
            }
            return config;
        },
        (error) => {
            if (gitopsOutputChannel) {
                const timestamp = new Date().toISOString();
                gitopsOutputChannel.appendLine(`[${timestamp}] REQUEST ERROR: ${error.message || 'Unknown error'}`);
                gitopsOutputChannel.appendLine('');
            }
            return Promise.reject(error);
        }
    );
    
    // Response interceptor - log incoming responses
    axios.interceptors.response.use(
        (response: AxiosResponse) => {
            if (gitopsOutputChannel) {
                const timestamp = new Date().toISOString();
                gitopsOutputChannel.appendLine('='.repeat(80));
                gitopsOutputChannel.appendLine(`[${timestamp}] RESPONSE`);
                gitopsOutputChannel.appendLine('='.repeat(80));
                gitopsOutputChannel.appendLine(`Status: ${response.status} ${response.statusText || ''}`);
                gitopsOutputChannel.appendLine(`URL: ${response.config?.url || 'N/A'}`);
                gitopsOutputChannel.appendLine(`Full URL: ${response.config?.baseURL ? response.config.baseURL + response.config.url : response.config?.url || 'N/A'}`);
                
                if (response.headers) {
                    gitopsOutputChannel.appendLine('Response Headers:');
                    gitopsOutputChannel.appendLine(JSON.stringify(response.headers, null, 2));
                }
                
                gitopsOutputChannel.appendLine('Response Data:');
                try {
                    // Try to format as JSON if it's an object/array
                    if (typeof response.data === 'object' && response.data !== null) {
                        gitopsOutputChannel.appendLine(JSON.stringify(response.data, null, 2));
                    } else if (typeof response.data === 'string') {
                        // Try to parse as JSON
                        try {
                            const parsed = JSON.parse(response.data);
                            gitopsOutputChannel.appendLine(JSON.stringify(parsed, null, 2));
                        } catch {
                            gitopsOutputChannel.appendLine(response.data);
                        }
                    } else {
                        gitopsOutputChannel.appendLine(String(response.data));
                    }
                } catch (e) {
                    gitopsOutputChannel.appendLine('[Unable to serialize response data]');
                }
                
                gitopsOutputChannel.appendLine('');
            }
            return response;
        },
        (error: AxiosError) => {
            if (gitopsOutputChannel) {
                const timestamp = new Date().toISOString();
                gitopsOutputChannel.appendLine('='.repeat(80));
                gitopsOutputChannel.appendLine(`[${timestamp}] RESPONSE ERROR`);
                gitopsOutputChannel.appendLine('='.repeat(80));
                
                if (error.config) {
                    gitopsOutputChannel.appendLine(`Method: ${error.config.method?.toUpperCase() || 'UNKNOWN'}`);
                    gitopsOutputChannel.appendLine(`URL: ${error.config.url || 'N/A'}`);
                    gitopsOutputChannel.appendLine(`Full URL: ${error.config.baseURL ? error.config.baseURL + error.config.url : error.config.url || 'N/A'}`);
                }
                
                if (error.response) {
                    gitopsOutputChannel.appendLine(`Status: ${error.response.status} ${error.response.statusText || ''}`);
                    
                    if (error.response.headers) {
                        gitopsOutputChannel.appendLine('Response Headers:');
                        gitopsOutputChannel.appendLine(JSON.stringify(error.response.headers, null, 2));
                    }
                    
                    gitopsOutputChannel.appendLine('Error Response Data:');
                    try {
                        if (typeof error.response.data === 'object' && error.response.data !== null) {
                            gitopsOutputChannel.appendLine(JSON.stringify(error.response.data, null, 2));
                        } else if (typeof error.response.data === 'string') {
                            try {
                                const parsed = JSON.parse(error.response.data);
                                gitopsOutputChannel.appendLine(JSON.stringify(parsed, null, 2));
                            } catch {
                                gitopsOutputChannel.appendLine(error.response.data);
                            }
                        } else {
                            gitopsOutputChannel.appendLine(String(error.response.data));
                        }
                    } catch (e) {
                        gitopsOutputChannel.appendLine('[Unable to serialize error response data]');
                    }
                } else if (error.request) {
                    gitopsOutputChannel.appendLine('No response received from server');
                    gitopsOutputChannel.appendLine(`Request: ${JSON.stringify(error.request, null, 2)}`);
                } else {
                    gitopsOutputChannel.appendLine(`Error: ${error.message || 'Unknown error'}`);
                }
                
                gitopsOutputChannel.appendLine('');
            }
            return Promise.reject(error);
        }
    );
    
    interceptorsInitialized = true;
}

/**
 * Helper function to log HTTP error responses to the output channel
 */
export function logHttpError(
  error: AxiosError,
  context: string,
  outputChannel?: vscode.OutputChannel
): void {
  if (!error.response || !outputChannel) {
    return;
  }

  const status = error.response.status;
  const responseData = error.response.data;
  const responseHeaders = error.response.headers;
  const config = error.config;

  outputChannel.appendLine("=".repeat(60));
  outputChannel.appendLine(`${context} - HTTP Error (${status})`);
  outputChannel.appendLine("=".repeat(60));
  if (config) {
    outputChannel.appendLine(`URL: ${config.url || 'N/A'}`);
    outputChannel.appendLine(`Method: ${config.method?.toUpperCase() || 'N/A'}`);
  }
  outputChannel.appendLine(`Status: ${status} ${error.response.statusText}`);
  outputChannel.appendLine(`Response Data:`);
  outputChannel.appendLine(JSON.stringify(responseData, null, 2));
  if (responseHeaders) {
    outputChannel.appendLine(`Response Headers:`);
    outputChannel.appendLine(JSON.stringify(responseHeaders, null, 2));
  }
  outputChannel.appendLine("=".repeat(60));
  outputChannel.show(true);
}


function gitBytesCompare(a: string, b: string): number {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = Math.min(ab.length, bb.length);

  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return ab.length - bb.length;
}

// Git sorts tree entries by name, but directories are compared as if they had a trailing "/"
function gitSortKey(name: string, type: vscode.FileType): string {
  return type === vscode.FileType.Directory ? `${name}/` : name;
}

function gitTreeEntrySort(
  a: [string, vscode.FileType],
  b: [string, vscode.FileType]
): number {
  return gitBytesCompare(gitSortKey(a[0], a[1]), gitSortKey(b[0], b[1]));
}

/**
 * Calculate git blob hash for a file (SHA1 of "blob <size>\0<content>")
 */
async function calculateGitBlobHash(filePath: string): Promise<string> {
  const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  const size = content.length;
  const header = Buffer.from(`blob ${size}\0`);
  const blob = Buffer.concat([header, Buffer.from(content)]);
  return crypto.createHash('sha1').update(blob).digest('hex');
}

/**
 * Calculate git tree hash for a directory.
 * Implements git's tree object format directly without spawning git processes.
 * Tree format: "tree <size>\0<entries>" where each entry is "<mode> <name>\0<20-byte-sha1>"
 */
async function calculateGitTreeHashRecursive(
  dirPath: string,
  outputChannel?: vscode.OutputChannel
): Promise<string> {
  const entries: Array<{ mode: string; name: string; hash: string }> = [];
  
  const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
  
  // Process entries in sorted order (git requires sorted entries)
  const sortedEntries = dirEntries
  .filter(([name]) => name !== ".git")
  .sort(gitTreeEntrySort);
  
  for (const [name, type] of sortedEntries) {
    // Skip .git directory
    if (name === '.git') {
      continue;
    }
    
    const fullPath = path.join(dirPath, name);
    
    if (type === vscode.FileType.Directory) {
      // Recursively calculate tree hash for subdirectory
      const treeHash = await calculateGitTreeHashRecursive(fullPath, outputChannel);
      entries.push({
        mode: '040000', // Directory mode
        name: name,
        hash: treeHash
      });
    } else if (type === vscode.FileType.File) {
      // Calculate blob hash for file
      // Check if file is executable (simplified: check if it has execute permission)
      // In practice, git uses 100644 for regular files and 100755 for executables
      // For simplicity, we'll use 100644 (regular file) unless we can detect executable
      let mode = '100644';
      try {
        const stats = fs.statSync(fullPath);
        // Check if file is executable (Unix: any execute bit set)
        if (stats.mode & 0o111) {
          mode = '100755';
        }
      } catch {
        // If we can't stat, default to regular file
      }
      
      const blobHash = await calculateGitBlobHash(fullPath);
      entries.push({
        mode: mode,
        name: name,
        hash: blobHash
      });
    }
  }
  
  // Build tree object: "tree <size>\0<entries>"
  const entryBuffers: Buffer[] = [];
  for (const entry of entries) {
    // Each entry: "<mode> <name>\0<20-byte-sha1>"
    const hashBuffer = Buffer.from(entry.hash, 'hex');
    const entryStr = `${entry.mode} ${entry.name}\0`;
    entryBuffers.push(Buffer.from(entryStr, 'utf8'));
    entryBuffers.push(hashBuffer);
  }
  
  const treeContent = Buffer.concat(entryBuffers);
  const treeSize = treeContent.length;
  const treeHeader = Buffer.from(`tree ${treeSize}\0`);
  const treeObject = Buffer.concat([treeHeader, treeContent]);
  
  // Calculate SHA1 hash of tree object
  const treeHash = crypto.createHash('sha1').update(treeObject).digest('hex');
  
  return treeHash;
}

/**
 * Calculate git tree hash for a directory using git's tree object format.
 * This implementation directly calculates the hash without spawning git processes,
 * making it much more efficient.
 */
export const calculateGitTreeHash = async (
  dirPath: string,
  outputChannel?: vscode.OutputChannel
): Promise<string> => {
  try {
    const treeHash = await calculateGitTreeHashRecursive(dirPath, outputChannel);
    
    if (outputChannel) {
      outputChannel.appendLine(`Calculated git tree hash: ${treeHash}`);
    }
    
    return treeHash;
  } catch (error: any) {
    if (outputChannel) {
      outputChannel.appendLine(`Failed to calculate git tree hash: ${error.message}`);
    }
    throw new Error(`Failed to calculate git tree hash: ${error.message}`);
  }
};

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


export const deploy = async (
  deployUrl: string, 
  form: FormData, 
  secret: string,
  outputChannel?: vscode.OutputChannel
) => {
  try {
    const response = await axios.post(deployUrl, form, {
      headers: {
        'Content-Type': 'multipart/form-data',
        'Authorization': `Bearer ${secret}`
      },
    });

    return response.status == 200;
  } catch (error: any) {
    if (error instanceof AxiosError && error.response) {
      logHttpError(error, "Deploy Request", outputChannel);
    }
    throw error;
  }
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
  try {
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
        a.versionHash = a.version_hash;
        // Stage field is already present, but normalize empty string to 'production'
        if (a.stage === '' || a.stage === null || a.stage === undefined) {
          a.stage = 'production';
        }
      });
      return automations;
    } else {
      throw new Error(`Failed to get automations from GitOps: Request failed with status code ${response.status}. URL: ${automationsUrl}, Secret: ${secret.substring(0, 8)}...`);
    }
  } catch (error: any) {
    if (error instanceof AxiosError) {
      const statusCode = error.response?.status || 'unknown';
      throw new Error(`Failed to get automations from GitOps: Request failed with status code ${statusCode}. URL: ${automationsUrl}, Secret: ${secret.substring(0, 8)}...`);
    }
    throw error;
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
  automationDirectoryPath: string,
  relativePath: string,
  pipelinesConfContent: string,
  outputChannel?: vscode.OutputChannel
) => {
  const params = new URLSearchParams();
  params.append("automation_name", automationName);
  params.append("pre_image", preImage);
  params.append("session_id", sessionId)
  params.append("automation_directory_path", automationDirectoryPath)
  params.append("relative_path", relativePath)
  params.append("pipelines_conf_content", pipelinesConfContent)

  try {
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
  } catch (error: any) {
    if (error instanceof AxiosError && error.response) {
      const status = error.response.status;
      const responseData = error.response.data;
      const responseHeaders = error.response.headers;
      
      const errorDetails = {
        status,
        statusText: error.response.statusText,
        data: responseData,
        headers: responseHeaders,
        url: jupyterServerUrl,
        method: 'POST',
      };

      const errorMessage = `Jupyter Server Request Failed (${status}):\n${JSON.stringify(errorDetails, null, 2)}`;
      
      console.error("jupyter-server:start-jupyter-server-request-error", errorDetails);
      
      logHttpError(error, "Jupyter Server Request", outputChannel);
      
      throw error;
    }
    throw error;
  }
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
  }[],
  outputChannel?: vscode.OutputChannel
) => {

  console.log("jupyter-server:heartbeat:jupyter-servers", jupyterServers)

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
  } catch (error: any) {
    if (error instanceof AxiosError && error.response) {
      const status = error.response.status;
      const responseData = error.response.data;
      const responseHeaders = error.response.headers;
      
      const errorDetails = {
        status,
        statusText: error.response.statusText,
        data: responseData,
        headers: responseHeaders,
        url: jupyterServerHeartBeatUrl,
        method: 'POST',
      };

      console.error("jupyter-server:heartbeat:error", errorDetails);
      
      logHttpError(error, "Jupyter Server Heartbeat", outputChannel);
    } else {
      console.error("jupyter-server:heartbeat:error", error);
    }
    return undefined;
  }

}

export const uploadAsset = async (assetsUploadUrl: string, form: FormData, secret: string) => {
  const response = await axios.post(assetsUploadUrl, form, {
    headers: {
      'Content-Type': 'multipart/form-data',
      'Authorization': `Bearer ${secret}`
    },
  });

  if (response.status === 200) {
    return response.data;
  } else {
    throw new Error(`Failed to upload asset: ${response.status}`);
  }
}

export const promoteAutomation = async (
  deployUrl: string,
  secret: string,
  checksum: string,
  stage: string,
  relativePath?: string
) => {
  const form = new FormData();
  form.append('checksum', checksum);
  form.append('stage', stage);
  if (relativePath) {
    form.append('relative_path', relativePath);
  }

  const response = await axios.post(deployUrl, form, {
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  return response.status === 200;
}

export const getAutomationHistory = async (
  historyUrl: string,
  secret: string,
  page: number = 1,
  pageSize: number = 20
) => {
  const response = await axios.get(historyUrl, {
    params: {
      page,
      page_size: pageSize
    },
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  if (response.status === 200) {
    return response.data;
  } else {
    throw new Error(`Failed to get automation history: ${response.status}`);
  }
}

export const listAssets = async (assetsUrl: string, secret: string) => {
  const response = await axios.get(assetsUrl, {
    headers: {
      'Authorization': `Bearer ${secret}`,
    },
  });

  if (response.status === 200) {
    return response.data;
  } else {
    throw new Error(`Failed to list assets: ${response.status}`);
  }
}


