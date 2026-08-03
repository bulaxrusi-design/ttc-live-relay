# Setup

## 1. Relay host

Use a nearby workstation or controlled VPS. A nearby host lowers frame/action
network latency; TTC itself remains device-timestamped either way.

```bash
cd server
cp .env.example .env
```

Generate a random device token locally and put it in `.env`. Do not paste it into
chat or commit it. Add `OPENAI_API_KEY` only if `start_autoplay` should run the
autonomous Computer Use loop.

```bash
npm ci
npm test
npm start
```

Production requires TLS. Put the service behind a reverse proxy so the Android URL
is `wss://host/device` and the MCP URL is `https://host/mcp`. For a private MCP
server, prefer OpenAI Secure MCP Tunnel; the Android WSS path must still be
reachable from the phone. Keep the MCP listener private unless a compatible
authentication layer is in front of it. `MCP_BEARER_TOKEN` is intended for clients
that can send a fixed Authorization header; Secure MCP Tunnel can provide the
outer account-bound boundary instead.

### No-domain Termux test

For a short lab test on the Android phone itself, run the public repository's
`scripts/termux-install.sh` in Termux. It installs Node.js and `cloudflared`, starts
the relay on localhost, creates a temporary `trycloudflare.com` development
tunnel, and prints the exact Android and ChatGPT values. Keep Termux running.

This is intentionally a development path: the random URL changes when the tunnel
restarts, and the MCP endpoint uses ChatGPT's `No Authentication` mode. Treat the
URL like a secret and replace this setup with a stable authenticated host for
extended research.

## 2. Android

Install the debug APK artifact from the `Device Lab Live v3` workflow. In the app:

1. enter a stable device ID;
2. enter the exact `wss://.../device` URL;
3. enter the device enrollment token;
4. enter one exact game package per line;
5. save;
6. enable only `Device Lab Live game gestures` in Accessibility settings;
7. start screen capture and choose the full/default display if the OS presents a
   capture-region choice;
8. leave the exact allowlisted game in the foreground.

Debug builds permit `ws://` for a controlled LAN test. Release builds require TLS.

## 3. Connect this ChatGPT account

In ChatGPT web, enable Developer mode under Settings → Security and login. Create a
developer-mode app for the relay's streaming HTTP MCP URL, then select that app in
the conversation. Private installations can point ChatGPT at a Secure MCP Tunnel
endpoint instead of exposing the MCP server publicly.

This authorizes the current ChatGPT account to call the MCP tools. Continuous
autonomous play is a server-side Computer Use session and additionally requires an
OpenAI Platform API key and API billing; ChatGPT login is not an API credential.

The primary tools are:

- `observe_game`
- `run_game_actions`
- `arm_ttc`
- `get_ttc_report`
- `start_autoplay`
- `autoplay_status`
- `stop_autoplay`
- `stop_device_agent`
- `get_research_data`

## 4. Game TTC profiles

For a game that renders a readable stage number, arm:

```json
{
  "mode": "stage_change",
  "stageRegex": "(?i)Stage\\s*(\\d+)",
  "endRegex": "(?i)complete|level cleared|you win",
  "stableFrames": 2,
  "ocrEveryMs": 200
}
```

For a completion phrase:

```json
{
  "mode": "text_end",
  "startRegex": "(?i)play|start|stage",
  "endRegex": "(?i)complete|level cleared|you win",
  "stableFrames": 2,
  "ocrEveryMs": 200
}
```

Profiles affect detection only. They cannot expand the phone's local package
allowlist.

## 5. Research output

`get_ttc_report` returns monotonic start/end values as strings (to preserve 64-bit
precision), `ttcMs`, wall-time metadata, stage labels, frame IDs, action count, and
detector mode/accuracy. Filter by the `ttcSessionId` returned by `arm_ttc` or
`start_autoplay` to retrieve the complete ordered level series. Store inference
latency and WebSocket RTT as separate columns;
do not subtract them from or merge them into the device TTC source of truth.

`RECORD_RESEARCH_DATA=true` writes metadata events to
`DATA_DIR/research-events.jsonl`. The Docker configuration uses a persistent named
volume. No JPEG or screen recording is written. Call `get_research_data` with a
`ttcSessionId` and `format: "csv"` to export one measured run.
