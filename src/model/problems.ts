// What is wrong in the cluster, and how hot it makes the floor.
//
// Three piles: errors (things broken now), warnings (things that will be, or
// were), and security (things that let a bad day become a worse one). Every
// finding names the objects it is about, and the node when there is one, so
// the lava can start under the right desk.

import { time, type KubeEvent, type Node, type Pod, type Container } from './kube';
import { isReady } from './nodes';
import type { Settings } from './settings';

export type Category = 'error' | 'warning' | 'security';

export interface Hit {
    /** A kind the plugin declares, so the page can open it: `pods`, `nodes` or `events`. */
    kind: string;
    namespace: string;
    name: string;
    /** The node it is on, when it is on one. */
    node: string;
    /** A word or two more: the container, the reason, the count. */
    detail: string;
}

export interface Finding {
    id: string;
    category: Category;
    label: string;
    why: string;
    /** How much one hit heats the floor. */
    weight: number;
    hits: Hit[];
}

export interface Report {
    findings: Finding[];
    /** 0-1: how much of the floor gives way, before the sensitivity setting. */
    heat: { error: number; warning: number; security: number };
    /** Heat per node name, for placing the first hot spots. */
    byNode: Map<string, number>;
    /** Pods no node has taken. */
    unscheduled: number;
}

interface Check {
    id: string;
    category: Category;
    label: string;
    why: string;
    weight: number;
}

const CHECKS = {
    nodeNotReady: { id: 'node-not-ready', category: 'error', label: 'Node not ready', why: 'The kubelet is not reporting, or reports it cannot run pods. Its pods are not being looked after.', weight: 8 },
    nodePressure: { id: 'node-pressure', category: 'error', label: 'Node under pressure', why: 'The node is short of memory, disk or process ids, or has no network, and will start evicting pods.', weight: 4 },
    crashLoop: { id: 'crashloop', category: 'error', label: 'Crash looping', why: 'A container keeps exiting and the kubelet keeps backing off before starting it again.', weight: 3 },
    imagePull: { id: 'image-pull', category: 'error', label: 'Image cannot be pulled', why: 'The image name, tag or registry credentials are wrong, or the registry is unreachable.', weight: 2 },
    containerConfig: { id: 'container-config', category: 'error', label: 'Container cannot start', why: 'A ConfigMap, Secret or setting the container needs is missing or wrong.', weight: 2 },
    pending: { id: 'pending', category: 'error', label: 'Stuck pending', why: 'Pending for more than five minutes: no node fits it, or its volume or image is not ready.', weight: 2 },
    oomKilled: { id: 'oom-killed', category: 'error', label: 'Killed for memory', why: 'A container went over its memory limit and was killed. It is too small, or it leaks.', weight: 1.5 },
    notReady: { id: 'pod-not-ready', category: 'warning', label: 'Running but not ready', why: 'The pod runs but has failed its readiness probe for five minutes; it gets no traffic.', weight: 1 },
    failed: { id: 'pod-failed', category: 'warning', label: 'Failed pod left behind', why: 'A failed pod that is not a Job’s -- evicted, most often. It holds nothing, but says something went wrong.', weight: 0.5 },
    restarts: { id: 'restarts', category: 'warning', label: 'Restarting often', why: 'Five restarts or more. Running now, but it has fallen over before.', weight: 0.4 },
    cordoned: { id: 'cordoned', category: 'warning', label: 'Node cordoned', why: 'Taken out of scheduling by hand. Fine for maintenance; easy to forget.', weight: 0.5 },
    noMemoryLimit: { id: 'no-memory-limit', category: 'warning', label: 'No memory limit', why: 'A container with no memory limit can take the node’s memory from everything else on it.', weight: 0.1 },
    events: { id: 'warning-events', category: 'warning', label: 'Warning events', why: 'What the cluster has complained about in the last hour.', weight: 0.15 },
    privileged: { id: 'privileged', category: 'security', label: 'Privileged container', why: 'A privileged container is root on the node: a way out of the container for anything that gets in.', weight: 2 },
    hostNamespaces: { id: 'host-namespaces', category: 'security', label: 'Shares the host’s namespaces', why: 'hostNetwork, hostPID or hostIPC: the pod sees the node’s network, processes or shared memory.', weight: 1.5 },
    capabilities: { id: 'capabilities', category: 'security', label: 'Dangerous capabilities', why: 'SYS_ADMIN, NET_ADMIN, SYS_PTRACE or ALL added: most of root, handed out one piece at a time.', weight: 1 },
    hostPath: { id: 'host-path', category: 'security', label: 'Mounts a host path', why: 'A hostPath volume reaches into the node’s own files.', weight: 1 },
    runAsRoot: { id: 'run-as-root', category: 'security', label: 'May run as root', why: 'Neither runAsNonRoot nor a non-zero runAsUser is set, so the image decides -- and many run as root.', weight: 0.25 },
    latestTag: { id: 'latest-tag', category: 'security', label: 'Unpinned image', why: 'The image is :latest or has no tag, so what runs can change under you on the next pull.', weight: 0.3 },
} as const satisfies Record<string, Check>;

const PENDING_GRACE = 5 * 60_000;
const EVENT_WINDOW = 60 * 60_000;
const DANGEROUS_CAPS = ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'ALL'];

/** Whether an image reference floats: `nginx`, `nginx:latest`, `reg:5000/app` -- but not one pinned by digest. */
export function unpinned(image: string | undefined): boolean {
    if (!image || image.includes('@sha256:')) return false;
    const last = image.slice(image.lastIndexOf('/') + 1);
    const colon = last.indexOf(':');
    return colon < 0 || last.slice(colon + 1) === 'latest';
}

function mayRunAsRoot(pod: Pod, c: Container): boolean {
    const nonRoot = c.securityContext?.runAsNonRoot ?? pod.spec?.securityContext?.runAsNonRoot;
    const user = c.securityContext?.runAsUser ?? pod.spec?.securityContext?.runAsUser;
    if (user === 0) return true;
    return nonRoot !== true && user === undefined;
}

function ownedByJob(pod: Pod): boolean {
    return (pod.metadata.ownerReferences ?? []).some((o) => o.kind === 'Job');
}

export function analyze(
    nodes: Node[],
    pods: Pod[],
    events: KubeEvent[],
    settings: Pick<Settings, 'securityChecks' | 'warningEvents' | 'ignoreNamespaces'>,
    now: number,
): Report {
    const found = new Map<string, Finding>();
    const hit = (check: Check, h: Hit): void => {
        let f = found.get(check.id);
        if (!f) {
            f = { ...check, hits: [] };
            found.set(check.id, f);
        }
        f.hits.push(h);
    };
    const ignored = new Set(settings.ignoreNamespaces);

    for (const node of nodes) {
        const name = node.metadata.name;
        const ref = { kind: 'nodes', namespace: '', name, node: name };
        if (!isReady(node)) hit(CHECKS.nodeNotReady, { ...ref, detail: 'NotReady' });
        for (const c of node.status?.conditions ?? []) {
            if (['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'].includes(c.type) && c.status === 'True') {
                hit(CHECKS.nodePressure, { ...ref, detail: c.type });
            }
        }
        if (node.spec?.unschedulable) hit(CHECKS.cordoned, { ...ref, detail: 'cordoned' });
    }

    let unscheduled = 0;
    const podNode = new Map<string, string>();
    for (const pod of pods) {
        const namespace = pod.metadata.namespace ?? '';
        const name = pod.metadata.name;
        const node = pod.spec?.nodeName ?? '';
        podNode.set(`${namespace}/${name}`, node);
        const ref = { kind: 'pods', namespace, name, node };
        const phase = pod.status?.phase;
        const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];

        if (phase === 'Pending' && !node) unscheduled++;
        if (phase === 'Pending' && now - time(pod.metadata.creationTimestamp) > PENDING_GRACE) {
            hit(CHECKS.pending, { ...ref, detail: node ? 'not started' : 'not scheduled' });
        }
        if (phase === 'Failed' && !ownedByJob(pod)) hit(CHECKS.failed, { ...ref, detail: pod.status?.reason ?? 'Failed' });

        let looping = false;
        for (const s of statuses) {
            const waiting = s.state?.waiting?.reason ?? '';
            if (waiting === 'CrashLoopBackOff') {
                looping = true;
                hit(CHECKS.crashLoop, { ...ref, detail: `${s.name}, ${s.restartCount ?? 0} restarts` });
            } else if (['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'ErrImageNeverPull'].includes(waiting)) {
                hit(CHECKS.imagePull, { ...ref, detail: `${s.name}: ${waiting}` });
            } else if (['CreateContainerConfigError', 'CreateContainerError', 'RunContainerError'].includes(waiting)) {
                hit(CHECKS.containerConfig, { ...ref, detail: `${s.name}: ${waiting}` });
            }
            if (s.state?.terminated?.reason === 'OOMKilled' || s.lastState?.terminated?.reason === 'OOMKilled') {
                hit(CHECKS.oomKilled, { ...ref, detail: s.name });
            }
            if (!looping && (s.restartCount ?? 0) >= 5 && s.state?.running) {
                hit(CHECKS.restarts, { ...ref, detail: `${s.name}, ${s.restartCount} restarts` });
            }
        }
        if (phase === 'Running' && !looping) {
            const ready = pod.status?.conditions?.find((c) => c.type === 'Ready');
            if (ready?.status === 'False' && now - time(ready.lastTransitionTime) > PENDING_GRACE) hit(CHECKS.notReady, { ...ref, detail: 'not ready' });
        }

        if (ignored.has(namespace) || phase === 'Succeeded' || phase === 'Failed') continue;
        const containers = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
        for (const c of pod.spec?.containers ?? []) {
            if (!c.resources?.limits?.memory) hit(CHECKS.noMemoryLimit, { ...ref, detail: c.name });
        }
        if (!settings.securityChecks) continue;
        const host = [pod.spec?.hostNetwork && 'network', pod.spec?.hostPID && 'PID', pod.spec?.hostIPC && 'IPC'].filter(Boolean);
        if (host.length) hit(CHECKS.hostNamespaces, { ...ref, detail: 'host ' + host.join(', ') });
        const paths = (pod.spec?.volumes ?? []).filter((v) => v.hostPath).map((v) => v.hostPath?.path ?? v.name);
        if (paths.length) hit(CHECKS.hostPath, { ...ref, detail: paths.join(', ') });
        for (const c of containers) {
            if (c.securityContext?.privileged) hit(CHECKS.privileged, { ...ref, detail: c.name });
            const caps = (c.securityContext?.capabilities?.add ?? []).filter((cap) => DANGEROUS_CAPS.includes(cap.replace(/^CAP_/, '')));
            if (caps.length) hit(CHECKS.capabilities, { ...ref, detail: `${c.name}: ${caps.join(', ')}` });
            if (mayRunAsRoot(pod, c)) hit(CHECKS.runAsRoot, { ...ref, detail: c.name });
            if (unpinned(c.image)) hit(CHECKS.latestTag, { ...ref, detail: c.image ?? '' });
        }
    }

    if (settings.warningEvents) {
        for (const e of events) {
            if (e.type !== 'Warning') continue;
            const when = time(e.series?.lastObservedTime) || time(e.lastTimestamp) || time(e.eventTime) || time(e.metadata.creationTimestamp);
            if (now - when > EVENT_WINDOW) continue;
            const io = e.involvedObject ?? {};
            const namespace = io.namespace ?? e.metadata.namespace ?? '';
            const count = e.series?.count ?? e.count ?? 1;
            const detail = `${e.reason ?? 'Warning'}${count > 1 ? ` ×${count}` : ''}`;
            if (io.kind === 'Pod' && io.name) {
                hit(CHECKS.events, { kind: 'pods', namespace, name: io.name, node: podNode.get(`${namespace}/${io.name}`) ?? '', detail });
            } else if (io.kind === 'Node' && io.name) {
                hit(CHECKS.events, { kind: 'nodes', namespace: '', name: io.name, node: io.name, detail });
            } else {
                const what = io.kind && io.name ? `${io.kind} ${io.name}: ` : '';
                hit(CHECKS.events, { kind: 'events', namespace: e.metadata.namespace ?? '', name: e.metadata.name, node: '', detail: what + detail });
            }
        }
    }

    const findings = [...found.values()].sort((a, b) => order(a.category) - order(b.category) || score(b) - score(a));
    const heat = { error: 0, warning: 0, security: 0 };
    const byNode = new Map<string, number>();
    for (const f of findings) {
        heat[f.category] += score(f);
        for (const h of f.hits) if (h.node) byNode.set(h.node, (byNode.get(h.node) ?? 0) + f.weight);
    }
    return { findings, heat, byNode, unscheduled };
}

function order(c: Category): number {
    return c === 'error' ? 0 : c === 'security' ? 1 : 2;
}

/** A finding's heat: its weight for every hit, with a crowd counting for less than its size -- 200 pods running as root is not 200 fires. */
export function score(f: Finding): number {
    return f.weight * Math.pow(f.hits.length, 0.75);
}

/**
 * How much trouble the office is in, 0-1: litter first, then cracks, and lava
 * only past the lava setting's start. Errors count in full, security at
 * seven tenths, warnings at half; the sensitivity setting multiplies the lot.
 */
export function hazard(report: Report, settings: Pick<Settings, 'hazardSensitivity' | 'securityChecks'>): number {
    const h = report.heat;
    const raw = h.error + 0.5 * h.warning + (settings.securityChecks ? 0.7 * h.security : 0);
    return 1 - Math.exp((-raw * settings.hazardSensitivity) / 25);
}

/** How the office is doing, in words: the same stages the floor goes through. */
export function hazardWords(level: number, settings: Pick<Settings, 'lava' | 'lavaStart'>): string {
    if (level < 0.03) return 'Spotless';
    if (level < 0.3) return 'A bit of a mess';
    if (!settings.lava || level < settings.lavaStart) return level < 0.5 ? 'Cracks in the floor' : 'Falling apart';
    return 'The floor is lava';
}

export function busyWords(level: number): string {
    if (level < 0.1) return 'Quiet day';
    if (level < 0.35) return 'Ticking over';
    if (level < 0.6) return 'Busy';
    if (level < 0.8) return 'Heads down';
    return 'Everybody sprinting';
}
