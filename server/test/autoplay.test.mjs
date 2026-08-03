import assert from "node:assert/strict";
import test from "node:test";
import { computerActions } from "../src/autoplay.mjs";

const frame = { frameId: 12, imageWidth: 640, imageHeight: 1200 };

test("computer clicks retain the exact source frame identity", () => {
  const actions = computerActions([{ type: "click", x: 320, y: 600 }], frame);
  assert.deepEqual(actions[0], {
    type: "tap",
    space: "frame",
    frameId: 12,
    x: 320,
    y: 600,
    afterMs: 90,
  });
});

test("computer typing is blocked in the game profile", () => {
  assert.throws(() => computerActions([{ type: "type", text: "secret" }], frame), /disabled/);
});

test("scroll becomes a bounded swipe", () => {
  const [action] = computerActions([{ type: "scroll", x: 320, y: 600, scroll_y: 400, scroll_x: 0 }], frame);
  assert.equal(action.type, "swipe");
  assert.equal(action.y2, 200);
});
