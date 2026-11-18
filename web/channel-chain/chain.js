import { iconSvg } from "../icon-svg.mjs";
import { deviceChoices, expectedSend, projectHostGraph } from "./host-graph.mjs";
import { nodeTitle, skinLabel } from "./labels.mjs";

const {
  devices, effects, tapNames, seed, routeError, splitLegacy,
  centerFromPixels, centerToPixels, roundCanvasPercent, migrateCanvasPosition,
  initialNodeLayout, hardwareOutputLayout, migrateLanePosition, channelIdentity, openNativeEffectBrowser,
  effectIdAt, portRoutes, minZoom, zoomAt, wireCurve, routeAroundCards,
} = channelChain;
const select = selector => document.querySelector(selector);
const board = select("#board");
const viewport = select(".board-scroll");
const workspace = select(".workspace");
const host = window.audcore;
const t = key => skinLabel(host, key);
const themeButton = select("#theme");
const zoomButton = select("#zoom");
const initialView = { x: 0, y: 0, scale: 1 };
const compactZoom = .5;
const paths = select("#route-paths");
const arrows = select("#route-arrows");
const draft = select("#draft-wire");
const dialog = select("#editor");
const fields = select("#editor-fields");
const status = select("#status");
const deviceMenu = select("#device-menu");
const graphKey = "audcore.channel-chain.demo-graph.v1";
const positionKey = "canvas-center/";
const canvasInset = 18;
const positions = new Map();
const canvasPositions = new Set();
const legacyPositions = new Map();
const cardElements = new Map();
const wireElements = new Map();
let graph = host ? { nodes: [], routes: [] } : loadGraph();
let gesture;
let pendingSource;
let commitDialog;
let ignoreClickUntil = 0;
let statusTimer;
let view = initialView;
let pan;
let spaceHeld = false;
let spaceUsed = false;
let hostState;
let deviceTrigger;
let initialLayoutDone = false;

function loadGraph() {
  try {
    const saved = JSON.parse(localStorage.getItem(graphKey));
    if (Array.isArray(saved?.nodes) && Array.isArray(saved?.routes)) {
      return { nodes: saved.nodes, routes: saved.routes.map(({ effects, effectIds, effectTap, ...route }) =>
        ({ ...route, tap: route.tap ?? 2 })) };
    }
  } catch { /* The demo can be used with storage disabled. */ }
  return seed();
}

function message(text, error = false) {
  clearTimeout(statusTimer);
  status.textContent = t(text);
  status.toggleAttribute("data-error", error);
  if (error) statusTimer = setTimeout(() => status.removeAttribute("data-error"), 5000);
}

function setGraph(next, notice, focusId) {
  graph = next;
  if (!host) {
    try { localStorage.setItem(graphKey, JSON.stringify(graph)); } catch { /* Keep the active draft. */ }
  }
  render();
  if (focusId) cardElements.get(focusId)?.querySelector(".node-title").focus();
  message(notice);
}

function setTheme(theme) {
  if (theme !== "light" && theme !== "dark") return;
  document.documentElement.dataset.theme = theme;
  if (!host) themeButton.textContent = theme === "light" ? "深色" : "浅色";
}

function receiveLayout(key, value) {
  if (key === "theme") {
    if (!host) setTheme(value);
    return;
  }
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) return;
  if (!key.startsWith(positionKey)) {
    const prefix = ["canvas-position/", "position/"].find(prefix => key.startsWith(prefix));
    if (prefix) legacyPositions.set(key, value);
    return;
  }
  const id = key.slice(positionKey.length);
  canvasPositions.add(id);
  if (gesture?.kind === "move" && gesture.id === id) {
    gesture.synced = value;
    return;
  }
  positions.set(id, { x: roundCanvasPercent(value.x), y: roundCanvasPercent(value.y) });
  place(id);
  drawWires();
}

let layout;
let layoutReady = Promise.resolve();
let layoutLoaded = false;
try {
  layout = openChannelChainLayout(receiveLayout);
  layoutReady = layout.snapshot().catch(() => message("当前浏览器无法读取布局记录", true));
} catch {
  message("当前浏览器无法读取布局记录", true);
}

async function storeLayout(key, value) {
  try {
    if (!layout) throw new Error("布局存储不可用");
    await layout.put(key, value);
  } catch {
    message("更改已应用，浏览器未能保存布局记录", true);
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function icon(name) {
  const node = element("span", "icon");
  node.innerHTML = iconSvg(name);
  return node;
}

function button(className, title, action) {
  const node = element("button", className);
  node.type = "button";
  node.title = title;
  node.setAttribute("aria-label", title);
  node.addEventListener("click", action);
  return node;
}

function position(id) {
  return positions.get(id) || { x: 0, y: 0 };
}

function canvasSize() {
  return { width: board.clientWidth, height: board.clientHeight };
}

function cardSize(card) {
  return { width: card.offsetWidth, height: card.offsetHeight };
}

function place(id) {
  const card = cardElements.get(id);
  if (!card) return;
  const point = centerToPixels(position(id), canvasSize());
  card.style.left = point.x - card.offsetWidth / 2 + "px";
  card.style.top = point.y - card.offsetHeight / 2 + "px";
}

function sendPort(node) {
  const port = button("port port-out", "从 " + node.name + " 连线", () => {
    if (performance.now() < ignoreClickUntil) return;
    selectSource(pendingSource === node.id ? undefined : node.id);
  });
  port.setAttribute("aria-pressed", "false");
  port.addEventListener("pointerdown", event => startGesture(event, "route", node.id, { id: node.id }));
  return port;
}

function receivePort(endpoint, title) {
  const port = button(endpoint.sidechainEffectId ? "port effect-port" : "port port-in", title, () => {
    if (performance.now() < ignoreClickUntil) return;
    if (pendingSource !== undefined) finishRoute(pendingSource, endpoint);
    else message("先选择一个发送圆点");
  });
  port.addEventListener("pointerdown", event => {
    if (portRoutes(graph, endpoint, "in").length) startGesture(event, "detach", endpoint.id, endpoint);
  });
  return port;
}

function createCard(node) {
  const card = element("article", "node");
  card.dataset.node = node.id;
  card.dataset.kind = node.kind;
  card.toggleAttribute("data-hardware-output", Boolean(node.hardwareOutput));
  if (node.color) card.style.setProperty("--node-color", node.color);
  card.append(receivePort({ id: node.id }, "连接到 " + node.name));
  const title = button("node-title", node.name + " · 拖动或使用方向键移动", () => {
    if (performance.now() >= ignoreClickUntil) openNodeSettings(node);
  });
  title.append(element("strong", "", nodeTitle(node)), element("span", "", node.device));
  title.title = [node.name, node.device].filter(Boolean).join(" · ");
  title.addEventListener("pointerdown", event => startGesture(event, "move", node.id));
  title.addEventListener("keydown", event => moveWithKeyboard(event, node.id));
  if (node.kind === "input") title.addEventListener("contextmenu", event => {
    event.preventDefault();
    if (gesture) return;
    const { left, bottom } = title.getBoundingClientRect();
    const anchor = { x: left, y: bottom };
    if (node.channel) {
      void host.menu.openInput(node.channel.id, anchor, channelIdentity(node.channel)).catch(reportHostError);
      return;
    }
    const rows = devices.input.map(device => {
      const choice = button("", device, () => {
        closeDeviceMenu();
        const nodes = graph.nodes.map(item => item.id === node.id ? { ...item, device } : item);
        setGraph({ ...graph, nodes }, "", node.id);
      });
      choice.textContent = device;
      return choice;
    });
    showDeviceMenu(title, rows, anchor, "选择设备");
  });
  const header = element("div", "node-header");
  header.append(title);
  if (!node.terminal) {
    const settings = button("icon-button", node.name + "设置", () => openNodeSettings(node));
    settings.append(icon("settings"));
    header.append(settings);
  }
  card.append(header);
  if (node.terminal) return card;
  const rack = element("div", "rack");
  node.effects.forEach((effect, index) => {
    const row = element("div", "effect-slot");
    const bypassed = Boolean(node.channel?.fxBypass || node.channel?.fx_bypass || node.channel?.rack?.[index]?.bypass);
    row.dataset.bypass = String(bypassed);
    const slot = button("effect", bypassed ? effect + " · " + t("旁通") : effect, () => openNodeEffect(node, index));
    slot.textContent = effect;
    if (node.channel) slot.addEventListener("contextmenu", event => {
      event.preventDefault();
      const { channel } = node;
      const entry = channel.rack[index];
      void host.menu.openEffect(channel.id, entry.instance, { x: event.clientX, y: event.clientY },
        effectIdentity(channel, entry)).catch(reportHostError);
    });
    const id = effectIdAt(node, index);
    row.dataset.effectId = id;
    if (Object.hasOwn(node.sidechainTargets ?? {}, id)) {
      row.dataset.sidechain = "";
      row.append(receivePort({ id: node.id, sidechainEffectId: id }, effect + " · " + t("侧链")));
    }
    row.append(slot);
    rack.append(row);
  });
  const add = button("icon-button", "添加效果器", () => openEffectBrowser(node));
  add.append(icon("plus"));
  rack.append(add);
  card.append(rack);
  card.append(sendPort(node));
  return card;
}

function render() {
  selectSource(undefined);
  for (const card of cardElements.values()) card.remove();
  cardElements.clear();
  wireElements.clear();
  paths.replaceChildren();
  arrows.replaceChildren();
  for (const node of graph.nodes) {
    const card = createCard(node);
    cardElements.set(node.id, card);
    board.append(card);
  }
  placeRenderedNodes();
  for (const route of graph.routes) {
    const from = graph.nodes.find(node => node.id === route.from);
    const to = graph.nodes.find(node => node.id === route.to);
    if (!from || !to) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "wire");
    path.setAttribute("aria-hidden", "true");
    const disabled = route.enabled === false ||
      Boolean(route.sidechainEffectId && !Object.hasOwn(to.sidechainTargets ?? {}, route.sidechainEffectId));
    path.toggleAttribute("data-disabled", disabled);
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("class", "wire-target");
    hit.setAttribute("role", "button");
    hit.setAttribute("tabindex", "0");
    hit.setAttribute("aria-label", from.name + " → " + (route.sidechainLabel || to.name) + " · 编辑发送");
    hit.addEventListener("click", () => editRoute(route));
    hit.addEventListener("keydown", event => {
      if (!event.repeat && event.key === "Enter") editRoute(route);
    });
    hit.addEventListener("keyup", event => {
      if (event.code === "Space" && !spaceUsed) editRoute(route);
    });
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("class", "wire-arrow");
    arrow.setAttribute("d", "M 0 0 L -8 -3.5 L -8 3.5 Z");
    arrow.toggleAttribute("data-disabled", disabled);
    const color = from.color || "var(--text-secondary)";
    for (const element of [path, hit, arrow]) element.toggleAttribute("data-sidechain-wire", Boolean(route.sidechainEffectId));
    path.style.setProperty("--wire-color", color);
    arrow.style.setProperty("--wire-color", color);
    paths.append(path, hit);
    arrows.append(arrow);
    wireElements.set(route.id, { path, hit, arrow });
  }
  drawWires();
}

function portPoint(endpoint, rect, direction = "in") {
  const card = cardElements.get(endpoint.id);
  const row = endpoint.sidechainEffectId &&
    card?.querySelector(`[data-effect-id="${CSS.escape(endpoint.sidechainEffectId)}"]`);
  const port = row ? row.querySelector(".effect-port") || row : card?.querySelector(".port-" + direction);
  if (!port) return;
  const bounds = port.getBoundingClientRect();
  return {
    x: (bounds.left + (port === row ? 0 : bounds.width / 2) - rect.left) / view.scale,
    y: (bounds.top + bounds.height / 2 - rect.top) / view.scale,
  };
}

function placeWireArrow(wire, target, arrival) {
  if (!arrival) {
    wire.arrow.setAttribute("transform", `translate(${target.x} ${target.y})`);
    return;
  }
  const length = wire.path.getTotalLength();
  const distance = Math.max(length * .4, length - arrival * 12);
  const tip = wire.path.getPointAtLength(distance);
  const tail = wire.path.getPointAtLength(Math.max(0, distance - 3));
  const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x) * 180 / Math.PI;
  wire.arrow.setAttribute("transform", `translate(${tip.x} ${tip.y}) rotate(${angle})`);
}

function drawWires() {
  const rect = board.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const branches = new Map();
  const arrivals = new Map();
  const bounds = new Map(Array.from(cardElements, ([id, card]) => {
    const box = card.getBoundingClientRect();
    return [id, { left: (box.left - rect.left) / view.scale, right: (box.right - rect.left) / view.scale,
      top: (box.top - rect.top) / view.scale, bottom: (box.bottom - rect.top) / view.scale }];
  }));
  const cards = [...bounds.values()];
  for (const route of graph.routes) {
    const wire = wireElements.get(route.id);
    if (!wire || (view.scale < compactZoom && route.sidechainEffectId)) continue;
    const a = portPoint({ id: route.from }, rect, "out");
    const b = portPoint({ id: route.to, sidechainEffectId: route.sidechainEffectId }, rect);
    if (!a || !b) continue;
    const branch = branches.get(route.from) || 0;
    branches.set(route.from, branch + 1);
    wire.path.setAttribute("d", routeAroundCards(a, b, bounds.get(route.from), bounds.get(route.to), cards, branch));
    wire.hit.setAttribute("d", wire.path.getAttribute("d"));
    const key = JSON.stringify([route.to, route.sidechainEffectId ?? null]);
    const arrival = arrivals.get(key) ?? 0;
    placeWireArrow(wire, b, arrival);
    arrivals.set(key, arrival + 1);
  }
}

function selectSource(source) {
  pendingSource = source;
  for (const [nodeId, card] of cardElements) {
    card.querySelector(".port-out")?.setAttribute("aria-pressed", String(nodeId === source));
  }
  if (source) message("选择另一个方框左端的圆点，Esc 取消");
}

function connectionError(source, endpoint) {
  const error = routeError(graph, source, endpoint.id, endpoint.sidechainEffectId);
  if (error || !host) return error;
  const target = graph.nodes.find(node => node.id === endpoint.id);
  return endpoint.sidechainEffectId || target.targetId ? "" : "此发送目标暂不可用";
}

function finishRoute(source, endpoint) {
  selectSource(undefined);
  const error = connectionError(source, endpoint);
  if (error) { message(error, true); return; }
  const target = graph.nodes.find(node => node.id === endpoint.id);
  const effectId = endpoint.sidechainEffectId;
  if (host) {
    const from = graph.nodes.find(node => node.id === source);
    const targetId = effectId ? target.sidechainTargets[effectId] : target.targetId;
    void host.channel.addSend(from.channel.id, targetId, channelIdentity(from.channel)).catch(reportHostError);
    return;
  }
  const route = { id: crypto.randomUUID(), from: source, to: endpoint.id, sidechainEffectId: effectId, tap: 2, gain: 0 };
  setGraph({ ...graph, routes: [...graph.routes, route] }, "已连接。点击连线可编辑发送。");
  wireElements.get(route.id)?.hit.focus({ preventScroll: true });
}

function startGesture(event, kind, id, endpoint) {
  if (event.button !== 0 || gesture) return;
  const target = event.currentTarget;
  const card = cardElements.get(id);
  const rect = card.getBoundingClientRect();
  const routes = endpoint ? portRoutes(graph, endpoint, kind === "route" ? "out" : "in") : [];
  gesture = { kind, id, endpoint, routes, pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: (event.clientX - rect.left) / view.scale, offsetY: (event.clientY - rect.top) / view.scale, previous: position(id), moved: false };
  target.setPointerCapture(event.pointerId);
}

function routeDropTarget(element) {
  return element?.closest(".effect-slot[data-sidechain], [data-node]");
}

function dropEndpoint(element) {
  return { id: element.closest("[data-node]").dataset.node, sidechainEffectId: element.dataset.effectId };
}

function markDropTargets(source) {
  const targets = new Set();
  for (const card of cardElements.values()) {
    for (const element of [card, ...card.querySelectorAll(".effect-slot[data-sidechain]")]) {
      if (connectionError(source, dropEndpoint(element))) continue;
      element.dataset.target = "available";
      targets.add(element);
    }
  }
  return targets;
}

function markDiscard(routes, active) {
  for (const route of routes) {
    const wire = wireElements.get(route.id);
    wire?.path.toggleAttribute("data-detaching", active);
    wire?.arrow.toggleAttribute("data-detaching", active);
  }
}

function canDiscard(drag, event, target) {
  return drag.routes.length && isCanvasBlank(target) &&
    Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 18;
}

function discardRoutes(routes) {
  if (host) {
    const entries = routes.map(route => {
      const node = graph.nodes.find(item => item.id === route.from);
      return { id: node.channel.id, index: route.index, expected: expectedSend(route, node.channel) };
    });
    if (entries.length === 1) {
      const { id, index, expected } = entries[0];
      void host.channel.removeSend(id, index, expected).catch(reportHostError);
    } else if (host.channel.removeSends) {
      void host.channel.removeSends(entries).catch(reportHostError);
    } else {
      message("请更新声核以一次移除多条连线", true);
    }
    return;
  }
  const ids = new Set(routes.map(route => route.id));
  setGraph({ ...graph, routes: graph.routes.filter(route => !ids.has(route.id)) }, "连线已删除");
}

function moveGesture(event) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const { id, x, y } = gesture;
  if (!gesture.moved) {
    if (Math.hypot(event.clientX - x, event.clientY - y) < 4) return;
    gesture.moved = true;
    if (gesture.kind === "route") gesture.dropTargets = markDropTargets(id);
  }
  const card = cardElements.get(id);
  if (gesture.kind === "move") {
    card.dataset.moving = "";
    const canvas = board.getBoundingClientRect();
    const x = (event.clientX - canvas.left) / view.scale - gesture.offsetX + card.offsetWidth / 2;
    const y = (event.clientY - canvas.top) / view.scale - gesture.offsetY + card.offsetHeight / 2;
    positions.set(id, centerFromPixels(x, y, canvasSize()));
    place(id);
    drawWires();
    return;
  }
  const under = document.elementFromPoint(event.clientX, event.clientY);
  const target = routeDropTarget(under);
  const hovered = gesture.dropTargets?.has(target) ? target : undefined;
  if (gesture.highlighted && gesture.highlighted !== hovered) gesture.highlighted.dataset.target = "available";
  gesture.highlighted = hovered;
  if (hovered) hovered.dataset.target = "active";
  const discard = canDiscard(gesture, event, under);
  markDiscard(gesture.routes, discard);
  const rect = board.getBoundingClientRect();
  const from = portPoint(gesture.endpoint, rect, gesture.kind === "route" ? "out" : "in");
  if (!from) return;
  const to = { x: (event.clientX - rect.left) / view.scale, y: (event.clientY - rect.top) / view.scale };
  if (hovered) Object.assign(to, portPoint(dropEndpoint(hovered), rect));
  draft.setAttribute("d", gesture.kind === "detach" ? wireCurve(to, from) : wireCurve(from, to));
  draft.toggleAttribute("data-detaching", discard);
  draft.style.setProperty("--wire-color", card.style.getPropertyValue("--node-color") || "var(--text-secondary)");
  draft.removeAttribute("hidden");
}

function endGesture(event, canceled = false) {
  if (!gesture || (event && event.pointerId !== gesture.pointerId)) return;
  const drag = gesture;
  const { id, kind, moved, previous, synced, dropTargets, routes } = drag;
  gesture = undefined;
  if (pendingHostGraph) queueMicrotask(applyHostNodes);
  if (!moved) {
    if (synced) receiveLayout(positionKey + id, synced);
    return;
  }
  ignoreClickUntil = performance.now() + 120;
  draft.setAttribute("hidden", "");
  for (const target of dropTargets ?? []) delete target.dataset.target;
  markDiscard(routes, false);
  if (kind === "move") {
    delete cardElements.get(id).dataset.moving;
    if (canceled) {
      positions.set(id, synced || previous);
      place(id);
      drawWires();
    } else {
      savePosition(id);
    }
    return;
  }
  const target = !canceled && event && document.elementFromPoint(event.clientX, event.clientY);
  const drop = target && kind === "route" && routeDropTarget(target);
  if (drop) return finishRoute(id, dropEndpoint(drop));
  selectSource(undefined);
  if (target && canDiscard(drag, event, target)) discardRoutes(routes);
  else message("已取消连线");
}

function savePosition(id) {
  const point = position(id);
  message(`位置 X ${point.x.toFixed(2)}% · Y ${point.y.toFixed(2)}%`);
  persistPosition(id);
}

function persistPosition(id) {
  canvasPositions.add(id);
  void storeLayout(positionKey + id, position(id));
}

function moveWithKeyboard(event, id) {
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  const point = position(id);
  const step = event.shiftKey ? 5 : 1;
  positions.set(id, { x: roundCanvasPercent(point.x + direction[0] * step), y: roundCanvasPercent(point.y + direction[1] * step) });
  place(id);
  drawWires();
  savePosition(id);
}

board.addEventListener("pointermove", moveGesture);
board.addEventListener("pointerup", endGesture);
board.addEventListener("pointercancel", event => endGesture(event, true));
board.addEventListener("lostpointercapture", event => endGesture(event, true));

function setView(next) {
  const zoomChanged = view.scale !== next.scale;
  const modeChanged = (view.scale < compactZoom) !== (next.scale < compactZoom);
  const nameScale = Math.min(2, 1 / next.scale);
  const nameSizeChanged = nameScale !== Math.min(2, 1 / view.scale);
  view = next;
  board.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  if (zoomChanged) zoomButton.textContent = Math.floor(view.scale * 100 + 1e-8) + "%";
  if (modeChanged) board.toggleAttribute("data-compact", view.scale < compactZoom);
  if (nameSizeChanged) board.style.setProperty("--node-name-scale", nameScale);
  if (modeChanged || nameSizeChanged) {
    for (const id of cardElements.keys()) place(id);
    drawWires();
  }
}

function stopPan(event) {
  if (!pan || (event && event.pointerId !== pan.id)) return;
  const { id } = pan;
  pan = undefined;
  delete viewport.dataset.panning;
  if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
}

viewport.addEventListener("pointerdown", event => {
  if (event.button !== 1 && !(event.button === 0 && spaceHeld)) return;
  event.preventDefault();
  event.stopPropagation();
  if (gesture || pan) return;
  if (event.button === 0) spaceUsed = true;
  pan = { id: event.pointerId, x: event.clientX - view.x, y: event.clientY - view.y };
  viewport.dataset.panning = "";
  viewport.setPointerCapture(event.pointerId);
}, true);
viewport.addEventListener("pointermove", event => {
  if (event.pointerId !== pan?.id) return;
  setView({ ...view, x: event.clientX - pan.x, y: event.clientY - pan.y });
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  viewport.addEventListener(type, stopPan);
}
viewport.addEventListener("auxclick", event => {
  if (event.button === 1) event.preventDefault();
});
window.addEventListener("blur", () => {
  spaceHeld = false;
  spaceUsed = false;
  delete viewport.dataset.panReady;
  stopPan();
});

zoomButton.addEventListener("click", resetCanvasView);

function resetCanvasView() {
  setView(initialView);
  if (!cardElements.size) return;
  const { left, top, right, bottom } = canvasBounds();
  const size = canvasSize();
  setView({ x: (size.width - left - right) / 2, y: (size.height - top - bottom) / 2, scale: 1 });
}
viewport.addEventListener("wheel", event => {
  event.preventDefault();
  if (gesture || pan || !event.deltaY) return;
  const rect = viewport.getBoundingClientRect();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
  const delta = Math.max(-360, Math.min(360, event.deltaY * unit));
  setView(zoomAt(view, { x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-delta * .0024)));
}, { passive: false });
document.addEventListener("keydown", event => {
  if (dialog.open) return;
  if (event.code === "Space" && !event.altKey && !event.ctrlKey && !event.metaKey) {
    if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (!event.repeat) spaceUsed = false;
    spaceHeld = true;
    viewport.dataset.panReady = "";
    if (!event.target.closest?.("button")) event.preventDefault();
    return;
  }
  if (event.key !== "Escape") return;
  stopPan();
  if (gesture) endGesture(undefined, true);
  if (pendingSource) {
    selectSource(undefined);
    message("已取消连线");
  }
});
document.addEventListener("keyup", event => {
  if (event.code !== "Space") return;
  if (spaceUsed) event.preventDefault();
  spaceHeld = false;
  spaceUsed = false;
  delete viewport.dataset.panReady;
});
new ResizeObserver(() => {
  for (const id of cardElements.keys()) place(id);
  drawWires();
}).observe(board);

function field(name, input) {
  const label = element("label", "field");
  label.append(element("span", "", name), input);
  return label;
}

function choices(values, selected) {
  const input = element("select");
  for (const [index, value] of values.entries()) {
    const option = element("option", "", value);
    option.value = String(index);
    option.selected = index === selected;
    input.append(option);
  }
  return input;
}

function openEditor({ title, description, content, submit, remove, confirm = "保存" }) {
  selectSource(undefined);
  select("#editor-title").textContent = title;
  select("#editor-description").textContent = description || "";
  select("#editor-description").hidden = !description;
  select("#confirm").textContent = t(confirm);
  const removeButton = select("#remove");
  removeButton.hidden = !remove;
  removeButton.onclick = remove ? () => { dialog.close(); remove(); } : null;
  fields.replaceChildren(content);
  commitDialog = submit;
  dialog.showModal();
}

select("#editor-form").addEventListener("submit", event => {
  event.preventDefault();
  dialog.close();
  commitDialog();
});
dialog.querySelectorAll("[data-close]").forEach(close => close.addEventListener("click", () => dialog.close()));

function placeRenderedNodes() {
  if (!cardElements.size) return;
  const size = canvasSize();
  const sizes = new Map(Array.from(cardElements, ([id, card]) => [id, cardSize(card)]));
  const oldHeight = Math.max(570, size.height, ...Array.from(sizes.values(), card => card.height + canvasInset * 2));
  for (const node of graph.nodes) {
    if (canvasPositions.has(node.id)) continue;
    const lane = legacyPositions.get("position/" + node.id);
    const old = legacyPositions.get("canvas-position/" + node.id) ?? (lane && migrateLanePosition(lane, node.kind));
    if (!old) continue;
    positions.set(node.id, migrateCanvasPosition(old, sizes.get(node.id), size, oldHeight, canvasInset));
    persistPosition(node.id);
  }

  const first = !initialLayoutDone;
  const hasPositions = graph.nodes.some(node => !node.hardwareOutput && positions.has(node.id));
  const unplaced = graph.nodes.filter(node => !positions.has(node.id));
  const connected = new Set(graph.routes.filter(route => route.enabled !== false && !route.sidechainEffectId)
    .flatMap(route => [route.from, route.to]));
  const preferred = first || unplaced.some(node => connected.has(node.id)) ? initialNodeLayout(graph, sizes, size, canvasInset) : new Map();
  for (const node of graph.nodes) if (positions.has(node.id)) place(node.id);
  for (const node of unplaced) {
    const point = preferred.get(node.id);
    if (point && !hasPositions) setTopLeft(node.id, point, sizes.get(node.id));
    else newPosition(node, point);
  }
  if (first || unplaced.length) placeHardwareOutputs(sizes, true);
  if (first) {
    initialLayoutDone = true;
    fitInitialNodes(size, !hasPositions);
  }
}

function setTopLeft(id, point, { width, height }) {
  positions.set(id, centerFromPixels(point.x + width / 2, point.y + height / 2, canvasSize()));
  place(id);
}

function placeHardwareOutputs(sizes, migrateSaved = false) {
  const bounds = new Map(Array.from(cardElements, ([id, card]) => {
    const { width, height } = sizes.get(id);
    return [id, { left: card.offsetLeft, top: card.offsetTop, right: card.offsetLeft + width, bottom: card.offsetTop + height }];
  }));
  for (const [id, point] of hardwareOutputLayout(graph, bounds)) {
    const box = bounds.get(id);
    if (point.x === box.left && point.y === box.top) continue;
    setTopLeft(id, point, sizes.get(id));
    if (migrateSaved && canvasPositions.has(id)) persistPosition(id);
  }
}

function canvasBounds() {
  const cards = [...cardElements.values()];
  return {
    left: Math.min(...cards.map(card => card.offsetLeft)),
    top: Math.min(...cards.map(card => card.offsetTop)),
    right: Math.max(...cards.map(card => card.offsetLeft + card.offsetWidth)),
    bottom: Math.max(...cards.map(card => card.offsetTop + card.offsetHeight)),
  };
}

function fitInitialNodes(size, fresh) {
  const bounds = canvasBounds();
  const left = bounds.left - canvasInset;
  const top = bounds.top - canvasInset;
  const right = bounds.right + canvasInset;
  const bottom = bounds.bottom + canvasInset;
  if (left >= 0 && top >= 0 && right <= size.width && bottom <= size.height) return;
  const scale = Math.min(1, size.width / (right - left), size.height / (bottom - top));
  if (scale < minZoom) {
    if (fresh) setView({ x: -left * minZoom, y: -top * minZoom, scale: minZoom });
    return;
  }
  setView({ x: (size.width - (right + left) * scale) / 2,
    y: (size.height - (bottom + top) * scale) / 2, scale });
}

function arrangeCanvas() {
  if (gesture || !cardElements.size) return;
  setView(initialView);
  const size = canvasSize();
  const sizes = new Map(Array.from(cardElements, ([id, card]) => [id, cardSize(card)]));
  for (const [id, point] of initialNodeLayout(graph, sizes, size, canvasInset)) {
    setTopLeft(id, point, sizes.get(id));
  }
  placeHardwareOutputs(sizes);
  for (const id of cardElements.keys()) persistPosition(id);
  fitInitialNodes(size, true);
  drawWires();
}

function newPosition(node, preferred) {
  const card = cardElements.get(node.id);
  const size = cardSize(card);
  const { width, height } = size;
  const occupied = graph.nodes.filter(item => positions.has(item.id) && (node.hardwareOutput || !item.hardwareOutput))
    .map(({ id }) => cardElements.get(id)).map(item => ({
    left: item.offsetLeft, top: item.offsetTop, right: item.offsetLeft + item.offsetWidth,
    bottom: item.offsetTop + item.offsetHeight,
  }));
  const clear = ({ x, y }) => occupied.every(item => x >= item.right + 8 || x + width + 8 <= item.left ||
    y >= item.bottom + 8 || y + height + 8 <= item.top);
  if (preferred && clear(preferred)) return setTopLeft(node.id, preferred, size);

  const canvas = canvasSize();
  const origin = { x: canvasInset - view.x / view.scale, y: canvasInset - view.y / view.scale };
  const space = { x: Math.max(0, canvas.width / view.scale - width - canvasInset * 2),
    y: Math.max(0, canvas.height / view.scale - height - canvasInset * 2) };
  const columns = node.kind === "output" ? [95, 72, 49, 26, 4] : [4, 26, 49, 72, 95];
  for (let y = 4; y <= 100; y += 8) {
    for (const x of columns) {
      const point = { x: origin.x + space.x * x / 100, y: origin.y + space.y * y / 100 };
      if (clear(point)) return setTopLeft(node.id, point, size);
    }
  }
  const x = origin.x + space.x * columns[0] / 100;
  const y = Math.max(origin.y, ...occupied.filter(item => x < item.right + 8 && x + width + 8 > item.left)
    .map(item => item.bottom + 8));
  setTopLeft(node.id, { x, y }, size);
}

function reportHostError(error) {
  message(error.message || String(error), true);
}

function openNodeSettings(node) {
  if (!host) return editNode(node);
  // Hardware output nodes represent host devices, not editable demo channels.
  if (!node.channel) return void host.settings.open().catch(reportHostError);
  host.menu.openChannelSettings(node.channel.id, channelIdentity(node.channel)).catch(reportHostError);
}

function openEffectBrowser(node) {
  if (!host) return editEffects(node, -1);
  if (!node.channel) return;
  openNativeEffectBrowser(host, node.channel).catch(reportHostError);
}

function openNodeEffect(node, index) {
  if (!host) return editEffects(node, index);
  if (!node.channel) return;
  const slot = node.channel.rack[index];
  host.effect.openEditor(node.channel.id, slot.instance, effectIdentity(node.channel, slot)).catch(reportHostError);
}

function effectIdentity(channel, slot) {
  return {
    channel: channelIdentity(channel), effect_uuid: slot.effect_uuid ?? null,
    path: slot.path ?? "", fuid: slot.fuid ?? null, cid: slot.cid ?? null,
  };
}

let pendingHostGraph;
let hostSignature;

function applyHostNodes() {
  if (!layoutLoaded || !pendingHostGraph || gesture) return;
  graph = pendingHostGraph;
  pendingHostGraph = undefined;
  render();
}

async function mountNativeChannels() {
  const [{ mountSkin }, { revealNativeCover }] = await Promise.all([
    import("../../skin-contract/web/skin.mjs"),
    import("../../skin-contract/web/startup.mjs"),
  ]);
  const ready = Promise.withResolvers();
  const startup = new AbortController();
  const cover = host.window.requiresStartup() ? revealNativeCover({
    post: ({ phase }) => {
      if (phase === "show") host.window.showUnderCover();
      if (phase === "complete") host.window.presentFrame();
      if (phase === "failed") host.window.startupFailed();
    },
    stateReady: ready.promise,
    fontsReady: document.fonts.ready,
    pageReady: layoutReady,
    signal: startup.signal,
  }) : Promise.resolve();
  cover.catch(reportHostError);
  try {
    const unmount = await mountSkin(host, state => {
      hostState = state;
      setTheme(state.appearance?.theme);
      localizeToolbar();
      if (!state.graph) return;
      const next = projectHostGraph(state, t);
      const signature = JSON.stringify(next);
      if (signature !== hostSignature) {
        hostSignature = signature;
        pendingHostGraph = next;
        applyHostNodes();
      }
      ready.resolve();
    }, reportHostError, { borrowState: true });
    window.addEventListener("pagehide", event => { if (!event.persisted) unmount(); }, { once: true });
    await cover;
  } catch (error) {
    startup.abort(error);
    throw error;
  }
}

function editNode(node, kind = node.kind) {
  const noun = kind === "input" ? "输入" : "输出";
  const content = element("div", "fields");
  const name = element("input");
  name.required = true;
  name.maxLength = 36;
  name.value = node?.name || "";
  name.placeholder = "通道名称";
  name.autofocus = true;
  name.addEventListener("input", () => name.setCustomValidity(name.value.trim() ? "" : "请输入通道名称"));
  const device = choices(devices[kind], Math.max(0, devices[kind].indexOf(node?.device)));
  if (kind === "output") {
    const used = new Set(graph.nodes.filter(item => item.kind === "output" && item.id !== node?.id).map(item => item.device));
    for (const option of device.options) option.disabled = used.has(devices.output[Number(option.value)]);
    if (!node) {
      const available = [...device.options].find(option => !option.disabled);
      if (!available) { message("所有示例输出已在画布中，可将连线接到现有输出", true); return; }
      device.value = available.value;
    }
  }
  content.append(field("名称", name), field("设备", device));
  openEditor({
    title: node ? noun + "设置" : "新建" + noun,
    content,
    description: kind === "input" ? "同一硬件输入可以被多个输入方框使用。" : "",
    confirm: node ? "保存" : "新建",
    submit() {
      const updated = { ...node, id: node?.id || crypto.randomUUID(), kind, name: name.value.trim(), device: devices[kind][Number(device.value)], effects: node?.effects || [] };
      if (!node && kind === "input") updated.color = "#7fafd0";
      const nodes = node ? graph.nodes.map(item => item.id === node.id ? updated : item) : [...graph.nodes, updated];
      setGraph({ ...graph, nodes }, node ? "设置已保存" : "已新建" + noun, updated.id);
    },
    remove: node && (() => {
      const nodes = graph.nodes.filter(item => item.id !== node.id);
      const routes = graph.routes.filter(route => route.from !== node.id && route.to !== node.id);
      setGraph({ nodes, routes }, "已删除方框及相关连线");
    }),
  });
}

function editEffects(item, focusIndex) {
  const content = element("div", "fields");
  const list = element("div", "effect-list");
  const effectChoice = choices(effects, 0);
  const chain = item.effects.map((name, index) => ({ name, id: effectIdAt(item, index) }));
  const add = button("", "添加效果器", () => {
    chain.push({ name: effects[Number(effectChoice.value)], id: crypto.randomUUID() });
    renderEffects();
  });
  add.textContent = "添加";
  const addRow = element("div", "effect-row");
  addRow.append(field("添加效果器", effectChoice), add);

  function renderEffects() {
    list.replaceChildren();
    if (!chain.length) list.append(element("span", "dialog-description", "暂无效果器"));
    for (const [index, { name: effect }] of chain.entries()) {
      const row = element("div", "effect-row");
      row.append(element("span", "", effect));
      for (const [step, label, glyph] of [[-1, "上移", "↑"], [1, "下移", "↓"], [0, "移除", "×"]]) {
        const action = button("", label + effect, () => {
          if (step) [chain[index], chain[index + step]] = [chain[index + step], chain[index]];
          else chain.splice(index, 1);
          renderEffects();
          const next = list.children[index + step] || list.lastElementChild;
          (next?.querySelector("button:not(:disabled)") || effectChoice).focus();
        });
        action.textContent = glyph;
        action.disabled = step !== 0 && (index + step < 0 || index + step >= chain.length);
        row.append(action);
      }
      list.append(row);
    }
  }
  renderEffects();
  content.append(addRow, list);
  const hasSends = graph.routes.some(route => route.to === item.id && route.sidechainEffectId);
  openEditor({
    title: item.name + " · 效果器",
    description: hasSends ? "移除带发送的效果器时，相应连线会一起移除。" : "",
    content,
    submit() {
      const updated = { ...item, effects: chain.map(effect => effect.name), effectIds: chain.map(effect => effect.id) };
      const nodes = graph.nodes.map(node => node.id === item.id ? updated : node);
      const routes = graph.routes.filter(route => route.to !== item.id || !route.sidechainEffectId ||
        updated.effectIds.includes(route.sidechainEffectId));
      const notice = routes.length === graph.routes.length ? "效果链已保存" : "效果链已保存，已清除失去来源的连线";
      setGraph({ nodes, routes }, notice, item.id);
    },
  });
  if (focusIndex === -1) effectChoice.focus();
  if (focusIndex >= 0) list.children[focusIndex]?.querySelector("button:not(:disabled)")?.focus();
}

function editRoute(route) {
  const from = graph.nodes.find(node => node.id === route.from);
  const to = graph.nodes.find(node => node.id === route.to);
  const content = element("div", "fields");
  const tap = choices(tapNames.map(t), route.tap);
  const gain = element("input");
  gain.type = "number";
  gain.min = "-60";
  gain.max = "12";
  gain.step = "0.1";
  gain.required = true;
  gain.value = route.gain ?? 0;
  content.append(field(t("取样位置"), tap), field(t("发送增益 dB"), gain));
  openEditor({
    title: t("发送设置"),
    description: from.name + " → " + (route.sidechainLabel || to.name),
    content,
    submit() {
      if (host) {
        const identity = expectedSend(route, from.channel);
        const save = async () => {
          if (Number(tap.value) !== route.tap) await host.channel.setSendTap(from.channel.id, route.index, Number(tap.value), identity);
          if (gain.valueAsNumber !== route.gain) await host.channel.setSendLevel(from.channel.id, route.index, gain.valueAsNumber, identity);
        };
        void save().catch(reportHostError);
        return;
      }
      const updated = { ...route, gain: gain.valueAsNumber };
      updated.tap = Number(tap.value);
      setGraph({ ...graph, routes: graph.routes.map(item => item.id === route.id ? updated : item) }, "发送设置已保存");
      wireElements.get(route.id)?.hit.focus({ preventScroll: true });
    },
    remove: () => {
      if (host) {
        void host.channel.removeSend(from.channel.id, route.index, expectedSend(route, from.channel)).catch(reportHostError);
        return;
      }
      setGraph({ ...graph, routes: graph.routes.filter(item => item.id !== route.id) }, "连线已删除", route.from);
    },
  });
}

function switchSkin() {
  const id = "legacy-guest";
  if (graph.nodes.some(node => node.id === id)) {
    message("来宾人声已拆分，可在画布查看");
    return;
  }
  const legacy = {
    id, kind: "input", name: "来宾人声", device: devices.input[0], color: "#b49bcb", effects: ["压缩"],
    nativeOutput: devices.output[0], outputName: "耳返", nativeSend: { tap: 2, gain: -6 },
  };
  const content = element("dl", "migration");
  for (const [label, value] of [["原通道", legacy.name], ["输入", legacy.device], ["输出", legacy.nativeOutput], ["拆分后", "来宾人声 → 现有或新建的耳返输出"]]) {
    const row = element("div");
    row.append(element("dt", "", label), element("dd", "", value));
    content.append(row);
  }
  openEditor({
    title: "同一通道同时绑定输入和输出，是否拆分？",
    description: "保留输入与原有效果器，原输出改为显式连线，保留发送增益和取样位置。",
    content,
    confirm: "拆分并切换",
    submit() {
      const outputId = crypto.randomUUID();
      const next = splitLegacy(graph, legacy, outputId, crypto.randomUUID());
      setGraph(next, "已拆分来宾人声，并保留原发送设置", legacy.id);
    },
  });
}

function closeDeviceMenu(restoreFocus = false) {
  if (!deviceTrigger) return;
  if (deviceTrigger.matches("[data-add]")) deviceTrigger.setAttribute("aria-expanded", "false");
  deviceMenu.hidden = true;
  if (restoreFocus) deviceTrigger.focus({ preventScroll: true });
  deviceTrigger = undefined;
}

function showDeviceMenu(trigger, rows, anchor, label) {
  closeDeviceMenu();
  deviceMenu.replaceChildren(...rows);
  deviceMenu.setAttribute("aria-label", t(label));
  deviceMenu.style.left = "0";
  deviceMenu.style.top = "0";
  deviceMenu.hidden = false;
  const { clientWidth, clientHeight } = document.documentElement;
  deviceMenu.style.left = Math.max(3, Math.min(anchor.x, clientWidth - deviceMenu.offsetWidth - 3)) + "px";
  deviceMenu.style.top = Math.max(3, Math.min(anchor.y, clientHeight - deviceMenu.offsetHeight - 3)) + "px";
  deviceTrigger = trigger;
  if (trigger.matches("[data-add]")) trigger.setAttribute("aria-expanded", "true");
  rows.find(row => !row.disabled)?.focus();
}

function createDemoNode(kind, device) {
  const id = crypto.randomUUID();
  const node = { id, kind, name: kind === "input" ? "输入" : "输出总线", device, effects: [], color: "#7fafd0" };
  const nodes = [...graph.nodes, node];
  const routes = [...graph.routes];
  if (kind === "output") {
    let endpoint = nodes.find(item => item.terminal && item.device === device);
    if (!endpoint) {
      endpoint = { id: crypto.randomUUID(), kind: "output", name: "设备输出", device, effects: [], terminal: true, hardwareOutput: true };
      nodes.push(endpoint);
    }
    node.device = "";
    routes.push({ id: crypto.randomUUID(), from: id, to: endpoint.id, tap: 2, gain: 0 });
  }
  setGraph({ nodes, routes }, "已新建" + (kind === "input" ? "输入" : "输出总线"), id);
}

function openDeviceMenu(trigger, kind, anchor) {
  const entries = host ? deviceChoices(hostState, kind) : devices[kind].map(label => ({ label }));
  const rows = entries.map(entry => {
    const option = button("", entry.label, () => {
      closeDeviceMenu(true);
      if (!host) return createDemoNode(kind, entry.label);
      if (!host.channel.addNode) { message("请更新声核以直接从设备新建节点", true); return; }
      void host.channel.addNode(kind, entry.index, entry.binding).catch(reportHostError);
    });
    option.textContent = entry.label;
    return option;
  });
  if (!rows.length) {
    const empty = button("", t("暂无已配置设备"), () => {});
    empty.textContent = t("暂无已配置设备");
    empty.disabled = true;
    rows.push(empty);
  }
  showDeviceMenu(trigger, rows, anchor, "选择设备");
}

function isCanvasBlank(target) {
  return target === workspace || target === viewport || target === board;
}

workspace.addEventListener("contextmenu", event => {
  if (!isCanvasBlank(event.target)) return;
  event.preventDefault();
  const anchor = { x: event.clientX, y: event.clientY };
  const rows = [["input", "新建输入"], ["output", "新建输出"]].map(([kind, label]) => {
    const choice = button("", t(label), () => openDeviceMenu(board, kind, anchor));
    choice.textContent = t(label);
    return choice;
  });
  const arrange = button("", t("自动排布"), () => {
    closeDeviceMenu(true);
    arrangeCanvas();
  });
  arrange.textContent = t("自动排布");
  arrange.disabled = !cardElements.size;
  rows.push(arrange);
  showDeviceMenu(board, rows, anchor, "画布菜单");
});

document.addEventListener("pointerdown", event => {
  if (deviceTrigger && !deviceMenu.contains(event.target) && !event.target.closest("[data-add]")) closeDeviceMenu();
});
document.addEventListener("keydown", event => {
  if (!deviceTrigger) return;
  if (event.key === "Escape") closeDeviceMenu(true);
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  const buttons = [...deviceMenu.querySelectorAll("button:not(:disabled)")];
  if (!buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next = index < 0 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length;
  buttons[next].focus();
});

if (!host) {
  themeButton.hidden = false;
  themeButton.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    setTheme(theme);
    void storeLayout("theme", theme);
  });
}
const demoSwitch = select("#switch-skin");
demoSwitch.hidden = Boolean(host);
demoSwitch.addEventListener("click", switchSkin);
const titlebar = select(".titlebar");
const minimize = select("#window-minimize");
const hide = select("#window-hide");
const restore = select("#window-restore");
const settingsButton = select("#settings");
hide.append(icon("hide"));
settingsButton.append(icon("settings"));
const addButtons = [...document.querySelectorAll("[data-add]")];

function localizeToolbar() {
  for (const add of addButtons) {
    add.lastChild.textContent = t(add.dataset.add === "input" ? "新建输入" : "新建输出");
  }
  for (const [control, key] of [[minimize, "最小化"], [hide, "隐藏"], [zoomButton, "居中并恢复 100%"], [settingsButton, "设置"]]) {
    const label = t(key);
    control.setAttribute("aria-label", label);
    control.title = label;
  }
  select("#remove").textContent = t("删除");
  dialog.querySelector(".dialog-actions [data-close]").textContent = t("取消");
}

function setPreviewWindow(state, focus) {
  titlebar.dataset.window = state;
  workspace.hidden = state !== "open";
  restore.hidden = state === "open";
  focus.focus();
}

minimize.addEventListener("click", () => {
  if (host) void host.window.minimize().catch(reportHostError);
  else setPreviewWindow("minimized", restore);
});
hide.addEventListener("click", () => {
  if (host) void host.window.close().catch(reportHostError);
  else setPreviewWindow("hidden", restore);
});
restore.addEventListener("click", () => setPreviewWindow("open", minimize));
addButtons.forEach(add => {
  add.prepend(icon("plus"));
  add.setAttribute("aria-expanded", "false");
  add.setAttribute("aria-controls", "device-menu");
  add.addEventListener("click", () => {
    if (deviceTrigger === add) return closeDeviceMenu();
    const rect = add.getBoundingClientRect();
    openDeviceMenu(add, add.dataset.add, { x: rect.left, y: rect.bottom + 4 });
  });
});
void layoutReady.then(() => {
  layoutLoaded = true;
  if (host) applyHostNodes();
  else render();
});
if (host) {
  const menu = select("#host-menu");
  titlebar.querySelector(":scope > img").hidden = true;
  titlebar.querySelector(":scope > strong").hidden = true;
  menu.hidden = false;
  menu.addEventListener("click", () => {
    const rect = menu.getBoundingClientRect();
    void host.menu.openSystem({ x: rect.left, y: rect.bottom }).catch(reportHostError);
  });
  settingsButton.disabled = false;
  settingsButton.addEventListener("click", () => { void host.settings.open().catch(reportHostError); });
  titlebar.dataset.windowDrag = "";
  workspace.dataset.windowDrag = "";
  const startWindowDrag = event => {
    if (event.button !== 0 || event.defaultPrevented || gesture || pan || spaceHeld) return;
    event.preventDefault();
    void host.window.startDrag().catch(reportHostError);
  };
  titlebar.addEventListener("pointerdown", event => {
    if (!event.target.closest("button")) startWindowDrag(event);
  });
  workspace.addEventListener("pointerdown", event => {
    if (isCanvasBlank(event.target)) startWindowDrag(event);
  });
  void mountNativeChannels().catch(reportHostError);
}
