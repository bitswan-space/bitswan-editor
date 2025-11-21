# Bitswan Editor

## Deployment

Use the [`bitswan cli`](https://github.com/bitswan-space/bitswan-workspaces) to deploy.

### Building the Editor Image

Before starting development, you need to build the editor Docker image:

```bash
docker build -t <1> <2>
```
**1.** Name of the container of your choosing, for example editor-test
**2.** Path to bitswan-editor, if in the folder then"."

### Updating the Editor Container

After building a new editor image, update the workspace container:

```bash
bitswan workspace update --editor-image <container name> <workspace>
```

Replace `<workspace>` with your workspace name.

### Managing Workspaces

**List all workspaces:**
```bash
bitswan workspace list
```

**List workspaces with passwords (for local development):**
```bash
bitswan workspace list --long --passwords
```

**Initialize a new workspace:**
```bash
bitswan workspace init
```

**Get help with workspace commands:**
```bash
bitswan workspace --help
```

**Available workspace commands:**
- `init` - Initializes a new GitOps, Caddy and Bitswan editor
- `list` - List available bitswan workspaces
- `open` - Open the editor for a workspace
- `pull-and-deploy` - Pull a specific branch into workspace gitops folder, build all automation images, and deploy them
- `remove` - Remove a workspace
- `select` - Select a workspace for activation
- `service` - Manage workspace services
- `update` - Update workspace configuration

### Debugging

**Check if the bitswan-network exists:**
```bash
docker network ls
```

**Access terminal in the editor container:**
```bash
docker exec -it dev-editor-bitswan-editor-1 bash
```

