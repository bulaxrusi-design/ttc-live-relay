# Device Live Protocol v3

Transport: one authenticated WebSocket at `/device`.

## Device authentication

The Android client sends `Authorization: Bearer <DEVICE_ENROLLMENT_TOKEN>` during
the WebSocket upgrade. The first message is a JSON `hello` with protocol version,
device ID, display geometry, locally allowed packages, and capabilities.

## JSON messages

Server command:

```json
{
  "type": "command",
  "id": "uuid",
  "sessionId": "uuid",
  "issuedWallTimeMs": 1785744000000,
  "ttlMs": 15000,
  "expectedPackage": "com.example.game",
  "op": "actions",
  "actions": [
    { "type": "tap", "space": "frame", "frameId": 17, "x": 320, "y": 700, "afterMs": 80 }
  ]
}
```

Device acknowledgement:

```json
{
  "type": "ack",
  "id": "uuid",
  "ok": true,
  "receivedMonoNs": 123,
  "dispatchStartMonoNs": 456,
  "completedMonoNs": 789,
  "queueDelayMs": 0.12,
  "deviceExecutionMs": 84.5,
  "foregroundPackage": "com.example.game"
}
```

The relay adds `serverRoundTripMs` when it resolves the acknowledgement. These
transport/dispatch metrics are diagnostic columns and are never folded into TTC.

Supported operations are `actions`, `arm_ttc`, `mark_ttc`, `get_ttc`, `status`,
and `stop`. Supported action types are `tap`, `swipe`, `path`, `back`, and `wait`.
TTC arm/marker commands carry a UUID `ttcSessionId`; every resulting level report
echoes that ID and the exact game package.

## Binary frame envelope

Each frame is a single WebSocket binary message:

1. four-byte unsigned big-endian JSON header length;
2. UTF-8 JSON header;
3. JPEG bytes.

The header includes `frameId`, `capturedMonoNs`, `wallTimeMs`, image and real
display dimensions, rotation, foreground package, and an optional bounded text
snapshot. Coordinates returned by Computer Use are interpreted in the exact image
space identified by `frameId` and mapped to real-display gesture coordinates. The
relay retains only the latest JPEG plus a short, bounded history of frame geometry,
so a recently observed frame remains actionable while newer frames continue to
stream. Expired frames and frames from a previous rotation are rejected.

## Limits

- binary message: 2 MiB;
- text message: 128 KiB;
- actions per batch: 120;
- delay per action: 0–2000 ms;
- total gesture plus delay budget: 30 seconds;
- command TTL: 30 seconds by default.
