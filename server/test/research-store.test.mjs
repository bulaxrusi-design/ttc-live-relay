import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchStore } from "../src/research-store.mjs";

test("research store persists, filters, redacts, and exports session events", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "device-live-store-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new ResearchStore({ dataDir });
  await store.init();
  const ttcSessionId = "77ac1498-ff03-4d7c-95d8-49d32e51c020";
  await store.record("ttc", {
    deviceId: "phone-1",
    report: {
      type: "ttc",
      ttcSessionId,
      packageName: "com.example.game",
      ttcMs: 1500,
      actionCount: 4,
    },
  });
  await store.record("command", {
    deviceId: "phone-1",
    enrollmentToken: "must-not-be-written",
    command: { op: "actions", expectedPackage: "com.example.game", sessionId: "action-session" },
  });
  const session = await store.query({ ttcSessionId });
  assert.equal(session.length, 1);
  assert.equal(session[0].data.report.ttcMs, 1500);
  const all = await store.query({ deviceId: "phone-1" });
  assert.equal(all[1].data.enrollmentToken, "[REDACTED]");
  const csv = store.toCsv(session);
  assert.match(csv, /ttcSessionId/);
  assert.match(csv, /1500/);
});
