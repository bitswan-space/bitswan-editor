#!/bin/bash
EXTENSIONS_DIR="/home/coder/.local/share/code-server/extensions"
TEMP_EXTENSIONS_DIR="/tmp/extensions"
EXTENSIONS_VERSION_FILE="/home/coder/.local/share/code-server/installed-extensions.json"

mkdir -p ${EXTENSIONS_DIR}
mkdir -p ${TEMP_EXTENSIONS_DIR}
mkdir -p "$(dirname "$EXTENSIONS_VERSION_FILE")"

# Create symlink from /home/coder/workspace to /workspace for backward compatibility
if [ ! -L /home/coder/workspace ] && [ ! -d /home/coder/workspace ]; then
    ln -s /workspace /home/coder/workspace
    echo "Created symlink: /home/coder/workspace -> /workspace"
elif [ -d /home/coder/workspace ] && [ ! -L /home/coder/workspace ]; then
    echo "WARNING: /home/coder/workspace exists as a directory. Migration may be needed."
fi

if [ "$UPDATE_CA_CERTIFICATES" = "true" ]; then
    echo "Updating CA certificates..."
    if [ -d /usr/local/share/ca-certificates/custom ]; then
        # Copy certificates from read-only mount to writable location
        sudo cp /usr/local/share/ca-certificates/custom/*.crt /usr/local/share/ca-certificates/ 2>/dev/null || true
        sudo cp /usr/local/share/ca-certificates/custom/*.pem /usr/local/share/ca-certificates/ 2>/dev/null || true
        
        # Rename .pem files to .crt (update-ca-certificates requires .crt)
        for f in /usr/local/share/ca-certificates/*.pem; do
            [ -f "$f" ] && sudo mv "$f" "${f%.pem}.crt"
            echo "Renaming .pem files to .crt (update-ca-certificates requires .crt)"
        done
        
        # Update the system CA certificates
        sudo update-ca-certificates 2>&1 | grep -v "WARNING: ca-certificates.crt does not contain exactly one certificate or CRL"
        echo "CA certificates updated successfully"
    else
        echo "No custom CA certificates found at /usr/local/share/ca-certificates/custom"
    fi
fi


# Initialize extensions version file if it doesn't exist
if [ ! -f "$EXTENSIONS_VERSION_FILE" ]; then
    echo "{}" > "$EXTENSIONS_VERSION_FILE"
fi

# Function to get installed extension version from JSON file
get_installed_version() {
    local extension=$1
    local version=$(jq -r --arg ext "$extension" '.[$ext] // empty' "$EXTENSIONS_VERSION_FILE" 2>/dev/null)
    if [ -n "$version" ] && [ "$version" != "null" ]; then
        echo "$version"
    else
        echo ""
    fi
}

# Function to update installed extension version in JSON file
update_installed_version() {
    local extension=$1
    local version=$2
    local temp_file=$(mktemp)
    jq --arg ext "$extension" --arg ver "$version" '.[$ext] = $ver' "$EXTENSIONS_VERSION_FILE" > "$temp_file" && mv "$temp_file" "$EXTENSIONS_VERSION_FILE"
}

# Function to get installed extension version from filesystem (fallback)
get_installed_version_filesystem() {
    local extension=$1
    local publisher=$(echo $extension | cut -d'.' -f1)
    local name=$(echo $extension | cut -d'.' -f2)
    
    # Find the exact extension directory (no additional components like -keymap or -renderers)
    local latest_installed=$(ls -d ${EXTENSIONS_DIR}/${publisher,,}.${name}-[0-9]* 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$latest_installed" ]; then
        echo "$latest_installed" | grep -o '[0-9][0-9.]*$'
    else
        echo ""
    fi
}

# Function to compare version strings (returns 0 if v1 >= v2, 1 otherwise)
version_compare() {
    local v1=$1
    local v2=$2
    
    # If either version is empty, consider it as "not installed"
    if [ -z "$v1" ]; then
        return 1  # Need to install
    fi
    if [ -z "$v2" ]; then
        return 0  # Already installed
    fi
    
    # Use sort -V for version comparison
    if [ "$v1" = "$v2" ]; then
        return 0  # Same version
    fi
    
    # Check if v1 is newer than v2
    if printf '%s\n%s\n' "$v1" "$v2" | sort -V -C; then
        return 0  # v1 >= v2
    else
        return 1  # v1 < v2, need to update
    fi
}

# Function to install or update an extension from local file
install_or_update_extension_local() {
    local extension=$1
    local version=$2
    local local_file=$3
    
    # Get installed version from JSON file first, fallback to filesystem
    local installed_version=$(get_installed_version "$extension")
    if [ -z "$installed_version" ]; then
        installed_version=$(get_installed_version_filesystem "$extension")
        # If found in filesystem but not in JSON, update JSON
        if [ -n "$installed_version" ]; then
            update_installed_version "$extension" "$installed_version"
        fi
    fi
    
    # Check if we need to install/update
    if [ -z "$installed_version" ] || ! version_compare "$installed_version" "$version"; then
        echo "Installing/Updating ${extension} from version ${installed_version:-none} to ${version}..."
        
        if [ -f "$local_file" ]; then
            echo "Installing from local file: $local_file"
            if code-server --install-extension "$local_file" --force; then
                # Update the version in JSON file after successful installation
                update_installed_version "$extension" "$version"
                echo "Successfully installed ${extension} version ${version}"
            else
                echo "Failed to install ${extension}"
                return 1
            fi
        else
            echo "Local file not found: $local_file"
            return 1
        fi
    else
        echo "${extension} is already at version ${installed_version} (>= ${version})"
    fi
}

echo "Installing/Updating extensions from pre-downloaded files..."

# Track installation results
INSTALLED_COUNT=0
UPDATED_COUNT=0
SKIPPED_COUNT=0

# Function to track installation results
track_installation() {
    local result=$1
    case $result in
        0) ((INSTALLED_COUNT++)) ;;
        1) ((UPDATED_COUNT++)) ;;
        2) ((SKIPPED_COUNT++)) ;;
    esac
}

# Install marketplace extensions from pre-downloaded files
install_or_update_extension_local "GitHub.copilot" "$COPILOT_EXTENSION_VERSION" "/opt/extensions/copilot.vsix"
install_or_update_extension_local "GitHub.copilot-chat" "$COPILOT_CHAT_EXTENSION_VERSION" "/opt/extensions/copilot-chat.vsix"
install_or_update_extension_local "ms-python.vscode-pylance" "$PYLANCE_EXTENSION_VERSION" "/opt/extensions/pylance.vsix"
install_or_update_extension_local "ms-python.python" "$PYTHON_EXTENSION_VERSION" "/opt/extensions/python.vsix"
install_or_update_extension_local "ms-toolsai.jupyter" "$JUPYTER_EXTENSION_VERSION" "/opt/extensions/jupyter.vsix"

# Auto-detect dev mode if extension source is available in workspace
# This allows automatic dev mode when the bitswan-editor repo is mounted
DEV_MODE_AUTO_DETECT_PATH="/workspace/workspace/AOC/bitswan-editor/Extension"
if [ "$BITSWAN_DEV_MODE" != "true" ] && [ -z "$BITSWAN_EXTENSION_DEV_DIR" ]; then
    if [ -f "$DEV_MODE_AUTO_DETECT_PATH/package.json" ]; then
        # Verify this is actually the bitswan extension
        DETECTED_EXT_NAME=$(jq -r .name "$DEV_MODE_AUTO_DETECT_PATH/package.json" 2>/dev/null)
        if [ "$DETECTED_EXT_NAME" = "bitswan" ]; then
            echo "========================================"
            echo "AUTO-DETECTED DEV MODE: Found extension source at $DEV_MODE_AUTO_DETECT_PATH"
            echo "========================================"
            export BITSWAN_DEV_MODE="true"
            export BITSWAN_EXTENSION_DEV_DIR="$DEV_MODE_AUTO_DETECT_PATH"
        fi
    fi
fi

# Install locally built BitSwan extension (or set up dev mode)
if [ "$BITSWAN_DEV_MODE" = "true" ] && [ -n "$BITSWAN_EXTENSION_DEV_DIR" ] && [ -d "$BITSWAN_EXTENSION_DEV_DIR" ]; then
    echo "========================================"
    echo "DEV MODE: Setting up extension development environment"
    echo "========================================"

    # Extract extension info from the dev directory
    DEV_PACKAGE_JSON="$BITSWAN_EXTENSION_DEV_DIR/package.json"
    if [ -f "$DEV_PACKAGE_JSON" ]; then
        DEV_EXT_NAME=$(jq -r .name "$DEV_PACKAGE_JSON")
        DEV_EXT_PUBLISHER=$(jq -r .publisher "$DEV_PACKAGE_JSON")
        DEV_EXT_VERSION=$(jq -r .version "$DEV_PACKAGE_JSON")
        DEV_EXT_ID="${DEV_EXT_PUBLISHER,,}.${DEV_EXT_NAME}-${DEV_EXT_VERSION}"

        echo "Extension: ${DEV_EXT_PUBLISHER}.${DEV_EXT_NAME} v${DEV_EXT_VERSION}"

        # Remove any existing installed version of the extension
        echo "Removing existing installed extension versions..."
        rm -rf "${EXTENSIONS_DIR}/${DEV_EXT_PUBLISHER,,}.${DEV_EXT_NAME}"* 2>/dev/null || true

        # Create symlink to the dev extension directory
        # The extension directory needs to be named correctly for VS Code to recognize it
        DEV_EXT_SYMLINK="${EXTENSIONS_DIR}/${DEV_EXT_ID}"

        echo "Creating symlink: $DEV_EXT_SYMLINK -> $BITSWAN_EXTENSION_DEV_DIR"
        ln -sf "$BITSWAN_EXTENSION_DEV_DIR" "$DEV_EXT_SYMLINK"

        # Install dependencies if node_modules doesn't exist or package-lock.json is newer
        if [ ! -d "$BITSWAN_EXTENSION_DEV_DIR/node_modules" ] || [ "$BITSWAN_EXTENSION_DEV_DIR/package.json" -nt "$BITSWAN_EXTENSION_DEV_DIR/node_modules" ]; then
            echo "Installing extension dependencies..."
            (cd "$BITSWAN_EXTENSION_DEV_DIR" && npm install)
        fi

        # Build the extension if out directory doesn't exist
        if [ ! -d "$BITSWAN_EXTENSION_DEV_DIR/out" ]; then
            echo "Building extension..."
            (cd "$BITSWAN_EXTENSION_DEV_DIR" && npm run compile 2>/dev/null || npm run build 2>/dev/null || true)
        fi

        # Start the watch process in background
        echo "Starting extension watch process in background..."
        (cd "$BITSWAN_EXTENSION_DEV_DIR" && npm run watch 2>&1 | while read line; do echo "[ext-watch] $line"; done) &
        WATCH_PID=$!
        echo "Extension watch PID: $WATCH_PID"

        echo "DEV MODE: Extension development environment ready!"
        echo "To reload extension changes: run 'Developer: Reload Window' in code-server"
        echo "========================================"
    else
        echo "DEV MODE ERROR: package.json not found in $BITSWAN_EXTENSION_DEV_DIR"
        echo "Falling back to pre-built extension..."
        # Fall back to normal installation
        LOCAL_EXTENSION_PATH="/opt/bitswan-extension/bitswan-extension.vsix"
        if [ -f "$LOCAL_EXTENSION_PATH" ]; then
            EXTENSION_VERSION=$(unzip -p "$LOCAL_EXTENSION_PATH" extension/package.json | jq -r .version)
            if [ -n "$EXTENSION_VERSION" ] && [ "$EXTENSION_VERSION" != "null" ]; then
                install_or_update_extension_local "libertyacesltd.bitswan" "$EXTENSION_VERSION" "$LOCAL_EXTENSION_PATH"
            fi
        fi
    fi
else
    echo "Installing locally built BitSwan extension..."
    LOCAL_EXTENSION_PATH="/opt/bitswan-extension/bitswan-extension.vsix"
    if [ -f "$LOCAL_EXTENSION_PATH" ]; then
        # Extract version from the built extension
        EXTENSION_VERSION=$(unzip -p "$LOCAL_EXTENSION_PATH" extension/package.json | jq -r .version)
        if [ -n "$EXTENSION_VERSION" ] && [ "$EXTENSION_VERSION" != "null" ]; then
            install_or_update_extension_local "libertyacesltd.bitswan" "$EXTENSION_VERSION" "$LOCAL_EXTENSION_PATH"
        else
            echo "Failed to extract version from locally built extension"
        fi
    else
        echo "Locally built BitSwan extension not found at $LOCAL_EXTENSION_PATH"
    fi
fi

# Extension installation summary
echo ""
echo "Extension installation summary:"
echo "- Installed: $INSTALLED_COUNT"
echo "- Updated: $UPDATED_COUNT" 
echo "- Skipped (already up-to-date): $SKIPPED_COUNT"
echo "- Version tracking file: $EXTENSIONS_VERSION_FILE"
echo ""

# Copy virtual environment
cp -r /opt/.bitswan /workspace

# Set up environment for MSAL
export ELECTRON_DISABLE_SECURITY_WARNINGS=1
export ELECTRON_NO_ATTACH_CONSOLE=1
export VSCODE_DISABLE_CRASH_REPORTER=1

# Ensure MSAL runtime directory is accessible
if [ -d "/usr/lib/code-server/lib/vscode/extensions/microsoft-authentication" ]; then
    chmod -R 755 /usr/lib/code-server/lib/vscode/extensions/microsoft-authentication
fi

# Create symlink to MSAL runtime if it doesn't exist
if [ ! -L "/usr/lib/code-server/lib/vscode/extensions/microsoft-authentication/node_modules/@azure/msal-node-extensions" ] && [ -d "/usr/lib/node_modules/@azure/msal-node-extensions" ]; then
    ln -sf /usr/lib/node_modules/@azure/msal-node-extensions /usr/lib/code-server/lib/vscode/extensions/microsoft-authentication/node_modules/@azure/msal-node-extensions
fi

INTERNAL_CODE_SERVER_PORT="9998"
# The port the container will expose EXTERNALLY (where OAuth proxy or Caddy listens)
EXTERNAL_PORT="9999"
# Caddy port (different when OAuth is enabled to avoid conflict)
CADDY_PORT="9997"
# Configure git with hostname-based username and fixed email
git config --global user.name "$HOSTNAME Bitswan user"
git config --global user.email "$HOSTNAME-bitswan@example.com"

# Create dynamic HTML file with AOC_URL
AOC_URL="${AOC_URL:-}"
# Remove "-editor" suffix from hostname for display
WORKSPACE_NAME="${HOSTNAME%-editor}"
# Use a different delimiter to avoid issues with special characters in AOC_URL and HOSTNAME
sed "s|AOC_URL_PLACEHOLDER|${AOC_URL}|g" /opt/bitswan-frame/frame.html | sed "s|WORKSPACE_NAME_PLACEHOLDER|${WORKSPACE_NAME}|g" > /opt/bitswan-frame/index.html


if [ "$OAUTH_ENABLED" = "true" ]; then
    CODE_SERVER_AUTH="none"
    echo "OAuth is enabled - code-server will use --auth none"
else
    CODE_SERVER_AUTH="password"
    echo "OAuth is disabled - code-server will use --auth password"
fi

# Start code-server on internal port
echo "Starting code-server on internal port ${INTERNAL_CODE_SERVER_PORT}..."
cd /workspace/workspace
/usr/bin/entrypoint.sh \
  --bind-addr "127.0.0.1:${INTERNAL_CODE_SERVER_PORT}" \
  --auth ${CODE_SERVER_AUTH} \
  /workspace/workspace &
CODE_SERVER_PID=$!

chown -R coder:coder /home/coder

if [ "$OAUTH_ENABLED" = "true" ]; then
  echo "OAuth is enabled. Starting oauth2-proxy and Caddy."

  # Start Caddy on internal port (will be proxied by oauth2-proxy)
  echo "Starting Caddy on internal port ${CADDY_PORT}..."
  export CODE_SERVER_PORT="${INTERNAL_CODE_SERVER_PORT}"
  # Create a temporary Caddyfile with the correct port
  sed "s/:9999/:${CADDY_PORT}/g" /etc/caddy/Caddyfile > /tmp/Caddyfile-${CADDY_PORT}
  caddy run --config /tmp/Caddyfile-${CADDY_PORT} --adapter caddyfile &
  CADDY_PID=$!

  # OAuth proxy listens on the external port and forwards to Caddy
  export OAUTH2_PROXY_UPSTREAMS="http://127.0.0.1:${CADDY_PORT}"
  export OAUTH2_PROXY_HTTP_ADDRESS="0.0.0.0:${EXTERNAL_PORT}"

  # Start oauth2-proxy (this will be the external service on port 9999)
  oauth2-proxy &
  OAUTH_PID=$!

  # Wait for all processes
  wait $CADDY_PID $CODE_SERVER_PID $OAUTH_PID

else
  # OAuth disabled - Caddy runs directly on external port
  echo "OAuth is disabled. Starting Caddy directly on port ${EXTERNAL_PORT}."

  # Start Caddy on external port
  echo "Starting Caddy on external port ${EXTERNAL_PORT}..."
  export CODE_SERVER_PORT="${INTERNAL_CODE_SERVER_PORT}"
  # Create a temporary Caddyfile with the correct port
  sed "s/:9999/:${EXTERNAL_PORT}/g" /etc/caddy/Caddyfile > /tmp/Caddyfile-${EXTERNAL_PORT}
  caddy run --config /tmp/Caddyfile-${EXTERNAL_PORT} --adapter caddyfile &
  CADDY_PID=$!

  # Wait for both processes
  wait $CADDY_PID $CODE_SERVER_PID
fi
