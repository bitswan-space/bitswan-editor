export function normalizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function generateNameVariations(name: string): string[] {
    const variations = new Set<string>();
    const add = (variant: string) => {
        if (variant) {
            variations.add(variant);
        }
    };

    add(name);
    add(name.replace(/-/g, ''));
    add(name.replace(/_/g, ''));
    add(name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
    add(name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());

    const camelCase = name.replace(/[-_](.)/g, (_, char: string) => char.toUpperCase());
    add(camelCase);

    const kebabCase = name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
    add(kebabCase);

    const snakeCase = name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    add(snakeCase);

    return Array.from(variations);
}

export function isImageMatchingSource(imageName: string, sourceName: string): boolean {
    const imageSourcePart = imageName.split('/')[1]?.split(':')[0];
    if (!imageSourcePart) {
        return false;
    }

    // sourceName is like "BP/backend" or just "backend"
    const sourceParts = sourceName.split('/');
    const sourceFolderName = sourceParts.pop() || sourceName;
    const bpName = sourceParts.length > 0 ? sourceParts[0] : '';

    const normalizedImageName = normalizeName(imageSourcePart);
    const normalizedSourceName = normalizeName(sourceFolderName);

    if (!normalizedImageName || !normalizedSourceName) {
        return false;
    }

    // New format: internal/{workspace}-{bp}-{name}:sha{checksum}
    // Match by checking the image tag ends with -{bp}-{name} or -{name}
    if (bpName) {
        const expectedSuffix = normalizeName(`${bpName}-${sourceFolderName}`);
        if (normalizedImageName.endsWith(expectedSuffix)) {
            return true;
        }
    }

    // Exact match (legacy: internal/{name})
    if (normalizedImageName === normalizedSourceName) {
        return true;
    }

    // Suffix match: image tag ends with the source name (handles workspace prefix)
    if (normalizedImageName.endsWith(normalizedSourceName)) {
        return true;
    }

    return false;
}

