import { describe, expect, it } from 'vitest';
import { NOW, node, pod, warning } from './fixtures';
import { analyze, hazard, unpinned } from './problems';
import { DEFAULT_SETTINGS } from './settings';

const ids = (r: ReturnType<typeof analyze>) => r.findings.map((f) => f.id).sort();

describe('analyze', () => {
    it('finds nothing wrong with a healthy cluster', () => {
        const r = analyze([node('w1')], [pod('a', { node: 'w1', runAsNonRoot: true, limit: '1Gi' })], [], DEFAULT_SETTINGS, NOW);
        expect(r.findings).toEqual([]);
        expect(hazard(r, DEFAULT_SETTINGS)).toBe(0);
    });

    it('finds broken pods and nodes, and puts them on their node', () => {
        const r = analyze(
            [node('w1', { ready: false }), node('w2', { pressure: 'MemoryPressure' })],
            [
                pod('loop', { node: 'w2', waiting: 'CrashLoopBackOff', restarts: 9, runAsNonRoot: true, limit: '1Gi' }),
                pod('pull', { node: 'w2', waiting: 'ImagePullBackOff', runAsNonRoot: true, limit: '1Gi' }),
                pod('stuck', { phase: 'Pending', runAsNonRoot: true, limit: '1Gi' }),
                pod('oom', { node: 'w2', oom: true, runAsNonRoot: true, limit: '1Gi' }),
            ],
            [],
            DEFAULT_SETTINGS,
            NOW,
        );
        expect(ids(r)).toEqual(['crashloop', 'image-pull', 'node-not-ready', 'node-pressure', 'oom-killed', 'pending']);
        expect(r.unscheduled).toBe(1);
        expect(r.byNode.get('w2')).toBeGreaterThan(0);
        expect(r.findings[0]!.category).toBe('error');
    });

    it('does not call a young pending pod stuck', () => {
        const r = analyze([], [pod('new', { phase: 'Pending', created: new Date(NOW - 60_000).toISOString(), runAsNonRoot: true, limit: '1Gi' })], [], DEFAULT_SETTINGS, NOW);
        expect(ids(r)).toEqual([]);
        expect(r.unscheduled).toBe(1);
    });

    it('finds security problems, but not in the namespaces it is told to skip', () => {
        const pods = [pod('p', { privileged: true, hostNetwork: true, image: 'busybox' }), pod('sys', { namespace: 'kube-system', privileged: true })];
        const r = analyze([], pods, [], DEFAULT_SETTINGS, NOW);
        expect(ids(r)).toEqual(['host-namespaces', 'latest-tag', 'no-memory-limit', 'privileged', 'run-as-root']);
        expect(r.findings.find((f) => f.id === 'privileged')!.hits.map((h) => h.name)).toEqual(['p']);
        const off = analyze([], pods, [], { ...DEFAULT_SETTINGS, securityChecks: false }, NOW);
        expect(ids(off)).toEqual(['no-memory-limit']);
    });

    it('counts warning events from the last hour only', () => {
        const events = [warning('e1', 'BackOff', { kind: 'Pod', name: 'a' }), warning('e2', 'Old', { kind: 'Pod', name: 'b' }, '2026-09-27T09:00:00Z')];
        const r = analyze([], [], events, DEFAULT_SETTINGS, NOW);
        expect(r.findings.find((f) => f.id === 'warning-events')?.hits.map((h) => h.detail)).toEqual(['BackOff']);
        expect(analyze([], [], events, { ...DEFAULT_SETTINGS, warningEvents: false }, NOW).findings).toEqual([]);
    });
});

describe('hazard', () => {
    it('grows with what is wrong and with the sensitivity, and never passes 1', () => {
        const few = analyze([], [pod('a', { waiting: 'CrashLoopBackOff', runAsNonRoot: true, limit: '1Gi' })], [], DEFAULT_SETTINGS, NOW);
        const many = analyze([], Array.from({ length: 40 }, (_, i) => pod(`p${i}`, { waiting: 'CrashLoopBackOff', runAsNonRoot: true, limit: '1Gi' })), [], DEFAULT_SETTINGS, NOW);
        const a = hazard(few, DEFAULT_SETTINGS);
        const b = hazard(many, DEFAULT_SETTINGS);
        expect(a).toBeGreaterThan(0);
        expect(b).toBeGreaterThan(a);
        expect(b).toBeLessThan(1);
        expect(hazard(few, { ...DEFAULT_SETTINGS, hazardSensitivity: 3 })).toBeGreaterThan(a);
        expect(hazard(few, { ...DEFAULT_SETTINGS, hazardSensitivity: 0 })).toBe(0);
    });
});

describe('unpinned', () => {
    it('knows a floating tag from a pinned one', () => {
        expect(unpinned('nginx')).toBe(true);
        expect(unpinned('nginx:latest')).toBe(true);
        expect(unpinned('registry:5000/app')).toBe(true);
        expect(unpinned('registry:5000/app:1.2')).toBe(false);
        expect(unpinned('nginx@sha256:abc')).toBe(false);
    });
});
