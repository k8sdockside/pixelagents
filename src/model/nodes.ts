// The nodes as the office sees them: who is a control plane, who can take
// work, who is up, and how much has been asked of each.

import type { Node, Pod } from './kube';
import { parseQuantity } from './quantity';

export type Role = 'control-plane' | 'worker';

export interface NodeInfo {
    name: string;
    role: Role;
    /** Whether pods can be scheduled here: not cordoned, and no NoSchedule taint. */
    schedulable: boolean;
    /** `kubectl cordon`: taken out of scheduling by hand. */
    cordoned: boolean;
    ready: boolean;
    /** Conditions that are True and should not be: MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable. */
    pressure: string[];
    /** Every address the node has, to match a metrics series by. */
    addresses: string[];
    /** Pods on it that have not finished. */
    pods: number;
    /** Cores and bytes it offers to pods. NaN when it does not say. */
    cpuAllocatable: number;
    memoryAllocatable: number;
    /** Cores and bytes its pods ask for. */
    cpuRequested: number;
    memoryRequested: number;
}

const CONTROL_PLANE_LABELS = ['node-role.kubernetes.io/control-plane', 'node-role.kubernetes.io/master'];
const PRESSURES = ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'];

export function isControlPlane(node: Node): boolean {
    const labels = node.metadata.labels ?? {};
    if (CONTROL_PLANE_LABELS.some((l) => l in labels)) return true;
    if (labels['node-role.kubernetes.io/controlplane'] === 'true') return true; // RKE
    return (node.spec?.taints ?? []).some((t) => CONTROL_PLANE_LABELS.includes(t.key));
}

export function isReady(node: Node): boolean {
    return (node.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
}

/** Whether a pod still holds a place on its node. */
export function isActivePod(pod: Pod): boolean {
    const phase = pod.status?.phase;
    return phase !== 'Succeeded' && phase !== 'Failed';
}

function requested(pod: Pod, resource: 'cpu' | 'memory'): number {
    let total = 0;
    for (const c of pod.spec?.containers ?? []) {
        const v = parseQuantity(c.resources?.requests?.[resource]);
        if (Number.isFinite(v)) total += v;
    }
    return total;
}

export function readNodes(nodes: Node[], pods: Pod[]): NodeInfo[] {
    const byNode = new Map<string, { pods: number; cpu: number; memory: number }>();
    for (const pod of pods) {
        const name = pod.spec?.nodeName;
        if (!name || !isActivePod(pod)) continue;
        const entry = byNode.get(name) ?? { pods: 0, cpu: 0, memory: 0 };
        entry.pods++;
        entry.cpu += requested(pod, 'cpu');
        entry.memory += requested(pod, 'memory');
        byNode.set(name, entry);
    }

    return nodes
        .map((node): NodeInfo => {
            const name = node.metadata.name;
            const cordoned = node.spec?.unschedulable === true;
            const noSchedule = (node.spec?.taints ?? []).some((t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute');
            const load = byNode.get(name) ?? { pods: 0, cpu: 0, memory: 0 };
            return {
                name,
                role: isControlPlane(node) ? 'control-plane' : 'worker',
                schedulable: !cordoned && !noSchedule,
                cordoned,
                ready: isReady(node),
                pressure: (node.status?.conditions ?? []).filter((c) => PRESSURES.includes(c.type) && c.status === 'True').map((c) => c.type),
                addresses: [name, ...(node.status?.addresses ?? []).map((a) => a.address)],
                pods: load.pods,
                cpuAllocatable: parseQuantity(node.status?.allocatable?.cpu),
                memoryAllocatable: parseQuantity(node.status?.allocatable?.memory),
                cpuRequested: load.cpu,
                memoryRequested: load.memory,
            };
        })
        .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'control-plane' ? -1 : 1));
}
