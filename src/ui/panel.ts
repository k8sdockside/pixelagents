// The settings panel: every knob, applied as it is turned. The preview
// sliders at the bottom are not kept -- they are for seeing what a busy or a
// broken cluster looks like without breaking one.

import type { Preview } from '../model/office';
import { parseNamespaces, PEOPLE_PER_NODE, REFRESH_CHOICES, SCALE_CHOICES, type Settings } from '../model/settings';
import { add, button, clear, el } from './dom';

export interface PanelHandlers {
    change(patch: Partial<Settings>): void;
    reset(): void;
    preview(preview: Preview): void;
}

let uid = 0;

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const id = `f${++uid}`;
    control.id = id;
    const wrap = el('div', 'field');
    const lab = el('label', '', label);
    lab.htmlFor = id;
    add(wrap, lab, control, hint ? el('span', 'hint', hint) : null);
    return wrap;
}

function range(label: string, value: number, min: number, max: number, step: number, format: (v: number) => string, onInput: (v: number) => void, hint?: string): HTMLElement {
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const out = el('output', '', format(value));
    input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = format(v);
        onInput(v);
    });
    const wrap = field(label, input, hint);
    wrap.classList.add('range');
    wrap.insertBefore(out, input.nextSibling);
    return wrap;
}

function select<T extends string | number>(label: string, value: T, options: [T, string][], onChange: (v: T) => void, hint?: string): HTMLElement {
    const s = el('select');
    for (const [v, text] of options) {
        const o = el('option', '', text);
        o.value = String(v);
        o.selected = v === value;
        s.appendChild(o);
    }
    s.addEventListener('change', () => {
        const found = options.find(([v]) => String(v) === s.value);
        if (found) onChange(found[0]);
    });
    return field(label, s, hint);
}

function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const wrap = field(label, input, hint);
    wrap.classList.add('toggle');
    return wrap;
}

function group(title: string, ...fields: HTMLElement[]): HTMLElement {
    const g = el('fieldset', 'group');
    add(g, el('legend', '', title), ...fields);
    return g;
}

const percent = (v: number): string => `${Math.round(v * 100)}%`;
const times = (v: number): string => (v === 0 ? 'off' : `×${v.toFixed(1)}`);

export function renderPanel(root: HTMLElement, settings: Settings, preview: Preview, on: PanelHandlers): void {
    clear(root);
    const s = settings;
    let p: Preview = { ...preview };

    const officeGroup = group(
        'Office',
        select(
            'Size',
            s.officeSize,
            [['auto', 'Grows with the cluster'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']],
            (v) => on.change({ officeSize: v }),
            'Bigger offices get wider aisles, a meeting table, a bigger lounge, and a server rack for every four nodes.',
        ),
        select('People per node', s.peoplePerNode, PEOPLE_PER_NODE.map((v) => [v, v < 1 ? `one per ${1 / v} nodes` : `${v}`]), (v) => on.change({ peoplePerNode: v })),
        range('Most people', s.maxPeople, 4, 200, 1, String, (v) => on.change({ maxPeople: v }), 'Past this, one person stands for several nodes.'),
    );
    const busyGroup = group(
        'Busyness',
        range('Busyness', s.busyness, 0, 3, 0.1, times, (v) => on.change({ busyness: v }), 'Multiplies every node’s load: turn it up for a livelier office.'),
        range('CPU counts for', s.cpuWeight, 0, 100, 5, String, (v) => on.change({ cpuWeight: v })),
        range('Memory counts for', s.memoryWeight, 0, 100, 5, String, (v) => on.change({ memoryWeight: v })),
        range('Disk counts for', s.diskWeight, 0, 100, 5, String, (v) => on.change({ diskWeight: v })),
    );
    const namespaces = el('input');
    namespaces.type = 'text';
    namespaces.value = s.ignoreNamespaces.join(', ');
    namespaces.spellcheck = false;
    namespaces.addEventListener('change', () => on.change({ ignoreNamespaces: parseNamespaces(namespaces.value) }));
    const troubleGroup = group(
        'Trouble',
        range('Sensitivity', s.hazardSensitivity, 0, 3, 0.1, times, (v) => on.change({ hazardSensitivity: v }), 'How quickly problems show: litter first, then cracks. Off keeps the floor spotless.'),
        toggle('Security checks', s.securityChecks, (v) => on.change({ securityChecks: v }), 'Privileged pods, host access, root, unpinned images. They add to the trouble and let intruders in.'),
        toggle('Warning events', s.warningEvents, (v) => on.change({ warningEvents: v })),
        field('Skip for security', namespaces, 'Namespaces whose pods the security checks leave alone, comma-separated.'),
    );
    const lavaGroup = group(
        'Lava',
        toggle('Lava when it gets really bad', s.lava, (v) => on.change({ lava: v }), 'Off, the floor only ever cracks.'),
        range('Starts at', s.lavaStart, 0.3, 1, 0.05, percent, (v) => on.change({ lavaStart: v }), 'The trouble level where the floor gives way. Below it: litter and cracks.'),
        range('Most of the floor', s.lavaMax, 0.05, 0.8, 0.05, percent, (v) => on.change({ lavaMax: v }), 'How much lava there is at 100% trouble.'),
        select('What rises', s.hazardStyle, [['lava', 'Lava'], ['flood', 'Flood water'], ['slime', 'Toxic slime']], (v) => on.change({ hazardStyle: v })),
    );
    const lookGroup = group(
        'Look',
        select('Floor', s.floor, [['wood', 'Wood'], ['carpet', 'Carpet'], ['tiles', 'Tiles'], ['concrete', 'Concrete']], (v) => on.change({ floor: v })),
        select('Time of day', s.dayNight, [['auto', 'Follow the clock'], ['day', 'Always day'], ['night', 'Always night']], (v) => on.change({ dayNight: v })),
        select('Zoom', s.scale, SCALE_CHOICES.map((v) => [v, v === 0 ? 'Fit' : `${v}×`]), (v) => on.change({ scale: v })),
        range('Speed', s.speed, 0.25, 3, 0.25, (v) => `×${v}`, (v) => on.change({ speed: v })),
        toggle('Names under desks', s.names, (v) => on.change({ names: v })),
        toggle('Intruders', s.intruders, (v) => on.change({ intruders: v })),
        toggle('Boxes for unscheduled pods', s.inbox, (v) => on.change({ inbox: v })),
        select('Refresh every', s.refresh, REFRESH_CHOICES.map((v) => [v, `${v} s`]), (v) => on.change({ refresh: v })),
    );

    const previewRange = (label: string, key: keyof Preview): HTMLElement => {
        const wrap = el('div', 'preview-row');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = p[key] !== null;
        const slider = el('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '1';
        slider.step = '0.01';
        slider.value = String(p[key] ?? 0.5);
        slider.disabled = !box.checked;
        const out = el('output', '', box.checked ? percent(Number(slider.value)) : 'live');
        const push = (): void => {
            p = { ...p, [key]: box.checked ? Number(slider.value) : null };
            slider.disabled = !box.checked;
            out.textContent = box.checked ? percent(Number(slider.value)) : 'live';
            on.preview(p);
        };
        box.addEventListener('change', push);
        slider.addEventListener('input', push);
        const lab = el('label', '');
        add(lab, box, el('span', '', label));
        add(wrap, lab, slider, out);
        return wrap;
    };
    const previewGroup = group('Preview (not saved)', previewRange('Force busyness', 'busy'), previewRange('Force trouble', 'hazard'));

    const actions = el('div', 'panel-actions');
    add(
        actions,
        button('Reset to defaults', 'secondary', 'undo', () => on.reset()),
    );

    add(root, officeGroup, busyGroup, troubleGroup, lavaGroup, lookGroup, previewGroup, actions);
}
