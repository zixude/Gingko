import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ROOT_ID } from "../tree.js";

const revisionSchema = z.number().int().positive().optional().describe("Optional optimistic-concurrency precondition. Obtain it from a read tool; stale writes are rejected.");
const nodeIdSchema = z.string().min(1).describe("Stable card/node id returned by read_project, read_node, search_nodes, or create_node.");
const parentIdSchema = z.string().min(1).describe(`Destination parent id. Use '${ROOT_ID}' for a top-level card.`);

const subtreeSchema = z.lazy(() => z.object({
  id: z.string().min(1),
  content: z.string(),
  children: z.array(subtreeSchema).default([]),
}));

const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("insert"), id: z.string().min(1), content: z.string().default(""), parentId: parentIdSchema, index: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("update"), id: nodeIdSchema, content: z.string() }),
  z.object({ type: z.literal("remove"), id: nodeIdSchema }),
  z.object({ type: z.literal("move"), id: nodeIdSchema, parentId: parentIdSchema, index: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("insertSubtree"), subtree: subtreeSchema, parentId: parentIdSchema, index: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("merge"), id: nodeIdSchema, otherId: nodeIdSchema, otherFirst: z.boolean().default(false) }),
]);

export function createGingkoMcpServer(runtime) {
  const server = new McpServer({
    name: "gingko-lite",
    version: "0.2.0",
    description: "A local-first tree research canvas. Read context before writing; use revisions and batch_apply for coherent multi-node edits.",
  });

  registerResources(server, runtime);
  registerReadTools(server, runtime);
  registerWriteTools(server, runtime);
  return server;
}

function registerResources(server, runtime) {
  server.registerResource(
    "current-project",
    "gingko://project",
    { title: "Current Gingko project", description: "Current project outline, revision, and focused card.", mimeType: "application/json" },
    async (uri) => resourceResult(uri, runtime.getProject({ includeContent: true })),
  );

  server.registerResource(
    "project-file",
    "gingko://project/file",
    { title: "Complete project file", description: "The complete portable Gingko JSON project.", mimeType: "application/json" },
    async (uri) => resourceResult(uri, runtime.snapshot()),
  );

  server.registerResource(
    "node-context",
    new ResourceTemplate("gingko://node/{id}", { list: undefined }),
    { title: "Gingko node context", description: "One card with its path, siblings, and immediate children.", mimeType: "application/json" },
    async (uri, variables) => resourceResult(uri, runtime.getNode(String(variables.id), { descendantsDepth: 1 })),
  );
}

function registerReadTools(server, runtime) {
  server.registerTool(
    "read_project",
    {
      title: "Read project outline",
      description: "Read the entire tree outline, current revision, and the card currently focused by the user. Use includeContent=true when full card text is required.",
      inputSchema: z.object({ includeContent: z.boolean().default(false) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safeTool(({ includeContent }) => runtime.getProject({ includeContent })),
  );

  server.registerTool(
    "read_node",
    {
      title: "Read card context",
      description: "Read one card with full content, parent, index, ancestor path, sibling order, descendant count, and a bounded descendant subtree.",
      inputSchema: z.object({
        id: nodeIdSchema,
        descendantsDepth: z.number().int().min(0).max(20).default(1),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safeTool(({ id, descendantsDepth }) => runtime.getNode(id, { descendantsDepth })),
  );

  server.registerTool(
    "search_nodes",
    {
      title: "Search cards",
      description: "Case-insensitive full-text search over card content. Returns stable ids, previews, parent ids, and ancestor paths.",
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safeTool(({ query, limit }) => runtime.searchNodes(query, { limit })),
  );
}

function registerWriteTools(server, runtime) {
  server.registerTool(
    "create_node",
    {
      title: "Create card",
      description: "Create one card under a parent. Omit index to append. Returns the generated stable id and complete local context.",
      inputSchema: z.object({ parentId: parentIdSchema, index: z.number().int().nonnegative().optional(), content: z.string().default(""), expectedRevision: revisionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safeTool(({ parentId, index, content, expectedRevision }) => {
      const id = randomUUID();
      runtime.applyOperations([{ type: "insert", id, content, parentId, index }], mutationOptions(expectedRevision));
      return runtime.getNode(id, { descendantsDepth: 1 });
    }),
  );

  server.registerTool(
    "update_node",
    {
      title: "Update card",
      description: "Replace the complete text content of one card without changing its position or children.",
      inputSchema: z.object({ id: nodeIdSchema, content: z.string(), expectedRevision: revisionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(({ id, content, expectedRevision }) => {
      runtime.applyOperations([{ type: "update", id, content }], mutationOptions(expectedRevision));
      return runtime.getNode(id, { descendantsDepth: 1 });
    }),
  );

  server.registerTool(
    "delete_node",
    {
      title: "Delete card subtree",
      description: "Delete one card and every descendant beneath it. Read the node first; this is destructive.",
      inputSchema: z.object({ id: nodeIdSchema, expectedRevision: revisionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safeTool(({ id, expectedRevision }) => {
      const before = runtime.getNode(id, { descendantsDepth: 0 });
      const result = runtime.applyOperations([{ type: "remove", id }], mutationOptions(expectedRevision));
      return { revision: result.revision, deletedId: id, deletedDescendantCount: before.descendantCount, focusedNodeId: result.focusedNodeId };
    }),
  );

  server.registerTool(
    "move_node",
    {
      title: "Move card subtree",
      description: "Move a card with all descendants to another parent and ordered index. Omit index to append. Cycles are rejected.",
      inputSchema: z.object({ id: nodeIdSchema, parentId: parentIdSchema, index: z.number().int().nonnegative().optional(), expectedRevision: revisionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safeTool(({ id, parentId, index, expectedRevision }) => {
      runtime.applyOperations([{ type: "move", id, parentId, index }], mutationOptions(expectedRevision));
      return runtime.getNode(id, { descendantsDepth: 1 });
    }),
  );

  server.registerTool(
    "insert_subtree",
    {
      title: "Insert research branch",
      description: "Insert a complete pre-built subtree atomically. Every supplied id must be unique in both the subtree and project.",
      inputSchema: z.object({ parentId: parentIdSchema, index: z.number().int().nonnegative().optional(), subtree: subtreeSchema, expectedRevision: revisionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safeTool(({ parentId, index, subtree, expectedRevision }) => {
      runtime.applyOperations([{ type: "insertSubtree", parentId, index, subtree }], mutationOptions(expectedRevision));
      return runtime.getNode(subtree.id, { descendantsDepth: 2 });
    }),
  );

  server.registerTool(
    "merge_nodes",
    {
      title: "Merge sibling cards",
      description: "Merge otherId into id. Both cards must be siblings. The other card is deleted and its children are transferred.",
      inputSchema: z.object({ id: nodeIdSchema, otherId: nodeIdSchema, otherFirst: z.boolean().default(false), expectedRevision: revisionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safeTool(({ id, otherId, otherFirst, expectedRevision }) => {
      runtime.applyOperations([{ type: "merge", id, otherId, otherFirst }], mutationOptions(expectedRevision));
      return runtime.getNode(id, { descendantsDepth: 1 });
    }),
  );

  server.registerTool(
    "batch_apply",
    {
      title: "Apply atomic tree transaction",
      description: "Apply an ordered batch of inserts, updates, removals, moves, subtree inserts, and merges as one transaction and one revision. If any operation fails, none are committed. Prefer this for coherent research branches.",
      inputSchema: z.object({ operations: z.array(operationSchema).min(1).max(500), expectedRevision: revisionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safeTool(({ operations, expectedRevision }) => {
      const result = runtime.applyOperations(operations, mutationOptions(expectedRevision));
      return { revision: result.revision, focusedNodeId: result.focusedNodeId, operationCount: operations.length };
    }),
  );

  server.registerTool(
    "focus_node",
    {
      title: "Focus card on shared canvas",
      description: "Ask connected browser canvases to activate and reveal one card without modifying document content.",
      inputSchema: z.object({ id: nodeIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(({ id }) => runtime.focusNode(id, { sourceId: "mcp" })),
  );

  server.registerTool(
    "rename_project",
    {
      title: "Rename project",
      description: "Change only the project title.",
      inputSchema: z.object({ title: z.string().max(120), expectedRevision: revisionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(({ title, expectedRevision }) => {
      const result = runtime.setProjectTitle(title, mutationOptions(expectedRevision));
      return { revision: result.revision, title: result.project.title };
    }),
  );

  server.registerTool(
    "new_project",
    {
      title: "Replace with new blank project",
      description: "Discard the entire current in-memory project and replace it with one blank card. Use only when explicitly requested by the user.",
      inputSchema: z.object({ title: z.string().max(120).default("Untitled"), expectedRevision: revisionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safeTool(({ title, expectedRevision }) => {
      const result = runtime.newProject(title, mutationOptions(expectedRevision));
      return { revision: result.revision, title: result.project.title, focusedNodeId: result.focusedNodeId };
    }),
  );
}

function mutationOptions(expectedRevision) {
  return { expectedRevision, sourceId: "mcp" };
}

function safeTool(handler) {
  return async (args) => {
    try {
      const data = await handler(args);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    } catch (error) {
      const data = {
        error: error?.message ?? String(error),
        code: error?.code ?? "TOOL_ERROR",
        ...(error?.actual !== undefined ? { currentRevision: error.actual } : {}),
      };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  };
}

function resourceResult(uri, data) {
  return {
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }],
  };
}
