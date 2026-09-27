// How hard every node is working -- CPU, memory and disk, each a fraction of
// what the node has -- from the best source the cluster offers:
//
//   1. Prometheus or VictoriaMetrics with node-exporter: all three, measured.
//   2. metrics-server: CPU and memory, measured; no disk.
//   3. Neither: what the pods on the node ask for, against what it offers.
//      An estimate, and the page says so.
//
// A node can mix them: node-exporter missing on one node falls back to
// metrics-server for that node alone. Disk that nothing measures reads from
// the DiskPressure condition when it is set, and is otherwise unknown.

import type { NodeMetrics } from './kube';
import type { NodeInfo } from './nodes';
import { parseQuantity } from './quantity';
import { clamp } from './rng';
import type { Settings } from './settings';

export const CPU_CHART = 'node-cpu';
export const MEMORY_CHART = 'node-memory';
export const DISK_CHART = 'node-disk';

export type LoadSource = 'prometheus' | 'metrics-server' | 'requests' | 'conditions' | 'none';

export interface Reading {
    /** A fraction of what the node has: 0.42 is 42%. NaN when unknown. */
    value: number;
    source: LoadSource;
}

export interface NodeLoad {
    cpu: Reading;
    memory: Reading;
    disk: Reading;
}

export type LoadMap = Map<string, NodeLoad>;

const UNKNOWN: Reading = { value: NaN, source: 'none' };

export function unknownLoad(): NodeLoad {
    return { cpu: UNKNOWN, memory: UNKNOWN, disk: UNKNOWN };
}

/** The host part of a Prometheus `instance`: `10.0.0.5:9100` -> `10.0.0.5`, `[fd00::1]:9100` -> `fd00::1`. */
export function instanceHost(instance: string): string {
    const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(instance);
    if (bracket) return bracket[1]!;
    const colons = instance.split(':').length - 1;
    return colons === 1 ? instance.slice(0, instance.indexOf(':')) : instance;
}

/**
 * The node a series is about. The charts name series `nodename|instance`:
 * the host name node-exporter reports, and the address it was scraped at.
 * Either may be what the node is called; the address may be one of its IPs.
 */
export function nodeForSeries(series: string, nodes: NodeInfo[]): NodeInfo | undefined {
    const [nodename = '', instance = ''] = series.split('|');
    const host = instanceHost(instance);
    const short = (n: string): string => n.split('.')[0]!;
    return (
        nodes.find((n) => n.name === nodename) ??
        nodes.find((n) => n.name === host || n.addresses.includes(host)) ??
        nodes.find((n) => nodename !== '' && (n.addresses.includes(nodename) || short(n.name) === short(nodename)))
    );
}

function latest(points: K8sDockside.ChartPoint[]): number {
    for (let i = points.length - 1; i >= 0; i--) {
        const v = points[i]!.v;
        if (Number.isFinite(v)) return v;
    }
    return NaN;
}

export interface ChartsOutcome {
    loads: LoadMap;
    /** Where the readings came from, for a person; '' when nothing came back. */
    where: string;
    /** Why this source gave nothing, or only part; '' when it gave everything. */
    note: string;
}

export function loadFromCharts(panel: K8sDockside.ChartsPanel, nodes: NodeInfo[]): ChartsOutcome {
    const loads: LoadMap = new Map();
    const source = panel.source;
    if (!source.available) {
        return { loads, where: '', note: source.error ? `could not look for Prometheus: ${source.error}` : 'no Prometheus or VictoriaMetrics found' };
    }
    const errors: string[] = [];
    const read = (id: string, field: keyof NodeLoad): void => {
        const chart = panel.charts.find((c) => c.id === id);
        if (!chart) return;
        if (chart.error) errors.push(chart.error);
        for (const series of chart.series) {
            const node = nodeForSeries(series.name, nodes);
            const value = latest(series.points);
            if (!node || !Number.isFinite(value)) continue;
            const entry = loads.get(node.name) ?? unknownLoad();
            entry[field] = { value: clamp(value, 0, 1), source: 'prometheus' };
            loads.set(node.name, entry);
        }
    };
    read(CPU_CHART, 'cpu');
    read(MEMORY_CHART, 'memory');
    read(DISK_CHART, 'disk');

    if (!loads.size) {
        const why = errors[0] ?? 'it has no node-exporter metrics (node_cpu_seconds_total, node_memory_MemAvailable_bytes)';
        return { loads, where: '', note: `${source.describe} answered, but ${why}` };
    }
    return { loads, where: `node-exporter via ${source.describe}`, note: errors.length ? errors[0]! : '' };
}

/** metrics-server's NodeMetrics, against what each node offers. */
export function loadFromNodeMetrics(items: NodeMetrics[], nodes: NodeInfo[]): LoadMap {
    const loads: LoadMap = new Map();
    for (const item of items) {
        const node = nodes.find((n) => n.name === item.metadata.name);
        if (!node) continue;
        const cpu = parseQuantity(item.usage?.cpu) / node.cpuAllocatable;
        const memory = parseQuantity(item.usage?.memory) / node.memoryAllocatable;
        loads.set(node.name, {
            cpu: Number.isFinite(cpu) ? { value: clamp(cpu, 0, 1), source: 'metrics-server' } : UNKNOWN,
            memory: Number.isFinite(memory) ? { value: clamp(memory, 0, 1), source: 'metrics-server' } : UNKNOWN,
            disk: UNKNOWN,
        });
    }
    return loads;
}

/** What the pods ask for, against what each node offers: how full it is booked, not how hard it works. */
export function loadFromRequests(nodes: NodeInfo[]): LoadMap {
    const loads: LoadMap = new Map();
    for (const node of nodes) {
        const cpu = node.cpuRequested / node.cpuAllocatable;
        const memory = node.memoryRequested / node.memoryAllocatable;
        loads.set(node.name, {
            cpu: Number.isFinite(cpu) ? { value: clamp(cpu, 0, 1), source: 'requests' } : UNKNOWN,
            memory: Number.isFinite(memory) ? { value: clamp(memory, 0, 1), source: 'requests' } : UNKNOWN,
            disk: node.pressure.includes('DiskPressure') ? { value: 0.95, source: 'conditions' } : UNKNOWN,
        });
    }
    return loads;
}

/** Each reading from the first source that has it, best source first. */
export function mergeLoads(nodes: NodeInfo[], sources: LoadMap[]): LoadMap {
    const out: LoadMap = new Map();
    for (const node of nodes) {
        const pickReading = (field: keyof NodeLoad): Reading => {
            for (const s of sources) {
                const r = s.get(node.name)?.[field];
                if (r && Number.isFinite(r.value)) return r;
            }
            return UNKNOWN;
        };
        out.set(node.name, { cpu: pickReading('cpu'), memory: pickReading('memory'), disk: pickReading('disk') });
    }
    return out;
}

/**
 * How busy a node's person is, 0-1: the weighted mean of its readings,
 * pulled towards the busiest one -- a node at 95% memory is busy whatever
 * its CPU says -- and then scaled by the busyness setting.
 */
export function activity(load: NodeLoad, settings: Pick<Settings, 'cpuWeight' | 'memoryWeight' | 'diskWeight' | 'busyness'>): number {
    const all: [number, number][] = [
        [load.cpu.value, settings.cpuWeight],
        [load.memory.value, settings.memoryWeight],
        [load.disk.value, settings.diskWeight],
    ];
    const parts = all.filter(([v, w]) => Number.isFinite(v) && w > 0);
    if (!parts.length) return 0;
    const weight = parts.reduce((s, [, w]) => s + w, 0);
    const mean = parts.reduce((s, [v, w]) => s + v * w, 0) / weight;
    const max = Math.max(...parts.map(([v]) => v));
    return clamp((0.65 * mean + 0.35 * max) * settings.busyness, 0, 1);
}

/**
 * The mean of one reading across nodes, ignoring the ones that have none. NaN
 * when none do. A reading guessed from a node's conditions is left out: one
 * node under DiskPressure is not the cluster's disk at 95%.
 */
export function average(loads: LoadMap, field: keyof NodeLoad): number {
    const values = [...loads.values()]
        .filter((l) => l[field].source !== 'conditions')
        .map((l) => l[field].value)
        .filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

/** The sources that supplied any reading, best first, for a person. */
export function sourcesUsed(loads: LoadMap): LoadSource[] {
    const order: LoadSource[] = ['prometheus', 'metrics-server', 'requests', 'conditions'];
    const seen = new Set<LoadSource>();
    for (const l of loads.values()) for (const r of [l.cpu, l.memory, l.disk]) if (r.source !== 'none') seen.add(r.source);
    return order.filter((s) => seen.has(s));
}
