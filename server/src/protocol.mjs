import { createHash, timingSafeEqual } from "node:crypto";

export const PROTOCOL_VERSION = 3;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_ACTIONS = 120;
export const MAX_ACTION_DELAY_MS = 2000;
export const MAX_BATCH_DURATION_MS = 30_000;

const ACTION_TYPES = new Set(["tap", "swipe", "path", "back", "wait"]);
const SPACES = new Set(["frame", "display", "normalized"]);
const HARD_BLOCKED_PACKAGES = new Set([
  "android",
  "com.android.systemui",
  "com.android.settings",
  "com.android.permissioncontroller",
  "com.android.packageinstaller",
  "com.google.android.packageinstaller",
  "com.google.android.permissioncontroller",
  "com.android.vending",
  "com.google.android.gms",
  "com.google.android.gms.authenticator",
  "com.google.android.apps.walletnfcrel",
  "com.samsung.android.app.spage",
  "com.samsung.android.packageinstaller",
  "com.samsung.android.spay",
  "com.samsung.android.spayfw",
]);
const SENSITIVE_PACKAGE_TOKENS = ["bank", "wallet", "payment", "billing", "authenticator", "installer"];

export function safeTokenEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function decodeFrameEnvelope(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 6 || bytes.length > MAX_FRAME_BYTES) {
    throw new Error("frame envelope size is invalid");
  }
  const headerLength = bytes.readUInt32BE(0);
  if (headerLength < 2 || headerLength > 64 * 1024 || 4 + headerLength >= bytes.length) {
    throw new Error("frame header length is invalid");
  }
  const header = JSON.parse(bytes.subarray(4, 4 + headerLength).toString("utf8"));
  validateFrameHeader(header);
  const jpeg = bytes.subarray(4 + headerLength);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("frame payload is not JPEG");
  }
  return { header, jpeg };
}

export function encodeFrameEnvelope(header, jpeg) {
  const normalized = { ...header, type: "frame" };
  const json = Buffer.from(JSON.stringify(normalized), "utf8");
  const image = Buffer.from(jpeg);
  const output = Buffer.allocUnsafe(4 + json.length + image.length);
  output.writeUInt32BE(json.length, 0);
  json.copy(output, 4);
  image.copy(output, 4 + json.length);
  return output;
}

export function validateHello(value) {
  if (!value || value.type !== "hello" || value.protocol !== PROTOCOL_VERSION) {
    throw new Error(`device must send hello protocol ${PROTOCOL_VERSION}`);
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value.deviceId ?? "")) {
    throw new Error("deviceId is invalid");
  }
  if (!value.display || !positiveInt(value.display.width) || !positiveInt(value.display.height)) {
    throw new Error("display geometry is invalid");
  }
  const allowedPackages = Array.isArray(value.allowedPackages) ? value.allowedPackages : [];
  if (allowedPackages.length === 0 || allowedPackages.length > 100) {
    throw new Error("device must advertise 1..100 locally allowed packages");
  }
  for (const packageName of allowedPackages) {
    if (!validPackage(packageName)) throw new Error(`invalid allowed package: ${packageName}`);
    if (isBlockedPackage(packageName)) throw new Error(`sensitive/system package is blocked: ${packageName}`);
  }
  return {
    ...value,
    allowedPackages: [...new Set(allowedPackages)],
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.slice(0, 50) : [],
  };
}

export function validateFrameHeader(header, expectedDeviceId) {
  if (!header || header.type !== "frame" || header.protocol !== PROTOCOL_VERSION) {
    throw new Error(`frame must use protocol ${PROTOCOL_VERSION}`);
  }
  if (!Number.isSafeInteger(header.frameId) || header.frameId < 0) throw new Error("frameId is invalid");
  if (expectedDeviceId && header.deviceId !== expectedDeviceId) throw new Error("frame deviceId does not match connection");
  if (header.deviceId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(header.deviceId)) throw new Error("frame deviceId is invalid");
  for (const key of ["imageWidth", "imageHeight", "displayWidth", "displayHeight"]) {
    if (!positiveInt(header[key])) throw new Error(`frame ${key} is invalid`);
  }
  if (!validPackage(header.foregroundPackage) || isBlockedPackage(header.foregroundPackage)) {
    throw new Error("frame foreground package is invalid or blocked");
  }
  if (typeof header.capturedMonoNs !== "string" || !/^\d{1,24}$/.test(header.capturedMonoNs)) {
    throw new Error("frame monotonic timestamp is invalid");
  }
  if (!Number.isSafeInteger(header.wallTimeMs) || header.wallTimeMs <= 0) throw new Error("frame wall timestamp is invalid");
  if (!Number.isInteger(header.rotation) || header.rotation < 0 || header.rotation > 3) throw new Error("frame rotation is invalid");
  if (header.accessibilityText !== undefined && (typeof header.accessibilityText !== "string" || header.accessibilityText.length > 8000)) {
    throw new Error("frame accessibility text is invalid");
  }
  const rect = header.contentRect;
  if (rect !== undefined) {
    const values = [rect.left, rect.top, rect.right, rect.bottom];
    if (!values.every(Number.isFinite)
      || rect.left < 0 || rect.top < 0
      || rect.right > header.imageWidth || rect.bottom > header.imageHeight
      || rect.right <= rect.left || rect.bottom <= rect.top) {
      throw new Error("frame content rectangle is invalid");
    }
  }
  return header;
}

export function validateActions(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_ACTIONS) {
    throw new Error(`actions must contain 1..${MAX_ACTIONS} items`);
  }
  let totalDelayMs = 0;
  const normalized = actions.map((raw, index) => {
    if (!raw || !ACTION_TYPES.has(raw.type)) {
      throw new Error(`unsupported action at index ${index}`);
    }
    const afterMs = boundedInteger(raw.afterMs ?? defaultDelay(raw.type), 0, MAX_ACTION_DELAY_MS);
    const action = { type: raw.type, afterMs };
    let activeMs = 0;
    if (raw.type === "wait") {
      action.durationMs = boundedInteger(raw.durationMs ?? afterMs, 20, MAX_ACTION_DELAY_MS);
      activeMs = action.durationMs;
    } else if (raw.type === "tap") {
      Object.assign(action, normalizePoint(raw));
      activeMs = 45;
    } else if (raw.type === "swipe") {
      Object.assign(action, normalizePoint(raw, "x1", "y1"));
      Object.assign(action, normalizePoint(raw, "x2", "y2"));
      action.durationMs = boundedInteger(raw.durationMs ?? 250, 50, 2000);
      activeMs = action.durationMs;
    } else if (raw.type === "path") {
      if (!Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > 64) {
        throw new Error(`path points are invalid at index ${index}`);
      }
      action.space = normalizeSpace(raw.space);
      action.frameId = optionalFrameId(raw.frameId, action.space);
      action.points = raw.points.map((point) => normalizePoint({ ...point, space: action.space, frameId: action.frameId }));
      action.durationMs = boundedInteger(raw.durationMs ?? 350, 50, 3000);
      activeMs = action.durationMs;
    }
    totalDelayMs += activeMs + afterMs;
    return action;
  });
  if (totalDelayMs > MAX_BATCH_DURATION_MS) throw new Error("batch delay budget exceeded");
  return normalized;
}

export function mapFramePointToDisplay(point, frame) {
  if (!frame?.header) throw new Error("a current frame is required");
  const h = frame.header;
  const imageWidth = positiveNumber(h.imageWidth);
  const imageHeight = positiveNumber(h.imageHeight);
  const displayWidth = positiveNumber(h.displayWidth);
  const displayHeight = positiveNumber(h.displayHeight);
  const crop = h.contentRect ?? { left: 0, top: 0, right: imageWidth, bottom: imageHeight };
  const cropWidth = positiveNumber(crop.right - crop.left);
  const cropHeight = positiveNumber(crop.bottom - crop.top);
  const imageX = boundedNumber(point.x, crop.left, Math.min(imageWidth - Number.EPSILON, crop.right));
  const imageY = boundedNumber(point.y, crop.top, Math.min(imageHeight - Number.EPSILON, crop.bottom));
  const normalizedX = (imageX - crop.left) / cropWidth;
  const normalizedY = (imageY - crop.top) / cropHeight;
  return {
    x: Math.min(displayWidth - 1, Math.round(Math.min(1, Math.max(0, normalizedX)) * displayWidth)),
    y: Math.min(displayHeight - 1, Math.round(Math.min(1, Math.max(0, normalizedY)) * displayHeight)),
  };
}

function normalizePoint(raw, xKey = "x", yKey = "y") {
  const space = normalizeSpace(raw.space);
  const x = boundedNumber(raw[xKey], space === "normalized" ? 0 : -100_000, space === "normalized" ? 1 : 100_000);
  const y = boundedNumber(raw[yKey], space === "normalized" ? 0 : -100_000, space === "normalized" ? 1 : 100_000);
  const suffix = xKey === "x" ? "" : xKey.slice(1);
  return {
    [`x${suffix}`]: x,
    [`y${suffix}`]: y,
    space,
    frameId: optionalFrameId(raw.frameId, space),
  };
}

function optionalFrameId(frameId, space) {
  if (space !== "frame") return undefined;
  if (!Number.isSafeInteger(frameId) || frameId < 0) throw new Error("frame-space action requires frameId");
  return frameId;
}

function normalizeSpace(value) {
  const space = value ?? "normalized";
  if (!SPACES.has(space)) throw new Error(`unsupported coordinate space: ${space}`);
  return space;
}

function defaultDelay(type) {
  return type === "wait" ? 0 : 70;
}

function boundedInteger(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`integer must be between ${min} and ${max}`);
  }
  return value;
}

function boundedNumber(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`number must be between ${min} and ${max}`);
  }
  return value;
}

function positiveNumber(value) {
  return boundedNumber(value, 1, 100_000);
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 && value <= 100_000;
}

function validPackage(value) {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(value);
}

export function isBlockedPackage(value) {
  if (typeof value !== "string") return true;
  const lower = value.toLowerCase();
  return HARD_BLOCKED_PACKAGES.has(lower) || SENSITIVE_PACKAGE_TOKENS.some((token) => lower.includes(token));
}
