// The fields of Kubernetes objects the office reads, and nothing more.
//
// The bridge hands objects back whole, as the API server wrote them; these
// describe only what is used. Everything is optional: a half-created object,
// an older or newer cluster, or a kind that could not be read at all must
// never take the page down.

export type KubeObject = K8sDockside.KubeObject;

export interface ResourceList {
    cpu?: string;
    memory?: string;
    [name: string]: string | undefined;
}

export interface Taint {
    key: string;
    value?: string;
    effect: string;
}

export interface NodeCondition {
    type: string;
    status: string;
    reason?: string;
    message?: string;
}

export interface NodeAddress {
    type: string;
    address: string;
}

export interface Node extends KubeObject {
    spec?: { unschedulable?: boolean; taints?: Taint[] };
    status?: {
        allocatable?: ResourceList;
        capacity?: ResourceList;
        conditions?: NodeCondition[];
        addresses?: NodeAddress[];
    };
}

export interface SecurityContext {
    privileged?: boolean;
    runAsNonRoot?: boolean;
    runAsUser?: number;
    allowPrivilegeEscalation?: boolean;
    capabilities?: { add?: string[] };
}

export interface Container {
    name: string;
    image?: string;
    resources?: { requests?: ResourceList; limits?: ResourceList };
    securityContext?: SecurityContext;
}

export interface Volume {
    name: string;
    hostPath?: { path?: string };
}

export interface PodSpec {
    nodeName?: string;
    containers?: Container[];
    initContainers?: Container[];
    hostNetwork?: boolean;
    hostPID?: boolean;
    hostIPC?: boolean;
    securityContext?: { runAsNonRoot?: boolean; runAsUser?: number };
    volumes?: Volume[];
}

export interface ContainerState {
    waiting?: { reason?: string; message?: string };
    running?: { startedAt?: string };
    terminated?: { reason?: string; exitCode?: number; finishedAt?: string };
}

export interface ContainerStatus {
    name: string;
    ready?: boolean;
    restartCount?: number;
    state?: ContainerState;
    lastState?: ContainerState;
}

export interface Pod extends KubeObject {
    spec?: PodSpec;
    status?: {
        phase?: string;
        reason?: string;
        startTime?: string;
        conditions?: { type: string; status: string; lastTransitionTime?: string }[];
        containerStatuses?: ContainerStatus[];
        initContainerStatuses?: ContainerStatus[];
    };
}

export interface KubeEvent extends KubeObject {
    type?: string;
    reason?: string;
    message?: string;
    count?: number;
    lastTimestamp?: string;
    eventTime?: string;
    involvedObject?: { kind?: string; namespace?: string; name?: string };
    series?: { count?: number; lastObservedTime?: string };
}

export interface NodeMetrics extends KubeObject {
    usage?: ResourceList;
}

/** Milliseconds since the epoch, or 0 when the text is not a time. */
export function time(text: string | undefined): number {
    const t = Date.parse(text ?? '');
    return Number.isFinite(t) ? t : 0;
}
