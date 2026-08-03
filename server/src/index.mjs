import process from "node:process";
import http from "node:http";
import express from "express";
import { DeviceRegistry } from "./registry.mjs";
import { attachDeviceSocket } from "./device-socket.mjs";
import { AutoplayManager } from "./autoplay.mjs";
import { mountMcp } from "./mcp.mjs";
import { ResearchStore } from "./research-store.mjs";

try {
  process.loadEnvFile?.();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const host = process.env.HOST || "127.0.0.1";
const port = integerEnv("PORT", 8787, 1, 65535);
const enrollmentToken = process.env.DEVICE_ENROLLMENT_TOKEN || "";
if (enrollmentToken.length < 32 || enrollmentToken.length > 512 || /\s/.test(enrollmentToken)) {
  throw new Error("DEVICE_ENROLLMENT_TOKEN must contain 32..512 non-space characters");
}
const mcpBearerToken = process.env.MCP_BEARER_TOKEN || "";
if (mcpBearerToken && (mcpBearerToken.length < 32 || mcpBearerToken.length > 512 || /\s/.test(mcpBearerToken))) {
  throw new Error("MCP_BEARER_TOKEN must be empty or contain 32..512 non-space characters");
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const researchStore = new ResearchStore({
  dataDir: process.env.DATA_DIR || "data",
  enabled: booleanEnv("RECORD_RESEARCH_DATA", true),
});
await researchStore.init();

const registry = new DeviceRegistry({
  commandTimeoutMs: integerEnv("COMMAND_TIMEOUT_MS", 30_000, 1000, 30_000),
  sourceFrameMaxAgeMs: integerEnv("SOURCE_FRAME_MAX_AGE_MS", 15_000, 1000, 30_000),
});
const autoplay = new AutoplayManager(registry, {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || "gpt-5.6",
  frameWaitMs: integerEnv("FRAME_WAIT_MS", 5000, 500, 30_000),
});
for (const eventType of ["device", "status", "ttc", "command", "ack", "command_error"]) {
  registry.on(eventType, (event) => recordResearchEvent(eventType, event));
}
autoplay.on("autoplay", (event) => recordResearchEvent("autoplay", event));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    protocol: 3,
    devices: registry.list().length,
    autonomousPlay: Boolean(process.env.OPENAI_API_KEY),
    researchRecording: researchStore.status(),
  });
});
app.get("/", (_req, res) => {
  res.type("text/plain").send("Device Lab Live v3\nMCP: /mcp\nAndroid WebSocket: /device\n");
});
mountMcp(app, { registry, autoplay, researchStore, bearerToken: mcpBearerToken });

const server = http.createServer(app);
attachDeviceSocket(server, registry, { enrollmentToken });
server.listen(port, host, () => {
  console.log(`Device Lab Live v3 listening on http://${host}:${port}`);
});

const shutdown = () => {
  server.close(() => {
    void researchStore.flush()
      .catch((error) => console.error(`research flush failed: ${error.message}`))
      .finally(() => process.exit(0));
  });
  setTimeout(() => {
    void researchStore.flush()
      .catch((error) => console.error(`research flush failed: ${error.message}`))
      .finally(() => process.exit(1));
  }, 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function integerEnv(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function booleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function recordResearchEvent(eventType, event) {
  void researchStore.record(eventType, event).catch((error) => {
    console.error(`research record failed: ${error.message}`);
  });
}
