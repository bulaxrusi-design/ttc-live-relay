import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { safeTokenEqual } from "./protocol.mjs";

const pointFields = {
  space: z.enum(["frame", "display", "normalized"]).default("normalized"),
  frameId: z.number().int().nonnegative().optional(),
};

const actionSchema = z.union([
  z.object({ type: z.literal("tap"), x: z.number(), y: z.number(), afterMs: z.number().int().min(0).max(2000).optional(), ...pointFields }),
  z.object({ type: z.literal("swipe"), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), durationMs: z.number().int().min(50).max(2000).optional(), afterMs: z.number().int().min(0).max(2000).optional(), ...pointFields }),
  z.object({ type: z.literal("path"), points: z.array(z.object({ x: z.number(), y: z.number() })).min(2).max(64), durationMs: z.number().int().min(50).max(3000).optional(), afterMs: z.number().int().min(0).max(2000).optional(), ...pointFields }),
  z.object({ type: z.literal("back"), afterMs: z.number().int().min(0).max(2000).optional() }),
  z.object({ type: z.literal("wait"), durationMs: z.number().int().min(20).max(2000), afterMs: z.number().int().min(0).max(2000).optional() }),
]);

const ttcProfileSchema = z.object({
  mode: z.enum(["stage_change", "text_end", "manual"]).default("stage_change"),
  stageRegex: z.string().min(1).max(256).optional(),
  startRegex: z.string().min(1).max(256).optional(),
  endRegex: z.string().min(1).max(256).optional(),
  stableFrames: z.number().int().min(1).max(5).default(2),
  ocrEveryMs: z.number().int().min(100).max(2000).default(200),
});

export function createDeviceMcpServer(registry, autoplay, researchStore) {
  const server = new McpServer(
    { name: "device-lab-live", version: "3.0.0" },
    {
      instructions:
        "Use only exact locally allowlisted game packages. Call observe_game before actions. Use frameId for frame-space coordinates. Batch obvious taps. Never open stores, ads, installers, payments, permissions, settings, login, or external links. Stop if the foreground package changes.",
    },
  );

  server.registerTool("list_devices", {
    title: "List connected game devices",
    description: "Use this to find connected Android lab devices and their exact locally allowed game packages.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => result({ devices: registry.list() }));

  server.registerTool("observe_game", {
    title: "Observe game screen",
    description: "Use this immediately before acting. Returns the latest exact game frame, frameId, display geometry, foreground package, and device TTC status.",
    inputSchema: { deviceId: z.string().min(1).max(128).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ deviceId }) => {
    const device = registry.choose(deviceId);
    const frame = device.latestFrame;
    if (!frame) throw new Error("the selected device has not published a frame");
    const status = registry.publicStatus(device);
    return {
      content: [
        { type: "text", text: JSON.stringify(status, null, 2) },
        { type: "image", data: frame.jpeg.toString("base64"), mimeType: "image/jpeg" },
      ],
      structuredContent: status,
    };
  });

  server.registerTool("run_game_actions", {
    title: "Run a fast game action batch",
    description: "Use this to execute one or more taps/swipes/waits in the exact allowlisted foreground game. For screenshot coordinates set space=frame and pass the observed frameId.",
    inputSchema: {
      deviceId: z.string().min(1).max(128).optional(),
      expectedPackage: z.string().min(3).max(200),
      actions: z.array(actionSchema).min(1).max(120),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ deviceId, expectedPackage, actions }) => {
    const device = registry.choose(deviceId);
    const ack = await registry.sendActions(device.id, { expectedPackage, actions });
    return result({ ack, device: registry.publicStatus(device) });
  });

  server.registerTool("arm_ttc", {
    title: "Arm on-device TTC detector",
    description: "Use this before play. The phone timestamps stable stage/text transitions with its monotonic clock, independent of network and model latency.",
    inputSchema: {
      deviceId: z.string().min(1).max(128).optional(),
      expectedPackage: z.string().min(3).max(200),
      profile: ttcProfileSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ deviceId, expectedPackage, profile }) => {
    const device = registry.choose(deviceId);
    registry.assertPackage(device, expectedPackage);
    const ttcSessionId = randomUUID();
    const ack = await registry.sendCommand(device.id, { op: "arm_ttc", expectedPackage, profile, ttcSessionId });
    return result({ ttcSessionId, ack });
  });

  server.registerTool("mark_ttc", {
    title: "Mark TTC start or end",
    description: "Fallback for games without a detector profile. Device-side stage_change detection is more accurate and preferred.",
    inputSchema: {
      deviceId: z.string().min(1).max(128).optional(),
      expectedPackage: z.string().min(3).max(200),
      event: z.enum(["start", "end"]),
      label: z.string().max(128).optional(),
      ttcSessionId: z.string().uuid().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ deviceId, expectedPackage, event, label, ttcSessionId }) => {
    const device = registry.choose(deviceId);
    registry.assertPackage(device, expectedPackage);
    if (event === "end" && !ttcSessionId) throw new Error("ttcSessionId from the start marker is required for an end marker");
    const resolvedSessionId = ttcSessionId ?? randomUUID();
    const ack = await registry.sendCommand(device.id, {
      op: "mark_ttc",
      expectedPackage,
      event,
      label,
      ttcSessionId: resolvedSessionId,
      accuracy: "explicit_marker",
    });
    return result({ ttcSessionId: resolvedSessionId, ack });
  });

  server.registerTool("get_ttc_report", {
    title: "Get TTC session reports",
    description: "Use this to retrieve the ordered on-device level reports for a TTC session, including timestamps, TTC milliseconds, detector settings, and action counts.",
    inputSchema: {
      deviceId: z.string().min(1).max(128).optional(),
      ttcSessionId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ deviceId, ttcSessionId, limit }) => {
    const device = registry.choose(deviceId);
    await registry.sendCommand(device.id, { op: "get_ttc" });
    return result({
      deviceId: device.id,
      ttcSessionId: ttcSessionId ?? null,
      reports: registry.ttcReports(device.id, { ttcSessionId, limit }),
      detectorStatus: device.latestTtcStatus,
    });
  });

  server.registerTool("start_autoplay", {
    title: "Start autonomous game play",
    description: "Use this after observing and confirming the exact game package. Starts a bounded OpenAI Computer Use loop that batches actions over the low-latency device socket.",
    inputSchema: {
      deviceId: z.string().min(1).max(128).optional(),
      expectedPackage: z.string().min(3).max(200),
      objective: z.string().min(3).max(1500),
      maxSeconds: z.number().int().min(5).max(1800).default(300),
      maxTurns: z.number().int().min(1).max(300).default(80),
      ttcProfile: ttcProfileSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ deviceId, expectedPackage, objective, maxSeconds, maxTurns, ttcProfile }) => {
    const device = registry.choose(deviceId);
    const task = autoplay.start({ deviceId: device.id, packageName: expectedPackage, objective, maxSeconds, maxTurns, ttcProfile });
    return result(task);
  });

  server.registerTool("autoplay_status", {
    title: "Get autonomous play status",
    description: "Use this to inspect a running or completed autonomous play task without changing it.",
    inputSchema: { taskId: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ taskId }) => result(autoplay.status(taskId)));

  server.registerTool("stop_autoplay", {
    title: "Stop autonomous play",
    description: "Use this to stop a running autonomous game task immediately. It does not stop the Android bridge.",
    inputSchema: { taskId: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ taskId }) => result(autoplay.cancel(taskId)));

  server.registerTool("stop_device_agent", {
    title: "Stop Android game agent",
    description: "Emergency stop. Ends screen capture and rejects further gestures until the user restarts the phone app.",
    inputSchema: { deviceId: z.string().min(1).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ deviceId }) => {
    const device = registry.choose(deviceId);
    const ack = await registry.sendCommand(device.id, { op: "stop" });
    return result(ack);
  });

  server.registerTool("get_research_data", {
    title: "Get recorded game research data",
    description: "Returns persistent TTC, action, acknowledgement, latency, device, and autoplay events. Raw screen frames are never included.",
    inputSchema: {
      deviceId: z.string().min(1).max(128).optional(),
      ttcSessionId: z.string().uuid().optional(),
      sessionId: z.string().min(1).max(128).optional(),
      packageName: z.string().min(3).max(200).optional(),
      eventTypes: z.array(z.enum(["device", "status", "ttc", "command", "ack", "command_error", "autoplay"])).max(7).optional(),
      since: z.iso.datetime().optional(),
      until: z.iso.datetime().optional(),
      limit: z.number().int().min(1).max(1000).default(1000),
      format: z.enum(["json", "csv"]).default("json"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ format, ...filters }) => {
    const events = await researchStore.query(filters);
    if (format === "csv") {
      return {
        content: [{ type: "text", text: researchStore.toCsv(events) }],
        structuredContent: { format, count: events.length, schema: researchStore.status().schema },
      };
    }
    return result({ format, count: events.length, events });
  });

  return server;
}

export function mountMcp(app, { registry, autoplay, researchStore, bearerToken = "" }) {
  const transports = new Map();
  const authorize = (req, res, next) => {
    if (!bearerToken) return next();
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!safeTokenEqual(match?.[1] ?? "", bearerToken)) return res.status(401).json({ error: "unauthorized" });
    next();
  };

  app.post("/mcp", authorize, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport = sessionId ? transports.get(sessionId) : null;
      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => transports.set(id, transport),
          // Quick development tunnels do not reliably proxy long-lived SSE.
          // JSON responses keep request/response tools usable without a domain.
          enableJsonResponse: true,
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        const server = createDeviceMcpServer(registry, autoplay, researchStore);
        await server.connect(transport);
      } else if (!transport) {
        return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid MCP session" }, id: null });
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: error.message }, id: null });
    }
  });

  const existingTransport = (req, res) => {
    const transport = transports.get(req.headers["mcp-session-id"]);
    if (!transport) {
      res.status(400).send("Invalid or missing MCP session ID");
      return null;
    }
    return transport;
  };
  app.get("/mcp", authorize, async (req, res) => {
    const transport = existingTransport(req, res);
    if (transport) await transport.handleRequest(req, res);
  });
  app.delete("/mcp", authorize, async (req, res) => {
    const transport = existingTransport(req, res);
    if (transport) await transport.handleRequest(req, res);
  });
  return transports;
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
