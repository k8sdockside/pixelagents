// What the user can turn: how big the office is and how many people, how busy
// they get, how quickly trouble shows on the floor and when it turns to lava,
// and what the office looks like. Kept per cluster in the
// app's plugin storage, never in the cluster.

import { clamp } from './rng';

export type HazardStyle = 'lava' | 'flood' | 'slime';
export type FloorStyle = 'wood' | 'carpet' | 'tiles' | 'concrete';
export type DayNight = 'auto' | 'day' | 'night';
export type OfficeSize = 'auto' | 'small' | 'medium' | 'large';

export interface Settings {
    /** How roomy the office is; `auto` grows it with the number of nodes. */
    officeSize: OfficeSize;
    /** People at a desk for every node: 0.5 is one person for two nodes. */
    peoplePerNode: number;
    /** The most people the office holds; past it, one person stands for several nodes. */
    maxPeople: number;
    /** How much of each resource makes a person busy, 0-100 each. */
    cpuWeight: number;
    memoryWeight: number;
    diskWeight: number;
    /** Multiplies every node's load before it becomes busyness: 1 is as measured. */
    busyness: number;
    /** Multiplies the trouble score: 0 keeps the floor spotless whatever happens. */
    hazardSensitivity: number;
    /** Whether the floor turns to lava at all when things are really bad. */
    lava: boolean;
    /** The trouble level, 0-1, at which lava starts: below it there is only mess and cracks. */
    lavaStart: number;
    /** The most of the free floor lava takes, 0-1, at a trouble level of 100%. */
    lavaMax: number;
    /** Whether security findings count towards the trouble, and bring in intruders. */
    securityChecks: boolean;
    /** Whether Warning events count. */
    warningEvents: boolean;
    /** Namespaces the security checks skip: system pods are privileged by trade. */
    ignoreNamespaces: string[];

    hazardStyle: HazardStyle;
    floor: FloorStyle;
    dayNight: DayNight;
    /** 0 picks the largest scale that fits. */
    scale: number;
    /** 0.25-3: how fast the office moves. */
    speed: number;
    names: boolean;
    intruders: boolean;
    /** Unscheduled pods as boxes piling up by the door. */
    inbox: boolean;
    /** Seconds between reads of the cluster. */
    refresh: number;
}

export const DEFAULT_SETTINGS: Settings = {
    officeSize: 'auto',
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
    ignoreNamespaces: ['kube-system', 'kube-public', 'kube-node-lease'],
    hazardStyle: 'lava',
    floor: 'wood',
    dayNight: 'auto',
    scale: 0,
    speed: 1,
    names: true,
    intruders: true,
    inbox: true,
    refresh: 15,
};

export const STORAGE_KEY = 'settings';

export const PEOPLE_PER_NODE = [0.25, 0.5, 1, 2, 3, 4] as const;
export const REFRESH_CHOICES = [5, 10, 15, 30, 60] as const;
export const SCALE_CHOICES = [0, 1, 2, 3, 4] as const;

/** Anything read back from storage, made into settings: unknown fields dropped, bad ones defaulted. */
export function sanitize(raw: unknown): Settings {
    const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const d = DEFAULT_SETTINGS;
    const num = (key: keyof Settings, lo: number, hi: number): number => {
        const v = src[key];
        return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : (d[key] as number);
    };
    const bool = (key: keyof Settings): boolean => (typeof src[key] === 'boolean' ? (src[key] as boolean) : (d[key] as boolean));
    const oneOf = <T extends string>(key: keyof Settings, choices: readonly T[]): T => {
        const v = src[key];
        return typeof v === 'string' && (choices as readonly string[]).includes(v) ? (v as T) : (d[key] as T);
    };
    const namespaces = Array.isArray(src.ignoreNamespaces)
        ? src.ignoreNamespaces.filter((n): n is string => typeof n === 'string').map((n) => n.trim()).filter(Boolean)
        : d.ignoreNamespaces;

    return {
        officeSize: oneOf('officeSize', ['auto', 'small', 'medium', 'large'] as const),
        peoplePerNode: num('peoplePerNode', 0.25, 4),
        maxPeople: Math.round(num('maxPeople', 1, 200)),
        cpuWeight: num('cpuWeight', 0, 100),
        memoryWeight: num('memoryWeight', 0, 100),
        diskWeight: num('diskWeight', 0, 100),
        busyness: num('busyness', 0, 3),
        hazardSensitivity: num('hazardSensitivity', 0, 3),
        lava: bool('lava'),
        lavaStart: num('lavaStart', 0.3, 1),
        lavaMax: num('lavaMax', 0.05, 0.8),
        securityChecks: bool('securityChecks'),
        warningEvents: bool('warningEvents'),
        ignoreNamespaces: [...new Set(namespaces)],
        hazardStyle: oneOf('hazardStyle', ['lava', 'flood', 'slime'] as const),
        floor: oneOf('floor', ['wood', 'carpet', 'tiles', 'concrete'] as const),
        dayNight: oneOf('dayNight', ['auto', 'day', 'night'] as const),
        scale: Math.round(num('scale', 0, 6)),
        speed: num('speed', 0.25, 3),
        names: bool('names'),
        intruders: bool('intruders'),
        inbox: bool('inbox'),
        refresh: Math.round(num('refresh', 5, 300)),
    };
}

/** Namespaces typed into a field, comma- or space-separated. */
export function parseNamespaces(text: string): string[] {
    return [...new Set(text.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean))];
}
