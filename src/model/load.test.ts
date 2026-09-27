import { describe, expect, it } from 'vitest';
import { node } from './fixtures';
import { activity, instanceHost, loadFromCharts, loadFromNodeMetrics, loadFromRequests, mergeLoads, nodeForSeries, unknownLoad } from './load';
import { readNodes } from './nodes';
import { DEFAULT_SETTINGS } from './settings';

const nodes = readNodes([node('alpha', { ip: '10.0.0.5' }), node('beta.example.com', { ip: '10.0.0.6' })], []);

function panel(charts: Partial<K8sDockside.Chart>[], available = true): K8sDockside.ChartsPanel {
    return {
        attached: true,
        range: 5,
        source: { available, error: '', configured: '', describe: 'monitoring/prometheus:9090', endpoint: { namespace: '', service: '', port: '', path: '', url: '', source: '' } },
        charts: charts.map((c) => ({ pluginId: 'p', pluginName: 'p', id: '', label: '', unit: 'percent', description: '', series: [], error: '', ...c })),
    };
}

describe('matching a series to a node', () => {
    it('strips the port from an instance, IPv6 too', () => {
        expect(instanceHost('10.0.0.5:9100')).toBe('10.0.0.5');
        expect(instanceHost('[fd00::1]:9100')).toBe('fd00::1');
        expect(instanceHost('alpha')).toBe('alpha');
    });

    it('matches by node name, then by address, then by short host name', () => {
        expect(nodeForSeries('alpha|10.9.9.9:9100', nodes)?.name).toBe('alpha');
        expect(nodeForSeries('ip-10-0-0-6|10.0.0.6:9100', nodes)?.name).toBe('beta.example.com');
        expect(nodeForSeries('beta|', nodes)?.name).toBe('beta.example.com');
        expect(nodeForSeries('gamma|10.1.1.1:9100', nodes)).toBeUndefined();
    });
});

describe('loads', () => {
    it('reads the latest point of each chart', () => {
        const out = loadFromCharts(
            panel([
                { id: 'node-cpu', series: [{ name: 'alpha|10.0.0.5:9100', points: [{ t: 1, v: 0.2 }, { t: 2, v: 0.4 }] }] },
                { id: 'node-disk', series: [{ name: 'alpha|10.0.0.5:9100', points: [{ t: 1, v: 0.9 }] }] },
            ]),
            nodes,
        );
        expect(out.loads.get('alpha')?.cpu).toEqual({ value: 0.4, source: 'prometheus' });
        expect(out.loads.get('alpha')?.disk.value).toBe(0.9);
        expect(out.where).toContain('node-exporter');
    });

    it('says why when there is no Prometheus', () => {
        const out = loadFromCharts(panel([], false), nodes);
        expect(out.loads.size).toBe(0);
        expect(out.note).toMatch(/no Prometheus/);
    });

    it('turns metrics-server usage into a share of what the node offers', () => {
        const loads = loadFromNodeMetrics([{ metadata: { name: 'alpha' }, usage: { cpu: '2', memory: '4Gi' } }], nodes);
        expect(loads.get('alpha')?.cpu.value).toBeCloseTo(0.5);
        expect(loads.get('alpha')?.memory.value).toBeCloseTo(0.5);
    });

    it('takes each reading from the best source that has it', () => {
        const measured = loadFromNodeMetrics([{ metadata: { name: 'alpha' }, usage: { cpu: '1' } }], nodes);
        const merged = mergeLoads(nodes, [measured, loadFromRequests(nodes)]);
        expect(merged.get('alpha')?.cpu.source).toBe('metrics-server');
        expect(merged.get('alpha')?.memory.source).toBe('requests');
    });
});

describe('activity', () => {
    const load = (cpu: number, memory: number, disk = NaN) => ({
        ...unknownLoad(),
        cpu: { value: cpu, source: 'prometheus' as const },
        memory: { value: memory, source: 'prometheus' as const },
        disk: { value: disk, source: Number.isNaN(disk) ? ('none' as const) : ('prometheus' as const) },
    });

    it('is nothing for an idle node and a lot for a full one', () => {
        expect(activity(load(0, 0), DEFAULT_SETTINGS)).toBe(0);
        expect(activity(load(1, 1, 1), DEFAULT_SETTINGS)).toBe(1);
    });

    it('leans towards the busiest resource', () => {
        const mean = (0.5 * 0.1 + 0.3 * 0.95) / 0.8;
        expect(activity(load(0.1, 0.95), DEFAULT_SETTINGS)).toBeGreaterThan(mean);
    });

    it('follows the weights and the busyness multiplier', () => {
        expect(activity(load(1, 0), { ...DEFAULT_SETTINGS, cpuWeight: 0 })).toBe(0);
        expect(activity(load(0.2, 0.2), { ...DEFAULT_SETTINGS, busyness: 2 })).toBeCloseTo(0.4);
    });
});
