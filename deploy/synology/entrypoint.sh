#!/bin/sh
set -eu
# Only the dedicated Jorik data mount is writable. The app runs as node.
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data
  exec gosu node "$@"
fi
exec "$@"
