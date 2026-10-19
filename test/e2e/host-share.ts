import type { Page } from '@playwright/test';
import { VIEW_APPLY_MS_PER_SECOND } from '@src/lib/in-sandbox-view';

/**
 * The host page's busy share under a flood, measured against its own idle baseline (docs/API.md, "The view's cost to
 * the host page"): ticks of a 10 ms interval on the host page. Relative, so the machine's speed does not matter: the idle
 * baseline is the best of IDLE_WINDOWS windows on the same page right before the flood, and the loaded figure the best of
 * LOADED_WINDOWS windows once the flood is under way (best of N on both sides: a window that another process on the
 * machine took ticks from says nothing about the view). The busy share is 1 − loaded / idle. Used by
 * test/e2e/view-bound.spec.ts (the bound, every canonical flood) and test/e2e/review-round-4.spec.ts (M-2).
 *
 * WEB_SANDBOX_SOAK=1 measures over windows four times as long, with more of them.
 */

export const SOAK = !!process.env.WEB_SANDBOX_SOAK;
export const IDLE_WINDOWS = SOAK ? 5 : 3;
export const IDLE_MS = SOAK ? 4000 : 1000;
export const LOADED_WINDOWS = SOAK ? 4 : 2;
export const LOADED_MS = SOAK ? 10000 : 2500;
export const WARMUP_MS = 1000;

/**
 * The long-run bound (a), as fractions of the host page's idle ticks (docs/API.md, the statement's (a)):
 *   - TIME_SHARE: what the view's time budget lets it spend, VIEW_APPLY_MS_PER_SECOND of every 1000 ms;
 *   - LOAD_SHARE: what the browser does with the loads VIEW_URLS_PER_SECOND admits, which the meter cannot see: about
 *     1 ms of the host page's thread per new admitted image at most (research 16: one render of 4 000 kept Chromium 52%
 *     and Firefox 46% busy over the 8 s after it), so at 200 loads a second at most 20 points. Only for floods that load;
 *   - MARGIN: the measure's own error. A 10 ms interval loses a tick for every slot a task straddles, so a stream of short
 *     tasks reads up to one tick per task more than the time they took; the time budget itself measured 15–23% under a
 *     flood against its 20% (research 16, the gap meter); and the machine is shared, so a window can lose ticks to
 *     another process (the best of N removes most of that, not all). 10 points.
 */
export const TIME_SHARE = VIEW_APPLY_MS_PER_SECOND / 1000;
export const LOAD_SHARE = 0.2;
export const MARGIN = 0.1;

export const ticks = (page: Page, ms: number) => page.evaluate((duration) => new Promise<{ count: number; longest: number }>(resolve => {
    let count = 0;
    let longest = 0;
    let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; count++; }, 10);
    setTimeout(() => { clearInterval(timer); resolve({ count, longest: Math.round(longest) }); }, duration);
}), ms);

// The best of `windows` windows (most ticks), the mean, and the longest gap of any.
export async function best(page: Page, windows: number, ms: number) {
    let count = 0;
    let sum = 0;
    let longest = 0;
    for (let i = 0; i < windows; i++) {
        const window = await ticks(page, ms);
        count = Math.max(count, window.count);
        sum += window.count;
        longest = Math.max(longest, window.longest);
    }
    return { count, mean: sum / windows, longest };
}

/**
 * The idle baseline, then `start()` (which starts the flood), WARMUP_MS, and the loaded windows (LOADED_WINDOWS of
 * LOADED_MS unless `loaded` names others: a flood whose cost comes in periods needs windows of whole periods): the busy
 * share of the best window (`busy`), of their mean (`meanBusy`), and the figures behind them.
 */
export async function busyShare(page: Page, start: () => Promise<unknown>, loaded = { windows: LOADED_WINDOWS, ms: LOADED_MS }) {
    const idle = await best(page, IDLE_WINDOWS, IDLE_MS);
    await start();
    await page.waitForTimeout(WARMUP_MS);
    const flood = await best(page, loaded.windows, loaded.ms);
    const idleTicks = idle.count * (loaded.ms / IDLE_MS);
    return { idle, loaded: flood, busy: 1 - flood.count / idleTicks, meanBusy: 1 - flood.mean / idleTicks };
}
