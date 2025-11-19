import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import urlJoin from 'proper-url-join';
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
 * Tree item representing a stage (dev/staging/production) under an automation source
 */
export class StageItem extends vscode.TreeItem {
    constructor(
        public readonly stage: 'dev' | 'staging' | 'production',
        public readonly automationSourceName: string,
        public readonly automation: AutomationItem | null, // null if stage not deployed
        public readonly deploymentId: string, // The actual deployment_id (e.g., "my-automation-dev")
        public readonly checksum: string | null = null // Current checksum for this stage
    ) {
        const stageDisplayName = stage.charAt(0).toUpperCase() + stage.slice(1);
        super(stageDisplayName, vscode.TreeItemCollapsibleState.None);
        
        if (automation) {
            // Stage is deployed - show automation details
            const checksumDisplay = checksum ? ` (${checksum.substring(0, 5)}...)` : '';
            this.tooltip = `${stageDisplayName} - ${automation.name}${checksumDisplay}`;
            // Show status and checksum in description
            const statusText = automation.status ?? '';
            const checksumText = checksum ? ` • ${checksum.substring(0, 5)}...` : '';
            this.description = `${statusText}${checksumText}`;
            // Build contextValue similar to AutomationItem for menu matching
            const status = automation.active ? 'active' : 'inactive';
            const state = automation.state ?? 'exited';
            const urlStatus = automation.automationUrl ? 'url' : 'nourl';
            this.contextValue = `automationStage,${stage},deployed,${status},${state},urlStatus:${urlStatus}`;
            this.iconPath = automation.iconPath;
        } else {
            // Stage not deployed - greyed out
            this.tooltip = `${stageDisplayName} - Not deployed`;
            this.description = 'Not deployed';
            this.contextValue = `automationStage,${stage},notDeployed`;
            this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
        }
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
export class CreateAutomationItem extends vscode.TreeItem {
    constructor(public readonly businessProcessName: string) {
        super('Create Automation', vscode.TreeItemCollapsibleState.None);
        this.tooltip = 'Create a new automation from a template';
        this.contextValue = 'createAutomation';
        this.iconPath = new vscode.ThemeIcon('add');
        this.command = {
            command: 'bitswan.openAutomationTemplates',
            title: 'Create Automation',
            arguments: [businessProcessName]
        };
    }
}

export class UnifiedBusinessProcessesViewProvider implements vscode.TreeDataProvider<BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | CreateAutomationItem | StageItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | CreateAutomationItem | StageItem | undefined | null | void> = new vscode.EventEmitter<BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | CreateAutomationItem | StageItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | CreateAutomationItem | StageItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        console.log(`[DEBUG] UnifiedBusinessProcessesViewProvider.refresh() called`);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | CreateAutomationItem | StageItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | CreateAutomationItem | StageItem): Promise<(BusinessProcessItem | AutomationSourceItem | AutomationItem | OtherAutomationsItem | CreateAutomationItem | StageItem)[]> {
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
            const items = this.getAutomationSourcesForBusinessProcess(element.name);
            // Add the "+ Create Automation" button at the end
            return [...items, new CreateAutomationItem(element.name)];
        }

        if (element instanceof AutomationSourceItem) {
            // Show stages (dev/staging/production) for this automation source
            console.log(`[DEBUG] getChildren - AutomationSourceItem: "${element.name}"`);
            return await this.getStagesForSource(element.name);
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

    private async getStagesForSource(sourceName: string): Promise<StageItem[]> {
        const automations = this.context.globalState.get<any[]>('automations', []);
        
        // Extract just the automation source name from the full path
        const automationSourceName = sourceName.split('/').pop() || sourceName;
        const sanitizedSourceName = sanitizeName(automationSourceName);
        
        console.log(`[DEBUG] getStagesForSource called with sourceName: "${sourceName}"`);
        console.log(`[DEBUG] Sanitized sourceName: "${sanitizedSourceName}"`);
        
        // Map stages to their deployment IDs
        const stageDeploymentIds = {
            dev: `${sanitizedSourceName}-dev`,
            staging: `${sanitizedSourceName}-staging`,
            production: sanitizedSourceName // Production uses base name without suffix
        };
        
        // Find automations for each stage
        const stages: StageItem[] = [];
        const stagesList: Array<'dev' | 'staging' | 'production'> = ['dev', 'staging', 'production'];
        
        for (const stage of stagesList) {
            const deploymentId = stageDeploymentIds[stage];
            
            // Find automation matching this deployment_id
            const automation = automations.find(a => {
                // Check if deployment_id matches
                const matches = a.deployment_id === deploymentId || a.deploymentId === deploymentId;
                
                // Also check if relative_path matches for production (which might not have -dev/-staging suffix)
                if (!matches && stage === 'production') {
                    const automationSourceFromPath = a.relativePath?.split('/').pop() || '';
                    const sanitizedAutomationSource = sanitizeName(automationSourceFromPath);
                    return sanitizedAutomationSource === sanitizedSourceName && 
                           (a.stage === '' || a.stage === 'production' || !a.stage);
                }
                
                return matches;
            });
            
            if (automation) {
                // Stage is deployed
                const automationItem = new AutomationItem(
                    automation.name,
                    automation.state,
                    automation.status,
                    automation.deployment_id || automation.deploymentId,
                    automation.active,
                    automation.automation_url || automation.automationUrl,
                    automation.relative_path || automation.relativePath
                );
                
                // Use version_hash from the automation object instead of fetching history
                const checksum = automation.version_hash || automation.versionHash || null;
                
                stages.push(new StageItem(stage, sourceName, automationItem, deploymentId, checksum));
            } else {
                // Stage not deployed - show greyed out
                stages.push(new StageItem(stage, sourceName, null, deploymentId, null));
            }
        }
        
        return stages;
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
