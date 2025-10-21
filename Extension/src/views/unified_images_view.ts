import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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
export class ImageItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly buildTime: string | null,
        public readonly size: string,
        public readonly building: boolean = false,
        public readonly sourceName?: string
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);
        
        // Handle tooltip and display based on building status
        if (this.building) {
            this.tooltip = `${this.name} (Building...)`;
            this.description = 'Building...';
            this.iconPath = new vscode.ThemeIcon('sync~spin');
        } else {
            this.tooltip = `${this.name} ${this.buildTime || 'Unknown build time'}`;
            this.iconPath = new vscode.ThemeIcon('circuit-board');
        }
        
        this.contextValue = 'image';
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
        const sourceImages = instances.filter(instance => {
            const imageName = instance.tag;
            return this.isImageMatchingSource(imageName, sourceName);
        });

        return sourceImages.map(instance => {
            return new ImageItem(
                instance.tag,
                instance.created,
                instance.size,
                instance.building || false,
                sourceName
            );
        });
    }

    /**
     * Smart matching between image names and source folder names
     * Handles various naming conventions and case differences
     */
    private isImageMatchingSource(imageName: string, sourceName: string): boolean {
        // Extract the image source part (e.g., "internal/memegenerator:latest" -> "memegenerator")
        const imageSourcePart = imageName.split('/')[1]?.split(':')[0];
        if (!imageSourcePart) {
            return false;
        }

        // Extract the folder name from the source path (e.g., "workspace/MemeGenerator" -> "MemeGenerator")
        const sourceFolderName = path.basename(sourceName);

        // Normalize both names for comparison
        const normalizedImageName = imageSourcePart.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normalizedSourceName = sourceFolderName.toLowerCase().replace(/[^a-z0-9]/g, '');

        // Direct match
        if (normalizedImageName === normalizedSourceName) {
            return true;
        }

        // Check if image name is contained in source name or vice versa
        if (normalizedImageName.includes(normalizedSourceName) || normalizedSourceName.includes(normalizedImageName)) {
            return true;
        }

        // Check for common variations (e.g., "memegenerator" vs "meme-generator" vs "meme_generator")
        const imageVariations = this.generateNameVariations(normalizedImageName);
        const sourceVariations = this.generateNameVariations(normalizedSourceName);

        // Check if any variations match
        for (const imageVar of imageVariations) {
            for (const sourceVar of sourceVariations) {
                if (imageVar === sourceVar) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Generate common variations of a name for matching
     */
    private generateNameVariations(name: string): string[] {
        const variations = [name];
        
        // Add variations with different separators
        variations.push(name.replace(/-/g, ''));
        variations.push(name.replace(/_/g, ''));
        variations.push(name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
        variations.push(name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
        
        // Add camelCase variations
        const camelCase = name.replace(/[-_](.)/g, (_, char) => char.toUpperCase());
        variations.push(camelCase);
        
        // Add kebab-case variations
        const kebabCase = name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
        variations.push(kebabCase);
        
        // Add snake_case variations
        const snakeCase = name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
        variations.push(snakeCase);

        return [...new Set(variations)]; // Remove duplicates
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
        const orphanedImages = instances.filter(instance => {
            const imageName = instance.tag;
            // Check if this image matches any source using the same smart matching logic
            return !imageSources.some(sourceName => this.isImageMatchingSource(imageName, sourceName));
        });

        const imageItems = orphanedImages.map(instance => {
            return new ImageItem(
                instance.tag,
                instance.created,
                instance.size,
                instance.building || false,
            );
        });

        // Sort images: building images first, then by name
        return imageItems.sort((a, b) => {
            // Building images come first
            if (a.building && !b.building) {
                return -1;
            }
            if (!a.building && b.building) {
                return 1;
            }
            // If both have same building status, sort by name
            return a.name.localeCompare(b.name);
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

    /**
     * Smart matching between image names and source folder names
     * Handles various naming conventions and case differences
     */
    private isImageMatchingSource(imageName: string, sourceName: string): boolean {
        // Extract the image source part (e.g., "internal/memegenerator:latest" -> "memegenerator")
        const imageSourcePart = imageName.split('/')[1]?.split(':')[0];
        if (!imageSourcePart) {
            return false;
        }

        // Extract the folder name from the source path (e.g., "workspace/MemeGenerator" -> "MemeGenerator")
        const sourceFolderName = path.basename(sourceName);

        // Normalize both names for comparison
        const normalizedImageName = imageSourcePart.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normalizedSourceName = sourceFolderName.toLowerCase().replace(/[^a-z0-9]/g, '');

        // Direct match
        if (normalizedImageName === normalizedSourceName) {
            return true;
        }

        // Check if image name is contained in source name or vice versa
        if (normalizedImageName.includes(normalizedSourceName) || normalizedSourceName.includes(normalizedImageName)) {
            return true;
        }

        // Check for common variations (e.g., "memegenerator" vs "meme-generator" vs "meme_generator")
        const imageVariations = this.generateNameVariations(normalizedImageName);
        const sourceVariations = this.generateNameVariations(normalizedSourceName);

        // Check if any variations match
        for (const imageVar of imageVariations) {
            for (const sourceVar of sourceVariations) {
                if (imageVar === sourceVar) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Generate common variations of a name for matching
     */
    private generateNameVariations(name: string): string[] {
        const variations = [name];
        
        // Add variations with different separators
        variations.push(name.replace(/-/g, ''));
        variations.push(name.replace(/_/g, ''));
        variations.push(name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
        variations.push(name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
        
        // Add camelCase variations
        const camelCase = name.replace(/[-_](.)/g, (_, char) => char.toUpperCase());
        variations.push(camelCase);
        
        // Add kebab-case variations
        const kebabCase = name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
        variations.push(kebabCase);
        
        // Add snake_case variations
        const snakeCase = name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
        variations.push(snakeCase);

        return [...new Set(variations)]; // Remove duplicates
    }
}
