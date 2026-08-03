#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

SOURCE_DIR="$HOME/device-lab-live-v3"
REPOSITORY="https://github.com/bulaxrusi-design/ttc-live-relay.git"
BRANCH="device-lab-live-v3"

pkg update -y
pkg install -y git nodejs cloudflared curl

if [[ -d "$SOURCE_DIR/.git" ]]; then
  git -C "$SOURCE_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPOSITORY" "$SOURCE_DIR"
fi

exec bash "$SOURCE_DIR/scripts/termux-quickstart.sh"
