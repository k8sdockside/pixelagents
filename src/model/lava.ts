// What trouble does to the floor, in stages:
//
//   a little trouble   litter and coffee stains around the desks that have it
//   more               cracks in the floor among them
//   past the lava line the floor gives way: lava, pooling from those desks
//
// The trouble level decides how far it reaches; the problems decide where it
// starts -- behind the desks of the nodes that have them first, then
// anywhere -- and a seeded random walk spreads it, so the same cluster in the
// same state marks the same tiles every refresh. Lava is the extreme: off
// until the level passes `lavaStart`, and never more than `lavaMax` of the floor.

import { T, type Layout, type Seat } from './layout';
import { hash, rng } from './rng';

/** The share of the free floor that shows some mark at a trouble level of 1. */
const MARK_REACH = 0.5;
/** Of the tiles in reach, how many carry a mark: marks are scattered, not a carpet. */
const MARK_DENSITY = 0.3;
/** The level at which cracks start to appear among the litter. */
export const CRACKS_FROM = 0.3;

export const Mark = { None: 0, Litter: 1, Stain: 2, Crack: 3 } as const;

export interface Lava {
    /** Per tile, 0 for solid floor, up to 1 for the hottest lava. */
    heat: Float32Array;
    /** Per tile, 1 where there is lava: what people path around. */
    mask: Uint8Array;
    /** Lava tiles. */
    count: number;
    /** Per tile, one of `Mark`: the milder damage, drawn on the floor and walked over. */
    marks: Uint8Array;
}

export interface FloorOptions {
    lava: boolean;
    lavaStart: number;
    lavaMax: number;
}

export function emptyLava(layout: Layout): Lava {
    const n = layout.w * layout.h;
    return { heat: new Float32Array(n), mask: new Uint8Array(n), count: 0, marks: new Uint8Array(n) };
}

/** How much of the free floor is lava at `level`: none below the start, `lavaMax` at 1. */
export function lavaShare(level: number, opts: FloorOptions): number {
    if (!opts.lava || level < opts.lavaStart) return 0;
    const span = 1 - opts.lavaStart;
    return opts.lavaMax * (span <= 0 ? 1 : Math.min(1, (level - opts.lavaStart) / span));
}

/**
 * @param level      0-1, from `hazard()`
 * @param hotSeats   seats behind which it starts, hottest first
 * @param seed       anything stable about the cluster
 */
export function spreadLava(layout: Layout, level: number, hotSeats: Seat[], seed: string, opts: FloorOptions): Lava {
    const out = emptyLava(layout);
    const { w, tiles, blocked } = layout;
    const chairs = new Set([...layout.seats, ...layout.managerSeats].map((s) => s.y * w + s.x));
    const eligible = (i: number): boolean => !blocked[i] && tiles[i] !== T.Door && !chairs.has(i);

    let free = 0;
    for (let i = 0; i < tiles.length; i++) if (eligible(i)) free++;
    if (level < 0.03 || !free) return out;

    const lavaN = Math.round(lavaShare(level, opts) * free);
    const reach = Math.min(free, Math.max(lavaN, Math.round(Math.min(1, level * 1.3) * free * MARK_REACH), 6));

    // Two generators: one picks the random seeds, the other grows the area.
    // The seeds are always drawn the same way, whatever the level, so rising
    // trouble spreads from the same places rather than starting new ones.
    const seedRandom = rng(hash(seed));
    const random = rng(hash(seed) ^ 0x9e3779b9);
    const candidates: number[] = [];
    for (let tries = 0; candidates.length < 24 && tries < 2000; tries++) {
        const i = Math.floor(seedRandom() * tiles.length);
        if (eligible(i) && !candidates.includes(i)) candidates.push(i);
    }
    // Seeds: the aisle behind each hot seat, then random tiles, one for every
    // twenty tiles in reach, so it comes in patches rather than one blob.
    const seeds: number[] = [];
    for (const s of hotSeats) {
        const behind = (s.y + 1) * w + s.x;
        if (eligible(behind)) seeds.push(behind);
    }
    seeds.push(...candidates.slice(0, 1 + Math.floor(reach / 20)));

    const order: number[] = [];
    const taken = new Uint8Array(tiles.length);
    const frontier: number[] = [];
    for (const s of seeds) {
        if (taken[s] || order.length >= reach) continue;
        taken[s] = 1;
        order.push(s);
        frontier.push(s);
    }
    while (order.length < reach && frontier.length) {
        // A random tile of the edge grows by one: patches with ragged edges.
        const k = Math.floor(random() * frontier.length);
        const cur = frontier[k]!;
        const x = cur % w;
        const around = [cur - w, cur + w, x > 0 ? cur - 1 : -1, x < w - 1 ? cur + 1 : -1].filter((n) => n >= 0 && n < tiles.length && !taken[n] && eligible(n));
        if (!around.length) {
            frontier.splice(k, 1);
            continue;
        }
        const n = around[Math.floor(random() * around.length)]!;
        taken[n] = 1;
        order.push(n);
        frontier.push(n);
    }

    // The first tiles reached are the lava, hottest where it started; the
    // rest get a scattering of marks, cracks more likely the worse it is.
    const crackOdds = level < CRACKS_FROM ? 0 : Math.min(0.85, 0.25 + (level - CRACKS_FROM) * 1.5);
    const salt = hash(seed + ':marks');
    order.forEach((i, n) => {
        if (n < lavaN) {
            out.heat[i] = 1 - (n / Math.max(1, lavaN)) * 0.6;
            out.mask[i] = 1;
            return;
        }
        const r = hash(`${salt}:${i}`) / 4294967296;
        if (r >= MARK_DENSITY) return;
        const kind = r / MARK_DENSITY;
        out.marks[i] = kind < crackOdds ? Mark.Crack : (hash(`${i}`) & 1) === 0 ? Mark.Litter : Mark.Stain;
    });
    out.count = Math.min(lavaN, order.length);
    return out;
}
