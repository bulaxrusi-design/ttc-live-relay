import assert from "node:assert/strict";
import test from "node:test";
import { DeviceRegistry } from "../src/registry.mjs";

class FakeSocket {
  OPEN = 1;
  readyState = 1;
  sent = [];
  send(text, callback) {
    this.sent.push(JSON.parse(text));
    callback?.();
  }
  close() {}
}

function connectedRegistry() {
  const registry = new DeviceRegistry({ commandTimeoutMs: 1000 });
  const ws = new FakeSocket();
  registry.attach(ws, {
    type: "hello",
    protocol: 3,
    deviceId: "phone-1",
    display: { width: 1080, height: 2400 },
    allowedPackages: ["com.example.game"],
  });
  registry.handleFrame("phone-1", {
    header: {
      type: "frame",
      protocol: 3,
      deviceId: "phone-1",
      frameId: 4,
      capturedMonoNs: "123456789",
      wallTimeMs: 1_700_000_000_000,
      foregroundPackage: "com.example.game",
      imageWidth: 640,
      imageHeight: 1200,
      displayWidth: 1080,
      displayHeight: 2400,
      rotation: 0,
    },
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  return { registry, ws };
}

test("registry maps exact frame coordinates before sending one device batch", async () => {
  const { registry, ws } = connectedRegistry();
  const pending = registry.sendActions("phone-1", {
    expectedPackage: "com.example.game",
    actions: [{ type: "tap", space: "frame", frameId: 4, x: 320, y: 600 }],
  });
  const command = ws.sent[0];
  assert.equal(command.actions[0].space, "display");
  assert.equal(command.actions[0].x, 540);
  assert.equal(command.actions[0].y, 1200);
  registry.handleText("phone-1", { type: "ack", id: command.id, ok: true });
  const ack = await pending;
  assert.equal(ack.ok, true);
});

test("registry rejects a stale source frame", async () => {
  const { registry } = connectedRegistry();
  await assert.rejects(
    registry.sendActions("phone-1", {
      expectedPackage: "com.example.game",
      actions: [{ type: "tap", space: "frame", frameId: 3, x: 10, y: 10 }],
    }),
    /unknown or expired/,
  );
});

test("registry retains recent source-frame geometry while newer frames stream", async () => {
  const { registry, ws } = connectedRegistry();
  registry.handleFrame("phone-1", {
    header: {
      ...registry.requireDevice("phone-1").latestFrame.header,
      frameId: 5,
      capturedMonoNs: "223456789",
      wallTimeMs: 1_700_000_000_100,
    },
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  const pending = registry.sendActions("phone-1", {
    expectedPackage: "com.example.game",
    actions: [{ type: "tap", space: "frame", frameId: 4, x: 320, y: 600 }],
  });
  const command = ws.sent[0];
  assert.equal(command.actions[0].x, 540);
  registry.handleText("phone-1", { type: "ack", id: command.id, ok: true });
  await pending;
});

test("registry rejects source coordinates after a display rotation", async () => {
  const { registry } = connectedRegistry();
  registry.handleFrame("phone-1", {
    header: {
      ...registry.requireDevice("phone-1").latestFrame.header,
      frameId: 5,
      capturedMonoNs: "223456789",
      wallTimeMs: 1_700_000_000_100,
      imageWidth: 1200,
      imageHeight: 640,
      displayWidth: 2400,
      displayHeight: 1080,
      rotation: 1,
    },
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  await assert.rejects(
    registry.sendActions("phone-1", {
      expectedPackage: "com.example.game",
      actions: [{ type: "tap", space: "frame", frameId: 4, x: 320, y: 600 }],
    }),
    /geometry changed/,
  );
});

test("registry never substitutes the newest frame when frameId is omitted", async () => {
  const { registry } = connectedRegistry();
  await assert.rejects(
    registry.sendActions("phone-1", {
      expectedPackage: "com.example.game",
      actions: [{ type: "tap", space: "frame", x: 10, y: 10 }],
    }),
    /frameId/,
  );
});

test("registry rejects gestures when foreground changed", async () => {
  const { registry } = connectedRegistry();
  registry.handleText("phone-1", {
    type: "status",
    foregroundPackage: "com.android.systemui",
    wallTimeMs: 1_700_000_000_100,
  });
  await assert.rejects(
    registry.sendActions("phone-1", {
      expectedPackage: "com.example.game",
      actions: [{ type: "tap", space: "normalized", x: 0.5, y: 0.5 }],
    }),
    /foreground/,
  );
});

test("registry keeps bounded TTC records addressable by session", () => {
  const { registry, ws } = connectedRegistry();
  const report = {
    type: "ttc",
    ttcSessionId: "77ac1498-ff03-4d7c-95d8-49d32e51c020",
    packageName: "com.example.game",
    startMonoNs: "1000000000",
    endMonoNs: "2500000000",
    ttcMs: 1500,
  };
  registry.handleText("phone-1", { type: "ttc_report", report });
  assert.deepEqual(registry.ttcReports("phone-1", { ttcSessionId: report.ttcSessionId }), [report]);
  registry.detach("phone-1", ws);
  assert.deepEqual(registry.ttcReports("phone-1", { ttcSessionId: report.ttcSessionId }), [report]);
});
