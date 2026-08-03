#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

STATE_DIR="$HOME/.device-lab-live-v3"
CONNECTION_FILE="$STATE_DIR/connection.txt"

if [[ ! -s "$CONNECTION_FILE" ]]; then
  echo "No active setup. Run ~/device-lab-live-v3/scripts/termux-quickstart.sh"
  exit 1
fi

echo "========== CONNECTION VALUES =========="
cat "$CONNECTION_FILE"
echo "======================================="
if curl -fsS http://127.0.0.1:8787/health; then
  echo
  echo "Local relay: healthy"
else
  echo
  echo "Local relay: stopped or unhealthy"
  exit 1
fi
