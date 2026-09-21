import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { createGingkoMcpServer } from "./src/adapters/mcp.js";
import { RevisionConflictError, TreeRuntime } from "./src/runtime/index.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(root, "public");
const sourceRoot = resolve(root, "src");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const runtime = new TreeRuntime();

const mcpServer = createGingkoMcpServer(runtime);
const mcpTransport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
await mcpServer.connect(mcpTransport);

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

    if (url.pathname === "/health") return send(response, 200, "text/plain; charset=utf-8", "ok\n");

    if (url.pathname === "/mcp") {
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      await mcpTransport.handleRequest(request, response);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      await handleApi(request, response, url);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(response, 405, { error: "Method not allowed" }, { Allow: "GET, HEAD" });
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: "Internal server error" });
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`Gingko Lite is running at http://${host}:${port}`);
  console.log(`MCP endpoint: http://${host}:${port}/mcp`);
});

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/project") {
    return json(response, 200, runtime.snapshot());
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    return streamEvents(request, response);
  }

  try {
    const body = await readJsonBody(request);
    const sourceId = stringOr(body.sourceId, "web");
    if (request.method === "POST" && url.pathname === "/api/operations") {
      return json(response, 200, runtime.applyOperations(body.operations, {
        expectedRevision: optionalRevision(body.expectedRevision),
        sourceId,
      }));
    }
    if (request.method === "PUT" && url.pathname === "/api/project") {
      return json(response, 200, runtime.replaceProject(body.project, {
        expectedRevision: optionalRevision(body.expectedRevision),
        sourceId,
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/project/new") {
      return json(response, 200, runtime.newProject(stringOr(body.title, "Untitled"), {
        expectedRevision: optionalRevision(body.expectedRevision),
        sourceId,
      }));
    }
    if (request.method === "PATCH" && url.pathname === "/api/project/title") {
      return json(response, 200, runtime.setProjectTitle(body.title, {
        expectedRevision: optionalRevision(body.expectedRevision),
        sourceId,
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/focus") {
      return json(response, 200, runtime.focusNode(body.id, { sourceId }));
    }
    return json(response, 404, { error: "API route not found" });
  } catch (error) {
    const status = error instanceof RevisionConflictError ? 409 : 400;
    return json(response, status, {
      error: error.message,
      code: error.code ?? "INVALID_REQUEST",
      ...(error.actual !== undefined ? { currentRevision: error.actual } : {}),
    });
  }
}

function streamEvents(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(`event: snapshot\ndata: ${JSON.stringify(runtime.snapshot())}\n\n`);

  const unsubscribe = runtime.subscribe((event) => {
    if (!response.destroyed) response.write(`event: runtime\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(": keepalive\n\n");
  }, 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function serveStatic(response, pathname) {
  const sourceRequest = pathname.startsWith("/src/");
  const base = sourceRequest ? sourceRoot : publicRoot;
  const relative = sourceRequest ? pathname.slice(5) : pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolve(base, decodeURIComponent(relative));
  if (file !== base && !file.startsWith(`${base}${sep}`)) return send(response, 403, "text/plain", "Forbidden");

  try {
    const body = await readFile(file);
    send(response, 200, mimeTypes[extname(file)] || "application/octet-stream", body);
  } catch (error) {
    if (error?.code === "ENOENT") return send(response, 404, "text/plain; charset=utf-8", "Not found\n");
    throw error;
  }
}

async function readJsonBody(request, maxBytes = 10 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function optionalRevision(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error("expectedRevision must be a positive integer");
  return value;
}

function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function json(response, status, value, extraHeaders = {}) {
  return send(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`, extraHeaders);
}

function send(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

async function shutdown() {
  await mcpServer.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
