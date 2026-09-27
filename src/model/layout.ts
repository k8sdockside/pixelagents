// The floor plan: a grid of 16-pixel tiles, worked out from how many people
// there are and how roomy the office should be. Plain data -- no drawing -- so
// it can be tested. A bigger office has wider aisles, a meeting table, a
// bigger lounge and more server racks.
//
//   ┌──────────┬─────────────────────────────┬─────────────┐
//   │ glass    │  open floor: rows of desks  │  lounge:    │
//   │ room:    │  ▭▭ ▭▭  ▭▭ ▭▭  ▭▭           │  coffee,    │
//   │ control  │  ☺  ☺   ☺  ☺   ☺            │  couch,     │
//   │ planes   │  ▭▭ ▭▭  ▭▭ ▭▭  ▭▭           │  server     │
//   │          │  ☺  ☺   ☺  ☺   ☺            │  rack       │
//   └──────door┴─────────────────────────────┴──door───────┘
//
// Every person faces up, towards their screen, with their back to us: we see
// what is on every monitor over their shoulders.

export const TILE = 16;

export const T = {
    Void: 0,
    Wall: 1,
    Floor: 2,
    Room: 3,
    Lounge: 4,
    Glass: 5,
    Door: 6,
} as const;

export type Tile = (typeof T)[keyof typeof T];

export type ItemType =
    | 'desk'
    | 'plant'
    | 'coffee'
    | 'cooler'
    | 'vending'
    | 'couch'
    | 'rack'
    | 'shelf'
    | 'printer'
    | 'inbox'
    | 'table'
    | 'window'
    | 'clock'
    | 'board'
    | 'cloud'
    | 'poster';

export interface Item {
    type: ItemType;
    x: number;
    y: number;
    w: number;
    h: number;
    /** Whether people walk around it rather than through it. Wall decorations do not block: they are on the wall. */
    blocks: boolean;
}

export interface Seat {
    /** The chair's tile; the desk is the two tiles above it, from `x`. */
    x: number;
    y: number;
    room: 'glass' | 'floor';
}

export type SpotKind = 'coffee' | 'cooler' | 'vending' | 'couch' | 'window' | 'printer' | 'plant' | 'meeting';

export interface Spot {
    x: number;
    y: number;
    kind: SpotKind;
    /** Whether the person sits there, facing us, rather than stands facing up. */
    sit: boolean;
}

export interface Layout {
    w: number;
    h: number;
    tiles: Uint8Array;
    /** 1 where nobody can stand. */
    blocked: Uint8Array;
    items: Item[];
    managerSeats: Seat[];
    seats: Seat[];
    spots: Spot[];
    door: { x: number; y: number };
    /** Where unscheduled pods pile up as boxes: just inside the door. */
    inbox: { x: number; y: number; w: number };
    /** The glass room's inner span, for its sign when there are no control planes to see. */
    glassRoom: { x0: number; x1: number };
    size: Size;
}

/** How roomy the office is, once `auto` has been decided. */
export type Size = 'small' | 'medium' | 'large';

interface Roominess {
    /** Tiles between one pair of desks and the next. */
    pairGap: number;
    /** Extra aisle rows between rows of desks. */
    rowGap: number;
    loungeW: number;
    minInnerH: number;
    /** A meeting table at the bottom of the open floor. */
    meeting: boolean;
}

const ROOMINESS: Record<Size, Roominess> = {
    small: { pairGap: 1, rowGap: 0, loungeW: 7, minInnerH: 11, meeting: false },
    medium: { pairGap: 2, rowGap: 1, loungeW: 9, minInnerH: 13, meeting: true },
    large: { pairGap: 2, rowGap: 1, loungeW: 11, minInnerH: 16, meeting: true },
};

const TOP = 2; // the wall's two rows

/** The size `auto` picks: the office grows with the cluster. */
export function sizeFor(nodes: number): Size {
    if (nodes <= 6) return 'small';
    if (nodes <= 24) return 'medium';
    return 'large';
}

/** Server racks in the lounge: one for every four nodes, at least two. */
export function racksFor(nodes: number): number {
    return Math.max(2, Math.ceil(nodes / 4));
}

/** Desks per row for `n` desks: a floor about half again as wide as it is deep. */
export function desksPerRow(n: number): number {
    return Math.max(1, Math.min(n, 14, Math.ceil(Math.sqrt(n * 1.6))));
}

/** A desk slot's x on the open floor: desks come in pairs, with an aisle after every pair. */
function slotX(x0: number, i: number, gap: number): number {
    return x0 + i * 2 + Math.floor(i / 2) * gap;
}

export interface LayoutOptions {
    size: Size;
    /** Server racks wanted; as many as fit are placed. */
    racks: number;
}

export function buildLayout(managers: number, workers: number, opts: LayoutOptions = { size: 'small', racks: 2 }): Layout {
    const room = ROOMINESS[opts.size];
    const desks = Math.max(workers, 2);
    const perRow = desksPerRow(desks);
    const rows = Math.ceil(desks / perRow);
    const pitch = 3 + room.rowGap;

    const floorW = slotX(0, perRow - 1, room.pairGap) + 2;
    // A meeting table as wide as the floor allows, up to six tiles, with room
    // for chairs above and below: five rows in all.
    const tableW = room.meeting ? Math.min(6, floorW - 2) : 0;
    const meetingRows = tableW >= 2 ? 5 : 0;

    // Height: the wall, an aisle, a pitch for every row of desks (desk, chair,
    // aisle and any extra aisle), the meeting area, then the bottom wall.
    const innerH = Math.max(1 + rows * pitch + meetingRows, room.minInnerH);
    const h = TOP + innerH + 1;

    // The glass room: columns of desks, three rows each, above a clear row
    // for its door.
    const roomRows = Math.max(1, Math.floor((innerH - 3) / 3));
    const roomCols = Math.max(1, Math.ceil(managers / roomRows));
    const roomW = 1 + roomCols * 3;
    const glassX = 1 + roomW;

    const floorX0 = glassX + 2;
    const loungeX0 = floorX0 + floorW + 1;
    const LW = room.loungeW;
    const w = loungeX0 + LW + 1;

    const tiles = new Uint8Array(w * h);
    const at = (x: number, y: number): number => y * w + x;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let t: Tile = T.Floor;
            if (y < TOP || y === h - 1 || x === 0 || x === w - 1) t = T.Wall;
            else if (x === glassX) t = T.Glass;
            else if (x < glassX) t = T.Room;
            else if (x >= loungeX0) t = T.Lounge;
            tiles[at(x, y)] = t;
        }
    }
    // The glass room's door, two tiles high, near the bottom.
    tiles[at(glassX, h - 3)] = T.Door;
    tiles[at(glassX, h - 2)] = T.Door;
    // The way in, at the bottom of the lounge.
    const door = { x: loungeX0 + 3, y: h - 1 };
    tiles[at(door.x, door.y)] = T.Door;

    const items: Item[] = [];
    const item = (type: ItemType, x: number, y: number, iw = 1, ih = 1, blocks = true): void => {
        items.push({ type, x, y, w: iw, h: ih, blocks });
    };

    // Managers: desks down each column of the glass room.
    const managerSeats: Seat[] = [];
    for (let i = 0; i < managers; i++) {
        const col = Math.floor(i / roomRows);
        const row = i % roomRows;
        const x = 2 + col * 3;
        const y = TOP + 1 + row * 3;
        item('desk', x, y, 2, 1);
        managerSeats.push({ x, y: y + 1, room: 'glass' });
    }
    if (managers === 0) item('cloud', 2, TOP + 1, Math.min(3, roomW - 1), 2, false);
    item('plant', roomW, h - 2);
    item('board', 2, 0, Math.min(3, roomW - 1), 2, false);

    // The open floor.
    const seats: Seat[] = [];
    for (let i = 0; i < desks; i++) {
        const row = Math.floor(i / perRow);
        const x = slotX(floorX0, i % perRow, room.pairGap);
        const y = TOP + 1 + row * pitch;
        item('desk', x, y, 2, 1);
        seats.push({ x, y: y + 1, room: 'floor' });
    }
    // Windows along the wall, a poster between them.
    const slots: number[] = [];
    for (let x = floorX0; x + 1 < loungeX0 - 1; x += 4) slots.push(x);
    const posterAt = slots.length >= 3 ? Math.floor(slots.length / 2) : -1;
    slots.forEach((x, i) => item(i === posterAt ? 'poster' : 'window', x, 0, 2, 2, false));

    const spots: Spot[] = [];
    // The meeting table, on a rug of its own, below the last row of desks.
    if (meetingRows) {
        const top = TOP + 1 + rows * pitch;
        const tx = floorX0 + Math.floor((floorW - tableW) / 2);
        for (let y = top; y < top + 4; y++) for (let x = tx - 1; x <= tx + tableW; x++) tiles[at(x, y)] = T.Room;
        item('table', tx, top + 1, tableW, 2);
        for (let x = tx; x < tx + tableW; x++) {
            spots.push({ x, y: top, kind: 'meeting', sit: true });
            spots.push({ x, y: top + 3, kind: 'meeting', sit: false });
        }
    }
    // Plants at the floor's bottom corners, when there is a free row for them.
    if (innerH > rows * pitch + meetingRows + 1) {
        item('plant', floorX0, h - 2);
        item('plant', floorX0 + floorW - 1, h - 2);
    }

    // The lounge: the kitchen along the wall, couches, a shelf and the
    // printer on the right, and the server racks at the bottom.
    const l = loungeX0;
    item('coffee', l + 1, TOP);
    spots.push({ x: l + 1, y: TOP + 1, kind: 'coffee', sit: false });
    item('cooler', l + 3, TOP);
    spots.push({ x: l + 3, y: TOP + 1, kind: 'cooler', sit: false });
    item('vending', l + 5, TOP);
    spots.push({ x: l + 5, y: TOP + 1, kind: 'vending', sit: false });
    if (LW >= 9) {
        item('coffee', l + 7, TOP);
        spots.push({ x: l + 7, y: TOP + 1, kind: 'coffee', sit: false });
    }
    item('clock', l + 3, 0, 1, 2, false);
    item('window', l + LW - 2, 0, 2, 2, false);
    const couches = LW >= 9 ? 2 : 1;
    for (let c = 0; c < couches; c++) {
        const cx = l + 1 + c * 4;
        item('couch', cx, TOP + 4, 3, 1, false);
        for (let i = 0; i < 3; i++) spots.push({ x: cx + i, y: TOP + 4, kind: 'couch', sit: true });
        item('plant', cx - 1, TOP + 4);
    }
    item('plant', l + 1 + couches * 4 - 1, TOP + 4);
    item('shelf', l + LW - 1, TOP + 3, 1, 2);
    item('printer', l + LW - 1, TOP + 6);
    spots.push({ x: l + LW - 2, y: TOP + 6, kind: 'printer', sit: false });
    spots.push({ x: l + 1, y: TOP + 1, kind: 'window', sit: false });

    // Racks in pairs from the right, a gap between pairs to walk through;
    // a second row above when there are more than fit, and room for it.
    const rackRows = [h - 4];
    if (h - 7 >= TOP + 8) rackRows.push(h - 7);
    let placed = 0;
    for (const y of rackRows) {
        for (let k = 0; placed < opts.racks; k++) {
            const x = l + LW - 1 - k - Math.floor(k / 2);
            if (x < l + 1) break;
            item('rack', x, y, 1, 2);
            placed++;
        }
    }

    const inbox = { x: door.x + 1, y: h - 2, w: 2 };
    item('inbox', inbox.x, inbox.y, inbox.w, 1, false);

    const blocked = new Uint8Array(w * h);
    for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        blocked[i] = t === T.Wall || t === T.Glass || t === T.Void ? 1 : 0;
    }
    blocked[at(door.x, door.y)] = 1; // nobody leaves
    for (const it of items) {
        if (!it.blocks) continue;
        for (let y = it.y; y < it.y + it.h; y++) for (let x = it.x; x < it.x + it.w; x++) blocked[at(x, y)] = 1;
    }

    return { w, h, tiles, blocked, items, managerSeats, seats, spots, door, inbox, glassRoom: { x0: 1, x1: glassX - 1 }, size: opts.size };
}

/** Tiles someone could stand on, as indices. */
export function walkable(layout: Layout): number[] {
    const out: number[] = [];
    for (let i = 0; i < layout.blocked.length; i++) if (!layout.blocked[i]) out.push(i);
    return out;
}
