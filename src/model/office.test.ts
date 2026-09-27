import { describe, expect, it } from 'vitest';
import { NOW, node, pod } from './fixtures';
import { buildLayout, racksFor, sizeFor, T, walkable } from './layout';
import { Mark, spreadLava } from './lava';
import { loadFromRequests } from './load';
import { readNodes } from './nodes';
import { buildOffice } from './office';
import { findPath } from './path';
import { analyze } from './problems';
import { DEFAULT_SETTINGS, sanitize } from './settings';
import { share, staff } from './staff';

const names = (n: number, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('staff', () => {
    it('gives a single schedulable control plane one manager and no workers', () => {
        const people = staff(readNodes([node('solo', { controlPlane: true })], []), DEFAULT_SETTINGS);
        expect(people.map((p) => [p.role, p.nodes])).toEqual([['control-plane', ['solo']]]);
    });

    it('staffs an HA cluster with forty workers one to a node', () => {
        const nodes = readNodes([...names(3, 'cp').map((n) => node(n, { controlPlane: true })), ...names(40).map((n) => node(n))], []);
        const people = staff(nodes, DEFAULT_SETTINGS);
        expect(people.filter((p) => p.role === 'control-plane')).toHaveLength(3);
        expect(people.filter((p) => p.role === 'worker')).toHaveLength(40);
    });

    it('caps the headcount, and then people stand for several nodes', () => {
        const nodes = readNodes([node('cp', { controlPlane: true }), ...names(100).map((n) => node(n))], []);
        const people = staff(nodes, { ...DEFAULT_SETTINGS, maxPeople: 20 });
        expect(people).toHaveLength(20);
        expect(people.flatMap((p) => p.nodes)).toHaveLength(101);
    });

    it('shares nodes both ways', () => {
        expect(share(['a', 'b'], 4)).toEqual([['a'], ['a'], ['b'], ['b']]);
        expect(share(['a', 'b', 'c', 'd'], 2)).toEqual([['a', 'b'], ['c', 'd']]);
    });
});

describe('layout', () => {
    it('has a seat for everybody, all of them reachable from the door, whatever the size', () => {
        for (const size of ['small', 'medium', 'large'] as const) {
            for (const [m, w] of [[0, 0], [1, 0], [3, 40], [5, 120]] as const) {
                const layout = buildLayout(m, w, { size, racks: racksFor(m + w) });
                expect(layout.managerSeats).toHaveLength(m);
                expect(layout.seats.length).toBeGreaterThanOrEqual(w);
                const start = { x: layout.door.x, y: layout.door.y - 1 };
                for (const seat of [...layout.managerSeats, ...layout.seats, ...layout.spots]) {
                    expect(findPath(layout, start, seat), `${size} ${m}+${w}: ${seat.x},${seat.y}`).not.toBeNull();
                }
            }
        }
    });

    it('grows with the headcount and with the size', () => {
        const small = buildLayout(1, 0);
        const big = buildLayout(3, 40);
        expect(big.w * big.h).toBeGreaterThan(small.w * small.h);
        expect(small.tiles[0]).toBe(T.Wall);
        const roomy = buildLayout(3, 40, { size: 'large', racks: 11 });
        expect(roomy.w * roomy.h).toBeGreaterThan(big.w * big.h);
        expect(roomy.spots.some((s) => s.kind === 'meeting')).toBe(true);
        expect(roomy.items.filter((i) => i.type === 'rack')).toHaveLength(11);
        expect(big.spots.some((s) => s.kind === 'meeting')).toBe(false);
    });

    it('picks a size from the number of nodes', () => {
        expect(sizeFor(1)).toBe('small');
        expect(sizeFor(12)).toBe('medium');
        expect(sizeFor(43)).toBe('large');
    });
});

describe('the floor', () => {
    const opts = { lava: true, lavaStart: 0.7, lavaMax: 0.3 };
    const count = (a: Uint8Array, v?: number) => a.reduce((n, x) => n + (v === undefined ? (x ? 1 : 0) : x === v ? 1 : 0), 0);

    it('is spotless with no trouble', () => {
        const lava = spreadLava(buildLayout(1, 8), 0, [], 'seed', opts);
        expect(lava.count).toBe(0);
        expect(count(lava.marks)).toBe(0);
    });

    it('shows litter for a little trouble, cracks for more, and no lava below the line', () => {
        const layout = buildLayout(1, 8);
        const little = spreadLava(layout, 0.15, [], 'seed', opts);
        expect(little.count).toBe(0);
        expect(count(little.marks)).toBeGreaterThan(0);
        expect(count(little.marks, Mark.Crack)).toBe(0);
        const more = spreadLava(layout, 0.6, [], 'seed', opts);
        expect(more.count).toBe(0);
        expect(count(more.marks, Mark.Crack)).toBeGreaterThan(0);
    });

    it('turns to lava only past the line, and never past the most', () => {
        const layout = buildLayout(1, 8);
        const free = walkable(layout).length;
        const bad = spreadLava(layout, 0.85, [], 'seed', opts);
        const worst = spreadLava(layout, 1, [], 'seed', opts);
        expect(bad.count).toBeGreaterThan(0);
        expect(worst.count).toBeGreaterThan(bad.count);
        expect(worst.count / free).toBeLessThanOrEqual(0.3);
        expect(spreadLava(layout, 1, [], 'seed', { ...opts, lava: false }).count).toBe(0);
    });

    it('grows the same pools rather than moving them', () => {
        const layout = buildLayout(1, 8);
        const low = spreadLava(layout, 0.8, [], 'seed', opts);
        const high = spreadLava(layout, 1, [], 'seed', opts);
        let kept = 0;
        for (let i = 0; i < low.mask.length; i++) if (low.mask[i] && high.mask[i]) kept++;
        expect(kept / low.count).toBeGreaterThan(0.5);
    });

    it('starts behind the hot seats and leaves chairs and furniture alone', () => {
        const layout = buildLayout(0, 8);
        const seat = layout.seats[3]!;
        const lava = spreadLava(layout, 0.9, [seat], 'seed', opts);
        expect(lava.mask[(seat.y + 1) * layout.w + seat.x]).toBe(1);
        for (let i = 0; i < lava.mask.length; i++) if (lava.mask[i]) expect(layout.blocked[i]).toBe(0);
        for (const s of layout.seats) expect(lava.mask[s.y * layout.w + s.x]).toBe(0);
    });

    it('still lets people get to a desk around it', () => {
        const layout = buildLayout(1, 12);
        const lava = spreadLava(layout, 1, [], 'x', opts);
        const path = findPath(layout, { x: layout.door.x, y: layout.door.y - 1 }, layout.seats[0]!, lava.mask);
        expect(path).not.toBeNull();
    });
});

describe('buildOffice', () => {
    it('makes a busy, troubled cluster busy and messy, but keeps the lava for worse', () => {
        const raw = [node('cp', { controlPlane: true }), node('w1'), node('w2', { ready: false })];
        const pods = [pod('a', { node: 'w1', cpu: '3500m' }), pod('b', { node: 'w1', waiting: 'CrashLoopBackOff' })];
        const nodes = readNodes(raw, pods);
        const report = analyze(raw, pods, [], DEFAULT_SETTINGS, NOW);
        const office = buildOffice(nodes, loadFromRequests(nodes), report, DEFAULT_SETTINGS, 'ctx');
        expect(office.desks).toHaveLength(3);
        expect(office.desks.find((d) => d.label === 'w2')?.mood).toBe('down');
        expect(office.desks.find((d) => d.label === 'w1')?.activity).toBeGreaterThan(0.5);
        expect(office.hazard).toBeGreaterThan(0);
        expect(office.hazard).toBeLessThan(DEFAULT_SETTINGS.lavaStart);
        expect(office.lava.count).toBe(0);
        expect(office.lava.marks.some((m) => m > 0)).toBe(true);
    });

    it('lets the preview override the cluster', () => {
        const nodes = readNodes([node('w1')], []);
        const report = analyze([], [], [], DEFAULT_SETTINGS, NOW);
        const office = buildOffice(nodes, loadFromRequests(nodes), report, DEFAULT_SETTINGS, 'ctx', { busy: 0.9, hazard: 0.9 });
        expect(office.busy).toBeCloseTo(0.9);
        expect(office.lava.count).toBeGreaterThan(0);
    });
});

describe('settings', () => {
    it('defaults what is missing or wrong and keeps what is right', () => {
        const s = sanitize({ peoplePerNode: 2, maxPeople: 9999, hazardStyle: 'plasma', names: 'yes', ignoreNamespaces: ['a', ' ', 'a', 3] });
        expect(s.peoplePerNode).toBe(2);
        expect(s.maxPeople).toBe(200);
        expect(s.hazardStyle).toBe('lava');
        expect(s.names).toBe(true);
        expect(s.ignoreNamespaces).toEqual(['a']);
        expect(sanitize(null)).toEqual(DEFAULT_SETTINGS);
    });
});
