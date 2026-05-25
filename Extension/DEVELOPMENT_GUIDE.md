# BitSwan Development Guide

BitSwan is a platform for building automations and microservices, deploying them with a single click, and promoting them through staged environments with network isolation and access control.

## Workspace Overview

When you open BitSwan in VS Code, the **Bitswan Workspace** tab is your home. It shows:

- **Worktrees** (feature branches) in the sidebar, each isolated with its own deployments
- **Business Processes** containing one or more automations
- **Automations** with their deployment status across stages (live-dev, dev, staging, production)
- **Requirements** and **README** for each business process

Each automation shows an icon reflecting its type: web frontends, backend APIs, streaming/Kafka services, or generic automations.

### Worktrees

Worktrees are git branches with isolated deployment copies. Create one for each feature:

1. Click **Create Worktree** in the sidebar
2. Develop and test in the worktree's live-dev environment
3. When ready, **Sync** (rebase onto main) and **Merge** back

Each worktree gets its own set of live-dev containers, separate from the main branch's dev/staging/production deployments.

## Exposure and Access Control

The table below shows how automations are accessed based on their stage and exposure configuration. This is the central security model.

### Routing Matrix

|                              | `expose=true`              | `expose_to=["groups"]`     | `expose_to` + `expose_to_internet=true` | No exposure settings |
|------------------------------|---------------------------|---------------------------|----------------------------------------|---------------------|
| **live-dev**                 | VPN only                  | VPN + SSO                 | VPN + SSO                              | Not exposed          |
| **dev**                      | VPN only                  | VPN + SSO                 | VPN + SSO                              | Not exposed          |
| **staging**                  | Public internet           | VPN + SSO                 | Public internet + SSO                  | Not exposed          |
| **production**               | Public internet           | VPN + SSO                 | Public internet + SSO                  | Not exposed          |

**Key:**
- **VPN only** -- accessible only through the WireGuard VPN tunnel. No authentication beyond VPN access.
- **VPN + SSO** -- accessible through VPN, protected by OAuth2/Keycloak. Users must belong to the specified groups.
- **Public internet + SSO** -- accessible from the internet, protected by OAuth2/Keycloak.
- **Public internet** -- accessible from the internet with no authentication (use for public-facing services).
- **Not exposed** -- no HTTP route, no port published. The container runs but is only reachable by other containers on the same stage network via Docker DNS.

**Security defaults:**
- `live-dev` and `dev` are **always internal** (VPN only), regardless of exposure settings
- `staging` and `production` go external only when explicitly exposed
- When VPN is not configured, the system falls back to single-ingress routing

### Configuration Examples

**Public API (staging + production on the internet, dev behind VPN):**
```toml
[deployment]
port = 8080
expose = true
```

**Internal tool with SSO (VPN-only at all stages):**
```toml
[deployment]
port = 3000

[expose_to]
dev = ["/MyOrg/developers"]
staging = ["/MyOrg/developers", "/MyOrg/qa"]
production = ["/MyOrg/all-staff"]
```

**Customer-facing app with SSO on the internet:**
```toml
[deployment]
port = 3000
expose_to_internet = true

[expose_to]
dev = ["/MyOrg/developers"]
staging = ["/MyOrg/qa"]
production = ["/MyOrg/customers"]
```

> `expose` and `expose_to` are mutually exclusive. Use `expose=true` for public services, `expose_to` for SSO-protected services.

## Deployment Stages

### live-dev (worktree development)

Your source code is **mounted directly** into the container. Edits are reflected immediately (or after a restart). This is where you develop and test.

- Start via the **Start Live Dev** button in the workspace
- Source code mounted at `/app/`
- Always on the `{workspace}-dev` Docker network
- Accessible via VPN only

### dev (main branch)

Deployed from the main branch. Same network isolation as live-dev but runs the committed code, not live-mounted source.

### staging

Pre-production testing. Deployed from a specific checksum (immutable). Can be exposed to the internet with `expose=true` or kept VPN-only.

### production

Live deployment. Same exposure rules as staging. Production deployments have no stage suffix in their deployment ID (e.g., `my-app-mybp` instead of `my-app-mybp-staging`).

### Promotion Flow

```
live-dev (worktree) --> dev (main branch) --> staging --> production
```

1. Develop in a worktree's live-dev environment
2. Merge the worktree to main (creates a dev deployment)
3. Right-click the dev stage in the sidebar --> **Promote to Staging**
4. Test in staging, then right-click --> **Promote to Production**

Each promotion creates an immutable snapshot (checksum) of the code.

## Network Isolation

Each workspace has three isolated Docker networks:

| Network | Contains | Isolation |
|---------|----------|-----------|
| `{workspace}-dev` | live-dev + dev automations, dev infra services | Cannot reach staging or production |
| `{workspace}-staging` | staging automations, staging infra services | Cannot reach dev or production |
| `{workspace}-production` | production automations, production infra services | Cannot reach dev or staging |

**Containers on the same stage network CAN communicate** (e.g., a dev app can reach its dev Postgres). Containers on different stage networks CANNOT communicate -- enforced by Docker network boundaries.

Management services (editor, gitops, coding agent) are on a separate `bitswan_network` and cannot be reached by automation containers.

## What is a BitSwan Automation

A BitSwan automation processes events from a Source, runs them through processing steps, and emits results via a Sink.

```
Source --> Processing Steps --> Sink
```

- **Source**: where events come from (WebForm, Webhook, Kafka, Cron trigger)
- **Processing Steps**: cells/functions that transform each event
- **Sink**: where results go (HTTP response, DB write, Kafka topic, log)

### Types of Automations

**Time-triggered** -- run on a schedule using cron expressions. Ideal for periodic tasks, reporting, and cleanup.

**Manually triggered** -- wait for HTTP requests or form submissions. Use `WebFormSource` for interactive forms, `ProtectedWebFormSource` for secret-protected forms.

**Event-triggered** -- react to Kafka messages or streaming data. Best for event-driven architectures and data pipelines.

## Project Structure

```
MyBusinessProcess/
  my-automation/
    automation.toml           # deployment config
    main.ipynb                # main notebook (or main.py for non-notebook apps)
    image/
      Dockerfile              # custom image (optional)
      requirements.txt        # dependencies (optional)
  another-automation/
    automation.toml
    app/
      main.py
    image/
      Dockerfile
```

### `auto_pipeline` (Notebook Automations)

```python
from bspump.jupyter import *
from bspump.http.web.server import *

auto_pipeline(
    source=lambda app, pipeline: WebFormSource(app, pipeline, route="/",
        fields=[TextField("name"), TextField("email")]),
    sink=lambda app, pipeline: WebSink(app, pipeline),
    name="MyForm"
)

# Cells below run for each form submission
# event["form"] contains the submitted data
```

### Custom Image (Non-notebook Apps)

For FastAPI, React, or any other framework, create an `image/` directory:

```toml
# automation.toml
[deployment]
port = 8000
expose = true
```

```dockerfile
# image/Dockerfile
FROM python:3.12-slim
WORKDIR /deps
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
WORKDIR /app
ENTRYPOINT ["python", "main.py"]
```

Your source code is mounted at `/app/` at runtime -- you don't need to `COPY` it in the Dockerfile.

## Configuration Reference

### `automation.toml`

```toml
[deployment]
image = "bitswan/pipeline-runtime-environment:latest"  # Docker image (optional with image/ dir)
port = 8080                                             # Application port
expose = true                                           # Public internet access (no OAuth2)
expose_to_internet = false                              # Route expose_to via external ingress

[expose_to]
dev = ["/Org/developers"]              # OAuth2 groups for dev/live-dev
staging = ["/Org/developers", "/Org/qa"]
production = ["/Org/all-staff"]

[secrets]
dev = ["dev-secrets", "dev-db"]        # Secret groups injected as env vars
staging = ["staging-secrets"]
production = ["prod-secrets", "prod-db"]

[services]
kafka = { enabled = true }             # Enable Kafka for this automation
postgres = { enabled = true }          # Enable PostgreSQL
couchdb = { enabled = true }           # Enable CouchDB
minio = { enabled = true }             # Enable MinIO (S3-compatible storage)
```

| Field | Type | Description |
|-------|------|-------------|
| `image` | string | Docker image. Omit if using `image/` directory. |
| `port` | integer | Application port (default: 8080) |
| `expose` | boolean | Expose publicly on staging/production (no OAuth2) |
| `expose_to_internet` | boolean | Route `expose_to` services via external ingress |
| `[expose_to]` | section | Per-stage OAuth2 groups. Mutually exclusive with `expose`. |
| `[secrets]` | section | Per-stage secret groups. `dev` and `live-dev` share secrets. |
| `[services]` | section | Infrastructure service dependencies |

### Secrets

Create secret groups in the **Secrets** panel (sidebar), then reference them:

```toml
[secrets]
dev = ["my-api-keys", "my-db-creds"]
staging = ["staging-api-keys"]
production = ["prod-api-keys", "prod-db-creds"]
```

Secrets are injected as environment variables into the container at startup. The `dev` and `live-dev` stages share the same secret groups.

## Infrastructure Services

Automations can depend on infrastructure services declared in `automation.toml`:

| Service | What it provides |
|---------|-----------------|
| `postgres` | PostgreSQL database, per-stage isolated |
| `kafka` | Apache Kafka message broker |
| `couchdb` | CouchDB document database |
| `minio` | S3-compatible object storage |

Each service runs on the same stage network as the automation -- a dev automation gets a dev Postgres, a staging automation gets a staging Postgres. They are fully isolated.

Enable in `automation.toml`:
```toml
[services]
postgres = { enabled = true }
```

## VPN Access

The workspace is accessible through a WireGuard VPN. Internal services (dev automations, editor, gitops) are only reachable via the VPN.

**First-time setup:**
1. Visit the VPN admin page (link provided by your administrator)
2. Download the WireGuard configuration file
3. Download and install the CA certificate for HTTPS trust
4. Import the config into the WireGuard client on your device

**CA Certificate:** Download from the VPN admin page. Install it in your system/browser trust store to avoid HTTPS warnings for internal services. See the VPN admin page for per-platform installation instructions.

## Coding Agent

The BitSwan Coding Agent provides an AI-assisted development environment inside the workspace. It runs as a container on `bitswan_network` with access to your worktrees.

- Open via **Agent Terminal** in the workspace
- Has SSH access to the workspace repository
- Can deploy, restart, and inspect automations via the agent API

## Snapshots

Snapshots capture the full data state of a stage (Postgres, CouchDB, MinIO) into tarballs stored on the gitops host. They let you clone a known-good state from one stage into another — for example, copying production data down to staging for debugging.

### Creating a snapshot

Right-click any stage in the Snapshots panel and choose **Create Snapshot**, or use the panel toolbar. Optionally give it a name; the snapshot ID is always auto-generated. For the `production` stage you will first see a size estimate and a confirmation modal.

Snapshot creation runs in the background. A progress notification tracks each step (Postgres backup → CouchDB backup → MinIO backup → writing manifest). You can keep working while it runs.

### Cloning a snapshot into a stage

Right-click a snapshot and choose **Clone**. You'll be asked which stage to clone into. The target stage's automations are briefly stopped while data is restored, then restarted. You will always see a confirmation prompt; cloning into `production` requires a second explicit acknowledgement.

**Source consistency:** the snapshot captures each service separately and is not a single atomic transaction. If automations were writing data during the snapshot, you may see minor inconsistencies across services.

### Production as a destination

Cloning into `production` is intentionally guarded by a double-confirmation modal. There is no automatic rollback — take a snapshot of production first if you want a recovery point.

### Partial failures

If a clone fails mid-way (e.g. Postgres succeeded but CouchDB failed), the target stage is left stopped. An inline **Resume target** button appears in the error notification; clicking it restarts the target automations so the service becomes available again even though the restore was incomplete. You can then fix the underlying problem and re-clone.

### Retention

The gitops server keeps the last **5** snapshots per source stage by default (configurable via `SNAPSHOT_RETENTION_PER_STAGE`). Older snapshots are pruned automatically after each create and nightly at 03:00.

### Deleting snapshots

Right-click a snapshot and choose **Delete**. Deletion is immediate and cannot be undone.

## Debugging and Testing

- **Notebooks**: run cells interactively in Jupyter for step-by-step debugging
- **Live Dev**: edit source files and restart the container to see changes
- **Logs**: click any running automation to stream its logs (stdout in white, stderr in red)
- **Inspect**: right-click an automation to see container details (env vars, mounts, networks)

## Architecture Overview

```
Internet (untrusted)
    |
[External Traefik] -- ports 80/443, LetsEncrypt
    |-- staging/production automations (expose=true)
    |-- expose_to + expose_to_internet automations (with OAuth2)
    +-- VPN admin page (OAuth-protected)

WireGuard VPN (UDP 51820)
    |
[VPN Traefik] -- HTTPS with workspace CA cert
    |-- editor, gitops (management)
    |-- all dev/live-dev automations
    |-- expose_to automations (with OAuth2)
    +-- VPN admin internal page
```
