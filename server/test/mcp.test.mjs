import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeviceMcpServer } from "../src/mcp.mjs";

test("list_devices returns object-shaped structured content", async () => {
  const registry = {
    list: () => [{ deviceId: "phone-1", connected: true, allowedPackages: ["com.example.game"] }],
  };
  const server = createDeviceMcpServer(registry, {}, {});
  const client = new Client({ name: "device-lab-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "list_devices", arguments: {} });
    assert.deepEqual(response.structuredContent, {
      devices: [{ deviceId: "phone-1", connected: true, allowedPackages: ["com.example.game"] }],
    });
  } finally {
    await client.close();
    await server.close();
  }
});
