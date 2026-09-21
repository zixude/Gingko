import {
  ROOT_ID,
  TreeError,
  applyOperation,
  findNode,
  getAncestors,
  getDepth,
  getDescendants,
  getScrollPositions,
  locateNode,
  projectColumns,
} from "/src/tree.js";
import {
  createProject,
  parseProject,
  projectFileName,
  serializeProject,
} from "/src/project.js";

const elements = {
  canvas: document.querySelector("#canvas"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  title: document.querySelector("#project-title"),
  status: document.querySelector("#status"),
  newProject: document.querySelector("#new-project"),
  openProject: document.querySelector("#open-project"),
  saveProject: document.querySelector("#save-project"),
  fileInput: document.querySelector("#file-input"),
  menu: document.querySelector("#project-menu"),
};

const initialProject = createProject();
const state = {
  project: initialProject,
  activeId: initialProject.root.children[0].id,
  activePast: [],
  mode: "editing",
  draggedId: null,
  dirty: false,
  fileName: null,
};

let filletFrame = null;

bindProjectActions();
render({ preserveScroll: false });
requestAnimationFrame(() => {
  positionActive(true);
  focusEditor();
});

function bindProjectActions() {
  elements.newProject.addEventListener("click", () => {
    if (!mayDiscardChanges()) return;
    state.project = createProject();
    state.activeId = state.project.root.children[0].id;
    state.activePast = [];
    state.mode = "editing";
    state.fileName = null;
    state.dirty = false;
    closeMenu();
    render({ preserveScroll: false });
    requestAnimationFrame(() => {
      positionActive(true);
      focusEditor();
    });
  });

  elements.openProject.addEventListener("click", () => {
    if (!mayDiscardChanges()) return;
    closeMenu();
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener("change", async () => {
    const [file] = elements.fileInput.files;
    elements.fileInput.value = "";
    if (!file) return;
    try {
      state.project = ensureProjectHasCard(parseProject(await file.text()));
      state.activeId = state.project.root.children[0].id;
      state.activePast = [];
      state.mode = findNode(state.project.root, state.activeId).content ? "normal" : "editing";
      state.fileName = file.name;
      state.dirty = false;
      render({ preserveScroll: false });
      requestAnimationFrame(() => {
        positionActive(true);
        if (state.mode === "editing") focusEditor();
      });
      setStatus(`已打开 ${file.name}`);
    } catch (error) {
      window.alert(`无法打开项目：${error.message}`);
    }
  });

  elements.saveProject.addEventListener("click", () => {
    saveProjectFile();
    closeMenu();
  });

  elements.title.addEventListener("input", () => {
    state.project = { ...state.project, title: elements.title.value };
    markDirty();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  window.addEventListener("resize", () => {
    positionActive(true);
    scheduleFilletUpdate();
  });
}

function render({ preserveScroll = true } = {}) {
  const oldColumns = preserveScroll
    ? [...elements.canvas.querySelectorAll(".column")].map((column) => column.scrollTop)
    : [];
  const oldHorizontal = preserveScroll ? elements.canvas.scrollLeft : 0;
  const activeNode = findNode(state.project.root, state.activeId);
  if (!activeNode) {
    state.activeId = state.project.root.children[0].id;
    state.mode = "normal";
  }

  const active = findNode(state.project.root, state.activeId);
  const ancestorIds = new Set(getAncestors(state.project.root, state.activeId).map((node) => node.id));
  const descendantIds = new Set(getDescendants(active).map((node) => node.id));
  const columns = projectColumns(state.project.root);

  const leftPadding = document.createElement("div");
  leftPadding.className = "left-padding-column";
  const columnContainer = document.createElement("div");
  columnContainer.id = "column-container";
  const rightPadding = document.createElement("div");
  rightPadding.className = "right-padding-column";

  columns.forEach((groups, columnIndex) => {
    const column = document.createElement("section");
    column.className = "column";
    column.dataset.columnIndex = String(columnIndex);
    column.append(createBuffer());

    groups.forEach((group) => {
      const groupElement = document.createElement("div");
      const hasActive = group.some((node) => node.id === state.activeId);
      const isActiveDescendant = Boolean(group[0] && descendantIds.has(group[0].id));
      groupElement.className = "group sibling-group";
      groupElement.classList.toggle("has-active", hasActive);
      groupElement.classList.toggle("active-descendant", isActiveDescendant);

      group.forEach((node, index) => {
        groupElement.append(createCard(node, index === group.length - 1, ancestorIds));
      });
      if (isActiveDescendant) {
        groupElement.append(
          createFillet("top-left"),
          createFillet("bottom-left"),
          createFillet("top-right"),
          createFillet("bottom-right"),
        );
      }
      column.append(groupElement);
    });

    column.append(createBuffer());
    column.addEventListener("scroll", scheduleFilletUpdate, { passive: true });
    columnContainer.append(column);
  });

  elements.canvas.replaceChildren(leftPadding, columnContainer, rightPadding);
  elements.canvas.scrollLeft = oldHorizontal;
  [...elements.canvas.querySelectorAll(".column")].forEach((column, index) => {
    column.scrollTop = oldColumns[index] ?? 0;
  });
  elements.title.value = state.project.title;
  renderBreadcrumbs();
  setStatus(state.dirty ? "未保存" : state.fileName ? `已打开 ${state.fileName}` : "尚未保存");
  scheduleFilletUpdate();
}

function createBuffer() {
  const buffer = document.createElement("div");
  buffer.className = "buffer";
  return buffer;
}

function createCard(node, isLast, ancestorIds) {
  const isActive = node.id === state.activeId;
  const isEditing = isActive && state.mode === "editing";
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.id = node.id;
  card.classList.toggle("active", isActive);
  card.classList.toggle("ancestor", ancestorIds.has(node.id) && node.id !== ROOT_ID);
  card.classList.toggle("has-children", node.children.length > 0);
  card.classList.toggle("editing", isEditing);

  const dragRegion = document.createElement("div");
  dragRegion.className = "drag-region";
  dragRegion.title = "拖动卡片";
  dragRegion.draggable = true;
  dragRegion.append(Object.assign(document.createElement("div"), { className: "handle" }));
  dragRegion.addEventListener("dragstart", (event) => startDrag(event, node.id, card));
  dragRegion.addEventListener("dragend", finishDrag);
  card.append(dragRegion);

  card.append(createDropRegion("above", node.id));
  card.append(createDropRegion("into", node.id));
  if (isLast) card.append(createDropRegion("below", node.id));

  if (isEditing) {
    card.append(createEditor(node));
  } else {
    const view = document.createElement("div");
    view.className = "view";
    view.textContent = node.content || "空白卡片";
    view.addEventListener("click", () => activateCard(node.id));
    view.addEventListener("dblclick", () => enterEditing(node.id));
    card.append(view);
  }

  if (isActive && !isEditing) {
    card.append(createActiveControls(node));
    if (node.children.length > 0) {
      card.append(createFillet("top-right"), createFillet("bottom-right"));
    }
  }
  if (isEditing) {
    const save = document.createElement("button");
    save.type = "button";
    save.className = "edit-save";
    save.title = "完成编辑";
    save.textContent = "✓";
    save.addEventListener("click", closeEditing);
    card.append(save);
  }
  return card;
}

function createEditor(node) {
  const textarea = document.createElement("textarea");
  textarea.className = "card-editor";
  textarea.value = node.content;
  textarea.placeholder = "写下内容…";
  textarea.setAttribute("aria-label", "卡片内容");
  textarea.addEventListener("input", () => {
    state.project = {
      ...state.project,
      root: applyOperation(state.project.root, { type: "update", id: node.id, content: textarea.value }),
    };
    autoSize(textarea);
    markDirty();
    scheduleFilletUpdate();
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      closeEditing();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeEditing();
    }
  });
  requestAnimationFrame(() => autoSize(textarea));
  return textarea;
}

function createActiveControls(node) {
  const controls = document.createElement("div");
  controls.className = "active-controls";

  controls.append(
    actionButton("＋", "在上方新建同级卡片", "insert-above", () => addRelative(node.id, 0)),
    actionButton("＋", "在下方新建同级卡片", "insert-below", () => addRelative(node.id, 1)),
    actionButton("＋", "新建子卡片", "insert-child", () => addChild(node.id)),
    actionButton("✕", "删除卡片及其子卡片", "delete-card", () => deleteCard(node.id)),
    actionButton("✎", "编辑卡片", "edit-card", () => enterEditing(node.id)),
  );
  return controls;
}

function actionButton(text, title, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    action();
  });
  return button;
}

function createDropRegion(placement, targetId) {
  const region = document.createElement("div");
  region.className = `drop-region drop-region-${placement}`;
  region.addEventListener("dragenter", (event) => {
    if (!state.draggedId || state.draggedId === targetId) return;
    event.preventDefault();
    clearDropHighlights();
    region.classList.add("drop-hover");
  });
  region.addEventListener("dragover", (event) => {
    if (!state.draggedId || state.draggedId === targetId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });
  region.addEventListener("dragleave", () => region.classList.remove("drop-hover"));
  region.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropCard(targetId, placement);
  });
  return region;
}

function createFillet(position) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("fillet", position);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("viewBox", "0 0 30 30");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M 30 0 A 30 30 0 0 1 0 30 L 30 30 L 30 0 z");
  svg.append(path);
  return svg;
}

function renderBreadcrumbs() {
  const active = findNode(state.project.root, state.activeId);
  const path = [...getAncestors(state.project.root, state.activeId), active]
    .filter((node) => node && node.id !== ROOT_ID);
  elements.breadcrumbs.replaceChildren(...path.map((node) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = cardTitle(node.content);
    button.addEventListener("click", () => activateCard(node.id));
    return button;
  }));
}

function cardTitle(content) {
  const firstLine = content.split("\n").find((line) => line.trim()) ?? "空白卡片";
  return firstLine.replace(/^#{1,6}\s*/, "").replace(/[*_`]/g, "").slice(0, 42);
}

function activateCard(id, { instant = false, mode = "normal" } = {}) {
  if (!findNode(state.project.root, id)) return;
  if (id !== state.activeId) {
    state.activePast = [state.activeId, ...state.activePast.filter((pastId) => pastId !== state.activeId)].slice(0, 40);
  }
  state.activeId = id;
  state.mode = mode;
  render({ preserveScroll: true });
  requestAnimationFrame(() => {
    positionActive(instant);
    if (mode === "editing") focusEditor();
  });
}

function enterEditing(id) {
  activateCard(id, { instant: true, mode: "editing" });
}

function closeEditing() {
  state.mode = "normal";
  render({ preserveScroll: true });
  requestAnimationFrame(() => positionActive(true));
}

function addRelative(id, offset) {
  const location = locateNode(state.project.root, id);
  if (!location?.parent) return;
  const newId = crypto.randomUUID();
  runOperation({
    type: "insert",
    id: newId,
    content: "",
    parentId: location.parent.id,
    index: location.index + offset,
  }, newId, "editing");
}

function addChild(id) {
  const node = findNode(state.project.root, id);
  if (!node) return;
  const newId = crypto.randomUUID();
  runOperation({ type: "insert", id: newId, content: "", parentId: id, index: node.children.length }, newId, "editing");
}

function deleteCard(id) {
  const location = locateNode(state.project.root, id);
  if (!location?.parent) return;
  const total = getDescendants(location.node).length + 1;
  if (total > 1 && !window.confirm(`删除这张卡片及其 ${total - 1} 张子卡片？`)) return;

  if (location.parent.id === ROOT_ID && state.project.root.children.length === 1) {
    const blankId = crypto.randomUUID();
    const withoutLastCard = applyOperation(state.project.root, { type: "remove", id });
    state.project = {
      ...state.project,
      root: applyOperation(withoutLastCard, { type: "insert", id: blankId, content: "", parentId: ROOT_ID, index: 0 }),
    };
    state.activeId = blankId;
    state.activePast = [];
    state.mode = "editing";
    markDirty();
    render({ preserveScroll: false });
    requestAnimationFrame(() => {
      positionActive(true);
      focusEditor();
    });
    return;
  }

  const nextActive = location.parent.id === ROOT_ID
    ? location.parent.children.find((node) => node.id !== id)?.id
    : location.parent.id;
  runOperation({ type: "remove", id }, nextActive, "normal");
}

function runOperation(operation, activeId = state.activeId, mode = "normal") {
  try {
    state.project = { ...state.project, root: applyOperation(state.project.root, operation) };
    markDirty();
    activateCard(activeId, { mode });
  } catch (error) {
    const message = error instanceof TreeError ? error.message : "Unexpected tree operation failure";
    window.alert(`无法完成操作：${message}`);
  }
}

function startDrag(event, id, card) {
  if (state.mode === "editing" && id === state.activeId) {
    event.preventDefault();
    return;
  }
  state.draggedId = id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", id);
  document.body.classList.add("dragging-tree");
  requestAnimationFrame(() => card.classList.add("dragging"));
}

function finishDrag() {
  state.draggedId = null;
  document.body.classList.remove("dragging-tree");
  document.querySelectorAll(".card.dragging").forEach((card) => card.classList.remove("dragging"));
  clearDropHighlights();
}

function clearDropHighlights() {
  document.querySelectorAll(".drop-hover").forEach((region) => region.classList.remove("drop-hover"));
}

function dropCard(targetId, placement) {
  const draggedId = state.draggedId;
  finishDrag();
  if (!draggedId || draggedId === targetId) return;
  const target = locateNode(state.project.root, targetId);
  if (!target) return;

  if (placement === "into") {
    runOperation({ type: "move", id: draggedId, parentId: targetId, index: target.node.children.length }, draggedId);
  } else if (target.parent) {
    runOperation({
      type: "move",
      id: draggedId,
      parentId: target.parent.id,
      index: target.index + (placement === "below" ? 1 : 0),
    }, draggedId);
  }
}

function positionActive(instant = false) {
  const active = findNode(state.project.root, state.activeId);
  if (!active) return;
  const viewport = elements.canvas.getBoundingClientRect();
  const positions = getScrollPositions(state.project.root, state.activeId, state.activePast);

  positions.forEach(({ columnIndex, position, target }) => {
    if (!target || position === "none") return;
    const column = elements.canvas.querySelector(`.column[data-column-index="${columnIndex}"]`);
    const card = column?.querySelector(`.card[data-id="${CSS.escape(target)}"]`);
    if (!column || !card) return;
    const rect = card.getBoundingClientRect();
    const multiplier = position === "before" ? 0 : position === "center" ? 0.5 : 1;
    const adjustedHeight = rect.height > viewport.height - 50 ? viewport.height * 0.5 + 50 : rect.height;
    const top = column.scrollTop + rect.top + adjustedHeight * multiplier - (viewport.top + viewport.bottom) * 0.5;
    column.scrollTo({ top, behavior: instant ? "auto" : "smooth" });
  });

  const depth = getDepth(state.project.root, state.activeId);
  const activeColumn = elements.canvas.querySelector(`.column[data-column-index="${depth - 1}"]`);
  if (activeColumn) {
    const rect = activeColumn.getBoundingClientRect();
    const left = elements.canvas.scrollLeft + rect.left - viewport.left + 0.5 * (rect.width - viewport.width);
    elements.canvas.scrollTo({ left, behavior: instant ? "auto" : "smooth" });
  }
  scheduleFilletUpdate();
  window.setTimeout(scheduleFilletUpdate, instant ? 0 : 320);
}

function scheduleFilletUpdate() {
  if (filletFrame !== null) return;
  filletFrame = requestAnimationFrame(() => {
    filletFrame = null;
    updateFillets();
  });
}

function updateFillets() {
  const columns = [...elements.canvas.querySelectorAll(".column")];
  const filletData = columns.map((column) => {
    const activeCard = column.querySelector(".card.active");
    if (activeCard) {
      const rect = activeCard.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
    const groups = [...column.querySelectorAll(".group.active-descendant")];
    if (groups.length === 0) return null;
    return {
      top: groups[0].getBoundingClientRect().top,
      bottom: groups.at(-1).getBoundingClientRect().bottom,
    };
  });

  document.querySelectorAll(".fillet").forEach((fillet) => {
    fillet.style.display = "none";
    fillet.classList.remove("flipped");
    fillet.style.removeProperty("height");
    fillet.style.removeProperty("top");
    fillet.style.removeProperty("bottom");
  });

  columns.forEach((column, index) => setColumnFillets(column, index, filletData));
}

function setColumnFillets(column, index, data) {
  if (data[index - 1] == null && data[index] != null && data[index + 1] != null) {
    const activeCard = column.querySelector(".card.active");
    if (!activeCard) return;
    const top = activeCard.querySelector(".fillet.top-right");
    const bottom = activeCard.querySelector(".fillet.bottom-right");
    if (top && bottom) {
      top.style.display = "block";
      bottom.style.display = "block";
      setFilletTop(clampDelta((data[index].top - data[index + 1].top) * 0.5), top);
      setFilletBottom(clampDelta((data[index].bottom - data[index + 1].bottom) * 0.5), bottom);
    }
    return;
  }

  if (data[index] == null || data[index - 1] == null) return;
  const topLeft = column.querySelector(".group.active-descendant .fillet.top-left");
  const bottomLeftAll = column.querySelectorAll(".group.active-descendant .fillet.bottom-left");
  const bottomLeft = bottomLeftAll[bottomLeftAll.length - 1];
  if (topLeft && bottomLeft) {
    topLeft.style.display = "block";
    bottomLeft.style.display = "block";
    setFilletTop(clampDelta((data[index].top - data[index - 1].top) * 0.5), topLeft);
    setFilletBottom(clampDelta((data[index].bottom - data[index - 1].bottom) * 0.5), bottomLeft);
  }

  if (data[index + 1] == null) return;
  const topRight = column.querySelector(".group.active-descendant .fillet.top-right");
  const bottomRightAll = column.querySelectorAll(".group.active-descendant .fillet.bottom-right");
  const bottomRight = bottomRightAll[bottomRightAll.length - 1];
  if (topRight && bottomRight) {
    topRight.style.display = "block";
    bottomRight.style.display = "block";
    setFilletTop(clampDelta((data[index].top - data[index + 1].top) * 0.5), topRight);
    setFilletBottom(clampDelta((data[index].bottom - data[index + 1].bottom) * 0.5), bottomRight);
  }
}

function clampDelta(value) {
  return Math.min(Math.max(value, -16), 16);
}

function setFilletTop(delta, fillet) {
  if (delta > 0) {
    fillet.style.height = `${delta}px`;
    fillet.style.top = `${-delta}px`;
  } else {
    fillet.style.height = `${-delta}px`;
    fillet.style.top = "0";
    fillet.classList.add("flipped");
  }
}

function setFilletBottom(delta, fillet) {
  if (delta > 0) {
    fillet.style.height = `${delta}px`;
    fillet.style.bottom = "0";
    fillet.classList.add("flipped");
  } else {
    fillet.style.height = `${-delta}px`;
    fillet.style.bottom = `${delta}px`;
  }
}

function autoSize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(72, textarea.scrollHeight)}px`;
}

function focusEditor() {
  requestAnimationFrame(() => {
    const editor = elements.canvas.querySelector(".card.active .card-editor");
    editor?.focus();
    if (editor) editor.setSelectionRange(editor.value.length, editor.value.length);
  });
}

function markDirty() {
  state.dirty = true;
  setStatus("未保存");
}

function setStatus(message) {
  elements.status.textContent = message;
}

function mayDiscardChanges() {
  return !state.dirty || window.confirm("当前项目尚未保存，确定放弃更改？");
}

function ensureProjectHasCard(project) {
  if (project.root.children.length > 0) return project;
  const id = crypto.randomUUID();
  return {
    ...project,
    root: applyOperation(project.root, { type: "insert", id, content: "", parentId: ROOT_ID, index: 0 }),
  };
}

function closeMenu() {
  elements.menu.removeAttribute("open");
}

function saveProjectFile() {
  try {
    const text = serializeProject(state.project);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = state.fileName || projectFileName(state.project.title);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    state.fileName = anchor.download;
    state.dirty = false;
    setStatus(`已保存 ${state.fileName}`);
  } catch (error) {
    window.alert(`无法保存项目：${error.message}`);
  }
}
