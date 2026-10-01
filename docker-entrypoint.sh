#!/bin/sh
# Devin Gateway container entrypoint.
#
# Runs as root just long enough to fix ownership of the bind-mounted logs
# directory (the host mount overrides image perms), then drops to the
# unprivileged `gateway` user before exec'ing bun.
set -e

LOG_DIR="${LOG_FILE%/*}"
# Default when LOG_FILE is unset/empty.
[ -z "$LOG_DIR" ] && LOG_DIR="/app/logs"

mkdir -p "$LOG_DIR" "$LOG_DIR/errors" 2>/dev/null || true
chown -R gateway:gateway "$LOG_DIR" 2>/dev/null || true

# Settings have a separate named volume and lifecycle from Devin authentication.
# Its root can be root-owned when Docker first creates the volume.
SETTINGS_DIR="${DEVIN_GATEWAY_SETTINGS_DIR:-/home/gateway/.devin-gateway-settings}"
AUTH_DIR="${DEVIN_GATEWAY_CONFIG_DIR:-/home/gateway/.devin-gateway}"
# Validate lexical form before any ownership/permission operation.
case "$SETTINGS_DIR" in /) echo "Settings directory cannot be the filesystem root." >&2; exit 1 ;; /*) ;; *) echo "Settings directory must be absolute." >&2; exit 1 ;; esac
case "$SETTINGS_DIR/" in *"/../"*|*"/./"*|*"//"*) echo "Settings directory must use a canonical path." >&2; exit 1 ;; esac
[ "$SETTINGS_DIR" != "$AUTH_DIR" ] || { echo "Settings and auth directories must be separate." >&2; exit 1; }
case "$SETTINGS_DIR/" in "$AUTH_DIR/"*) echo "Settings must not be inside auth storage." >&2; exit 1 ;; esac
case "$AUTH_DIR/" in "$SETTINGS_DIR/"*) echo "Auth must not be inside settings storage." >&2; exit 1 ;; esac
[ ! -L "$SETTINGS_DIR" ] || { echo "Settings directory must not be a symlink." >&2; exit 1; }
mkdir -p "$SETTINGS_DIR"
chown gateway:gateway "$SETTINGS_DIR"
chmod 700 "$SETTINGS_DIR"

exec su-exec gateway bun run src/index.ts
