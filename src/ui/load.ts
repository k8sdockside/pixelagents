// Reading the cluster through the bridge.

import type { KubeEvent, Node, NodeMetrics, Pod } from '../model/kube';
import { loadFromCharts, loadFromNodeMetrics, loadFromRequests, mergeLoads, type LoadMap } from '../model/load';
import type { NodeInfo } from '../model/nodes';
import { message, sdk } from './page';

export interface Snapshot {
    nodes: Node[];
    pods: Pod[];
    events: KubeEvent[];
    /** Kinds that could not be read, and why. Nodes missing is fatal; the others are not. */
    missing: Map<string, string>;
}

async function listOr<T extends K8sDockside.KubeObject>(kind: string, missing: Map<string, string>): Promise<T[]> {
    try {
        return await sdk.list<T>({ kind, namespace: '' });
    } catch (err) {
        missing.set(kind, message(err));
        return [];
    }
}

export async function loadSnapshot(): Promise<Snapshot> {
    const missing = new Map<string, string>();
    const [nodes, pods, events] = await Promise.all([
        listOr<Node>('nodes', missing),
        listOr<Pod>('pods', missing),
        listOr<KubeEvent>('events', missing),
    ]);
    return { nodes, pods, events, missing };
}

export interface Loads {
    loads: LoadMap;
    /** Where the readings came from, best first, for a person. */
    where: string[];
    /** Why a better source was not used; '' when the best one was. */
    note: string;
}

/**
 * CPU, memory and disk for every node, from the best source there is. Never
 * rejects -- no monitoring is an ordinary cluster.
 */
export async function loadLoads(nodes: NodeInfo[]): Promise<Loads> {
    const notes: string[] = [];
    const where: string[] = [];
    const sources: LoadMap[] = [];
    let covered = false;

    try {
        const outcome = loadFromCharts(await sdk.charts({ minutes: 5 }), nodes);
        if (outcome.loads.size) {
            sources.push(outcome.loads);
            where.push(outcome.where);
            covered = outcome.loads.size >= nodes.length && !outcome.note;
        }
        if (outcome.note) notes.push(outcome.note);
    } catch (err) {
        notes.push(`could not ask for charts (${message(err)})`);
    }

    if (!covered) {
        try {
            const items = await sdk.list<NodeMetrics>({ kind: 'crd:nodes.metrics.k8s.io', namespace: '' });
            const loads = loadFromNodeMetrics(items, nodes);
            if (loads.size) {
                sources.push(loads);
                where.push('metrics-server');
            }
        } catch (err) {
            notes.push(metricsServerProblem(err));
        }
    }

    // Always last: fills whatever the measured sources left out.
    sources.push(loadFromRequests(nodes));
    const loads = mergeLoads(nodes, sources);
    return { loads, where, note: notes.join('; ') };
}

function metricsServerProblem(err: unknown): string {
    const text = message(err);
    if (/not served|could not find the requested resource|no matches for|not found/i.test(text)) return 'metrics-server is not installed';
    if (/service unavailable|503/i.test(text)) return 'metrics-server is installed but not answering';
    return `metrics-server did not answer (${text})`;
}
