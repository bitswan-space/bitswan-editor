import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import urlJoin from 'proper-url-join';
import { FolderItem } from './sources_view';
import { AutomationItem } from './automations_view';
import { ImageItem } from './unified_images_view';
import { WorktreeItem } from './worktrees_view';
import { isImageMatchingSource } from '../utils/imageMatching';
import { sanitizeName } from '../utils/nameUtils';
import { getAutomationDeployConfig } from '../utils/automationImageBuilder';

const getTimestamp = (value?: string | null): number => {
    if (!value) {
        return 0;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
};

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
        this.id = `bp:${name}`;
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
        this.id = `as:${name}`;
        this.tooltip = `${this.name} (Automation Source)`;
        this.contextValue = 'automationSource';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

/**
 * Tree item representing a subfolder containing automation sources (but not a business process)
 */
export class SubfolderItem extends vscode.TreeItem {
    public readonly children: (AutomationSourceItem | SubfolderItem)[];

    constructor(
        public readonly name: string,
        public readonly resourceUri: vscode.Uri,
        children: (AutomationSourceItem | SubfolderItem)[]
    ) {
        // Extract just the folder name from the path
        const displayName = name.split('/').pop() || name;
        super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `sf:${name}`;
        this.children = children;
        const automationCount = SubfolderItem.countAutomations(children);
        this.tooltip = `${this.name} (${automationCount} automation${automationCount === 1 ? '' : 's'})`;
        this.contextValue = 'subfolder';
        this.iconPath = new vscode.ThemeIcon('folder-library');
    }

    private static countAutomations(children: (AutomationSourceItem | SubfolderItem)[]): number {
        let count = 0;
        for (const child of children) {
            if (child instanceof SubfolderItem) {
                count += SubfolderItem.countAutomations(child.children);
            } else {
                count++;
            }
        }
        return count;
    }
}

/**
 * Tree item representing a stage (live-dev/dev/staging/production) under an automation source
 */
export class StageItem extends vscode.TreeItem {
    constructor(
        public readonly stage: 'live-dev' | 'dev' | 'staging' | 'production',
        public readonly automationSourceName: string,
        public readonly automation: AutomationItem | null, // null if stage not deployed
        public readonly deploymentId: string, // The actual deployment_id (e.g., "my-automation-dev")
        public readonly checksum: string | null = null,
        public readonly sourceUri?: vscode.Uri, // Filesystem path for the automation source
        public readonly serviceNames: string[] = [], // Service dependencies from automation.toml (e.g., ['kafka', 'couchdb'])
        public readonly worktreeName?: string // Set for worktree live-dev stages
    ) {
        // Display name: "Live Dev" for live-dev, capitalized for others
        const stageDisplayName = worktreeName
            ? `Live Dev (${worktreeName})`
            : stage === 'live-dev' ? 'Live Dev' : stage.charAt(0).toUpperCase() + stage.slice(1);
        super(stageDisplayName, vscode.TreeItemCollapsibleState.None);
        this.id = worktreeName
            ? `st:${automationSourceName}/live-dev-wt-${worktreeName}`
            : `st:${automationSourceName}/${stage}`;

        if (sourceUri) {
            this.resourceUri = sourceUri;
        }

        const worktreeTag = worktreeName ? ',worktreeLiveDev' : '';

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
            const svcTags = serviceNames.map(s => `svc:${s}`).join(',');
            this.contextValue = `automationStage,${stage},deployed,${status},${state},urlStatus:${urlStatus}${sourceUri ? ',fsRoot' : ''}${svcTags ? ',' + svcTags : ''}${worktreeTag}`;
            this.iconPath = automation.iconPath;
        } else {
            // Stage not deployed - greyed out
            this.tooltip = `${stageDisplayName} - Not deployed`;
            this.description = 'Not deployed';
            this.contextValue = `automationStage,${stage},notDeployed${sourceUri ? ',fsRoot' : ''}${worktreeTag}`;
            this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
        }
    }
}

export class AutomationSourceImagesItem extends vscode.TreeItem {
    constructor(
        public readonly sourceName: string,
        public readonly images: AutomationSourceImageItem[]
    ) {
        super(
            `Images (${images.length})`,
            images.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        this.id = `asi:${sourceName}`;
        this.tooltip = images.length
            ? `Image builds found for ${sourceName}`
            : `No image builds found for ${sourceName}`;
        this.description = images.length ? undefined : 'No builds yet';
        this.contextValue = 'automationSourceImages';
        this.iconPath = new vscode.ThemeIcon('circuit-board');
    }
}

export class AutomationSourceImageItem extends ImageItem {
    constructor(
        name: string,
        buildTime: string | null,
        size: string,
        buildStatus: string,
        sourceName: string,
        metadata: any
    ) {
        super(name, buildTime, size, buildStatus, sourceName, 'businessProcesses', 'automationSourceImage', metadata);
        this.id = `asimg:${sourceName}/${name}`;
    }
}

/**
 * Tree item representing files/directories inside an automation source
 */
export class AutomationSourceFileItem extends vscode.TreeItem {
    constructor(
        public readonly resourceUri: vscode.Uri,
        public readonly isDirectory: boolean
    ) {
        const label = path.basename(resourceUri.fsPath) || resourceUri.fsPath;
        super(label, isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = `asf:${resourceUri.fsPath}`;
        this.resourceUri = resourceUri;
        this.tooltip = resourceUri.fsPath;
        this.contextValue = isDirectory ? 'automationSourceDirectory' : 'automationSourceFile';
        if (!isDirectory) {
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [resourceUri]
            };
        }
    }
}

/**
 * Tree item representing the "Other automations" virtual business process
 */
export class OtherAutomationsItem extends vscode.TreeItem {
    constructor() {
        super('Other', vscode.TreeItemCollapsibleState.Expanded);
        this.id = 'other';
        this.tooltip = 'Automation sources not belonging to any business process';
        this.contextValue = 'otherAutomations';
        this.iconPath = new vscode.ThemeIcon('folder-opened');
    }
}

/**
 * Tree item representing the "Checkouts" category
 */
export class CheckoutsItem extends vscode.TreeItem {
    constructor() {
        super('Checkouts', vscode.TreeItemCollapsibleState.Collapsed);
        this.id = 'checkouts';
        this.tooltip = 'Checked-out asset versions for local inspection';
        this.contextValue = 'checkouts';
        this.iconPath = new vscode.ThemeIcon('desktop-download');
    }
}

/**
 * Tree item representing a single checkout group (e.g. backend-dev-20260314T1846-47775d35)
 */
export class CheckoutGroupItem extends vscode.TreeItem {
    constructor(
        public readonly groupName: string,
        public readonly groupPath: string
    ) {
        super(groupName, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `cg:${groupName}`;
        this.resourceUri = vscode.Uri.file(groupPath);
        this.tooltip = groupPath;
        this.contextValue = 'checkoutGroup';
        this.iconPath = new vscode.ThemeIcon('archive');
    }
}

/**
 * Unified view provider that shows business processes as trunks with automation sources as branches,
 * and running automations as leaves under their respective automation sources
 */
export class CreateAutomationItem extends vscode.TreeItem {
    constructor(public readonly businessProcessName: string) {
        super('Create Automation', vscode.TreeItemCollapsibleState.None);
        this.id = `ca:${businessProcessName}`;
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

/**
 * Section header for worktrees in the BP sidebar
 */
export class WorktreesSectionItem extends vscode.TreeItem {
    constructor() {
        super('Worktrees', vscode.TreeItemCollapsibleState.Expanded);
        this.id = 'worktrees-section';
        this.contextValue = 'worktreesSection';
        this.iconPath = new vscode.ThemeIcon('git-branch');
    }
}

/**
 * Action button that appears at the bottom of the BP sidebar
 */
export class ActionButtonItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly actionCommand: string,
        icon: string,
        id: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.id = id;
        this.contextValue = 'actionButton';
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = {
            command: actionCommand,
            title: label,
        };
    }
}

type UnifiedTreeItem =
    | BusinessProcessItem
    | AutomationSourceItem
    | SubfolderItem
    | AutomationItem
    | OtherAutomationsItem
    | CreateAutomationItem
    | CheckoutsItem
    | CheckoutGroupItem
    | WorktreesSectionItem
    | WorktreeItem
    | ActionButtonItem
    | StageItem
    | AutomationSourceFileItem
    | AutomationSourceImagesItem
    | AutomationSourceImageItem
    | vscode.TreeItem;

export class UnifiedBusinessProcessesViewProvider implements vscode.TreeDataProvider<UnifiedTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<UnifiedTreeItem | undefined | null | void> = new vscode.EventEmitter<UnifiedTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<UnifiedTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private readonly separatorIconPaths: { light: vscode.Uri; dark: vscode.Uri };
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    // Track automation source items so we can fire targeted refreshes
    private _knownAutomationSources: AutomationSourceItem[] = [];
    // Worktree mode: undefined = main tree, string = worktree name
    private _selectedWorktree: string | undefined;
    private _view: vscode.TreeView<UnifiedTreeItem> | undefined;
    private _worktreesProvider: { getChildren(): Promise<WorktreeItem[]> } | undefined;

    get selectedWorktree(): string | undefined { return this._selectedWorktree; }

    setView(view: vscode.TreeView<UnifiedTreeItem>): void { this._view = view; }

    setWorktreesProvider(provider: { getChildren(): Promise<WorktreeItem[]> }): void {
        this._worktreesProvider = provider;
    }

    selectWorktree(name: string | undefined): void {
        this._selectedWorktree = name;
        if (this._view) {
            this._view.message = name ? `Worktree: ${name}` : undefined;
        }
        this.refresh();
    }

    constructor(private context: vscode.ExtensionContext) {
        this.separatorIconPaths = {
            light: vscode.Uri.file(context.asAbsolutePath(path.join('resources', 'icons', 'separator_light.svg'))),
            dark: vscode.Uri.file(context.asAbsolutePath(path.join('resources', 'icons', 'separator_dark.svg')))
        };
    }

    /**
     * Full tree refresh — rebuilds everything from root.
     * Use only when the file structure or business processes change.
     */
    refresh(): void {
        console.log(`[DEBUG] UnifiedBusinessProcessesViewProvider.refresh() called`);
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this._knownAutomationSources = [];
        this.refreshTimer = setTimeout(() => {
            this._onDidChangeTreeData.fire();
        }, 500);
    }

    /**
     * Targeted refresh — only re-fetches children of known AutomationSourceItems.
     * This avoids rebuilding the entire tree when only automations data changes,
     * keeping the sidebar interactive during refresh.
     */
    refreshAutomations(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            if (this._knownAutomationSources.length > 0) {
                for (const item of this._knownAutomationSources) {
                    this._onDidChangeTreeData.fire(item);
                }
            } else {
                // No tracked sources yet — fall back to full refresh
                this._onDidChangeTreeData.fire();
            }
        }, 500);
    }

    getTreeItem(element: UnifiedTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: UnifiedTreeItem): Promise<UnifiedTreeItem[]> {
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
            console.log(`[DEBUG] getChildren - BusinessProcessItem: "${element.name}"`);
            const items = (element as any)._idPrefix
                ? this.getAutomationSourcesAtPath(element.resourceUri.fsPath, element.name)
                : this.getAutomationSourcesForBusinessProcess(element.name);
            // Namespace IDs for worktree BPs to avoid collisions
            const prefix = (element as any)._idPrefix || '';
            if (prefix) {
                this._prefixTreeItemIds(items, prefix);
            }
            this._trackAutomationSources(items);
            const createItem = new CreateAutomationItem(element.name);
            if (prefix) { createItem.id = prefix + createItem.id; }
            return [...items, createItem];
        }

        if (element instanceof AutomationSourceItem) {
            // Worktree automations: no children — actions are inline buttons
            if ((element as any)._idPrefix) {
                return [];
            }

            // Main workspace: show stages, file entries, images
            console.log(`[DEBUG] getChildren - AutomationSourceItem: "${element.name}"`);
            const [stages, fileEntries] = await Promise.all([
                this.getStagesForSource(element.name),
                this.getAutomationSourceFileEntries(element.resourceUri.fsPath)
            ]);
            const images = this.getImagesForAutomationSource(element.name);
            const imagesSection = new AutomationSourceImagesItem(element.name, images);

            const items: UnifiedTreeItem[] = [];

            if (stages.length) {
                items.push(...stages);
            }

            if (fileEntries.length) {
                if (items.length) {
                    items.push(this.createSeparator(element.name, 0));
                }
                items.push(...fileEntries);
            }

            if (items.length) {
                items.push(this.createSeparator(element.name, 1));
            }

            items.push(imagesSection);

            return items;
        }

        if (element instanceof AutomationSourceFileItem) {
            // Expand directories the same way the Explorer file tree works
            if (!element.isDirectory) {
                return [];
            }
            return this.getAutomationSourceFileEntries(element.resourceUri.fsPath);
        }

        if (element instanceof AutomationSourceImagesItem) {
            return element.images;
        }

        if (element instanceof SubfolderItem) {
            // Show nested subfolders and automation sources within this subfolder
            console.log(`[DEBUG] getChildren - SubfolderItem: "${element.name}"`);
            return element.children;
        }

        if (element instanceof OtherAutomationsItem) {
            // Show automation sources not belonging to any business process
            console.log(`[DEBUG] getChildren - OtherAutomationsItem`);
            const items = this.getOtherAutomationSources();
            this._trackAutomationSources(items);
            return items;
        }

        if (element instanceof CheckoutsItem) {
            return this.getCheckoutGroups();
        }

        if (element instanceof CheckoutGroupItem) {
            return this.getCheckoutGroupChildren(element);
        }

        if (element instanceof WorktreesSectionItem) {
            if (this._worktreesProvider) {
                const items = await this._worktreesProvider.getChildren();
                for (const item of items) {
                    item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                    item.command = undefined;
                }
                return items;
            }
            return [];
        }

        if (element instanceof WorktreeItem) {
            // Show business processes inside this worktree
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '/workspace/workspace';
            const wtRoot = path.join(workspacePath, 'worktrees', element.name);
            if (fs.existsSync(wtRoot)) {
                const processDirs = this.findDirectoriesWithProcessToml(wtRoot);
                const wtPrefix = `wt-${element.name}/`;
                return processDirs.map(processDir => {
                    const relativePath = path.relative(wtRoot, processDir);
                    const processConfigPath = path.join(processDir, 'process.toml');
                    const item = new BusinessProcessItem(
                        relativePath,
                        vscode.Uri.file(processDir),
                        processConfigPath
                    );
                    item.id = `bp:${wtPrefix}${relativePath}`;
                    (item as any)._idPrefix = wtPrefix;
                    return item;
                });
            }
            return [];
        }

        console.log(`[DEBUG] getChildren - unknown element type: ${element.constructor.name}`);
        return [];
    }

    /**
     * Collect AutomationSourceItem instances (including inside SubfolderItems)
     * so that refreshAutomations() can fire targeted change events.
     */
    private _prefixTreeItemIds(items: readonly vscode.TreeItem[], prefix: string): void {
        const automations = this.context.globalState.get<any[]>('automations', []);
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '/workspace/workspace';

        for (const item of items) {
            if (item.id) { item.id = prefix + item.id; }
            (item as any)._idPrefix = prefix;
            // Worktree automations are leaf nodes with state info
            if (item instanceof AutomationSourceItem) {
                item.collapsibleState = vscode.TreeItemCollapsibleState.None;

                // Match against running automations by relative_path
                const relPath = path.relative(workspacePath, item.resourceUri.fsPath);
                const match = automations.find(a => {
                    const aPath = a.relative_path || a.relativePath || '';
                    return aPath === relPath || aPath.endsWith('/' + relPath);
                });

                if (match) {
                    const state = match.state || 'unknown';
                    const status = match.status || state;
                    const hasUrl = !!(match.automation_url || match.automationUrl);
                    item.contextValue = `worktreeAutomation,${state}${hasUrl ? ',url' : ''}`;
                    item.description = status;
                    // Use the same color scheme as AutomationItem
                    switch (state) {
                        case 'running':
                            item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.green'));
                            break;
                        case 'paused': case 'restarting':
                            item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.orange'));
                            break;
                        case 'exited': case 'dead': case 'removing':
                            item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.red'));
                            break;
                        default:
                            item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('bitswan.statusIcon.gray'));
                    }
                } else {
                    item.contextValue = 'worktreeAutomation,notDeployed';
                    item.description = 'not deployed';
                    item.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('bitswan.statusIcon.gray'));
                }
            }
            if (item instanceof SubfolderItem && item.children) {
                this._prefixTreeItemIds(item.children, prefix);
            }
        }
    }

    private _trackAutomationSources(items: readonly UnifiedTreeItem[]): void {
        for (const item of items) {
            if (item instanceof AutomationSourceItem) {
                if (!this._knownAutomationSources.some(s => s.id === item.id)) {
                    this._knownAutomationSources.push(item);
                }
            } else if (item instanceof SubfolderItem) {
                this._trackAutomationSources(item.children);
            }
        }
    }

    /**
     * Returns the effective scan root for the current mode.
     * In worktree mode, scans the worktree directory instead of the workspace.
     */
    private getEffectiveScanRoot(): string | undefined {
        if (this._selectedWorktree) {
            // Worktrees are inside the workspace directory
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '/workspace/workspace';
            const wtRoot = path.join(workspacePath, 'worktrees', this._selectedWorktree);
            return fs.existsSync(wtRoot) ? wtRoot : undefined;
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private getBusinessProcesses(): UnifiedTreeItem[] {
        const businessProcesses: UnifiedTreeItem[] = [];

        // Worktrees at the top (expandable — no mode switching)
        if (!this._selectedWorktree && this._worktreesProvider) {
            businessProcesses.push(new WorktreesSectionItem());
        }

        // "Back to Main" button when viewing a worktree
        if (this._selectedWorktree) {
            const backItem = new ActionButtonItem('Back to Main', 'bitswan.selectWorktree', 'arrow-left', 'action:back-to-main');
            businessProcesses.push(backItem);
        }

        const scanRoot = this.getEffectiveScanRoot();

        // Scan for business processes if we have a valid scan root
        if (scanRoot) {
            const processDirs = this.findDirectoriesWithProcessToml(scanRoot);

            for (const processDir of processDirs) {
                const relativePath = path.relative(scanRoot, processDir);
                const processConfigPath = path.join(processDir, 'process.toml');

                businessProcesses.push(new BusinessProcessItem(
                    relativePath,
                    vscode.Uri.file(processDir),
                    processConfigPath
                ));
            }
        }

        // Always include "Other automations"
        businessProcesses.push(new OtherAutomationsItem());

        // Include "Checkouts" only in main mode
        if (!this._selectedWorktree) {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspacePath) {
                const checkoutsDir = path.join(workspacePath, '..', 'checkouts');
                if (fs.existsSync(checkoutsDir)) {
                    try {
                        const entries = fs.readdirSync(checkoutsDir, { withFileTypes: true });
                        const hasCheckouts = entries.some(e => e.isDirectory());
                        if (hasCheckouts) {
                            businessProcesses.push(new CheckoutsItem());
                        }
                    } catch {
                        // ignore
                    }
                }
            }
        }

        // Action buttons at the bottom — always show regardless of scan root
        businessProcesses.push(
            new ActionButtonItem('Workspace', 'bitswan.openRequirementsEditor', 'dashboard', 'action:workspace'),
            new ActionButtonItem('Backups', 'bitswan.openBackups', 'cloud-download', 'action:backups'),
        );

        return businessProcesses;
    }

    private getAutomationSourcesAtPath(absolutePath: string, businessProcessName: string): (AutomationSourceItem | SubfolderItem)[] {
        const allSources = this.getAutomationSourcesInDirectoryRecursive(absolutePath, businessProcessName);
        return this.buildSubfolderTree(allSources, absolutePath);
    }

    private getAutomationSourcesForBusinessProcess(businessProcessName: string): (AutomationSourceItem | SubfolderItem)[] {
        const scanRoot = this.getEffectiveScanRoot();
        if (!scanRoot) {
            return [];
        }

        const businessProcessPath = path.join(scanRoot, businessProcessName);

        console.log(`[DEBUG] getAutomationSourcesForBusinessProcess called for business process: "${businessProcessName}"`);
        console.log(`[DEBUG] Business process path: "${businessProcessPath}"`);

        // Get all automation sources recursively within this business process
        const allSources = this.getAutomationSourcesInDirectoryRecursive(businessProcessPath, businessProcessName);

        // Build a nested tree structure from relative paths
        const result = this.buildSubfolderTree(allSources, businessProcessPath);

        console.log(`[DEBUG] Found ${result.length} items for business process "${businessProcessName}"`);

        return result;
    }

    private getOtherAutomationSources(): (AutomationSourceItem | SubfolderItem | AutomationItem)[] {
        const scanRoot = this.getEffectiveScanRoot();
        if (!scanRoot) {
            return [];
        }

        const allAutomationSources = this.getAllAutomationSources(scanRoot);
        const businessProcessSources = this.getAllBusinessProcessSources(scanRoot);

        // Find automation sources that don't belong to any business process
        const otherSources = allAutomationSources.filter(source =>
            !businessProcessSources.some(bpSource =>
                source.resourceUri.fsPath.startsWith(bpSource.resourceUri.fsPath)
            )
        );

        // Build nested tree structure for automation sources
        const sourceItems = otherSources.map(source => new AutomationSourceItem(source.name, source.resourceUri));
        const treeItems = this.buildSubfolderTree(sourceItems, scanRoot);
        const result: (AutomationSourceItem | SubfolderItem | AutomationItem)[] = [...treeItems];

        // Add orphaned automations (automations that don't belong to any automation source)
        const automations = this.context.globalState.get<any[]>('automations', []);
        console.log(`[DEBUG] getOtherAutomationSources - checking ${automations.length} automations for orphaned status`);
        console.log(`[DEBUG] Available automation sources: ${allAutomationSources.map(s => s.name).join(', ')}`);
        
        // Build a set of known automation names from sources
        const knownAutomationNames = new Set<string>();
        for (const source of allAutomationSources) {
            const srcName = source.name.split('/').pop() || source.name;
            knownAutomationNames.add(sanitizeName(srcName));
        }

        // An automation is orphaned if its automation_name doesn't match any known source
        const orphanedAutomations = automations.filter(automation => {
            const autoName = automation.automation_name || automation.automationName || '';
            return !autoName || !knownAutomationNames.has(autoName);
        });

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

        // Extract automation name and business process name from sourceName
        // sourceName is like "Test/backend" or just "backend"
        const pathParts = sourceName.split('/');
        const automationSourceName = pathParts.pop() || sourceName;
        const bpName = pathParts.length > 0 ? pathParts[0] : '';
        const sanitizedSourceName = sanitizeName(automationSourceName);
        const sanitizedBpName = bpName ? sanitizeName(bpName) : '';
        const scanRoot = this.getEffectiveScanRoot();
        const sourceUri = scanRoot
            ? vscode.Uri.file(path.join(scanRoot, sourceName))
            : undefined;

        // Read service dependencies from automation.toml
        const serviceNames: string[] = [];
        if (sourceUri) {
            try {
                const config = getAutomationDeployConfig(sourceUri.fsPath);
                if (config.services) {
                    for (const [svcName, svcConf] of Object.entries(config.services)) {
                        if (svcConf.enabled) {
                            serviceNames.push(svcName);
                        }
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        const stages: StageItem[] = [];

        if (this._selectedWorktree) {
            // Worktree mode: only live-dev stage
            const wtName = this._selectedWorktree;
            const wtSourceUri = sourceUri; // already points into the worktree via scanRoot

            // Match by relative_path — the server owns the deployment ID format
            const expectedRelPath = `worktrees/${wtName}/${sourceName}`;
            const automation = automations.find(a => {
                const aPath = a.relative_path || a.relativePath || '';
                return aPath === expectedRelPath;
            });
            const deploymentId = automation
                ? (automation.deployment_id || automation.deploymentId || '')
                : '';

            if (automation) {
                const automationItem = new AutomationItem(
                    automation.name,
                    automation.state,
                    automation.status,
                    automation.deployment_id || automation.deploymentId,
                    automation.active,
                    automation.automation_url || automation.automationUrl,
                    automation.relative_path || automation.relativePath
                );
                const checksum = automation.version_hash || automation.versionHash || null;
                stages.push(new StageItem('live-dev', sourceName, automationItem, deploymentId, checksum, wtSourceUri, serviceNames, wtName));
            } else {
                stages.push(new StageItem('live-dev', sourceName, null, deploymentId, null, wtSourceUri, serviceNames, wtName));
            }
        } else {
            // Main mode: 3 stages (live-dev is worktree-only, managed in the Workspace panel)
            const stagesList: Array<'dev' | 'staging' | 'production'> = ['dev', 'staging', 'production'];

            for (const stage of stagesList) {
                // Match by structured fields: automation_name + stage
                const automation = automations.find(a => {
                    const aName = a.automation_name || a.automationName || '';
                    const aStage = a.stage || 'production';
                    const normalizedStage = aStage === '' ? 'production' : aStage;
                    return aName === sanitizedSourceName && normalizedStage === stage;
                });
                const deploymentId = automation
                    ? (automation.deployment_id || automation.deploymentId || '')
                    : '';

                if (automation) {
                    const automationItem = new AutomationItem(
                        automation.name,
                        automation.state,
                        automation.status,
                        automation.deployment_id || automation.deploymentId,
                        automation.active,
                        automation.automation_url || automation.automationUrl,
                        automation.relative_path || automation.relativePath
                    );
                    const checksum = automation.version_hash || automation.versionHash || null;
                    stages.push(new StageItem(stage, sourceName, automationItem, deploymentId, checksum, sourceUri, serviceNames));
                } else {
                    stages.push(new StageItem(stage, sourceName, null, deploymentId, null, sourceUri, serviceNames));
                }
            }
        }

        return stages;
    }

    private getImagesForAutomationSource(sourceName: string): AutomationSourceImageItem[] {
        const images = this.context.globalState.get<any[]>('images', []);
        const matchingImages = images
            .filter(instance => {
                const imageName = instance.tag;
                return isImageMatchingSource(imageName, sourceName);
            })
            .sort((a, b) => getTimestamp(b.created) - getTimestamp(a.created));

        return matchingImages.map(instance => new AutomationSourceImageItem(
            instance.tag,
            instance.created,
            instance.size,
            instance.build_status || (instance.building ? 'building' : 'ready'),
            sourceName,
            instance
        ));
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
                        // Skip worktrees directory to avoid duplicates (it's a bind mount of the same data)
                        if (entry.name === 'worktrees') { continue; }
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
        const scanRoot = this.getEffectiveScanRoot() || vscode.workspace.workspaceFolders![0].uri.fsPath;

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    // Skip templates directory
                    if (entry.name === 'templates') {
                        continue;
                    }

                    const fullPath = path.join(dirPath, entry.name);

                    // Check if this directory contains automation.toml or pipelines.conf (automation source marker)
                    if (fs.existsSync(path.join(fullPath, 'automation.toml')) || fs.existsSync(path.join(fullPath, 'pipelines.conf'))) {
                        const relativePath = path.relative(scanRoot, fullPath);
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

    private getAutomationSourcesInDirectoryRecursive(dirPath: string, businessProcessName: string): AutomationSourceItem[] {
        const sources: AutomationSourceItem[] = [];
        const scanRoot = this.getEffectiveScanRoot() || vscode.workspace.workspaceFolders![0].uri.fsPath;

        const findAutomationSources = (currentPath: string): void => {
            try {
                const entries = fs.readdirSync(currentPath, { withFileTypes: true });

                // Skip if directory contains .bitswan-ignore
                if (entries.some(entry => entry.isFile() && entry.name === '.bitswan-ignore')) {
                    return;
                }

                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        // Skip templates directory
                        if (entry.name === 'templates') {
                            continue;
                        }

                        const fullPath = path.join(currentPath, entry.name);

                        // Check if this directory contains automation.toml or pipelines.conf
                        if (fs.existsSync(path.join(fullPath, 'automation.toml')) || fs.existsSync(path.join(fullPath, 'pipelines.conf'))) {
                            const relativePath = path.relative(scanRoot, fullPath);
                            sources.push(new AutomationSourceItem(
                                relativePath,
                                vscode.Uri.file(fullPath),
                                businessProcessName
                            ));
                        } else {
                            // Not an automation source, recurse into it
                            findAutomationSources(fullPath);
                        }
                    }
                }
            } catch (error) {
                // Skip directories that can't be read
            }
        };

        findAutomationSources(dirPath);
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

                // Skip templates directory
                if (path.basename(dirPath) === 'templates') {
                    return;
                }

                // Check if current directory has automation.toml or pipelines.conf
                if (fs.existsSync(path.join(dirPath, 'automation.toml')) || fs.existsSync(path.join(dirPath, 'pipelines.conf'))) {
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
                        if (entry.name === 'worktrees') { continue; }
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
            // Use recursive search to find all automation sources within business processes
            const processSources = this.getAutomationSourcesInDirectoryRecursive(processDir, '');
            sources.push(...processSources);
        }

        return sources;
    }

    /**
     * Build a nested subfolder tree from a flat list of automation sources.
     * Sources at the root level are returned directly; sources nested in subdirectories
     * are grouped into nested SubfolderItem hierarchies.
     */
    private buildSubfolderTree(sources: AutomationSourceItem[], basePath: string): (AutomationSourceItem | SubfolderItem)[] {
        // Intermediate tree node for building the hierarchy
        interface TreeNode {
            automations: AutomationSourceItem[];
            children: Map<string, TreeNode>;
        }

        const root: TreeNode = { automations: [], children: new Map() };

        for (const source of sources) {
            const relativePath = path.relative(basePath, source.resourceUri.fsPath);
            const parts = relativePath.split(path.sep);

            if (parts.length <= 1) {
                // Direct child — no subfolder nesting needed
                root.automations.push(source);
            } else {
                // Walk/create intermediate folder nodes for each path segment except the last (the automation itself)
                let node = root;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!node.children.has(parts[i])) {
                        node.children.set(parts[i], { automations: [], children: new Map() });
                    }
                    node = node.children.get(parts[i])!;
                }
                node.automations.push(source);
            }
        }

        // Convert the tree into SubfolderItem / AutomationSourceItem arrays
        const buildItems = (node: TreeNode, currentPath: string): (AutomationSourceItem | SubfolderItem)[] => {
            const items: (AutomationSourceItem | SubfolderItem)[] = [];

            // Add direct automation sources
            items.push(...node.automations);

            // Add subfolder children
            for (const [folderName, childNode] of node.children) {
                const folderPath = path.join(currentPath, folderName);
                const childItems = buildItems(childNode, folderPath);
                const subfolderUri = vscode.Uri.file(folderPath);
                items.push(new SubfolderItem(folderName, subfolderUri, childItems));
            }

            return items;
        };

        return buildItems(root, basePath);
    }

    private getAutomationSourceFileEntries(dirPath: string): AutomationSourceFileItem[] {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const sortedEntries = entries.sort((a, b) => {
                const aIsDir = a.isDirectory();
                const bIsDir = b.isDirectory();
                if (aIsDir && !bIsDir) {
                    return -1;
                }
                if (!aIsDir && bIsDir) {
                    return 1;
                }
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });

            return sortedEntries.map(entry => {
                const fullPath = path.join(dirPath, entry.name);
                const isDirectory = entry.isDirectory();
                return new AutomationSourceFileItem(vscode.Uri.file(fullPath), isDirectory);
            });
        } catch (error) {
            console.error(`[DEBUG] Failed to read automation source entries for "${dirPath}":`, error);
            return [];
        }
    }

    private getCheckoutGroups(): CheckoutGroupItem[] {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            return [];
        }

        const checkoutsDir = path.join(workspacePath, '..', 'checkouts');
        if (!fs.existsSync(checkoutsDir)) {
            return [];
        }

        try {
            const entries = fs.readdirSync(checkoutsDir, { withFileTypes: true });
            return entries
                .filter(e => e.isDirectory())
                .sort((a, b) => b.name.localeCompare(a.name)) // newest first (timestamp in name)
                .map(e => new CheckoutGroupItem(e.name, path.join(checkoutsDir, e.name)));
        } catch {
            return [];
        }
    }

    private getCheckoutGroupChildren(group: CheckoutGroupItem): UnifiedTreeItem[] {
        const items: UnifiedTreeItem[] = [];

        try {
            const entries = fs.readdirSync(group.groupPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const fullPath = path.join(group.groupPath, entry.name);
                // If this subdirectory is an automation source, show it as such
                if (fs.existsSync(path.join(fullPath, 'automation.toml')) || fs.existsSync(path.join(fullPath, 'pipelines.conf'))) {
                    const sourceItem = new AutomationSourceItem(
                        `checkouts/${group.groupName}/${entry.name}`,
                        vscode.Uri.file(fullPath),
                    );
                    this._knownAutomationSources.push(sourceItem);
                    items.push(sourceItem);
                } else {
                    // Generic directory
                    items.push(new AutomationSourceFileItem(vscode.Uri.file(fullPath), true));
                }
            }
        } catch {
            // ignore
        }

        return items;
    }

    private createSeparator(parentId: string, index: number): vscode.TreeItem {
        const separatorItem = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
        separatorItem.id = `sep:${parentId}:${index}`;
        separatorItem.contextValue = 'automationSeparator';
        separatorItem.tooltip = '';
        separatorItem.iconPath = this.separatorIconPaths;
        separatorItem.command = undefined;
        separatorItem.description = '';
        separatorItem.accessibilityInformation = {
            label: 'Automation files divider',
            role: 'separator'
        };
        return separatorItem;
    }
}
