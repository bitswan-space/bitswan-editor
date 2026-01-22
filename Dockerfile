FROM --platform=linux/amd64 node:18-alpine AS extension_builder
WORKDIR /build
COPY Extension/ ./
RUN npm install
RUN npx vsce package --out bitswan-extension.vsix

FROM --platform=linux/amd64 codercom/code-server:4.108.1-ubuntu

ENV VSCODE_AGENT_FOLDER=/home/coder/.vscode-server
ENV VSCODE_EXTENSIONS_FOLDER=/home/coder/.local/share/code-server/extensions
ENV CODE_SERVER_EXTENSIONS_DIR=/home/coder/.local/share/code-server/extensions
ENV ELECTRON_DISABLE_SECURITY_WARNINGS=1
ENV ELECTRON_NO_ATTACH_CONSOLE=1
ENV VSCODE_DISABLE_CRASH_REPORTER=1
ENV PYTHON_EXTENSION_VERSION="2025.17.2025100201"
ENV JUPYTER_EXTENSION_VERSION="2025.8.0"
ENV COPILOT_EXTENSION_VERSION="1.378.1798"
ENV COPILOT_CHAT_EXTENSION_VERSION="0.31.4"
ENV PYLANCE_EXTENSION_VERSION="2025.8.3"

USER root

# Set the timezone
RUN ln -snf /usr/share/zoneinfo/$CONTAINER_TIMEZONE /etc/localtime && echo $CONTAINER_TIMEZONE > /etc/timezone

# Install system packages (external dependencies - cache early)
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    build-essential \
    libffi-dev \
    libssl-dev \
    libsecret-1-dev \
    libsecret-1-0 \
    pkg-config \
    jq \
    libxss1 \
    ca-certificates \
    gnupg \
    lsb-release \
    libevent-dev \
    libncurses-dev \
    bison \
    autoconf \
    automake \
    git

# Build and install tmux from git for latest features
RUN git clone https://github.com/tmux/tmux.git /tmp/tmux && \
    cd /tmp/tmux && \
    sh autogen.sh && \
    ./configure && \
    make && \
    make install && \
    rm -rf /tmp/tmux
RUN (type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
	&& sudo mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& sudo apt update \
	&& sudo apt install gh -y

COPY mob /usr/local/bin/mob
RUN chmod +x /usr/local/bin/mob

# Install Node.js 18 (required for MSAL)
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

# Install Caddy
RUN curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list && \
    apt-get update && \
    apt-get install -y caddy

# Install MSAL node extensions (external dependency - cache early)
RUN npm config set cache /tmp/.npm && \
    npm install -g @azure/msal-node-extensions && \
    rm -rf /tmp/.npm

# Download oauth2-proxy (external resource - cache early)
RUN LATEST_VERSION=$(curl -s https://api.github.com/repos/bitswan-space/bitswan-aoc-oauth2/releases/latest | jq -r '.tag_name') \
    && curl -L -o /usr/local/bin/oauth2-proxy https://github.com/bitswan-space/bitswan-aoc-oauth2/releases/download/${LATEST_VERSION}/oauth2-proxy-mqtt \
    && chmod +x /usr/local/bin/oauth2-proxy

# Download marketplace extensions (external resources - cache early)
RUN mkdir -p /home/coder/.local/share/code-server/extensions
RUN mkdir -p /opt/extensions
RUN chown -R coder:coder /home/coder/.local/share/code-server
RUN chown -R coder:coder /opt/extensions

RUN curl -L -o /opt/extensions/copilot.vsix.gz "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/GitHub/vsextensions/copilot/$COPILOT_EXTENSION_VERSION/vspackage" && \
    gunzip /opt/extensions/copilot.vsix.gz

RUN curl -L -o /opt/extensions/copilot-chat.vsix.gz "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/GitHub/vsextensions/copilot-chat/$COPILOT_CHAT_EXTENSION_VERSION/vspackage" && \
    gunzip /opt/extensions/copilot-chat.vsix.gz

RUN curl -L -o /opt/extensions/pylance.vsix.gz "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/vscode-pylance/$PYLANCE_EXTENSION_VERSION/vspackage" && \
    gunzip /opt/extensions/pylance.vsix.gz

RUN curl -L -o /opt/extensions/python.vsix.gz "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/python/$PYTHON_EXTENSION_VERSION/vspackage" && \
    gunzip /opt/extensions/python.vsix.gz

RUN curl -L -o /opt/extensions/jupyter.vsix.gz "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-toolsai/vsextensions/jupyter/$JUPYTER_EXTENSION_VERSION/vspackage" && \
    gunzip /opt/extensions/jupyter.vsix.gz

RUN chown -R coder:coder /opt/extensions

# Setup MSAL runtime (external dependency setup - cache early)
RUN mkdir -p /usr/lib/code-server/lib/vscode/extensions/microsoft-authentication/node_modules/@azure/msal-node-extensions
RUN chown -R coder:coder /usr/lib/code-server/lib/vscode/extensions
RUN ln -sf /usr/lib/node_modules/@azure/msal-node-extensions /usr/lib/code-server/lib/vscode/extensions/microsoft-authentication/node_modules/@azure/msal-node-extensions || true

# Create code-server configuration directory and add settings (static config - cache early)
RUN mkdir -p /home/coder/.config/code-server
RUN echo '{"extensions.supportNodeGlobalNavigator": false}' > /home/coder/.config/code-server/settings.json
RUN chown -R coder:coder /home/coder/.config

# Create directories for source code (cache early)
RUN mkdir -p /opt/bitswan-extension
RUN mkdir -p /opt/bitswan-frame
RUN chown -R coder:coder /opt/bitswan-extension
RUN chown -R coder:coder /opt/bitswan-frame
RUN chown -R coder:coder /home/coder

# Create /workspace directory for the new volume mount structure
RUN mkdir -p /workspace
RUN chown -R coder:coder /workspace

# ============================================
# Source code and build steps (copy late)
# ============================================

# Copy the built extension from the build stage (source code artifact)
COPY --from=extension_builder /build/bitswan-extension.vsix /opt/bitswan-extension/

# Copy scripts and configuration files (source code)
COPY update-entrypoint.sh /usr/bin/update-entrypoint.sh
RUN chmod +x /usr/bin/update-entrypoint.sh

COPY Caddyfile /etc/caddy/Caddyfile
RUN chmod 644 /etc/caddy/Caddyfile

# Copy frame files (source code)
COPY frame.html /opt/bitswan-frame/frame.html
COPY Extension/resources/bitswan-logo.png /opt/bitswan-frame/bitswan-logo.png
RUN chmod 644 /opt/bitswan-frame/frame.html /opt/bitswan-frame/bitswan-logo.png
RUN chown -R coder:coder /opt/bitswan-frame
RUN chown -R coder:coder /home/coder

USER coder

EXPOSE 9999

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/update-entrypoint.sh"]
