#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/.device-lab-live-v3"
SERVER_DIR="$SOURCE_DIR/server"
SERVER_PID_FILE="$STATE_DIR/server.pid"
TUNNEL_PID_FILE="$STATE_DIR/tunnel.pid"
SERVER_LOG="$STATE_DIR/server.log"
TUNNEL_LOG="$STATE_DIR/tunnel.log"
TOKEN_FILE="$STATE_DIR/device-token"
CONNECTION_FILE="$STATE_DIR/connection.txt"

mkdir -p "$STATE_DIR" "$STATE_DIR/data" "$STATE_DIR/cloudflared-home"
chmod 700 "$STATE_DIR"

stop_owned_process() {
  local pid_file="$1"
  local expected="$2"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(tr -cd '0-9' < "$pid_file")"
  if [[ -n "$pid" && -r "/proc/$pid/cmdline" ]]; then
    local command_line
    command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
    if [[ "$command_line" == *"$expected"* ]]; then
      kill "$pid" 2>/dev/null || true
      for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
  fi
  rm -f "$pid_file"
}

stop_owned_process "$TUNNEL_PID_FILE" "cloudflared"
stop_owned_process "$SERVER_PID_FILE" "src/index.mjs"

for command_name in node npm cloudflared curl; do
  command -v "$command_name" >/dev/null || {
    echo "Missing $command_name. Run scripts/termux-install.sh first."
    exit 1
  }
done

cd "$SERVER_DIR"
npm ci --omit=dev

if [[ "${1:-}" == "--rotate-token" ]]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$TOKEN_FILE"
fi
if [[ ! -s "$TOKEN_FILE" ]]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
DEVICE_TOKEN="$(tr -d '\r\n[:space:]' < "$TOKEN_FILE")"
if [[ ! "$DEVICE_TOKEN" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Stored device token is invalid: $TOKEN_FILE"
  exit 1
fi

: > "$SERVER_LOG"
nohup env \
  HOST=127.0.0.1 \
  PORT=8787 \
  DEVICE_ENROLLMENT_TOKEN="$DEVICE_TOKEN" \
  MCP_BEARER_TOKEN= \
  RECORD_RESEARCH_DATA=true \
  DATA_DIR="$STATE_DIR/data" \
  node src/index.mjs > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$SERVER_PID_FILE"

server_ready=false
for _ in {1..60}; do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then
    server_ready=true
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Relay stopped during startup:"
    tail -n 40 "$SERVER_LOG"
    exit 1
  fi
  sleep 0.5
done
if [[ "$server_ready" != true ]]; then
  echo "Relay did not become ready. Log: $SERVER_LOG"
  exit 1
fi

: > "$TUNNEL_LOG"
nohup env HOME="$STATE_DIR/cloudflared-home" \
  cloudflared tunnel --url http://127.0.0.1:8787 > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
printf '%s\n' "$TUNNEL_PID" > "$TUNNEL_PID_FILE"

PUBLIC_URL=""
for _ in {1..120}; do
  PUBLIC_URL="$(grep -Eo 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "Tunnel stopped during startup:"
    tail -n 60 "$TUNNEL_LOG"
    exit 1
  fi
  sleep 0.5
done
if [[ -z "$PUBLIC_URL" ]]; then
  echo "Tunnel URL was not created. Log: $TUNNEL_LOG"
  exit 1
fi

PUBLIC_HOST="${PUBLIC_URL#https://}"
cat > "$CONNECTION_FILE" <<EOF
DEVICE_ID=leave the existing android-... value
RELAY_URL=wss://$PUBLIC_HOST/device
DEVICE_ENROLLMENT_TOKEN=$DEVICE_TOKEN
ALLOWED_GAME_PACKAGE=com.easybrain.number.puzzle.game
MCP_URL=https://$PUBLIC_HOST/mcp
MCP_AUTHENTICATION=No Authentication
EOF
chmod 600 "$CONNECTION_FILE"

command -v termux-wake-lock >/dev/null && termux-wake-lock || true

echo
echo "========== COPY THESE VALUES =========="
cat "$CONNECTION_FILE"
echo "======================================="
echo
echo "Keep Termux running. Do not share the token or tunnel URL."
echo "Show values: bash $SOURCE_DIR/scripts/termux-status.sh"
echo "Stop relay:  bash $SOURCE_DIR/scripts/termux-stop.sh"
