import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { findNode, getAncestors, getDescendants, locateNode, preorder, ROOT_ID } from "../tree.js";
import { ProjectStore } from "./project-store.js";

export class TreeRuntime {
  #store;
  #events = new EventEmitter();
  #focusedNodeId;
  #instanceId = randomUUID();

  constructor({ store = new ProjectStore() } = {}) {
    this.#store = store;
    this.#focusedNodeId = this.#store.snapshot().project.root.children[0]?.id ?? null;
    this.#events.setMaxListeners(100);
  }

  snapshot() {
    return { ...this.#store.snapshot(), focusedNodeId: this.#focusedNodeId, instanceId: this.#instanceId };
  }

  subscribe(listener) {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  replaceProject(project, { expectedRevision, sourceId = "unknown" } = {}) {
    const snapshot = this.#store.replace(project, { expectedRevision });
    this.#focusedNodeId = snapshot.project.root.children[0]?.id ?? null;
    return this.#publishProject(snapshot, sourceId, [{ type: "replaceProject" }]);
  }

  newProject(title = "Untitled", { expectedRevision, sourceId = "unknown" } = {}) {
    const snapshot = this.#store.newProject(title, { expectedRevision });
    this.#focusedNodeId = snapshot.project.root.children[0]?.id ?? null;
    return this.#publishProject(snapshot, sourceId, [{ type: "newProject", title }]);
  }

  setProjectTitle(title, { expectedRevision, sourceId = "unknown" } = {}) {
    const snapshot = this.#store.setTitle(title, { expectedRevision });
    return this.#publishProject(snapshot, sourceId, [{ type: "setProjectTitle", title }]);
  }

  applyOperations(operations, { expectedRevision, sourceId = "unknown" } = {}) {
    const snapshot = this.#store.apply(operations, { expectedRevision });
    if (this.#focusedNodeId && !findNode(snapshot.project.root, this.#focusedNodeId)) {
      this.#focusedNodeId = snapshot.project.root.children[0]?.id ?? null;
    }
    return this.#publishProject(snapshot, sourceId, operations);
  }

  focusNode(id, { sourceId = "unknown" } = {}) {
    const { project, revision } = this.#store.snapshot();
    if (!findNode(project.root, id)) throw new Error(`Node not found: ${id}`);
    this.#focusedNodeId = id;
    const event = { type: "view.focused", id, revision, instanceId: this.#instanceId, sourceId };
    this.#events.emit("event", event);
    return event;
  }

  getProject({ includeContent = true } = {}) {
    const snapshot = this.snapshot();
    return {
      revision: snapshot.revision,
      instanceId: this.#instanceId,
      focusedNodeId: snapshot.focusedNodeId,
      title: snapshot.project.title,
      format: snapshot.project.format,
      version: snapshot.project.version,
      outline: outlineNode(snapshot.project.root, { includeContent, includeRoot: false }),
    };
  }

  getNode(id, { descendantsDepth = 1 } = {}) {
    const { project, revision } = this.#store.snapshot();
    const location = locateNode(project.root, id);
    if (!location) throw new Error(`Node not found: ${id}`);
    const ancestors = getAncestors(project.root, id)
      .filter((node) => node.id !== ROOT_ID)
      .map(nodeSummary);
    const siblings = location.parent
      ? location.parent.children.map((node, index) => ({ ...nodeSummary(node), index, isTarget: node.id === id }))
      : [];
    return {
      revision,
      instanceId: this.#instanceId,
      focusedNodeId: this.#focusedNodeId,
      node: nodeWithDepth(location.node, descendantsDepth),
      parentId: location.parent?.id ?? null,
      index: location.index,
      ancestors,
      siblings,
      descendantCount: getDescendants(location.node).length,
    };
  }

  searchNodes(query, { limit = 20 } = {}) {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) throw new Error("Search query cannot be empty");
    const { project, revision } = this.#store.snapshot();
    const matches = preorder(project.root)
      .filter((node) => node.id !== ROOT_ID && node.content.toLocaleLowerCase().includes(normalized))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((node) => ({
        ...nodeSummary(node),
        parentId: locateNode(project.root, node.id).parent?.id ?? null,
        path: getAncestors(project.root, node.id).filter((ancestor) => ancestor.id !== ROOT_ID).map(nodeSummary),
      }));
    return { revision, instanceId: this.#instanceId, query, matches };
  }

  #publishProject(snapshot, sourceId, operations) {
    const result = { ...snapshot, focusedNodeId: this.#focusedNodeId, instanceId: this.#instanceId };
    this.#events.emit("event", {
      type: "project.changed",
      revision: snapshot.revision,
      instanceId: this.#instanceId,
      sourceId,
      operations: structuredClone(operations),
      project: structuredClone(snapshot.project),
      focusedNodeId: this.#focusedNodeId,
    });
    return result;
  }
}

function nodeSummary(node) {
  return {
    id: node.id,
    preview: preview(node.content),
    childCount: node.children.length,
  };
}

function outlineNode(node, { includeContent, includeRoot }) {
  const children = node.children.map((child) => outlineNode(child, { includeContent, includeRoot: true }));
  if (!includeRoot) return children;
  return {
    id: node.id,
    ...(includeContent ? { content: node.content } : { preview: preview(node.content) }),
    childCount: node.children.length,
    children,
  };
}

function nodeWithDepth(node, depth) {
  return {
    id: node.id,
    content: node.content,
    childCount: node.children.length,
    children: depth > 0 ? node.children.map((child) => nodeWithDepth(child, depth - 1)) : undefined,
  };
}

function preview(content) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.slice(0, 160);
}
