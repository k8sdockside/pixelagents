// Small builders for the tests: objects with only the fields that matter.

import type { KubeEvent, Node, Pod } from './kube';

export const NOW = Date.parse('2026-09-27T12:00:00Z');
export const LONG_AGO = '2026-09-27T10:00:00Z';

export function node(name: string, opts: { controlPlane?: boolean; ready?: boolean; cordoned?: boolean; taint?: boolean; pressure?: string; cpu?: string; memory?: string; ip?: string } = {}): Node {
    const conditions = [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }];
    if (opts.pressure) conditions.push({ type: opts.pressure, status: 'True' });
    return {
        metadata: { name, labels: opts.controlPlane ? { 'node-role.kubernetes.io/control-plane': '' } : {} },
        spec: {
            unschedulable: opts.cordoned,
            taints: opts.taint ? [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] : [],
        },
        status: {
            allocatable: { cpu: opts.cpu ?? '4', memory: opts.memory ?? '8Gi' },
            conditions,
            addresses: [{ type: 'InternalIP', address: opts.ip ?? '10.0.0.1' }],
        },
    };
}

export function pod(name: string, opts: Partial<{ namespace: string; node: string; phase: string; waiting: string; restarts: number; image: string; privileged: boolean; runAsNonRoot: boolean; hostNetwork: boolean; cpu: string; memory: string; limit: string; created: string; oom: boolean }> = {}): Pod {
    return {
        metadata: { name, namespace: opts.namespace ?? 'default', creationTimestamp: opts.created ?? LONG_AGO },
        spec: {
            nodeName: opts.node,
            hostNetwork: opts.hostNetwork,
            securityContext: opts.runAsNonRoot ? { runAsNonRoot: true } : undefined,
            containers: [
                {
                    name: 'app',
                    image: opts.image ?? 'nginx:1.27',
                    resources: { requests: { cpu: opts.cpu ?? '500m', memory: opts.memory ?? '1Gi' }, limits: opts.limit ? { memory: opts.limit } : {} },
                    securityContext: opts.privileged ? { privileged: true } : undefined,
                },
            ],
        },
        status: {
            phase: opts.phase ?? 'Running',
            containerStatuses: [
                {
                    name: 'app',
                    restartCount: opts.restarts ?? 0,
                    state: opts.waiting ? { waiting: { reason: opts.waiting } } : { running: {} },
                    lastState: opts.oom ? { terminated: { reason: 'OOMKilled' } } : {},
                },
            ],
        },
    };
}

export function warning(name: string, reason: string, on: { kind: string; name: string; namespace?: string }, when = '2026-09-27T11:50:00Z'): KubeEvent {
    return {
        metadata: { name, namespace: on.namespace ?? 'default' },
        type: 'Warning',
        reason,
        lastTimestamp: when,
        involvedObject: on,
    };
}
