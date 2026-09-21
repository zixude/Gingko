import test from "node:test";
import assert from "node:assert/strict";
import {
  ROOT_ID,
  TreeError,
  applyOperation,
  createNode,
  createRoot,
  findNode,
  getScrollPositions,
  preorder,
  projectColumns,
} from "../src/tree.js";
import { createProject, parseProject, serializeProject } from "../src/project.js";

function sampleTree() {
  return createRoot([
    createNode("a", "A", [createNode("a1", "A1"), createNode("a2", "A2")]),
    createNode("b", "B", [createNode("b1", "B1")]),
  ]);
}

test("insert, update, and remove preserve unrelated branches", () => {
  const initial = sampleTree();
  const inserted = applyOperation(initial, { type: "insert", id: "a3", content: "A3", parentId: "a", index: 1 });
  assert.deepEqual(findNode(inserted, "a").children.map((node) => node.id), ["a1", "a3", "a2"]);
  assert.equal(findNode(initial, "a3"), null);

  const updated = applyOperation(inserted, { type: "update", id: "a3", content: "changed" });
  assert.equal(findNode(updated, "a3").content, "changed");
  assert.equal(findNode(updated, "b"), findNode(inserted, "b"));

  const removed = applyOperation(updated, { type: "remove", id: "a" });
  assert.deepEqual(preorder(removed).map((node) => node.id), [ROOT_ID, "b", "b1"]);
});

test("moving within one sibling group uses the original drop index", () => {
  const root = createRoot([createNode("a"), createNode("b"), createNode("c")]);
  const moved = applyOperation(root, { type: "move", id: "a", parentId: ROOT_ID, index: 3 });
  assert.deepEqual(moved.children.map((node) => node.id), ["b", "c", "a"]);
});

test("moving a parent into its descendant is rejected", () => {
  assert.throws(
    () => applyOperation(sampleTree(), { type: "move", id: "a", parentId: "a1", index: 0 }),
    (error) => error instanceof TreeError && error.code === "MOVE_CYCLE",
  );
});

test("column projection keeps a sibling group for each parent", () => {
  const columns = projectColumns(sampleTree());
  assert.deepEqual(columns[0].map((group) => group.map((node) => node.id)), [["a", "b"]]);
  assert.deepEqual(columns[1].map((group) => group.map((node) => node.id)), [["a1", "a2"], ["b1"]]);
});

test("merge keeps content and children in the requested order", () => {
  const merged = applyOperation(sampleTree(), { type: "merge", id: "b", otherId: "a", otherFirst: true });
  assert.deepEqual(merged.children.map((node) => node.id), ["b"]);
  assert.equal(findNode(merged, "b").content, "A\n\nB");
  assert.deepEqual(findNode(merged, "b").children.map((node) => node.id), ["a1", "a2", "b1"]);
});

test("focus alignment centers ancestors, active cards, and recent descendants", () => {
  const ancestorFocus = getScrollPositions(sampleTree(), "a1", []);
  assert.deepEqual(
    ancestorFocus.map(({ position, target }) => [position, target]),
    [["center", "a"], ["center", "a1"]],
  );

  const rememberedDescendant = getScrollPositions(sampleTree(), "a", ["a2"]);
  assert.deepEqual(
    rememberedDescendant.map(({ position, target }) => [position, target]),
    [["center", "a"], ["center", "a2"]],
  );
});

test("new projects open directly on one blank card", () => {
  const project = createProject("Untitled", "first");
  assert.deepEqual(project.root.children, [createNode("first")]);
});

test("project files round-trip and reject duplicate ids", () => {
  const project = createProject("Research", "first");
  project.root = sampleTree();
  assert.deepEqual(parseProject(serializeProject(project)), project);

  const invalid = structuredClone(project);
  invalid.root.children[1].id = "a";
  assert.throws(() => parseProject(JSON.stringify(invalid)), /Duplicate node id/);
});
