FROM --platform=linux/amd64 codercom/code-server:4.93.1-ubuntu

ENV VENV_PATH=/home/coder/workspace/.bitswan

USER root

# Set the timezone
RUN ln -snf /usr/share/zoneinfo/$CONTAINER_TIMEZONE /etc/localtime && echo $CONTAINER_TIMEZONE > /etc/timezone

RUN apt-get update && apt-get install -y \
    software-properties-common

RUN add-apt-repository 'ppa:deadsnakes/ppa' && \
    apt-get update

# Install Python and development tools
RUN apt-get install -y \
    gcc \
    libffi-dev \ 
    python3.10 \
    python3.10-venv \
    python3.10-dev \
    python3.10-distutils \
    autoconf \
    automake \
    libtool \
    make \
    libssl-dev \
    build-essential \
    python-lxml

# Create python3 symlink
RUN ln -s -f /usr/bin/python3.10 /usr/bin/python3

# Create a virtual environment
RUN python3 -m venv ${VENV_PATH} && \
    chown -R coder:coder ${VENV_PATH}

RUN . ${VENV_PATH}/bin/activate && \
    pip install --upgrade pip

# Install Python packages
COPY requirements.txt /tmp/requirements.txt
RUN . ${VENV_PATH}/bin/activate && \
    pip install -r /tmp/requirements.txt

# Install VSCode extensions
RUN mkdir -p /extensions

# Download GitHub Copilot extension
ENV GITHUB_COPILOT_VERSION=1.235.1136
RUN curl -L -o /extensions/github-copilot.vsix.gz \
            https://marketplace.visualstudio.com/_apis/public/gallery/publishers/GitHub/vsextensions/copilot/${GITHUB_COPILOT_VERSION}/vspackage && gunzip /extensions/github-copilot.vsix.gz

# Download Pylance extension
ENV PYLANCE_VERSION=2024.9.103
RUN curl -L -o /extensions/pylance.vsix.gz \
                https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/vscode-pylance/${PYLANCE_VERSION}/vspackage && gunzip /extensions/pylance.vsix.gz

# Download Bitswan extension
RUN curl -L -o /extensions/bitswan-extension.vsix \
            https://bitswan-vscode-extension.s3.eu-north-1.amazonaws.com/bitswan-pre-0.0.2.vsix


ENV EXTENSIONS_DIR=/home/coder/.local/share/code-server/extensions
RUN mkdir -p ${EXTENSIONS_DIR} && \
    chown -R coder:coder /home/coder/.local && \
    chown -R coder:coder /extensions/ && \
    chown -R coder:coder /home/coder/workspace

USER coder

RUN code-server --install-extension ms-python.python
RUN code-server --install-extension ms-toolsai.jupyter

RUN code-server --install-extension /extensions/bitswan-extension.vsix
RUN code-server --install-extension /extensions/github-copilot.vsix
RUN code-server --install-extension /extensions/pylance.vsix

RUN sudo rm -rf /extensions

EXPOSE 8080

WORKDIR /home/coder/workspace
ENTRYPOINT ["/usr/bin/entrypoint.sh", "--bind-addr", "0.0.0.0:8080", "."]