import { describe, expect, it } from 'vitest';
import { NOW, node, pod } from '../model/fixtures';
import { loadFromRequests } from '../model/load';
import { readNodes } from '../model/nodes';
import { buildOffice, type Preview } from '../model/office';
import { analyze } from '../model/problems';
import { DEFAULT_SETTINGS } from '../model/settings';
import { World } from './world';

function office(raw: ReturnType<typeof node>[], pods: ReturnType<typeof pod>[] = [], preview?: Preview) {
    const nodes = readNodes(raw, pods);
    return buildOffice(nodes, loadFromRequests(nodes), analyze(raw, pods, [], DEFAULT_SETTINGS, NOW), DEFAULT_SETTINGS, 'test', preview);
}

function run(world: World, seconds: number): void {
    for (let t = 0; t < seconds; t += 0.05) world.step(0.05);
}

describe('World', () => {
    it('sends a cordoned node’s person to the couch', () => {
        const world = new World(office([node('w1', { cordoned: true }), node('w2')]));
        run(world, 20);
        const a = world.agents.find((x) => x.desk?.label === 'w1')!;
        expect(a.spot?.kind).toBe('couch');
        expect(a.state).toBe('linger');
    });

    it('puts a down node’s person to sleep at the desk', () => {
        const world = new World(office([node('w1', { ready: false })]));
        run(world, 5);
        const a = world.agents[0]!;
        expect(a.state).toBe('sleep');
        expect(world.tile(a)).toEqual({ x: a.desk!.seat.x, y: a.desk!.seat.y });
    });

    it('gets idle people up and about', () => {
        const world = new World(office([node('w1'), node('w2'), node('w3'), node('w4')], [], { busy: 0, hazard: null }));
        let moved = 0;
        for (let t = 0; t < 60; t += 0.05) {
            world.step(0.05);
            moved = Math.max(moved, world.agents.filter((a) => a.state !== 'sit').length);
        }
        expect(moved).toBeGreaterThan(0);
    });

    it('keeps people where they are when only the numbers change', () => {
        const world = new World(office([node('w1'), node('w2')]));
        run(world, 3);
        const before = world.agents.map((a) => a.id);
        world.update(office([node('w1'), node('w2')], [], { busy: 1, hazard: null }), 0);
        expect(world.agents.map((a) => a.id)).toEqual(before);
        expect(world.agents[0]!.desk!.activity).toBe(1);
    });

    it('lets intruders in and out', () => {
        const world = new World(office([node('w1')]));
        world.update(world.office, 3);
        expect(world.agents.filter((a) => !a.desk)).toHaveLength(3);
        world.update(world.office, 0);
        expect(world.agents.filter((a) => !a.desk)).toHaveLength(0);
    });
});
