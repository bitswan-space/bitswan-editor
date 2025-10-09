FROM quay.io/oauth2-proxy/oauth2-proxy:v7.9.0 AS proxy_builder


FROM --platform=linux/amd64 ghcr.io/astral-sh/uv:latest AS uvbin

FROM --platform=linux/amd64 codercom/code-server:4.104.3-ubuntu

ENV VENV_PATH=/tmp/.bitswan
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python

USER root

# Set the timezone
RUN ln -snf /usr/share/zoneinfo/$CONTAINER_TIMEZONE /etc/localtime && echo $CONTAINER_TIMEZONE > /etc/timezone

RUN mkdir -p /opt/uv/python && chmod -R 755 /opt/uv

RUN apt-get update && apt-get install -y \
    jq

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
COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --python ${VENV_PATH}/bin/python -r /tmp/requirements.txt

COPY update-entrypoint.sh /usr/bin/update-entrypoint.sh
RUN chmod +x /usr/bin/update-entrypoint.sh

USER coder

EXPOSE 9999

WORKDIR /home/coder/workspace
ENTRYPOINT ["/usr/bin/update-entrypoint.sh", "/usr/bin/entrypoint.sh", "--bind-addr", "0.0.0.0:9999", "."]
