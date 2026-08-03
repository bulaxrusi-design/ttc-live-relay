import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import OpenAI from "openai";

export class AutoplayManager extends EventEmitter {
  constructor(registry, { apiKey, model = "gpt-5.6", frameWaitMs = 5000 } = {}) {
    super();
    this.registry = registry;
    this.model = model;
    this.frameWaitMs = frameWaitMs;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.tasks = new Map();
  }

  start({ deviceId, packageName, objective, maxSeconds = 300, maxTurns = 80, ttcProfile }) {
    if (!this.client) throw new Error("OPENAI_API_KEY is required for autonomous play");
    const device = this.registry.requireDevice(deviceId);
    this.registry.assertPackage(device, packageName);
    if (!device.latestFrame) throw new Error("the device has not published a frame yet");
    const taskId = randomUUID();
    const task = {
      id: taskId,
      deviceId,
      packageName,
      objective,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      turns: 0,
      actions: 0,
      error: null,
      result: null,
      ttcSessionId: taskId,
      cancelled: false,
    };
    this.tasks.set(task.id, task);
    this.emit("autoplay", { action: "started", task: this.publicTask(task) });
    void this.run(task, { maxSeconds, maxTurns, ttcProfile }).catch((error) => {
      task.status = "failed";
      task.error = error.message;
      task.finishedAt = new Date().toISOString();
      this.emit("autoplay", { action: "failed", task: this.publicTask(task) });
    });
    return this.publicTask(task);
  }

  status(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`autoplay task not found: ${taskId}`);
    return this.publicTask(task);
  }

  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`autoplay task not found: ${taskId}`);
    task.cancelled = true;
    this.emit("autoplay", { action: "cancellation_requested", task: this.publicTask(task) });
    return this.publicTask(task);
  }

  async run(task, { maxSeconds, maxTurns, ttcProfile }) {
    const deadline = Date.now() + maxSeconds * 1000;
    if (ttcProfile) {
      await this.registry.sendCommand(task.deviceId, {
        op: "arm_ttc",
        expectedPackage: task.packageName,
        profile: ttcProfile,
        ttcSessionId: task.ttcSessionId,
      });
    } else {
      await this.registry.sendCommand(task.deviceId, {
        op: "mark_ttc",
        expectedPackage: task.packageName,
        event: "start",
        ttcSessionId: task.ttcSessionId,
        accuracy: "controller_marker",
      });
    }

    let frame = this.registry.requireDevice(task.deviceId).latestFrame;
    let response = await this.client.responses.create({
      model: this.model,
      tools: [{ type: "computer" }],
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: this.prompt(task, maxSeconds) },
          { type: "input_image", image_url: imageData(frame), detail: "original" },
        ],
      }],
    });

    while (!task.cancelled && Date.now() < deadline && task.turns < maxTurns) {
      const computerCall = response.output?.find((item) => item.type === "computer_call");
      if (!computerCall) {
        task.status = "completed";
        task.result = response.output_text ?? "Model ended the Computer Use loop.";
        break;
      }
      task.turns += 1;
      const current = this.registry.requireDevice(task.deviceId);
      this.registry.assertPackage(current, task.packageName);
      frame = current.latestFrame;
      const actions = computerActions(computerCall.actions ?? [], frame.header);
      if (actions.length) {
        await this.registry.sendActions(task.deviceId, {
          expectedPackage: task.packageName,
          sessionId: task.id,
          actions,
        });
        task.actions += actions.length;
      }
      const nextFrame = await this.registry.waitForFrame(task.deviceId, frame.header.frameId, this.frameWaitMs);
      response = await this.client.responses.create({
        model: this.model,
        tools: [{ type: "computer" }],
        previous_response_id: response.id,
        input: [{
          type: "computer_call_output",
          call_id: computerCall.call_id,
          output: {
            type: "computer_screenshot",
            image_url: imageData(nextFrame),
            detail: "original",
          },
        }],
      });
    }

    if (task.cancelled) task.status = "cancelled";
    else if (task.status === "running") task.status = Date.now() >= deadline ? "timeout" : "turn_limit";
    if (!ttcProfile) {
      await this.registry.sendCommand(task.deviceId, {
        op: "mark_ttc",
        expectedPackage: task.packageName,
        event: "end",
        ttcSessionId: task.ttcSessionId,
        accuracy: "controller_marker",
      });
    }
    task.finishedAt = new Date().toISOString();
    this.emit("autoplay", { action: "finished", task: this.publicTask(task) });
  }

  prompt(task, maxSeconds) {
    return [
      "You are operating an authorized Android game in a fraud-analysis lab.",
      `Objective: ${task.objective}`,
      `The only allowed foreground package is ${task.packageName}.`,
      "Use the computer tool and batch obvious actions when possible.",
      "Never open an ad, store, installer, payment, login, permission, settings, or external link.",
      "If the foreground changes, a purchase appears, or the objective is complete, stop immediately.",
      `Finish within ${maxSeconds} seconds. Do not explain while playing.`,
    ].join("\n");
  }

  publicTask(task) {
    const ttcReports = this.registry.ttcReports(task.deviceId, { ttcSessionId: task.ttcSessionId ?? task.id, limit: 1000 });
    return { ...task, ttcReports };
  }
}

export function computerActions(actions, frameHeader) {
  const output = [];
  const width = frameHeader.imageWidth;
  const height = frameHeader.imageHeight;
  const frameId = frameHeader.frameId;
  for (const action of actions) {
    switch (action.type) {
      case "screenshot":
      case "move":
        break;
      case "click":
        output.push({ type: "tap", space: "frame", frameId, x: action.x, y: action.y, afterMs: 90 });
        break;
      case "double_click":
        output.push({ type: "tap", space: "frame", frameId, x: action.x, y: action.y, afterMs: 80 });
        output.push({ type: "tap", space: "frame", frameId, x: action.x, y: action.y, afterMs: 120 });
        break;
      case "drag":
        output.push({ type: "path", space: "frame", frameId, points: action.path, durationMs: 350, afterMs: 100 });
        break;
      case "scroll": {
        const x = clamp(action.x ?? width / 2, 0, width);
        const y = clamp(action.y ?? height / 2, 0, height);
        const dx = clamp(action.scroll_x ?? 0, -width * 0.7, width * 0.7);
        const dy = clamp(action.scroll_y ?? 0, -height * 0.7, height * 0.7);
        output.push({
          type: "swipe",
          space: "frame",
          frameId,
          x1: x,
          y1: y,
          x2: clamp(x - dx, 0, width),
          y2: clamp(y - dy, 0, height),
          durationMs: 300,
          afterMs: 120,
        });
        break;
      }
      case "wait":
        output.push({ type: "wait", durationMs: 700, afterMs: 0 });
        break;
      case "keypress":
        if ((action.keys ?? []).some((key) => ["BACK", "ESC", "ESCAPE"].includes(String(key).toUpperCase()))) {
          output.push({ type: "back", afterMs: 120 });
        } else {
          throw new Error(`computer keypress is not permitted: ${(action.keys ?? []).join("+")}`);
        }
        break;
      case "type":
        throw new Error("text entry is disabled in the game safety profile");
      default:
        throw new Error(`unsupported Computer Use action: ${action.type}`);
    }
  }
  return output;
}

function imageData(frame) {
  return `data:image/jpeg;base64,${frame.jpeg.toString("base64")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}
