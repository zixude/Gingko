import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/project.js";
import { ProjectStore, RevisionConflictError, TreeRuntime } from "../src/runtime/index.js";
import { findNode, ROOT_ID } from "../src/tree.js";

function runtimeWithKnownRoot() {
  const project = createProject("Research", "first");
  return new TreeRuntime({ store: new ProjectStore(project) });
}

test("runtime applies batches atomically and emits one document event", () => {
  const runtime = runtimeWithKnownRoot();
  const events = [];
  runtime.subscribe((event) => events.push(event));

  const result = runtime.applyOperations([
    { type: "update", id: "first", content: "Question" },
    { type: "insert", id: "evidence", parentId: "first", content: "Evidence" },
  ], { expectedRevision: 1, sourceId: "test" });

  assert.equal(result.revision, 2);
  assert.equal(findNode(result.project.root, "first").content, "Question");
  assert.equal(findNode(result.project.root, "evidence").content, "Evidence");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "project.changed");
  assert.equal(events[0].operations.length, 2);
});

test("failed batches leave project and revision unchanged", () => {
  const runtime = runtimeWithKnownRoot();
  assert.throws(() => runtime.applyOperations([
    { type: "update", id: "first", content: "Changed" },
    { type: "move", id: "first", parentId: "missing", index: 0 },
  ]), /Node not found|Parent node not found/);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.revision, 1);
  assert.equal(findNode(snapshot.project.root, "first").content, "");
});

test("revision preconditions prevent stale writes", () => {
  const runtime = runtimeWithKnownRoot();
  runtime.applyOperations([{ type: "update", id: "first", content: "Current" }]);
  assert.throws(
    () => runtime.applyOperations([{ type: "update", id: "first", content: "Stale" }], { expectedRevision: 1 }),
    (error) => error instanceof RevisionConflictError && error.actual === 2,
  );
});

test("deleting the final card preserves a usable blank project", () => {
  const runtime = runtimeWithKnownRoot();
  const result = runtime.applyOperations([{ type: "remove", id: "first" }]);
  assert.equal(result.project.root.children.length, 1);
  assert.equal(result.project.root.children[0].content, "");
  assert.equal(result.focusedNodeId, result.project.root.children[0].id);
});

test("queries provide outline, context, paths, search, and focus state", () => {
  const runtime = runtimeWithKnownRoot();
  runtime.applyOperations([
    { type: "update", id: "first", content: "Main question" },
    { type: "insert", id: "evidence", parentId: "first", content: "Primary evidence" },
    { type: "insert", id: "counter", parentId: ROOT_ID, content: "Counterargument" },
  ]);
  runtime.focusNode("evidence", { sourceId: "test" });

  const project = runtime.getProject({ includeContent: false });
  assert.equal(project.focusedNodeId, "evidence");
  assert.equal(project.outline[0].preview, "Main question");

  const context = runtime.getNode("evidence", { descendantsDepth: 0 });
  assert.equal(context.parentId, "first");
  assert.deepEqual(context.ancestors.map((node) => node.id), ["first"]);

  const search = runtime.searchNodes("evidence");
  assert.deepEqual(search.matches.map((node) => node.id), ["evidence"]);
});
