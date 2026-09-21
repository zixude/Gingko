import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 34_000 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
let child;
let output = "";

test.before(async () => {
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await waitForServer();
});

test.after(() => {
  child?.kill("SIGTERM");
});

test("HTTP API and MCP share one authoritative runtime", async () => {
  const initial = await jsonFetch("/api/project");
  assert.equal(initial.revision, 1);
  assert.equal(typeof initial.instanceId, "string");
  assert.equal(initial.project.root.children.length, 1);

  const initialized = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  }, false);
  assert.equal(initialized.result.serverInfo.name, "gingko-lite");

  const notification = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notification.status, 202);

  const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.ok(tools.result.tools.some((tool) => tool.name === "batch_apply"));
  assert.ok(tools.result.tools.some((tool) => tool.name === "focus_node"));

  const resources = await mcp({ jsonrpc: "2.0", id: 20, method: "resources/list", params: {} });
  assert.ok(resources.result.resources.some((resource) => resource.uri === "gingko://project"));
  const projectResource = await mcp({
    jsonrpc: "2.0",
    id: 21,
    method: "resources/read",
    params: { uri: "gingko://project" },
  });
  assert.equal(JSON.parse(projectResource.result.contents[0].text).revision, 1);

  const created = await mcp({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "create_node",
      arguments: { parentId: "root", content: "From MCP", expectedRevision: 1 },
    },
  });
  assert.equal(created.result.structuredContent.revision, 2);
  assert.equal(created.result.structuredContent.instanceId, initial.instanceId);
  const createdId = created.result.structuredContent.node.id;

  const afterMcp = await jsonFetch("/api/project");
  assert.equal(afterMcp.revision, 2);
  assert.equal(afterMcp.project.root.children[1].id, createdId);

  const browserWrite = await jsonFetch("/api/operations", {
    method: "POST",
    body: {
      expectedRevision: 2,
      sourceId: "browser-test",
      operations: [{ type: "update", id: createdId, content: "From browser" }],
    },
  });
  assert.equal(browserWrite.revision, 3);

  const readBack = await mcp({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "read_node", arguments: { id: createdId, descendantsDepth: 0 } },
  });
  assert.equal(readBack.result.structuredContent.node.content, "From browser");

  const stale = await mcp({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "update_node",
      arguments: { id: createdId, content: "stale", expectedRevision: 2 },
    },
  });
  assert.equal(stale.result.isError, true);
  assert.match(stale.result.content[0].text, /REVISION_CONFLICT/);
});

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Retry until the process binds its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start:\n${output}`);
}

async function jsonFetch(path, { method = "GET", body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

async function mcp(body, withProtocol = true) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(withProtocol),
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

function mcpHeaders(withProtocol = true) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(withProtocol ? { "MCP-Protocol-Version": "2025-11-25" } : {}),
  };
}
