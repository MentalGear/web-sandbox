import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handTimedScaling, meterHits, wallClockBounds } from './host-share-scan';

/**
 * Backlog T9: every spec that counts the host page's ticks, the gaps between them, a busy share or a stall goes through
 * test/e2e/host-share.ts, the one measure (best of N windows against the page's own idle baseline, interleaved where the
 * flood can pause; the documented bounds; the stall meter; stall bounds calibrated in the same run). A meter or a fixed
 * bound of a spec's own measured the machine's load as the code's (T7: one window on each side; a stall table per
 * engine), so a new one fails here, by the shapes every old one took (./host-share-scan.ts).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOST_SHARE = 'test/e2e/host-share.ts';

// The only meters outside host-share.ts, and why each cannot go through it.
const OUTSIDE: Record<string, string> = {
    // research 19 measures the host page from inside it, by design also with no Playwright attached (its "standalone"
    // floods), so there is no Page for host-share.ts to measure through
    'docs/research/19_relay_worker/host.html': 'measures from inside the page, with or without Playwright',
    // the relay worker's own ticks (its own busy share), counted inside the relay; and a guest's busy loop
    'docs/research/19_relay_worker/harness.ts': "counts the relay worker's own ticks, inside the worker",
};

function sources(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...sources(file));
        else if (/\.(ts|mjs|js|html)$/.test(entry.name)) found.push(file);
    }
    return found;
}
const FILES = [...sources('test/e2e'), ...sources('docs/research')];
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

// Unit tests that may bound their own wall-clock time by a number, each with the reason it measures the code and not the
// machine. Reviewed; none today.
const WALL_CLOCK_ALLOWED: Record<string, string> = {};

// Unit tests that may keep a scaling measure of their own (a best-of-N of clock differences, a ratio of two timings),
// each with the reason scalingRatio (test/unit/scaling.ts) cannot measure it. Reviewed; none today.
const SCALING_ALLOWED: Record<string, string> = {};

// Samples of the meter shapes this scan forbids, verbatim: one of each, so the scan is shown to catch them.
const OLD_METERS: Record<string, string> = {
    'worker-port-and-view-cost.spec.ts countTicks': `const countTicks = (page: Page, ms: number) => page.evaluate((duration) => new Promise<number>(resolve => {
    let count = 0;
    const timer = setInterval(() => count++, 10);
    setTimeout(() => { clearInterval(timer); resolve(count); }, duration);
}), ms);`,
    'relay-and-rpc-budgets.spec.ts, its limit': `expect(ticks).toBeGreaterThan(idle * 0.8);`,
    'worker-port-and-view-cost.spec.ts M-6, a meter spread over lines': `const gaps = await page.evaluate(() => new Promise<{ ticks: number; longest: number }>(resolve => {
                let ticks = 0;
                let last = performance.now();
                let longest = 0;
                const timer = setInterval(() => {
                    ticks++;
                    const now = performance.now();
                    longest = Math.max(longest, now - last);
                    last = now;
                }, 10);
                setTimeout(() => { clearInterval(timer); resolve({ ticks, longest: Math.round(longest) }); }, 6000);
            }));`,
    'watchdog.spec.ts START_LAG': `const START_LAG = () => {
    const w = window as any;
    w.lag = { max: 0, last: performance.now() };
    clearInterval(w.lagTimer);
    w.lagTimer = setInterval(() => { const now = performance.now(); w.lag.max = Math.max(w.lag.max, now - w.lag.last - 10); w.lag.last = now; }, 10);
};`,
    'view-bound.spec.ts (b), a self-arming timer': `const tick = () => { const now = performance.now(); if (now - last > 500) (window as any).__stalls.push(Math.round(now - last)); last = now; setTimeout(tick, 10); };`,
    'view-budget.spec.ts M-5, its share': `const busy = Math.round((1 - loaded / idle) * 100);`,
    'research 16, a share against the ideal': `busyPercent: Math.max(0, Math.round((1 - ticks / (WINDOW_MS / 10)) * 100)),`,
    'strict-view-budget.spec.ts, a limit over another window': `expect(loaded).toBeGreaterThan(idle * (30 / 8) * 0.7);`,
    // the four that failed on a loaded machine (T9), each in its old shape
    'strict-view-budget.spec.ts M-3, "observing the loads costs nothing": one window on each side': `expect(idle).toBeGreaterThan(before * 0.95);`,
    'worker-port-and-view-cost.spec.ts M-2, an admitted origin (before T7)': `expect(loaded).toBeGreaterThan(idle * 0.7);`,
    'view-bound.spec.ts (a) at T7: a pausable flood against one baseline': `const flood = (setup: string, step: string) => \`
    globalThis.flood = () => { let n = 0; const next = () => { if (globalThis.stop) return; (\${step})(n++); setTimeout(next, 5); }; next(); };\`;
const { idle, loaded, busy, meanBusy } = await busyShare(page, () => sandbox.run('flood()'));`,
    'watchdog.spec.ts render-then-loop, a stall bound per engine': `const bound = { chromium: 600, firefox: 600, webkit: 1500 }[browserName]!;
    expect(stall).toBeLessThan(bound);`,
    'strict-render-flood.spec.ts, a table of stall bounds': `const BOUNDS: Record<string, { lag: number; roundTrip: number }> = {
    chromium: { lag: 600, roundTrip: 1500 },`,
    'strict-renderer.spec.ts ST2, a stall against a number': `expect(lag).toBeLessThan(500);`,
    'view-bound.spec.ts, a calibration of its own': `const operationCost = async (page: Page, html: string) => {`,
};

describe('T9: every host-tick measure goes through test/e2e/host-share.ts', () => {
    it('no spec or helper under test/e2e or docs/research has a meter of its own', () => {
        const own = FILES.filter(file => file !== HOST_SHARE && !(file in OUTSIDE))
            .flatMap(file => meterHits(read(file)).map(hit => `${file}:${hit.line} ${hit.pattern}: ${hit.text}`));
        expect(own).toEqual([]);
    });

    it('the scan catches every shape of the meters it replaced', () => {
        for (const [name, source] of Object.entries(OLD_METERS)) expect(meterHits(source).length, name).toBeGreaterThan(0);
    });

    it('and the one measure itself (a positive control on the tree)', () => {
        const patterns = new Set(meterHits(read(HOST_SHARE)).map(hit => hit.pattern));
        expect([...patterns].sort()).toEqual(['a 10 ms interval', 'a busy share against idle ticks', 'a calibration of its own', 'a gap read off the clock']);
    });

    it("what a comment says is not a meter; guest code's own timers are not either", () => {
        expect(meterHits(`// ticks of a 10 ms interval: setInterval(() => count++, 10)\n/** 1 - loaded / idle */`)).toEqual([]);
        expect(meterHits("await sandbox.run(`setInterval(() => { for (let i = 0; i < 5; i++) bridge.call('noop'); }, 5);`);")).toEqual([]);
    });

    it('each meter outside it still exists and still measures (the list does not outlive its reason)', () => {
        for (const file of Object.keys(OUTSIDE)) {
            expect(existsSync(path.join(ROOT, file)), file).toBe(true);
            expect(meterHits(read(file)).length, file).toBeGreaterThan(0);
        }
    });

    it('no unit test bounds its own wall-clock time by a number, but for a reviewed list; the two it replaced are caught', () => {
        const tests = [...sources('src'), ...sources('test/unit'), ...sources('test/model')].filter(file => /\.test\.ts$/.test(file) && file !== 'test/unit/host-share.test.ts'); // this file holds the samples
        expect(tests.length).toBeGreaterThan(40);
        expect(tests.filter(file => !(file in WALL_CLOCK_ALLOWED)).flatMap(file => wallClockBounds(read(file)).map(hit => `${file}:${hit.line} ${hit.text}`))).toEqual([]);
        for (const file of Object.keys(WALL_CLOCK_ALLOWED)) expect(wallClockBounds(read(file)).length, `${file} is listed, so it still has one`).toBeGreaterThan(0);
        // two samples, verbatim, and the indirect form
        expect(wallClockBounds(`const started = performance.now();\n        expect(count(css)).toBe(3 * 13000);\n        expect(performance.now() - started).toBeLessThan(1000);`)).toHaveLength(1);
        expect(wallClockBounds(`expect(performance.now() - started).toBeLessThan(3000);`)).toHaveLength(1);
        expect(wallClockBounds(`const elapsed = Date.now() - started;\nexpect(elapsed, 'ms').toBeLessThanOrEqual(500);`)).toHaveLength(1);
        // not: a ratio of two sizes measured in the same run, or a wait that must last
        expect(wallClockBounds(`expect(large / small).toBeLessThan(24);`)).toEqual([]);
        expect(wallClockBounds(`const waited = Date.now() - started;\nexpect(waited).toBeGreaterThan(6000);`)).toEqual([]);
    });

    it('no unit test measures scaling by clock reads of its own, but for a reviewed list; the three it replaced are caught', () => {
        const tests = [...sources('src'), ...sources('test/unit'), ...sources('test/model')].filter(file => /\.test\.ts$/.test(file) && file !== 'test/unit/host-share.test.ts');
        expect(tests.filter(file => !(file in SCALING_ALLOWED)).flatMap(file => handTimedScaling(read(file)).map(hit => `${file}:${hit.line} ${hit.pattern}: ${hit.text}`))).toEqual([]);
        for (const file of Object.keys(SCALING_ALLOWED)) expect(handTimedScaling(read(file)).length, `${file} is listed, so it still has one`).toBeGreaterThan(0);
        // three samples, verbatim (view-css-loads, css-references and in-sandbox-view tests)
        expect(handTimedScaling(`let fastest = Infinity;
            for (let run = 0; run < 3; run++) {
                const started = performance.now();
                expect(count(text)).toBe(3 * n);
                fastest = Math.min(fastest, performance.now() - started);
            }`).map(hit => hit.pattern)).toEqual(['a fastest of clock differences']);
        expect(handTimedScaling(`const small = best(1024 * 1024);
        const large = best(8 * 1024 * 1024);
        expect(large / small, \`best of 3: \${small.toFixed(1)} ms for 1 MiB, \${large.toFixed(1)} ms for 8 MiB\`).toBeLessThan(24);`).map(hit => hit.pattern)).toEqual(['a ceiling on a ratio of two names']);
        expect(handTimedScaling(`                template.innerHTML = text;
                const started = performance.now();
                sanitizeRender(template.content, () => null, () => false, RENDER_RULES, KEEP_ALL);
                fastest = Math.min(fastest, performance.now() - started);
        expect(large / small, \`best of 3: \${small.toFixed(1)} ms for 1 000\`).toBeLessThan(24); // linear: ~8`)).toHaveLength(2);
        // the same through a Date.now() clock, and a ceiling of or-equal
        expect(handTimedScaling(`best = Math.min(best, Date.now() - t0);`)).toHaveLength(1);
        expect(handTimedScaling(`expect(slow / fast).toBeLessThanOrEqual(24);`)).toHaveLength(1);
        // not: a timing for the log, a ratio that is no ceiling, the helper's result, a comment
        expect(handTimedScaling(`const measured = time(() => measure(sample)); console.log(measured);`)).toEqual([]);
        expect(handTimedScaling(`expect(made.size / listed.size).toBeGreaterThan(0.6);\nexpect(busy / elapsed).toBeCloseTo(0.2, 2);`)).toEqual([]);
        expect(handTimedScaling(`const result = scalingRatio(size(1000), size(8000), { bound: 24 });\nexpect(result.ratio, result.message).toBeLessThan(24);`)).toEqual([]);
        expect(handTimedScaling(`// fastest = Math.min(fastest, performance.now() - started); expect(large / small).toBeLessThan(24)`)).toEqual([]);
    });
});
