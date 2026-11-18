(function (root) {
  "use strict";

  const tapNames = ["效果前", "推子前", "推子后"];
  const effects = ["降噪", "均衡", "压缩", "齿音抑制", "混响", "限幅", "声像"];
  const devices = {
    input: ["Fireface USB · 输入 1", "Fireface USB · 输入 9/10", "声核输入 1/2", "仅接收连线"],
    output: ["Fireface USB · 输出 11/12", "声核输出 1/2", "声核输出 3/4", "声核输出 5/6", "声核输出 7/8"],
  };

  function seed() {
    return {
      nodes: [
        { id: "voice", kind: "input", name: "主麦克风", device: devices.input[0], effects: ["降噪", "均衡", "压缩"], color: "#7fafd0" },
        { id: "dry", kind: "input", name: "麦克风分支", device: devices.input[0], effects: ["压缩"],
          sidechainTargets: { "dry/0": "sidechain:dry/0" }, color: "#b49bcb" },
        { id: "music", kind: "input", name: "伴奏", device: devices.input[1], effects: [], color: "#d1ad73" },
        { id: "bus", kind: "input", name: "直播总线", device: devices.input[3], effects: ["限幅"], color: "#80b39d" },
        { id: "monitor", kind: "output", hardwareOutput: true, name: "耳返", device: devices.output[0], effects: [] },
        { id: "stream", kind: "output", hardwareOutput: true, name: "直播混音", device: devices.output[1], effects: [] },
        { id: "record", kind: "output", hardwareOutput: true, name: "人声录制", device: devices.output[2], effects: [] },
      ],
      routes: [
        { id: "ear", from: "voice", to: "monitor", tap: 2, gain: 0 },
        { id: "vocal", from: "voice", to: "record", tap: 2, gain: -3 },
        { id: "backing", from: "music", to: "bus", tap: 2, gain: 0 },
        { id: "live", from: "bus", to: "stream", tap: 2, gain: 0 },
      ],
    };
  }

  function effectIdAt(node, index) {
    return node.effectIds?.[index] ?? node.id + "/" + index;
  }

  function routeError(graph, from, to, sidechainEffectId) {
    const source = graph.nodes.find(node => node.id === from && !node.terminal);
    const target = graph.nodes.find(node => node.id === to);
    if (!source || !target) return "请选择有效的起点和目标";
    if (sidechainEffectId && !Object.hasOwn(target.sidechainTargets ?? {}, sidechainEffectId)) return "此发送目标暂不可用";
    if (from === to) return "通道不能连到自己";
    if (graph.routes.some(route => route.from === from && route.to === to &&
        route.sidechainEffectId === sidechainEffectId)) return "这个发送口到目标已有连线";
    const pending = [to];
    const visited = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === from) return "这条连线会形成反馈回路";
      if (visited.has(id)) continue;
      visited.add(id);
      for (const route of graph.routes) if (route.from === id && route.enabled !== false) pending.push(route.to);
    }
    return "";
  }

  function portRoutes(graph, endpoint, direction) {
    return graph.routes.filter(route => direction === "out" ? route.from === endpoint.id :
      route.to === endpoint.id && route.sidechainEffectId === endpoint.sidechainEffectId);
  }

  function splitLegacy(graph, channel, outputId, routeId) {
    const output = graph.nodes.find(node => node.kind === "output" && node.device === channel.nativeOutput);
    const { nativeOutput, nativeSend, ...input } = channel;
    const target = output || { id: outputId, kind: "output", hardwareOutput: true, name: channel.outputName, device: nativeOutput, effects: [] };
    delete input.outputName;
    const next = { nodes: [...graph.nodes, input], routes: [...graph.routes] };
    if (!output) next.nodes.push(target);
    const error = routeError(next, input.id, target.id);
    if (error) throw new Error(error);
    next.routes.push({ ...nativeSend, id: routeId, from: input.id, to: target.id });
    return next;
  }

  function percentage(value) {
    return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
  }

  // A fixed world scale keeps node spacing stable when the window is resized.
  const pixelsPerPercent = 10;
  const roundCanvasPercent = value => Math.round(value * 100) / 100;

  function centerFromPixels(x, y, viewport) {
    return {
      x: roundCanvasPercent((x - viewport.width / 2) / pixelsPerPercent),
      y: roundCanvasPercent((y - viewport.height / 2) / pixelsPerPercent),
    };
  }

  function centerToPixels(point, viewport) {
    return { x: viewport.width / 2 + point.x * pixelsPerPercent, y: viewport.height / 2 + point.y * pixelsPerPercent };
  }

  function migrateCanvasPosition(point, size, viewport, oldHeight, inset) {
    const left = inset + Math.max(0, viewport.width - size.width - inset * 2) * point.x / 100;
    const top = inset + Math.max(0, oldHeight - size.height - inset * 2) * point.y / 100;
    return centerFromPixels(left + size.width / 2, top + size.height / 2, viewport);
  }

  function initialNodeLayout(graph, sizes, viewport, inset) {
    const horizontalGap = 56;
    const verticalGap = 24;
    const nodes = new Map(graph.nodes.map(({ id, kind, terminal, hasSource, hardwareOutput, device }) => [id, {
      id, kind, terminal, hardwareOutput, hasSource: hasSource ?? (kind === "input" && device !== devices.input.at(-1) && devices.input.includes(device)),
      ...sizes.get(id), outgoing: new Set(), incoming: new Set(), rank: 0,
    }]));
    if ([...nodes.values()].some(node => node.hasSource)) {
      for (const node of nodes.values()) node.rank = node.hasSource ? 0 : 1;
    }

    function reaches(start, goal) {
      const pending = [start];
      const visited = new Set();
      while (pending.length) {
        const node = pending.pop();
        if (node === goal) return true;
        if (visited.has(node)) continue;
        visited.add(node);
        for (const target of node.outgoing) pending.push(target);
      }
      return false;
    }

    for (const route of graph.routes) {
      if (route.enabled === false || route.sidechainEffectId) continue;
      const from = nodes.get(route.from);
      const to = nodes.get(route.to);
      if (!from || !to || from.terminal || to.hasSource || from.outgoing.has(to) || reaches(to, from)) continue;
      from.outgoing.add(to);
      to.incoming.add(from);
    }

    const pending = new Map(Array.from(nodes.values(), node => [node, node.incoming.size]));
    const queue = Array.from(nodes.values()).filter(node => !node.incoming.size);
    for (const node of queue) {
      for (const target of node.outgoing) {
        target.rank = Math.max(target.rank, node.rank + 1);
        const remaining = pending.get(target) - 1;
        pending.set(target, remaining);
        if (!remaining) queue.push(target);
      }
    }

    const hasHardwareOutput = [...nodes.values()].some(node => node.hardwareOutput);
    const isOutput = node => hasHardwareOutput ? node.hardwareOutput :
      node.terminal || (!node.hasSource && node.kind === "output" && !node.outgoing.size);
    const outputRank = Math.max(0, ...Array.from(nodes.values(), node => node.rank + Number(!isOutput(node))));
    const layers = Array.from({ length: outputRank + 1 }, () => []);
    for (const node of nodes.values()) {
      if (isOutput(node)) node.rank = outputRank;
      layers[node.rank].push(node);
    }
    const columns = layers.filter(layer => layer.length);
    const anchor = (node, links, coordinate) => {
      let weighted = 0;
      let total = 0;
      for (const neighbor of links) {
        const weight = 1 / Math.max(1, Math.abs(neighbor.rank - node.rank));
        weighted += neighbor[coordinate] * weight;
        total += weight;
      }
      return total ? weighted / total : node[coordinate];
    };
    const setOrder = column => column.forEach((node, index) => { node.order = (index + .5) / column.length; });
    columns.forEach(setOrder);
    for (const forward of [true, false, true, false]) {
      for (const column of forward ? columns : columns.toReversed()) {
        const anchors = new Map(column.map(node => [node, anchor(node, forward ? node.incoming : node.outgoing, "order")]));
        column.sort((a, b) => anchors.get(a) - anchors.get(b));
        setOrder(column);
      }
    }

    const widths = columns.map(column => Math.max(...column.map(node => node.width)));
    const heights = columns.map(column => column.reduce((height, node) => height + node.height, 0) + verticalGap * (column.length - 1));
    const minWidth = inset * 2 + widths.reduce((sum, width) => sum + width, 0) + horizontalGap * Math.max(0, columns.length - 1);
    const minHeight = inset * 2 + Math.max(0, ...heights);
    const width = Math.max(minWidth, viewport.width);
    const height = Math.max(minHeight, viewport.height);
    const gap = horizontalGap + (width - minWidth) / Math.max(1, columns.length - 1);
    let x = inset;
    columns.forEach((column, index) => {
      const slack = (height - inset * 2 - heights[index]) / (column.length + 1);
      let y = inset + slack;
      for (const node of column) {
        node.x = x;
        node.y = y;
        y += node.height + verticalGap + slack;
      }
      x += widths[index] + gap;
    });

    // Main ports have the same vertical offset, so lining up card tops straightens a send.
    for (const forward of [true, false, true]) {
      const ordered = forward ? columns : columns.toReversed();
      for (const column of ordered) {
        let minimum = inset;
        let remaining = heights[columns.indexOf(column)];
        for (const node of column) {
          const desired = anchor(node, forward ? node.incoming : node.outgoing, "y");
          node.y = Math.max(minimum, Math.min(desired, height - inset - remaining));
          const advance = node.height + verticalGap;
          minimum = node.y + advance;
          remaining -= advance;
        }
      }
    }
    return new Map(Array.from(nodes.values(), ({ id, x, y }) => [id, { x, y }]));
  }

  function hardwareOutputLayout(graph, bounds) {
    const outputs = graph.nodes.filter(node => node.hardwareOutput && bounds.has(node.id));
    const channels = graph.nodes.filter(node => !node.hardwareOutput && bounds.has(node.id));
    if (!outputs.length || !channels.length) return new Map();

    const right = Math.max(...channels.map(node => bounds.get(node.id).right));
    const firstX = bounds.get(outputs[0].id).left;
    const x = firstX >= right + 55 && outputs.every(node => bounds.get(node.id).left === firstX) ? firstX : right + 56;
    const channelsById = new Set(channels.map(node => node.id));
    const sourceRows = new Map(outputs.map(node => [node.id, []]));
    for (const route of graph.routes) {
      if (route.enabled === false || route.sidechainEffectId || !channelsById.has(route.from)) continue;
      sourceRows.get(route.to)?.push(bounds.get(route.from).top);
    }

    const rows = outputs.map(({ id }) => {
      const box = bounds.get(id);
      const sources = sourceRows.get(id);
      const preferred = sources.length ? sources.reduce((sum, top) => sum + top, 0) / sources.length : box.top;
      return { id, preferred, height: box.bottom - box.top };
    });
    rows.sort((a, b) => a.preferred - b.preferred);
    // Subtract the required row spacing, then merge colliding groups around their preferred heights.
    const groups = [];
    let offset = 0;
    for (const row of rows) {
      row.offset = offset;
      offset += row.height + 16;
      groups.push({ rows: [row], total: row.preferred - row.offset });
      while (groups.length > 1) {
        const right = groups.at(-1);
        const left = groups.at(-2);
        if (left.total / left.rows.length <= right.total / right.rows.length) break;
        left.rows.push(...right.rows);
        left.total += right.total;
        groups.pop();
      }
    }
    return new Map(groups.flatMap(group => group.rows.map(row => [row.id, { x, y: row.offset + group.total / group.rows.length }])));
  }

  const minZoom = .1;

  function zoomAt(view, point, factor) {
    const scale = Math.max(minZoom, Math.min(1, view.scale * factor));
    const ratio = scale / view.scale;
    return { scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
  }

  function roundedWire(points, radius = 15) {
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 1; index < points.length - 1; index++) {
      const previous = points[index - 1];
      const corner = points[index];
      const next = points[index + 1];
      const before = Math.hypot(previous.x - corner.x, previous.y - corner.y);
      const after = Math.hypot(next.x - corner.x, next.y - corner.y);
      const length = Math.min(radius, before / 2, after / 2);
      if (!length) {
        path += ` L ${corner.x} ${corner.y}`;
        continue;
      }
      const entry = length / before;
      const exit = length / after;
      path += ` L ${corner.x + (previous.x - corner.x) * entry} ${corner.y + (previous.y - corner.y) * entry}`;
      path += ` Q ${corner.x} ${corner.y} ${corner.x + (next.x - corner.x) * exit} ${corner.y + (next.y - corner.y) * exit}`;
    }
    const last = points.at(-1);
    return path + ` L ${last.x} ${last.y}`;
  }

  function wireControl(a, b) {
    const distance = Math.abs(b.x - a.x);
    const control = Math.max(18, Math.min(120, distance * .42 + Math.min(20, Math.abs(b.y - a.y) * .1)));
    return b.x >= a.x ? Math.min(control, distance / 2) : control;
  }

  function wireCurve(a, b) {
    const control = wireControl(a, b);
    return `M ${a.x} ${a.y} C ${a.x + control} ${a.y}, ${b.x - control} ${b.y}, ${b.x} ${b.y}`;
  }

  function clearWire(a, b, obstacles) {
    return obstacles.every(box => Math.max(a.x, b.x) <= box.left || Math.min(a.x, b.x) >= box.right ||
      Math.max(a.y, b.y) <= box.top || Math.min(a.y, b.y) >= box.bottom);
  }

  function routeAroundCards(a, b, source, target, cards, branch = 0) {
    const padding = 10;
    const obstacles = cards.filter(box => box !== source && box !== target).map(box => ({
      left: box.left - padding, right: box.right + padding, top: box.top - padding, bottom: box.bottom + padding,
    }));
    if (b.x >= a.x) {
      if (clearWire(a, b, obstacles)) return wireCurve(a, b);
      const control = wireControl(a, b);
      let previous = a;
      let blocked = false;
      for (let step = 1; step <= 24; step++) {
        const t = step / 24;
        const u = 1 - t;
        const progress = t * t * (3 - 2 * t);
        const point = { x: a.x + (b.x - a.x) * progress + 3 * u * t * (u - t) * control,
          y: a.y + (b.y - a.y) * progress };
        if (!clearWire(previous, point, obstacles)) { blocked = true; break; }
        previous = point;
      }
      if (!blocked) return wireCurve(a, b);
    }

    const spacing = 12 + Math.min(branch, 3) * 4;
    const exit = { x: a.x + spacing, y: a.y };
    const entry = { x: b.x - spacing, y: b.y };
    const blockers = [...obstacles, source, target];
    const lanes = new Set([a.y, b.y, (a.y + b.y) / 2]);
    for (const box of blockers) {
      lanes.add(box.top - spacing);
      lanes.add(box.bottom + spacing);
    }
    let best;
    let shortest = Infinity;
    if (clearWire(a, exit, obstacles) && clearWire(entry, b, obstacles)) {
      for (const y of lanes) {
        const length = Math.abs(y - a.y) + Math.abs(y - b.y);
        if (length >= shortest) continue;
        const start = { x: exit.x, y };
        const end = { x: entry.x, y };
        if (!clearWire(exit, start, blockers) || !clearWire(start, end, blockers) || !clearWire(end, entry, blockers)) continue;
        shortest = length;
        best = [a, exit, start, end, entry, b];
      }
    }
    if (best) return roundedWire(best, 9);
    if (b.x >= a.x) return wireCurve(a, b);
    const above = Math.min(source.top, target.top) - spacing;
    const below = Math.max(source.bottom, target.bottom) + spacing;
    const bend = a.y + b.y <= above + below ? above : below;
    return roundedWire([a, exit, { x: exit.x, y: bend }, { x: entry.x, y: bend }, entry, b]);
  }

  function migrateLanePosition(point, kind) {
    return { x: percentage(kind === "output" ? 78 + point.x * .18 : 4 + point.x * .13), y: percentage(point.y) };
  }

  function channelIdentity(channel) {
    return { chain_uuid: channel.chain_uuid ?? null, source_uuid: channel.source_uuid ?? null };
  }

  function openNativeEffectBrowser(host, channel) {
    return host.effect.openBrowser(channel.id, channelIdentity(channel));
  }

  const api = { devices, effects, tapNames, seed, routeError, splitLegacy, initialNodeLayout, hardwareOutputLayout,
    centerFromPixels, centerToPixels, roundCanvasPercent, migrateCanvasPosition,
    migrateLanePosition, channelIdentity, openNativeEffectBrowser, effectIdAt, portRoutes,
    minZoom, zoomAt, roundedWire, wireCurve, routeAroundCards };
  if (typeof module === "object") module.exports = api;
  else root.channelChain = api;
})(globalThis);
