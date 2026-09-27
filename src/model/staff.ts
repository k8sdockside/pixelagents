// Who works in the office: people for nodes. Control planes are the managers
// in the glass room; workers sit on the open floor. With the defaults it is
// one person a node; the settings change the ratio and cap the headcount, and
// past the cap one person stands for several nodes.

import type { NodeInfo, Role } from './nodes';
import type { Settings } from './settings';

export interface Person {
    /** Stable across refreshes while the nodes stay the same. */
    id: string;
    role: Role;
    /** The nodes this person stands for -- one, usually. */
    nodes: string[];
}

/** Splits `nodes` among `people`: several people a node when there are more people, several nodes a person when fewer. */
export function share(nodes: string[], people: number): string[][] {
    const n = nodes.length;
    if (!n || people <= 0) return [];
    const out: string[][] = [];
    if (people >= n) {
        for (let j = 0; j < people; j++) out.push([nodes[j % n]!]);
        // Keep a node's people together, so they sit side by side.
        return out.sort((a, b) => nodes.indexOf(a[0]!) - nodes.indexOf(b[0]!));
    }
    for (let j = 0; j < people; j++) out.push(nodes.slice(Math.floor((j * n) / people), Math.floor(((j + 1) * n) / people)));
    return out;
}

export function staff(nodes: NodeInfo[], settings: Pick<Settings, 'peoplePerNode' | 'maxPeople'>): Person[] {
    const cp = nodes.filter((n) => n.role === 'control-plane').map((n) => n.name);
    const workers = nodes.filter((n) => n.role === 'worker').map((n) => n.name);
    const want = (count: number): number => (count ? Math.max(1, Math.round(count * settings.peoplePerNode)) : 0);

    let cpPeople = want(cp.length);
    let workerPeople = want(workers.length);
    const max = Math.max(1, settings.maxPeople);
    if (cpPeople + workerPeople > max) {
        const total = cpPeople + workerPeople;
        const cpShare = cp.length ? Math.min(cpPeople, Math.max(1, Math.round((max * cpPeople) / total))) : 0;
        workerPeople = workers.length ? Math.max(1, max - cpShare) : 0;
        cpPeople = cpShare;
    }

    const people: Person[] = [];
    const add = (role: Role, groups: string[][]): void => {
        const seen = new Map<string, number>();
        for (const group of groups) {
            const key = group[0]!;
            const nth = seen.get(key) ?? 0;
            seen.set(key, nth + 1);
            people.push({ id: `${role}:${key}:${nth}`, role, nodes: group });
        }
    };
    add('control-plane', share(cp, cpPeople));
    add('worker', share(workers, workerPeople));
    return people;
}
