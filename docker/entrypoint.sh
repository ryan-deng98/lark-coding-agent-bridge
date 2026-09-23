#!/bin/sh
# Container entrypoint: run the supervisor + web console on the mounted volume.
set -eu

if [ -z "${LARK_CHANNEL_KEYSTORE_SECRET:-}" ]; then
  echo "LARK_CHANNEL_KEYSTORE_SECRET is not set. Set it once to a random value" >&2
  echo "(openssl rand -hex 32) and keep it: it encrypts the bots' secrets on the volume." >&2
  exit 1
fi

# Platforms (Railway included) hand the listening port in via $PORT, and
# Railway its public domain via $RAILWAY_PUBLIC_DOMAIN (the console's Host).
export LARK_CHANNEL_UI_PORT="${LARK_CHANNEL_UI_PORT:-${PORT:-8080}}"
export LARK_CHANNEL_UI_ALLOWED_HOSTS="${LARK_CHANNEL_UI_ALLOWED_HOSTS:-${RAILWAY_PUBLIC_DOMAIN:-}}"

mkdir -p "$LARK_CHANNEL_HOME"

# One container mounts the volume at a time (Railway stops the old deployment
# before starting the next when a volume is attached), so locks and process
# registry entries found here belong to a container that is gone. Their PIDs
# can match live processes in this one, which would block every bot: drop them.
rm -rf "$LARK_CHANNEL_HOME/registry/locks" "$LARK_CHANNEL_HOME/registry/processes.json"

exec node /app/bin/lark-channel-bridge.mjs run --web-ui "$@"
