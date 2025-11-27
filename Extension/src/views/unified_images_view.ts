import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { isImageMatchingSource } from '../utils/imageMatching';

const getTimestamp = (value?: string | null): number => {
    if (!value) {
        return 0;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Tree item representing an image source (folder with Dockerfile)
 */
export class ImageSourceItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly resourceUri: vscode.Uri
    ) {
        super(name, vscode.TreeItemCollapsibleState.Collapsed);
        this.tooltip = `${this.name}`;
        this.description = path.extname(this.name);
        this.contextValue = 'imageSource';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

/**
 * Tree item representing an image built from a source
 */
export type ImageItemOwner = 'images' | 'orphanedImages' | 'businessProcesses';

export class ImageItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly buildTime: string | null,
        public readonly size: string,
        public readonly buildStatus: string = 'ready',
        public readonly sourceName?: string,
        public readonly owner: ImageItemOwner = 'images',
        contextValue: string = 'image',
        public readonly metadata?: any
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);
        
        if (this.buildStatus === 'failed') {
            this.tooltip = `${this.name} (Build failed)`;
            this.description = 'Build failed';
            this.iconPath = new vscode.ThemeIcon('error');
        } else if (this.buildStatus === 'building') {
            this.tooltip = `${this.name} (Building...)`;
            this.description = 'Building...';
            this.iconPath = new vscode.ThemeIcon('sync~spin');
        } else {
            this.tooltip = `${this.name} ${this.buildTime || 'Unknown build time'}`;
            this.iconPath = new vscode.ThemeIcon('circuit-board');
        }
        
        this.contextValue = contextValue;
        this.command = {
            command: 'bitswan.openImageDetails',
            title: 'Open Image Details',
            arguments: [this]
        };
    }

    public get building(): boolean {
        return this.buildStatus === 'building';
    }

    public urlSlug(): string {
        // The name is an image like internal/foo:bar the url slug is foo:bar
        return this.name.split('/')[1];
    }
}

/**
 * Unified view provider that shows image sources as trunks with their images as branches
 */
export class UnifiedImagesViewProvider implements vscode.TreeDataProvider<ImageSourceItem | ImageItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ImageSourceItem | ImageItem | undefined | null | void> = new vscode.EventEmitter<ImageSourceItem | ImageItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ImageSourceItem | ImageItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ImageSourceItem | ImageItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ImageSourceItem | ImageItem): Promise<(ImageSourceItem | ImageItem)[]> {
        const activeInstance = this.context.globalState.get<any>('activeGitOpsInstance');
        if (!activeInstance) {
            return [];
        }

        if (!element) {
            // Root level - show image sources
            return this.getImageSources();
        }

        if (element instanceof ImageSourceItem) {
            // Show images for this source
            return this.getImagesForSource(element.name);
        }

        return [];
    }

    private getImageSources(): ImageSourceItem[] {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        return this.getFoldersWithDockerfile(workspacePath);
    }

    private getFoldersWithDockerfile(folderPath: string): ImageSourceItem[] {
        let results: ImageSourceItem[] = [];

        // Read all entries in current directory
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });

        // Skip directories explicitly named "image"
        if (path.basename(folderPath) === 'image') {
            return results;
        }

        // If the current directory contains a file named .bitswan-ignore, skip it
        if (entries.some(entry => entry.isFile() && entry.name === '.bitswan-ignore')) {
            return results;
        }

        // Check if current directory has a Dockerfile
        if (fs.existsSync(path.join(folderPath, 'Dockerfile'))) {
            // Only add if it's not the workspace root
            if (folderPath !== vscode.workspace.workspaceFolders![0].uri.fsPath) {
                const relativePath = path.relative(vscode.workspace.workspaceFolders![0].uri.fsPath, folderPath);
                results.push(new ImageSourceItem(
                    relativePath,
                    vscode.Uri.file(folderPath)
                ));
            }
        }

        // Recursively check subdirectories
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const fullPath = path.join(folderPath, entry.name);
                results = results.concat(this.getFoldersWithDockerfile(fullPath));
            }
        }

        return results;
    }

    private async getImagesForSource(sourceName: string): Promise<ImageItem[]> {
        const instances = this.context.globalState.get<any[]>('images', []);
        
        // Filter images that match this source using smarter matching
        const sourceImages = instances
            .filter(instance => {
                const imageName = instance.tag;
                return isImageMatchingSource(imageName, sourceName);
            })
            .sort((a, b) => getTimestamp(b.created) - getTimestamp(a.created));

        return sourceImages.map(instance => new ImageItem(
            instance.tag,
            instance.created,
            instance.size,
            instance.build_status || (instance.building ? 'building' : 'ready'),
            sourceName,
            'images',
            'image',
            instance
        ));
    }
}

/**
 * View provider for orphaned images (images without associated sources)
 */
export class OrphanedImagesViewProvider implements vscode.TreeDataProvider<ImageItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ImageItem | undefined | null | void> = new vscode.EventEmitter<ImageItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ImageItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ImageItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ImageItem): Promise<ImageItem[]> {
        const activeInstance = this.context.globalState.get<any>('activeGitOpsInstance');
        if (!activeInstance) {
            return [];
        }

        const instances = this.context.globalState.get<any[]>('images', []);
        
        // Get all image sources
        const imageSources = this.getImageSourceNames();
        
        // Filter out images that have associated sources using smart matching
        const orphanedImages = instances
            .filter(instance => {
                const imageName = instance.tag;
                return !imageSources.some(sourceName => isImageMatchingSource(imageName, sourceName));
            })
            .sort((a, b) => getTimestamp(b.created) - getTimestamp(a.created));

        return orphanedImages.map(instance => {
            const status = instance.build_status || (instance.building ? 'building' : 'ready');
            return new ImageItem(
                instance.tag,
                instance.created,
                instance.size,
                status,
                undefined,
                'orphanedImages',
                'image',
                instance
            );
        });
    }

    private getImageSourceNames(): string[] {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const sources = this.getFoldersWithDockerfile(workspacePath);
        return sources.map(source => source.name);
    }

    private getFoldersWithDockerfile(folderPath: string): { name: string }[] {
        let results: { name: string }[] = [];

        // Read all entries in current directory
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });

        if (path.basename(folderPath) === 'image') {
            return results;
        }

        // If the current directory contains a file named .bitswan-ignore, skip it
        if (entries.some(entry => entry.isFile() && entry.name === '.bitswan-ignore')) {
            return results;
        }

        // Check if current directory has a Dockerfile
        if (fs.existsSync(path.join(folderPath, 'Dockerfile'))) {
            // Only add if it's not the workspace root
            if (folderPath !== vscode.workspace.workspaceFolders![0].uri.fsPath) {
                const relativePath = path.relative(vscode.workspace.workspaceFolders![0].uri.fsPath, folderPath);
                results.push({ name: relativePath });
            }
        }

        // Recursively check subdirectories
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const fullPath = path.join(folderPath, entry.name);
                results = results.concat(this.getFoldersWithDockerfile(fullPath));
            }
        }

        return results;
    }

}
