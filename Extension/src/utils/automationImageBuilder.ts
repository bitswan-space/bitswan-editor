import * as fs from "fs";
import * as path from "path";
import FormData from "form-data";
import JSZip from "jszip";
import axios from "axios";
import urlJoin from "proper-url-join";
import * as vscode from "vscode";
import * as toml from "@iarna/toml";

import { sanitizeName } from "./nameUtils";
import {
  calculateGitTreeHash,
  deploy,
  getImages,
  shouldIgnore,
  zip2stream,
  zipDirectory,
} from "../lib";
import { DeployDetails } from "../deploy_details";

export interface AutomationImageResult {
  checksum: string;
  imageTag: string;
  status: "ready" | "building" | "failed";
}

const IMAGE_FOLDER_NAME = "image";

// Types for config file handling
type ConfigFormat = "toml" | "ini";

interface ConfigState {
  format: ConfigFormat;
  filePath: string;
  imageValue: string | null;
}

interface PipelinesDeploymentSectionState {
  pipelinesConfPath: string;
  lines: string[];
  deploymentSectionIndex: number;
  preLineIndex: number;
  preValue: string | null;
  newline: string;
}

interface AutomationTomlState {
  automationTomlPath: string;
  data: toml.JsonMap;
  imageValue: string | null;
}

/**
 * Detect which config format is available in the automation folder.
 * Priority: automation.toml > pipelines.conf
 */
function detectConfigFormat(automationFolderPath: string): ConfigFormat | null {
  const tomlPath = path.join(automationFolderPath, "automation.toml");
  const iniPath = path.join(automationFolderPath, "pipelines.conf");

  if (fs.existsSync(tomlPath)) {
    return "toml";
  }
  if (fs.existsSync(iniPath)) {
    return "ini";
  }
  return null;
}

/**
 * Load automation.toml state
 */
function loadAutomationTomlState(
  automationFolderPath: string
): AutomationTomlState | null {
  const automationTomlPath = path.join(automationFolderPath, "automation.toml");
  if (!fs.existsSync(automationTomlPath)) {
    return null;
  }

  const content = fs.readFileSync(automationTomlPath, "utf-8");
  const data = toml.parse(content);
  const deployment = (data.deployment as toml.JsonMap) || {};
  const imageValue = (deployment.image as string) || null;

  return {
    automationTomlPath,
    data,
    imageValue,
  };
}

/**
 * Automation config values needed for deployment
 */
export interface AutomationDeployConfig {
  image: string;
  expose: boolean;
  port: number;
  mountPath: string;
  secretGroups?: string[];
  ignore?: string[];
  automationId?: string;
  auth?: boolean;
  services?: Record<string, { enabled: boolean }>;
}

/**
 * Read automation config from automation.toml or pipelines.conf.
 * Returns config values needed for deployment.
 */
/**
 * Parse a TOML value that can be either a string or array of strings.
 */
function parseStringOrArray(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return undefined;
}

export function getAutomationDeployConfig(automationFolderPath: string): AutomationDeployConfig {
  // Default values
  const defaults: AutomationDeployConfig = {
    image: "bitswan/pipeline-runtime-environment:latest",
    expose: false,
    port: 8080,
    mountPath: "/opt/pipelines",
  };

  // Try automation.toml first
  const tomlState = loadAutomationTomlState(automationFolderPath);
  if (tomlState) {
    const deployment = (tomlState.data.deployment as toml.JsonMap) || {};
    const secrets = (tomlState.data.secrets as toml.JsonMap) || {};
    const liveDevSecrets = parseStringOrArray(secrets["live-dev"]);
    const ignorePatterns = parseStringOrArray(deployment.ignore);

    // Parse [services.*] sections
    const servicesSection = tomlState.data.services as toml.JsonMap | undefined;
    let services: Record<string, { enabled: boolean }> | undefined;
    if (servicesSection) {
      services = {};
      for (const [svcName, svcConf] of Object.entries(servicesSection)) {
        const conf = svcConf as toml.JsonMap | undefined;
        services[svcName] = { enabled: (conf?.enabled as boolean) ?? true };
      }
    }

    return {
      image: (deployment.image as string) || defaults.image,
      expose: (deployment.expose as boolean) ?? defaults.expose,
      port: (deployment.port as number) ?? defaults.port,
      mountPath: "/app/", // TOML format always uses /app/
      secretGroups: liveDevSecrets,
      ignore: ignorePatterns,
      automationId: deployment.id as string | undefined,
      auth: deployment.auth as boolean | undefined,
      services,
    };
  }

  // Fall back to pipelines.conf
  const pipelinesPath = path.join(automationFolderPath, "pipelines.conf");
  if (fs.existsSync(pipelinesPath)) {
    // For INI format, just return defaults with /opt/pipelines mount path
    return defaults;
  }

  return defaults;
}

function loadPipelinesDeploymentSection(
  automationFolderPath: string
): PipelinesDeploymentSectionState | null {
  const pipelinesConfPath = path.join(automationFolderPath, "pipelines.conf");
  if (!fs.existsSync(pipelinesConfPath)) {
    return null;
  }

  const originalContent = fs.readFileSync(pipelinesConfPath, "utf-8");
  const lines = originalContent.split(/\r?\n/);
  const newline = originalContent.includes("\r\n") ? "\r\n" : "\n";

  let inDeploymentSection = false;
  let deploymentSectionIndex = -1;
  let preLineIndex = -1;
  let preValue: string | null = null;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inDeploymentSection = trimmed.toLowerCase() === "[deployment]";
      if (inDeploymentSection) {
        deploymentSectionIndex = index;
      }
      return;
    }

    if (inDeploymentSection && trimmed.toLowerCase().startsWith("pre=")) {
      preLineIndex = index;
      preValue = trimmed.substring(4);
    }
  });

  return {
    pipelinesConfPath,
    lines,
    deploymentSectionIndex,
    preLineIndex,
    preValue,
    newline,
  };
}

/**
 * Get the current image value from either automation.toml or pipelines.conf
 */
function getCurrentImageValue(automationFolderPath: string): ConfigState | null {
  // Try automation.toml first
  const tomlState = loadAutomationTomlState(automationFolderPath);
  if (tomlState) {
    return {
      format: "toml",
      filePath: tomlState.automationTomlPath,
      imageValue: tomlState.imageValue,
    };
  }

  // Fall back to pipelines.conf
  const iniState = loadPipelinesDeploymentSection(automationFolderPath);
  if (iniState) {
    return {
      format: "ini",
      filePath: iniState.pipelinesConfPath,
      imageValue: iniState.preValue,
    };
  }

  return null;
}

function extractChecksumFromTag(tag: string): string | null {
  const match = tag.match(/:sha([0-9a-fA-F]+)/);
  return match ? match[1] : null;
}

/**
 * Update automation.toml with new image value.
 * Validates the TOML first, then uses string-level editing to preserve
 * the original file formatting and content.
 */
async function updateAutomationTomlImageValue(
  automationFolderPath: string,
  newImageValue: string,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const automationTomlPath = path.join(automationFolderPath, "automation.toml");

  if (!fs.existsSync(automationTomlPath)) {
    // Create new automation.toml
    const newData: toml.JsonMap = {
      deployment: {
        image: newImageValue,
      },
    };
    fs.writeFileSync(automationTomlPath, toml.stringify(newData), "utf-8");
    outputChannel.appendLine(
      `Created automation.toml with image value ${newImageValue}`
    );
    return;
  }

  const content = fs.readFileSync(automationTomlPath, "utf-8");

  // Validate TOML syntax before proceeding
  try {
    toml.parse(content);
  } catch (e: any) {
    const msg = `automation.toml has invalid TOML syntax: ${e.message || e}`;
    outputChannel.appendLine(msg);
    throw new Error(msg);
  }

  const lines = content.split(/\r?\n/);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";

  let inDeploymentSection = false;
  let imageLineIndex = -1;
  let deploymentSectionIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inDeploymentSection = trimmed.toLowerCase() === "[deployment]";
      if (inDeploymentSection) {
        deploymentSectionIndex = i;
      }
      continue;
    }
    if (inDeploymentSection && trimmed.toLowerCase().startsWith("image")) {
      const match = trimmed.match(/^image\s*=\s*/);
      if (match) {
        imageLineIndex = i;
        break;
      }
    }
  }

  if (imageLineIndex >= 0) {
    // Check if already up to date
    const currentLine = lines[imageLineIndex].trim();
    const expectedLine = `image = "${newImageValue}"`;
    if (currentLine === expectedLine) {
      outputChannel.appendLine(
        `automation.toml image already points to ${newImageValue}, no update needed`
      );
      return;
    }
    // Replace just the image line, preserving leading whitespace
    const prefix = lines[imageLineIndex].substring(
      0,
      lines[imageLineIndex].indexOf(lines[imageLineIndex].trim())
    );
    lines[imageLineIndex] = `${prefix}image = "${newImageValue}"`;
  } else if (deploymentSectionIndex >= 0) {
    // [deployment] exists but no image key — insert after the section header
    lines.splice(deploymentSectionIndex + 1, 0, `image = "${newImageValue}"`);
  } else {
    // No [deployment] section at all — append one
    lines.push("");
    lines.push("[deployment]");
    lines.push(`image = "${newImageValue}"`);
  }

  fs.writeFileSync(automationTomlPath, lines.join(newline), "utf-8");
  outputChannel.appendLine(
    `Updated automation.toml image value to ${newImageValue}`
  );
}

/**
 * Update pipelines.conf with new pre value
 */
async function updatePipelinesConfPreValue(
  automationFolderPath: string,
  newPreValue: string,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const section = loadPipelinesDeploymentSection(automationFolderPath);
  if (!section) {
    const pipelinesConfPath = path.join(automationFolderPath, "pipelines.conf");
    outputChannel.appendLine(
      `pipelines.conf not found at ${pipelinesConfPath}, skipping pre update`
    );
    return;
  }

  const {
    pipelinesConfPath,
    lines,
    deploymentSectionIndex,
    preLineIndex,
    newline,
  } = section;

  let changed = false;

  if (preLineIndex >= 0) {
    const existingLine = lines[preLineIndex];
    const trimmed = existingLine.trim();
    if (trimmed !== `pre=${newPreValue}`) {
      const prefix = existingLine.substring(
        0,
        existingLine.indexOf(existingLine.trim())
      );
      lines[preLineIndex] = `${prefix}pre=${newPreValue}`;
      changed = true;
    }
  } else {
    if (deploymentSectionIndex === -1) {
      lines.push("[deployment]");
      lines.push(`pre=${newPreValue}`);
    } else {
      const insertionIndex = deploymentSectionIndex + 1;
      lines.splice(insertionIndex, 0, `pre=${newPreValue}`);
    }
    changed = true;
  }

  if (changed) {
    const updatedContent = lines.join(newline);
    fs.writeFileSync(pipelinesConfPath, updatedContent, "utf-8");
    outputChannel.appendLine(
      `Updated pipelines.conf pre value to ${newPreValue}`
    );
  } else {
    outputChannel.appendLine(
      `pipelines.conf pre already points to ${newPreValue}, no update needed`
    );
  }
}

/**
 * Update the image reference in the appropriate config file.
 * Uses automation.toml if it exists, otherwise pipelines.conf.
 */
async function updateImageReference(
  automationFolderPath: string,
  newImageValue: string,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const configFormat = detectConfigFormat(automationFolderPath);

  if (configFormat === "toml") {
    await updateAutomationTomlImageValue(
      automationFolderPath,
      newImageValue,
      outputChannel
    );
  } else {
    // Default to pipelines.conf (will create if needed)
    await updatePipelinesConfPreValue(
      automationFolderPath,
      newImageValue,
      outputChannel
    );
  }
}

async function streamImageBuildLogs(
  details: DeployDetails,
  checksum: string,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const logsUrl = urlJoin(
    details.deployUrl,
    "images",
    "builds",
    checksum,
    "stream"
  ).toString();

  const response = await axios.get(logsUrl, {
    headers: {
      Authorization: `Bearer ${details.deploySecret}`,
    },
    responseType: "stream",
  });

  await new Promise<void>((resolve, reject) => {
    const stream = response.data;
    stream.on("data", (chunk: Buffer) => {
      outputChannel.append(chunk.toString());
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
}

async function waitForImageStatus(
  details: DeployDetails,
  expectedTag: string,
  desiredStatuses: ("ready" | "failed")[],
  outputChannel: vscode.OutputChannel
): Promise<"ready" | "failed"> {
  const imagesUrl = urlJoin(details.deployUrl, "images").toString();
  const deadline = Date.now() + 1000 * 60 * 5; // 5 minutes

  while (Date.now() < deadline) {
    const images = await getImages(imagesUrl, details.deploySecret);
    const match = images.find((image: any) => image.tag === expectedTag);
    let status: "ready" | "failed" | "building" | undefined =
      match?.build_status;
    if (match && !status) {
      status = "ready";
    }

    const normalizedStatus =
      status === "ready" || status === "failed" ? status : undefined;

    if (normalizedStatus && desiredStatuses.includes(normalizedStatus)) {
      return normalizedStatus;
    }

    if (match && status === "failed") {
      return "failed";
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  outputChannel.appendLine(
    `Timed out waiting for image ${expectedTag} to reach desired status`
  );
  throw new Error(
    `Timed out waiting for image ${expectedTag} build to complete`
  );
}

async function startImageBuild(
  details: DeployDetails,
  automationFolderPath: string,
  checksum: string,
  normalizedName: string,
  outputChannel: vscode.OutputChannel,
  ignorePatterns?: string[]
): Promise<void> {
  const imageDir = path.join(automationFolderPath, IMAGE_FOLDER_NAME);
  let zip = await zipDirectory(imageDir, "", new JSZip(), outputChannel, ignorePatterns);
  const stream = zip2stream(zip);

  const form = new FormData();
  form.append("file", stream, {
    filename: `${normalizedName}-image.zip`,
    contentType: "application/zip",
  });
  form.append("checksum", checksum);

  const deployUrl = urlJoin(
    details.deployUrl,
    "images",
    normalizedName
  ).toString();

  outputChannel.appendLine(
    `Uploading automation image ${normalizedName} with checksum ${checksum}`
  );
  await deploy(deployUrl, form, details.deploySecret, outputChannel);
  outputChannel.appendLine("Image upload successful, waiting for build logs...");
}

/**
 * Pre-flight check on the image/ directory.
 * Returns a warning message string if issues are found, or null if everything looks fine.
 */
export function checkImageDirectoryPreflight(
  automationFolderPath: string,
  ignorePatterns?: string[]
): string | null {
  const imageFolder = path.join(automationFolderPath, IMAGE_FOLDER_NAME);
  if (!fs.existsSync(imageFolder) || !fs.statSync(imageFolder).isDirectory()) {
    return null;
  }

  const warnings: string[] = [];
  let fileCount = 0;
  let hasUnignoredNodeModules = false;

  function walk(dir: string, relativePath: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (shouldIgnore(entryRelative, ignorePatterns)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          hasUnignoredNodeModules = true;
        }
        walk(path.join(dir, entry.name), entryRelative);
      } else if (entry.isFile()) {
        fileCount++;
      }
    }
  }

  walk(imageFolder, "");

  if (hasUnignoredNodeModules) {
    warnings.push(
      "The image/ directory contains an unignored node_modules folder. " +
      "Add 'node_modules' to [deployment].ignore in automation.toml to exclude it."
    );
  }
  if (fileCount > 150) {
    warnings.push(
      `The image/ directory contains ${fileCount} files (after applying ignore patterns). ` +
      "This may result in a very large image upload."
    );
  }

  return warnings.length > 0 ? warnings.join("\n\n") : null;
}

export async function ensureAutomationImageReady(
  details: DeployDetails,
  automationFolderPath: string,
  outputChannel: vscode.OutputChannel,
  ignorePatterns?: string[]
): Promise<AutomationImageResult | null> {
  const imageFolder = path.join(automationFolderPath, IMAGE_FOLDER_NAME);
  const dockerfilePath = path.join(imageFolder, "Dockerfile");

  if (
    !fs.existsSync(imageFolder) ||
    !fs.statSync(imageFolder).isDirectory() ||
    !fs.existsSync(dockerfilePath)
  ) {
    return null;
  }

  const automationName = path.basename(automationFolderPath);
  const normalizedName = sanitizeName(automationName);

  const checksum = calculateGitTreeHash(imageFolder, outputChannel, ignorePatterns);
  const expectedTag = `internal/${normalizedName}:sha${checksum}`;

  // Get current image value from either config format
  const configState = getCurrentImageValue(automationFolderPath);
  const currentImageValue = configState?.imageValue ?? null;
  const currentImageChecksum = currentImageValue
    ? extractChecksumFromTag(currentImageValue)
    : null;

  if (currentImageValue) {
    const checksumInfo = currentImageChecksum
      ? ` (checksum ${currentImageChecksum})`
      : "";
    const configFile = configState?.format === "toml" ? "automation.toml" : "pipelines.conf";
    const fieldName = configState?.format === "toml" ? "image" : "pre";
    outputChannel.appendLine(
      `${configFile} ${fieldName} currently set to ${currentImageValue}${checksumInfo}`
    );
  } else {
    outputChannel.appendLine(
      "No image reference found in config, it will be created if the build succeeds"
    );
  }

  const writeImageReference = async () =>
    updateImageReference(automationFolderPath, expectedTag, outputChannel);

  const imagesUrl = urlJoin(details.deployUrl, "images").toString();
  let images = await getImages(imagesUrl, details.deploySecret);
  let existing = images.find((img: any) => img.tag === expectedTag);

  if (
    existing &&
    (!existing.build_status || existing.build_status === "ready")
  ) {
    outputChannel.appendLine(
      `Image ${expectedTag} already built, skipping rebuild`
    );
    await writeImageReference();
    return {
      checksum,
      imageTag: expectedTag,
      status: "ready",
    };
  }

  outputChannel.show(true);

  if (existing && existing.build_status === "building") {
    outputChannel.appendLine(
      `Image ${expectedTag} currently building, attaching to logs...`
    );
  } else {
    await startImageBuild(
      details,
      automationFolderPath,
      checksum,
      normalizedName,
      outputChannel,
      ignorePatterns
    );
  }

  await streamImageBuildLogs(details, checksum, outputChannel);

  images = await getImages(imagesUrl, details.deploySecret);
  existing = images.find((img: any) => img.tag === expectedTag);
  if (
    existing &&
    (!existing.build_status || existing.build_status === "ready")
  ) {
    outputChannel.appendLine(`Image ${expectedTag} built successfully`);
    await writeImageReference();
    return {
      checksum,
      imageTag: expectedTag,
      status: "ready",
    };
  }

  const finalStatus = await waitForImageStatus(
    details,
    expectedTag,
    ["ready", "failed"],
    outputChannel
  );

  if (finalStatus !== "ready") {
    throw new Error(`Image ${expectedTag} failed to build`);
  }

  await writeImageReference();
  return {
    checksum,
    imageTag: expectedTag,
    status: "ready",
  };
}
