import * as vscode from 'vscode';
import * as path from 'path';
import { ImageItem } from  '../views/images_view';
import { GitOpsItem } from '../views/workspaces_view';
import { getImageLogs, getImages } from '../lib';
import { outputChannel, outputChannelsMap } from '../extension';
import { ImagesViewProvider } from '../views/images_view';

export async function showImageLogsCommand(context: vscode.ExtensionContext, treeDataProvider: ImagesViewProvider, item: ImageItem) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    try {
        outputChannel.appendLine(`Fetching logs for image build process: ${item.label}`);

        // split the image label to get the image tag (it is currently in the form repository/tag)
        const imageTag = item.label.split('/')[1];
        
        const logsUri = path.join(activeInstance.url, "images", imageTag, "logs").toString();
        const logsResponse = await getImageLogs(logsUri, activeInstance.secret);
        
        if (!logsResponse) {
            throw new Error('Failed to fetch logs from server');
        }
        
        // Create a dedicated output channel for this automation's logs
        const logChannelName = `BitSwan: ${item.label} Logs`;
        
        // Check if the channel already exists in our map
        let logChannel: vscode.OutputChannel;
        if (outputChannelsMap.has(logChannelName)) {
            outputChannel.appendLine(`Using existing output channel: ${logChannelName}`);
            logChannel = outputChannelsMap.get(logChannelName)!;
            logChannel.clear(); // Clear existing content
        } else {
            outputChannel.appendLine(`Creating new output channel: ${logChannelName}`);
            logChannel = vscode.window.createOutputChannel(logChannelName);
            outputChannelsMap.set(logChannelName, logChannel);
        }
        
        // Display logs in the output channel
        logChannel.appendLine('='.repeat(80));
        logChannel.appendLine(`Logs for image build: ${item.label}`);
        logChannel.appendLine(`Fetched at: ${new Date().toISOString()}`);
        logChannel.appendLine('='.repeat(80));
        logChannel.appendLine('');
        
        // Handle the specific JSON response format
        logsResponse.logs.forEach((logLine: string) => {
            logChannel.appendLine(logLine);
        });
        
        // Show the output channel
        logChannel.show(true);
        
        outputChannel.appendLine(`Logs for ${item.label} displayed successfully`);
    } catch (error: any) {
        let errorMessage = error.message || 'Unknown error occurred';
        outputChannel.appendLine(`Error fetching logs: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to fetch logs: ${errorMessage}`);
    }
}

export async function refreshImagesCommand(context: vscode.ExtensionContext, treeDataProvider: ImagesViewProvider) {
    const activeInstance = context.globalState.get<GitOpsItem>('activeGitOpsInstance');
    if (!activeInstance) {
        vscode.window.showErrorMessage('No active GitOps instance');
        return;
    }

    try {
        const images = await getImages(path.join(activeInstance.url, "images").toString(), activeInstance.secret);
        await context.globalState.update('images', images);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to get images from GitOps: ${error.message}`);
        await context.globalState.update('images', []);
    }

    treeDataProvider.refresh();
} 

