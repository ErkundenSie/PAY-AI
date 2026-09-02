#!/bin/sh
set -e
if [ ! -f /app/node_modules/express/package.json ]; then
  echo "[boot] seeding Linux node_modules"
  mkdir -p /app/node_modules
  cp -a /opt/node_modules/. /app/node_modules/
fi
exec "$@"
