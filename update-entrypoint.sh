#!/bin/bash
EXTENSIONS_DIR="/home/coder/.local/share/code-server/extensions"
TEMP_EXTENSIONS_DIR="/tmp/extensions"

mkdir -p ${EXTENSIONS_DIR}
mkdir -p ${TEMP_EXTENSIONS_DIR}

# Function to get installed extension version
get_installed_version() {
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

# Function to install or update an extension from local file
install_or_update_extension_local() {
    local extension=$1
    local version=$2
    local local_file=$3
    local installed_version=$(get_installed_version "$extension")
    
    if [ -z "$installed_version" ] || [ "$installed_version" != "$version" ]; then
        echo "Installing/Updating ${extension} from version ${installed_version:-none} to ${version}..."
        
        if [ -f "$local_file" ]; then
            echo "Installing from local file: $local_file"
            code-server --install-extension "$local_file" --force
        else
            echo "Local file not found: $local_file"
        fi
    else
        echo "${extension} is already at version ${version}"
    fi
}

echo "Installing/Updating extensions from pre-downloaded files..."

# Install marketplace extensions from pre-downloaded files
install_or_update_extension_local "GitHub.copilot" "$COPILOT_EXTENSION_VERSION" "/opt/extensions/copilot.vsix"
install_or_update_extension_local "ms-python.vscode-pylance" "$PYLANCE_EXTENSION_VERSION" "/opt/extensions/pylance.vsix"
install_or_update_extension_local "ms-python.python" "$PYTHON_EXTENSION_VERSION" "/opt/extensions/python.vsix"
install_or_update_extension_local "ms-toolsai.jupyter" "$JUPYTER_EXTENSION_VERSION" "/opt/extensions/jupyter.vsix"

# Install locally built BitSwan extension
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

# Copy virtual environment
cp -r /opt/.bitswan /home/coder/workspace

INTERNAL_CODE_SERVER_PORT="9998"
# The port the container will expose EXTERNALLY (where oauth2-proxy listens)
EXTERNAL_PORT="9999"
# Configure git with hostname-based username and fixed email
git config --global user.name "$HOSTNAME Bitswan user"
git config --global user.email "$HOSTNAME-bitswan@example.com"

if [ "$OAUTH_ENABLED" = "true" ]; then
  echo "OAuth is enabled. Starting oauth2-proxy and code-server."

  export OAUTH2_PROXY_UPSTREAMS="http://127.0.0.1:${INTERNAL_CODE_SERVER_PORT}"
  export OAUTH2_PROXY_HTTP_ADDRESS="0.0.0.0:${EXTERNAL_PORT}"

  oauth2-proxy &

  exec /usr/bin/entrypoint.sh \
    --bind-addr "127.0.0.1:${INTERNAL_CODE_SERVER_PORT}" \
    --auth none \
    .

else
  # Execute the original entrypoint
  echo "OAuth is disabled. Starting code-server directly."
  exec "$@"
fi
