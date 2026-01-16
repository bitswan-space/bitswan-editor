#!/usr/bin/env node

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Compare two strings byte-by-byte (git's sorting method)
 */
function gitBytesCompare(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = Math.min(ab.length, bb.length);

  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return ab.length - bb.length;
}

/**
 * Git sorts tree entries by name, but directories are compared as if they had a trailing "/"
 */
function gitSortKey(name, isDirectory) {
  return isDirectory ? `${name}/` : name;
}

/**
 * Sort function for git tree entries
 */
function gitTreeEntrySort(a, b) {
  return gitBytesCompare(gitSortKey(a[0], a[1]), gitSortKey(b[0], b[1]));
}

/**
 * Calculate git blob hash for a file (SHA1 of "blob <size>\0<content>")
 */
async function calculateGitBlobHash(filePath) {
  const content = await fs.readFile(filePath);
  const size = content.length;
  const header = Buffer.from(`blob ${size}\0`);
  const blob = Buffer.concat([header, content]);
  return crypto.createHash('sha1').update(blob).digest('hex');
}

/**
 * Calculate git tree hash for a directory.
 * Implements git's tree object format directly without spawning git processes.
 * Tree format: "tree <size>\0<entries>" where each entry is "<mode> <name>\0<20-byte-sha1>"
 */
async function calculateGitTreeHashRecursive(dirPath) {
  const entries = [];
  
  const dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
  
  // Process entries in sorted order (git requires sorted entries)
  const sortedEntries = dirEntries
    .filter(entry => entry.name !== ".git")
    .map(entry => [entry.name, entry.isDirectory()])
    .sort(gitTreeEntrySort);
  
  for (const [name, isDirectory] of sortedEntries) {
    // Skip .git directory
    if (name === '.git') {
      continue;
    }
    
    const fullPath = path.join(dirPath, name);
    
    if (isDirectory) {
      // Recursively calculate tree hash for subdirectory
      const treeHash = await calculateGitTreeHashRecursive(fullPath);
      entries.push({
        mode: '040000', // Directory mode
        name: name,
        hash: treeHash
      });
    } else {
      // Calculate blob hash for file
      // Check if file is executable (simplified: check if it has execute permission)
      // In practice, git uses 100644 for regular files and 100755 for executables
      let mode = '100644';
      try {
        const stats = fsSync.statSync(fullPath);
        // Check if file is executable (Unix: any execute bit set)
        if (stats.mode & 0o111) {
          mode = '100755';
        }
      } catch {
        // If we can't stat, default to regular file
      }
      
      const blobHash = await calculateGitBlobHash(fullPath);
      entries.push({
        mode: mode,
        name: name,
        hash: blobHash
      });
    }
  }
  
  // Build tree object: "tree <size>\0<entries>"
  const entryBuffers = [];
  for (const entry of entries) {
    // Each entry: "<mode> <name>\0<20-byte-sha1>"
    const hashBuffer = Buffer.from(entry.hash, 'hex');
    const entryStr = `${entry.mode} ${entry.name}\0`;
    entryBuffers.push(Buffer.from(entryStr, 'utf8'));
    entryBuffers.push(hashBuffer);
  }
  
  const treeContent = Buffer.concat(entryBuffers);
  const treeSize = treeContent.length;
  const treeHeader = Buffer.from(`tree ${treeSize}\0`);
  const treeObject = Buffer.concat([treeHeader, treeContent]);
  
  // Calculate SHA1 hash of tree object
  const treeHash = crypto.createHash('sha1').update(treeObject).digest('hex');
  
  return treeHash;
}

/**
 * Main function - calculate git tree hash for a directory
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: calculate-git-tree-hash.js <directory>');
    process.exit(1);
  }
  
  const dirPath = args[0];
  
  // Resolve to absolute path
  const absolutePath = path.resolve(dirPath);
  
  // Check if directory exists
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isDirectory()) {
      console.error(`Error: ${absolutePath} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error: Directory ${absolutePath} does not exist or cannot be accessed`);
    process.exit(1);
  }
  
  try {
    const treeHash = await calculateGitTreeHashRecursive(absolutePath);
    console.log(treeHash);
  } catch (error) {
    console.error(`Error calculating git tree hash: ${error.message}`);
    process.exit(1);
  }
}

// Run the script
main();
