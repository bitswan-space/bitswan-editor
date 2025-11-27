import * as fs from "fs";
import * as path from "path";
import FormData from "form-data";
import JSZip from "jszip";
import axios from "axios";
import urlJoin from "proper-url-join";
import * as vscode from "vscode";

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

interface PipelinesDeploymentSectionState {
  pipelinesConfPath: string;
  lines: string[];
  deploymentSectionIndex: number;
  preLineIndex: number;
  preValue: string | null;
  newline: string;
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

function getCurrentPreValue(automationFolderPath: string): string | null {
  const section = loadPipelinesDeploymentSection(automationFolderPath);
  return section?.preValue ?? null;
}

function extractChecksumFromTag(tag: string): string | null {
  const match = tag.match(/:sha([0-9a-fA-F]+)/);
  return match ? match[1] : null;
}

async function updatePipelinesPreValue(
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
  const currentPreValue = getCurrentPreValue(automationFolderPath);
  const currentPreChecksum = currentPreValue
    ? extractChecksumFromTag(currentPreValue)
    : null;

  if (currentPreValue) {
    const checksumInfo = currentPreChecksum
      ? ` (checksum ${currentPreChecksum})`
      : "";
    outputChannel.appendLine(
      `pipelines.conf pre currently set to ${currentPreValue}${checksumInfo}`
    );
  } else {
    outputChannel.appendLine(
      "pipelines.conf pre entry not found, it will be created if the build succeeds"
    );
  }

  const writePreReference = async () =>
    updatePipelinesPreValue(automationFolderPath, expectedTag, outputChannel);

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
    await writePreReference();
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
    await writePreReference();
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

  await writePreReference();
  return {
    checksum,
    imageTag: expectedTag,
    status: "ready",
  };
}

