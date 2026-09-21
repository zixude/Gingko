import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(root, "public");
const sourceRoot = resolve(root, "src");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

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

    const sourceRequest = url.pathname.startsWith("/src/");
    const base = sourceRequest ? sourceRoot : publicRoot;
    const relative = sourceRequest ? url.pathname.slice(5) : url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = resolve(base, decodeURIComponent(relative));
    if (file !== base && !file.startsWith(`${base}${sep}`)) return send(response, 403, "text/plain", "Forbidden");

    const body = await readFile(file);
    send(response, 200, mimeTypes[extname(file)] || "application/octet-stream", body);
  } catch (error) {
    const status = error?.code === "ENOENT" ? 404 : 500;
    send(response, status, "text/plain; charset=utf-8", status === 404 ? "Not found\n" : "Internal server error\n");
  }
});

server.listen(port, host, () => {
  console.log(`Gingko Lite is running at http://${host}:${port}`);
});

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}
