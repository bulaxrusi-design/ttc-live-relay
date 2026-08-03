import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFrameEnvelope,
  encodeFrameEnvelope,
  mapFramePointToDisplay,
  safeTokenEqual,
  validateActions,
  validateHello,
} from "../src/protocol.mjs";

test("frame envelopes round-trip metadata and JPEG", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const encoded = encodeFrameEnvelope({
    protocol: 3,
    deviceId: "lab-phone-1",
    frameId: 7,
    capturedMonoNs: "123456789",
    wallTimeMs: 1_700_000_000_000,
    imageWidth: 640,
    imageHeight: 1200,
    displayWidth: 1080,
    displayHeight: 2400,
    rotation: 0,
    foregroundPackage: "com.example.game",
  }, jpeg);
  const decoded = decodeFrameEnvelope(encoded);
  assert.equal(decoded.header.type, "frame");
  assert.equal(decoded.header.frameId, 7);
  assert.deepEqual(decoded.jpeg, jpeg);
});

test("frame coordinates map through content rect", () => {
  const frame = {
    header: {
      imageWidth: 640,
      imageHeight: 1200,
      displayWidth: 1080,
      displayHeight: 2400,
      contentRect: { left: 20, top: 0, right: 620, bottom: 1200 },
    },
  };
  assert.deepEqual(mapFramePointToDisplay({ x: 320, y: 600 }, frame), { x: 540, y: 1200 });
});

test("action validation requires frame identity for frame coordinates", () => {
  assert.throws(() => validateActions([{ type: "tap", space: "frame", x: 3, y: 4 }]), /frameId/);
  const actions = validateActions([{ type: "tap", space: "frame", frameId: 9, x: 3, y: 4 }]);
  assert.equal(actions[0].frameId, 9);
});

test("action validation caps the real gesture and delay budget", () => {
  assert.throws(
    () => validateActions(Array.from({ length: 16 }, () => ({
      type: "swipe",
      space: "normalized",
      x1: 0.1,
      y1: 0.1,
      x2: 0.9,
      y2: 0.9,
      durationMs: 2000,
    }))),
    /budget/,
  );
});

test("hello requires an exact nonempty local allowlist", () => {
  const hello = validateHello({
    type: "hello",
    protocol: 3,
    deviceId: "lab-phone-1",
    display: { width: 1080, height: 2400 },
    allowedPackages: ["com.example.game"],
  });
  assert.deepEqual(hello.allowedPackages, ["com.example.game"]);
});

test("hello rejects sensitive and system packages even if a client advertises them", () => {
  assert.throws(() => validateHello({
    type: "hello",
    protocol: 3,
    deviceId: "lab-phone-1",
    display: { width: 1080, height: 2400 },
    allowedPackages: ["com.android.systemui"],
  }), /blocked/);
});

test("token comparison does not accept prefixes", () => {
  assert.equal(safeTokenEqual("abc", "abc"), true);
  assert.equal(safeTokenEqual("abc", "abcd"), false);
});
