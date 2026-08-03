import { WebSocketServer } from "ws";
import { decodeFrameEnvelope, MAX_FRAME_BYTES, MAX_TEXT_BYTES, safeTokenEqual } from "./protocol.mjs";

export function attachDeviceSocket(httpServer, registry, { enrollmentToken }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/device") {
      socket.destroy();
      return;
    }
    const token = bearer(request.headers.authorization);
    if (!safeTokenEqual(token, enrollmentToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    let deviceId = null;
    let initialized = false;
    ws.isAlive = true;
    const helloTimer = setTimeout(() => ws.close(4000, "hello timeout"), 5000);

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (data, isBinary) => {
      try {
        if (!isBinary && data.length > MAX_TEXT_BYTES) throw new Error("text message exceeds limit");
        if (!initialized) {
          if (isBinary) throw new Error("first message must be JSON hello");
          const hello = JSON.parse(data.toString("utf8"));
          const device = registry.attach(ws, hello);
          deviceId = device.id;
          initialized = true;
          clearTimeout(helloTimer);
          ws.send(JSON.stringify({ type: "hello_ack", protocol: 3, serverWallTimeMs: Date.now() }));
          return;
        }
        if (isBinary) registry.handleFrame(deviceId, decodeFrameEnvelope(data));
        else registry.handleText(deviceId, data.toString("utf8"));
      } catch (error) {
        ws.send(JSON.stringify({ type: "protocol_error", error: error.message }));
        ws.close(4002, initialized ? "protocol error" : "invalid hello");
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (deviceId) registry.detach(deviceId, ws);
    });
  });

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 10_000);
  pingTimer.unref();
  wss.on("close", () => clearInterval(pingTimer));
  return wss;
}

function bearer(header) {
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? "";
}
