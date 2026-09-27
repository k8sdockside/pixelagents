// Randomness that is the same every time for the same input, so a refresh
// does not reshuffle the office: a node keeps its person's face, and a hot
// spot keeps its place on the floor.

/** A 32-bit hash of a string (FNV-1a). */
export function hash(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** A generator of numbers in [0, 1) from a seed (mulberry32). */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** One element of a list, chosen by `random`. */
export function pick<T>(list: readonly T[], random: () => number): T {
    return list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
}

export function clamp(value: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, value));
}
