# Contributing to Bitswan Editor

This document provides guidelines and instructions for contributing to the Bitswan Editor project.

## Development Setup

### Prerequisites

- Node.js and npm
- VS Code (for extension development)
- Docker (for container-based development)

### Local Extension Development

1. Open the `Extension` directory in VS Code
2. Run `npm install` to install dependencies
3. Go to the Run menu and click "Start Debugging"

This launches a new VS Code window with the extension loaded for testing.

### Connecting to GitOps

To test the extension with a local GitOps instance:

1. In the new VS Code window, find the BitSwan icon in the sidebar
2. Scroll down to "WORKSPACES" and click the plus icon
3. For local development, use URL: `bitswan.localhost:8079`
4. Enter the secret from your GitOps `.env` file

## Development Mode

The Editor service supports automatic development mode that enables live-reloading for the VS Code extension during development.

### How Dev Mode Works

Dev mode is **automatically detected** when the extension source directory is available. The detection works as follows:

1. The container checks for `package.json` at the configured extension dev path
2. It verifies the package name is "bitswan" to confirm it's the correct source
3. If detected, `BITSWAN_DEV_MODE=true` is automatically set

When dev mode is active:
- Existing installed extension versions are removed
- A symlink is created to your development extension directory
- Dependencies are installed if `node_modules` is missing or outdated
- The extension is built if the `out` directory doesn't exist
- A watch process starts in the background for live compilation

### Enabling Dev Mode

**Via the Automation Server CLI (Recommended):**

```bash
bitswan workspace update <workspace-name> --dev-mode --editor-dev-source-dir /path/to/bitswan-editor/Extension
```

This mounts your local extension source and enables automatic live-reloading.

**Environment Variables:**

You can also enable dev mode manually with these environment variables:

```bash
BITSWAN_DEV_MODE=true
BITSWAN_EXTENSION_DEV_DIR=/path/to/extension/source
```

### Dev Mode Output

When dev mode is activated, you'll see:

```
========================================
AUTO-DETECTED DEV MODE: Found extension source at /workspace/workspace/AOC/bitswan-editor/Extension
========================================
DEV MODE: Setting up extension development environment
========================================
Extension: libertyacesltd.bitswan v<version>
Removing existing installed extension versions...
Creating symlink: <extensions-dir>/libertyacesltd.bitswan-<version> -> <dev-dir>
Installing extension dependencies...
Building extension...
Starting extension watch process in background...
Extension watch PID: <pid>
DEV MODE: Extension development environment ready!
To reload extension changes: run 'Developer: Reload Window' in code-server
========================================
```

### Reloading Changes

After making changes to the extension source:
1. The watch process automatically recompiles TypeScript
2. Run "Developer: Reload Window" in code-server to load the changes

### Disabling Dev Mode

To disable dev mode via the automation server:

```bash
bitswan workspace update <workspace-name> --disable-dev-mode
```

## Extension Structure

```
Extension/
  src/                 # TypeScript source files
  out/                 # Compiled JavaScript (generated)
  package.json         # Extension manifest
  tsconfig.json        # TypeScript configuration
```

## Code Style

- Follow TypeScript best practices
- Use ESLint for code linting
- Format code consistently

## Building

Build the extension:

```bash
cd Extension
npm run compile
```

Build with watch mode:

```bash
npm run watch
```

## Testing

Run extension tests:

```bash
npm test
```

## Submitting Changes

1. Create a feature branch from `main`
2. Make your changes
3. Ensure the extension builds and tests pass
4. Submit a pull request
