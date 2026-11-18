import { channelDisplayColor } from "../channel-color.mjs";

function outputPair(graph, pair, lane = null) {
  const endpoint = graph.output_devices?.[pair];
  const offset = graph.output_pairs?.[pair];
  const device = endpoint?.name || graph.output || "";
  const channel = lane === null ? "stereo" : String(lane);
  const identity = JSON.stringify([endpoint?.backend ?? graph.backend ?? "", device, offset ?? pair, channel]);
  return { id: "output/" + identity, pair, lane, device, offset, channel };
}

function outputNode(state, pair, lane, t) {
  const endpoint = outputPair(state.graph, pair, lane);
  const { id, device, offset, channel } = endpoint;
  const number = Number.isSafeInteger(offset) ? offset : pair * 2;
  const label = lane === null ? `${number + 1}/${number + 2}` : String(number + lane + 1);
  return {
    id, kind: "output", terminal: true, hardwareOutput: true, name: state.outputLabels?.[pair]?.[channel] || `${t("输出")} ${label}`,
    device: device || (offset === undefined ? t("设备不可用") : label),
    targetId: offset === undefined ? undefined : lane === null ? `output:${pair}` : `output:${pair}:${lane}`,
    effects: [],
  };
}

export function deviceChoices(state, kind) {
  const graph = state?.graph;
  return (graph?.[kind + "_pairs"] ?? []).map((offset, index) => {
    const endpoint = graph[kind + "_devices"]?.[index] ?? null;
    const device = endpoint?.name || graph[kind] || "";
    const channels = `${offset + 1}/${offset + 2}`;
    const label = kind === "input" ? state.inputPairLabels?.[index] : state.outputLabels?.[index]?.stereo;
    return { index, label: label || (device ? device + " · " + channels : channels),
      binding: [offset, endpoint, graph.backend ?? null, graph[kind] ?? null] };
  });
}

function isRouteBridge(slot) {
  const match = /^@wdm-(?:play|rec)-(\+?\d+)$/.exec(slot.alias ?? "");
  return Boolean(match && Number(match[1]) <= 255);
}

export function projectHostGraph(state, t = text => text) {
  const sidechainInstances = new Set(state.sidechains ?? Object.entries(state.effectInfo ?? {})
    .filter(([, info]) => info?.hasSidechain === true).map(([instance]) => Number(instance)));
  const inputs = (state.channels ?? []).filter(channel => !channel.hidden).map(channel => ({
    id: "host/" + (channel.chain_uuid ?? channel.source_uuid ?? channel.id),
    kind: channel.purpose === "node_output_bus" ? "output" : "input",
    hasSource: Boolean(channel.inputs?.length || channel.virtual_input ||
      (channel.rack ?? []).some(slot => slot.alias?.startsWith("@wdm-play-") && isRouteBridge(slot))),
    name: channel.name || (channel.purpose === "node_output_bus" ? t("输出总线") : state.channelLabels?.[channel.id] || t("通道") + " " + (channel.id + 1)),
    device: channel.purpose === "node_output_bus" ? "" : state.inputLabels?.[channel.id] || t("仅接收连线"),
    color: channelDisplayColor(channel),
    effects: (channel.rack ?? []).map(slot => state.effectLabels?.[slot.instance] ||
      slot.alias || state.effectInfo?.[slot.instance]?.name || slot.name || t("效果器")),
    effectIds: (channel.rack ?? []).map(slot => String(slot.effect_uuid ?? slot.instance)),
    sidechainTargets: Object.fromEntries((channel.rack ?? []).filter(slot => !slot.offline &&
      !state.missingEffects?.[slot.instance] && sidechainInstances.has(slot.instance) && !isRouteBridge(slot)).map(slot => [
      String(slot.effect_uuid ?? slot.instance), "sidechain:" + slot.instance,
    ])),
    targetId: "chain:" + channel.id,
    channel,
  }));
  const byChannel = new Map(inputs.map(node => [node.channel.id, node]));
  const outputs = new Map();
  const routes = [];
  const sidechains = new Map(inputs.flatMap(node => (node.channel.rack ?? []).map(slot => [slot.instance, { node, slot }])));
  for (const source of inputs) {
    for (const [index, send] of (source.channel.sends ?? []).entries()) {
      const { dest } = send;
      let target;
      let sidechain;
      if (dest.kind === "chain") target = byChannel.get(dest.id);
      if (dest.kind === "sidechain") {
        sidechain = sidechains.get(dest.instance);
        target = sidechain?.node;
      }
      if (dest.kind === "output") target = outputNode(state, dest.pair, send.output_channel ?? null, t);
      if (dest.kind === "virtual_recording") {
        target = { id: "recording/" + dest.endpoint, kind: "output", terminal: true, effects: [],
          name: t(dest.endpoint === "vocal" ? "人声录制" : "混音录制"), device: "Audcore REC" };
      }
      if (!target) continue;
      if (target.terminal) outputs.set(target.id, target);
      routes.push({
        id: JSON.stringify([source.id, send.id ?? index, send.dest, send.output_channel ?? null]),
        from: source.id, to: target.id, tap: send.tap ?? 2, gain: send.level_db,
        enabled: send.enabled !== false, index, send,
        sidechainLabel: sidechain && (state.sidechainLabels?.[dest.instance] ||
          (sidechain.slot.alias || sidechain.slot.name || "效果器") + " · 侧链"),
        sidechainEffectId: sidechain && String(sidechain.slot.effect_uuid ?? sidechain.slot.instance),
      });
    }
  }
  return { nodes: [...inputs, ...outputs.values()], routes };
}

export function expectedSend(route, channel) {
  const { send } = route;
  return { id: send.id ?? null, dest: send.dest, output_channel: send.output_channel ?? null,
    channel: { chain_uuid: channel.chain_uuid ?? null, source_uuid: channel.source_uuid ?? null } };
}
