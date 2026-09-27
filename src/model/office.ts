// Everything the office is drawn from, worked out in one place: the people
// and their desks, how busy each is, the floor plan, and the lava.

import { buildLayout, racksFor, sizeFor, type Layout, type Seat } from './layout';
import { spreadLava, type Lava } from './lava';
import { activity, average, unknownLoad, type LoadMap, type NodeLoad, type Reading } from './load';
import type { NodeInfo, Role } from './nodes';
import { hazard, type Report } from './problems';
import { clamp } from './rng';
import type { Settings } from './settings';
import { staff, type Person } from './staff';

export type Mood = 'ok' | 'trouble' | 'down' | 'cordoned';

export interface Desk {
    person: Person;
    seat: Seat;
    role: Role;
    /** 0-1. */
    activity: number;
    /** The readings, averaged over the person's nodes. */
    load: NodeLoad;
    mood: Mood;
    /** How much of what is wrong is on this person's nodes. */
    trouble: number;
    pods: number;
    /** The node's name, or how many it stands for. */
    label: string;
}

export interface Office {
    layout: Layout;
    desks: Desk[];
    lava: Lava;
    /** The trouble level, 0-1, after the settings. Lava only past `settings.lavaStart`. */
    hazard: number;
    /** 0-1: the mean of every desk's activity. */
    busy: number;
    /** 0-1: security's share of the heat, for how many intruders. */
    security: number;
    unscheduled: number;
    /** Cluster-wide means, NaN when unknown. */
    cpu: number;
    memory: number;
    disk: number;
}

/** What the preview sliders override: null leaves it to the cluster. */
export interface Preview {
    busy: number | null;
    hazard: number | null;
}

function averageReading(readings: Reading[]): Reading {
    const known = readings.filter((r) => Number.isFinite(r.value));
    if (!known.length) return { value: NaN, source: 'none' };
    return { value: known.reduce((s, r) => s + r.value, 0) / known.length, source: known[0]!.source };
}

export function buildOffice(
    nodes: NodeInfo[],
    loads: LoadMap,
    report: Report,
    settings: Settings,
    seed: string,
    preview: Preview = { busy: null, hazard: null },
): Office {
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const people = staff(nodes, settings);
    const managers = people.filter((p) => p.role === 'control-plane');
    const workers = people.filter((p) => p.role === 'worker');
    const size = settings.officeSize === 'auto' ? sizeFor(nodes.length) : settings.officeSize;
    const layout = buildLayout(managers.length, workers.length, { size, racks: racksFor(nodes.length) });

    const desks: Desk[] = [];
    const place = (list: Person[], seats: Seat[]): void => {
        list.forEach((person, i) => {
            const seat = seats[i];
            if (!seat) return;
            const infos = person.nodes.map((n) => byName.get(n)).filter((n): n is NodeInfo => !!n);
            const nodeLoads = person.nodes.map((n) => loads.get(n) ?? unknownLoad());
            const load: NodeLoad = {
                cpu: averageReading(nodeLoads.map((l) => l.cpu)),
                memory: averageReading(nodeLoads.map((l) => l.memory)),
                disk: averageReading(nodeLoads.map((l) => l.disk)),
            };
            const trouble = person.nodes.reduce((s, n) => s + (report.byNode.get(n) ?? 0), 0);
            let mood: Mood = 'ok';
            if (infos.length && infos.every((n) => !n.ready)) mood = 'down';
            else if (infos.length && infos.every((n) => n.cordoned)) mood = 'cordoned';
            else if (trouble >= 2 || infos.some((n) => !n.ready || n.pressure.length)) mood = 'trouble';
            desks.push({
                person,
                seat,
                role: person.role,
                activity: preview.busy ?? (mood === 'down' ? 0 : activity(load, settings)),
                load,
                mood,
                trouble,
                pods: infos.reduce((s, n) => s + n.pods, 0),
                label: person.nodes.length === 1 ? person.nodes[0]! : `${person.nodes.length} nodes`,
            });
        });
    };
    place(managers, layout.managerSeats);
    place(workers, layout.seats);

    const level = clamp(preview.hazard ?? (settings.hazardSensitivity === 0 ? 0 : hazard(report, settings)), 0, 1);
    const hotSeats = desks
        .filter((d) => d.trouble > 0)
        .sort((a, b) => b.trouble - a.trouble)
        .map((d) => d.seat);
    const lava = spreadLava(layout, level, hotSeats, seed, settings);

    const heat = report.heat;
    const total = heat.error + heat.warning + heat.security;
    const security = settings.securityChecks && total > 0 ? clamp(heat.security / 12, 0, 1) : 0;

    return {
        layout,
        desks,
        lava,
        hazard: level,
        busy: desks.length ? desks.reduce((s, d) => s + d.activity, 0) / desks.length : 0,
        security,
        unscheduled: report.unscheduled,
        cpu: average(loads, 'cpu'),
        memory: average(loads, 'memory'),
        disk: average(loads, 'disk'),
    };
}
