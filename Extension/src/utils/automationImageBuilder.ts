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

  try {
    const content = fs.readFileSync(automationTomlPath, "utf-8");
    const data = toml.parse(content);
    const deployment = (data.deployment as toml.JsonMap) || {};
    const imageValue = (deployment.image as string) || null;

    return {
      automationTomlPath,
      data,
      imageValue,
    };
  } catch {
    return null;
  }
}

/**
 * Automation config values needed for deployment
 */
export interface AutomationDeployConfig {
  image: string;
  expose: boolean;
  port: number;
  mountPath: string;
}

/**
 * Read automation config from automation.toml or pipelines.conf.
 * Returns config values needed for deployment.
 */
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
    return {
      image: (deployment.image as string) || defaults.image,
      expose: (deployment.expose as boolean) ?? defaults.expose,
      port: (deployment.port as number) ?? defaults.port,
      mountPath: "/app/", // TOML format always uses /app/
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
 * Update automation.toml with new image value
 */
async function updateAutomationTomlImageValue(
  automationFolderPath: string,
  newImageValue: string,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const state = loadAutomationTomlState(automationFolderPath);

  if (!state) {
    // Create new automation.toml
    const automationTomlPath = path.join(automationFolderPath, "automation.toml");
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

  const { automationTomlPath, data, imageValue } = state;

  if (imageValue === newImageValue) {
    outputChannel.appendLine(
      `automation.toml image already points to ${newImageValue}, no update needed`
    );
    return;
  }

  // Update the image value
  if (!data.deployment) {
    data.deployment = {};
  }
  (data.deployment as toml.JsonMap).image = newImageValue;

  // Stringify and remove underscores from numbers (TOML 1.0 feature not supported by Python's toml library)
  let tomlContent = toml.stringify(data);
  tomlContent = tomlContent.replace(/(\d)_(\d)/g, '$1$2');

  fs.writeFileSync(automationTomlPath, tomlContent, "utf-8");
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
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const imageDir = path.join(automationFolderPath, IMAGE_FOLDER_NAME);
  let zip = await zipDirectory(imageDir, "", new JSZip(), outputChannel);
  const stream = await zip2stream(zip);

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

export async function ensureAutomationImageReady(
  details: DeployDetails,
  automationFolderPath: string,
  outputChannel: vscode.OutputChannel
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

  const checksum = await calculateGitTreeHash(imageFolder, outputChannel);
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
      outputChannel
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
