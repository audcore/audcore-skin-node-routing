const assert = require("node:assert/strict");
const test = require("node:test");
const { devices, seed, routeError, splitLegacy, centerFromPixels, centerToPixels, migrateCanvasPosition, initialNodeLayout, hardwareOutputLayout,
  migrateLanePosition, openNativeEffectBrowser, portRoutes, zoomAt, roundedWire, routeAroundCards } = require("./model.js");

test("routing rejects duplicate sends, self routes and transitive feedback", () => {
  const graph = seed();
  graph.routes.push({ from: "bus", to: "dry" });
  assert.match(routeError(graph, "voice", "monitor"), /已有连线/);
  assert.match(routeError(graph, "voice", "voice"), /自己/);
  assert.match(routeError(graph, "dry", "music"), /反馈回路/);
  assert.match(routeError(graph, "monitor", "voice"), /反馈回路/);
  assert.equal(routeError(graph, "monitor", "record"), "");
  graph.nodes.find(node => node.id === "record").terminal = true;
  assert.match(routeError(graph, "record", "stream"), /有效/);
  assert.equal(routeError(graph, "dry", "monitor"), "");
  assert.equal(graph.nodes.find(node => node.id === "voice").device, graph.nodes.find(node => node.id === "dry").device);
});

test("wire bends stay rounded without overshooting short segments", () => {
  assert.equal(roundedWire([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 8 }]),
    "M 0 0 L 2 0 Q 4 0 4 2 L 4 8");
});

test("main wire takes a clear lane when a middle card blocks its curve", () => {
  const a = { x: 120, y: 44 };
  const b = { x: 400, y: 44 };
  const source = { left: 0, top: 20, right: 120, bottom: 100 };
  const target = { left: 400, top: 20, right: 520, bottom: 100 };
  const middle = { left: 210, top: 25, right: 330, bottom: 125 };
  assert.match(routeAroundCards(a, b, source, target, [source, target]), / C /);
  const detour = routeAroundCards(a, b, source, target, [source, middle, target]);
  const lane = [...detour.matchAll(/L (\d+) (-?\d+) Q/g)]
    .find(([, x]) => Number(x) > middle.right);
  assert.ok(lane && Number(lane[2]) < middle.top);
  assert.match(detour, /400 44$/);
});

test("splitting retains source identity, effects, gain and tap and reuses an output", () => {
  const graph = seed();
  const channel = {
    id: "guest", kind: "input", name: "来宾", device: devices.input[0], effects: ["压缩"],
    nativeOutput: devices.output[0], nativeSend: { gain: -6, tap: 1 }, outputName: "耳返",
  };
  const next = splitLegacy(graph, channel, "new-output", "new-route");
  assert.deepEqual(next.nodes.at(-1), { id: "guest", kind: "input", name: "来宾", device: devices.input[0], effects: ["压缩"] });
  assert.deepEqual(next.routes.at(-1), { id: "new-route", from: "guest", to: "monitor", gain: -6, tap: 1 });
  assert.equal(graph.nodes.some(node => node.id === "guest"), false);
  assert.equal(splitLegacy(graph, { ...channel, nativeOutput: devices.output[3] }, "new-output", "new-route").routes.at(-1).to, "new-output");
});

test("canvas centers round to hundredths without clipping and retain spacing when resized", () => {
  const viewport = { width: 440, height: 260 };
  assert.deepEqual(centerFromPixels(220, 130, viewport), { x: 0, y: 0 });
  const point = centerFromPixels(-1234.56, 1456.24, viewport);
  assert.deepEqual(point, { x: -145.46, y: 132.62 });
  const resized = { width: 640, height: 460 };
  const pixels = centerToPixels(point, resized);
  assert.deepEqual(centerFromPixels(pixels.x, pixels.y, resized), point);
  const old = migrateCanvasPosition({ x: 75, y: 80 }, { width: 120, height: 80 }, viewport, 570, 18);
  assert.deepEqual(centerToPixels(old, viewport), { x: 291, y: 421.2 });
});

test("initial graph layout places downstream nodes to the right and untangles branch order", () => {
  const nodes = ["music", "voice", "voiceBus", "musicBus", "monitor", "record"].map(id => ({ id }));
  nodes[4].terminal = nodes[5].terminal = true;
  const routes = [
    { from: "music", to: "musicBus" }, { from: "voice", to: "voiceBus" },
    { from: "musicBus", to: "monitor" }, { from: "voiceBus", to: "record" },
    { from: "musicBus", to: "voice", enabled: false }, { from: "voiceBus", to: "voice", sidechainEffectId: "sc" },
  ];
  const sizes = new Map(nodes.map(({ id }) => [id, { width: 120, height: id === "music" ? 260 : 90 }]));
  const viewport = { width: 434, height: 260 };
  const points = initialNodeLayout({ nodes, routes }, sizes, viewport, 18);
  assert.deepEqual(initialNodeLayout({ nodes, routes: routes.slice(0, 4) }, sizes, viewport, 18), points);
  for (const route of routes.slice(0, 4)) assert.ok(points.get(route.to).x > points.get(route.from).x + 120);
  assert.equal(points.get("monitor").x, points.get("record").x);
  const voiceAbove = points.get("voice").y < points.get("music").y;
  assert.equal(points.get("voiceBus").y < points.get("musicBus").y, voiceAbove);
  assert.equal(points.get("record").y < points.get("monitor").y, voiceAbove);
  for (const [a, b] of [["voice", "music"], ["voiceBus", "musicBus"], ["record", "monitor"]]) {
    const [first, second] = points.get(a).y < points.get(b).y ? [a, b] : [b, a];
    assert.ok(points.get(first).y + sizes.get(first).height < points.get(second).y);
  }
  assert.ok(points.get("monitor").x + sizes.get("monitor").width > viewport.width);
});

test("sidechain-only links do not change the layout and main sends align their ports", () => {
  const nodes = ["idle", "source", "bus", "output"].map(id => ({ id, terminal: id === "output" }));
  const main = [{ from: "source", to: "bus" }, { from: "bus", to: "output" }];
  const sidechains = [{ from: "idle", to: "source", sidechainEffectId: "sc" },
    { from: "bus", to: "idle", sidechainEffectId: "sc" }];
  const sizes = new Map(nodes.map(({ id }) => [id, { width: 120, height: id === "bus" ? 155 : 52 }]));
  const viewport = { width: 1040, height: 600 };
  const points = initialNodeLayout({ nodes, routes: main.concat(sidechains) }, sizes, viewport, 18);
  assert.deepEqual(points, initialNodeLayout({ nodes, routes: main }, sizes, viewport, 18));
  assert.equal(points.get("source").y, points.get("bus").y);
  assert.equal(points.get("bus").y, points.get("output").y);
});

test("original input bindings stay together on the left even when they receive sends", () => {
  const nodes = [{ id: "mix" }, { id: "reverb" }, { id: "music", hasSource: true },
    { id: "mic", hasSource: true }, { id: "recording", terminal: true },
    { id: "device", terminal: true, hardwareOutput: true }, { id: "monitor", terminal: true, hardwareOutput: true }];
  const routes = [{ from: "reverb", to: "music" }, { from: "mic", to: "reverb" },
    { from: "music", to: "mix" }, { from: "mix", to: "device" },
    { from: "mix", to: "recording" }, { from: "mic", to: "monitor" }];
  const sizes = new Map(nodes.map(({ id }) => [id, { width: 120, height: 80 }]));
  const points = initialNodeLayout({ nodes, routes }, sizes, { width: 440, height: 260 }, 18);
  assert.equal(points.get("mic").x, points.get("music").x);
  for (const id of ["reverb", "mix", "device"]) assert.ok(points.get(id).x > points.get("mic").x);
  assert.equal(points.get("device").x, points.get("monitor").x);
  assert.ok(points.get("recording").x < points.get("device").x);
});

test("saved device endpoints are repaired to the right and fan out around their source", () => {
  const nodes = [{ id: "mix" }, { id: "monitor" }, { id: "phones", hardwareOutput: true },
    { id: "playback", hardwareOutput: true }, { id: "recording", terminal: true }];
  const routes = [{ from: "monitor", to: "phones" }, { from: "monitor", to: "playback" },
    { from: "mix", to: "phones", sidechainEffectId: "ignored" }];
  const bounds = new Map([
    ["mix", { left: 280, top: 24, right: 400, bottom: 100 }],
    ["monitor", { left: 600, top: 300, right: 720, bottom: 380 }],
    ["phones", { left: 24, top: 20, right: 144, bottom: 72 }],
    ["playback", { left: 80, top: 60, right: 200, bottom: 112 }],
    ["recording", { left: 525, top: 100, right: 645, bottom: 152 }],
  ]);
  const points = hardwareOutputLayout({ nodes, routes }, bounds);
  assert.deepEqual([...points.values()], [{ x: 776, y: 266 }, { x: 776, y: 334 }]);
  for (const [id, { x, y }] of points) bounds.set(id, { left: x, top: y, right: x + 120, bottom: y + 52 });
  assert.deepEqual(hardwareOutputLayout({ nodes, routes }, bounds), points);
});

test("old lane coordinates migrate once into the appropriate side of the free canvas", () => {
  assert.deepEqual(migrateLanePosition({ x: 25.55, y: 44.12 }, "input"), { x: 7.32, y: 44.12 });
  assert.deepEqual(migrateLanePosition({ x: 100, y: 66.67 }, "output"), { x: 96, y: 66.67 });
});

test("the add effect action invokes the host browser with the real channel identity", async () => {
  const calls = [];
  const host = { effect: { async openBrowser(...args) { calls.push(args); } } };
  await openNativeEffectBrowser(host, { id: 7, chain_uuid: "chain", source_uuid: "source" });
  assert.deepEqual(calls, [[7, { chain_uuid: "chain", source_uuid: "source" }]]);
});

test("a sidechain input and a channel input on the same node are separate targets", () => {
  const graph = seed();
  const effect = { from: "voice", to: "dry", sidechainEffectId: "dry/0" };
  const channel = { from: "voice", to: "dry" };
  assert.equal(routeError(graph, "voice", "dry", effect.sidechainEffectId), "");
  assert.match(routeError(graph, "voice", "dry", "unknown"), /暂不可用/);
  graph.routes.push(effect);
  assert.match(routeError(graph, "voice", "dry", effect.sidechainEffectId), /已有连线/);
  assert.equal(routeError(graph, "voice", "dry"), "");
  assert.match(routeError(graph, "dry", "voice"), /反馈回路/);
  graph.routes.push(channel);
  assert.deepEqual(portRoutes(graph, { id: "dry", sidechainEffectId: "dry/0" }, "in"), [effect]);
  assert.deepEqual(portRoutes(graph, { id: "dry" }, "in"), [channel]);
  assert.deepEqual(portRoutes({ routes: [effect, channel] }, { id: "voice" }, "out"), [effect, channel]);
});

test("zoom retains the exact canvas point under the cursor through zoom limits", () => {
  const start = { x: -80, y: 35, scale: .75 };
  const cursor = { x: 250, y: 117 };
  for (const factor of [.01, .8, 1.5, 10]) {
    const view = zoomAt(start, cursor, factor);
    assert.equal(view.scale, Math.max(.1, Math.min(1, start.scale * factor)));
    for (const axis of ["x", "y"]) {
      assert.ok(Math.abs((cursor[axis] - view[axis]) / view.scale - (cursor[axis] - start[axis]) / start.scale) < 1e-9);
    }
  }
});
