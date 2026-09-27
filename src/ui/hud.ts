// Everything around the office that is words: the meters above it, the
// tooltip over a person, and the list of what is wrong below it.

import type { NodeInfo } from '../model/nodes';
import type { Office } from '../model/office';
import type { Settings } from '../model/settings';
import { busyWords, hazardWords, type Category, type Finding, type Report } from '../model/problems';
import { add, button, chip, clear, el, icon, linkButton, type ChipTone } from './dom';
import type { IconName } from './icons';
import { banner, sdk } from './page';
import type { Agent } from './world';

function pct(v: number): string {
    return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—';
}

function bar(label: string, value: number, title: string): HTMLElement {
    const row = el('div', 'bar');
    const track = el('span', 'track');
    const fill = el('span', 'fill');
    const known = Number.isFinite(value);
    fill.style.width = known ? `${Math.round(value * 100)}%` : '0';
    fill.classList.add(!known ? 'none' : value > 0.85 ? 'hot' : value > 0.6 ? 'warm' : 'ok');
    track.appendChild(fill);
    add(row, el('span', 'bar-label', label), track, el('span', 'bar-value', pct(value)));
    row.title = title;
    return row;
}

function meter(iconName: IconName, heading: string, big: string, words: string, ...rest: (Node | null)[]): HTMLElement {
    const card = el('div', 'meter');
    add(card, add(el('div', 'meter-head'), icon(iconName), el('span', '', heading)), add(el('div', 'meter-big'), el('strong', '', big), el('span', 'meter-words', words)), ...rest);
    return card;
}

export interface Meters {
    office: Office;
    settings: Settings;
    nodes: NodeInfo[];
    report: Report;
    where: string[];
    note: string;
    preview: boolean;
}

export function renderMeters(root: HTMLElement, m: Meters): void {
    clear(root);
    const { office, nodes, report } = m;
    const managers = nodes.filter((n) => n.role === 'control-plane').length;
    const down = nodes.filter((n) => !n.ready).length;
    const people = office.desks.length;

    const staffLine = el('div', 'meter-line');
    add(staffLine, `${managers} control plane${managers === 1 ? '' : 's'} · ${nodes.length - managers} worker${nodes.length - managers === 1 ? '' : 's'}`);
    const staffChips = el('div', 'chips');
    if (!managers) add(staffChips, chip('managed control plane', 'info', 'info', 'No control-plane nodes are visible: the provider runs them, drawn as a cloud in the glass room.'));
    if (down) add(staffChips, chip(`${down} node${down === 1 ? '' : 's'} down`, 'error', 'alert'));
    const cordoned = nodes.filter((n) => n.cordoned).length;
    if (cordoned) add(staffChips, chip(`${cordoned} cordoned`, 'warn'));
    const perPerson = people && nodes.length > people ? `each person stands for ~${Math.round(nodes.length / people)} nodes` : '';

    const counts = { error: 0, warning: 0, security: 0 };
    for (const f of report.findings) counts[f.category] += f.hits.length;
    const floorChips = el('div', 'chips');
    add(
        floorChips,
        chip(`${counts.error} errors`, counts.error ? 'error' : 'muted', 'alert'),
        chip(`${counts.security} security`, counts.security ? 'warn' : 'muted', 'security'),
        chip(`${counts.warning} warnings`, counts.warning ? 'info' : 'muted', 'warning'),
    );

    const source = el('div', 'meter-line faint');
    source.textContent = m.where.length ? `from ${m.where.join(', then ')}` : 'estimated from pod requests: no metrics found';
    if (m.note) source.title = m.note;

    add(
        root,
        meter('users', 'Staff', `${people}`, people === 1 ? 'person' : 'people', staffLine, perPerson ? el('div', 'meter-line faint', perPerson) : null, staffChips),
        meter(
            'gauge',
            'Busyness',
            pct(office.busy),
            busyWords(office.busy),
            bar('CPU', office.cpu, 'Mean across nodes'),
            bar('Memory', office.memory, 'Mean across nodes'),
            bar('Disk', office.disk, 'Mean across nodes; unknown without node-exporter'),
            source,
        ),
        meter('flame', 'Trouble', pct(office.hazard), hazardWords(office.hazard, m.settings), floorChips, lavaLine(office, m.settings), office.unscheduled ? el('div', 'meter-line', `${office.unscheduled} pod${office.unscheduled === 1 ? '' : 's'} waiting for a node (boxes by the door)`) : null),
    );
    if (m.preview) root.appendChild(el('div', 'preview-note', 'Preview on: the sliders in the settings are overriding what the cluster says.'));
}

/** Where the lava line is, and whether the office has crossed it. */
function lavaLine(office: Office, settings: Settings): HTMLElement {
    if (!settings.lava) return el('div', 'meter-line faint', 'Lava is off: the floor only cracks.');
    if (office.lava.count) return el('div', 'meter-line lava', `Past ${pct(settings.lavaStart)}: the floor has given way.`);
    return el('div', 'meter-line faint', `Litter, then cracks; lava only past ${pct(settings.lavaStart)}.`);
}

// ----- the tooltip -------------------------------------------------------------------------

const MOOD_WORDS = { ok: 'at work', trouble: 'has problems', down: 'node is down -- asleep at the desk', cordoned: 'cordoned -- on a long break' } as const;

export function renderTip(tip: HTMLElement, agent: Agent, security: number): void {
    clear(tip);
    const desk = agent.desk;
    if (!desk) {
        add(tip, el('strong', '', 'An intruder'), el('div', 'faint', `Here because of the security findings (${pct(security)} of the way to a full break-in). Fix them and they leave.`));
        return;
    }
    const nodes = desk.person.nodes;
    add(
        tip,
        el('strong', '', desk.label),
        el('div', 'faint', `${desk.role === 'control-plane' ? 'Control plane' : 'Worker'} · ${MOOD_WORDS[desk.mood]}`),
        bar('CPU', desk.load.cpu.value, desk.load.cpu.source),
        bar('Memory', desk.load.memory.value, desk.load.memory.source),
        bar('Disk', desk.load.disk.value, desk.load.disk.source),
        el('div', 'tip-line', `Busyness ${pct(desk.activity)} · ${desk.pods} pod${desk.pods === 1 ? '' : 's'}`),
        nodes.length > 1 ? el('div', 'faint', nodes.slice(0, 6).join(', ') + (nodes.length > 6 ? ` and ${nodes.length - 6} more` : '')) : null,
        el('div', 'faint', nodes.length === 1 ? 'Click to open the node' : 'Click to open the first node'),
    );
}

// ----- what is wrong ------------------------------------------------------------------------

const CATEGORY: Record<Category, { title: string; icon: IconName; tone: ChipTone }> = {
    error: { title: 'Errors', icon: 'alert', tone: 'error' },
    security: { title: 'Security', icon: 'security', tone: 'warn' },
    warning: { title: 'Warnings', icon: 'warning', tone: 'info' },
};

const SHOWN = 40;

/** Which findings are open, kept across refreshes. */
const open = new Set<string>();

function renderFinding(f: Finding): HTMLElement {
    const details = el('details', 'finding');
    details.open = open.has(f.id);
    details.addEventListener('toggle', () => (details.open ? open.add(f.id) : open.delete(f.id)));
    const summary = el('summary', '');
    add(summary, icon('chevron', 'caret'), el('span', 'finding-label', f.label), chip(String(f.hits.length), CATEGORY[f.category].tone), el('span', 'finding-why', f.why));
    const list = el('ul', 'hits');
    for (const h of f.hits.slice(0, SHOWN)) {
        const item = el('li', '');
        const name = h.namespace ? `${h.namespace}/${h.name}` : h.name;
        add(
            item,
            linkButton(name, () => sdk.open({ kind: h.kind, namespace: h.namespace, name: h.name }).catch(banner.show), `Open ${name}`),
            el('span', 'hit-detail', h.detail),
            h.node && h.kind !== 'nodes' ? el('span', 'hit-node', `on ${h.node}`) : null,
        );
        list.appendChild(item);
    }
    if (f.hits.length > SHOWN) list.appendChild(el('li', 'faint', `and ${f.hits.length - SHOWN} more`));
    add(details, summary, list);
    return details;
}

export function renderFindings(root: HTMLElement, report: Report, securityOn: boolean): void {
    clear(root);
    if (!report.findings.length) {
        add(root, add(el('div', 'all-clear'), icon('check'), el('span', '', 'Nothing wrong that the office can see. The floor holds.')));
        return;
    }
    for (const category of ['error', 'security', 'warning'] as Category[]) {
        const findings = report.findings.filter((f) => f.category === category);
        if (!findings.length) continue;
        const c = CATEGORY[category];
        const group = el('section', 'group');
        add(group, add(el('h2', ''), icon(c.icon), el('span', '', c.title)));
        if (category === 'security' && !securityOn) group.appendChild(el('p', 'faint', 'Security checks are off in the settings, so these do not heat the floor.'));
        for (const f of findings) group.appendChild(renderFinding(f));
        root.appendChild(group);
    }
}

export function renderFoot(root: HTMLElement, ctx: K8sDockside.Context): void {
    clear(root);
    const links = ctx.plugin?.links ?? [];
    add(root, el('span', 'faint', 'Inspired by Pixel Agents.'));
    for (const l of links) root.appendChild(button(l.label, 'link', 'link', () => void sdk.openUrl(l.url)));
}
