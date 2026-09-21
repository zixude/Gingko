import { randomUUID } from "node:crypto";
import { applyOperation, assertTree, createNode, findNode, ROOT_ID } from "../tree.js";
import { createProject, validateProject } from "../project.js";

export class RevisionConflictError extends Error {
  constructor(expected, actual) {
    super(`Revision conflict: expected ${expected}, current revision is ${actual}`);
    this.name = "RevisionConflictError";
    this.code = "REVISION_CONFLICT";
    this.expected = expected;
    this.actual = actual;
  }
}

// Replaceable persistence boundary. The first implementation is intentionally
// in-memory; file import/export is handled by adapters without leaking into the tree domain.
export class ProjectStore {
  #project;
  #revision;

  constructor(project = createProject(), revision = 1) {
    this.#project = ensureProjectHasCard(clone(validateProject(project)));
    this.#revision = revision;
  }

  snapshot() {
    return { project: clone(this.#project), revision: this.#revision };
  }

  replace(project, { expectedRevision } = {}) {
    this.#assertRevision(expectedRevision);
    const nextProject = ensureProjectHasCard(clone(validateProject(project)));
    this.#project = nextProject;
    this.#revision += 1;
    return this.snapshot();
  }

  newProject(title = "Untitled", options = {}) {
    return this.replace(createProject(title), options);
  }

  setTitle(title, { expectedRevision } = {}) {
    this.#assertRevision(expectedRevision);
    if (typeof title !== "string" || title.length > 120) {
      throw new Error("Project title must be a string of at most 120 characters");
    }
    this.#project = { ...this.#project, title };
    this.#revision += 1;
    return this.snapshot();
  }

  apply(operations, { expectedRevision } = {}) {
    this.#assertRevision(expectedRevision);
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error("At least one tree operation is required");
    }

    let root = this.#project.root;
    for (const operation of operations) {
      root = applyOperation(root, normalizeOperation(root, operation));
    }
    if (root.children.length === 0) {
      root = { ...root, children: [createNode(randomUUID())] };
    }
    assertTree(root);
    this.#project = { ...this.#project, root };
    this.#revision += 1;
    return this.snapshot();
  }

  #assertRevision(expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this.#revision) {
      throw new RevisionConflictError(expectedRevision, this.#revision);
    }
  }
}

function normalizeOperation(root, operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error("Every operation must be an object");
  }
  const normalized = { ...operation };
  if (normalized.parentId === null) normalized.parentId = ROOT_ID;
  if ((normalized.type === "insert" || normalized.type === "insertSubtree" || normalized.type === "move") && normalized.index === undefined) {
    const parent = findNode(root, normalized.parentId);
    if (!parent) throw new Error(`Parent node not found: ${normalized.parentId}`);
    normalized.index = parent.children.length;
  }
  return normalized;
}

function ensureProjectHasCard(project) {
  if (project.root.children.length === 0) project.root.children.push(createNode(randomUUID()));
  return project;
}

function clone(value) {
  return structuredClone(value);
}
