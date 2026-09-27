// The office: the cluster as a pixel-art office floor. One person a node --
// control planes in the glass room, workers on the open floor -- as busy as
// their node's CPU, memory and disk. Trouble shows on the floor as litter,
// then cracks, and -- only when it gets really bad -- lava.

import type { LoadMap } from '../model/load';
import { readNodes, type NodeInfo } from '../model/nodes';
import { buildOffice, type Office, type Preview } from '../model/office';
import { analyze, type Report } from '../model/problems';
import { sanitize, type Settings } from '../model/settings';
import { byId, button, clear } from '../ui/dom';
import { renderFindings, renderFoot, renderMeters, renderTip } from '../ui/hud';
import { loadLoads, loadSnapshot } from '../ui/load';
import { banner, every, loadSettings, message, saveSettings, sdk } from '../ui/page';
import { renderPanel } from '../ui/panel';
import { Renderer } from '../ui/render';
import { World, type Agent } from '../ui/world';

interface Reading {
    nodes: NodeInfo[];
    loads: LoadMap;
    report: Report;
    where: string[];
    note: string;
}

let ctx: K8sDockside.Context;
let settings: Settings;
let preview: Preview = { busy: null, hazard: null };
let reading: Reading | null = null;
let office: Office | null = null;
let world: World | null = null;
let paused = false;
let hover: Agent | null = null;
let scale = 2;

const stage = byId('stage');
const canvas = byId<HTMLCanvasElement>('office');
const tip = byId('tip');
const renderer = new Renderer(canvas);

/** How many intruders the security findings let in: none for none, up to six. */
function intruders(o: Office): number {
    if (!settings.intruders || o.security <= 0) return 0;
    return Math.max(1, Math.min(6, Math.round(o.security * 6)));
}

/** Everything drawn from the last reading, again: after a poll, or a setting changed. */
function rebuild(): void {
    if (!reading) return;
    const report = reading.report;
    office = buildOffice(reading.nodes, reading.loads, report, settings, ctx.contextId || 'cluster', preview);
    if (!settings.inbox) office.unscheduled = 0;
    if (!world) world = new World(office);
    world.update(office, intruders(office));

    renderMeters(byId('meters'), {
        office,
        settings,
        nodes: reading.nodes,
        report,
        where: reading.where,
        note: reading.note,
        preview: preview.busy !== null || preview.hazard !== null,
    });
    renderFindings(byId('findings'), report, settings.securityChecks);
    canvas.setAttribute(
        'aria-label',
        `An office of ${office.desks.length} people for ${reading.nodes.length} nodes, ${Math.round(office.busy * 100)}% busy, ${Math.round(office.hazard * 100)}% in trouble${office.lava.count ? ', and the floor is lava' : ''}.`,
    );
    byId('loading').hidden = true;
}

/** One read of the cluster. */
async function poll(): Promise<void> {
    const snap = await loadSnapshot();
    const nodesProblem = snap.missing.get('nodes');
    if (nodesProblem) throw new Error(`Cannot read the cluster’s nodes: ${nodesProblem}`);
    const nodes = readNodes(snap.nodes, snap.pods);
    const { loads, where, note } = await loadLoads(nodes);
    const report = analyze(snap.nodes, snap.pods, snap.events, settings, Date.now());
    reading = { nodes, loads, report, where, note };
    // Pods or events missing is survivable, but worth saying.
    const partial = [...snap.missing.entries()].map(([k, why]) => `${k}: ${why}`);
    if (partial.length) banner.show(`Some of the cluster could not be read, so the office is missing it -- ${partial.join('; ')}`);
    else banner.clear();
    rebuild();
}

/**
 * Page pixels per world pixel: the zoom setting, or what fits the page's
 * width (and most of its height). Whole numbers keep every pixel the same
 * size, so they are used from 3x up; below that, quarter steps, so a big
 * office fills the page rather than dropping to a postage stamp at 1x.
 */
function fitScale(): number {
    if (!office) return scale;
    const size = renderer.size(office.layout);
    if (settings.scale > 0) return settings.scale;
    const width = stage.clientWidth - 2;
    const height = Math.max(320, window.innerHeight * 0.9);
    const fit = Math.min(width / size.w, height / size.h);
    if (fit >= 3) return Math.floor(fit);
    return Math.max(0.5, Math.floor(fit * 4) / 4);
}

let last = performance.now();
function frame(now: number): void {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (world && office) {
        if (!paused) world.step(dt * settings.speed);
        scale = fitScale();
        renderer.draw(world, settings, { scale, hover });
    }
    requestAnimationFrame(frame);
}

function pointer(event: MouseEvent): Agent | null {
    if (!world) return null;
    const r = canvas.getBoundingClientRect();
    return world.agentAt((event.clientX - r.left) / scale, (event.clientY - r.top) / scale);
}

function wirePointer(): void {
    canvas.addEventListener('mousemove', (event) => {
        hover = pointer(event);
        canvas.style.cursor = hover ? 'pointer' : 'default';
        if (!hover || !office) {
            tip.hidden = true;
            return;
        }
        renderTip(tip, hover, office.security);
        tip.hidden = false;
        const s = stage.getBoundingClientRect();
        const x = event.clientX - s.left + stage.scrollLeft + 14;
        const y = event.clientY - s.top + stage.scrollTop + 14;
        tip.style.left = `${Math.min(x, stage.scrollLeft + stage.clientWidth - tip.offsetWidth - 8)}px`;
        tip.style.top = `${y}px`;
    });
    canvas.addEventListener('mouseleave', () => {
        hover = null;
        tip.hidden = true;
    });
    canvas.addEventListener('click', (event) => {
        const agent = pointer(event);
        if (!agent) return;
        if (agent.desk) {
            const name = agent.desk.person.nodes[0];
            if (name) sdk.open({ kind: 'nodes', name }).catch(banner.show);
        } else {
            byId('findings').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
}

function wireTools(refresh: () => void): void {
    const tools = byId('tools');
    clear(tools);
    const makePause = (): HTMLButtonElement => {
        const b = button(paused ? 'Play' : 'Pause', 'secondary', paused ? 'play' : 'pause', () => {
            paused = !paused;
            b.replaceWith(makePause());
        });
        return b;
    };
    const panel = byId('settings');
    const openPanel = (): void => {
        renderPanel(panel, settings, preview, {
            change(patch) {
                const refreshChanged = patch.refresh !== undefined && patch.refresh !== settings.refresh;
                const readsChanged = patch.securityChecks !== undefined || patch.warningEvents !== undefined || patch.ignoreNamespaces !== undefined;
                settings = sanitize({ ...settings, ...patch });
                saveSettings(settings);
                // What the checks find depends on these, so the cluster is read again.
                if (readsChanged || refreshChanged) refresh();
                else rebuild();
            },
            reset() {
                settings = sanitize(null);
                saveSettings(settings);
                openPanel();
                refresh();
            },
            preview(p) {
                preview = p;
                rebuild();
            },
        });
    };
    const gear = button('Settings', 'secondary', 'settings', () => {
        panel.hidden = !panel.hidden;
        gear.classList.toggle('on', !panel.hidden);
        if (!panel.hidden) openPanel();
    });
    tools.append(makePause(), gear);
}

async function main(): Promise<void> {
    ctx = await sdk.ready();
    settings = await loadSettings();
    byId('title').textContent = ctx.contextName ? `${ctx.contextName}` : 'The office';
    renderFoot(byId('foot'), ctx);
    wirePointer();
    const refresh = every(
        () => settings.refresh * 1000,
        poll,
        (err) => {
            banner.show(err);
            if (!reading) byId('loading').textContent = `The office could not open: ${message(err)}`;
        },
    );
    wireTools(refresh);
    requestAnimationFrame(frame);
}

main().catch(banner.show);
