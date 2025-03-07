FROM --platform=linux/amd64 codercom/code-server:4.95.3-ubuntu

ENV VENV_PATH=/tmp/.bitswan

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
RUN echo "export PYTHONPATH=/home/coder/workspace/workspace/bitswan_lib:${PYTHONPATH}" >> ${VENV_PATH}/bin/activate

RUN . ${VENV_PATH}/bin/activate && \
    pip install --upgrade pip

# Install Python packages
COPY requirements.txt /tmp/requirements.txt
RUN . ${VENV_PATH}/bin/activate && \
    pip install -r /tmp/requirements.txt

# Install VSCode extensions
RUN mkdir -p /tmp/extensions

# Download GitHub Copilot extension
ENV GITHUB_COPILOT_VERSION=1.246.1243
RUN curl -L -o /tmp/extensions/github-copilot.vsix.gz \
            https://marketplace.visualstudio.com/_apis/public/gallery/publishers/GitHub/vsextensions/copilot/${GITHUB_COPILOT_VERSION}/vspackage && gunzip /tmp/extensions/github-copilot.vsix.gz

# Download Pylance extension
ENV PYLANCE_VERSION=2024.11.102
RUN curl -L -o /tmp/extensions/pylance.vsix.gz \
                https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/vscode-pylance/${PYLANCE_VERSION}/vspackage && gunzip /tmp/extensions/pylance.vsix.gz

# Download Bitswan extension
RUN curl -L -o /tmp/extensions/bitswan-extension.vsix \
            https://bitswan-vscode-extension.s3.eu-north-1.amazonaws.com/bitswan-pre-0.0.5.vsix


ENV EXTENSIONS_DIR=/home/coder/.local/share/code-server/extensions
RUN mkdir -p ${EXTENSIONS_DIR} && \
    chown -R coder:coder /home/coder/.local && \
    chown -R coder:coder /tmp/extensions/ && \
    chown -R coder:coder ${EXTENSIONS_DIR} && \ 
    chown -R coder:coder /tmp/.bitswan

COPY update-entrypoint.sh /usr/bin/update-entrypoint.sh
RUN chmod +x /usr/bin/update-entrypoint.sh

USER coder

RUN code-server --install-extension ms-python.python
RUN code-server --install-extension ms-toolsai.jupyter

EXPOSE 9999

WORKDIR /home/coder/workspace
RUN rm /home/coder/.config/code-server/config.yaml # This is important to clear the password so that every instance doesn't have the samepassword
ENTRYPOINT ["/usr/bin/update-entrypoint.sh", "/usr/bin/entrypoint.sh", "--bind-addr", "0.0.0.0:9999", "."]
