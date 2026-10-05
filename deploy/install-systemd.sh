#!/usr/bin/env bash
# Install the watcher as a systemd service for the current user and directory.
#   ./deploy/install-systemd.sh          install, enable at boot, start
#   ./deploy/install-systemd.sh remove   stop and remove
set -euo pipefail

SERVICE=x-watcher
UNIT=/etc/systemd/system/${SERVICE}.service
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "remove" ]]; then
  sudo systemctl disable --now "$SERVICE" 2>/dev/null || true
  sudo rm -f "$UNIT"
  sudo systemctl daemon-reload
  echo "Removed $SERVICE."
  exit 0
fi

NODE_BIN="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
[[ -f "$APP_DIR/dist/daemon.js" ]] || { echo "dist/daemon.js not found; run 'npm run build' first" >&2; exit 1; }
[[ -f "$APP_DIR/.env" ]] || { echo ".env not found in $APP_DIR" >&2; exit 1; }

sed -e "s|__USER__|$(id -un)|" -e "s|__APP_DIR__|$APP_DIR|" -e "s|__NODE__|$NODE_BIN|" \
  "$APP_DIR/deploy/watcher.service" | sudo tee "$UNIT" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE"
echo "Installed and started $SERVICE. Logs: journalctl -u $SERVICE -f"
