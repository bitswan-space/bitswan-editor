#!/bin/bash
code-server --install-extension /tmp/extensions/bitswan-extension.vsix
code-server --install-extension /tmp/extensions/github-copilot.vsix
code-server --install-extension /tmp/extensions/pylance.vsix

cp -r /tmp/.bitswan /home/coder/workspace/.bitswan

exec "$@"