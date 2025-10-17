FROM quay.io/oauth2-proxy/oauth2-proxy:v7.9.0 AS proxy_builder

FROM --platform=linux/amd64 ghcr.io/astral-sh/uv:latest AS uvbin

# Build stage for the extension
FROM --platform=linux/amd64 node:18-alpine AS extension_builder
WORKDIR /build
COPY Extension/ ./
RUN npm install
RUN npx vsce package --out bitswan-extension.vsix

FROM --platform=linux/amd64 codercom/code-server:4.104.3-ubuntu

ENV VENV_PATH=/opt/.bitswan
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python

# Environment variables for extension compatibility
ENV VSCODE_AGENT_FOLDER=/home/coder/.vscode-server
ENV VSCODE_EXTENSIONS_FOLDER=/home/coder/.local/share/code-server/extensions
ENV CODE_SERVER_EXTENSIONS_DIR=/home/coder/.local/share/code-server/extensions

# Environment variables for MSAL and Microsoft extensions
ENV ELECTRON_DISABLE_SECURITY_WARNINGS=1
ENV ELECTRON_NO_ATTACH_CONSOLE=1
ENV VSCODE_DISABLE_CRASH_REPORTER=1

USER root

# Set the timezone
RUN ln -snf /usr/share/zoneinfo/$CONTAINER_TIMEZONE /etc/localtime && echo $CONTAINER_TIMEZONE > /etc/timezone

RUN mkdir -p /opt/uv/python && chmod -R 755 /opt/uv

RUN apt-get update && apt-get install -y \
    jq \
    curl \
    unzip \
    build-essential \
    python3-dev \
    libffi-dev \
    libssl-dev \
    libsecret-1-dev \
    libsecret-1-0 \
    pkg-config \
    libgtk-3-dev \
    libx11-dev \
    libxss1 \
    ca-certificates \
    gnupg \
    lsb-release

# Install Node.js 18 (required for MSAL)
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

# Install Caddy
RUN curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list && \
    apt-get update && \
    apt-get install -y caddy

COPY --from=uvbin /uv /uvx /bin/

COPY --from=proxy_builder /bin/oauth2-proxy /usr/local/bin/oauth2-proxy

RUN uv python install 3.10

RUN chmod -R 755 /opt/uv

# Create a virtual environment
RUN uv venv ${VENV_PATH} --python $(uv python find 3.10) && \
    chown -R coder:coder ${VENV_PATH}
RUN echo "export PYTHONPATH=/home/coder/workspace/workspace/bitswan_lib:${PYTHONPATH}" >> ${VENV_PATH}/bin/activate

RUN uv pip install --python ${VENV_PATH}/bin/python --upgrade pip

# Install Python packages
COPY requirements.txt /opt/requirements.txt
RUN uv pip install --python ${VENV_PATH}/bin/python -r /opt/requirements.txt

# Install MSAL node extensions for Microsoft authentication
RUN npm config set cache /tmp/.npm && \
    npm install -g @azure/msal-node-extensions && \
    rm -rf /tmp/.npm

# Copy the built extension from the build stage
RUN mkdir -p /opt/bitswan-extension
COPY --from=extension_builder /build/bitswan-extension.vsix /opt/bitswan-extension/
RUN chown -R coder:coder /opt/bitswan-extension

# Download and install all marketplace extensions during build
RUN mkdir -p /home/coder/.local/share/code-server/extensions
RUN mkdir -p /opt/extensions
RUN chown -R coder:coder /home/coder/.local/share/code-server
RUN chown -R coder:coder /opt/extensions

# Define extension versions and URLs
ENV PYTHON_EXTENSION_VERSION="2025.17.2025100201"
ENV JUPYTER_EXTENSION_VERSION="2025.8.0"
ENV COPILOT_EXTENSION_VERSION="1.378.1798"
ENV PYLANCE_EXTENSION_VERSION="2025.8.3"

# Download marketplace extensions directly to /opt/extensions
RUN curl -L -o /opt/extensions/copilot.vsix.gz "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/GitHub/vsextensions/copilot/$COPILOT_EXTENSION_VERSION/vspackage" && \
    gunzip /opt/extensions/copilot.vsix.gz

RUN curl -L -o /opt/extensions/pylance.vsix.gz "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/vscode-pylance/$PYLANCE_EXTENSION_VERSION/vspackage" && \
    gunzip /opt/extensions/pylance.vsix.gz

RUN curl -L -o /opt/extensions/python.vsix.gz "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/python/$PYTHON_EXTENSION_VERSION/vspackage" && \
    gunzip /opt/extensions/python.vsix.gz

RUN curl -L -o /opt/extensions/jupyter.vsix.gz "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-toolsai/vsextensions/jupyter/$JUPYTER_EXTENSION_VERSION/vspackage" && \
    gunzip /opt/extensions/jupyter.vsix.gz

# Ensure all downloaded extensions are owned by coder user
RUN chown -R coder:coder /opt/extensions

# Create code-server configuration directory and add settings
RUN mkdir -p /home/coder/.config/code-server
RUN echo '{"extensions.supportNodeGlobalNavigator": false}' > /home/coder/.config/code-server/settings.json
RUN chown -R coder:coder /home/coder/.config

# Ensure MSAL runtime is accessible
RUN mkdir -p /usr/lib/code-server/lib/vscode/extensions/microsoft-authentication/node_modules/@azure/msal-node-extensions
RUN chown -R coder:coder /usr/lib/code-server/lib/vscode/extensions

# Create a symlink to the globally installed MSAL runtime
RUN ln -sf /usr/lib/node_modules/@azure/msal-node-extensions /usr/lib/code-server/lib/vscode/extensions/microsoft-authentication/node_modules/@azure/msal-node-extensions || true

COPY update-entrypoint.sh /usr/bin/update-entrypoint.sh
RUN chmod +x /usr/bin/update-entrypoint.sh

COPY Caddyfile /etc/caddy/Caddyfile
RUN chmod 644 /etc/caddy/Caddyfile

# Create frame directory and copy HTML file and logo
RUN mkdir -p /opt/bitswan-frame
COPY frame.html /opt/bitswan-frame/frame.html
COPY Extension/resources/bitswan-logo.png /opt/bitswan-frame/bitswan-logo.png
RUN chmod 644 /opt/bitswan-frame/frame.html /opt/bitswan-frame/bitswan-logo.png
RUN chown -R coder:coder /opt/bitswan-frame

USER coder

EXPOSE 9999

WORKDIR /home/coder/workspace
ENTRYPOINT ["/usr/bin/update-entrypoint.sh"]
