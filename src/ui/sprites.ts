// The people, drawn a pixel at a time from little maps of letters, and cached
// as canvases -- one per look, direction, pose and frame -- so a frame of the
// office is a few hundred drawImage calls rather than tens of thousands of
// rectangles.
//
// Every person is 12 x 18 pixels, standing on the bottom of a 16-pixel tile
// and poking two pixels into the one above.

import { hash, pick, rng } from '../model/rng';

export const SPRITE_W = 12;
export const SPRITE_H = 18;

export type Dir = 'down' | 'up' | 'left' | 'right';
export type Pose = 'stand' | 'walk' | 'sit-back' | 'type' | 'sit-front' | 'sleep';

export type HairStyle = 'short' | 'long' | 'bun' | 'cap' | 'bald' | 'hood';

export interface Look {
    key: string;
    skin: string;
    hair: string;
    hairStyle: HairStyle;
    shirt: string;
    pants: string;
    shoes: string;
    /** A tie and a jacket: the control planes. */
    suit: boolean;
    /** Eyes that glow: the intruders. */
    eyes: string;
}

const SKIN = ['#f5d0b0', '#e8b894', '#d49a6a', '#b07040', '#8d5524', '#5c3a1e', '#f1c27d', '#ffdcb5'];
const HAIR = ['#2c1b10', '#4a2c18', '#7a4a26', '#b5651d', '#d8b04a', '#e9dcc4', '#1b1b1f', '#a83232', '#5b4bbf', '#2f6f73'];
const SHIRT = ['#4a86ff', '#e0564f', '#46b37a', '#f0a53c', '#9b6cf0', '#2bb3c0', '#f06ca4', '#e6d24a', '#7d8a99', '#ff8a3d', '#3fbf9f', '#c9d6e8'];
const PANTS = ['#2b3a55', '#3b3b46', '#4a3a2a', '#1f2a36', '#50607a', '#2d4a3c'];
const SHOES = ['#1c1c22', '#3a2a1c', '#e8e8ea', '#5a2020'];
const STYLES: HairStyle[] = ['short', 'short', 'long', 'bun', 'cap', 'bald', 'long', 'short'];

/** A person's look, the same every time for the same id. */
export function lookFor(id: string, manager: boolean): Look {
    const r = rng(hash(id));
    const look: Look = {
        key: '',
        skin: pick(SKIN, r),
        hair: pick(HAIR, r),
        hairStyle: pick(STYLES, r),
        shirt: manager ? pick(['#2b2f3a', '#39324a', '#233a4f', '#4a2f2f'], r) : pick(SHIRT, r),
        pants: manager ? '#20242c' : pick(PANTS, r),
        shoes: pick(SHOES, r),
        suit: manager,
        eyes: '#1a1418',
    };
    if (look.hairStyle === 'cap') look.hair = pick(['#e0564f', '#4a86ff', '#46b37a', '#1b1b1f', '#f0a53c'], r);
    look.key = [look.skin, look.hair, look.hairStyle, look.shirt, look.pants, look.shoes, look.suit].join();
    return look;
}

export const INTRUDER: Look = {
    key: 'intruder',
    skin: '#15151c',
    hair: '#23232d',
    hairStyle: 'hood',
    shirt: '#23232d',
    pants: '#18181f',
    shoes: '#0d0d11',
    suit: false,
    eyes: '#7dff9a',
};

// ----- the maps ---------------------------------------------------------------
// h hair, s skin, e eye, c shirt, t tie, w white shirt, m mouth. Legs are
// drawn separately so they can walk.

const HEAD_FRONT = [
    '....hhhh....',
    '...hhhhhh...',
    '..hhhhhhhh..',
    '..hssssssh..',
    '..sesssses..',
    '..ssssssss..',
    '...ssmmss...',
    '....ssss....',
];
const HEAD_BACK = [
    '....hhhh....',
    '...hhhhhh...',
    '..hhhhhhhh..',
    '..hhhhhhhh..',
    '..hhhhhhhh..',
    '..shhhhhhs..',
    '...hhhhhh...',
    '....ssss....',
];
const HEAD_SIDE = [
    '....hhhh....',
    '...hhhhhhh..',
    '..hhhhhhhh..',
    '..hhhhssss..',
    '..hhhsssse..',
    '..hhssssss..',
    '...hsssss...',
    '....sss.....',
];
const BODY_FRONT = ['..cccccccc..', '.cccccccccc.', '.cccccccccc.', '.sccccccccs.', '.s.cccccc.s.', '...cccccc...', '...pppppp...'];
const BODY_BACK = BODY_FRONT;
const BODY_SIDE = ['...cccccc...', '...cccccc...', '...cccccc...', '...ccccsc...', '...ccccs....', '...cccccc...', '...pppppp...'];

interface Ctx2D {
    fillStyle: string | CanvasGradient | CanvasPattern;
    globalAlpha: number;
    fillRect(x: number, y: number, w: number, h: number): void;
}

function paint(g: Ctx2D, rows: string[], top: number, colours: Record<string, string>, mirror = false): void {
    rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
            const colour = colours[row[x]!];
            if (!colour) continue;
            g.fillStyle = colour;
            g.fillRect(mirror ? SPRITE_W - 1 - x : x, top + y, 1, 1);
        }
    });
}

function shade(hex: string, amount: number): string {
    const n = parseInt(hex.slice(1), 16);
    const f = (v: number): number => Math.max(0, Math.min(255, Math.round(v * (1 + amount))));
    const r = f((n >> 16) & 255);
    const gg = f((n >> 8) & 255);
    const b = f(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (gg << 8) | b).toString(16).slice(1);
}

function hairOverlay(g: Ctx2D, look: Look, dir: Dir, top: number): void {
    g.fillStyle = look.hair;
    const px = (x: number, y: number): void => {
        g.fillRect(dir === 'left' ? SPRITE_W - 1 - x : x, top + y, 1, 1);
    };
    switch (look.hairStyle) {
        case 'long':
            for (let y = 3; y < 11; y++) {
                if (dir === 'down') {
                    if (y < 10) px(1, y), px(10, y);
                    if (y < 6) px(2, y), px(9, y);
                } else if (dir === 'up') {
                    if (y >= 5) for (let x = 2; x < 10; x++) px(x, y);
                } else if (y < 10) {
                    px(2, y), px(3, y);
                }
            }
            break;
        case 'bun':
            for (let x = 5; x < 7; x++) px(x, -1), px(x, -2);
            px(4, -1);
            px(7, -1);
            break;
        case 'cap':
            for (let x = 2; x < 10; x++) px(x, 0), px(x, 1), px(x, 2);
            // The peak, towards where they look.
            g.fillStyle = shade(look.hair, -0.35);
            if (dir === 'down') for (let x = 2; x < 10; x++) px(x, 3);
            else if (dir !== 'up') for (let x = 7; x < 12; x++) px(x, 3);
            break;
        case 'hood':
            for (let y = 0; y < 9; y++) px(1, y), px(10, y);
            for (let x = 2; x < 10; x++) px(x, -1);
            break;
        default:
            break;
    }
}

function legs(g: Ctx2D, look: Look, dir: Dir, frame: number, top: number): void {
    // Frames 0 and 2 stand; 1 and 3 each put one foot forward.
    const lift = [0, 1, 0, -1][frame % 4]!;
    const draw = (x: number, dy: number): void => {
        g.fillStyle = look.pants;
        g.fillRect(x, top, 2, 2 - Math.max(0, dy));
        g.fillStyle = look.shoes;
        g.fillRect(x, top + 2 - Math.max(0, dy), 2, 1);
    };
    if (dir === 'left' || dir === 'right') {
        const a = dir === 'right' ? 4 + lift : 6 - lift;
        const b = dir === 'right' ? 6 - lift : 4 + lift;
        draw(Math.min(a, b), 0);
        draw(Math.max(a, b), 0);
        return;
    }
    draw(3, lift > 0 ? 1 : 0);
    draw(7, lift < 0 ? 1 : 0);
}

function colours(look: Look, dir: Dir): Record<string, string> {
    const hairless = look.hairStyle === 'bald' || look.hairStyle === 'cap';
    return {
        h: look.hairStyle === 'bald' ? shade(look.skin, -0.08) : look.hair,
        s: look.skin,
        e: look.eyes,
        m: look.hairStyle === 'hood' ? look.skin : shade(look.skin, -0.25),
        c: look.shirt,
        p: look.pants,
        ...(hairless && dir === 'up' ? { h: look.hairStyle === 'cap' ? look.hair : shade(look.skin, -0.08) } : {}),
    };
}

function suitOverlay(g: Ctx2D, dir: Dir, top: number): void {
    if (dir !== 'down') return;
    g.fillStyle = '#f2f2f2';
    g.fillRect(5, top, 2, 3);
    g.fillStyle = '#d23c3c';
    g.fillRect(5, top + 1, 2, 1);
    g.fillRect(5, top + 2, 2, 3);
}

/** Draws one person into `g` at (0, 0). Frame counts from 0 to 3. */
export function drawPerson(g: Ctx2D, look: Look, dir: Dir, pose: Pose, frame: number): void {
    const mirror = dir === 'left';
    const head = dir === 'down' ? HEAD_FRONT : dir === 'up' ? HEAD_BACK : HEAD_SIDE;
    const body = dir === 'down' ? BODY_FRONT : dir === 'up' ? BODY_BACK : BODY_SIDE;
    const col = colours(look, dir);

    // A walk bobs a pixel on the stepping frames; a sleeper's head is on the desk.
    let bob = pose === 'walk' && frame % 2 === 1 ? 1 : 0;
    if (pose === 'sleep') bob = 3;
    const headTop = 0 + bob;
    const bodyTop = 8 + (pose === 'sleep' ? 1 : bob);

    paint(g, body, bodyTop, col, mirror);
    if (look.suit) suitOverlay(g, dir, bodyTop);
    // Typing: the hands take turns at the keyboard.
    if (pose === 'type') {
        g.fillStyle = look.skin;
        const up = frame % 2 === 0;
        g.fillRect(1, bodyTop + (up ? 2 : 3), 1, 1);
        g.fillRect(10, bodyTop + (up ? 3 : 2), 1, 1);
    }
    paint(g, head, headTop, col, mirror);
    hairOverlay(g, look, dir, headTop);

    if (pose === 'walk' || pose === 'stand') legs(g, look, dir, pose === 'walk' ? frame : 0, 15);
    if (pose === 'sit-front') {
        // Knees towards us: short legs, feet a little apart.
        g.fillStyle = look.pants;
        g.fillRect(3, 15, 6, 1);
        g.fillStyle = look.shoes;
        g.fillRect(3, 16, 2, 1);
        g.fillRect(7, 16, 2, 1);
    }
}

const cache = new Map<string, HTMLCanvasElement>();

/** The cached canvas for a person as they are right now. */
export function personSprite(look: Look, dir: Dir, pose: Pose, frame: number): HTMLCanvasElement {
    const f = pose === 'walk' ? frame % 4 : pose === 'type' ? frame % 2 : 0;
    const key = `${look.key}|${dir}|${pose}|${f}`;
    let canvas = cache.get(key);
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = SPRITE_W;
        canvas.height = SPRITE_H + 2;
        const g = canvas.getContext('2d')!;
        g.translate(0, 2); // room for a bun
        drawPerson(g, look, dir, pose, f);
        cache.set(key, canvas);
    }
    return canvas;
}

/** How far above a sprite's canvas top its drawing starts: the bun's headroom. */
export const SPRITE_PAD = 2;
