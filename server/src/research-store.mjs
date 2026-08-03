import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";

const SCHEMA = "device-lab-research/v1";
const SECRET_KEY = /(authorization|api.?key|secret|password|token)/i;

export class ResearchStore {
  constructor({ dataDir = "data", enabled = true, fileName = "research-events.jsonl" } = {}) {
    this.enabled = enabled;
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, fileName);
    this.tail = Promise.resolve();
    this.lastError = null;
  }

  async init() {
    if (!this.enabled) return;
    await mkdir(this.dataDir, { recursive: true });
    await appendFile(this.filePath, "", { encoding: "utf8", flag: "a", mode: 0o600 });
  }

  record(eventType, rawData = {}) {
    if (!this.enabled) return Promise.resolve(null);
    const data = redact(rawData);
    const indexes = deriveIndexes(data);
    const event = {
      schema: SCHEMA,
      eventId: randomUUID(),
      recordedAt: new Date().toISOString(),
      eventType,
      ...indexes,
      data,
    };
    const line = `${JSON.stringify(event)}\n`;
    const operation = this.tail.then(() => appendFile(this.filePath, line, { encoding: "utf8", flag: "a", mode: 0o600 }));
    this.tail = operation.catch((error) => {
      this.lastError = error;
    });
    return operation.then(() => event);
  }

  async flush() {
    await this.tail;
    if (this.lastError) throw this.lastError;
  }

  async query({ deviceId, ttcSessionId, packageName, sessionId, eventTypes, since, until, limit = 1000 } = {}) {
    if (!this.enabled) return [];
    await this.flush();
    const boundedLimit = Math.min(Math.max(limit, 1), 5000);
    const output = [];
    const lines = readline.createInterface({
      input: createReadStream(this.filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.schema !== SCHEMA) continue;
      if (deviceId && event.deviceId !== deviceId) continue;
      if (ttcSessionId && event.ttcSessionId !== ttcSessionId) continue;
      if (packageName && event.packageName !== packageName) continue;
      if (sessionId && event.sessionId !== sessionId) continue;
      if (eventTypes?.length && !eventTypes.includes(event.eventType)) continue;
      if (since && event.recordedAt < since) continue;
      if (until && event.recordedAt > until) continue;
      output.push(event);
      if (output.length > boundedLimit) output.shift();
    }
    return output;
  }

  toCsv(events) {
    const columns = [
      "recordedAt",
      "eventType",
      "deviceId",
      "ttcSessionId",
      "sessionId",
      "packageName",
      "op",
      "ttcMs",
      "actionCount",
      "queueDelayMs",
      "deviceExecutionMs",
      "serverRoundTripMs",
      "dataJson",
    ];
    const rows = events.map((event) => {
      const report = event.data?.report ?? event.data?.status?.ttc ?? {};
      const command = event.data?.command ?? {};
      const ack = event.data?.ack ?? {};
      return [
        event.recordedAt,
        event.eventType,
        event.deviceId,
        event.ttcSessionId,
        event.sessionId,
        event.packageName,
        command.op,
        report.ttcMs,
        report.actionCount,
        ack.queueDelayMs,
        ack.deviceExecutionMs,
        ack.serverRoundTripMs,
        JSON.stringify(event.data),
      ].map(csvCell).join(",");
    });
    return `${columns.join(",")}\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
  }

  status() {
    return { enabled: this.enabled, schema: SCHEMA, lastError: this.lastError?.message ?? null };
  }
}

function deriveIndexes(data) {
  const report = data.report ?? data.data?.report ?? {};
  const command = data.command ?? {};
  const task = data.task ?? {};
  const ack = data.ack ?? {};
  return compact({
    deviceId: data.deviceId ?? task.deviceId,
    ttcSessionId: report.ttcSessionId ?? command.ttcSessionId ?? task.ttcSessionId,
    sessionId: command.sessionId ?? ack.sessionId ?? task.id,
    packageName: report.packageName ?? command.expectedPackage ?? task.packageName ?? data.status?.foregroundPackage,
  });
}

function redact(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
