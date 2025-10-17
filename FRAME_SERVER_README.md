# BitSwan Editor with Caddy Reverse Proxy

This Docker container now includes a Caddy reverse proxy that serves as a drop-in replacement for the original code-server setup.

## Architecture

1. **Caddy Reverse Proxy**: Runs on port 9999 (external access point) or 9997 (when OAuth enabled)
2. **Code-Server**: Runs internally on port 9998 (not exposed)
3. **OAuth Proxy**: Optional, runs on port 9999 when OAuth is enabled, forwarding to Caddy

## Features

- **Drop-in Replacement**: Maintains the same external port (9999) as the original setup
- **Floating BitSwan Icon**: A floating icon in the top-left corner
- **AOC Integration**: If `AOC_URL` environment variable is set, the icon becomes a clickable link
- **Responsive Design**: Modern UI with loading states and error handling
- **OAuth Support**: Works with both OAuth-enabled and direct access modes
- **Robust Proxy**: Uses Caddy for reliable reverse proxying with WebSocket support

## Usage

### Environment Variables

- `AOC_URL`: Optional URL for the BitSwan icon link
- `OAUTH_ENABLED`: Set to "true" to enable OAuth2 proxy

### Ports

- **9999**: External access point (OAuth proxy when enabled, Caddy when disabled)
- **9998**: Internal code-server (not exposed)
- **9997**: Internal Caddy (when OAuth enabled)

### Access

- **Primary**: `http://localhost:9999` - Caddy reverse proxy with floating icon (drop-in replacement)
- **No direct access**: Code-server is only accessible through the proxy

## Implementation Details

- Caddy reverse proxy forwards all requests to code-server (port 9998)
- HTML responses are modified using Caddy's templates to inject floating BitSwan icon
- All HTTP methods and WebSocket connections are proxied transparently
- When OAuth is enabled: OAuth proxy → Caddy → Code-server
- When OAuth is disabled: Caddy → Code-server
- All servers run concurrently and the container waits for all processes