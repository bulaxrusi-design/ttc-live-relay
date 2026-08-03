import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  isBlockedPackage,
  mapFramePointToDisplay,
  validateActions,
  validateFrameHeader,
  validateHello,
} from "./protocol.mjs";

export class DeviceRegistry extends EventEmitter {
  constructor({ commandTimeoutMs = 30_000, sourceFrameMaxAgeMs = 15_000, frameHistorySize = 300 } = {}) {
    super();
    this.commandTimeoutMs = commandTimeoutMs;
    this.sourceFrameMaxAgeMs = sourceFrameMaxAgeMs;
    this.frameHistorySize = frameHistorySize;
    this.sequence = 0;
    this.devices = new Map();
    this.ttcArchive = new Map();
  }

  attach(ws, rawHello) {
    const hello = validateHello(rawHello);
    const prior = this.devices.get(hello.deviceId);
    if (prior && prior.ws?.readyState === 1) {
      prior.ws.close(4001, "superseded by a new connection");
    }
    const ttcHistory = this.ttcArchive.get(hello.deviceId) ?? [];
    this.ttcArchive.set(hello.deviceId, ttcHistory);
    const device = {
      id: hello.deviceId,
      ws,
      hello,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      latestFrame: null,
      latestStatus: null,
      latestTtcReport: ttcHistory.at(-1) ?? null,
      latestTtcStatus: null,
      ttcHistory,
      frameHistory: new Map(),
      pending: new Map(),
    };
    this.devices.set(device.id, device);
    this.emit("device", { type: "connected", deviceId: device.id });
    return device;
  }

  detach(deviceId, ws) {
    const device = this.devices.get(deviceId);
    if (!device || device.ws !== ws) return;
    for (const pending of device.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("device disconnected"));
    }
    device.pending.clear();
    this.devices.delete(deviceId);
    this.emit("device", { type: "disconnected", deviceId });
  }

  handleText(deviceId, raw) {
    const device = this.requireDevice(deviceId);
    const message = typeof raw === "string" ? JSON.parse(raw) : raw;
    device.lastSeenAt = Date.now();
    if (message.type === "ack" && typeof message.id === "string") {
      const pending = device.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        device.pending.delete(message.id);
        const ack = { ...message, serverRoundTripMs: Date.now() - pending.sentAt };
        this.emit("ack", { deviceId, command: pending.command, ack });
        if (message.ok) pending.resolve(ack);
        else pending.reject(new Error(message.error || "device rejected command"));
      }
    } else if (message.type === "status") {
      device.latestStatus = { ...message, _sequence: ++this.sequence };
      this.emit("status", { deviceId, status: message });
    } else if (message.type === "ttc_report") {
      const report = message.report ?? message;
      if (report?.type === "ttc") {
        const checkedReport = validateTtcReport(report, device);
        device.latestTtcReport = checkedReport;
        device.ttcHistory.push(checkedReport);
        if (device.ttcHistory.length > 5000) device.ttcHistory.splice(0, device.ttcHistory.length - 5000);
        this.emit("ttc", { deviceId, report: checkedReport });
      } else {
        device.latestTtcStatus = report;
      }
    } else if (message.type === "pong") {
      device.lastSeenAt = Date.now();
    }
    return message;
  }

  handleFrame(deviceId, frame) {
    const device = this.requireDevice(deviceId);
    validateFrameHeader(frame.header, deviceId);
    if (device.latestFrame && frame.header.frameId <= device.latestFrame.header.frameId) {
      return false;
    }
    device.lastSeenAt = Date.now();
    const receivedAt = Date.now();
    const sequence = ++this.sequence;
    device.latestFrame = { ...frame, receivedAt, sequence };
    device.frameHistory.set(frame.header.frameId, { header: frame.header, receivedAt, sequence });
    this.pruneFrameHistory(device, receivedAt);
    this.emit("frame", { deviceId, frameId: frame.header.frameId });
    return true;
  }

  list() {
    return [...this.devices.values()].map((device) => this.publicStatus(device));
  }

  choose(deviceId) {
    if (deviceId) return this.requireDevice(deviceId);
    const connected = [...this.devices.values()];
    if (connected.length !== 1) {
      throw new Error(connected.length === 0 ? "no device is connected" : "deviceId is required when multiple devices are connected");
    }
    return connected[0];
  }

  requireDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`device is not connected: ${deviceId}`);
    return device;
  }

  publicStatus(device) {
    const frame = device.latestFrame?.header;
    const foregroundPackage = this.currentForegroundPackage(device);
    return {
      deviceId: device.id,
      connected: true,
      connectedAt: new Date(device.connectedAt).toISOString(),
      lastSeenAt: new Date(device.lastSeenAt).toISOString(),
      allowedPackages: device.hello.allowedPackages,
      capabilities: device.hello.capabilities,
      display: frame ? { width: frame.displayWidth, height: frame.displayHeight, rotation: frame.rotation } : device.hello.display,
      foregroundPackage,
      frameId: frame?.frameId ?? null,
      frameCapturedMonoNs: frame?.capturedMonoNs ?? null,
      frameAgeMs: device.latestFrame ? Date.now() - device.latestFrame.receivedAt : null,
      ttc: device.latestTtcReport ?? device.latestTtcStatus,
    };
  }

  async sendActions(deviceId, { expectedPackage, actions, sessionId, timeoutMs } = {}) {
    const device = this.requireDevice(deviceId);
    this.assertPackage(device, expectedPackage);
    const checked = validateActions(actions);
    const displayActions = checked.map((action) => this.toDisplayAction(device, action, expectedPackage));
    return this.sendCommand(deviceId, {
      op: "actions",
      expectedPackage,
      sessionId,
      actions: displayActions,
    }, timeoutMs);
  }

  async sendCommand(deviceId, payload, timeoutMs = this.commandTimeoutMs) {
    const device = this.requireDevice(deviceId);
    if (device.ws.readyState !== 1) throw new Error("device socket is not open");
    const id = randomUUID();
    const command = {
      type: "command",
      id,
      sessionId: payload.sessionId ?? randomUUID(),
      issuedWallTimeMs: Date.now(),
      ttlMs: Math.min(Math.max(timeoutMs, 1000), 30_000),
      ...payload,
    };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        device.pending.delete(id);
        this.emit("command_error", { deviceId, command, error: `device command timed out: ${payload.op}` });
        reject(new Error(`device command timed out: ${payload.op}`));
      }, timeoutMs);
      device.pending.set(id, { resolve, reject, timer, sentAt: Date.now(), command });
    });
    this.emit("command", { deviceId, command });
    device.ws.send(JSON.stringify(command), (error) => {
      if (!error) return;
      const pending = device.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        device.pending.delete(id);
        this.emit("command_error", { deviceId, command, error: error.message });
        pending.reject(error);
      }
    });
    return promise;
  }

  waitForFrame(deviceId, afterFrameId, timeoutMs = 5000) {
    const device = this.requireDevice(deviceId);
    if (device.latestFrame?.header.frameId > afterFrameId) return Promise.resolve(device.latestFrame);
    return new Promise((resolve, reject) => {
      const onFrame = (event) => {
        if (event.deviceId !== deviceId || event.frameId <= afterFrameId) return;
        cleanup();
        resolve(this.requireDevice(deviceId).latestFrame);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for a fresh frame"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("frame", onFrame);
      };
      this.on("frame", onFrame);
    });
  }

  assertPackage(device, expectedPackage) {
    if (isBlockedPackage(expectedPackage)) throw new Error(`sensitive/system package is blocked: ${expectedPackage}`);
    if (!device.hello.allowedPackages.includes(expectedPackage)) {
      throw new Error(`package is not locally allowlisted: ${expectedPackage}`);
    }
    const foreground = this.currentForegroundPackage(device);
    if (foreground !== expectedPackage) {
      throw new Error(`safe foreground check failed: ${foreground}`);
    }
  }

  toDisplayAction(device, action, expectedPackage) {
    if (action.space !== "frame") return action;
    const source = device.frameHistory.get(action.frameId);
    if (!source || Date.now() - source.receivedAt > this.sourceFrameMaxAgeMs) {
      throw new Error(`unknown or expired source frame: ${action.frameId}`);
    }
    if (source.header.foregroundPackage !== expectedPackage) {
      throw new Error(`source frame package does not match: ${source.header.foregroundPackage}`);
    }
    const current = device.latestFrame?.header;
    if (!current
      || current.displayWidth !== source.header.displayWidth
      || current.displayHeight !== source.header.displayHeight
      || current.rotation !== source.header.rotation) {
      throw new Error("display geometry changed after the source frame");
    }
    const frame = { header: source.header };
    if (action.type === "tap") {
      return { ...action, ...mapFramePointToDisplay(action, frame), space: "display" };
    }
    if (action.type === "swipe") {
      const start = mapFramePointToDisplay({ x: action.x1, y: action.y1 }, frame);
      const end = mapFramePointToDisplay({ x: action.x2, y: action.y2 }, frame);
      return { ...action, x1: start.x, y1: start.y, x2: end.x, y2: end.y, space: "display" };
    }
    if (action.type === "path") {
      return { ...action, points: action.points.map((point) => mapFramePointToDisplay(point, frame)), space: "display" };
    }
    return action;
  }

  currentForegroundPackage(device) {
    const frameSequence = device.latestFrame?.sequence ?? -1;
    const statusSequence = device.latestStatus?._sequence ?? -1;
    return statusSequence > frameSequence
      ? device.latestStatus?.foregroundPackage ?? null
      : device.latestFrame?.header?.foregroundPackage ?? null;
  }

  ttcReports(deviceId, { ttcSessionId, limit = 200 } = {}) {
    const history = this.devices.get(deviceId)?.ttcHistory ?? this.ttcArchive.get(deviceId);
    if (!history) throw new Error(`TTC archive not found for device: ${deviceId}`);
    const reports = ttcSessionId
      ? history.filter((report) => report.ttcSessionId === ttcSessionId)
      : history;
    return reports.slice(-Math.min(Math.max(limit, 1), 1000));
  }

  pruneFrameHistory(device, now) {
    for (const [frameId, frame] of device.frameHistory) {
      if (now - frame.receivedAt <= this.sourceFrameMaxAgeMs && device.frameHistory.size <= this.frameHistorySize) break;
      device.frameHistory.delete(frameId);
    }
  }
}

function validateTtcReport(report, device) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(report.ttcSessionId ?? "")) {
    throw new Error("TTC session ID is invalid");
  }
  if (!device.hello.allowedPackages.includes(report.packageName) || isBlockedPackage(report.packageName)) {
    throw new Error("TTC package is not locally allowlisted");
  }
  if (!/^\d{1,24}$/.test(report.startMonoNs ?? "") || !/^\d{1,24}$/.test(report.endMonoNs ?? "")) {
    throw new Error("TTC monotonic timestamps are invalid");
  }
  const deltaNs = BigInt(report.endMonoNs) - BigInt(report.startMonoNs);
  if (deltaNs < 0n || deltaNs > 86_400_000_000_000n) throw new Error("TTC duration is outside the 24 hour limit");
  const expectedMs = Number(deltaNs) / 1_000_000;
  if (typeof report.ttcMs !== "number" || !Number.isFinite(report.ttcMs) || Math.abs(report.ttcMs - expectedMs) > 0.001) {
    throw new Error("TTC milliseconds do not match monotonic timestamps");
  }
  if (report.actionCount !== undefined && (!Number.isInteger(report.actionCount) || report.actionCount < 0 || report.actionCount > 1_000_000)) {
    throw new Error("TTC action count is invalid");
  }
  return { ...report };
}
