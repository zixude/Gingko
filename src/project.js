import { assertTree, createNode, createRoot } from "./tree.js";

export const PROJECT_FORMAT = "gingko-lite";
export const PROJECT_VERSION = 1;

export function createProject(title = "Untitled", firstCardId = crypto.randomUUID()) {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    title,
    root: createRoot([createNode(firstCardId)]),
  };
}

export function parseProject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON");
  }
  return validateProject(value);
}

export function validateProject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project file must contain an object");
  }
  if (value.format !== PROJECT_FORMAT || value.version !== PROJECT_VERSION) {
    throw new Error(`Unsupported project format; expected ${PROJECT_FORMAT} version ${PROJECT_VERSION}`);
  }
  if (typeof value.title !== "string") throw new Error("Project title must be a string");
  assertTree(value.root);
  return value;
}

export function serializeProject(project) {
  validateProject(project);
  return `${JSON.stringify(project, null, 2)}\n`;
}

export function projectFileName(title) {
  const safe = title.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 80);
  return `${safe || "Untitled"}.gingko.json`;
}
