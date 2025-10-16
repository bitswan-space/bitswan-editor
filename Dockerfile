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

USER root

# Set the timezone
RUN ln -snf /usr/share/zoneinfo/$CONTAINER_TIMEZONE /etc/localtime && echo $CONTAINER_TIMEZONE > /etc/timezone

RUN mkdir -p /opt/uv/python && chmod -R 755 /opt/uv

RUN apt-get update && apt-get install -y \
    jq \
    curl \
    unzip

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

COPY update-entrypoint.sh /usr/bin/update-entrypoint.sh
RUN chmod +x /usr/bin/update-entrypoint.sh

USER coder

EXPOSE 9999

WORKDIR /home/coder/workspace
ENTRYPOINT ["/usr/bin/update-entrypoint.sh", "/usr/bin/entrypoint.sh", "--bind-addr", "0.0.0.0:9999", "."]
