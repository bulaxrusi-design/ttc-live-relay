#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

STATE_DIR="$HOME/.device-lab-live-v3"

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
    fi
  fi
  rm -f "$pid_file"
}

stop_owned_process "$STATE_DIR/tunnel.pid" "cloudflared"
stop_owned_process "$STATE_DIR/server.pid" "src/index.mjs"
command -v termux-wake-unlock >/dev/null && termux-wake-unlock || true
echo "Device Lab Live relay and tunnel stopped."
