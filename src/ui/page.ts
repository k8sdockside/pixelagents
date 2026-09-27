// What the page does with the bridge: report a failure, poll, and remember
// the user's settings.

import { sanitize, STORAGE_KEY, type Settings } from '../model/settings';
import { byId } from './dom';

/** The bridge. The SDK's <script> runs before the page's own, so it is always there. */
export const sdk: K8sDockside.Bridge = k8sdockside;

/** A failure, as text: the bridge rejects with an Error carrying a sentence. */
export function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** The page's error banner: a `<p id="error" hidden>`. */
export const banner = {
    show(err: unknown): void {
        const node = byId('error');
        node.textContent = message(err);
        node.hidden = false;
    },
    clear(): void {
        byId('error').hidden = true;
    },
};

/**
 * Runs `fn` now and then `ms()` after it settles -- never two at once, so a
 * slow cluster is not asked again before it has answered. `ms` is asked each
 * time, so a change to the refresh setting takes effect on the next round.
 * Returns a function that runs it again straight away.
 */
export function every(ms: () => number, fn: () => Promise<unknown>, onError: (err: unknown) => void = banner.show): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const run = (): void => {
        if (running) return;
        clearTimeout(timer);
        running = true;
        fn()
            .catch(onError)
            .finally(() => {
                running = false;
                timer = setTimeout(run, ms());
            });
    };
    run();
    return run;
}

/** The settings kept for this plugin and cluster, or the defaults. */
export async function loadSettings(): Promise<Settings> {
    try {
        return sanitize(await sdk.storage?.get(STORAGE_KEY));
    } catch {
        return sanitize(null);
    }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Keeps the settings, a moment after the last change: a slider dragged is one write, not fifty. */
export function saveSettings(settings: Settings): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        sdk.storage?.set(STORAGE_KEY, settings).catch(banner.show);
    }, 400);
}
