import * as vscode from 'vscode';
import { UnifiedBusinessProcessesViewProvider } from '../views/unified_business_processes_view';

export async function refreshBusinessProcessesCommand(context: vscode.ExtensionContext, treeDataProvider: UnifiedBusinessProcessesViewProvider) {
    console.log('[DEBUG] refreshBusinessProcessesCommand function called');
    // For business processes, we just need to refresh the tree data provider
    // since business processes are determined by the file system structure
    treeDataProvider.refresh();
    console.log('[DEBUG] refreshBusinessProcessesCommand completed');
}
