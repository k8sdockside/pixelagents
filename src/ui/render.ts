// Drawing the office. Everything is drawn at one pixel a pixel into a buffer
// the size of the world, then scaled up onto the page canvas with smoothing
// off -- which is what keeps pixel art crisp -- and the names are written on
// top at the page's own resolution, so they are sharp too.
//
// Three layers: the floor and walls (drawn once per floor plan, and again
// when night falls), the lava, then everything that stands on the floor,
// sorted by where it meets the floor so a person walking in front of a desk
// is drawn over it and one behind is hidden by it.

import { T, TILE, type Item, type Layout } from '../model/layout';
import { Mark } from '../model/lava';
import type { Desk } from '../model/office';
import { hash } from '../model/rng';
import type { FloorStyle, HazardStyle, Settings } from '../model/settings';
import { personSprite, SPRITE_PAD, SPRITE_W, type Look } from './sprites';
import type { Agent, Bubble, World } from './world';

type G = CanvasRenderingContext2D;

// ----- colours ----------------------------------------------------------------

const FLOORS: Record<FloorStyle, { a: string; b: string; line: string }> = {
    wood: { a: '#b8844f', b: '#a8763f', line: '#7d5530' },
    carpet: { a: '#5a6b8c', b: '#52627f', line: '#46546e' },
    tiles: { a: '#d8dde3', b: '#c9cfd6', line: '#aab2bc' },
    concrete: { a: '#9a9a96', b: '#8f8f8b', line: '#7c7c78' },
};

const HAZARDS: Record<HazardStyle, { base: string; hot: string; core: string; crust: string; rim: string; crack: string; glow: string }> = {
    lava: { base: '#b8330c', hot: '#f97316', core: '#fde047', crust: '#3b1a0b', rim: '#7c2d12', crack: '#2a1a10', glow: 'rgba(255, 120, 30, 0.28)' },
    flood: { base: '#2563eb', hot: '#60a5fa', core: '#dbeafe', crust: '#1e3a8a', rim: '#93c5fd', crack: '#1e40af', glow: 'rgba(90, 160, 255, 0.18)' },
    slime: { base: '#4d7c0f', hot: '#84cc16', core: '#d9f99d', crust: '#1a2e05', rim: '#365314', crack: '#264010', glow: 'rgba(160, 255, 60, 0.2)' },
};

const WALL = { face: '#e9e4da', faceTop: '#f4f0e8', trim: '#3c3f4a', base: '#7a6a58', side: '#3c3f4a', sideTop: '#5a5e6c' };

function rect(g: G, colour: string, x: number, y: number, w: number, h: number): void {
    g.fillStyle = colour;
    g.fillRect(x, y, w, h);
}

function mix(a: string, b: string, t: number): string {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const ch = (s: number): number => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
    return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}

/** 0 at noon, 1 at midnight, following the settings or the clock. */
export function nightLevel(settings: Pick<Settings, 'dayNight'>, now = new Date()): number {
    if (settings.dayNight === 'day') return 0;
    if (settings.dayNight === 'night') return 1;
    const h = now.getHours() + now.getMinutes() / 60;
    if (h >= 7.5 && h <= 18) return 0;
    if (h > 18 && h < 21) return (h - 18) / 3;
    if (h > 5 && h < 7.5) return 1 - (h - 5) / 2.5;
    return 1;
}

// ----- the floor and the walls ----------------------------------------------------

function drawFloorTile(g: G, t: number, x: number, y: number, style: FloorStyle, seed: number): void {
    const px = x * TILE;
    const py = y * TILE;
    if (t === T.Room) {
        // The glass room has a rug of its own.
        rect(g, (x + y) % 2 ? '#6b5470' : '#735b78', px, py, TILE, TILE);
        rect(g, '#62496a', px + ((seed >> 3) % 14), py + ((seed >> 7) % 14), 1, 1);
        return;
    }
    if (t === T.Lounge) {
        rect(g, (x + y) % 2 ? '#e6dcc8' : '#d9ccb4', px, py, TILE, TILE);
        rect(g, '#c7b89c', px, py + TILE - 1, TILE, 1);
        rect(g, '#c7b89c', px + TILE - 1, py, 1, TILE);
        return;
    }
    const f = FLOORS[style];
    switch (style) {
        case 'wood':
            // Planks four pixels high, the joints staggered row by row.
            for (let row = 0; row < 4; row++) {
                rect(g, (row + y + (seed & 1)) % 2 ? f.a : f.b, px, py + row * 4, TILE, 4);
                rect(g, f.line, px, py + row * 4 + 3, TILE, 1);
                rect(g, f.line, px + ((x * 7 + row * 5 + y * 3) % 16), py + row * 4, 1, 3);
            }
            break;
        case 'carpet':
            rect(g, f.a, px, py, TILE, TILE);
            for (let i = 0; i < 6; i++) rect(g, f.b, px + ((seed >> (i * 2)) & 15), py + ((seed >> (i * 3 + 1)) & 15), 1, 1);
            break;
        case 'tiles':
            rect(g, (x + y) % 2 ? f.a : f.b, px, py, TILE, TILE);
            rect(g, f.line, px, py + TILE - 1, TILE, 1);
            rect(g, f.line, px + TILE - 1, py, 1, TILE);
            break;
        case 'concrete':
            rect(g, f.a, px, py, TILE, TILE);
            for (let i = 0; i < 5; i++) rect(g, i % 2 ? f.b : f.line, px + ((seed >> (i * 3)) & 15), py + ((seed >> (i * 2 + 5)) & 15), 1, 1);
            break;
    }
}

function drawWindow(g: G, px: number, py: number, w: number, night: number): void {
    rect(g, '#6b5a48', px + 2, py + 5, w - 4, 22);
    const sky = mix('#8ecdf5', '#131a3a', night);
    rect(g, sky, px + 4, py + 7, w - 8, 18);
    rect(g, mix('#bfe4fb', '#1d2752', night), px + 4, py + 7, w - 8, 6);
    if (night < 0.5) {
        rect(g, '#ffffff', px + 7, py + 10, 6, 2);
        rect(g, '#ffffff', px + 9, py + 9, 3, 1);
        rect(g, '#6fa36a', px + 4, py + 21, w - 8, 4);
        rect(g, '#5b8f57', px + 10, py + 19, 6, 2);
    } else {
        rect(g, '#fdf6c9', px + w - 12, py + 9, 3, 3);
        rect(g, '#ffffff', px + 7, py + 12, 1, 1);
        rect(g, '#ffffff', px + 12, py + 18, 1, 1);
        rect(g, '#2a2f4a', px + 4, py + 21, w - 8, 4);
        rect(g, '#f5d76e', px + 8, py + 22, 1, 1);
        rect(g, '#f5d76e', px + 14, py + 22, 1, 1);
    }
    rect(g, '#6b5a48', px + w / 2 - 1, py + 7, 2, 18);
    rect(g, '#6b5a48', px + 4, py + 15, w - 8, 1);
    rect(g, '#8a7660', px + 1, py + 26, w - 2, 2);
}

function drawWallItem(g: G, it: Item, night: number): void {
    const px = it.x * TILE;
    const py = it.y * TILE;
    switch (it.type) {
        case 'window':
            drawWindow(g, px, py, it.w * TILE, night);
            break;
        case 'board': {
            const w = it.w * TILE;
            rect(g, '#9aa3ad', px + 2, py + 6, w - 4, 20);
            rect(g, '#fbfbfb', px + 3, py + 7, w - 6, 18);
            // Someone's architecture diagram.
            rect(g, '#3b82f6', px + 6, py + 10, 8, 5);
            rect(g, '#ef4444', px + 20, py + 10, 8, 5);
            rect(g, '#10b981', px + 13, py + 18, 8, 5);
            rect(g, '#555555', px + 14, py + 12, 6, 1);
            rect(g, '#555555', px + 17, py + 15, 1, 3);
            rect(g, '#9aa3ad', px + 4, py + 26, w - 8, 2);
            break;
        }
        case 'poster': {
            rect(g, '#1d4ed8', px + 9, py + 5, 14, 20);
            rect(g, '#326ce5', px + 10, py + 6, 12, 18);
            // A ship's wheel, near enough, in the middle of its two tiles.
            const cx = px + 16;
            const cy = py + 15;
            rect(g, '#ffffff', cx - 3, cy - 4, 6, 1);
            rect(g, '#ffffff', cx - 3, cy + 3, 6, 1);
            rect(g, '#ffffff', cx - 4, cy - 3, 1, 6);
            rect(g, '#ffffff', cx + 3, cy - 3, 1, 6);
            rect(g, '#ffffff', cx - 1, cy - 6, 1, 12);
            rect(g, '#ffffff', cx - 6, cy - 1, 12, 1);
            rect(g, '#ffffff', cx - 1, cy - 1, 2, 2);
            break;
        }
        case 'clock':
            // Drawn each frame instead: it keeps time.
            break;
        case 'cloud': {
            // No control planes to see: the cloud runs them.
            const cx = px + 8;
            const cy = py + 12;
            rect(g, '#dfe8f5', cx, cy + 4, 30, 8);
            rect(g, '#dfe8f5', cx + 4, cy, 12, 6);
            rect(g, '#dfe8f5', cx + 14, cy - 3, 12, 8);
            rect(g, '#b9c8dd', cx, cy + 11, 30, 1);
            rect(g, '#326ce5', cx + 12, cy + 4, 6, 6);
            rect(g, '#ffffff', cx + 14, cy + 6, 2, 2);
            break;
        }
        default:
            break;
    }
}

export function drawBackground(g: G, layout: Layout, style: FloorStyle, night: number): void {
    const { w, h, tiles } = layout;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const t = tiles[y * w + x]!;
            const px = x * TILE;
            const py = y * TILE;
            if (t === T.Wall) {
                if (y < 2 && x > 0 && x < w - 1) {
                    // The wall we look at: two tiles of face, trim on top, skirting at the bottom.
                    rect(g, y === 0 ? WALL.faceTop : WALL.face, px, py, TILE, TILE);
                    if (y === 0) rect(g, WALL.trim, px, py, TILE, 3);
                    if (y === 1) rect(g, WALL.base, px, py + TILE - 3, TILE, 3);
                } else {
                    rect(g, WALL.side, px, py, TILE, TILE);
                    rect(g, WALL.sideTop, px, py, TILE, 2);
                }
                continue;
            }
            // Under glass and doors, the floor of whichever side they are on.
            let floor: number = t;
            if (t === T.Glass || t === T.Door) floor = y === h - 1 ? T.Lounge : tiles[y * w + x - 1] === T.Room ? T.Room : T.Floor;
            drawFloorTile(g, floor, x, y, style, hash(`${x},${y}`));
            if (t === T.Glass) {
                // A glass partition: a frame and panes we see through.
                rect(g, 'rgba(170, 215, 245, 0.45)', px + 5, py, 6, TILE);
                rect(g, '#8aa4bc', px + 5, py, 1, TILE);
                rect(g, '#8aa4bc', px + 10, py, 1, TILE);
                rect(g, 'rgba(255, 255, 255, 0.6)', px + 7, py + ((x * 5 + y * 3) % 10), 1, 4);
                if (y % 3 === 0) rect(g, '#8aa4bc', px + 5, py, 6, 1);
            }
            if (t === T.Door && y === h - 1) {
                rect(g, '#6e4a2c', px + 1, py + 4, TILE - 2, 10);
                rect(g, '#8a5d38', px + 2, py + 5, TILE - 4, 8);
                rect(g, '#9b7045', px + 3, py + 12, TILE - 6, 2);
            }
        }
    }
    for (const it of layout.items) if (!it.blocks) drawWallItem(g, it, night);
}

// ----- the floor's damage ------------------------------------------------------------

/**
 * The milder stages: litter, coffee stains and cracks. Drawn once into the
 * floor layer, since they do not move. Cracks next to lava glow; elsewhere
 * they are only cracks.
 */
export function drawMarks(g: G, layout: Layout, marks: Uint8Array, mask: Uint8Array, style: HazardStyle): void {
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
        const ox = 2 + (seed % 8);
        const oy = 3 + ((seed >> 4) % 8);
        if (m === Mark.Litter) {
            // A screwed-up sheet of paper, or a stray printout.
            if (seed & 32) {
                rect(g, '#e9e9e2', px + ox, py + oy, 4, 3);
                rect(g, '#c9c9c0', px + ox + 1, py + oy + 1, 2, 1);
                rect(g, '#ffffff', px + ox, py + oy, 1, 1);
            } else {
                rect(g, '#f4f4ee', px + ox, py + oy, 5, 4);
                rect(g, '#9aa3ad', px + ox + 1, py + oy + 1, 3, 1);
                rect(g, '#9aa3ad', px + ox + 1, py + oy + 2, 2, 1);
            }
        } else if (m === Mark.Stain) {
            // Spilt coffee.
            g.globalAlpha = 0.55;
            rect(g, '#5a3a22', px + ox, py + oy + 1, 6, 2);
            rect(g, '#5a3a22', px + ox + 1, py + oy, 4, 4);
            g.globalAlpha = 1;
        } else {
            const near = (dx: number, dy: number): boolean => mask[(y + dy) * w + x + dx] === 1;
            const hot = near(1, 0) || near(-1, 0) || near(0, 1) || near(0, -1);
            const cx = 3 + (seed % 9);
            const line = hot ? glow : 'rgba(30, 20, 14, 0.75)';
            rect(g, line, px + cx, py + 2, 1, 5);
            rect(g, line, px + cx + 1, py + 6, 1, 4);
            rect(g, line, px + cx - 1, py + 9, 1, 5);
            rect(g, line, px + cx + 2, py + 9, 4, 1);
            rect(g, line, px + cx - 4, py + 4, 4, 1);
        }
    }
}

// ----- the lava -------------------------------------------------------------------

export function drawHazard(g: G, layout: Layout, heat: Float32Array, mask: Uint8Array, style: HazardStyle, clock: number): void {
    const c = HAZARDS[style];
    const { w } = layout;
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const x = i % w;
        const y = (i - x) / w;
        const px = x * TILE;
        const py = y * TILE;
        const h = heat[i]!;
        const seed = hash(`${x}.${y}`);
        const phase = clock * 1.6 + (seed % 100) / 16;
        rect(g, c.base, px, py, TILE, TILE);
        // Blobs of the hotter stuff drifting about.
        for (let k = 0; k < 3; k++) {
            const bx = (((seed >> (k * 5)) & 15) + Math.sin(phase + k * 2.1) * 3 + 16) % 13;
            const by = (((seed >> (k * 5 + 3)) & 15) + Math.cos(phase * 0.8 + k) * 3 + 16) % 13;
            rect(g, c.hot, px + Math.floor(bx), py + Math.floor(by), 4, 3);
            rect(g, c.hot, px + Math.floor(bx) + 1, py + Math.floor(by) - 1, 2, 5);
            if (k === 0 && h > 0.6) rect(g, c.core, px + Math.floor(bx) + 1, py + Math.floor(by) + 1, 2, 1);
        }
        // Now and then a bubble comes up and pops.
        const cycle = (clock * 0.7 + (seed % 97) / 97) % 1;
        if (cycle < 0.18) {
            const r = cycle < 0.12 ? 1 : 2;
            const bx = px + 4 + (seed % 8);
            const by = py + 4 + ((seed >> 4) % 8);
            rect(g, c.core, bx - r, by, r * 2 + 1, 1);
            rect(g, c.core, bx, by - r, 1, r * 2 + 1);
        }
        // A crust where it meets solid floor.
        const edge = (dx: number, dy: number): boolean => {
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

// ----- furniture ---------------------------------------------------------------------

const itemCache = new Map<string, HTMLCanvasElement>();

function sprite(key: string, w: number, h: number, draw: (g: G) => void): HTMLCanvasElement {
    let c = itemCache.get(key);
    if (!c) {
        c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        draw(c.getContext('2d')!);
        itemCache.set(key, c);
    }
    return c;
}

function deskSprite(): HTMLCanvasElement {
    return sprite('desk', 32, 16, (g) => {
        rect(g, '#b88352', 0, 2, 32, 2);
        rect(g, '#9c6b3f', 0, 4, 32, 6);
        rect(g, '#7a522e', 0, 10, 32, 4);
        rect(g, '#5e3f24', 1, 14, 3, 2);
        rect(g, '#5e3f24', 28, 14, 3, 2);
        // Keyboard and mouse.
        rect(g, '#d6d9de', 10, 7, 11, 3);
        rect(g, '#aeb3ba', 10, 9, 11, 1);
        rect(g, '#d6d9de', 23, 7, 2, 3);
    });
}

function chairSprite(): HTMLCanvasElement {
    return sprite('chair', 16, 16, (g) => {
        rect(g, '#2f3440', 2, 8, 12, 4);
        rect(g, '#434a59', 3, 8, 10, 1);
        rect(g, '#2f3440', 7, 12, 2, 2);
        rect(g, '#1f232b', 3, 14, 10, 1);
        rect(g, '#1f232b', 3, 15, 2, 1);
        rect(g, '#1f232b', 11, 15, 2, 1);
    });
}

function itemSprite(it: Item): HTMLCanvasElement | null {
    switch (it.type) {
        case 'plant':
            return sprite('plant', 16, 24, (g) => {
                rect(g, '#2f7d43', 4, 2, 8, 8);
                rect(g, '#3f9d56', 2, 5, 5, 6);
                rect(g, '#3f9d56', 9, 4, 5, 7);
                rect(g, '#56b86d', 6, 0, 4, 5);
                rect(g, '#2f7d43', 5, 10, 6, 4);
                rect(g, '#b5653b', 3, 14, 10, 8);
                rect(g, '#9a5230', 3, 20, 10, 2);
                rect(g, '#cf7a4c', 3, 14, 10, 2);
            });
        case 'coffee':
            return sprite('coffee', 16, 26, (g) => {
                rect(g, '#8b7a66', 0, 16, 16, 10);
                rect(g, '#a8957d', 0, 16, 16, 2);
                rect(g, '#3a3d45', 3, 2, 10, 14);
                rect(g, '#50545e', 4, 3, 8, 4);
                rect(g, '#e84a4a', 10, 9, 2, 1);
                rect(g, '#1d1f24', 6, 11, 4, 3);
                rect(g, '#f4f4f4', 6, 13, 3, 3);
            });
        case 'cooler':
            return sprite('cooler', 16, 28, (g) => {
                rect(g, '#9fd3f5', 4, 0, 8, 10);
                rect(g, '#cdeafc', 5, 1, 2, 7);
                rect(g, '#6aa6d6', 6, 10, 4, 2);
                rect(g, '#e9edf2', 3, 12, 10, 14);
                rect(g, '#c8cfd8', 3, 24, 10, 2);
                rect(g, '#3b82f6', 6, 16, 2, 2);
                rect(g, '#ef4444', 9, 16, 2, 2);
            });
        case 'vending':
            return sprite('vending', 16, 30, (g) => {
                rect(g, '#b9303a', 1, 0, 14, 28);
                rect(g, '#d8434d', 1, 0, 14, 2);
                rect(g, '#1d2233', 3, 3, 8, 18);
                for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) rect(g, ['#f0a53c', '#46b37a', '#4a86ff', '#e6d24a'][(r + k) % 4]!, 4 + k * 2, 5 + r * 4, 1, 2);
                rect(g, '#d6d9de', 12, 6, 2, 6);
                rect(g, '#1d2233', 3, 23, 8, 3);
                rect(g, '#7a1d24', 1, 28, 14, 2);
            });
        case 'couch':
            return sprite('couch', 48, 20, (g) => {
                rect(g, '#7a3f52', 0, 0, 48, 9);
                rect(g, '#8a4b5c', 1, 1, 46, 3);
                rect(g, '#9b5a6c', 2, 9, 44, 7);
                rect(g, '#7a3f52', 16, 9, 1, 7);
                rect(g, '#7a3f52', 31, 9, 1, 7);
                rect(g, '#6a3446', 0, 4, 3, 14);
                rect(g, '#6a3446', 45, 4, 3, 14);
                rect(g, '#4a2433', 2, 18, 3, 2);
                rect(g, '#4a2433', 43, 18, 3, 2);
            });
        case 'shelf':
            return sprite('shelf', 16, 34, (g) => {
                rect(g, '#6b4a2e', 0, 0, 16, 34);
                rect(g, '#4a321f', 1, 1, 14, 32);
                const books = ['#e0564f', '#4a86ff', '#46b37a', '#f0a53c', '#9b6cf0', '#e6d24a', '#2bb3c0'];
                for (let s = 0; s < 4; s++) {
                    rect(g, '#6b4a2e', 1, 8 + s * 8, 14, 1);
                    for (let b = 0; b < 5; b++) rect(g, books[(s * 3 + b) % books.length]!, 2 + b * 3 - (b > 3 ? 1 : 0), 2 + s * 8 + (b % 2), 2, 6 - (b % 2));
                }
            });
        case 'printer':
            return sprite('printer', 16, 18, (g) => {
                rect(g, '#6b6f78', 2, 10, 12, 8);
                rect(g, '#e5e7eb', 1, 2, 14, 8);
                rect(g, '#c4c8cf', 1, 8, 14, 2);
                rect(g, '#ffffff', 4, 0, 8, 3);
                rect(g, '#22c55e', 12, 4, 1, 1);
            });
        case 'table':
            return sprite(`table${it.w}`, it.w * TILE, it.h * TILE + 4, (g) => {
                const tw = it.w * TILE;
                const th = it.h * TILE;
                rect(g, '#6e4a2c', 0, 2, tw, th - 4);
                rect(g, '#8a5d38', 1, 3, tw - 2, th - 7);
                rect(g, '#a06d42', 2, 4, tw - 4, 2);
                rect(g, '#5a3b22', 2, th - 2, 3, 4);
                rect(g, '#5a3b22', tw - 5, th - 2, 3, 4);
                // Laptops and papers on it.
                for (let x = 8; x + 8 < tw; x += 20) {
                    rect(g, '#c4c8cf', x, 8, 8, 5);
                    rect(g, '#38bdf8', x + 1, 9, 6, 3);
                    rect(g, '#f4f4ee', x + 11, 14, 5, 4);
                }
            });
        case 'rack':
            return sprite('rack', 16, 34, (g) => {
                rect(g, '#1f232b', 1, 0, 14, 34);
                rect(g, '#2f3440', 2, 1, 12, 32);
                for (let u = 0; u < 7; u++) rect(g, '#15181e', 3, 3 + u * 4, 10, 3);
            });
        default:
            return null;
    }
}

// ----- the moving parts ---------------------------------------------------------------

const SCREEN_W = 12;
const SCREEN_H = 7;

function drawMonitor(g: G, desk: Desk | null, agent: Agent | null, px: number, py: number, clock: number): void {
    // The monitor stands on the back of the desk and pokes above it.
    const mx = px + 10;
    const my = py - 6;
    rect(g, '#2a2d34', mx, my, 14, 10);
    rect(g, '#2a2d34', mx + 6, my + 10, 2, 2);
    rect(g, '#3a3e47', mx + 4, my + 11, 6, 1);
    const sx = mx + 1;
    const sy = my + 1;
    const present = !!agent && agent.away < 0.5;
    if (!desk || !agent) {
        rect(g, '#0c0e12', sx, sy, SCREEN_W, SCREEN_H);
        return;
    }
    if (desk.mood === 'down') {
        // The blue screen.
        rect(g, '#1d4ed8', sx, sy, SCREEN_W, SCREEN_H);
        rect(g, '#dbeafe', sx + 1, sy + 1, 3, 1);
        rect(g, '#dbeafe', sx + 1, sy + 3, 8, 1);
        rect(g, '#dbeafe', sx + 1, sy + 5, 6, 1);
        return;
    }
    if (!present) {
        // A screensaver: one dot wandering the dark.
        rect(g, '#0c0e12', sx, sy, SCREEN_W, SCREEN_H);
        const t = clock * 0.8 + (hash(desk.person.id) % 50);
        rect(g, '#38bdf8', sx + Math.floor(((Math.sin(t) + 1) / 2) * (SCREEN_W - 1)), sy + Math.floor(((Math.cos(t * 1.3) + 1) / 2) * (SCREEN_H - 1)), 1, 1);
        return;
    }
    const hot = desk.activity > 0.85;
    const trouble = desk.mood === 'trouble';
    rect(g, hot ? '#2a0f14' : '#0f1a24', sx, sy, SCREEN_W, SCREEN_H);
    // Lines of code scrolling up, faster the busier the node.
    const speed = 1 + desk.activity * 10;
    const offset = Math.floor(clock * speed);
    const seed = hash(desk.person.id);
    const palette = trouble ? ['#f87171', '#fca5a5', '#fbbf24'] : hot ? ['#fb923c', '#fca5a5', '#fde68a'] : ['#4ade80', '#60a5fa', '#e5e7eb', '#c084fc'];
    for (let row = 0; row < 3; row++) {
        const n = offset + row;
        const len = 3 + ((seed >> (n % 13)) + n * 7) % 8;
        const indent = ((seed >> (n % 7)) + n) % 3;
        rect(g, palette[(n + seed) % palette.length]!, sx + 1 + indent, sy + 1 + row * 2, Math.min(len, SCREEN_W - 2 - indent), 1);
    }
    if (trouble && Math.floor(clock * 2) % 2 === 0) {
        rect(g, '#ef4444', sx + SCREEN_W - 3, sy + 1, 2, 3);
        rect(g, '#ef4444', sx + SCREEN_W - 3, sy + 5, 2, 1);
    }
}

function drawPapers(g: G, pods: number, px: number, py: number): void {
    // The node's pods, as paperwork: a sheet for every ten, up to a tall pile.
    const sheets = Math.min(6, Math.ceil(pods / 10));
    for (let i = 0; i < sheets; i++) {
        rect(g, i % 2 ? '#f4f4f0' : '#e6e6de', px + 25 - (i % 2), py + 5 - i, 6, 2);
    }
}

function drawClock(g: G, it: Item): void {
    const cx = it.x * TILE + 8;
    const cy = it.y * TILE + 14;
    rect(g, '#3c3f4a', cx - 6, cy - 6, 12, 12);
    rect(g, '#fafafa', cx - 5, cy - 5, 10, 10);
    const now = new Date();
    const hand = (angle: number, len: number, colour: string): void => {
        for (let r = 0; r <= len; r++) rect(g, colour, Math.round(cx + Math.sin(angle) * r) - 0.5, Math.round(cy - Math.cos(angle) * r) - 0.5, 1, 1);
    };
    hand(((now.getHours() % 12) + now.getMinutes() / 60) * (Math.PI / 6), 2.5, '#1f2937');
    hand(now.getMinutes() * (Math.PI / 30), 4, '#1f2937');
}

function drawRackLights(g: G, it: Item, busy: number, clock: number): void {
    const px = it.x * TILE;
    const py = (it.y + it.h) * TILE - 34;
    for (let u = 0; u < 7; u++) {
        for (let k = 0; k < 3; k++) {
            const on = Math.sin(clock * (3 + busy * 25) * (1 + k * 0.37) + u * 1.7 + it.x) > 0.2 - busy * 0.6;
            rect(g, on ? (k === 2 && busy > 0.85 ? '#f97316' : '#22c55e') : '#0b3d1f', px + 4 + k * 3, py + 4 + u * 4, 1, 1);
        }
    }
}

function drawInbox(g: G, it: Item, count: number): void {
    // Unscheduled pods: boxes stacking up by the door, three to a layer.
    const n = Math.min(count, 9);
    const baseX = it.x * TILE;
    const baseY = (it.y + 1) * TILE;
    for (let i = 0; i < n; i++) {
        const layer = Math.floor(i / 3);
        const col = i % 3;
        const x = baseX + 1 + col * 10 + layer * 5;
        const y = baseY - 8 - layer * 7;
        if (layer * 5 + col * 10 > 22) continue;
        rect(g, '#b08150', x, y, 9, 7);
        rect(g, '#c99a66', x, y, 9, 2);
        rect(g, '#8a6038', x + 4, y, 1, 7);
    }
}

function drawBubble(g: G, kind: Bubble, x: number, y: number, clock: number): void {
    rect(g, '#1f2330', x - 1, y - 1, 11, 9);
    rect(g, '#ffffff', x, y, 9, 7);
    rect(g, '#ffffff', x + 2, y + 7, 2, 1);
    rect(g, '#1f2330', x + 2, y + 8, 1, 1);
    switch (kind) {
        case 'chat': {
            const n = Math.floor(clock * 3) % 4;
            for (let i = 0; i < Math.max(1, n); i++) rect(g, '#374151', x + 1 + i * 3, y + 3, 1, 1);
            break;
        }
        case 'bang':
            rect(g, '#dc2626', x + 4, y + 1, 1, 3);
            rect(g, '#dc2626', x + 4, y + 5, 1, 1);
            break;
        case 'zzz':
            rect(g, '#3b82f6', x + 2, y + 1, 5, 1);
            rect(g, '#3b82f6', x + 5, y + 2, 1, 1);
            rect(g, '#3b82f6', x + 4, y + 3, 1, 1);
            rect(g, '#3b82f6', x + 3, y + 4, 1, 1);
            rect(g, '#3b82f6', x + 2, y + 5, 5, 1);
            break;
        case 'coffee':
            rect(g, '#7c4a2a', x + 2, y + 2, 4, 4);
            rect(g, '#7c4a2a', x + 6, y + 3, 1, 2);
            rect(g, '#d6d3d1', x + 3, y + 1, 1, 1);
            break;
        case 'sweat':
            rect(g, '#38bdf8', x + 4, y + 1, 1, 1);
            rect(g, '#38bdf8', x + 3, y + 2, 3, 3);
            break;
        case 'fire':
            rect(g, '#f97316', x + 2, y + 2, 5, 4);
            rect(g, '#f97316', x + 3, y + 1, 2, 1);
            rect(g, '#fde047', x + 3, y + 3, 3, 3);
            break;
        case 'eye':
            rect(g, '#22c55e', x + 2, y + 3, 2, 1);
            rect(g, '#22c55e', x + 5, y + 3, 2, 1);
            break;
    }
}

// ----- the renderer ---------------------------------------------------------------------

export interface View {
    /** Page pixels per world pixel. */
    scale: number;
    hover: Agent | null;
}

interface Drawable {
    base: number;
    draw: () => void;
}

export class Renderer {
    readonly canvas: HTMLCanvasElement;
    private readonly ctx: G;
    private readonly buffer = document.createElement('canvas');
    private readonly bctx: G;
    private readonly bg = document.createElement('canvas');
    private bgKey = '';
    private bgLava: unknown = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
        this.bctx = this.buffer.getContext('2d')!;
    }

    /** The world's size in world pixels. */
    size(layout: Layout): { w: number; h: number } {
        return { w: layout.w * TILE, h: layout.h * TILE };
    }

    draw(world: World, settings: Settings, view: View): void {
        const { layout, lava } = world.office;
        const size = this.size(layout);
        const night = nightLevel(settings);
        const nightStep = Math.round(night * 8) / 8;

        if (this.buffer.width !== size.w || this.buffer.height !== size.h) {
            this.buffer.width = size.w;
            this.buffer.height = size.h;
        }
        // The floor layer, marks and all, is redrawn only when something in it changes.
        if (world.office.lava !== this.bgLava || this.bgKey !== `${layout.w}x${layout.h}|${settings.floor}|${settings.hazardStyle}|${nightStep}`) {
            this.bg.width = size.w;
            this.bg.height = size.h;
            const bg = this.bg.getContext('2d')!;
            drawBackground(bg, layout, settings.floor, nightStep);
            drawMarks(bg, layout, lava.marks, lava.mask, settings.hazardStyle);
            this.bgKey = `${layout.w}x${layout.h}|${settings.floor}|${settings.hazardStyle}|${nightStep}`;
            this.bgLava = world.office.lava;
        }

        const g = this.bctx;
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        g.drawImage(this.bg, 0, 0);
        drawHazard(g, layout, lava.heat, lava.mask, settings.hazardStyle, world.clock);

        // Everything that stands on the floor, back to front.
        const items: Drawable[] = [];
        const bySeat = new Map<string, Agent>();
        for (const a of world.agents) if (a.desk) bySeat.set(`${a.desk.seat.x},${a.desk.seat.y}`, a);
        const deskFor = new Map(world.office.desks.map((d) => [`${d.seat.x},${d.seat.y}`, d]));
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
                    drawMonitor(g, desk, agent, px, py, world.clock);
                    if (desk) drawPapers(g, desk.pods, px, py);
                },
            });
            items.push({ base: (seat.y + 1) * TILE + 0.5, draw: () => g.drawImage(chairSprite(), px + 8, seat.y * TILE) });
        }
        for (const it of layout.items) {
            const s = itemSprite(it);
            if (s) {
                const base = it.type === 'couch' ? it.y * TILE + 4 : (it.y + it.h) * TILE;
                items.push({
                    base,
                    draw: () => {
                        g.drawImage(s, it.x * TILE, (it.y + it.h) * TILE - s.height + (it.type === 'couch' ? 4 : 0));
                        if (it.type === 'rack') drawRackLights(g, it, world.office.busy, world.clock);
                    },
                });
            } else if (it.type === 'inbox') {
                items.push({ base: (it.y + 1) * TILE - 1, draw: () => drawInbox(g, it, world.office.unscheduled) });
            }
        }
        for (const a of world.agents) items.push({ base: a.y + TILE, draw: () => this.drawAgent(g, a, world.clock, view.hover === a) });
        items.sort((p, q) => p.base - q.base);
        for (const d of items) d.draw();

        this.drawParticles(g, world);
        for (const it of layout.items) if (it.type === 'clock') drawClock(g, it);
        for (const a of world.agents) {
            if (!a.bubble) continue;
            const { x } = this.agentPos(a);
            drawBubble(g, a.bubble, x + 7, a.y - 16, world.clock);
        }

        // Night: dim everything, then let the screens and the lava shine.
        if (night > 0.02) {
            g.fillStyle = `rgba(12, 16, 48, ${0.5 * night})`;
            g.fillRect(0, 0, size.w, size.h);
            g.globalCompositeOperation = 'lighter';
            const glow = HAZARDS[settings.hazardStyle].glow;
            g.globalAlpha = night * 0.6;
            for (let i = 0; i < lava.mask.length; i++) {
                if (lava.mask[i]) rect(g, glow, (i % layout.w) * TILE, Math.floor(i / layout.w) * TILE, TILE, TILE);
            }
            g.globalAlpha = night;
            for (const a of world.agents) {
                if (!a.desk || a.away > 0.5 || a.desk.mood === 'down') continue;
                rect(g, 'rgba(120, 180, 255, 0.16)', a.desk.seat.x * TILE + 11, (a.desk.seat.y - 1) * TILE - 5, 12, 8);
            }
            g.globalAlpha = 1;
            g.globalCompositeOperation = 'source-over';
        }

        // Onto the page, scaled up with no smoothing.
        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.round(size.w * view.scale);
        const cssH = Math.round(size.h * view.scale);
        if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
            this.canvas.width = Math.round(cssW * dpr);
            this.canvas.height = Math.round(cssH * dpr);
            this.canvas.style.width = `${cssW}px`;
            this.canvas.style.height = `${cssH}px`;
        }
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
        const k = view.scale * dpr;
        if (view.hover) {
            const { x } = this.agentPos(view.hover);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(1, dpr);
            ctx.strokeRect((x + 1) * k, (view.hover.y - 5) * k, 14 * k, 22 * k);
        }
        if (settings.names && view.scale >= 1.5) this.drawNames(ctx, world, k, dpr);
    }

    /** Where an agent is drawn: at the desk, slid over to the middle of it. */
    agentPos(a: Agent): { x: number } {
        return { x: a.x + (a.desk ? 8 * (1 - a.away) : 0) };
    }

    private drawAgent(g: G, a: Agent, clock: number, hovered: boolean): void {
        const { x } = this.agentPos(a);
        const frame = Math.floor(a.phase);
        let y = a.y - 2 - SPRITE_PAD;
        // Standing on lava: hopping from foot to foot.
        if (a.burning > 0 && a.state !== 'walk') y -= Math.abs(Math.sin(clock * 12)) * 3;
        const look: Look = a.look;
        if (!a.desk) g.globalAlpha = 0.82;
        if (a.state !== 'sit' && a.state !== 'sleep') {
            // A shadow under anyone on their feet.
            g.fillStyle = 'rgba(0, 0, 0, 0.18)';
            g.fillRect(x + 4, a.y + 14, 8, 2);
        }
        g.drawImage(personSprite(look, a.dir, a.pose, frame), Math.round(x + (16 - SPRITE_W) / 2), Math.round(y));
        g.globalAlpha = 1;
        if (hovered) {
            // A little marker overhead, as well as the outline on the page.
            rect(g, '#ffffff', x + 7, a.y - 9, 2, 2);
        }
    }

    private drawParticles(g: G, world: World): void {
        const c = HAZARDS.lava;
        for (const p of world.particles) {
            const t = p.life / p.max;
            g.globalAlpha = Math.max(0, Math.min(1, t * 1.5));
            switch (p.kind) {
                case 'spark':
                case 'ember':
                    rect(g, t > 0.5 ? c.core : c.hot, Math.round(p.x), Math.round(p.y), 1, 1);
                    break;
                case 'sweat':
                    rect(g, '#7dd3fc', Math.round(p.x), Math.round(p.y), 1, 2);
                    break;
                case 'smoke':
                    rect(g, t > 0.5 ? '#6b7280' : '#9ca3af', Math.round(p.x), Math.round(p.y), 2, 2);
                    break;
                case 'steam':
                    rect(g, '#ffffff', Math.round(p.x + Math.sin(p.y / 3)), Math.round(p.y), 1, 1);
                    break;
                case 'z': {
                    const x = Math.round(p.x);
                    const y = Math.round(p.y);
                    rect(g, '#93c5fd', x, y, 3, 1);
                    rect(g, '#93c5fd', x + 1, y + 1, 1, 1);
                    rect(g, '#93c5fd', x, y + 2, 3, 1);
                    break;
                }
            }
        }
        g.globalAlpha = 1;
    }

    private drawNames(ctx: G, world: World, k: number, dpr: number): void {
        const size = Math.max(9, Math.min(12, 3.4 * (k / dpr))) * dpr;
        ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const desk of world.office.desks) {
            const text = desk.label.length > 18 ? desk.label.slice(0, 17) + '…' : desk.label;
            const cx = (desk.seat.x * TILE + 16) * k;
            const cy = (desk.seat.y + 1) * TILE * k + 1 * dpr;
            const w = ctx.measureText(text).width + 6 * dpr;
            ctx.fillStyle = 'rgba(15, 18, 26, 0.72)';
            ctx.fillRect(cx - w / 2, cy, w, size + 3 * dpr);
            ctx.fillStyle = desk.mood === 'down' ? '#fca5a5' : desk.mood === 'trouble' ? '#fcd34d' : desk.role === 'control-plane' ? '#c4b5fd' : '#e5e7eb';
            ctx.fillText(text, cx, cy + 1.5 * dpr);
        }
    }
}
