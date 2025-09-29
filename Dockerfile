FROM --platform=linux/amd64 codercom/code-server:4.95.3-ubuntu

ENV VENV_PATH=/tmp/.bitswan

USER root

# Set the timezone
RUN ln -snf /usr/share/zoneinfo/$CONTAINER_TIMEZONE /etc/localtime && echo $CONTAINER_TIMEZONE > /etc/timezone

RUN apt-get update && apt-get install -y \
    software-properties-common \
    jq \
    wget \
    curl

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

# Download oauth2-proxy from GitHub releases
RUN LATEST_TAG=$(curl -s https://github.com/bitswan-space/bitswan-aoc-oauth2/releases | jq -r .tag_name) && \
    wget -O /usr/local/bin/oauth2-proxy \
    "https://github.com/bitswan-space/bitswan-aoc-oauth2/releases/download/${LATEST_TAG}/oauth2-proxy-mqtt" && \
    chmod +x /usr/local/bin/oauth2-proxy


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

COPY update-entrypoint.sh /usr/bin/update-entrypoint.sh
RUN chmod +x /usr/bin/update-entrypoint.sh

USER coder

EXPOSE 9999

WORKDIR /home/coder/workspace
ENTRYPOINT ["/usr/bin/update-entrypoint.sh", "/usr/bin/entrypoint.sh", "--bind-addr", "0.0.0.0:9999", "."]
