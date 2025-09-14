#!/bin/bash
EXTENSIONS_DIR="/home/coder/.local/share/code-server/extensions"
TEMP_EXTENSIONS_DIR="/tmp/extensions"

mkdir -p ${EXTENSIONS_DIR}
mkdir -p ${TEMP_EXTENSIONS_DIR}

PYTHON_EXTENSION_VERSION="2025.3.2025031001"
JUPYTER_EXTENSION_VERSION="2024.11.2024102401"
COPILOT_EXTENSION_VERSION="1.250.1260"
PYLANCE_EXTENSION_VERSION="2025.3.102"

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

# Function to install or update an extension
install_or_update_extension() {
    local extension=$1
    local version=$2
    local url=$3
    local installed_version=$(get_installed_version "$extension")
    local publisher=$(echo $extension | cut -d'.' -f1)
    local name=$(echo $extension | cut -d'.' -f2)
    
    if [ -z "$installed_version" ] || [ "$installed_version" != "$version" ]; then
        echo "Installing/Updating ${extension} from version ${installed_version:-none} to ${version}..."
        
        # Download and install extension
        if [[ $url == *"vspackage"* ]]; then
            echo "Downloading ${url}"
            curl -L -o "${TEMP_EXTENSIONS_DIR}/${name}.vsix.gz" "$url"
            gunzip "${TEMP_EXTENSIONS_DIR}/${name}.vsix.gz"
            code-server --install-extension "${TEMP_EXTENSIONS_DIR}/${name}.vsix" --force
        else
            echo "Downloading ${url}"
            curl -L -o "${TEMP_EXTENSIONS_DIR}/${name}.vsix" "$url"
            sleep 1
            code-server --install-extension "${TEMP_EXTENSIONS_DIR}/${name}.vsix" --force
        fi
    else
        echo "${extension} is already at version ${version}"
    fi
}

echo "Installing/Updating extensions..."

# Install marketplace extensions with hardcoded versions
declare -A marketplace_extensions=(
    ["GitHub.copilot"]="$COPILOT_EXTENSION_VERSION#https://marketplace.visualstudio.com/_apis/public/gallery/publishers/GitHub/vsextensions/copilot/$COPILOT_EXTENSION_VERSION/vspackage"
    ["ms-python.vscode-pylance"]="$PYLANCE_EXTENSION_VERSION#https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/vscode-pylance/$PYLANCE_EXTENSION_VERSION/vspackage"
    ["ms-python.python"]="$PYTHON_EXTENSION_VERSION#https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/python/$PYTHON_EXTENSION_VERSION/vspackage"
    ["ms-toolsai.jupyter"]="$JUPYTER_EXTENSION_VERSION#https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-toolsai/vsextensions/jupyter/$JUPYTER_EXTENSION_VERSION/vspackage"
)

# Install marketplace extensions
for extension in "${!marketplace_extensions[@]}"; do
    IFS='#' read -r version url <<< "${marketplace_extensions[$extension]}"
    install_or_update_extension "$extension" "$version" "$url"
done

# Handle BitSwan extension dynamically
echo "Checking BitSwan extension..."
REPO="bitswan-space/bitswan-editor"

# Get the latest release tag and version
TAG=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | jq -r .tag_name)
if [ -n "$TAG" ] && [ "$TAG" != "null" ]; then
    VERSION=$(echo $TAG | sed 's/^v//')
    VSIX_URL="https://github.com/$REPO/releases/download/$TAG/bitswan-$VERSION.vsix"
    
    install_or_update_extension "libertyacesltd.bitswan" "$VERSION" "$VSIX_URL"
else
    echo "Failed to get latest release information for BitSwan extension"
fi

# Copy virtual environment
cp -r /tmp/.bitswan /home/coder/workspace

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
