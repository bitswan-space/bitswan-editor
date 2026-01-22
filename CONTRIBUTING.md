# Development Mode

When developing the BitSwan VS Code extension, you can enable dev mode to get live-reloading.

## Enabling Dev Mode

Use the automation server CLI:

```bash
bitswan workspace update <workspace-name> --dev-mode --editor-dev-source-dir /path/to/bitswan-editor/Extension
```

This mounts your local extension source and sets up the development environment.

## How It Works

When dev mode is enabled, the container:

1. Removes any existing installed extension versions
2. Creates a symlink to your development extension directory
3. Installs dependencies if needed
4. Builds the extension if the `out` directory doesn't exist
5. Starts a watch process for live TypeScript compilation

## Reloading Changes

After making changes to the extension source:

1. The watch process automatically recompiles TypeScript
2. Run "Developer: Reload Window" in code-server
3. Refresh your web browser

Both steps 2 and 3 are required.

## Disabling Dev Mode

```bash
bitswan workspace update <workspace-name> --disable-dev-mode
```
