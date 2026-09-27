import { describe, expect, it } from 'vitest';
import { node, pod } from './fixtures';
import { readNodes } from './nodes';

describe('readNodes', () => {
    it('puts control planes first and tells who can take work', () => {
        const nodes = readNodes([node('w1'), node('cp1', { controlPlane: true, taint: true }), node('solo', { controlPlane: true })], []);
        expect(nodes.map((n) => [n.name, n.role, n.schedulable])).toEqual([
            ['cp1', 'control-plane', false],
            ['solo', 'control-plane', true],
            ['w1', 'worker', true],
        ]);
    });

    it('adds up what the running pods on each node ask for', () => {
        const [n] = readNodes([node('w1')], [pod('a', { node: 'w1', cpu: '250m' }), pod('b', { node: 'w1', cpu: '1' }), pod('done', { node: 'w1', phase: 'Succeeded' })]);
        expect(n!.pods).toBe(2);
        expect(n!.cpuRequested).toBeCloseTo(1.25);
        expect(n!.cpuAllocatable).toBe(4);
    });

    it('reads readiness, cordons and pressure', () => {
        const [n] = readNodes([node('w1', { ready: false, cordoned: true, pressure: 'DiskPressure' })], []);
        expect(n).toMatchObject({ ready: false, cordoned: true, schedulable: false, pressure: ['DiskPressure'] });
    });
});
