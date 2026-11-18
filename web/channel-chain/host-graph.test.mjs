import assert from "node:assert/strict";
import test from "node:test";
import { deviceChoices, expectedSend, projectHostGraph } from "./host-graph.mjs";
import { nodeTitle } from "./labels.mjs";

test("playback is abbreviated on hardware cards only", () => {
  const playback = { name: "PLAYBACK 5/6", hardwareOutput: true };
  assert.equal(nodeTitle(playback), "BACK 5/6");
  assert.equal(playback.name, "PLAYBACK 5/6");
  assert.equal(nodeTitle({ name: "PLAYBACK 5/6" }), "PLAYBACK 5/6");
  assert.equal(nodeTitle({ name: "Analog Out 1/2", hardwareOutput: true }), "Analog Out 1/2");
});

test("host output buses can send to other buses and actual hardware terminals", () => {
  const sends = [
    { id: "send1", dest: { kind: "chain", id: 1 }, tap: 2, level_db: -6 },
    { id: "send2", dest: { kind: "output", pair: 0 }, tap: 1, level_db: 0 },
  ];
  const channels = [
    { id: 0, chain_uuid: "a", purpose: "node_output_bus", rack: [], sends },
    { id: 1, chain_uuid: "b", purpose: "node_output_bus", rack: [], sends: [], color: "#123456", displayColor: "#abcdef" },
  ];
  const graph = { chains: channels, output_pairs: [10], output: "Fireface" };
  const { nodes, routes } = projectHostGraph({ channels, graph });
  assert.deepEqual(nodes.map(node => [node.kind, Boolean(node.terminal), node.targetId]), [
    ["output", false, "chain:0"], ["output", false, "chain:1"], ["output", true, "output:0"],
  ]);
  assert.deepEqual(routes.map(route => route.to), ["host/b", nodes[2].id]);
  assert.deepEqual(nodes.map(node => node.color), ["#38b9ec", "#abcdef", undefined]);
  assert.deepEqual(expectedSend(routes[0], channels[0]), {
    id: "send1", dest: sends[0].dest, output_channel: null, channel: { chain_uuid: "a", source_uuid: null },
  });
  assert.deepEqual(deviceChoices({ graph, outputLabels: { 0: { stereo: "Analog Out 11/12" } } }, "output"),
    [{ index: 0, label: "Analog Out 11/12", binding: [10, null, null, "Fireface"] }]);
  assert.deepEqual(deviceChoices({ graph }, "output"), [{ index: 0, label: "Fireface · 11/12", binding: [10, null, null, "Fireface"] }]);
});

test("device dropdown uses pair labels rather than channel labels or a saved endpoint ID", () => {
  const graph = { backend: "asio", input: "driver", input_pairs: [0], input_devices: { 0: { backend: "asio", name: "device-id" } } };
  assert.deepEqual(deviceChoices({ graph, inputLabels: { 0: "Different channel input" }, inputPairLabels: { 0: "Analog In 1/2" } }, "input"),
    [{ index: 0, label: "Analog In 1/2", binding: [0, graph.input_devices[0], "asio", "driver"] }]);
});

test("original input status follows actual device, virtual and managed input bindings", () => {
  const channels = [{ id: 0, inputs: [0] }, { id: 1, virtual_input: {} },
    { id: 2, rack: [{ alias: "@wdm-play-2" }] }, { id: 3, rack: [{ alias: "@wdm-rec-2" }] }, { id: 4, inputs: [] }];
  const { nodes } = projectHostGraph({ channels, graph: {} });
  assert.deepEqual(nodes.map(node => node.hasSource), [true, true, true, false, false]);
});

test("sidechain ports use host capabilities and retain existing sends while a plugin is offline", () => {
  const send = { dest: { kind: "sidechain", instance: 12 }, level_db: 0 };
  const channels = [
    { id: 0, rack: [], sends: [send] },
    { id: 1, rack: [{ instance: 12, effect_uuid: "duck" }, { instance: 13, offline: true },
      { instance: 14 }, { instance: 15, alias: "@wdm-play-2" }], sends: [] },
  ];
  const graph = { chains: channels };
  const effectInfo = { 12: { hasSidechain: true }, 13: { hasSidechain: true }, 15: { hasSidechain: true } };
  const { nodes, routes } = projectHostGraph({ channels, graph, effectInfo });
  assert.deepEqual(nodes[1].sidechainTargets, { duck: "sidechain:12" });
  assert.equal(routes[0].sidechainEffectId, "duck");
  const offline = projectHostGraph({ channels, graph, effectInfo, missingEffects: { 12: true } });
  assert.deepEqual(offline.nodes[1].sidechainTargets, {});
  assert.equal(offline.routes[0].sidechainEffectId, "duck");
});
