#!/bin/sh
export GIT_AUTHOR_NAME=$HOSTNAME
export GIT_AUTHOR_EMAIL="$HOSTNAME@example.com"
exec /usr/bin/git "$@"
