import * as vscode from 'vscode';
import { ImageItem } from '../views/images_view';
import { getImageLogs, getImages } from '../lib';
import { ImagesViewProvider } from '../views/images_view';
import { showLogsCommand, refreshItemsCommand } from './items';

export async function showImageLogsCommand(context: vscode.ExtensionContext, treeDataProvider: ImagesViewProvider, item: ImageItem) {
    return showLogsCommand(context, treeDataProvider, item, {
        entityType: 'image build process',
        getLogsFunction: getImageLogs
    });
}

export async function refreshImagesCommand(context: vscode.ExtensionContext, treeDataProvider: ImagesViewProvider) {
    return refreshItemsCommand(context, treeDataProvider, {
        entityType: 'image',
        getItemsFunction: getImages
    });
}
