// Getting from one tile to another: breadth-first over the grid, four ways.
// The office is at most a few thousand tiles, so nothing cleverer is needed.

export interface Grid {
    w: number;
    h: number;
    blocked: Uint8Array;
}

export interface Point {
    x: number;
    y: number;
}

/**
 * The tiles from `from` (left out) to `to` (included), or null when there is
 * no way. Tiles in `avoid` -- the lava -- are gone around when that is
 * possible and crossed when it is not: nobody is trapped at their desk. The
 * goal itself may be blocked (a chair tucked under a desk is not); the start
 * always may be.
 */
export function findPath(grid: Grid, from: Point, to: Point, avoid?: Uint8Array): Point[] | null {
    if (avoid) {
        const around = search(grid, from, to, avoid);
        if (around) return around;
    }
    return search(grid, from, to, undefined);
}

function search(grid: Grid, from: Point, to: Point, avoid: Uint8Array | undefined): Point[] | null {
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
        const cur = queue[head++]!;
        if (cur === goal) break;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        const next = [cy > 0 ? cur - w : -1, cy < h - 1 ? cur + w : -1, cx > 0 ? cur - 1 : -1, cx < w - 1 ? cur + 1 : -1];
        for (const n of next) {
            if (n < 0 || prev[n] !== -1) continue;
            if (n !== goal && (blocked[n] || (avoid && avoid[n]))) continue;
            prev[n] = cur;
            queue[tail++] = n;
        }
    }
    if (prev[goal] === -1) return null;
    const path: Point[] = [];
    for (let cur = goal; cur !== start; cur = prev[cur]!) path.push({ x: cur % w, y: Math.floor(cur / w) });
    return path.reverse();
}
