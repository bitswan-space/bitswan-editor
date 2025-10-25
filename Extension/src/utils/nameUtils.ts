/**
 * Utility functions for name sanitization and path operations
 */

/**
 * Sanitizes a name using the same logic as in deployments.ts
 * Converts to lowercase and removes invalid characters
 */
export function sanitizeName(name: string): string {
    return name.toLowerCase()
              .replace(/[^a-z0-9\-]/g, '')
              .replace(/^[,\.\-]+/g, '');
}
