import type { Page } from '@playwright/test';
import { VIEW_APPLY_MS_PER_SECOND } from '@src/lib/in-sandbox-view';

/**
 * The one measure of what the host page's thread has left (backlog T7, T9): ticks of a 10 ms interval on the host page.
 * Every spec under test/e2e and docs/research that counts host ticks, a busy share or the host page's longest stall
 * goes through this module; test/unit/host-share.test.ts scans their sources and fails on a meter of their own.
 *
 * The busy share is measured against the page's own idle baseline (docs/API.md, "The view's cost to the host page").
 * Relative, so the machine's speed does not matter: the idle baseline is the best of IDLE_WINDOWS windows on the same
 * page right before the flood, and the loaded figure the best of LOADED_WINDOWS windows once the flood is under way (best
 * of N on both sides: a window that another process on the machine took ticks from says nothing about the code). The
 * busy share is 1 − loaded / idle, both per the same length of time. Best of N on the loaded side holds only while the
 * flood lasts over every window. One operation has no share to measure: a spec bounds its stall (startLag, lag).
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
 *     another process (the best of N removes most of that, not all). 10 points. docs/API.md states that the suite
 *     asserts the bound plus this margin.
 */
export const TIME_SHARE = VIEW_APPLY_MS_PER_SECOND / 1000;
export const LOAD_SHARE = 0.2;
export const MARGIN = 0.1;

/** What a view flood may take, as the suite asserts it (docs/API.md): the bound of (a) for its kind, plus MARGIN. */
export const viewBound = (loads: boolean) => TIME_SHARE + (loads ? LOAD_SHARE : 0) + MARGIN;

export interface Window { count: number; longest: number; frames: number }

/**
 * One window of `ms`: the ticks, the longest gap between two of them (ms), and with `frames` the host page's animation
 * frames. `execute` is guest code the window starts with (the element's execute(), called right after the interval
 * starts), for a spec that measures what one operation costs while it runs.
 */
export const ticks = (page: Page, ms: number, options: { frames?: boolean; execute?: string } = {}) => page.evaluate(({ duration, frames: countFrames, execute }) => new Promise<Window>(resolve => {
    let count = 0;
    let longest = 0;
    let frames = 0;
    let running = true;
    let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; count++; }, 10);
    if (countFrames) {
        const frame = () => { if (!running) return; frames++; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
    }
    if (execute !== undefined) (document.querySelector('web-sandbox') as any).execute(execute);
    setTimeout(() => { running = false; clearInterval(timer); resolve({ count, longest: Math.round(longest), frames }); }, duration);
}), { duration: ms, frames: !!options.frames, execute: options.execute });

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
    return { count, mean: sum / windows, longest, ms };
}
export type Best = Awaited<ReturnType<typeof best>>;

/** The busy share of `count` ticks over `ms`, against `baseline` (an idle best, or the ideal: `ms / 10` ticks per window). */
export const busyOf = (count: number, ms: number, baseline: { count: number; ms: number }) => 1 - count / (baseline.count * (ms / baseline.ms));

/** The idle baseline: the best of IDLE_WINDOWS windows of IDLE_MS, on the page as it is now. */
export const idleBaseline = (page: Page) => best(page, IDLE_WINDOWS, IDLE_MS);

/** The loaded windows (LOADED_WINDOWS of LOADED_MS unless `loaded` names others), against `idle`. */
export async function loadedShare(page: Page, idle: Best, loaded = { windows: LOADED_WINDOWS, ms: LOADED_MS }) {
    const flood = await best(page, loaded.windows, loaded.ms);
    return { idle, loaded: flood, busy: busyOf(flood.count, loaded.ms, idle), meanBusy: busyOf(flood.mean, loaded.ms, idle) };
}

/**
 * The idle baseline, then `start()` (which starts the flood), `warmup` ms (WARMUP_MS by default), and the loaded windows
 * (LOADED_WINDOWS of LOADED_MS unless `loaded` names others: a flood whose cost comes in periods needs windows of whole
 * periods): the busy share of the best window (`busy`), of their mean (`meanBusy`), and the figures behind them.
 */
export async function busyShare(page: Page, start: () => Promise<unknown>, loaded = { windows: LOADED_WINDOWS, ms: LOADED_MS }, warmup = WARMUP_MS) {
    const idle = await idleBaseline(page);
    await start();
    if (warmup > 0) await page.waitForTimeout(warmup);
    return loadedShare(page, idle, loaded);
}

/** One line for a MEASURED log: the figures of a busyShare() or loadedShare() result. */
export const describeShare = (share: Awaited<ReturnType<typeof loadedShare>>) =>
    `host ticks: idle ${share.idle.count} per ${share.idle.ms} ms (best of ${IDLE_WINDOWS}), loaded ${share.loaded.count} per ${share.loaded.ms} ms (best window; longest gap ${share.loaded.longest} ms): ${Math.round(share.busy * 100)}% busy (mean of the windows ${Math.round(share.meanBusy * 100)}%)`;

/**
 * The host page's longest stall from now on: a 10 ms interval that keeps the largest gap past its 10 ms between two of
 * its ticks, until lag() reads it (and startLag() starts it again). With `recordOver`, every gap longer than that many
 * ms is also kept for stalls(): where it ended (performance.now()) and how long it was. For a spec that bounds a
 * stall, not a share.
 */
export const startLag = (page: Page, options: { recordOver?: number } = {}) => page.evaluate((recordOver) => {
    const w = window as any;
    clearInterval(w.__hostLagTimer);
    w.__hostLag = { max: 0, last: performance.now(), stalls: [] as { end: number; ms: number }[] };
    w.__hostLagTimer = setInterval(() => {
        const now = performance.now();
        const gap = now - w.__hostLag.last;
        w.__hostLag.max = Math.max(w.__hostLag.max, gap - 10);
        if (recordOver !== null && gap > recordOver) w.__hostLag.stalls.push({ end: Math.round(now), ms: Math.round(gap) });
        w.__hostLag.last = now;
    }, 10);
}, options.recordOver ?? null);
export const lag = (page: Page) => page.evaluate(() => Math.round((window as any).__hostLag.max) as number);
export const stalls = (page: Page) => page.evaluate(() => [...(window as any).__hostLag.stalls] as { end: number; ms: number }[]);
export const stopLag = (page: Page) => page.evaluate(() => clearInterval((window as any).__hostLagTimer));

/**
 * What applying `html` costs on this engine and machine now, measured as the view measures one operation (the
 * replacement, its layout forced, and the rendering update after it), in a page of its own (ms). A calibration taken in
 * the same run as what it calibrates, so a bound on one operation holds relative to what an operation costs here, under
 * the load the machine has now, not on the machine the bound was written on.
 */
export const operationCost = async (page: Page, html: string) => {
    const other = await page.context().newPage();
    try {
        await other.setContent('<!DOCTYPE html><html><head></head><body><div id="a"></div></body></html>');
        return await other.evaluate(async (markup) => {
            const a = document.getElementById('a')!;
            const start = performance.now();
            a.innerHTML = markup;
            document.elementFromPoint(0, 0);
            const flushed = performance.now() - start;
            await new Promise(resolve => requestAnimationFrame(() => resolve(0)));
            const frame = performance.now();
            await new Promise(resolve => setTimeout(resolve, 0));
            return Math.round(flushed + performance.now() - frame);
        }, html);
    } finally {
        await other.close();
    }
};

/**
 * The longest stall the host page may show while the view applies `html` one render at a time ("the host's largest
 * stall is one apply"): APPLY_FACTOR times the most that `samples` calibrations of it took (operationCost), plus the
 * machine's own longest gap right then (quietStall), plus STALL_MARGIN (a tick, and the scheduling of the measure).
 * The view does more per apply than the bare replacement (the renderer's walk over every element, the move into its
 * document): measured 1.0–3.8 times it. Three times it is about one apply, and far from the many applies a lost flow
 * control would stack. Calibrated in the same run, before and after what it bounds, so the machine's load raises the
 * bound with the stall it measures: under load, one apply's stall grows with the load, past any number fixed per engine
 * (T9). Idle, these bounds are at or under such numbers.
 */
export const APPLY_FACTOR = 3;
export const STALL_MARGIN = 100;
export async function oneApplyStall(page: Page, html: string, samples = 3) {
    const costs: number[] = [];
    for (let i = 0; i < samples; i++) costs.push(await operationCost(page, html));
    const quiet = await quietStall(page, 1000);
    return { costs, quiet, bound: APPLY_FACTOR * Math.max(...costs) + quiet + STALL_MARGIN };
}

/**
 * The busy share with each loaded window between two idle baselines, taken right before and right after it with the
 * flood paused (`pause()`, then `settle` ms, SETTLE_MS by default, for what is in flight), and the share of a window
 * taken against the mean of the two. A baseline taken once, before the flood, is taken at another time than the windows
 * it is compared with, and the machine's other load varies between them (T9). Interleaved, the baseline of each window
 * brackets it in time. `resume()` starts the flood again (the first
 * time, starts it). The busy share is that of the best window; a flood that can be paused and resumed uses this.
 */
export const SETTLE_MS = 1000;
export async function interleavedShare(page: Page, flood: { resume: () => Promise<unknown>; pause: () => Promise<unknown> },
    loaded = { windows: LOADED_WINDOWS, ms: LOADED_MS }, warmup = WARMUP_MS, settle = SETTLE_MS) {
    const first = await idleBaseline(page);
    let before = first;
    const shares: number[] = [];
    let bestWindow: Window | null = null;
    let bestShare = Infinity;
    let longest = 0;
    let sum = 0;
    for (let i = 0; i < loaded.windows; i++) {
        await flood.resume();
        await page.waitForTimeout(warmup);
        const window = await ticks(page, loaded.ms);
        await flood.pause();
        await page.waitForTimeout(settle);
        const after = await idleBaseline(page);
        const share = busyOf(window.count, loaded.ms, { count: (before.count + after.count) / 2, ms: IDLE_MS });
        shares.push(share);
        sum += window.count;
        longest = Math.max(longest, window.longest);
        if (share < bestShare) { bestShare = share; bestWindow = window; }
        before = after;
    }
    return {
        idle: first,
        loaded: { count: bestWindow!.count, mean: sum / loaded.windows, longest, ms: loaded.ms },
        busy: bestShare,
        meanBusy: shares.reduce((a, b) => a + b, 0) / shares.length,
        shares,
    };
}

/**
 * The host page's longest gap between two ticks over `ms` with nothing of the code under test running (ms): the stall the
 * machine causes now. A spec that bounds a stall which the code should not cause at all ("the host is not blocked")
 * bounds it as this plus what the code may add, so that a loaded machine's own stalls are not read as the code's.
 */
export const quietStall = async (page: Page, ms = 1500) => (await ticks(page, ms)).longest;

/**
 * Guest code for a flood on every timer turn that interleavedShare() can pause and resume: `setup` runs once, then
 * `flood()` runs `tick` on every turn until `globalThis.stop` is set, for at most `budgetMs` of running in all (a flood
 * that grows memory stays bounded). `flood()` again resumes it.
 */
export const pausableFlood = (setup: string, tick: string, budgetMs = Infinity) => `
    ${setup}
    let left = ${Number.isFinite(budgetMs) ? budgetMs : 'Infinity'};
    globalThis.flood = () => {
        globalThis.stop = false;
        const started = performance.now();
        const timer = setInterval(() => {
            if (globalThis.stop || performance.now() - started > left) { clearInterval(timer); left -= performance.now() - started; return; }
            (${tick})();
        }, 0);
    };`;

/**
 * How interleavedShare() pauses and resumes a pausableFlood() in the guest. A sandbox that a flood ended takes no more
 * code; that is not an error of the measure.
 */
export const floodControl = (sandbox: { run(code: string): Promise<unknown> }, source: string) => {
    let started = false;
    return {
        resume: () => sandbox.run(started ? 'flood()' : (started = true, `${source}\nflood();`)).catch(() => {}),
        pause: () => sandbox.run('globalThis.stop = true').catch(() => {}),
    };
};
