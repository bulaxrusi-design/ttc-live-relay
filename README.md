# Device Lab Live v3

Low-latency Android game control and on-device Time to Complete (TTC)
measurement for authorized fraud-research sessions.

The old GitHub Contents relay and snapshot branches are removed. v3 uses:

- a persistent WebSocket between the Android device and the relay;
- an MCP server that exposes controlled game tools to ChatGPT/Codex;
- an optional OpenAI Computer Use loop for autonomous play;
- device-side monotonic timestamps and stable OCR/accessibility detectors;
- rotation-safe frame mapping plus a bounded recent-frame metadata history;
- persistent JSONL research events with filtered JSON/CSV export;
- an exact, user-managed package allowlist and a permanent STOP control.

## Layout

- `android-agent/` — Android app, screen capture, accessibility gestures, TTC clock.
- `server/` — WebSocket relay, MCP tools, autonomous Computer Use loop.
- `plugins/device-lab-live/` — local Codex plugin package for the MCP server.
- `protocol/` — wire protocol and timing semantics.
- `docs/` — architecture, security model, and deployment instructions.

## Local server

```bash
cd server
cp .env.example .env
npm install
npm test
npm start
```

Never put `OPENAI_API_KEY`, `DEVICE_ENROLLMENT_TOKEN`, or MCP credentials in the
APK, source control, screenshots, or chat messages.

By default, `server/data/research-events.jsonl` records TTC reports, action batches,
ACK/latency metrics, device state, and autoplay lifecycle events. It never records
raw screen frames. Query or export it through the `get_research_data` MCP tool.

## Android build

The repository workflow builds a debug APK on GitHub Actions. A local build needs
JDK 17, Android SDK 35, and Gradle 8.11+:

```bash
gradle -p android-agent :app:assembleDebug
```

See `docs/SETUP.md` after the first successful build.

Existing v2 users should follow `docs/MIGRATION_FROM_V2.md`, especially the old
GitHub-token revocation and accessibility-service cleanup steps.
