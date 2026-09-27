// Built by k8sdockside-plugin from src/ -- edit the TypeScript there, not this file.
"use strict";
(() => {
  // src/model/quantity.ts
  var BINARY = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
  var DECIMAL = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  var SHAPE = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E))?$/;
  function parseQuantity(text) {
    if (typeof text === "number") return text;
    if (!text) return NaN;
    const match = SHAPE.exec(text.trim());
    if (!match) return NaN;
    const value = Number(match[1]);
    if (match[2]) return value * 10 ** Number(match[2].slice(1));
    const suffix = match[3] ?? "";
    return value * (BINARY[suffix] ?? DECIMAL[suffix] ?? NaN);
  }
  var MI = 2 ** 20;

  // src/model/nodes.ts
  var CONTROL_PLANE_LABELS = ["node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master"];
  var PRESSURES = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"];
  function isControlPlane(node) {
    const labels = node.metadata.labels ?? {};
    if (CONTROL_PLANE_LABELS.some((l) => l in labels)) return true;
    if (labels["node-role.kubernetes.io/controlplane"] === "true") return true;
    return (node.spec?.taints ?? []).some((t) => CONTROL_PLANE_LABELS.includes(t.key));
  }
  function isReady(node) {
    return (node.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
  }
  function isActivePod(pod) {
    const phase = pod.status?.phase;
    return phase !== "Succeeded" && phase !== "Failed";
  }
  function requested(pod, resource) {
    let total = 0;
    for (const c of pod.spec?.containers ?? []) {
      const v = parseQuantity(c.resources?.requests?.[resource]);
      if (Number.isFinite(v)) total += v;
    }
    return total;
  }
  function readNodes(nodes, pods) {
    const byNode = /* @__PURE__ */ new Map();
    for (const pod of pods) {
      const name = pod.spec?.nodeName;
      if (!name || !isActivePod(pod)) continue;
      const entry = byNode.get(name) ?? { pods: 0, cpu: 0, memory: 0 };
      entry.pods++;
      entry.cpu += requested(pod, "cpu");
      entry.memory += requested(pod, "memory");
      byNode.set(name, entry);
    }
    return nodes.map((node) => {
      const name = node.metadata.name;
      const cordoned = node.spec?.unschedulable === true;
      const noSchedule = (node.spec?.taints ?? []).some((t) => t.effect === "NoSchedule" || t.effect === "NoExecute");
      const load = byNode.get(name) ?? { pods: 0, cpu: 0, memory: 0 };
      return {
        name,
        role: isControlPlane(node) ? "control-plane" : "worker",
        schedulable: !cordoned && !noSchedule,
        cordoned,
        ready: isReady(node),
        pressure: (node.status?.conditions ?? []).filter((c) => PRESSURES.includes(c.type) && c.status === "True").map((c) => c.type),
        addresses: [name, ...(node.status?.addresses ?? []).map((a) => a.address)],
        pods: load.pods,
        cpuAllocatable: parseQuantity(node.status?.allocatable?.cpu),
        memoryAllocatable: parseQuantity(node.status?.allocatable?.memory),
        cpuRequested: load.cpu,
        memoryRequested: load.memory
      };
    }).sort((a, b) => a.role === b.role ? a.name.localeCompare(b.name) : a.role === "control-plane" ? -1 : 1);
  }

  // src/model/layout.ts
  var TILE = 16;
  var T = {
    Void: 0,
    Wall: 1,
    Floor: 2,
    Room: 3,
    Lounge: 4,
    Glass: 5,
    Door: 6
  };
  var ROOMINESS = {
    small: { pairGap: 1, rowGap: 0, loungeW: 7, minInnerH: 11, meeting: false },
    medium: { pairGap: 2, rowGap: 1, loungeW: 9, minInnerH: 13, meeting: true },
    large: { pairGap: 2, rowGap: 1, loungeW: 11, minInnerH: 16, meeting: true }
  };
  var TOP = 2;
  function sizeFor(nodes) {
    if (nodes <= 6) return "small";
    if (nodes <= 24) return "medium";
    return "large";
  }
  function racksFor(nodes) {
    return Math.max(2, Math.ceil(nodes / 4));
  }
  function desksPerRow(n) {
    return Math.max(1, Math.min(n, 14, Math.ceil(Math.sqrt(n * 1.6))));
  }
  function slotX(x0, i, gap) {
    return x0 + i * 2 + Math.floor(i / 2) * gap;
  }
  function buildLayout(managers, workers, opts = { size: "small", racks: 2 }) {
    const room = ROOMINESS[opts.size];
    const desks = Math.max(workers, 2);
    const perRow = desksPerRow(desks);
    const rows = Math.ceil(desks / perRow);
    const pitch = 3 + room.rowGap;
    const floorW = slotX(0, perRow - 1, room.pairGap) + 2;
    const tableW = room.meeting ? Math.min(6, floorW - 2) : 0;
    const meetingRows = tableW >= 2 ? 5 : 0;
    const innerH = Math.max(1 + rows * pitch + meetingRows, room.minInnerH);
    const h = TOP + innerH + 1;
    const roomRows = Math.max(1, Math.floor((innerH - 3) / 3));
    const roomCols = Math.max(1, Math.ceil(managers / roomRows));
    const roomW = 1 + roomCols * 3;
    const glassX = 1 + roomW;
    const floorX0 = glassX + 2;
    const loungeX0 = floorX0 + floorW + 1;
    const LW = room.loungeW;
    const w = loungeX0 + LW + 1;
    const tiles = new Uint8Array(w * h);
    const at = (x, y) => y * w + x;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let t = T.Floor;
        if (y < TOP || y === h - 1 || x === 0 || x === w - 1) t = T.Wall;
        else if (x === glassX) t = T.Glass;
        else if (x < glassX) t = T.Room;
        else if (x >= loungeX0) t = T.Lounge;
        tiles[at(x, y)] = t;
      }
    }
    tiles[at(glassX, h - 3)] = T.Door;
    tiles[at(glassX, h - 2)] = T.Door;
    const door = { x: loungeX0 + 3, y: h - 1 };
    tiles[at(door.x, door.y)] = T.Door;
    const items = [];
    const item = (type, x, y, iw = 1, ih = 1, blocks = true) => {
      items.push({ type, x, y, w: iw, h: ih, blocks });
    };
    const managerSeats = [];
    for (let i = 0; i < managers; i++) {
      const col = Math.floor(i / roomRows);
      const row = i % roomRows;
      const x = 2 + col * 3;
      const y = TOP + 1 + row * 3;
      item("desk", x, y, 2, 1);
      managerSeats.push({ x, y: y + 1, room: "glass" });
    }
    if (managers === 0) item("cloud", 2, TOP + 1, Math.min(3, roomW - 1), 2, false);
    item("plant", roomW, h - 2);
    item("board", 2, 0, Math.min(3, roomW - 1), 2, false);
    const seats = [];
    for (let i = 0; i < desks; i++) {
      const row = Math.floor(i / perRow);
      const x = slotX(floorX0, i % perRow, room.pairGap);
      const y = TOP + 1 + row * pitch;
      item("desk", x, y, 2, 1);
      seats.push({ x, y: y + 1, room: "floor" });
    }
    const slots = [];
    for (let x = floorX0; x + 1 < loungeX0 - 1; x += 4) slots.push(x);
    const posterAt = slots.length >= 3 ? Math.floor(slots.length / 2) : -1;
    slots.forEach((x, i) => item(i === posterAt ? "poster" : "window", x, 0, 2, 2, false));
    const spots = [];
    if (meetingRows) {
      const top = TOP + 1 + rows * pitch;
      const tx = floorX0 + Math.floor((floorW - tableW) / 2);
      for (let y = top; y < top + 4; y++) for (let x = tx - 1; x <= tx + tableW; x++) tiles[at(x, y)] = T.Room;
      item("table", tx, top + 1, tableW, 2);
      for (let x = tx; x < tx + tableW; x++) {
        spots.push({ x, y: top, kind: "meeting", sit: true });
        spots.push({ x, y: top + 3, kind: "meeting", sit: false });
      }
    }
    if (innerH > rows * pitch + meetingRows + 1) {
      item("plant", floorX0, h - 2);
      item("plant", floorX0 + floorW - 1, h - 2);
    }
    const l = loungeX0;
    item("coffee", l + 1, TOP);
    spots.push({ x: l + 1, y: TOP + 1, kind: "coffee", sit: false });
    item("cooler", l + 3, TOP);
    spots.push({ x: l + 3, y: TOP + 1, kind: "cooler", sit: false });
    item("vending", l + 5, TOP);
    spots.push({ x: l + 5, y: TOP + 1, kind: "vending", sit: false });
    if (LW >= 9) {
      item("coffee", l + 7, TOP);
      spots.push({ x: l + 7, y: TOP + 1, kind: "coffee", sit: false });
    }
    item("clock", l + 3, 0, 1, 2, false);
    item("window", l + LW - 2, 0, 2, 2, false);
    const couches = LW >= 9 ? 2 : 1;
    for (let c = 0; c < couches; c++) {
      const cx = l + 1 + c * 4;
      item("couch", cx, TOP + 4, 3, 1, false);
      for (let i = 0; i < 3; i++) spots.push({ x: cx + i, y: TOP + 4, kind: "couch", sit: true });
      item("plant", cx - 1, TOP + 4);
    }
    item("plant", l + 1 + couches * 4 - 1, TOP + 4);
    item("shelf", l + LW - 1, TOP + 3, 1, 2);
    item("printer", l + LW - 1, TOP + 6);
    spots.push({ x: l + LW - 2, y: TOP + 6, kind: "printer", sit: false });
    spots.push({ x: l + 1, y: TOP + 1, kind: "window", sit: false });
    const rackRows = [h - 4];
    if (h - 7 >= TOP + 8) rackRows.push(h - 7);
    let placed = 0;
    for (const y of rackRows) {
      for (let k = 0; placed < opts.racks; k++) {
        const x = l + LW - 1 - k - Math.floor(k / 2);
        if (x < l + 1) break;
        item("rack", x, y, 1, 2);
        placed++;
      }
    }
    const inbox = { x: door.x + 1, y: h - 2, w: 2 };
    item("inbox", inbox.x, inbox.y, inbox.w, 1, false);
    const blocked = new Uint8Array(w * h);
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      blocked[i] = t === T.Wall || t === T.Glass || t === T.Void ? 1 : 0;
    }
    blocked[at(door.x, door.y)] = 1;
    for (const it of items) {
      if (!it.blocks) continue;
      for (let y = it.y; y < it.y + it.h; y++) for (let x = it.x; x < it.x + it.w; x++) blocked[at(x, y)] = 1;
    }
    return { w, h, tiles, blocked, items, managerSeats, seats, spots, door, inbox, glassRoom: { x0: 1, x1: glassX - 1 }, size: opts.size };
  }

  // src/model/rng.ts
  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function pick(list, random) {
    return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  }
  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  // src/model/lava.ts
  var MARK_REACH = 0.5;
  var MARK_DENSITY = 0.3;
  var CRACKS_FROM = 0.3;
  var Mark = { None: 0, Litter: 1, Stain: 2, Crack: 3 };
  function emptyLava(layout) {
    const n = layout.w * layout.h;
    return { heat: new Float32Array(n), mask: new Uint8Array(n), count: 0, marks: new Uint8Array(n) };
  }
  function lavaShare(level, opts) {
    if (!opts.lava || level < opts.lavaStart) return 0;
    const span = 1 - opts.lavaStart;
    return opts.lavaMax * (span <= 0 ? 1 : Math.min(1, (level - opts.lavaStart) / span));
  }
  function spreadLava(layout, level, hotSeats, seed, opts) {
    const out = emptyLava(layout);
    const { w, tiles, blocked } = layout;
    const chairs = new Set([...layout.seats, ...layout.managerSeats].map((s) => s.y * w + s.x));
    const eligible = (i) => !blocked[i] && tiles[i] !== T.Door && !chairs.has(i);
    let free = 0;
    for (let i = 0; i < tiles.length; i++) if (eligible(i)) free++;
    if (level < 0.03 || !free) return out;
    const lavaN = Math.round(lavaShare(level, opts) * free);
    const reach = Math.min(free, Math.max(lavaN, Math.round(Math.min(1, level * 1.3) * free * MARK_REACH), 6));
    const seedRandom = rng(hash(seed));
    const random = rng(hash(seed) ^ 2654435769);
    const candidates = [];
    for (let tries = 0; candidates.length < 24 && tries < 2e3; tries++) {
      const i = Math.floor(seedRandom() * tiles.length);
      if (eligible(i) && !candidates.includes(i)) candidates.push(i);
    }
    const seeds = [];
    for (const s of hotSeats) {
      const behind = (s.y + 1) * w + s.x;
      if (eligible(behind)) seeds.push(behind);
    }
    seeds.push(...candidates.slice(0, 1 + Math.floor(reach / 20)));
    const order2 = [];
    const taken = new Uint8Array(tiles.length);
    const frontier = [];
    for (const s of seeds) {
      if (taken[s] || order2.length >= reach) continue;
      taken[s] = 1;
      order2.push(s);
      frontier.push(s);
    }
    while (order2.length < reach && frontier.length) {
      const k = Math.floor(random() * frontier.length);
      const cur = frontier[k];
      const x = cur % w;
      const around = [cur - w, cur + w, x > 0 ? cur - 1 : -1, x < w - 1 ? cur + 1 : -1].filter((n2) => n2 >= 0 && n2 < tiles.length && !taken[n2] && eligible(n2));
      if (!around.length) {
        frontier.splice(k, 1);
        continue;
      }
      const n = around[Math.floor(random() * around.length)];
      taken[n] = 1;
      order2.push(n);
      frontier.push(n);
    }
    const crackOdds = level < CRACKS_FROM ? 0 : Math.min(0.85, 0.25 + (level - CRACKS_FROM) * 1.5);
    const salt = hash(seed + ":marks");
    order2.forEach((i, n) => {
      if (n < lavaN) {
        out.heat[i] = 1 - n / Math.max(1, lavaN) * 0.6;
        out.mask[i] = 1;
        return;
      }
      const r = hash(`${salt}:${i}`) / 4294967296;
      if (r >= MARK_DENSITY) return;
      const kind = r / MARK_DENSITY;
      out.marks[i] = kind < crackOdds ? Mark.Crack : (hash(`${i}`) & 1) === 0 ? Mark.Litter : Mark.Stain;
    });
    out.count = Math.min(lavaN, order2.length);
    return out;
  }

  // src/model/load.ts
  var CPU_CHART = "node-cpu";
  var MEMORY_CHART = "node-memory";
  var DISK_CHART = "node-disk";
  var UNKNOWN = { value: NaN, source: "none" };
  function unknownLoad() {
    return { cpu: UNKNOWN, memory: UNKNOWN, disk: UNKNOWN };
  }
  function instanceHost(instance) {
    const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(instance);
    if (bracket) return bracket[1];
    const colons = instance.split(":").length - 1;
    return colons === 1 ? instance.slice(0, instance.indexOf(":")) : instance;
  }
  function nodeForSeries(series, nodes) {
    const [nodename = "", instance = ""] = series.split("|");
    const host = instanceHost(instance);
    const short = (n) => n.split(".")[0];
    return nodes.find((n) => n.name === nodename) ?? nodes.find((n) => n.name === host || n.addresses.includes(host)) ?? nodes.find((n) => nodename !== "" && (n.addresses.includes(nodename) || short(n.name) === short(nodename)));
  }
  function latest(points) {
    for (let i = points.length - 1; i >= 0; i--) {
      const v = points[i].v;
      if (Number.isFinite(v)) return v;
    }
    return NaN;
  }
  function loadFromCharts(panel, nodes) {
    const loads = /* @__PURE__ */ new Map();
    const source = panel.source;
    if (!source.available) {
      return { loads, where: "", note: source.error ? `could not look for Prometheus: ${source.error}` : "no Prometheus or VictoriaMetrics found" };
    }
    const errors = [];
    const read = (id, field2) => {
      const chart = panel.charts.find((c) => c.id === id);
      if (!chart) return;
      if (chart.error) errors.push(chart.error);
      for (const series of chart.series) {
        const node = nodeForSeries(series.name, nodes);
        const value = latest(series.points);
        if (!node || !Number.isFinite(value)) continue;
        const entry = loads.get(node.name) ?? unknownLoad();
        entry[field2] = { value: clamp(value, 0, 1), source: "prometheus" };
        loads.set(node.name, entry);
      }
    };
    read(CPU_CHART, "cpu");
    read(MEMORY_CHART, "memory");
    read(DISK_CHART, "disk");
    if (!loads.size) {
      const why = errors[0] ?? "it has no node-exporter metrics (node_cpu_seconds_total, node_memory_MemAvailable_bytes)";
      return { loads, where: "", note: `${source.describe} answered, but ${why}` };
    }
    return { loads, where: `node-exporter via ${source.describe}`, note: errors.length ? errors[0] : "" };
  }
  function loadFromNodeMetrics(items, nodes) {
    const loads = /* @__PURE__ */ new Map();
    for (const item of items) {
      const node = nodes.find((n) => n.name === item.metadata.name);
      if (!node) continue;
      const cpu = parseQuantity(item.usage?.cpu) / node.cpuAllocatable;
      const memory = parseQuantity(item.usage?.memory) / node.memoryAllocatable;
      loads.set(node.name, {
        cpu: Number.isFinite(cpu) ? { value: clamp(cpu, 0, 1), source: "metrics-server" } : UNKNOWN,
        memory: Number.isFinite(memory) ? { value: clamp(memory, 0, 1), source: "metrics-server" } : UNKNOWN,
        disk: UNKNOWN
      });
    }
    return loads;
  }
  function loadFromRequests(nodes) {
    const loads = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      const cpu = node.cpuRequested / node.cpuAllocatable;
      const memory = node.memoryRequested / node.memoryAllocatable;
      loads.set(node.name, {
        cpu: Number.isFinite(cpu) ? { value: clamp(cpu, 0, 1), source: "requests" } : UNKNOWN,
        memory: Number.isFinite(memory) ? { value: clamp(memory, 0, 1), source: "requests" } : UNKNOWN,
        disk: node.pressure.includes("DiskPressure") ? { value: 0.95, source: "conditions" } : UNKNOWN
      });
    }
    return loads;
  }
  function mergeLoads(nodes, sources) {
    const out = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      const pickReading = (field2) => {
        for (const s of sources) {
          const r = s.get(node.name)?.[field2];
          if (r && Number.isFinite(r.value)) return r;
        }
        return UNKNOWN;
      };
      out.set(node.name, { cpu: pickReading("cpu"), memory: pickReading("memory"), disk: pickReading("disk") });
    }
    return out;
  }
  function activity(load, settings2) {
    const all = [
      [load.cpu.value, settings2.cpuWeight],
      [load.memory.value, settings2.memoryWeight],
      [load.disk.value, settings2.diskWeight]
    ];
    const parts = all.filter(([v, w]) => Number.isFinite(v) && w > 0);
    if (!parts.length) return 0;
    const weight = parts.reduce((s, [, w]) => s + w, 0);
    const mean = parts.reduce((s, [v, w]) => s + v * w, 0) / weight;
    const max = Math.max(...parts.map(([v]) => v));
    return clamp((0.65 * mean + 0.35 * max) * settings2.busyness, 0, 1);
  }
  function average(loads, field2) {
    const values = [...loads.values()].filter((l) => l[field2].source !== "conditions").map((l) => l[field2].value).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
  }

  // src/model/kube.ts
  function time(text) {
    const t = Date.parse(text ?? "");
    return Number.isFinite(t) ? t : 0;
  }

  // src/model/problems.ts
  var CHECKS = {
    nodeNotReady: { id: "node-not-ready", category: "error", label: "Node not ready", why: "The kubelet is not reporting, or reports it cannot run pods. Its pods are not being looked after.", weight: 8 },
    nodePressure: { id: "node-pressure", category: "error", label: "Node under pressure", why: "The node is short of memory, disk or process ids, or has no network, and will start evicting pods.", weight: 4 },
    crashLoop: { id: "crashloop", category: "error", label: "Crash looping", why: "A container keeps exiting and the kubelet keeps backing off before starting it again.", weight: 3 },
    imagePull: { id: "image-pull", category: "error", label: "Image cannot be pulled", why: "The image name, tag or registry credentials are wrong, or the registry is unreachable.", weight: 2 },
    containerConfig: { id: "container-config", category: "error", label: "Container cannot start", why: "A ConfigMap, Secret or setting the container needs is missing or wrong.", weight: 2 },
    pending: { id: "pending", category: "error", label: "Stuck pending", why: "Pending for more than five minutes: no node fits it, or its volume or image is not ready.", weight: 2 },
    oomKilled: { id: "oom-killed", category: "error", label: "Killed for memory", why: "A container went over its memory limit and was killed. It is too small, or it leaks.", weight: 1.5 },
    notReady: { id: "pod-not-ready", category: "warning", label: "Running but not ready", why: "The pod runs but has failed its readiness probe for five minutes; it gets no traffic.", weight: 1 },
    failed: { id: "pod-failed", category: "warning", label: "Failed pod left behind", why: "A failed pod that is not a Job’s -- evicted, most often. It holds nothing, but says something went wrong.", weight: 0.5 },
    restarts: { id: "restarts", category: "warning", label: "Restarting often", why: "Five restarts or more. Running now, but it has fallen over before.", weight: 0.4 },
    cordoned: { id: "cordoned", category: "warning", label: "Node cordoned", why: "Taken out of scheduling by hand. Fine for maintenance; easy to forget.", weight: 0.5 },
    noMemoryLimit: { id: "no-memory-limit", category: "warning", label: "No memory limit", why: "A container with no memory limit can take the node’s memory from everything else on it.", weight: 0.1 },
    events: { id: "warning-events", category: "warning", label: "Warning events", why: "What the cluster has complained about in the last hour.", weight: 0.15 },
    privileged: { id: "privileged", category: "security", label: "Privileged container", why: "A privileged container is root on the node: a way out of the container for anything that gets in.", weight: 2 },
    hostNamespaces: { id: "host-namespaces", category: "security", label: "Shares the host’s namespaces", why: "hostNetwork, hostPID or hostIPC: the pod sees the node’s network, processes or shared memory.", weight: 1.5 },
    capabilities: { id: "capabilities", category: "security", label: "Dangerous capabilities", why: "SYS_ADMIN, NET_ADMIN, SYS_PTRACE or ALL added: most of root, handed out one piece at a time.", weight: 1 },
    hostPath: { id: "host-path", category: "security", label: "Mounts a host path", why: "A hostPath volume reaches into the node’s own files.", weight: 1 },
    runAsRoot: { id: "run-as-root", category: "security", label: "May run as root", why: "Neither runAsNonRoot nor a non-zero runAsUser is set, so the image decides -- and many run as root.", weight: 0.25 },
    latestTag: { id: "latest-tag", category: "security", label: "Unpinned image", why: "The image is :latest or has no tag, so what runs can change under you on the next pull.", weight: 0.3 }
  };
  var PENDING_GRACE = 5 * 6e4;
  var EVENT_WINDOW = 60 * 6e4;
  var DANGEROUS_CAPS = ["SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "SYS_MODULE", "ALL"];
  function unpinned(image) {
    if (!image || image.includes("@sha256:")) return false;
    const last2 = image.slice(image.lastIndexOf("/") + 1);
    const colon = last2.indexOf(":");
    return colon < 0 || last2.slice(colon + 1) === "latest";
  }
  function mayRunAsRoot(pod, c) {
    const nonRoot = c.securityContext?.runAsNonRoot ?? pod.spec?.securityContext?.runAsNonRoot;
    const user = c.securityContext?.runAsUser ?? pod.spec?.securityContext?.runAsUser;
    if (user === 0) return true;
    return nonRoot !== true && user === void 0;
  }
  function ownedByJob(pod) {
    return (pod.metadata.ownerReferences ?? []).some((o) => o.kind === "Job");
  }
  function analyze(nodes, pods, events, settings2, now) {
    const found = /* @__PURE__ */ new Map();
    const hit = (check, h) => {
      let f = found.get(check.id);
      if (!f) {
        f = { ...check, hits: [] };
        found.set(check.id, f);
      }
      f.hits.push(h);
    };
    const ignored = new Set(settings2.ignoreNamespaces);
    for (const node of nodes) {
      const name = node.metadata.name;
      const ref = { kind: "nodes", namespace: "", name, node: name };
      if (!isReady(node)) hit(CHECKS.nodeNotReady, { ...ref, detail: "NotReady" });
      for (const c of node.status?.conditions ?? []) {
        if (["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"].includes(c.type) && c.status === "True") {
          hit(CHECKS.nodePressure, { ...ref, detail: c.type });
        }
      }
      if (node.spec?.unschedulable) hit(CHECKS.cordoned, { ...ref, detail: "cordoned" });
    }
    let unscheduled = 0;
    const podNode = /* @__PURE__ */ new Map();
    for (const pod of pods) {
      const namespace = pod.metadata.namespace ?? "";
      const name = pod.metadata.name;
      const node = pod.spec?.nodeName ?? "";
      podNode.set(`${namespace}/${name}`, node);
      const ref = { kind: "pods", namespace, name, node };
      const phase = pod.status?.phase;
      const statuses = [...pod.status?.initContainerStatuses ?? [], ...pod.status?.containerStatuses ?? []];
      if (phase === "Pending" && !node) unscheduled++;
      if (phase === "Pending" && now - time(pod.metadata.creationTimestamp) > PENDING_GRACE) {
        hit(CHECKS.pending, { ...ref, detail: node ? "not started" : "not scheduled" });
      }
      if (phase === "Failed" && !ownedByJob(pod)) hit(CHECKS.failed, { ...ref, detail: pod.status?.reason ?? "Failed" });
      let looping = false;
      for (const s of statuses) {
        const waiting = s.state?.waiting?.reason ?? "";
        if (waiting === "CrashLoopBackOff") {
          looping = true;
          hit(CHECKS.crashLoop, { ...ref, detail: `${s.name}, ${s.restartCount ?? 0} restarts` });
        } else if (["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull"].includes(waiting)) {
          hit(CHECKS.imagePull, { ...ref, detail: `${s.name}: ${waiting}` });
        } else if (["CreateContainerConfigError", "CreateContainerError", "RunContainerError"].includes(waiting)) {
          hit(CHECKS.containerConfig, { ...ref, detail: `${s.name}: ${waiting}` });
        }
        if (s.state?.terminated?.reason === "OOMKilled" || s.lastState?.terminated?.reason === "OOMKilled") {
          hit(CHECKS.oomKilled, { ...ref, detail: s.name });
        }
        if (!looping && (s.restartCount ?? 0) >= 5 && s.state?.running) {
          hit(CHECKS.restarts, { ...ref, detail: `${s.name}, ${s.restartCount} restarts` });
        }
      }
      if (phase === "Running" && !looping) {
        const ready = pod.status?.conditions?.find((c) => c.type === "Ready");
        if (ready?.status === "False" && now - time(ready.lastTransitionTime) > PENDING_GRACE) hit(CHECKS.notReady, { ...ref, detail: "not ready" });
      }
      if (ignored.has(namespace) || phase === "Succeeded" || phase === "Failed") continue;
      const containers = [...pod.spec?.initContainers ?? [], ...pod.spec?.containers ?? []];
      for (const c of pod.spec?.containers ?? []) {
        if (!c.resources?.limits?.memory) hit(CHECKS.noMemoryLimit, { ...ref, detail: c.name });
      }
      if (!settings2.securityChecks) continue;
      const host = [pod.spec?.hostNetwork && "network", pod.spec?.hostPID && "PID", pod.spec?.hostIPC && "IPC"].filter(Boolean);
      if (host.length) hit(CHECKS.hostNamespaces, { ...ref, detail: "host " + host.join(", ") });
      const paths = (pod.spec?.volumes ?? []).filter((v) => v.hostPath).map((v) => v.hostPath?.path ?? v.name);
      if (paths.length) hit(CHECKS.hostPath, { ...ref, detail: paths.join(", ") });
      for (const c of containers) {
        if (c.securityContext?.privileged) hit(CHECKS.privileged, { ...ref, detail: c.name });
        const caps = (c.securityContext?.capabilities?.add ?? []).filter((cap) => DANGEROUS_CAPS.includes(cap.replace(/^CAP_/, "")));
        if (caps.length) hit(CHECKS.capabilities, { ...ref, detail: `${c.name}: ${caps.join(", ")}` });
        if (mayRunAsRoot(pod, c)) hit(CHECKS.runAsRoot, { ...ref, detail: c.name });
        if (unpinned(c.image)) hit(CHECKS.latestTag, { ...ref, detail: c.image ?? "" });
      }
    }
    if (settings2.warningEvents) {
      for (const e of events) {
        if (e.type !== "Warning") continue;
        const when = time(e.series?.lastObservedTime) || time(e.lastTimestamp) || time(e.eventTime) || time(e.metadata.creationTimestamp);
        if (now - when > EVENT_WINDOW) continue;
        const io = e.involvedObject ?? {};
        const namespace = io.namespace ?? e.metadata.namespace ?? "";
        const count = e.series?.count ?? e.count ?? 1;
        const detail = `${e.reason ?? "Warning"}${count > 1 ? ` ×${count}` : ""}`;
        if (io.kind === "Pod" && io.name) {
          hit(CHECKS.events, { kind: "pods", namespace, name: io.name, node: podNode.get(`${namespace}/${io.name}`) ?? "", detail });
        } else if (io.kind === "Node" && io.name) {
          hit(CHECKS.events, { kind: "nodes", namespace: "", name: io.name, node: io.name, detail });
        } else {
          const what = io.kind && io.name ? `${io.kind} ${io.name}: ` : "";
          hit(CHECKS.events, { kind: "events", namespace: e.metadata.namespace ?? "", name: e.metadata.name, node: "", detail: what + detail });
        }
      }
    }
    const findings = [...found.values()].sort((a, b) => order(a.category) - order(b.category) || score(b) - score(a));
    const heat = { error: 0, warning: 0, security: 0 };
    const byNode = /* @__PURE__ */ new Map();
    for (const f of findings) {
      heat[f.category] += score(f);
      for (const h of f.hits) if (h.node) byNode.set(h.node, (byNode.get(h.node) ?? 0) + f.weight);
    }
    return { findings, heat, byNode, unscheduled };
  }
  function order(c) {
    return c === "error" ? 0 : c === "security" ? 1 : 2;
  }
  function score(f) {
    return f.weight * Math.pow(f.hits.length, 0.75);
  }
  function hazard(report, settings2) {
    const h = report.heat;
    const raw = h.error + 0.5 * h.warning + (settings2.securityChecks ? 0.7 * h.security : 0);
    return 1 - Math.exp(-raw * settings2.hazardSensitivity / 25);
  }
  function hazardWords(level, settings2) {
    if (level < 0.03) return "Spotless";
    if (level < 0.3) return "A bit of a mess";
    if (!settings2.lava || level < settings2.lavaStart) return level < 0.5 ? "Cracks in the floor" : "Falling apart";
    return "The floor is lava";
  }
  function busyWords(level) {
    if (level < 0.1) return "Quiet day";
    if (level < 0.35) return "Ticking over";
    if (level < 0.6) return "Busy";
    if (level < 0.8) return "Heads down";
    return "Everybody sprinting";
  }

  // src/model/staff.ts
  function share(nodes, people) {
    const n = nodes.length;
    if (!n || people <= 0) return [];
    const out = [];
    if (people >= n) {
      for (let j = 0; j < people; j++) out.push([nodes[j % n]]);
      return out.sort((a, b) => nodes.indexOf(a[0]) - nodes.indexOf(b[0]));
    }
    for (let j = 0; j < people; j++) out.push(nodes.slice(Math.floor(j * n / people), Math.floor((j + 1) * n / people)));
    return out;
  }
  function staff(nodes, settings2) {
    const cp = nodes.filter((n) => n.role === "control-plane").map((n) => n.name);
    const workers = nodes.filter((n) => n.role === "worker").map((n) => n.name);
    const want = (count) => count ? Math.max(1, Math.round(count * settings2.peoplePerNode)) : 0;
    let cpPeople = want(cp.length);
    let workerPeople = want(workers.length);
    const max = Math.max(1, settings2.maxPeople);
    if (cpPeople + workerPeople > max) {
      const total = cpPeople + workerPeople;
      const cpShare = cp.length ? Math.min(cpPeople, Math.max(1, Math.round(max * cpPeople / total))) : 0;
      workerPeople = workers.length ? Math.max(1, max - cpShare) : 0;
      cpPeople = cpShare;
    }
    const people = [];
    const add2 = (role, groups) => {
      const seen = /* @__PURE__ */ new Map();
      for (const group2 of groups) {
        const key = group2[0];
        const nth = seen.get(key) ?? 0;
        seen.set(key, nth + 1);
        people.push({ id: `${role}:${key}:${nth}`, role, nodes: group2 });
      }
    };
    add2("control-plane", share(cp, cpPeople));
    add2("worker", share(workers, workerPeople));
    return people;
  }

  // src/model/office.ts
  function averageReading(readings) {
    const known = readings.filter((r) => Number.isFinite(r.value));
    if (!known.length) return { value: NaN, source: "none" };
    return { value: known.reduce((s, r) => s + r.value, 0) / known.length, source: known[0].source };
  }
  function buildOffice(nodes, loads, report, settings2, seed, preview2 = { busy: null, hazard: null }) {
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const people = staff(nodes, settings2);
    const managers = people.filter((p) => p.role === "control-plane");
    const workers = people.filter((p) => p.role === "worker");
    const size = settings2.officeSize === "auto" ? sizeFor(nodes.length) : settings2.officeSize;
    const layout = buildLayout(managers.length, workers.length, { size, racks: racksFor(nodes.length) });
    const desks = [];
    const place = (list, seats) => {
      list.forEach((person, i) => {
        const seat = seats[i];
        if (!seat) return;
        const infos = person.nodes.map((n) => byName.get(n)).filter((n) => !!n);
        const nodeLoads = person.nodes.map((n) => loads.get(n) ?? unknownLoad());
        const load = {
          cpu: averageReading(nodeLoads.map((l) => l.cpu)),
          memory: averageReading(nodeLoads.map((l) => l.memory)),
          disk: averageReading(nodeLoads.map((l) => l.disk))
        };
        const trouble = person.nodes.reduce((s, n) => s + (report.byNode.get(n) ?? 0), 0);
        let mood = "ok";
        if (infos.length && infos.every((n) => !n.ready)) mood = "down";
        else if (infos.length && infos.every((n) => n.cordoned)) mood = "cordoned";
        else if (trouble >= 2 || infos.some((n) => !n.ready || n.pressure.length)) mood = "trouble";
        desks.push({
          person,
          seat,
          role: person.role,
          activity: preview2.busy ?? (mood === "down" ? 0 : activity(load, settings2)),
          load,
          mood,
          trouble,
          pods: infos.reduce((s, n) => s + n.pods, 0),
          label: person.nodes.length === 1 ? person.nodes[0] : `${person.nodes.length} nodes`
        });
      });
    };
    place(managers, layout.managerSeats);
    place(workers, layout.seats);
    const level = clamp(preview2.hazard ?? (settings2.hazardSensitivity === 0 ? 0 : hazard(report, settings2)), 0, 1);
    const hotSeats = desks.filter((d) => d.trouble > 0).sort((a, b) => b.trouble - a.trouble).map((d) => d.seat);
    const lava = spreadLava(layout, level, hotSeats, seed, settings2);
    const heat = report.heat;
    const total = heat.error + heat.warning + heat.security;
    const security = settings2.securityChecks && total > 0 ? clamp(heat.security / 12, 0, 1) : 0;
    return {
      layout,
      desks,
      lava,
      hazard: level,
      busy: desks.length ? desks.reduce((s, d) => s + d.activity, 0) / desks.length : 0,
      security,
      unscheduled: report.unscheduled,
      cpu: average(loads, "cpu"),
      memory: average(loads, "memory"),
      disk: average(loads, "disk")
    };
  }

  // src/model/settings.ts
  var DEFAULT_SETTINGS = {
    officeSize: "auto",
    peoplePerNode: 1,
    maxPeople: 64,
    cpuWeight: 50,
    memoryWeight: 30,
    diskWeight: 20,
    busyness: 1,
    hazardSensitivity: 1,
    lava: true,
    lavaStart: 0.7,
    lavaMax: 0.25,
    securityChecks: true,
    warningEvents: true,
    ignoreNamespaces: ["kube-system", "kube-public", "kube-node-lease"],
    hazardStyle: "lava",
    floor: "wood",
    dayNight: "auto",
    scale: 0,
    speed: 1,
    names: true,
    intruders: true,
    inbox: true,
    refresh: 15
  };
  var STORAGE_KEY = "settings";
  var PEOPLE_PER_NODE = [0.25, 0.5, 1, 2, 3, 4];
  var REFRESH_CHOICES = [5, 10, 15, 30, 60];
  var SCALE_CHOICES = [0, 1, 2, 3, 4];
  function sanitize(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const d = DEFAULT_SETTINGS;
    const num = (key, lo, hi) => {
      const v = src[key];
      return typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : d[key];
    };
    const bool = (key) => typeof src[key] === "boolean" ? src[key] : d[key];
    const oneOf = (key, choices) => {
      const v = src[key];
      return typeof v === "string" && choices.includes(v) ? v : d[key];
    };
    const namespaces = Array.isArray(src.ignoreNamespaces) ? src.ignoreNamespaces.filter((n) => typeof n === "string").map((n) => n.trim()).filter(Boolean) : d.ignoreNamespaces;
    return {
      officeSize: oneOf("officeSize", ["auto", "small", "medium", "large"]),
      peoplePerNode: num("peoplePerNode", 0.25, 4),
      maxPeople: Math.round(num("maxPeople", 1, 200)),
      cpuWeight: num("cpuWeight", 0, 100),
      memoryWeight: num("memoryWeight", 0, 100),
      diskWeight: num("diskWeight", 0, 100),
      busyness: num("busyness", 0, 3),
      hazardSensitivity: num("hazardSensitivity", 0, 3),
      lava: bool("lava"),
      lavaStart: num("lavaStart", 0.3, 1),
      lavaMax: num("lavaMax", 0.05, 0.8),
      securityChecks: bool("securityChecks"),
      warningEvents: bool("warningEvents"),
      ignoreNamespaces: [...new Set(namespaces)],
      hazardStyle: oneOf("hazardStyle", ["lava", "flood", "slime"]),
      floor: oneOf("floor", ["wood", "carpet", "tiles", "concrete"]),
      dayNight: oneOf("dayNight", ["auto", "day", "night"]),
      scale: Math.round(num("scale", 0, 6)),
      speed: num("speed", 0.25, 3),
      names: bool("names"),
      intruders: bool("intruders"),
      inbox: bool("inbox"),
      refresh: Math.round(num("refresh", 5, 300))
    };
  }
  function parseNamespaces(text) {
    return [...new Set(text.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean))];
  }

  // src/ui/icons.ts
  var ICONS = {
    settings: [
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
      "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
    ],
    pause: ["M8 5v14", "M16 5v14"],
    play: ["M7 4.5v15l12-7.5z"],
    alert: ["M12 3.5l9.5 17h-19z", "M12 10v4", "M12 17.2h.01"],
    security: ["M6 10.5h12v9.5H6z", "M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"],
    warning: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7.5v5.5", "M12 16.5h.01"],
    check: ["M4.5 12.5l5 5L19.5 7"],
    close: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
    info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v6", "M12 7.5h.01"],
    node: ["M4 5h16v5H4z", "M4 14h16v5H4z", "M7.5 7.5h.01", "M7.5 16.5h.01"],
    users: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5", "M16 4.3a3.5 3.5 0 0 1 0 6.4", "M18 14.8c2 .7 3.2 2.5 3.5 5.2"],
    flame: ["M12 21c-4 0-6.5-2.7-6.5-6.2 0-3.8 3.2-5.5 3.7-9.8 2.3 1.4 3.3 3.6 3.3 5.5 1-.6 1.7-1.7 1.9-3 2 1.6 4.1 4.3 4.1 7.3 0 3.5-2.5 6.2-6.5 6.2z"],
    gauge: ["M4.2 16.5a8.5 8.5 0 1 1 15.6 0", "M12 13.5l4-5", "M12 14.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"],
    open: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
    undo: ["M9 14L4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
    chevron: ["M9.5 6l6 6-6 6"],
    "chevron-down": ["M6 9.5l6 6 6-6"],
    link: ["M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.2 1.2", "M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.2-1.2"]
  };

  // src/ui/dom.ts
  var SVG_NS = "http://www.w3.org/2000/svg";
  function el(tag, className = "", text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== void 0) node.textContent = String(text);
    return node;
  }
  function add(parent, ...children) {
    for (const child of children) {
      if (child === null || child === void 0 || child === false) continue;
      parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return parent;
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }
  function clear(node) {
    node.textContent = "";
  }
  function byId(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error(`the page has no #${id}`);
    return node;
  }
  function icon(name, className = "") {
    const node = svg("svg", { viewBox: "0 0 24 24", class: "ico" + (className ? " " + className : ""), "aria-hidden": "true" });
    for (const d of ICONS[name]) node.appendChild(svg("path", { d }));
    return node;
  }
  function chip(text, tone = "", iconName, title) {
    const node = el("span", "chip" + (tone ? " " + tone : ""));
    if (iconName) node.appendChild(icon(iconName));
    node.appendChild(el("span", "", text));
    if (title) node.title = title;
    return node;
  }
  function button(text, className, iconName, onClick) {
    const node = el("button", className);
    node.type = "button";
    if (iconName) node.appendChild(icon(iconName));
    if (text) node.appendChild(el("span", "", text));
    node.addEventListener("click", onClick);
    return node;
  }
  function linkButton(text, onClick, title) {
    const node = el("button", "link", text);
    node.type = "button";
    if (title) node.title = title;
    node.addEventListener("click", onClick);
    return node;
  }

  // src/ui/page.ts
  var sdk = k8sdockside;
  function message(err) {
    return err instanceof Error ? err.message : String(err);
  }
  var banner = {
    show(err) {
      const node = byId("error");
      node.textContent = message(err);
      node.hidden = false;
    },
    clear() {
      byId("error").hidden = true;
    }
  };
  function every(ms, fn, onError = banner.show) {
    let timer;
    let running = false;
    const run = () => {
      if (running) return;
      clearTimeout(timer);
      running = true;
      fn().catch(onError).finally(() => {
        running = false;
        timer = setTimeout(run, ms());
      });
    };
    run();
    return run;
  }
  async function loadSettings() {
    try {
      return sanitize(await sdk.storage?.get(STORAGE_KEY));
    } catch {
      return sanitize(null);
    }
  }
  var saveTimer;
  function saveSettings(settings2) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      sdk.storage?.set(STORAGE_KEY, settings2).catch(banner.show);
    }, 400);
  }

  // src/ui/hud.ts
  function pct(v) {
    return Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—";
  }
  function bar(label, value, title) {
    const row = el("div", "bar");
    const track = el("span", "track");
    const fill = el("span", "fill");
    const known = Number.isFinite(value);
    fill.style.width = known ? `${Math.round(value * 100)}%` : "0";
    fill.classList.add(!known ? "none" : value > 0.85 ? "hot" : value > 0.6 ? "warm" : "ok");
    track.appendChild(fill);
    add(row, el("span", "bar-label", label), track, el("span", "bar-value", pct(value)));
    row.title = title;
    return row;
  }
  function meter(iconName, heading, big, words, ...rest) {
    const card = el("div", "meter");
    add(card, add(el("div", "meter-head"), icon(iconName), el("span", "", heading)), add(el("div", "meter-big"), el("strong", "", big), el("span", "meter-words", words)), ...rest);
    return card;
  }
  function renderMeters(root, m) {
    clear(root);
    const { office: office2, nodes, report } = m;
    const managers = nodes.filter((n) => n.role === "control-plane").length;
    const down = nodes.filter((n) => !n.ready).length;
    const people = office2.desks.length;
    const staffLine = el("div", "meter-line");
    add(staffLine, `${managers} control plane${managers === 1 ? "" : "s"} · ${nodes.length - managers} worker${nodes.length - managers === 1 ? "" : "s"}`);
    const staffChips = el("div", "chips");
    if (!managers) add(staffChips, chip("managed control plane", "info", "info", "No control-plane nodes are visible: the provider runs them, drawn as a cloud in the glass room."));
    if (down) add(staffChips, chip(`${down} node${down === 1 ? "" : "s"} down`, "error", "alert"));
    const cordoned = nodes.filter((n) => n.cordoned).length;
    if (cordoned) add(staffChips, chip(`${cordoned} cordoned`, "warn"));
    const perPerson = people && nodes.length > people ? `each person stands for ~${Math.round(nodes.length / people)} nodes` : "";
    const counts = { error: 0, warning: 0, security: 0 };
    for (const f of report.findings) counts[f.category] += f.hits.length;
    const floorChips = el("div", "chips");
    add(
      floorChips,
      chip(`${counts.error} errors`, counts.error ? "error" : "muted", "alert"),
      chip(`${counts.security} security`, counts.security ? "warn" : "muted", "security"),
      chip(`${counts.warning} warnings`, counts.warning ? "info" : "muted", "warning")
    );
    const source = el("div", "meter-line faint");
    source.textContent = m.where.length ? `from ${m.where.join(", then ")}` : "estimated from pod requests: no metrics found";
    if (m.note) source.title = m.note;
    add(
      root,
      meter("users", "Staff", `${people}`, people === 1 ? "person" : "people", staffLine, perPerson ? el("div", "meter-line faint", perPerson) : null, staffChips),
      meter(
        "gauge",
        "Busyness",
        pct(office2.busy),
        busyWords(office2.busy),
        bar("CPU", office2.cpu, "Mean across nodes"),
        bar("Memory", office2.memory, "Mean across nodes"),
        bar("Disk", office2.disk, "Mean across nodes; unknown without node-exporter"),
        source
      ),
      meter("flame", "Trouble", pct(office2.hazard), hazardWords(office2.hazard, m.settings), floorChips, lavaLine(office2, m.settings), office2.unscheduled ? el("div", "meter-line", `${office2.unscheduled} pod${office2.unscheduled === 1 ? "" : "s"} waiting for a node (boxes by the door)`) : null)
    );
    if (m.preview) root.appendChild(el("div", "preview-note", "Preview on: the sliders in the settings are overriding what the cluster says."));
  }
  function lavaLine(office2, settings2) {
    if (!settings2.lava) return el("div", "meter-line faint", "Lava is off: the floor only cracks.");
    if (office2.lava.count) return el("div", "meter-line lava", `Past ${pct(settings2.lavaStart)}: the floor has given way.`);
    return el("div", "meter-line faint", `Litter, then cracks; lava only past ${pct(settings2.lavaStart)}.`);
  }
  var MOOD_WORDS = { ok: "at work", trouble: "has problems", down: "node is down -- asleep at the desk", cordoned: "cordoned -- on a long break" };
  function renderTip(tip2, agent, security) {
    clear(tip2);
    const desk = agent.desk;
    if (!desk) {
      add(tip2, el("strong", "", "An intruder"), el("div", "faint", `Here because of the security findings (${pct(security)} of the way to a full break-in). Fix them and they leave.`));
      return;
    }
    const nodes = desk.person.nodes;
    add(
      tip2,
      el("strong", "", desk.label),
      el("div", "faint", `${desk.role === "control-plane" ? "Control plane" : "Worker"} · ${MOOD_WORDS[desk.mood]}`),
      bar("CPU", desk.load.cpu.value, desk.load.cpu.source),
      bar("Memory", desk.load.memory.value, desk.load.memory.source),
      bar("Disk", desk.load.disk.value, desk.load.disk.source),
      el("div", "tip-line", `Busyness ${pct(desk.activity)} · ${desk.pods} pod${desk.pods === 1 ? "" : "s"}`),
      nodes.length > 1 ? el("div", "faint", nodes.slice(0, 6).join(", ") + (nodes.length > 6 ? ` and ${nodes.length - 6} more` : "")) : null,
      el("div", "faint", nodes.length === 1 ? "Click to open the node" : "Click to open the first node")
    );
  }
  var CATEGORY = {
    error: { title: "Errors", icon: "alert", tone: "error" },
    security: { title: "Security", icon: "security", tone: "warn" },
    warning: { title: "Warnings", icon: "warning", tone: "info" }
  };
  var SHOWN = 40;
  var open = /* @__PURE__ */ new Set();
  function renderFinding(f) {
    const details = el("details", "finding");
    details.open = open.has(f.id);
    details.addEventListener("toggle", () => details.open ? open.add(f.id) : open.delete(f.id));
    const summary = el("summary", "");
    add(summary, icon("chevron", "caret"), el("span", "finding-label", f.label), chip(String(f.hits.length), CATEGORY[f.category].tone), el("span", "finding-why", f.why));
    const list = el("ul", "hits");
    for (const h of f.hits.slice(0, SHOWN)) {
      const item = el("li", "");
      const name = h.namespace ? `${h.namespace}/${h.name}` : h.name;
      add(
        item,
        linkButton(name, () => sdk.open({ kind: h.kind, namespace: h.namespace, name: h.name }).catch(banner.show), `Open ${name}`),
        el("span", "hit-detail", h.detail),
        h.node && h.kind !== "nodes" ? el("span", "hit-node", `on ${h.node}`) : null
      );
      list.appendChild(item);
    }
    if (f.hits.length > SHOWN) list.appendChild(el("li", "faint", `and ${f.hits.length - SHOWN} more`));
    add(details, summary, list);
    return details;
  }
  function renderFindings(root, report, securityOn) {
    clear(root);
    if (!report.findings.length) {
      add(root, add(el("div", "all-clear"), icon("check"), el("span", "", "Nothing wrong that the office can see. The floor holds.")));
      return;
    }
    for (const category of ["error", "security", "warning"]) {
      const findings = report.findings.filter((f) => f.category === category);
      if (!findings.length) continue;
      const c = CATEGORY[category];
      const group2 = el("section", "group");
      add(group2, add(el("h2", ""), icon(c.icon), el("span", "", c.title)));
      if (category === "security" && !securityOn) group2.appendChild(el("p", "faint", "Security checks are off in the settings, so these do not heat the floor."));
      for (const f of findings) group2.appendChild(renderFinding(f));
      root.appendChild(group2);
    }
  }
  function renderFoot(root, ctx2) {
    clear(root);
    const links = ctx2.plugin?.links ?? [];
    add(root, el("span", "faint", "Inspired by Pixel Agents."));
    for (const l of links) root.appendChild(button(l.label, "link", "link", () => void sdk.openUrl(l.url)));
  }

  // src/ui/load.ts
  async function listOr(kind, missing) {
    try {
      return await sdk.list({ kind, namespace: "" });
    } catch (err) {
      missing.set(kind, message(err));
      return [];
    }
  }
  async function loadSnapshot() {
    const missing = /* @__PURE__ */ new Map();
    const [nodes, pods, events] = await Promise.all([
      listOr("nodes", missing),
      listOr("pods", missing),
      listOr("events", missing)
    ]);
    return { nodes, pods, events, missing };
  }
  async function loadLoads(nodes) {
    const notes = [];
    const where = [];
    const sources = [];
    let covered = false;
    try {
      const outcome = loadFromCharts(await sdk.charts({ minutes: 5 }), nodes);
      if (outcome.loads.size) {
        sources.push(outcome.loads);
        where.push(outcome.where);
        covered = outcome.loads.size >= nodes.length && !outcome.note;
      }
      if (outcome.note) notes.push(outcome.note);
    } catch (err) {
      notes.push(`could not ask for charts (${message(err)})`);
    }
    if (!covered) {
      try {
        const items = await sdk.list({ kind: "crd:nodes.metrics.k8s.io", namespace: "" });
        const loads2 = loadFromNodeMetrics(items, nodes);
        if (loads2.size) {
          sources.push(loads2);
          where.push("metrics-server");
        }
      } catch (err) {
        notes.push(metricsServerProblem(err));
      }
    }
    sources.push(loadFromRequests(nodes));
    const loads = mergeLoads(nodes, sources);
    return { loads, where, note: notes.join("; ") };
  }
  function metricsServerProblem(err) {
    const text = message(err);
    if (/not served|could not find the requested resource|no matches for|not found/i.test(text)) return "metrics-server is not installed";
    if (/service unavailable|503/i.test(text)) return "metrics-server is installed but not answering";
    return `metrics-server did not answer (${text})`;
  }

  // src/ui/panel.ts
  var uid = 0;
  function field(label, control, hint) {
    const id = `f${++uid}`;
    control.id = id;
    const wrap = el("div", "field");
    const lab = el("label", "", label);
    lab.htmlFor = id;
    add(wrap, lab, control, hint ? el("span", "hint", hint) : null);
    return wrap;
  }
  function range(label, value, min, max, step, format, onInput, hint) {
    const input = el("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const out = el("output", "", format(value));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      out.textContent = format(v);
      onInput(v);
    });
    const wrap = field(label, input, hint);
    wrap.classList.add("range");
    wrap.insertBefore(out, input.nextSibling);
    return wrap;
  }
  function select(label, value, options, onChange, hint) {
    const s = el("select");
    for (const [v, text] of options) {
      const o = el("option", "", text);
      o.value = String(v);
      o.selected = v === value;
      s.appendChild(o);
    }
    s.addEventListener("change", () => {
      const found = options.find(([v]) => String(v) === s.value);
      if (found) onChange(found[0]);
    });
    return field(label, s, hint);
  }
  function toggle(label, checked, onChange, hint) {
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    const wrap = field(label, input, hint);
    wrap.classList.add("toggle");
    return wrap;
  }
  function group(title, ...fields) {
    const g = el("fieldset", "group");
    add(g, el("legend", "", title), ...fields);
    return g;
  }
  var percent = (v) => `${Math.round(v * 100)}%`;
  var times = (v) => v === 0 ? "off" : `×${v.toFixed(1)}`;
  function renderPanel(root, settings2, preview2, on) {
    clear(root);
    const s = settings2;
    let p = { ...preview2 };
    const officeGroup = group(
      "Office",
      select(
        "Size",
        s.officeSize,
        [["auto", "Grows with the cluster"], ["small", "Small"], ["medium", "Medium"], ["large", "Large"]],
        (v) => on.change({ officeSize: v }),
        "Bigger offices get wider aisles, a meeting table, a bigger lounge, and a server rack for every four nodes."
      ),
      select("People per node", s.peoplePerNode, PEOPLE_PER_NODE.map((v) => [v, v < 1 ? `one per ${1 / v} nodes` : `${v}`]), (v) => on.change({ peoplePerNode: v })),
      range("Most people", s.maxPeople, 4, 200, 1, String, (v) => on.change({ maxPeople: v }), "Past this, one person stands for several nodes.")
    );
    const busyGroup = group(
      "Busyness",
      range("Busyness", s.busyness, 0, 3, 0.1, times, (v) => on.change({ busyness: v }), "Multiplies every node’s load: turn it up for a livelier office."),
      range("CPU counts for", s.cpuWeight, 0, 100, 5, String, (v) => on.change({ cpuWeight: v })),
      range("Memory counts for", s.memoryWeight, 0, 100, 5, String, (v) => on.change({ memoryWeight: v })),
      range("Disk counts for", s.diskWeight, 0, 100, 5, String, (v) => on.change({ diskWeight: v }))
    );
    const namespaces = el("input");
    namespaces.type = "text";
    namespaces.value = s.ignoreNamespaces.join(", ");
    namespaces.spellcheck = false;
    namespaces.addEventListener("change", () => on.change({ ignoreNamespaces: parseNamespaces(namespaces.value) }));
    const troubleGroup = group(
      "Trouble",
      range("Sensitivity", s.hazardSensitivity, 0, 3, 0.1, times, (v) => on.change({ hazardSensitivity: v }), "How quickly problems show: litter first, then cracks. Off keeps the floor spotless."),
      toggle("Security checks", s.securityChecks, (v) => on.change({ securityChecks: v }), "Privileged pods, host access, root, unpinned images. They add to the trouble and let intruders in."),
      toggle("Warning events", s.warningEvents, (v) => on.change({ warningEvents: v })),
      field("Skip for security", namespaces, "Namespaces whose pods the security checks leave alone, comma-separated.")
    );
    const lavaGroup = group(
      "Lava",
      toggle("Lava when it gets really bad", s.lava, (v) => on.change({ lava: v }), "Off, the floor only ever cracks."),
      range("Starts at", s.lavaStart, 0.3, 1, 0.05, percent, (v) => on.change({ lavaStart: v }), "The trouble level where the floor gives way. Below it: litter and cracks."),
      range("Most of the floor", s.lavaMax, 0.05, 0.8, 0.05, percent, (v) => on.change({ lavaMax: v }), "How much lava there is at 100% trouble."),
      select("What rises", s.hazardStyle, [["lava", "Lava"], ["flood", "Flood water"], ["slime", "Toxic slime"]], (v) => on.change({ hazardStyle: v }))
    );
    const lookGroup = group(
      "Look",
      select("Floor", s.floor, [["wood", "Wood"], ["carpet", "Carpet"], ["tiles", "Tiles"], ["concrete", "Concrete"]], (v) => on.change({ floor: v })),
      select("Time of day", s.dayNight, [["auto", "Follow the clock"], ["day", "Always day"], ["night", "Always night"]], (v) => on.change({ dayNight: v })),
      select("Zoom", s.scale, SCALE_CHOICES.map((v) => [v, v === 0 ? "Fit" : `${v}×`]), (v) => on.change({ scale: v })),
      range("Speed", s.speed, 0.25, 3, 0.25, (v) => `×${v}`, (v) => on.change({ speed: v })),
      toggle("Names under desks", s.names, (v) => on.change({ names: v })),
      toggle("Intruders", s.intruders, (v) => on.change({ intruders: v })),
      toggle("Boxes for unscheduled pods", s.inbox, (v) => on.change({ inbox: v })),
      select("Refresh every", s.refresh, REFRESH_CHOICES.map((v) => [v, `${v} s`]), (v) => on.change({ refresh: v }))
    );
    const previewRange = (label, key) => {
      const wrap = el("div", "preview-row");
      const box = el("input");
      box.type = "checkbox";
      box.checked = p[key] !== null;
      const slider = el("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.01";
      slider.value = String(p[key] ?? 0.5);
      slider.disabled = !box.checked;
      const out = el("output", "", box.checked ? percent(Number(slider.value)) : "live");
      const push = () => {
        p = { ...p, [key]: box.checked ? Number(slider.value) : null };
        slider.disabled = !box.checked;
        out.textContent = box.checked ? percent(Number(slider.value)) : "live";
        on.preview(p);
      };
      box.addEventListener("change", push);
      slider.addEventListener("input", push);
      const lab = el("label", "");
      add(lab, box, el("span", "", label));
      add(wrap, lab, slider, out);
      return wrap;
    };
    const previewGroup = group("Preview (not saved)", previewRange("Force busyness", "busy"), previewRange("Force trouble", "hazard"));
    const actions = el("div", "panel-actions");
    add(
      actions,
      button("Reset to defaults", "secondary", "undo", () => on.reset())
    );
    add(root, officeGroup, busyGroup, troubleGroup, lavaGroup, lookGroup, previewGroup, actions);
  }

  // src/ui/sprites.ts
  var SPRITE_W = 12;
  var SPRITE_H = 18;
  var SKIN = ["#f5d0b0", "#e8b894", "#d49a6a", "#b07040", "#8d5524", "#5c3a1e", "#f1c27d", "#ffdcb5"];
  var HAIR = ["#2c1b10", "#4a2c18", "#7a4a26", "#b5651d", "#d8b04a", "#e9dcc4", "#1b1b1f", "#a83232", "#5b4bbf", "#2f6f73"];
  var SHIRT = ["#4a86ff", "#e0564f", "#46b37a", "#f0a53c", "#9b6cf0", "#2bb3c0", "#f06ca4", "#e6d24a", "#7d8a99", "#ff8a3d", "#3fbf9f", "#c9d6e8"];
  var PANTS = ["#2b3a55", "#3b3b46", "#4a3a2a", "#1f2a36", "#50607a", "#2d4a3c"];
  var SHOES = ["#1c1c22", "#3a2a1c", "#e8e8ea", "#5a2020"];
  var STYLES = ["short", "short", "long", "bun", "cap", "bald", "long", "short"];
  function lookFor(id, manager) {
    const r = rng(hash(id));
    const look = {
      key: "",
      skin: pick(SKIN, r),
      hair: pick(HAIR, r),
      hairStyle: pick(STYLES, r),
      shirt: manager ? pick(["#2b2f3a", "#39324a", "#233a4f", "#4a2f2f"], r) : pick(SHIRT, r),
      pants: manager ? "#20242c" : pick(PANTS, r),
      shoes: pick(SHOES, r),
      suit: manager,
      eyes: "#1a1418"
    };
    if (look.hairStyle === "cap") look.hair = pick(["#e0564f", "#4a86ff", "#46b37a", "#1b1b1f", "#f0a53c"], r);
    look.key = [look.skin, look.hair, look.hairStyle, look.shirt, look.pants, look.shoes, look.suit].join();
    return look;
  }
  var INTRUDER = {
    key: "intruder",
    skin: "#15151c",
    hair: "#23232d",
    hairStyle: "hood",
    shirt: "#23232d",
    pants: "#18181f",
    shoes: "#0d0d11",
    suit: false,
    eyes: "#7dff9a"
  };
  var HEAD_FRONT = [
    "....hhhh....",
    "...hhhhhh...",
    "..hhhhhhhh..",
    "..hssssssh..",
    "..sesssses..",
    "..ssssssss..",
    "...ssmmss...",
    "....ssss...."
  ];
  var HEAD_BACK = [
    "....hhhh....",
    "...hhhhhh...",
    "..hhhhhhhh..",
    "..hhhhhhhh..",
    "..hhhhhhhh..",
    "..shhhhhhs..",
    "...hhhhhh...",
    "....ssss...."
  ];
  var HEAD_SIDE = [
    "....hhhh....",
    "...hhhhhhh..",
    "..hhhhhhhh..",
    "..hhhhssss..",
    "..hhhsssse..",
    "..hhssssss..",
    "...hsssss...",
    "....sss....."
  ];
  var BODY_FRONT = ["..cccccccc..", ".cccccccccc.", ".cccccccccc.", ".sccccccccs.", ".s.cccccc.s.", "...cccccc...", "...pppppp..."];
  var BODY_BACK = BODY_FRONT;
  var BODY_SIDE = ["...cccccc...", "...cccccc...", "...cccccc...", "...ccccsc...", "...ccccs....", "...cccccc...", "...pppppp..."];
  function paint(g, rows, top, colours2, mirror = false) {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const colour = colours2[row[x]];
        if (!colour) continue;
        g.fillStyle = colour;
        g.fillRect(mirror ? SPRITE_W - 1 - x : x, top + y, 1, 1);
      }
    });
  }
  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * (1 + amount))));
    const r = f(n >> 16 & 255);
    const gg = f(n >> 8 & 255);
    const b = f(n & 255);
    return "#" + (1 << 24 | r << 16 | gg << 8 | b).toString(16).slice(1);
  }
  function hairOverlay(g, look, dir, top) {
    g.fillStyle = look.hair;
    const px = (x, y) => {
      g.fillRect(dir === "left" ? SPRITE_W - 1 - x : x, top + y, 1, 1);
    };
    switch (look.hairStyle) {
      case "long":
        for (let y = 3; y < 11; y++) {
          if (dir === "down") {
            if (y < 10) px(1, y), px(10, y);
            if (y < 6) px(2, y), px(9, y);
          } else if (dir === "up") {
            if (y >= 5) for (let x = 2; x < 10; x++) px(x, y);
          } else if (y < 10) {
            px(2, y), px(3, y);
          }
        }
        break;
      case "bun":
        for (let x = 5; x < 7; x++) px(x, -1), px(x, -2);
        px(4, -1);
        px(7, -1);
        break;
      case "cap":
        for (let x = 2; x < 10; x++) px(x, 0), px(x, 1), px(x, 2);
        g.fillStyle = shade(look.hair, -0.35);
        if (dir === "down") for (let x = 2; x < 10; x++) px(x, 3);
        else if (dir !== "up") for (let x = 7; x < 12; x++) px(x, 3);
        break;
      case "hood":
        for (let y = 0; y < 9; y++) px(1, y), px(10, y);
        for (let x = 2; x < 10; x++) px(x, -1);
        break;
      default:
        break;
    }
  }
  function legs(g, look, dir, frame2, top) {
    const lift = [0, 1, 0, -1][frame2 % 4];
    const draw = (x, dy) => {
      g.fillStyle = look.pants;
      g.fillRect(x, top, 2, 2 - Math.max(0, dy));
      g.fillStyle = look.shoes;
      g.fillRect(x, top + 2 - Math.max(0, dy), 2, 1);
    };
    if (dir === "left" || dir === "right") {
      const a = dir === "right" ? 4 + lift : 6 - lift;
      const b = dir === "right" ? 6 - lift : 4 + lift;
      draw(Math.min(a, b), 0);
      draw(Math.max(a, b), 0);
      return;
    }
    draw(3, lift > 0 ? 1 : 0);
    draw(7, lift < 0 ? 1 : 0);
  }
  function colours(look, dir) {
    const hairless = look.hairStyle === "bald" || look.hairStyle === "cap";
    return {
      h: look.hairStyle === "bald" ? shade(look.skin, -0.08) : look.hair,
      s: look.skin,
      e: look.eyes,
      m: look.hairStyle === "hood" ? look.skin : shade(look.skin, -0.25),
      c: look.shirt,
      p: look.pants,
      ...hairless && dir === "up" ? { h: look.hairStyle === "cap" ? look.hair : shade(look.skin, -0.08) } : {}
    };
  }
  function suitOverlay(g, dir, top) {
    if (dir !== "down") return;
    g.fillStyle = "#f2f2f2";
    g.fillRect(5, top, 2, 3);
    g.fillStyle = "#d23c3c";
    g.fillRect(5, top + 1, 2, 1);
    g.fillRect(5, top + 2, 2, 3);
  }
  function drawPerson(g, look, dir, pose, frame2) {
    const mirror = dir === "left";
    const head = dir === "down" ? HEAD_FRONT : dir === "up" ? HEAD_BACK : HEAD_SIDE;
    const body = dir === "down" ? BODY_FRONT : dir === "up" ? BODY_BACK : BODY_SIDE;
    const col = colours(look, dir);
    let bob = pose === "walk" && frame2 % 2 === 1 ? 1 : 0;
    if (pose === "sleep") bob = 3;
    const headTop = 0 + bob;
    const bodyTop = 8 + (pose === "sleep" ? 1 : bob);
    paint(g, body, bodyTop, col, mirror);
    if (look.suit) suitOverlay(g, dir, bodyTop);
    if (pose === "type") {
      g.fillStyle = look.skin;
      const up = frame2 % 2 === 0;
      g.fillRect(1, bodyTop + (up ? 2 : 3), 1, 1);
      g.fillRect(10, bodyTop + (up ? 3 : 2), 1, 1);
    }
    paint(g, head, headTop, col, mirror);
    hairOverlay(g, look, dir, headTop);
    if (pose === "walk" || pose === "stand") legs(g, look, dir, pose === "walk" ? frame2 : 0, 15);
    if (pose === "sit-front") {
      g.fillStyle = look.pants;
      g.fillRect(3, 15, 6, 1);
      g.fillStyle = look.shoes;
      g.fillRect(3, 16, 2, 1);
      g.fillRect(7, 16, 2, 1);
    }
  }
  var cache = /* @__PURE__ */ new Map();
  function personSprite(look, dir, pose, frame2) {
    const f = pose === "walk" ? frame2 % 4 : pose === "type" ? frame2 % 2 : 0;
    const key = `${look.key}|${dir}|${pose}|${f}`;
    let canvas2 = cache.get(key);
    if (!canvas2) {
      canvas2 = document.createElement("canvas");
      canvas2.width = SPRITE_W;
      canvas2.height = SPRITE_H + 2;
      const g = canvas2.getContext("2d");
      g.translate(0, 2);
      drawPerson(g, look, dir, pose, f);
      cache.set(key, canvas2);
    }
    return canvas2;
  }
  var SPRITE_PAD = 2;

  // src/ui/render.ts
  var FLOORS = {
    wood: { a: "#b8844f", b: "#a8763f", line: "#7d5530" },
    carpet: { a: "#5a6b8c", b: "#52627f", line: "#46546e" },
    tiles: { a: "#d8dde3", b: "#c9cfd6", line: "#aab2bc" },
    concrete: { a: "#9a9a96", b: "#8f8f8b", line: "#7c7c78" }
  };
  var HAZARDS = {
    lava: { base: "#b8330c", hot: "#f97316", core: "#fde047", crust: "#3b1a0b", rim: "#7c2d12", crack: "#2a1a10", glow: "rgba(255, 120, 30, 0.28)" },
    flood: { base: "#2563eb", hot: "#60a5fa", core: "#dbeafe", crust: "#1e3a8a", rim: "#93c5fd", crack: "#1e40af", glow: "rgba(90, 160, 255, 0.18)" },
    slime: { base: "#4d7c0f", hot: "#84cc16", core: "#d9f99d", crust: "#1a2e05", rim: "#365314", crack: "#264010", glow: "rgba(160, 255, 60, 0.2)" }
  };
  var WALL = { face: "#e9e4da", faceTop: "#f4f0e8", trim: "#3c3f4a", base: "#7a6a58", side: "#3c3f4a", sideTop: "#5a5e6c" };
  function rect(g, colour, x, y, w, h) {
    g.fillStyle = colour;
    g.fillRect(x, y, w, h);
  }
  function mix(a, b, t) {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const ch = (s) => Math.round((pa >> s & 255) * (1 - t) + (pb >> s & 255) * t);
    return "#" + (1 << 24 | ch(16) << 16 | ch(8) << 8 | ch(0)).toString(16).slice(1);
  }
  function nightLevel(settings2, now = /* @__PURE__ */ new Date()) {
    if (settings2.dayNight === "day") return 0;
    if (settings2.dayNight === "night") return 1;
    const h = now.getHours() + now.getMinutes() / 60;
    if (h >= 7.5 && h <= 18) return 0;
    if (h > 18 && h < 21) return (h - 18) / 3;
    if (h > 5 && h < 7.5) return 1 - (h - 5) / 2.5;
    return 1;
  }
  function drawFloorTile(g, t, x, y, style, seed) {
    const px = x * TILE;
    const py = y * TILE;
    if (t === T.Room) {
      rect(g, (x + y) % 2 ? "#6b5470" : "#735b78", px, py, TILE, TILE);
      rect(g, "#62496a", px + (seed >> 3) % 14, py + (seed >> 7) % 14, 1, 1);
      return;
    }
    if (t === T.Lounge) {
      rect(g, (x + y) % 2 ? "#e6dcc8" : "#d9ccb4", px, py, TILE, TILE);
      rect(g, "#c7b89c", px, py + TILE - 1, TILE, 1);
      rect(g, "#c7b89c", px + TILE - 1, py, 1, TILE);
      return;
    }
    const f = FLOORS[style];
    switch (style) {
      case "wood":
        for (let row = 0; row < 4; row++) {
          rect(g, (row + y + (seed & 1)) % 2 ? f.a : f.b, px, py + row * 4, TILE, 4);
          rect(g, f.line, px, py + row * 4 + 3, TILE, 1);
          rect(g, f.line, px + (x * 7 + row * 5 + y * 3) % 16, py + row * 4, 1, 3);
        }
        break;
      case "carpet":
        rect(g, f.a, px, py, TILE, TILE);
        for (let i = 0; i < 6; i++) rect(g, f.b, px + (seed >> i * 2 & 15), py + (seed >> i * 3 + 1 & 15), 1, 1);
        break;
      case "tiles":
        rect(g, (x + y) % 2 ? f.a : f.b, px, py, TILE, TILE);
        rect(g, f.line, px, py + TILE - 1, TILE, 1);
        rect(g, f.line, px + TILE - 1, py, 1, TILE);
        break;
      case "concrete":
        rect(g, f.a, px, py, TILE, TILE);
        for (let i = 0; i < 5; i++) rect(g, i % 2 ? f.b : f.line, px + (seed >> i * 3 & 15), py + (seed >> i * 2 + 5 & 15), 1, 1);
        break;
    }
  }
  function drawWindow(g, px, py, w, night) {
    rect(g, "#6b5a48", px + 2, py + 5, w - 4, 22);
    const sky = mix("#8ecdf5", "#131a3a", night);
    rect(g, sky, px + 4, py + 7, w - 8, 18);
    rect(g, mix("#bfe4fb", "#1d2752", night), px + 4, py + 7, w - 8, 6);
    if (night < 0.5) {
      rect(g, "#ffffff", px + 7, py + 10, 6, 2);
      rect(g, "#ffffff", px + 9, py + 9, 3, 1);
      rect(g, "#6fa36a", px + 4, py + 21, w - 8, 4);
      rect(g, "#5b8f57", px + 10, py + 19, 6, 2);
    } else {
      rect(g, "#fdf6c9", px + w - 12, py + 9, 3, 3);
      rect(g, "#ffffff", px + 7, py + 12, 1, 1);
      rect(g, "#ffffff", px + 12, py + 18, 1, 1);
      rect(g, "#2a2f4a", px + 4, py + 21, w - 8, 4);
      rect(g, "#f5d76e", px + 8, py + 22, 1, 1);
      rect(g, "#f5d76e", px + 14, py + 22, 1, 1);
    }
    rect(g, "#6b5a48", px + w / 2 - 1, py + 7, 2, 18);
    rect(g, "#6b5a48", px + 4, py + 15, w - 8, 1);
    rect(g, "#8a7660", px + 1, py + 26, w - 2, 2);
  }
  function drawWallItem(g, it, night) {
    const px = it.x * TILE;
    const py = it.y * TILE;
    switch (it.type) {
      case "window":
        drawWindow(g, px, py, it.w * TILE, night);
        break;
      case "board": {
        const w = it.w * TILE;
        rect(g, "#9aa3ad", px + 2, py + 6, w - 4, 20);
        rect(g, "#fbfbfb", px + 3, py + 7, w - 6, 18);
        rect(g, "#3b82f6", px + 6, py + 10, 8, 5);
        rect(g, "#ef4444", px + 20, py + 10, 8, 5);
        rect(g, "#10b981", px + 13, py + 18, 8, 5);
        rect(g, "#555555", px + 14, py + 12, 6, 1);
        rect(g, "#555555", px + 17, py + 15, 1, 3);
        rect(g, "#9aa3ad", px + 4, py + 26, w - 8, 2);
        break;
      }
      case "poster": {
        rect(g, "#1d4ed8", px + 9, py + 5, 14, 20);
        rect(g, "#326ce5", px + 10, py + 6, 12, 18);
        const cx = px + 16;
        const cy = py + 15;
        rect(g, "#ffffff", cx - 3, cy - 4, 6, 1);
        rect(g, "#ffffff", cx - 3, cy + 3, 6, 1);
        rect(g, "#ffffff", cx - 4, cy - 3, 1, 6);
        rect(g, "#ffffff", cx + 3, cy - 3, 1, 6);
        rect(g, "#ffffff", cx - 1, cy - 6, 1, 12);
        rect(g, "#ffffff", cx - 6, cy - 1, 12, 1);
        rect(g, "#ffffff", cx - 1, cy - 1, 2, 2);
        break;
      }
      case "clock":
        break;
      case "cloud": {
        const cx = px + 8;
        const cy = py + 12;
        rect(g, "#dfe8f5", cx, cy + 4, 30, 8);
        rect(g, "#dfe8f5", cx + 4, cy, 12, 6);
        rect(g, "#dfe8f5", cx + 14, cy - 3, 12, 8);
        rect(g, "#b9c8dd", cx, cy + 11, 30, 1);
        rect(g, "#326ce5", cx + 12, cy + 4, 6, 6);
        rect(g, "#ffffff", cx + 14, cy + 6, 2, 2);
        break;
      }
      default:
        break;
    }
  }
  function drawBackground(g, layout, style, night) {
    const { w, h, tiles } = layout;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = tiles[y * w + x];
        const px = x * TILE;
        const py = y * TILE;
        if (t === T.Wall) {
          if (y < 2 && x > 0 && x < w - 1) {
            rect(g, y === 0 ? WALL.faceTop : WALL.face, px, py, TILE, TILE);
            if (y === 0) rect(g, WALL.trim, px, py, TILE, 3);
            if (y === 1) rect(g, WALL.base, px, py + TILE - 3, TILE, 3);
          } else {
            rect(g, WALL.side, px, py, TILE, TILE);
            rect(g, WALL.sideTop, px, py, TILE, 2);
          }
          continue;
        }
        let floor = t;
        if (t === T.Glass || t === T.Door) floor = y === h - 1 ? T.Lounge : tiles[y * w + x - 1] === T.Room ? T.Room : T.Floor;
        drawFloorTile(g, floor, x, y, style, hash(`${x},${y}`));
        if (t === T.Glass) {
          rect(g, "rgba(170, 215, 245, 0.45)", px + 5, py, 6, TILE);
          rect(g, "#8aa4bc", px + 5, py, 1, TILE);
          rect(g, "#8aa4bc", px + 10, py, 1, TILE);
          rect(g, "rgba(255, 255, 255, 0.6)", px + 7, py + (x * 5 + y * 3) % 10, 1, 4);
          if (y % 3 === 0) rect(g, "#8aa4bc", px + 5, py, 6, 1);
        }
        if (t === T.Door && y === h - 1) {
          rect(g, "#6e4a2c", px + 1, py + 4, TILE - 2, 10);
          rect(g, "#8a5d38", px + 2, py + 5, TILE - 4, 8);
          rect(g, "#9b7045", px + 3, py + 12, TILE - 6, 2);
        }
      }
    }
    for (const it of layout.items) if (!it.blocks) drawWallItem(g, it, night);
  }
  function drawMarks(g, layout, marks, mask, style) {
    const { w } = layout;
    const glow = HAZARDS[style].hot;
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (!m) continue;
      const x = i % w;
      const y = (i - x) / w;
      const px = x * TILE;
      const py = y * TILE;
      const seed = hash(`${x}:${y}`);
      const ox = 2 + seed % 8;
      const oy = 3 + (seed >> 4) % 8;
      if (m === Mark.Litter) {
        if (seed & 32) {
          rect(g, "#e9e9e2", px + ox, py + oy, 4, 3);
          rect(g, "#c9c9c0", px + ox + 1, py + oy + 1, 2, 1);
          rect(g, "#ffffff", px + ox, py + oy, 1, 1);
        } else {
          rect(g, "#f4f4ee", px + ox, py + oy, 5, 4);
          rect(g, "#9aa3ad", px + ox + 1, py + oy + 1, 3, 1);
          rect(g, "#9aa3ad", px + ox + 1, py + oy + 2, 2, 1);
        }
      } else if (m === Mark.Stain) {
        g.globalAlpha = 0.55;
        rect(g, "#5a3a22", px + ox, py + oy + 1, 6, 2);
        rect(g, "#5a3a22", px + ox + 1, py + oy, 4, 4);
        g.globalAlpha = 1;
      } else {
        const near = (dx, dy) => mask[(y + dy) * w + x + dx] === 1;
        const hot = near(1, 0) || near(-1, 0) || near(0, 1) || near(0, -1);
        const cx = 3 + seed % 9;
        const line = hot ? glow : "rgba(30, 20, 14, 0.75)";
        rect(g, line, px + cx, py + 2, 1, 5);
        rect(g, line, px + cx + 1, py + 6, 1, 4);
        rect(g, line, px + cx - 1, py + 9, 1, 5);
        rect(g, line, px + cx + 2, py + 9, 4, 1);
        rect(g, line, px + cx - 4, py + 4, 4, 1);
      }
    }
  }
  function drawHazard(g, layout, heat, mask, style, clock) {
    const c = HAZARDS[style];
    const { w } = layout;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      const px = x * TILE;
      const py = y * TILE;
      const h = heat[i];
      const seed = hash(`${x}.${y}`);
      const phase = clock * 1.6 + seed % 100 / 16;
      rect(g, c.base, px, py, TILE, TILE);
      for (let k = 0; k < 3; k++) {
        const bx = ((seed >> k * 5 & 15) + Math.sin(phase + k * 2.1) * 3 + 16) % 13;
        const by = ((seed >> k * 5 + 3 & 15) + Math.cos(phase * 0.8 + k) * 3 + 16) % 13;
        rect(g, c.hot, px + Math.floor(bx), py + Math.floor(by), 4, 3);
        rect(g, c.hot, px + Math.floor(bx) + 1, py + Math.floor(by) - 1, 2, 5);
        if (k === 0 && h > 0.6) rect(g, c.core, px + Math.floor(bx) + 1, py + Math.floor(by) + 1, 2, 1);
      }
      const cycle = (clock * 0.7 + seed % 97 / 97) % 1;
      if (cycle < 0.18) {
        const r = cycle < 0.12 ? 1 : 2;
        const bx = px + 4 + seed % 8;
        const by = py + 4 + (seed >> 4) % 8;
        rect(g, c.core, bx - r, by, r * 2 + 1, 1);
        rect(g, c.core, bx, by - r, 1, r * 2 + 1);
      }
      const edge = (dx, dy) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx < 0 || ny < 0 || nx >= w || ny >= layout.h || !mask[ny * w + nx];
      };
      if (edge(0, -1)) {
        rect(g, c.crust, px, py, TILE, 2);
        rect(g, c.rim, px, py + 2, TILE, 1);
      }
      if (edge(0, 1)) {
        rect(g, c.crust, px, py + TILE - 2, TILE, 2);
        rect(g, c.rim, px, py + TILE - 3, TILE, 1);
      }
      if (edge(-1, 0)) {
        rect(g, c.crust, px, py, 2, TILE);
        rect(g, c.rim, px + 2, py, 1, TILE);
      }
      if (edge(1, 0)) {
        rect(g, c.crust, px + TILE - 2, py, 2, TILE);
        rect(g, c.rim, px + TILE - 3, py, 1, TILE);
      }
    }
  }
  var itemCache = /* @__PURE__ */ new Map();
  function sprite(key, w, h, draw) {
    let c = itemCache.get(key);
    if (!c) {
      c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      draw(c.getContext("2d"));
      itemCache.set(key, c);
    }
    return c;
  }
  function deskSprite() {
    return sprite("desk", 32, 16, (g) => {
      rect(g, "#b88352", 0, 2, 32, 2);
      rect(g, "#9c6b3f", 0, 4, 32, 6);
      rect(g, "#7a522e", 0, 10, 32, 4);
      rect(g, "#5e3f24", 1, 14, 3, 2);
      rect(g, "#5e3f24", 28, 14, 3, 2);
      rect(g, "#d6d9de", 10, 7, 11, 3);
      rect(g, "#aeb3ba", 10, 9, 11, 1);
      rect(g, "#d6d9de", 23, 7, 2, 3);
    });
  }
  function chairSprite() {
    return sprite("chair", 16, 16, (g) => {
      rect(g, "#2f3440", 2, 8, 12, 4);
      rect(g, "#434a59", 3, 8, 10, 1);
      rect(g, "#2f3440", 7, 12, 2, 2);
      rect(g, "#1f232b", 3, 14, 10, 1);
      rect(g, "#1f232b", 3, 15, 2, 1);
      rect(g, "#1f232b", 11, 15, 2, 1);
    });
  }
  function itemSprite(it) {
    switch (it.type) {
      case "plant":
        return sprite("plant", 16, 24, (g) => {
          rect(g, "#2f7d43", 4, 2, 8, 8);
          rect(g, "#3f9d56", 2, 5, 5, 6);
          rect(g, "#3f9d56", 9, 4, 5, 7);
          rect(g, "#56b86d", 6, 0, 4, 5);
          rect(g, "#2f7d43", 5, 10, 6, 4);
          rect(g, "#b5653b", 3, 14, 10, 8);
          rect(g, "#9a5230", 3, 20, 10, 2);
          rect(g, "#cf7a4c", 3, 14, 10, 2);
        });
      case "coffee":
        return sprite("coffee", 16, 26, (g) => {
          rect(g, "#8b7a66", 0, 16, 16, 10);
          rect(g, "#a8957d", 0, 16, 16, 2);
          rect(g, "#3a3d45", 3, 2, 10, 14);
          rect(g, "#50545e", 4, 3, 8, 4);
          rect(g, "#e84a4a", 10, 9, 2, 1);
          rect(g, "#1d1f24", 6, 11, 4, 3);
          rect(g, "#f4f4f4", 6, 13, 3, 3);
        });
      case "cooler":
        return sprite("cooler", 16, 28, (g) => {
          rect(g, "#9fd3f5", 4, 0, 8, 10);
          rect(g, "#cdeafc", 5, 1, 2, 7);
          rect(g, "#6aa6d6", 6, 10, 4, 2);
          rect(g, "#e9edf2", 3, 12, 10, 14);
          rect(g, "#c8cfd8", 3, 24, 10, 2);
          rect(g, "#3b82f6", 6, 16, 2, 2);
          rect(g, "#ef4444", 9, 16, 2, 2);
        });
      case "vending":
        return sprite("vending", 16, 30, (g) => {
          rect(g, "#b9303a", 1, 0, 14, 28);
          rect(g, "#d8434d", 1, 0, 14, 2);
          rect(g, "#1d2233", 3, 3, 8, 18);
          for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) rect(g, ["#f0a53c", "#46b37a", "#4a86ff", "#e6d24a"][(r + k) % 4], 4 + k * 2, 5 + r * 4, 1, 2);
          rect(g, "#d6d9de", 12, 6, 2, 6);
          rect(g, "#1d2233", 3, 23, 8, 3);
          rect(g, "#7a1d24", 1, 28, 14, 2);
        });
      case "couch":
        return sprite("couch", 48, 20, (g) => {
          rect(g, "#7a3f52", 0, 0, 48, 9);
          rect(g, "#8a4b5c", 1, 1, 46, 3);
          rect(g, "#9b5a6c", 2, 9, 44, 7);
          rect(g, "#7a3f52", 16, 9, 1, 7);
          rect(g, "#7a3f52", 31, 9, 1, 7);
          rect(g, "#6a3446", 0, 4, 3, 14);
          rect(g, "#6a3446", 45, 4, 3, 14);
          rect(g, "#4a2433", 2, 18, 3, 2);
          rect(g, "#4a2433", 43, 18, 3, 2);
        });
      case "shelf":
        return sprite("shelf", 16, 34, (g) => {
          rect(g, "#6b4a2e", 0, 0, 16, 34);
          rect(g, "#4a321f", 1, 1, 14, 32);
          const books = ["#e0564f", "#4a86ff", "#46b37a", "#f0a53c", "#9b6cf0", "#e6d24a", "#2bb3c0"];
          for (let s = 0; s < 4; s++) {
            rect(g, "#6b4a2e", 1, 8 + s * 8, 14, 1);
            for (let b = 0; b < 5; b++) rect(g, books[(s * 3 + b) % books.length], 2 + b * 3 - (b > 3 ? 1 : 0), 2 + s * 8 + b % 2, 2, 6 - b % 2);
          }
        });
      case "printer":
        return sprite("printer", 16, 18, (g) => {
          rect(g, "#6b6f78", 2, 10, 12, 8);
          rect(g, "#e5e7eb", 1, 2, 14, 8);
          rect(g, "#c4c8cf", 1, 8, 14, 2);
          rect(g, "#ffffff", 4, 0, 8, 3);
          rect(g, "#22c55e", 12, 4, 1, 1);
        });
      case "table":
        return sprite(`table${it.w}`, it.w * TILE, it.h * TILE + 4, (g) => {
          const tw = it.w * TILE;
          const th = it.h * TILE;
          rect(g, "#6e4a2c", 0, 2, tw, th - 4);
          rect(g, "#8a5d38", 1, 3, tw - 2, th - 7);
          rect(g, "#a06d42", 2, 4, tw - 4, 2);
          rect(g, "#5a3b22", 2, th - 2, 3, 4);
          rect(g, "#5a3b22", tw - 5, th - 2, 3, 4);
          for (let x = 8; x + 8 < tw; x += 20) {
            rect(g, "#c4c8cf", x, 8, 8, 5);
            rect(g, "#38bdf8", x + 1, 9, 6, 3);
            rect(g, "#f4f4ee", x + 11, 14, 5, 4);
          }
        });
      case "rack":
        return sprite("rack", 16, 34, (g) => {
          rect(g, "#1f232b", 1, 0, 14, 34);
          rect(g, "#2f3440", 2, 1, 12, 32);
          for (let u = 0; u < 7; u++) rect(g, "#15181e", 3, 3 + u * 4, 10, 3);
        });
      default:
        return null;
    }
  }
  var SCREEN_W = 12;
  var SCREEN_H = 7;
  function drawMonitor(g, desk, agent, px, py, clock) {
    const mx = px + 10;
    const my = py - 6;
    rect(g, "#2a2d34", mx, my, 14, 10);
    rect(g, "#2a2d34", mx + 6, my + 10, 2, 2);
    rect(g, "#3a3e47", mx + 4, my + 11, 6, 1);
    const sx = mx + 1;
    const sy = my + 1;
    const present = !!agent && agent.away < 0.5;
    if (!desk || !agent) {
      rect(g, "#0c0e12", sx, sy, SCREEN_W, SCREEN_H);
      return;
    }
    if (desk.mood === "down") {
      rect(g, "#1d4ed8", sx, sy, SCREEN_W, SCREEN_H);
      rect(g, "#dbeafe", sx + 1, sy + 1, 3, 1);
      rect(g, "#dbeafe", sx + 1, sy + 3, 8, 1);
      rect(g, "#dbeafe", sx + 1, sy + 5, 6, 1);
      return;
    }
    if (!present) {
      rect(g, "#0c0e12", sx, sy, SCREEN_W, SCREEN_H);
      const t = clock * 0.8 + hash(desk.person.id) % 50;
      rect(g, "#38bdf8", sx + Math.floor((Math.sin(t) + 1) / 2 * (SCREEN_W - 1)), sy + Math.floor((Math.cos(t * 1.3) + 1) / 2 * (SCREEN_H - 1)), 1, 1);
      return;
    }
    const hot = desk.activity > 0.85;
    const trouble = desk.mood === "trouble";
    rect(g, hot ? "#2a0f14" : "#0f1a24", sx, sy, SCREEN_W, SCREEN_H);
    const speed = 1 + desk.activity * 10;
    const offset = Math.floor(clock * speed);
    const seed = hash(desk.person.id);
    const palette = trouble ? ["#f87171", "#fca5a5", "#fbbf24"] : hot ? ["#fb923c", "#fca5a5", "#fde68a"] : ["#4ade80", "#60a5fa", "#e5e7eb", "#c084fc"];
    for (let row = 0; row < 3; row++) {
      const n = offset + row;
      const len = 3 + ((seed >> n % 13) + n * 7) % 8;
      const indent = ((seed >> n % 7) + n) % 3;
      rect(g, palette[(n + seed) % palette.length], sx + 1 + indent, sy + 1 + row * 2, Math.min(len, SCREEN_W - 2 - indent), 1);
    }
    if (trouble && Math.floor(clock * 2) % 2 === 0) {
      rect(g, "#ef4444", sx + SCREEN_W - 3, sy + 1, 2, 3);
      rect(g, "#ef4444", sx + SCREEN_W - 3, sy + 5, 2, 1);
    }
  }
  function drawPapers(g, pods, px, py) {
    const sheets = Math.min(6, Math.ceil(pods / 10));
    for (let i = 0; i < sheets; i++) {
      rect(g, i % 2 ? "#f4f4f0" : "#e6e6de", px + 25 - i % 2, py + 5 - i, 6, 2);
    }
  }
  function drawClock(g, it) {
    const cx = it.x * TILE + 8;
    const cy = it.y * TILE + 14;
    rect(g, "#3c3f4a", cx - 6, cy - 6, 12, 12);
    rect(g, "#fafafa", cx - 5, cy - 5, 10, 10);
    const now = /* @__PURE__ */ new Date();
    const hand = (angle, len, colour) => {
      for (let r = 0; r <= len; r++) rect(g, colour, Math.round(cx + Math.sin(angle) * r) - 0.5, Math.round(cy - Math.cos(angle) * r) - 0.5, 1, 1);
    };
    hand((now.getHours() % 12 + now.getMinutes() / 60) * (Math.PI / 6), 2.5, "#1f2937");
    hand(now.getMinutes() * (Math.PI / 30), 4, "#1f2937");
  }
  function drawRackLights(g, it, busy, clock) {
    const px = it.x * TILE;
    const py = (it.y + it.h) * TILE - 34;
    for (let u = 0; u < 7; u++) {
      for (let k = 0; k < 3; k++) {
        const on = Math.sin(clock * (3 + busy * 25) * (1 + k * 0.37) + u * 1.7 + it.x) > 0.2 - busy * 0.6;
        rect(g, on ? k === 2 && busy > 0.85 ? "#f97316" : "#22c55e" : "#0b3d1f", px + 4 + k * 3, py + 4 + u * 4, 1, 1);
      }
    }
  }
  function drawInbox(g, it, count) {
    const n = Math.min(count, 9);
    const baseX = it.x * TILE;
    const baseY = (it.y + 1) * TILE;
    for (let i = 0; i < n; i++) {
      const layer = Math.floor(i / 3);
      const col = i % 3;
      const x = baseX + 1 + col * 10 + layer * 5;
      const y = baseY - 8 - layer * 7;
      if (layer * 5 + col * 10 > 22) continue;
      rect(g, "#b08150", x, y, 9, 7);
      rect(g, "#c99a66", x, y, 9, 2);
      rect(g, "#8a6038", x + 4, y, 1, 7);
    }
  }
  function drawBubble(g, kind, x, y, clock) {
    rect(g, "#1f2330", x - 1, y - 1, 11, 9);
    rect(g, "#ffffff", x, y, 9, 7);
    rect(g, "#ffffff", x + 2, y + 7, 2, 1);
    rect(g, "#1f2330", x + 2, y + 8, 1, 1);
    switch (kind) {
      case "chat": {
        const n = Math.floor(clock * 3) % 4;
        for (let i = 0; i < Math.max(1, n); i++) rect(g, "#374151", x + 1 + i * 3, y + 3, 1, 1);
        break;
      }
      case "bang":
        rect(g, "#dc2626", x + 4, y + 1, 1, 3);
        rect(g, "#dc2626", x + 4, y + 5, 1, 1);
        break;
      case "zzz":
        rect(g, "#3b82f6", x + 2, y + 1, 5, 1);
        rect(g, "#3b82f6", x + 5, y + 2, 1, 1);
        rect(g, "#3b82f6", x + 4, y + 3, 1, 1);
        rect(g, "#3b82f6", x + 3, y + 4, 1, 1);
        rect(g, "#3b82f6", x + 2, y + 5, 5, 1);
        break;
      case "coffee":
        rect(g, "#7c4a2a", x + 2, y + 2, 4, 4);
        rect(g, "#7c4a2a", x + 6, y + 3, 1, 2);
        rect(g, "#d6d3d1", x + 3, y + 1, 1, 1);
        break;
      case "sweat":
        rect(g, "#38bdf8", x + 4, y + 1, 1, 1);
        rect(g, "#38bdf8", x + 3, y + 2, 3, 3);
        break;
      case "fire":
        rect(g, "#f97316", x + 2, y + 2, 5, 4);
        rect(g, "#f97316", x + 3, y + 1, 2, 1);
        rect(g, "#fde047", x + 3, y + 3, 3, 3);
        break;
      case "eye":
        rect(g, "#22c55e", x + 2, y + 3, 2, 1);
        rect(g, "#22c55e", x + 5, y + 3, 2, 1);
        break;
    }
  }
  var Renderer = class {
    canvas;
    ctx;
    buffer = document.createElement("canvas");
    bctx;
    bg = document.createElement("canvas");
    bgKey = "";
    bgLava = null;
    constructor(canvas2) {
      this.canvas = canvas2;
      this.ctx = canvas2.getContext("2d");
      this.bctx = this.buffer.getContext("2d");
    }
    /** The world's size in world pixels. */
    size(layout) {
      return { w: layout.w * TILE, h: layout.h * TILE };
    }
    draw(world2, settings2, view) {
      const { layout, lava } = world2.office;
      const size = this.size(layout);
      const night = nightLevel(settings2);
      const nightStep = Math.round(night * 8) / 8;
      if (this.buffer.width !== size.w || this.buffer.height !== size.h) {
        this.buffer.width = size.w;
        this.buffer.height = size.h;
      }
      if (world2.office.lava !== this.bgLava || this.bgKey !== `${layout.w}x${layout.h}|${settings2.floor}|${settings2.hazardStyle}|${nightStep}`) {
        this.bg.width = size.w;
        this.bg.height = size.h;
        const bg = this.bg.getContext("2d");
        drawBackground(bg, layout, settings2.floor, nightStep);
        drawMarks(bg, layout, lava.marks, lava.mask, settings2.hazardStyle);
        this.bgKey = `${layout.w}x${layout.h}|${settings2.floor}|${settings2.hazardStyle}|${nightStep}`;
        this.bgLava = world2.office.lava;
      }
      const g = this.bctx;
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      g.drawImage(this.bg, 0, 0);
      drawHazard(g, layout, lava.heat, lava.mask, settings2.hazardStyle, world2.clock);
      const items = [];
      const bySeat = /* @__PURE__ */ new Map();
      for (const a of world2.agents) if (a.desk) bySeat.set(`${a.desk.seat.x},${a.desk.seat.y}`, a);
      const deskFor = new Map(world2.office.desks.map((d) => [`${d.seat.x},${d.seat.y}`, d]));
      for (const seat of [...layout.managerSeats, ...layout.seats]) {
        const key = `${seat.x},${seat.y}`;
        const desk = deskFor.get(key) ?? null;
        const agent = bySeat.get(key) ?? null;
        const px = seat.x * TILE;
        const py = (seat.y - 1) * TILE;
        items.push({
          base: seat.y * TILE,
          draw: () => {
            g.drawImage(deskSprite(), px, py);
            drawMonitor(g, desk, agent, px, py, world2.clock);
            if (desk) drawPapers(g, desk.pods, px, py);
          }
        });
        items.push({ base: (seat.y + 1) * TILE + 0.5, draw: () => g.drawImage(chairSprite(), px + 8, seat.y * TILE) });
      }
      for (const it of layout.items) {
        const s = itemSprite(it);
        if (s) {
          const base = it.type === "couch" ? it.y * TILE + 4 : (it.y + it.h) * TILE;
          items.push({
            base,
            draw: () => {
              g.drawImage(s, it.x * TILE, (it.y + it.h) * TILE - s.height + (it.type === "couch" ? 4 : 0));
              if (it.type === "rack") drawRackLights(g, it, world2.office.busy, world2.clock);
            }
          });
        } else if (it.type === "inbox") {
          items.push({ base: (it.y + 1) * TILE - 1, draw: () => drawInbox(g, it, world2.office.unscheduled) });
        }
      }
      for (const a of world2.agents) items.push({ base: a.y + TILE, draw: () => this.drawAgent(g, a, world2.clock, view.hover === a) });
      items.sort((p, q) => p.base - q.base);
      for (const d of items) d.draw();
      this.drawParticles(g, world2);
      for (const it of layout.items) if (it.type === "clock") drawClock(g, it);
      for (const a of world2.agents) {
        if (!a.bubble) continue;
        const { x } = this.agentPos(a);
        drawBubble(g, a.bubble, x + 7, a.y - 16, world2.clock);
      }
      if (night > 0.02) {
        g.fillStyle = `rgba(12, 16, 48, ${0.5 * night})`;
        g.fillRect(0, 0, size.w, size.h);
        g.globalCompositeOperation = "lighter";
        const glow = HAZARDS[settings2.hazardStyle].glow;
        g.globalAlpha = night * 0.6;
        for (let i = 0; i < lava.mask.length; i++) {
          if (lava.mask[i]) rect(g, glow, i % layout.w * TILE, Math.floor(i / layout.w) * TILE, TILE, TILE);
        }
        g.globalAlpha = night;
        for (const a of world2.agents) {
          if (!a.desk || a.away > 0.5 || a.desk.mood === "down") continue;
          rect(g, "rgba(120, 180, 255, 0.16)", a.desk.seat.x * TILE + 11, (a.desk.seat.y - 1) * TILE - 5, 12, 8);
        }
        g.globalAlpha = 1;
        g.globalCompositeOperation = "source-over";
      }
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.round(size.w * view.scale);
      const cssH = Math.round(size.h * view.scale);
      if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
        this.canvas.width = Math.round(cssW * dpr);
        this.canvas.height = Math.round(cssH * dpr);
        this.canvas.style.width = `${cssW}px`;
        this.canvas.style.height = `${cssH}px`;
      }
      const ctx2 = this.ctx;
      ctx2.setTransform(1, 0, 0, 1, 0, 0);
      ctx2.imageSmoothingEnabled = false;
      ctx2.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
      const k = view.scale * dpr;
      if (view.hover) {
        const { x } = this.agentPos(view.hover);
        ctx2.strokeStyle = "#ffffff";
        ctx2.lineWidth = Math.max(1, dpr);
        ctx2.strokeRect((x + 1) * k, (view.hover.y - 5) * k, 14 * k, 22 * k);
      }
      if (settings2.names && view.scale >= 1.5) this.drawNames(ctx2, world2, k, dpr);
    }
    /** Where an agent is drawn: at the desk, slid over to the middle of it. */
    agentPos(a) {
      return { x: a.x + (a.desk ? 8 * (1 - a.away) : 0) };
    }
    drawAgent(g, a, clock, hovered) {
      const { x } = this.agentPos(a);
      const frame2 = Math.floor(a.phase);
      let y = a.y - 2 - SPRITE_PAD;
      if (a.burning > 0 && a.state !== "walk") y -= Math.abs(Math.sin(clock * 12)) * 3;
      const look = a.look;
      if (!a.desk) g.globalAlpha = 0.82;
      if (a.state !== "sit" && a.state !== "sleep") {
        g.fillStyle = "rgba(0, 0, 0, 0.18)";
        g.fillRect(x + 4, a.y + 14, 8, 2);
      }
      g.drawImage(personSprite(look, a.dir, a.pose, frame2), Math.round(x + (16 - SPRITE_W) / 2), Math.round(y));
      g.globalAlpha = 1;
      if (hovered) {
        rect(g, "#ffffff", x + 7, a.y - 9, 2, 2);
      }
    }
    drawParticles(g, world2) {
      const c = HAZARDS.lava;
      for (const p of world2.particles) {
        const t = p.life / p.max;
        g.globalAlpha = Math.max(0, Math.min(1, t * 1.5));
        switch (p.kind) {
          case "spark":
          case "ember":
            rect(g, t > 0.5 ? c.core : c.hot, Math.round(p.x), Math.round(p.y), 1, 1);
            break;
          case "sweat":
            rect(g, "#7dd3fc", Math.round(p.x), Math.round(p.y), 1, 2);
            break;
          case "smoke":
            rect(g, t > 0.5 ? "#6b7280" : "#9ca3af", Math.round(p.x), Math.round(p.y), 2, 2);
            break;
          case "steam":
            rect(g, "#ffffff", Math.round(p.x + Math.sin(p.y / 3)), Math.round(p.y), 1, 1);
            break;
          case "z": {
            const x = Math.round(p.x);
            const y = Math.round(p.y);
            rect(g, "#93c5fd", x, y, 3, 1);
            rect(g, "#93c5fd", x + 1, y + 1, 1, 1);
            rect(g, "#93c5fd", x, y + 2, 3, 1);
            break;
          }
        }
      }
      g.globalAlpha = 1;
    }
    drawNames(ctx2, world2, k, dpr) {
      const size = Math.max(9, Math.min(12, 3.4 * (k / dpr))) * dpr;
      ctx2.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
      ctx2.textAlign = "center";
      ctx2.textBaseline = "top";
      for (const desk of world2.office.desks) {
        const text = desk.label.length > 18 ? desk.label.slice(0, 17) + "…" : desk.label;
        const cx = (desk.seat.x * TILE + 16) * k;
        const cy = (desk.seat.y + 1) * TILE * k + 1 * dpr;
        const w = ctx2.measureText(text).width + 6 * dpr;
        ctx2.fillStyle = "rgba(15, 18, 26, 0.72)";
        ctx2.fillRect(cx - w / 2, cy, w, size + 3 * dpr);
        ctx2.fillStyle = desk.mood === "down" ? "#fca5a5" : desk.mood === "trouble" ? "#fcd34d" : desk.role === "control-plane" ? "#c4b5fd" : "#e5e7eb";
        ctx2.fillText(text, cx, cy + 1.5 * dpr);
      }
    }
  };

  // src/model/path.ts
  function findPath(grid, from, to, avoid) {
    if (avoid) {
      const around = search(grid, from, to, avoid);
      if (around) return around;
    }
    return search(grid, from, to, void 0);
  }
  function search(grid, from, to, avoid) {
    const { w, h, blocked } = grid;
    const start = from.y * w + from.x;
    const goal = to.y * w + to.x;
    if (start === goal) return [];
    if (to.x < 0 || to.y < 0 || to.x >= w || to.y >= h) return null;
    const prev = new Int32Array(w * h).fill(-1);
    prev[start] = start;
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const cur = queue[head++];
      if (cur === goal) break;
      const cx = cur % w;
      const cy = (cur - cx) / w;
      const next = [cy > 0 ? cur - w : -1, cy < h - 1 ? cur + w : -1, cx > 0 ? cur - 1 : -1, cx < w - 1 ? cur + 1 : -1];
      for (const n of next) {
        if (n < 0 || prev[n] !== -1) continue;
        if (n !== goal && (blocked[n] || avoid && avoid[n])) continue;
        prev[n] = cur;
        queue[tail++] = n;
      }
    }
    if (prev[goal] === -1) return null;
    const path = [];
    for (let cur = goal; cur !== start; cur = prev[cur]) path.push({ x: cur % w, y: Math.floor(cur / w) });
    return path.reverse();
  }

  // src/ui/world.ts
  var MAX_PARTICLES = 400;
  var World = class {
    office;
    agents = [];
    particles = [];
    /** Seconds since the world began: every animation keys off it. */
    clock = 0;
    random = rng(hash("pixel-agents"));
    taken = /* @__PURE__ */ new Set();
    layoutKey = "";
    constructor(office2) {
      this.office = office2;
      this.rebuild(office2);
    }
    /**
     * A new reading of the cluster. The same floor plan keeps everyone where
     * they are and only changes how busy they are; a new one -- a node came
     * or went -- seats everybody again.
     */
    update(office2, intruders2) {
      const key = `${office2.layout.w}x${office2.layout.h}:${office2.desks.map((d) => d.person.id).join(",")}`;
      const same = key === this.layoutKey;
      this.office = office2;
      if (!same) {
        this.rebuild(office2);
      } else {
        const byId2 = new Map(office2.desks.map((d) => [d.person.id, d]));
        for (const a of this.agents) if (a.desk) a.desk = byId2.get(a.desk.person.id) ?? a.desk;
      }
      this.setIntruders(intruders2);
    }
    rebuild(office2) {
      this.layoutKey = `${office2.layout.w}x${office2.layout.h}:${office2.desks.map((d) => d.person.id).join(",")}`;
      this.taken.clear();
      const staff2 = office2.desks.map((desk) => {
        const look = lookFor(desk.person.id, desk.role === "control-plane");
        return {
          id: desk.person.id,
          look,
          desk,
          x: desk.seat.x * TILE,
          y: desk.seat.y * TILE,
          dir: "up",
          pose: "type",
          state: "sit",
          // Stagger the first stand-up so the whole floor does not rise at
          // once; a cordoned node's person is off to the couch straight away.
          timer: desk.mood === "cordoned" ? 0.5 : 2 + this.random() * 12,
          path: [],
          goal: "seat",
          spot: null,
          phase: this.random() * 4,
          bubble: null,
          bubbleTimer: 0,
          burning: 0,
          away: 0
        };
      });
      this.agents = [...staff2, ...this.agents.filter((a) => !a.desk)];
      for (const a of this.agents) if (!a.desk) this.placeAnywhere(a);
    }
    setIntruders(count) {
      const current = this.agents.filter((a) => !a.desk);
      if (current.length > count) {
        const drop = new Set(current.slice(count));
        this.agents = this.agents.filter((a) => !drop.has(a));
        return;
      }
      for (let i = current.length; i < count; i++) {
        const a = {
          id: `intruder:${i}`,
          look: INTRUDER,
          desk: null,
          x: this.office.layout.door.x * TILE,
          y: (this.office.layout.door.y - 1) * TILE,
          dir: "up",
          pose: "stand",
          state: "linger",
          timer: 0.5 + i,
          path: [],
          goal: "wander",
          spot: null,
          phase: 0,
          bubble: null,
          bubbleTimer: 0,
          burning: 0,
          away: 1
        };
        this.agents.push(a);
      }
    }
    placeAnywhere(a) {
      const tile = this.randomFloor();
      a.x = tile.x * TILE;
      a.y = tile.y * TILE;
      a.path = [];
      a.state = "linger";
      a.timer = 1;
    }
    randomFloor() {
      const { w, h, blocked } = this.office.layout;
      for (let i = 0; i < 400; i++) {
        const x = 1 + Math.floor(this.random() * (w - 2));
        const y = 2 + Math.floor(this.random() * (h - 3));
        if (!blocked[y * w + x]) return { x, y };
      }
      return { x: this.office.layout.door.x, y: this.office.layout.door.y - 1 };
    }
    tile(a) {
      return { x: Math.round(a.x / TILE), y: Math.round(a.y / TILE) };
    }
    onLava(a) {
      const { x, y } = this.tile(a);
      return this.office.lava.mask[y * this.office.layout.w + x] === 1;
    }
    walkTo(a, to, goal) {
      const path = findPath(this.office.layout, this.tile(a), to, this.office.lava.mask);
      if (!path) return false;
      a.path = path;
      a.goal = goal;
      a.state = "walk";
      a.pose = "walk";
      return true;
    }
    goToSeat(a) {
      if (!a.desk) return;
      this.release(a);
      if (!this.walkTo(a, a.desk.seat, "seat")) {
        a.x = a.desk.seat.x * TILE;
        a.y = a.desk.seat.y * TILE;
        this.arrive(a);
      }
    }
    release(a) {
      if (a.spot) this.taken.delete(a.spot);
      a.spot = null;
    }
    goSomewhere(a) {
      const desk = a.desk;
      const spots = this.office.layout.spots.filter((s) => !this.taken.has(s));
      const cordoned = desk.mood === "cordoned";
      const couch = spots.filter((s) => s.kind === "couch");
      if (cordoned && couch.length) return this.useSpot(a, pick(couch, this.random));
      const roll = this.random();
      const others = this.agents.filter((o) => o !== a && o.desk && o.state === "sit");
      if (roll < 0.25 && others.length) {
        const other = pick(others, this.random);
        const at = { x: other.desk.seat.x + 1, y: other.desk.seat.y + 1 };
        if (!this.office.layout.blocked[at.y * this.office.layout.w + at.x] && this.walkTo(a, at, "visit")) return;
      }
      if (spots.length) return this.useSpot(a, pick(spots, this.random));
      this.walkTo(a, this.randomFloor(), "wander");
    }
    useSpot(a, spot) {
      this.release(a);
      this.taken.add(spot);
      a.spot = spot;
      if (!this.walkTo(a, spot, "spot")) this.release(a);
    }
    arrive(a) {
      const desk = a.desk;
      a.path = [];
      if (!desk) {
        a.state = "linger";
        a.pose = "stand";
        a.timer = 0.8 + this.random() * 3;
        if (this.random() < 0.3) this.say(a, "eye", 2);
        return;
      }
      switch (a.goal) {
        case "seat":
          a.dir = "up";
          if (desk.mood === "down") {
            a.state = "sleep";
            a.pose = "sleep";
            a.timer = 5;
          } else {
            a.state = "sit";
            a.pose = desk.activity > 0.08 ? "type" : "sit-back";
            a.timer = (5 + this.random() * 15) * (0.6 + desk.activity * 2);
          }
          break;
        case "spot": {
          const spot = a.spot;
          a.state = "linger";
          if (spot.sit) {
            a.dir = "down";
            a.pose = "sit-front";
            a.timer = desk.mood === "cordoned" ? 60 : 8 + this.random() * 14;
          } else {
            a.dir = "up";
            a.pose = "stand";
            a.timer = 3 + this.random() * 8;
          }
          if (spot.kind === "coffee") this.say(a, "coffee", 3);
          if (spot.kind === "meeting") this.say(a, "chat", a.timer * 0.6);
          break;
        }
        case "visit":
          a.state = "linger";
          a.dir = "up";
          a.pose = "stand";
          a.timer = 3 + this.random() * 5;
          this.say(a, "chat", a.timer);
          break;
        default:
          a.state = "linger";
          a.pose = "stand";
          a.timer = 1 + this.random() * 3;
      }
    }
    say(a, bubble, seconds) {
      a.bubble = bubble;
      a.bubbleTimer = seconds;
    }
    emit(p) {
      if (this.particles.length >= MAX_PARTICLES) return;
      this.particles.push({ ...p, max: p.life });
    }
    /** Moves everything on by `dt` seconds, already scaled by the speed setting. */
    step(dt) {
      this.clock += dt;
      for (const a of this.agents) this.stepAgent(a, dt);
      this.stepParticles(dt);
    }
    stepAgent(a, dt) {
      const desk = a.desk;
      const activity2 = desk?.activity ?? 0.3;
      a.bubbleTimer -= dt;
      if (a.bubbleTimer <= 0) a.bubble = null;
      const atDesk = !!desk && (a.state === "sit" || a.state === "sleep");
      a.away += ((atDesk ? 0 : 1) - a.away) * Math.min(1, dt * 12);
      const burning = this.onLava(a);
      a.burning = burning ? a.burning + dt : 0;
      if (burning) {
        if (this.random() < dt * 14) this.emit({ x: a.x + 4 + this.random() * 8, y: a.y + 14, vx: (this.random() - 0.5) * 10, vy: -18 - this.random() * 12, life: 0.6, kind: "ember" });
        if (a.state !== "walk") {
          this.say(a, "fire", 1.5);
          const seated = a.state === "sit" || a.state === "sleep";
          if (!seated || a.burning >= 3) {
            if (desk) this.goSomewhere(a);
            else this.walkTo(a, this.randomFloor(), "wander");
          }
        }
      }
      switch (a.state) {
        case "walk":
          this.stepWalk(a, dt, activity2, burning);
          break;
        case "sit":
          a.phase += dt * (2 + activity2 * 14);
          a.pose = desk && desk.activity > 0.08 ? "type" : "sit-back";
          if (desk && desk.activity > 0.82 && this.random() < dt * 1.2) {
            this.emit({ x: a.x + 4 + this.random() * 8, y: a.y - 2, vx: (this.random() - 0.5) * 8, vy: -6, life: 0.7, kind: "sweat" });
          }
          if (desk && desk.mood === "trouble") {
            if (!a.bubble && this.random() < dt * 0.25) this.say(a, "bang", 2.5);
            if (this.random() < dt * 1.5) this.emit({ x: a.x + 16 + (this.random() - 0.5) * 8, y: a.y - 20, vx: (this.random() - 0.5) * 4, vy: -7, life: 1.4, kind: "smoke" });
          }
          if (desk && desk.mood === "down") {
            a.state = "sleep";
            a.pose = "sleep";
          }
          a.timer -= dt;
          if (a.timer <= 0 && desk) {
            const leave = desk.mood === "cordoned" ? 1 : desk.activity > 0.85 ? 0.03 : Math.pow(1 - desk.activity, 1.5) * 0.75 + 0.05;
            if (this.random() < leave) this.goSomewhere(a);
            else a.timer = 4 + this.random() * 10;
          }
          break;
        case "sleep":
          if (this.random() < dt * 0.8) this.emit({ x: a.x + 10, y: a.y - 4, vx: 4, vy: -8, life: 1.6, kind: "z" });
          if (desk && desk.mood !== "down") {
            a.state = "sit";
            a.timer = 2;
          }
          break;
        case "linger":
          if (a.spot?.kind === "coffee" && this.random() < dt * 2) this.emit({ x: a.x + 8, y: a.y - 14, vx: 0, vy: -6, life: 1.2, kind: "steam" });
          a.timer -= dt;
          if (a.timer <= 0) {
            if (!desk) {
              this.walkTo(a, this.pickIntruderTarget(), "wander");
            } else if (desk.mood === "cordoned" && a.spot?.sit) {
              a.timer = 30;
            } else if (desk.mood === "down" || this.random() < 0.55 + activity2 * 0.4) {
              this.goToSeat(a);
            } else {
              this.goSomewhere(a);
            }
          }
          break;
      }
    }
    pickIntruderTarget() {
      const seated = this.agents.filter((o) => o.desk && o.state === "sit");
      if (seated.length && this.random() < 0.5) {
        const o = pick(seated, this.random);
        const at = { x: o.desk.seat.x + 1, y: o.desk.seat.y + 1 };
        if (!this.office.layout.blocked[at.y * this.office.layout.w + at.x]) return at;
      }
      return this.randomFloor();
    }
    stepWalk(a, dt, activity2, burning) {
      const next = a.path[0];
      if (!next) {
        this.arrive(a);
        return;
      }
      const tilesPerSecond = (a.desk ? 2.2 + activity2 * 2.4 : 1.4) * (burning ? 2.2 : 1);
      let budget = tilesPerSecond * TILE * dt;
      a.phase += dt * tilesPerSecond * 2.2;
      while (budget > 0 && a.path.length) {
        const target = a.path[0];
        const tx = target.x * TILE;
        const ty = target.y * TILE;
        const dx = tx - a.x;
        const dy = ty - a.y;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist > 0) a.dir = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up";
        if (dist <= budget) {
          a.x = tx;
          a.y = ty;
          budget -= dist;
          a.path.shift();
        } else {
          a.x += Math.sign(dx) * Math.min(Math.abs(dx), budget);
          if (Math.abs(dx) < budget) a.y += Math.sign(dy) * (budget - Math.abs(dx));
          budget = 0;
        }
      }
      if (!a.path.length) this.arrive(a);
    }
    stepParticles(dt) {
      const { lava, layout } = this.office;
      if (lava.count) {
        const chances = Math.min(6, lava.count * 0.04) * dt * 10;
        for (let i = 0; i < chances; i++) {
          if (this.random() > 0.35) continue;
          const idx = Math.floor(this.random() * lava.mask.length);
          if (!lava.mask[idx]) continue;
          const x = idx % layout.w * TILE + this.random() * TILE;
          const y = Math.floor(idx / layout.w) * TILE + this.random() * TILE;
          this.emit({ x, y, vx: (this.random() - 0.5) * 14, vy: -14 - this.random() * 18, life: 0.5 + this.random() * 0.5, kind: "spark" });
        }
      }
      for (const p of this.particles) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.kind === "spark" || p.kind === "sweat") p.vy += 40 * dt;
      }
      this.particles = this.particles.filter((p) => p.life > 0);
    }
    /** The agent under a point in world pixels, the front-most first. */
    agentAt(px, py) {
      const sorted = [...this.agents].sort((a, b) => b.y - a.y);
      for (const a of sorted) {
        const left = a.x + 2 + (a.desk && a.away < 0.5 ? 8 : 0);
        if (px >= left && px < left + 12 && py >= a.y - 4 && py < a.y + 16) return a;
      }
      return null;
    }
  };

  // src/pages/overview.ts
  var ctx;
  var settings;
  var preview = { busy: null, hazard: null };
  var reading = null;
  var office = null;
  var world = null;
  var paused = false;
  var hover = null;
  var scale = 2;
  var stage = byId("stage");
  var canvas = byId("office");
  var tip = byId("tip");
  var renderer = new Renderer(canvas);
  function intruders(o) {
    if (!settings.intruders || o.security <= 0) return 0;
    return Math.max(1, Math.min(6, Math.round(o.security * 6)));
  }
  function rebuild() {
    if (!reading) return;
    const report = reading.report;
    office = buildOffice(reading.nodes, reading.loads, report, settings, ctx.contextId || "cluster", preview);
    if (!settings.inbox) office.unscheduled = 0;
    if (!world) world = new World(office);
    world.update(office, intruders(office));
    renderMeters(byId("meters"), {
      office,
      settings,
      nodes: reading.nodes,
      report,
      where: reading.where,
      note: reading.note,
      preview: preview.busy !== null || preview.hazard !== null
    });
    renderFindings(byId("findings"), report, settings.securityChecks);
    canvas.setAttribute(
      "aria-label",
      `An office of ${office.desks.length} people for ${reading.nodes.length} nodes, ${Math.round(office.busy * 100)}% busy, ${Math.round(office.hazard * 100)}% in trouble${office.lava.count ? ", and the floor is lava" : ""}.`
    );
    byId("loading").hidden = true;
  }
  async function poll() {
    const snap = await loadSnapshot();
    const nodesProblem = snap.missing.get("nodes");
    if (nodesProblem) throw new Error(`Cannot read the cluster’s nodes: ${nodesProblem}`);
    const nodes = readNodes(snap.nodes, snap.pods);
    const { loads, where, note } = await loadLoads(nodes);
    const report = analyze(snap.nodes, snap.pods, snap.events, settings, Date.now());
    reading = { nodes, loads, report, where, note };
    const partial = [...snap.missing.entries()].map(([k, why]) => `${k}: ${why}`);
    if (partial.length) banner.show(`Some of the cluster could not be read, so the office is missing it -- ${partial.join("; ")}`);
    else banner.clear();
    rebuild();
  }
  function fitScale() {
    if (!office) return scale;
    const size = renderer.size(office.layout);
    if (settings.scale > 0) return settings.scale;
    const width = stage.clientWidth - 2;
    const height = Math.max(320, window.innerHeight * 0.9);
    const fit = Math.min(width / size.w, height / size.h);
    if (fit >= 3) return Math.floor(fit);
    return Math.max(0.5, Math.floor(fit * 4) / 4);
  }
  var last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1e3);
    last = now;
    if (world && office) {
      if (!paused) world.step(dt * settings.speed);
      scale = fitScale();
      renderer.draw(world, settings, { scale, hover });
    }
    requestAnimationFrame(frame);
  }
  function pointer(event) {
    if (!world) return null;
    const r = canvas.getBoundingClientRect();
    return world.agentAt((event.clientX - r.left) / scale, (event.clientY - r.top) / scale);
  }
  function wirePointer() {
    canvas.addEventListener("mousemove", (event) => {
      hover = pointer(event);
      canvas.style.cursor = hover ? "pointer" : "default";
      if (!hover || !office) {
        tip.hidden = true;
        return;
      }
      renderTip(tip, hover, office.security);
      tip.hidden = false;
      const s = stage.getBoundingClientRect();
      const x = event.clientX - s.left + stage.scrollLeft + 14;
      const y = event.clientY - s.top + stage.scrollTop + 14;
      tip.style.left = `${Math.min(x, stage.scrollLeft + stage.clientWidth - tip.offsetWidth - 8)}px`;
      tip.style.top = `${y}px`;
    });
    canvas.addEventListener("mouseleave", () => {
      hover = null;
      tip.hidden = true;
    });
    canvas.addEventListener("click", (event) => {
      const agent = pointer(event);
      if (!agent) return;
      if (agent.desk) {
        const name = agent.desk.person.nodes[0];
        if (name) sdk.open({ kind: "nodes", name }).catch(banner.show);
      } else {
        byId("findings").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }
  function wireTools(refresh) {
    const tools = byId("tools");
    clear(tools);
    const makePause = () => {
      const b = button(paused ? "Play" : "Pause", "secondary", paused ? "play" : "pause", () => {
        paused = !paused;
        b.replaceWith(makePause());
      });
      return b;
    };
    const panel = byId("settings");
    const openPanel = () => {
      renderPanel(panel, settings, preview, {
        change(patch) {
          const refreshChanged = patch.refresh !== void 0 && patch.refresh !== settings.refresh;
          const readsChanged = patch.securityChecks !== void 0 || patch.warningEvents !== void 0 || patch.ignoreNamespaces !== void 0;
          settings = sanitize({ ...settings, ...patch });
          saveSettings(settings);
          if (readsChanged || refreshChanged) refresh();
          else rebuild();
        },
        reset() {
          settings = sanitize(null);
          saveSettings(settings);
          openPanel();
          refresh();
        },
        preview(p) {
          preview = p;
          rebuild();
        }
      });
    };
    const gear = button("Settings", "secondary", "settings", () => {
      panel.hidden = !panel.hidden;
      gear.classList.toggle("on", !panel.hidden);
      if (!panel.hidden) openPanel();
    });
    tools.append(makePause(), gear);
  }
  async function main() {
    ctx = await sdk.ready();
    settings = await loadSettings();
    byId("title").textContent = ctx.contextName ? `${ctx.contextName}` : "The office";
    renderFoot(byId("foot"), ctx);
    wirePointer();
    const refresh = every(
      () => settings.refresh * 1e3,
      poll,
      (err) => {
        banner.show(err);
        if (!reading) byId("loading").textContent = `The office could not open: ${message(err)}`;
      }
    );
    wireTools(refresh);
    requestAnimationFrame(frame);
  }
  main().catch(banner.show);
})();
