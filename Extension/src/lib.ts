import axios, { AxiosError, InternalAxiosRequestConfig, AxiosResponse } from 'axios';

import FormData from 'form-data';
import JSZip from 'jszip';
import archiver from 'archiver';
import { minimatch } from 'minimatch';
import { JupyterServerRequestResponse } from "./types";
import { Readable, PassThrough } from 'stream';
import path from 'path';
import vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Check if a path should be ignored based on glob patterns.
 * @param relativePath - The relative path to check (e.g., "node_modules" or "src/file.ts")
 * @param ignorePatterns - Array of glob patterns to match against
 * @returns true if the path should be ignored
 */
export function shouldIgnore(relativePath: string, ignorePatterns?: string[]): boolean {
  if (!ignorePatterns || ignorePatterns.length === 0) {
    return false;
  }

  // Normalize path separators for cross-platform compatibility
  const normalizedPath = relativePath.replace(/\\/g, '/');

  for (const pattern of ignorePatterns) {
    // Match against the full path
    if (minimatch(normalizedPath, pattern, { dot: true })) {
      return true;
    }
    // Also match if any path segment matches (for patterns like "node_modules")
    const segments = normalizedPath.split('/');
    for (const segment of segments) {
      if (minimatch(segment, pattern, { dot: true })) {
        return true;
      }
    }
  }
  return false;
}

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
 * Uses synchronous fs operations to avoid VS Code API hangs.
 */
function calculateGitTreeHashRecursive(
  dirPath: string,
  outputChannel?: vscode.OutputChannel,
  relativePath: string = '',
  ignorePatterns?: string[]
): string {
  const entries: Array<{ mode: string; name: string; hash: string }> = [];

  // Use synchronous fs.readdirSync instead of vscode.workspace.fs which can hang
  const dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });

  // Convert to format compatible with sorting, filter .git, symlinks, and ignored patterns
  const sortedEntries = dirEntries
    .filter(entry => {
      if (entry.name === '.git') {
        return false;
      }
      // Skip symlinks - they should not be included in deployments
      if (entry.isSymbolicLink()) {
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (outputChannel) {
          outputChannel.appendLine(`Skipping symlink: ${entryRelativePath}`);
        }
        return false;
      }
      // Only include regular files and directories
      if (!entry.isFile() && !entry.isDirectory()) {
        return false;
      }
      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (shouldIgnore(entryRelativePath, ignorePatterns)) {
        if (outputChannel) {
          outputChannel.appendLine(`Ignoring: ${entryRelativePath}`);
        }
        return false;
      }
      return true;
    })
    .map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile()
    }))
    .sort((a, b) => {
      // Git sorts directories with trailing slash, using byte order (not locale)
      const aName = a.isDirectory ? a.name + '/' : a.name;
      const bName = b.isDirectory ? b.name + '/' : b.name;
      // Use simple comparison for ASCII byte order like git does
      if (aName < bName) return -1;
      if (aName > bName) return 1;
      return 0;
    });

  for (const entry of sortedEntries) {
    const fullPath = path.join(dirPath, entry.name);
    const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory) {
      const treeHash = calculateGitTreeHashRecursive(fullPath, outputChannel, entryRelativePath, ignorePatterns);
      entries.push({
        mode: '040000',
        name: entry.name,
        hash: treeHash
      });
      if (outputChannel) {
        outputChannel.appendLine(`CHECKSUM DIR:  ${entryRelativePath}/ -> ${treeHash}`);
      }
    } else if (entry.isFile) {
      // Always use 100644 mode - zip extraction doesn't preserve executable bits reliably
      const blobHash = calculateGitBlobHashSync(fullPath);
      entries.push({
        mode: '100644',
        name: entry.name,
        hash: blobHash
      });
      if (outputChannel) {
        outputChannel.appendLine(`CHECKSUM FILE: ${entryRelativePath} -> 100644 ${blobHash}`);
      }
    }
  }

  // Build tree object
  const entryBuffers: Buffer[] = [];
  for (const entry of entries) {
    const hashBuffer = Buffer.from(entry.hash, 'hex');
    const entryStr = `${entry.mode} ${entry.name}\0`;
    entryBuffers.push(Buffer.from(entryStr, 'utf8'));
    entryBuffers.push(hashBuffer);
  }

  const treeContent = Buffer.concat(entryBuffers);
  const treeHeader = Buffer.from(`tree ${treeContent.length}\0`);
  const treeObject = Buffer.concat([treeHeader, treeContent]);

  const finalHash = crypto.createHash('sha1').update(treeObject).digest('hex');
  if (outputChannel && relativePath === '') {
    outputChannel.appendLine(`=== CLIENT CHECKSUM CALCULATION END: ${finalHash} ===`);
  }
  return finalHash;
}

/**
 * Synchronous version of blob hash calculation
 */
function calculateGitBlobHashSync(filePath: string): string {
  const content = fs.readFileSync(filePath);
  const header = Buffer.from(`blob ${content.length}\0`);
  const blob = Buffer.concat([header, content]);
  return crypto.createHash('sha1').update(blob).digest('hex');
}

/**
 * Calculate git tree hash for a directory using git's tree object format.
 * This implementation directly calculates the hash without spawning git processes,
 * making it much more efficient.
 */
export const calculateGitTreeHash = (
  dirPath: string,
  outputChannel?: vscode.OutputChannel,
  ignorePatterns?: string[]
): string => {
  try {
    if (outputChannel) {
      outputChannel.appendLine(`=== CLIENT CHECKSUM CALCULATION START for ${dirPath} ===`);
      if (ignorePatterns && ignorePatterns.length > 0) {
        outputChannel.appendLine(`Ignoring patterns: ${ignorePatterns.join(', ')}`);
      }
    }
    const treeHash = calculateGitTreeHashRecursive(dirPath, outputChannel, '', ignorePatterns);

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

/**
 * Calculate git tree hash for merged directories without copying files.
 * Later directories override earlier ones (like bitswan_lib overriding automation files).
 */
export const calculateMergedGitTreeHash = (
  dirPaths: string[],
  outputChannel?: vscode.OutputChannel,
  ignorePatterns?: string[]
): string => {
  if (outputChannel) {
    outputChannel.appendLine(`=== CLIENT MERGED CHECKSUM CALCULATION START for ${dirPaths.length} directories ===`);
    for (const dp of dirPaths) {
      outputChannel.appendLine(`  - ${dp}`);
    }
    if (ignorePatterns && ignorePatterns.length > 0) {
      outputChannel.appendLine(`Ignoring patterns: ${ignorePatterns.join(', ')}`);
    }
  }
  const treeHash = calculateMergedGitTreeHashRecursive(dirPaths, '', outputChannel, ignorePatterns);
  if (outputChannel) {
    outputChannel.appendLine(`Calculated merged git tree hash: ${treeHash}`);
  }
  return treeHash;
};

function calculateMergedGitTreeHashRecursive(
  dirPaths: string[],
  relativePath: string,
  outputChannel?: vscode.OutputChannel,
  ignorePatterns?: string[]
): string {
  // Build a map of name -> {sourcePath, isDirectory}, with later directories overwriting earlier ones
  const entryMap = new Map<string, { sourcePath: string; isDirectory: boolean }>();

  for (const dirPath of dirPaths) {
    const fullDirPath = relativePath ? path.join(dirPath, relativePath) : dirPath;

    // Use synchronous fs to avoid VS Code API hangs
    if (!fs.existsSync(fullDirPath)) {
      continue;
    }
    const stat = fs.statSync(fullDirPath);
    if (!stat.isDirectory()) {
      continue;
    }

    const dirEntries = fs.readdirSync(fullDirPath, { withFileTypes: true });

    for (const entry of dirEntries) {
      if (entry.name === '.git') {
        continue;
      }
      // Skip symlinks - they should not be included in deployments
      if (entry.isSymbolicLink()) {
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (outputChannel) {
          outputChannel.appendLine(`Skipping symlink: ${entryRelativePath}`);
        }
        continue;
      }
      // Only include regular files and directories
      if (!entry.isFile() && !entry.isDirectory()) {
        continue;
      }
      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (shouldIgnore(entryRelativePath, ignorePatterns)) {
        if (outputChannel) {
          outputChannel.appendLine(`Ignoring: ${entryRelativePath}`);
        }
        continue;
      }
      entryMap.set(entry.name, {
        sourcePath: path.join(fullDirPath, entry.name),
        isDirectory: entry.isDirectory()
      });
    }
  }

  // Sort entries using git's sorting rules (byte order, not locale)
  const sortedEntries = Array.from(entryMap.entries())
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => {
      const aName = a.isDirectory ? a.name + '/' : a.name;
      const bName = b.isDirectory ? b.name + '/' : b.name;
      // Use simple comparison for ASCII byte order like git does
      if (aName < bName) return -1;
      if (aName > bName) return 1;
      return 0;
    });

  const entries: Array<{ mode: string; name: string; hash: string }> = [];

  for (const entry of sortedEntries) {
    const childRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

    if (entry.isDirectory) {
      const treeHash = calculateMergedGitTreeHashRecursive(dirPaths, childRelativePath, outputChannel, ignorePatterns);
      entries.push({ mode: '040000', name: entry.name, hash: treeHash });
      if (outputChannel) {
        outputChannel.appendLine(`CHECKSUM DIR:  ${childRelativePath}/ -> ${treeHash}`);
      }
    } else {
      // Always use 100644 mode - zip extraction doesn't preserve executable bits reliably
      const blobHash = calculateGitBlobHashSync(entry.sourcePath);
      entries.push({ mode: '100644', name: entry.name, hash: blobHash });
      if (outputChannel) {
        outputChannel.appendLine(`CHECKSUM FILE: ${childRelativePath} -> 100644 ${blobHash}`);
      }
    }
  }

  // Build tree object
  const entryBuffers: Buffer[] = [];
  for (const entry of entries) {
    const hashBuffer = Buffer.from(entry.hash, 'hex');
    const entryStr = `${entry.mode} ${entry.name}\0`;
    entryBuffers.push(Buffer.from(entryStr, 'utf8'));
    entryBuffers.push(hashBuffer);
  }

  const treeContent = Buffer.concat(entryBuffers);
  const treeHeader = Buffer.from(`tree ${treeContent.length}\0`);
  const treeObject = Buffer.concat([treeHeader, treeContent]);

  const finalHash = crypto.createHash('sha1').update(treeObject).digest('hex');
  if (outputChannel && relativePath === '') {
    outputChannel.appendLine(`=== CLIENT MERGED CHECKSUM CALCULATION END: ${finalHash} ===`);
  }
  return finalHash;
}

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

/**
 * Create a zip from multiple directories without copying files.
 * Later directories in the array override files from earlier directories.
 * This streams files directly from source, avoiding temp directory creation.
 * Uses synchronous fs operations to avoid VS Code API hangs.
 */
export const zipMergedDirectories = (
  dirPaths: string[],
  outputChannel: vscode.OutputChannel
): JSZip => {
  const zipFile = new JSZip();
  zipMergedDirectoriesRecursive(dirPaths, '', zipFile, outputChannel);
  return zipFile;
};

function zipMergedDirectoriesRecursive(
  dirPaths: string[],
  relativePath: string,
  zipFile: JSZip,
  outputChannel: vscode.OutputChannel
): void {
  // Build a map of name -> sourcePath, with later directories overwriting earlier ones
  const fileMap = new Map<string, { sourcePath: string; isDirectory: boolean }>();

  for (const dirPath of dirPaths) {
    const fullDirPath = relativePath ? path.join(dirPath, relativePath) : dirPath;

    // Use synchronous fs to avoid VS Code API hangs
    if (!fs.existsSync(fullDirPath)) {
      continue;
    }
    const stat = fs.statSync(fullDirPath);
    if (!stat.isDirectory()) {
      continue;
    }

    const entries = fs.readdirSync(fullDirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;
      }
      // Skip symlinks - they should not be included in deployments
      if (entry.isSymbolicLink()) {
        outputChannel.appendLine(`Skipping symlink: ${relativePath ? `${relativePath}/${entry.name}` : entry.name}`);
        continue;
      }
      // Only include regular files and directories
      if (!entry.isFile() && !entry.isDirectory()) {
        continue;
      }
      fileMap.set(entry.name, {
        sourcePath: path.join(fullDirPath, entry.name),
        isDirectory: entry.isDirectory()
      });
    }
  }

  // Process all entries
  for (const [name, entry] of fileMap) {
    const zipPath = relativePath ? path.join(relativePath, name) : name;

    if (entry.isDirectory) {
      // Recursively process subdirectory from all source paths
      zipMergedDirectoriesRecursive(dirPaths, zipPath, zipFile, outputChannel);
    } else {
      // Use a stream for lazy file reading - files are only read when zip is generated
      outputChannel.appendLine(`Zipping: ${zipPath}`);
      zipFile.file(zipPath, fs.createReadStream(entry.sourcePath));
    }
  }
}


export const zip2stream = (zipFile: JSZip): NodeJS.ReadableStream => {
  // Use generateNodeStream for true streaming - generates zip on-the-fly
  // instead of buffering the entire zip in memory
  return zipFile.generateNodeStream({ type: 'nodebuffer', streamFiles: true });
}

/**
 * Create a true streaming zip from multiple directories using archiver.
 * Files are discovered and compressed as the stream is consumed, not beforehand.
 * Later directories in the array override files from earlier directories.
 * Returns a readable stream that can be piped directly to upload.
 */
export const createStreamingZip = (
  dirPaths: string[],
  outputChannel: vscode.OutputChannel,
  ignorePatterns?: string[]
): NodeJS.ReadableStream => {
  const archive = archiver('zip', {
    zlib: { level: 6 } // Compression level
  });

  // Handle archive errors
  archive.on('error', (err) => {
    outputChannel.appendLine(`Archive error: ${err.message}`);
    throw err;
  });

  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
      outputChannel.appendLine(`Archive warning: ${err.message}`);
    } else {
      throw err;
    }
  });

  // Log when entries are added (this happens as stream is consumed)
  archive.on('entry', (entry) => {
    outputChannel.appendLine(`Streaming: ${entry.name}`);
  });

  if (ignorePatterns && ignorePatterns.length > 0) {
    outputChannel.appendLine(`Ignoring patterns: ${ignorePatterns.join(', ')}`);
  }

  // Build file map with later directories overriding earlier ones
  const addFilesFromMergedDirs = (relativePath: string = '') => {
    const fileMap = new Map<string, { sourcePath: string; isDirectory: boolean }>();

    for (const dirPath of dirPaths) {
      const fullDirPath = relativePath ? path.join(dirPath, relativePath) : dirPath;

      if (!fs.existsSync(fullDirPath)) {
        continue;
      }
      const stat = fs.statSync(fullDirPath);
      if (!stat.isDirectory()) {
        continue;
      }

      const entries = fs.readdirSync(fullDirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name === '.git') {
          continue;
        }
        // Skip symlinks - they should not be included in deployments
        // (checksum calculation also skips them since isFile() returns false for symlinks)
        if (entry.isSymbolicLink()) {
          outputChannel.appendLine(`Skipping symlink: ${relativePath ? `${relativePath}/${entry.name}` : entry.name}`);
          continue;
        }
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (shouldIgnore(entryRelativePath, ignorePatterns)) {
          outputChannel.appendLine(`Ignoring: ${entryRelativePath}`);
          continue;
        }
        // Only include regular files and directories
        if (!entry.isFile() && !entry.isDirectory()) {
          continue;
        }
        fileMap.set(entry.name, {
          sourcePath: path.join(fullDirPath, entry.name),
          isDirectory: entry.isDirectory()
        });
      }
    }

    // Process all entries
    for (const [name, entry] of fileMap) {
      const zipPath = relativePath ? path.join(relativePath, name) : name;

      if (entry.isDirectory) {
        // Recursively process subdirectory
        addFilesFromMergedDirs(zipPath);
      } else {
        // Add file to archive - archiver streams file content when needed
        archive.file(entry.sourcePath, { name: zipPath });
      }
    }
  };

  // Start adding files (this queues them for streaming)
  addFilesFromMergedDirs();

  // Finalize the archive - stream will complete when all files are processed
  archive.finalize();

  return archive;
};


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
      ...form.getHeaders(),
      'Authorization': `Bearer ${secret}`
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (response.status === 200) {
    return response.data;
  } else {
    throw new Error(`Failed to upload asset: ${response.status}`);
  }
}

/**
 * Upload asset using streaming endpoint.
 * Sends raw zip data with checksum in X-Checksum header.
 * This endpoint supports chunked transfer encoding for true streaming.
 */
export const uploadAssetStream = async (
  uploadUrl: string,
  stream: NodeJS.ReadableStream,
  checksum: string,
  secret: string
) => {
  const response = await axios.post(uploadUrl, stream, {
    headers: {
      'Content-Type': 'application/zip',
      'X-Checksum': checksum,
      'Authorization': `Bearer ${secret}`,
      'Transfer-Encoding': 'chunked',
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (response.status === 200) {
    return response.data;
  } else {
    throw new Error(`Failed to upload asset: ${response.status}`);
  }
}

export interface AutomationConfigParams {
  image?: string;
  expose?: boolean;
  port?: number;
  mountPath?: string;
  secretGroups?: string[];
  automationId?: string;
  auth?: boolean;
}

export const promoteAutomation = async (
  deployUrl: string,
  secret: string,
  checksum: string,
  stage: string,
  relativePath?: string,
  automationConfig?: AutomationConfigParams
) => {
  const form = new FormData();
  form.append('checksum', checksum);
  form.append('stage', stage);
  if (relativePath) {
    form.append('relative_path', relativePath);
  }
  // Send automation config for live-dev (so server doesn't need to read from filesystem)
  if (automationConfig) {
    if (automationConfig.image) {
      form.append('image', automationConfig.image);
    }
    if (automationConfig.expose !== undefined) {
      form.append('expose', automationConfig.expose.toString());
    }
    if (automationConfig.port !== undefined) {
      form.append('port', automationConfig.port.toString());
    }
    if (automationConfig.mountPath) {
      form.append('mount_path', automationConfig.mountPath);
    }
    if (automationConfig.secretGroups && automationConfig.secretGroups.length > 0) {
      form.append('secret_groups', automationConfig.secretGroups.join(','));
    }
    if (automationConfig.automationId) {
      form.append('automation_id', automationConfig.automationId);
    }
    if (automationConfig.auth !== undefined) {
      form.append('auth', automationConfig.auth.toString());
    }
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


