// The office in motion: people who sit and type as hard as their node works,
// get up for coffee when it is quiet, sleep at the desk when their node is
// down, lounge on the couch when it is cordoned, and run when the floor under
// them is lava. Intruders -- the security findings -- skulk about.
//
// No drawing here; render.ts reads the state this keeps.

import { TILE, type Spot } from '../model/layout';
import type { Desk, Office } from '../model/office';
import { findPath, type Point } from '../model/path';
import { hash, pick, rng } from '../model/rng';
import { INTRUDER, lookFor, type Dir, type Look, type Pose } from './sprites';

export type Bubble = 'chat' | 'bang' | 'zzz' | 'coffee' | 'sweat' | 'fire' | 'eye';

type State = 'sit' | 'walk' | 'linger' | 'sleep';

export interface Agent {
    id: string;
    look: Look;
    desk: Desk | null;
    /** Pixel position of the tile the agent stands on, top-left. */
    x: number;
    y: number;
    dir: Dir;
    pose: Pose;
    state: State;
    /** Seconds left in the current state. */
    timer: number;
    path: Point[];
    /** What the walk is for. */
    goal: 'seat' | 'spot' | 'visit' | 'wander';
    spot: Spot | null;
    /** Animation clock: steps while walking, keystrokes while typing. */
    phase: number;
    bubble: Bubble | null;
    bubbleTimer: number;
    /** Seconds on lava, for the flames. */
    burning: number;
    /** 0 at the desk, 1 anywhere else: slides the seated sprite to the desk's middle. */
    away: number;
}

export interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    max: number;
    kind: 'spark' | 'z' | 'sweat' | 'steam' | 'ember' | 'smoke';
}

const MAX_PARTICLES = 400;

export class World {
    office: Office;
    agents: Agent[] = [];
    particles: Particle[] = [];
    /** Seconds since the world began: every animation keys off it. */
    clock = 0;
    private random = rng(hash('pixel-agents'));
    private taken = new Set<Spot>();
    private layoutKey = '';

    constructor(office: Office) {
        this.office = office;
        this.rebuild(office);
    }

    /**
     * A new reading of the cluster. The same floor plan keeps everyone where
     * they are and only changes how busy they are; a new one -- a node came
     * or went -- seats everybody again.
     */
    update(office: Office, intruders: number): void {
        const key = `${office.layout.w}x${office.layout.h}:${office.desks.map((d) => d.person.id).join(',')}`;
        const same = key === this.layoutKey;
        this.office = office;
        if (!same) {
            this.rebuild(office);
        } else {
            const byId = new Map(office.desks.map((d) => [d.person.id, d]));
            for (const a of this.agents) if (a.desk) a.desk = byId.get(a.desk.person.id) ?? a.desk;
        }
        this.setIntruders(intruders);
    }

    private rebuild(office: Office): void {
        this.layoutKey = `${office.layout.w}x${office.layout.h}:${office.desks.map((d) => d.person.id).join(',')}`;
        this.taken.clear();
        const staff = office.desks.map((desk): Agent => {
            const look = lookFor(desk.person.id, desk.role === 'control-plane');
            return {
                id: desk.person.id,
                look,
                desk,
                x: desk.seat.x * TILE,
                y: desk.seat.y * TILE,
                dir: 'up',
                pose: 'type',
                state: 'sit',
                // Stagger the first stand-up so the whole floor does not rise at
                // once; a cordoned node's person is off to the couch straight away.
                timer: desk.mood === 'cordoned' ? 0.5 : 2 + this.random() * 12,
                path: [],
                goal: 'seat',
                spot: null,
                phase: this.random() * 4,
                bubble: null,
                bubbleTimer: 0,
                burning: 0,
                away: 0,
            };
        });
        this.agents = [...staff, ...this.agents.filter((a) => !a.desk)];
        for (const a of this.agents) if (!a.desk) this.placeAnywhere(a);
    }

    private setIntruders(count: number): void {
        const current = this.agents.filter((a) => !a.desk);
        if (current.length > count) {
            const drop = new Set(current.slice(count));
            this.agents = this.agents.filter((a) => !drop.has(a));
            return;
        }
        for (let i = current.length; i < count; i++) {
            const a: Agent = {
                id: `intruder:${i}`,
                look: INTRUDER,
                desk: null,
                x: this.office.layout.door.x * TILE,
                y: (this.office.layout.door.y - 1) * TILE,
                dir: 'up',
                pose: 'stand',
                state: 'linger',
                timer: 0.5 + i,
                path: [],
                goal: 'wander',
                spot: null,
                phase: 0,
                bubble: null,
                bubbleTimer: 0,
                burning: 0,
                away: 1,
            };
            this.agents.push(a);
        }
    }

    private placeAnywhere(a: Agent): void {
        const tile = this.randomFloor();
        a.x = tile.x * TILE;
        a.y = tile.y * TILE;
        a.path = [];
        a.state = 'linger';
        a.timer = 1;
    }

    private randomFloor(): Point {
        const { w, h, blocked } = this.office.layout;
        for (let i = 0; i < 400; i++) {
            const x = 1 + Math.floor(this.random() * (w - 2));
            const y = 2 + Math.floor(this.random() * (h - 3));
            if (!blocked[y * w + x]) return { x, y };
        }
        return { x: this.office.layout.door.x, y: this.office.layout.door.y - 1 };
    }

    tile(a: Agent): Point {
        return { x: Math.round(a.x / TILE), y: Math.round(a.y / TILE) };
    }

    private onLava(a: Agent): boolean {
        const { x, y } = this.tile(a);
        return this.office.lava.mask[y * this.office.layout.w + x] === 1;
    }

    private walkTo(a: Agent, to: Point, goal: Agent['goal']): boolean {
        const path = findPath(this.office.layout, this.tile(a), to, this.office.lava.mask);
        if (!path) return false;
        a.path = path;
        a.goal = goal;
        a.state = 'walk';
        a.pose = 'walk';
        return true;
    }

    private goToSeat(a: Agent): void {
        if (!a.desk) return;
        this.release(a);
        if (!this.walkTo(a, a.desk.seat, 'seat')) {
            // Somehow walled in: teleport rather than stand there for ever.
            a.x = a.desk.seat.x * TILE;
            a.y = a.desk.seat.y * TILE;
            this.arrive(a);
        }
    }

    private release(a: Agent): void {
        if (a.spot) this.taken.delete(a.spot);
        a.spot = null;
    }

    private goSomewhere(a: Agent): void {
        const desk = a.desk!;
        const spots = this.office.layout.spots.filter((s) => !this.taken.has(s));
        const cordoned = desk.mood === 'cordoned';
        // A cordoned node's person is on a long break, on the couch if they can.
        const couch = spots.filter((s) => s.kind === 'couch');
        if (cordoned && couch.length) return this.useSpot(a, pick(couch, this.random));

        const roll = this.random();
        const others = this.agents.filter((o) => o !== a && o.desk && o.state === 'sit');
        if (roll < 0.25 && others.length) {
            // Over to a colleague's desk, to stand behind them and talk.
            const other = pick(others, this.random);
            const at = { x: other.desk!.seat.x + 1, y: other.desk!.seat.y + 1 };
            if (!this.office.layout.blocked[at.y * this.office.layout.w + at.x] && this.walkTo(a, at, 'visit')) return;
        }
        if (spots.length) return this.useSpot(a, pick(spots, this.random));
        this.walkTo(a, this.randomFloor(), 'wander');
    }

    private useSpot(a: Agent, spot: Spot): void {
        this.release(a);
        this.taken.add(spot);
        a.spot = spot;
        if (!this.walkTo(a, spot, 'spot')) this.release(a);
    }

    private arrive(a: Agent): void {
        const desk = a.desk;
        a.path = [];
        if (!desk) {
            a.state = 'linger';
            a.pose = 'stand';
            a.timer = 0.8 + this.random() * 3;
            if (this.random() < 0.3) this.say(a, 'eye', 2);
            return;
        }
        switch (a.goal) {
            case 'seat':
                a.dir = 'up';
                if (desk.mood === 'down') {
                    a.state = 'sleep';
                    a.pose = 'sleep';
                    a.timer = 5;
                } else {
                    a.state = 'sit';
                    a.pose = desk.activity > 0.08 ? 'type' : 'sit-back';
                    a.timer = (5 + this.random() * 15) * (0.6 + desk.activity * 2);
                }
                break;
            case 'spot': {
                const spot = a.spot!;
                a.state = 'linger';
                if (spot.sit) {
                    a.dir = 'down';
                    a.pose = 'sit-front';
                    a.timer = desk.mood === 'cordoned' ? 60 : 8 + this.random() * 14;
                } else {
                    a.dir = 'up';
                    a.pose = 'stand';
                    a.timer = 3 + this.random() * 8;
                }
                if (spot.kind === 'coffee') this.say(a, 'coffee', 3);
                if (spot.kind === 'meeting') this.say(a, 'chat', a.timer * 0.6);
                break;
            }
            case 'visit':
                a.state = 'linger';
                a.dir = 'up';
                a.pose = 'stand';
                a.timer = 3 + this.random() * 5;
                this.say(a, 'chat', a.timer);
                break;
            default:
                a.state = 'linger';
                a.pose = 'stand';
                a.timer = 1 + this.random() * 3;
        }
    }

    private say(a: Agent, bubble: Bubble, seconds: number): void {
        a.bubble = bubble;
        a.bubbleTimer = seconds;
    }

    private emit(p: Omit<Particle, 'max'>): void {
        if (this.particles.length >= MAX_PARTICLES) return;
        this.particles.push({ ...p, max: p.life });
    }

    /** Moves everything on by `dt` seconds, already scaled by the speed setting. */
    step(dt: number): void {
        this.clock += dt;
        for (const a of this.agents) this.stepAgent(a, dt);
        this.stepParticles(dt);
    }

    private stepAgent(a: Agent, dt: number): void {
        const desk = a.desk;
        const activity = desk?.activity ?? 0.3;
        a.bubbleTimer -= dt;
        if (a.bubbleTimer <= 0) a.bubble = null;

        const atDesk = !!desk && (a.state === 'sit' || a.state === 'sleep');
        a.away += ((atDesk ? 0 : 1) - a.away) * Math.min(1, dt * 12);

        // The floor is lava: run.
        const burning = this.onLava(a);
        a.burning = burning ? a.burning + dt : 0;
        if (burning) {
            if (this.random() < dt * 14) this.emit({ x: a.x + 4 + this.random() * 8, y: a.y + 14, vx: (this.random() - 0.5) * 10, vy: -18 - this.random() * 12, life: 0.6, kind: 'ember' });
            if (a.state !== 'walk') {
                this.say(a, 'fire', 1.5);
                // At a desk with lava under it, they put up with it for a few
                // seconds; anywhere else, they are off at once.
                const seated = a.state === 'sit' || a.state === 'sleep';
                if (!seated || a.burning >= 3) {
                    if (desk) this.goSomewhere(a);
                    else this.walkTo(a, this.randomFloor(), 'wander');
                }
            }
        }

        switch (a.state) {
            case 'walk':
                this.stepWalk(a, dt, activity, burning);
                break;
            case 'sit':
                a.phase += dt * (2 + activity * 14);
                a.pose = desk && desk.activity > 0.08 ? 'type' : 'sit-back';
                if (desk && desk.activity > 0.82 && this.random() < dt * 1.2) {
                    this.emit({ x: a.x + 4 + this.random() * 8, y: a.y - 2, vx: (this.random() - 0.5) * 8, vy: -6, life: 0.7, kind: 'sweat' });
                }
                if (desk && desk.mood === 'trouble') {
                    if (!a.bubble && this.random() < dt * 0.25) this.say(a, 'bang', 2.5);
                    // The troubled desk's monitor smokes a little.
                    if (this.random() < dt * 1.5) this.emit({ x: a.x + 16 + (this.random() - 0.5) * 8, y: a.y - 20, vx: (this.random() - 0.5) * 4, vy: -7, life: 1.4, kind: 'smoke' });
                }
                if (desk && desk.mood === 'down') {
                    a.state = 'sleep';
                    a.pose = 'sleep';
                }
                a.timer -= dt;
                if (a.timer <= 0 && desk) {
                    const leave = desk.mood === 'cordoned' ? 1 : desk.activity > 0.85 ? 0.03 : Math.pow(1 - desk.activity, 1.5) * 0.75 + 0.05;
                    if (this.random() < leave) this.goSomewhere(a);
                    else a.timer = 4 + this.random() * 10;
                }
                break;
            case 'sleep':
                if (this.random() < dt * 0.8) this.emit({ x: a.x + 10, y: a.y - 4, vx: 4, vy: -8, life: 1.6, kind: 'z' });
                if (desk && desk.mood !== 'down') {
                    a.state = 'sit';
                    a.timer = 2;
                }
                break;
            case 'linger':
                if (a.spot?.kind === 'coffee' && this.random() < dt * 2) this.emit({ x: a.x + 8, y: a.y - 14, vx: 0, vy: -6, life: 1.2, kind: 'steam' });
                a.timer -= dt;
                if (a.timer <= 0) {
                    if (!desk) {
                        this.walkTo(a, this.pickIntruderTarget(), 'wander');
                    } else if (desk.mood === 'cordoned' && a.spot?.sit) {
                        a.timer = 30;
                    } else if (desk.mood === 'down' || this.random() < 0.55 + activity * 0.4) {
                        this.goToSeat(a);
                    } else {
                        this.goSomewhere(a);
                    }
                }
                break;
        }
    }

    private pickIntruderTarget(): Point {
        // Half the time, behind someone's chair, reading over their shoulder.
        const seated = this.agents.filter((o) => o.desk && o.state === 'sit');
        if (seated.length && this.random() < 0.5) {
            const o = pick(seated, this.random);
            const at = { x: o.desk!.seat.x + 1, y: o.desk!.seat.y + 1 };
            if (!this.office.layout.blocked[at.y * this.office.layout.w + at.x]) return at;
        }
        return this.randomFloor();
    }

    private stepWalk(a: Agent, dt: number, activity: number, burning: boolean): void {
        const next = a.path[0];
        if (!next) {
            this.arrive(a);
            return;
        }
        const tilesPerSecond = (a.desk ? 2.2 + activity * 2.4 : 1.4) * (burning ? 2.2 : 1);
        let budget = tilesPerSecond * TILE * dt;
        a.phase += dt * tilesPerSecond * 2.2;
        while (budget > 0 && a.path.length) {
            const target = a.path[0]!;
            const tx = target.x * TILE;
            const ty = target.y * TILE;
            const dx = tx - a.x;
            const dy = ty - a.y;
            const dist = Math.abs(dx) + Math.abs(dy);
            if (dist > 0) a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
            if (dist <= budget) {
                a.x = tx;
                a.y = ty;
                budget -= dist;
                a.path.shift();
            } else {
                a.x += (Math.sign(dx) * Math.min(Math.abs(dx), budget));
                if (Math.abs(dx) < budget) a.y += Math.sign(dy) * (budget - Math.abs(dx));
                budget = 0;
            }
        }
        if (!a.path.length) this.arrive(a);
    }

    private stepParticles(dt: number): void {
        const { lava, layout } = this.office;
        // Lava spits.
        if (lava.count) {
            const chances = Math.min(6, lava.count * 0.04) * dt * 10;
            for (let i = 0; i < chances; i++) {
                if (this.random() > 0.35) continue;
                const idx = Math.floor(this.random() * lava.mask.length);
                if (!lava.mask[idx]) continue;
                const x = (idx % layout.w) * TILE + this.random() * TILE;
                const y = Math.floor(idx / layout.w) * TILE + this.random() * TILE;
                this.emit({ x, y, vx: (this.random() - 0.5) * 14, vy: -14 - this.random() * 18, life: 0.5 + this.random() * 0.5, kind: 'spark' });
            }
        }
        for (const p of this.particles) {
            p.life -= dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.kind === 'spark' || p.kind === 'sweat') p.vy += 40 * dt;
        }
        this.particles = this.particles.filter((p) => p.life > 0);
    }

    /** The agent under a point in world pixels, the front-most first. */
    agentAt(px: number, py: number): Agent | null {
        const sorted = [...this.agents].sort((a, b) => b.y - a.y);
        for (const a of sorted) {
            const left = a.x + 2 + (a.desk && a.away < 0.5 ? 8 : 0);
            if (px >= left && px < left + 12 && py >= a.y - 4 && py < a.y + 16) return a;
        }
        return null;
    }
}
