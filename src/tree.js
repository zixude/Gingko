export const ROOT_ID = "root";

export class TreeError extends Error {
  constructor(message, code = "INVALID_TREE_OPERATION") {
    super(message);
    this.name = "TreeError";
    this.code = code;
  }
}

export function createRoot(children = []) {
  return { id: ROOT_ID, content: "", children };
}

export function createNode(id, content = "", children = []) {
  return { id, content, children };
}

export function findNode(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function locateNode(root, id, parent = null) {
  if (root.id === id) return { node: root, parent, index: -1 };
  for (let index = 0; index < root.children.length; index += 1) {
    const child = root.children[index];
    if (child.id === id) return { node: child, parent: root, index };
    const found = locateNode(child, id, root);
    if (found) return found;
  }
  return null;
}

export function getAncestors(root, id) {
  const path = [];
  function visit(node) {
    if (node.id === id) return true;
    for (const child of node.children) {
      path.push(node);
      if (visit(child)) return true;
      path.pop();
    }
    return false;
  }
  return visit(root) ? path : [];
}

export function getDescendants(node) {
  return node.children.flatMap((child) => [child, ...getDescendants(child)]);
}

export function preorder(root) {
  return [root, ...root.children.flatMap(preorder)];
}

export function getDepth(root, id) {
  const location = locateNode(root, id);
  if (!location) return -1;
  return getAncestors(root, id).length;
}

// Port of Gingko's focus-preserving column alignment. Each result tells one
// independently scrolling column which card should remain in view.
export function getScrollPositions(root, activeId, activePast = []) {
  const active = findNode(root, activeId);
  if (!active) return [];

  const ancestorIds = new Set(getAncestors(root, activeId).map((node) => node.id));
  const descendantIds = new Set(getDescendants(active).map((node) => node.id));
  const activePastRank = new Map(activePast.map((id, index) => [id, index]));
  const historySortedRoot = sortChildrenBy(root, (node) => activePastRank.get(node.id) ?? 9999);
  const historySortedDescendants = projectColumns(historySortedRoot)
    .flat(2)
    .map((node) => node.id)
    .filter((id) => descendantIds.has(id));

  const preorderIds = preorder(root).map((node) => node.id);
  const activeIndex = Math.max(0, preorderIds.indexOf(activeId));
  const excluded = new Set([...ancestorIds, ...descendantIds, activeId]);
  // Names intentionally mirror the original Elm implementation.
  const afterIds = new Set(preorderIds.slice(0, activeIndex).filter((id) => !excluded.has(id)));
  const beforeIds = new Set(preorderIds.slice(activeIndex).filter((id) => !excluded.has(id)));

  return projectColumns(root).map((groups, columnIndex) => {
    const ids = groups.flat().map((node) => node.id);
    const activeInColumn = ids.find((id) => id === activeId);
    if (activeInColumn) return scrollPosition(columnIndex, "center", activeInColumn);

    const ancestor = ids.find((id) => ancestorIds.has(id));
    if (ancestor) return scrollPosition(columnIndex, "center", ancestor);

    const historicalDescendant = historySortedDescendants.find((id) => ids.includes(id));
    if (historicalDescendant) return scrollPosition(columnIndex, "center", historicalDescendant);

    const descendant = ids.find((id) => descendantIds.has(id));
    if (descendant) return scrollPosition(columnIndex, "center", descendant);

    const before = ids.find((id) => beforeIds.has(id));
    const after = [...ids].reverse().find((id) => afterIds.has(id));
    if (before && after) return scrollPosition(columnIndex, "between", after, before);
    if (before) return scrollPosition(columnIndex, "before", before);
    if (after) return scrollPosition(columnIndex, "after", after);
    return scrollPosition(columnIndex, "none", null);
  });
}

function scrollPosition(columnIndex, position, target, target2 = null) {
  return { columnIndex, position, target, target2 };
}

function sortChildrenBy(node, rank) {
  const children = node.children
    .map((child) => sortChildrenBy(child, rank))
    .sort((left, right) => rank(left) - rank(right));
  return { ...node, children };
}

// A column is a list of sibling groups. This preserves Gingko's key spatial
// rule: siblings stack vertically, while children appear one column to the right.
export function projectColumns(root) {
  const columns = [];
  let groups = [root.children];
  while (groups.some((group) => group.length > 0)) {
    columns.push(groups);
    groups = groups.flat().map((node) => node.children);
  }
  return columns;
}

export function applyOperation(root, operation) {
  switch (operation.type) {
    case "insert":
      return insertSubtree(root, operation.parentId, operation.index, createNode(operation.id, operation.content ?? ""));
    case "insertSubtree":
      return insertSubtree(root, operation.parentId, operation.index, operation.subtree);
    case "update":
      return updateNode(root, operation.id, operation.content);
    case "remove":
      return removeNode(root, operation.id);
    case "move":
      return moveNode(root, operation.id, operation.parentId, operation.index);
    case "merge":
      return mergeNodes(root, operation.id, operation.otherId, operation.otherFirst === true);
    default:
      throw new TreeError(`Unknown operation: ${operation.type}`, "UNKNOWN_OPERATION");
  }
}

export function updateNode(root, id, content) {
  requireContent(content);
  requireNode(root, id);
  return mapAt(root, id, (node) => ({ ...node, content }));
}

export function insertSubtree(root, parentId, index, subtree) {
  const parent = requireNode(root, parentId);
  assertTree(subtree, { allowRootId: false });
  const existingIds = new Set(preorder(root).map((node) => node.id));
  const duplicate = preorder(subtree).find((node) => existingIds.has(node.id));
  if (duplicate) throw new TreeError(`Node id already exists: ${duplicate.id}`, "DUPLICATE_ID");
  const targetIndex = clampIndex(index, parent.children.length);
  return mapAt(root, parentId, (node) => ({
    ...node,
    children: node.children.toSpliced(targetIndex, 0, subtree),
  }));
}

export function removeNode(root, id) {
  if (id === ROOT_ID) throw new TreeError("The root node cannot be removed", "ROOT_IMMUTABLE");
  const location = requireLocation(root, id);
  return mapAt(root, location.parent.id, (parent) => ({
    ...parent,
    children: parent.children.toSpliced(location.index, 1),
  }));
}

export function moveNode(root, id, parentId, index) {
  if (id === ROOT_ID) throw new TreeError("The root node cannot be moved", "ROOT_IMMUTABLE");
  const source = requireLocation(root, id);
  requireNode(root, parentId);
  if (id === parentId || getDescendants(source.node).some((node) => node.id === parentId)) {
    throw new TreeError("A node cannot be moved inside its own subtree", "MOVE_CYCLE");
  }

  let targetIndex = index;
  if (source.parent.id === parentId && source.index < targetIndex) targetIndex -= 1;
  const pruned = removeNode(root, id);
  return insertExistingSubtree(pruned, parentId, targetIndex, source.node);
}

export function mergeNodes(root, id, otherId, otherFirst = false) {
  if (id === ROOT_ID || otherId === ROOT_ID || id === otherId) {
    throw new TreeError("Only two different cards can be merged", "INVALID_MERGE");
  }
  const current = requireLocation(root, id);
  const other = requireLocation(root, otherId);
  if (current.parent.id !== other.parent.id) {
    throw new TreeError("Only sibling cards can be merged", "INVALID_MERGE");
  }

  const contents = otherFirst
    ? [other.node.content, current.node.content]
    : [current.node.content, other.node.content];
  const children = otherFirst
    ? [...other.node.children, ...current.node.children]
    : [...current.node.children, ...other.node.children];

  const withoutOther = removeNode(root, otherId);
  return mapAt(withoutOther, id, (node) => ({
    ...node,
    content: contents.filter(Boolean).join("\n\n"),
    children,
  }));
}

export function assertTree(root, { allowRootId = true, maxNodes = 100_000 } = {}) {
  const ids = new Set();
  let count = 0;
  function visit(node, isRoot) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new TreeError("Every node must be an object", "INVALID_TREE");
    }
    if (typeof node.id !== "string" || node.id.length === 0) {
      throw new TreeError("Every node needs a non-empty string id", "INVALID_TREE");
    }
    if (!allowRootId && node.id === ROOT_ID) {
      throw new TreeError(`The id '${ROOT_ID}' is reserved`, "INVALID_TREE");
    }
    if (isRoot && allowRootId && node.id !== ROOT_ID) {
      throw new TreeError(`The project root id must be '${ROOT_ID}'`, "INVALID_TREE");
    }
    requireContent(node.content);
    if (!Array.isArray(node.children)) {
      throw new TreeError(`Node '${node.id}' must have a children array`, "INVALID_TREE");
    }
    if (ids.has(node.id)) throw new TreeError(`Duplicate node id: ${node.id}`, "DUPLICATE_ID");
    ids.add(node.id);
    count += 1;
    if (count > maxNodes) throw new TreeError(`Tree exceeds ${maxNodes} nodes`, "TREE_TOO_LARGE");
    node.children.forEach((child) => visit(child, false));
  }
  visit(root, true);
  return root;
}

function mapAt(node, id, transform) {
  if (node.id === id) return transform(node);
  let changed = false;
  const children = node.children.map((child) => {
    const next = mapAt(child, id, transform);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function insertExistingSubtree(root, parentId, index, subtree) {
  const parent = requireNode(root, parentId);
  const targetIndex = clampIndex(index, parent.children.length);
  return mapAt(root, parentId, (node) => ({
    ...node,
    children: node.children.toSpliced(targetIndex, 0, subtree),
  }));
}

function clampIndex(index, length) {
  if (!Number.isInteger(index)) throw new TreeError("Insertion index must be an integer", "INVALID_INDEX");
  return Math.max(0, Math.min(index, length));
}

function requireNode(root, id) {
  const node = findNode(root, id);
  if (!node) throw new TreeError(`Node not found: ${id}`, "NODE_NOT_FOUND");
  return node;
}

function requireLocation(root, id) {
  const location = locateNode(root, id);
  if (!location) throw new TreeError(`Node not found: ${id}`, "NODE_NOT_FOUND");
  return location;
}

function requireContent(content) {
  if (typeof content !== "string") throw new TreeError("Card content must be a string", "INVALID_CONTENT");
}
