import * as vscode from 'vscode';
import { BaseSourcesViewProvider, FolderItem } from './sources_view';

export class ImageSourcesViewProvider extends BaseSourcesViewProvider {
    constructor(context: vscode.ExtensionContext) {
        super(context);
    }

    protected getMarkerFileName(): string {
        return 'Dockerfile';
    }
}
