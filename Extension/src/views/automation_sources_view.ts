import * as vscode from 'vscode';
import { BaseSourcesViewProvider, FolderItem } from './sources_view';

export class AutomationSourcesViewProvider extends BaseSourcesViewProvider {
    constructor(context: vscode.ExtensionContext) {
        super(context);
    }

    protected getMarkerFileName(): string {
        return 'pipelines.conf';
    }
}