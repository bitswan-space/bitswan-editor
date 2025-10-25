import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FolderItem } from './sources_view';
import { AutomationItem } from './automations_view';
import { sanitizeName } from '../utils/nameUtils';

/**
 * Tree item representing a business process (directory containing process.toml)
 */
export class BusinessProcessItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly resourceUri: vscode.Uri,
        public readonly processConfigPath: string
    ) {
        // Extract just the folder name from the path
        const displayName = name.split('/').pop() || name;
        super(displayName, vscode.TreeItemCollapsibleState.Expanded);
        this.tooltip = `${this.name} (Business Process)`;
        this.contextValue = 'businessProcess';
        this.iconPath = new vscode.ThemeIcon('organization');
    }
}

/**
 * Tree item representing an automation source within a business process
 */
export class AutomationSourceItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly resourceUri: vscode.Uri,
        public readonly businessProcessName?: string
    ) {
        // Extract just the folder name from the path
        const displayName = name.split('/').pop() || name;
        super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
        this.tooltip = `${this.name} (Automation Source)`;
        this.contextValue = 'automationSource';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

/**
 * Tree item representing the "Other automations" virtual business process
 */
export class OtherAutomationsItem extends vscode.TreeItem {
    constructor() {
        super('Other', vscode.TreeItemCollapsibleState.Expanded);
        this.tooltip = 'Automation sources not belonging to any business process';
        this.contextValue = 'otherAutomations';
        this.iconPath = new vscode.ThemeIcon('folder-opened');
    }
}

/**
 * Unified view provider that shows business processes as trunks with automation sources as branches,
 * and running automations as leaves under their respective automation sources
 */
export class UnifiedBusinessProcessesViewProvider implements vscode.TreeDataProvider<BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | undefined | null | void> = new vscode.EventEmitter<BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        console.log(`[DEBUG] UnifiedBusinessProcessesViewProvider.refresh() called`);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem): Promise<(BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem)[]> {
        const activeInstance = this.context.globalState.get<any>('activeGitOpsInstance');
        console.log(`[DEBUG] getChildren called - activeInstance:`, activeInstance);
        if (!activeInstance) {
            console.log(`[DEBUG] getChildren - no active GitOps instance, returning empty array`);
            return [];
        }

        if (!element) {
            // Root level - show business processes and "Other automations"
            console.log(`[DEBUG] getChildren - root level, getting business processes`);
            return this.getBusinessProcesses();
        }

        if (element instanceof BusinessProcessItem) {
            // Show automation sources for this business process
            console.log(`[DEBUG] getChildren - BusinessProcessItem: "${element.name}"`);
            return this.getAutomationSourcesForBusinessProcess(element.name);
        }

        if (element instanceof AutomationSourceItem) {
            // Show running automations for this automation source
            console.log(`[DEBUG] getChildren - AutomationSourceItem: "${element.name}"`);
            return this.getAutomationsForSource(element.name);
        }

        if (element instanceof OtherAutomationsItem) {
            // Show automation sources not belonging to any business process
            console.log(`[DEBUG] getChildren - OtherAutomationsItem`);
            return this.getOtherAutomationSources();
        }

        console.log(`[DEBUG] getChildren - unknown element type: ${element.constructor.name}`);
        return [];
    }

    private getBusinessProcesses(): (BusinessProcessItem | OtherAutomationsItem)[] {
        const businessProcesses: (BusinessProcessItem | OtherAutomationsItem)[] = [];
        
        if (!vscode.workspace.workspaceFolders) {
            return [new OtherAutomationsItem()];
        }

        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const processDirs = this.findDirectoriesWithProcessToml(workspacePath);

        for (const processDir of processDirs) {
            const relativePath = path.relative(workspacePath, processDir);
            const processConfigPath = path.join(processDir, 'process.toml');
            
            businessProcesses.push(new BusinessProcessItem(
                relativePath,
                vscode.Uri.file(processDir),
                processConfigPath
            ));
        }

        // Always include "Other automations" at the end
        businessProcesses.push(new OtherAutomationsItem());

        return businessProcesses;
    }

    private getAutomationSourcesForBusinessProcess(businessProcessName: string): AutomationSourceItem[] {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const businessProcessPath = path.join(workspacePath, businessProcessName);
        
        console.log(`[DEBUG] getAutomationSourcesForBusinessProcess called for business process: "${businessProcessName}"`);
        console.log(`[DEBUG] Business process path: "${businessProcessPath}"`);
        
        const sources = this.getAutomationSourcesInDirectory(businessProcessPath, businessProcessName);
        console.log(`[DEBUG] Found ${sources.length} automation sources for business process "${businessProcessName}": ${sources.map(s => s.name).join(', ')}`);
        
        return sources;
    }

    private getOtherAutomationSources(): (AutomationSourceItem | AutomationItem)[] {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const allAutomationSources = this.getAllAutomationSources(workspacePath);
        const businessProcessSources = this.getAllBusinessProcessSources(workspacePath);
        
        // Find automation sources that don't belong to any business process
        const otherSources = allAutomationSources.filter(source => 
            !businessProcessSources.some(bpSource => 
                source.resourceUri.fsPath.startsWith(bpSource.resourceUri.fsPath)
            )
        );

        const result: (AutomationSourceItem | AutomationItem)[] = otherSources.map(source => new AutomationSourceItem(
            source.name,
            source.resourceUri
        ));

        // Add orphaned automations (automations that don't belong to any automation source)
        const automations = this.context.globalState.get<any[]>('automations', []);
        console.log(`[DEBUG] getOtherAutomationSources - checking ${automations.length} automations for orphaned status`);
        console.log(`[DEBUG] Available automation sources: ${allAutomationSources.map(s => s.name).join(', ')}`);
        
        const orphanedAutomations = automations.filter(automation => {
            // Check if this automation belongs to any automation source
            const belongsToSource = allAutomationSources.some(source => {
                // Extract just the automation source name from the full path
                const automationSourceName = source.name.split('/').pop() || source.name;
                const sanitizedSourceName = sanitizeName(automationSourceName);
                
                // Extract the automation source name from the automation's relative path
                const automationSourceFromPath = automation.relativePath?.split('/').pop() || '';
                const sanitizedAutomationSource = sanitizeName(automationSourceFromPath);
                
                const matches = automation.relativePath === sanitizedSourceName || 
                               automation.relativePath?.startsWith(sanitizedSourceName + '/') ||
                               sanitizedAutomationSource === sanitizedSourceName;
                console.log(`[DEBUG] Checking if automation "${automation.name}" (relativePath: "${automation.relativePath}") belongs to source "${source.name}" (sanitized: "${sanitizedSourceName}") - matches: ${matches}`);
                console.log(`[DEBUG]   - automationSourceFromPath: "${automationSourceFromPath}"`);
                console.log(`[DEBUG]   - sanitizedAutomationSource: "${sanitizedAutomationSource}"`);
                return matches;
            });
            const isOrphaned = !belongsToSource && automation.relativePath;
            console.log(`[DEBUG] Automation "${automation.name}" (relativePath: "${automation.relativePath}") is orphaned: ${isOrphaned}`);
            return isOrphaned; // Only include if it has a relativePath
        });

        console.log(`[DEBUG] Found ${orphanedAutomations.length} orphaned automations`);

        // Add orphaned automations directly to the result
        result.push(...orphanedAutomations.map(automation => 
            new AutomationItem(
                automation.name,
                automation.state,
                automation.status,
                automation.deploymentId,
                automation.active,
                automation.automationUrl,
                automation.relativePath
            )
        ));

        return result;
    }

    private getAutomationsForSource(sourceName: string): AutomationItem[] {
        const automations = this.context.globalState.get<any[]>('automations', []);
        
        // Extract just the automation source name from the full path
        // sourceName might be "business-process/automation-source", we need just "automation-source"
        const automationSourceName = sourceName.split('/').pop() || sourceName;
        const sanitizedSourceName = sanitizeName(automationSourceName);
        
        console.log(`[DEBUG] getAutomationsForSource called with sourceName: "${sourceName}"`);
        console.log(`[DEBUG] Extracted automationSourceName: "${automationSourceName}"`);
        console.log(`[DEBUG] Sanitized sourceName: "${sanitizedSourceName}"`);
        console.log(`[DEBUG] Total automations available: ${automations.length}`);
        
        // Log all automation relative paths for debugging
        automations.forEach((automation, index) => {
            console.log(`[DEBUG] Automation ${index}: name="${automation.name}", relativePath="${automation.relativePath}"`);
        });
        
        // Filter automations that belong to this automation source
        const sourceAutomations = automations.filter(automation => {
            // Extract the automation source name from the automation's relative path
            const automationSourceFromPath = automation.relativePath?.split('/').pop() || '';
            const sanitizedAutomationSource = sanitizeName(automationSourceFromPath);
            
            const matches = automation.relativePath === sanitizedSourceName || 
                           automation.relativePath?.startsWith(sanitizedSourceName + '/') ||
                           sanitizedAutomationSource === sanitizedSourceName;
            console.log(`[DEBUG] Checking automation "${automation.name}" (relativePath: "${automation.relativePath}") against "${sanitizedSourceName}" - matches: ${matches}`);
            console.log(`[DEBUG]   - automationSourceFromPath: "${automationSourceFromPath}"`);
            console.log(`[DEBUG]   - sanitizedAutomationSource: "${sanitizedAutomationSource}"`);
            return matches;
        });

        console.log(`[DEBUG] Found ${sourceAutomations.length} automations for source "${sourceName}"`);

        return sourceAutomations.map(automation => 
            new AutomationItem(
                automation.name,
                automation.state,
                automation.status,
                automation.deploymentId,
                automation.active,
                automation.automationUrl,
                automation.relativePath
            )
        );
    }

    private findDirectoriesWithProcessToml(rootPath: string): string[] {
        const processDirs: string[] = [];

        const findProcessToml = (dirPath: string): void => {
            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });

                // Skip if directory contains .bitswan-ignore
                if (entries.some(entry => entry.isFile() && entry.name === '.bitswan-ignore')) {
                    return;
                }

                // Check if current directory has process.toml
                if (fs.existsSync(path.join(dirPath, 'process.toml'))) {
                    processDirs.push(dirPath);
                }

                // Recursively check subdirectories
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const fullPath = path.join(dirPath, entry.name);
                        findProcessToml(fullPath);
                    }
                }
            } catch (error) {
                // Skip directories that can't be read
            }
        };

        findProcessToml(rootPath);
        return processDirs;
    }

    private getAutomationSourcesInDirectory(dirPath: string, businessProcessName: string): AutomationSourceItem[] {
        const sources: AutomationSourceItem[] = [];

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const fullPath = path.join(dirPath, entry.name);
                    
                    // Check if this directory contains pipelines.conf (automation source marker)
                    if (fs.existsSync(path.join(fullPath, 'pipelines.conf'))) {
                        const relativePath = path.relative(vscode.workspace.workspaceFolders![0].uri.fsPath, fullPath);
                        sources.push(new AutomationSourceItem(
                            relativePath,
                            vscode.Uri.file(fullPath),
                            businessProcessName
                        ));
                    }
                }
            }
        } catch (error) {
            // Skip directories that can't be read
        }

        return sources;
    }

    private getAllAutomationSources(rootPath: string): FolderItem[] {
        const sources: FolderItem[] = [];

        const findAutomationSources = (dirPath: string): void => {
            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });

                // Skip if directory contains .bitswan-ignore
                if (entries.some(entry => entry.isFile() && entry.name === '.bitswan-ignore')) {
                    return;
                }

                // Check if current directory has pipelines.conf
                if (fs.existsSync(path.join(dirPath, 'pipelines.conf'))) {
                    // Only add if it's not the workspace root
                    if (dirPath !== rootPath) {
                        const relativePath = path.relative(rootPath, dirPath);
                        sources.push(new FolderItem(
                            relativePath,
                            vscode.Uri.file(dirPath)
                        ));
                    }
                }

                // Recursively check subdirectories
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const fullPath = path.join(dirPath, entry.name);
                        findAutomationSources(fullPath);
                    }
                }
            } catch (error) {
                // Skip directories that can't be read
            }
        };

        findAutomationSources(rootPath);
        return sources;
    }

    private getAllBusinessProcessSources(rootPath: string): FolderItem[] {
        const sources: FolderItem[] = [];
        const processDirs = this.findDirectoriesWithProcessToml(rootPath);

        for (const processDir of processDirs) {
            const processSources = this.getAutomationSourcesInDirectory(processDir, '');
            sources.push(...processSources);
        }

        return sources;
    }
}
