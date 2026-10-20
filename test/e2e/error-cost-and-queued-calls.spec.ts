import { deflateSync } from 'node:zlib';
import { test, expect, type SandboxDriver } from './fixture';
import { waitInView } from './strict-view';
import type { Page } from '@playwright/test';
import { busyShare, describeShare, floodControl, interleavedShare, pausableFlood } from './host-share';

/**
 * Findings of R5 where the browser decides, on Chromium, Firefox and WebKit. Each names its class
 * (docs/research/18_finding_classes/README.md). The library's own logic is unit-tested in test/unit/call-settling-and-read-once.test.ts; the egress table's
 * enumeration of every engine's surfaces is test/e2e/egress.spec.ts.
 *   R5:N-1  unhandled rejections in a loop keep Firefox's host page 99% busy unless bounded (E-cpu)
 *   R5:L-1  a call made while loading that times out before `ready` never runs (L)
 *   R5:N-4  a removal of a file the host unregistered after the build shows in the view (D)
 */

// What the host page's thread had left: its busy share against its own idle baseline (./host-share.ts). The floods
// last 5 s of running, so the loaded side is the best of 2 windows of 2 s, each after a warm-up of 500 ms, within the
// flood; where the flood can pause, each window lies between two idle baselines (interleavedShare).
const WITHIN_FLOOD = { windows: 2, ms: 2000 };

async function mountMode(sandbox: SandboxDriver, mode: 'worker' | 'strict') {
    if (mode === 'worker') {
        expect(await sandbox.mount({ mode: 'worker', scriptUnsafe: true })).toBe('ready');
        return;
    }
    await sandbox.registerFiles({ 'main.js': 'void 0' });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', scriptUnsafe: true })).toBe('ready');
}

// The 'terminated' reasons of the harness's sandbox from now on.
const recordTerminations = (page: Page) => page.evaluate(() => {
    (window as any).terminations = [];
    document.querySelector('web-sandbox')!.addEventListener('terminated', (e) => (window as any).terminations.push((e as CustomEvent).detail.reason));
});
const terminations = (page: Page) => page.evaluate(() => [...(window as any).terminations] as string[]);

const UNCAUGHT_REASON = /uncaught errors or unhandled rejections/;

// A flood that runs its tick on every timer turn for 5 s of running in all, then stops: long enough to measure, short
// enough that a flood the sandbox does not end cannot run the test's browser out of memory (Firefox's console kept about
// 7 GB in 25 s, past this machine's memory limit). Pausable, so that each loaded window lies between two idle
// baselines (./host-share.ts, interleavedShare): the WITHIN_FLOOD windows and their warm-ups are its 5 s.
const FOR_5_SECONDS = (setup: string, tick: string) => pausableFlood(setup, tick, 5000);

test.describe('N-1 (E-cpu): uncaught errors and unhandled rejections cost the host page a bounded share, or end the sandbox', () => {
    // The reviewers' flood: a rejection of 16 Mi characters per timer tick. Firefox reports each to the host page's
    // thread whether or not it is cancelled (99% busy unbounded, and with the guest cancelling every one);
    // past the budget the sandbox ends.
    const FLOODS: Record<string, string> = {
        'rejections of 16 Mi characters': FOR_5_SECONDS(`const big = 'x'.repeat(2 ** 24);`, `() => { Promise.reject(new Error(big)); }`),
        'small rejections, 100 per tick': FOR_5_SECONDS('', `() => { for (let i = 0; i < 100; i++) Promise.reject(new Error('x')); }`),
        'small rejections handled a tick later (rejectionhandled), 100 per tick': FOR_5_SECONDS('', `() => { for (let i = 0; i < 100; i++) { const p = Promise.reject(new Error('x')); setTimeout(() => p.catch(() => {}), 0); } }`),
        // errors, which the worker cancels once relayed (R4:M-1), count against the same budget
        'uncaught errors of 16 Mi characters': FOR_5_SECONDS(`const big = 'x'.repeat(2 ** 24);`, `() => { reportError(new Error(big)); }`),
        'small uncaught errors, 100 per tick': FOR_5_SECONDS('', `() => { for (let i = 0; i < 100; i++) reportError(new Error('x')); }`),
    };
    for (const mode of ['worker', 'strict'] as const) {
        for (const [name, flood] of Object.entries(FLOODS)) {
            test(`${mode} mode, ${name}: the host page keeps its idle ticks, or the sandbox ends with the reason`, async ({ sandbox, page, browserName }) => {
                test.setTimeout(60000);
                await mountMode(sandbox, mode);
                await recordTerminations(page);
                await page.waitForTimeout(300);
                const share = await interleavedShare(page, floodControl(sandbox, flood), WITHIN_FLOOD, 500);
                const reasons = await terminations(page);
                console.log(`MEASURED ${browserName} N-1 ${mode} mode, ${name}: ${describeShare(share)}, state ${await sandbox.state()}, ${JSON.stringify(reasons)}`);
                const ended = reasons.length === 1 && UNCAUGHT_REASON.test(reasons[0]!);
                // no documented share (docs/API.md lists Firefox's cost within the budget, 4–7%, as outside the view's
                // bound): the spec's own 10% stands
                expect(ended || share.busy < 0.1, 'near idle, or ended with the reason').toBe(true);
                // a flood this fast is past the budget: the sandbox ends, and says why. Except WebKit's uncaught errors of
                // 16 Mi characters: WebKit mutes a worker's errors ("Script error.", no error object), so their characters are
                // not there to count, and it raises fewer than the count budget (its host page stayed idle: measured 2-5%)
                if (browserName === 'webkit' && name === 'uncaught errors of 16 Mi characters') return;
                expect(reasons).toEqual([expect.stringMatching(UNCAUGHT_REASON)]);
            });
        }
    }

    // Within the budget the sandbox stays, and the host page is near idle: rejections cancelled once relayed, so Chromium
    // reports none on its page (uncancelled it is 11-39% busy), and Firefox's report stays small.
    for (const mode of ['worker', 'strict'] as const) {
        test(`${mode} mode, within the budget (300 rejections of 2 Ki characters per second, each handled a tick later): the sandbox stays, the host page near idle, every rejection relayed`, async ({ sandbox, page, browserName }) => {
            test.setTimeout(60000);
            await mountMode(sandbox, mode);
            await recordTerminations(page);
            await page.waitForTimeout(300);
            await sandbox.clearLogs();
            const share = await busyShare(page, () => sandbox.run(`const text = 'y'.repeat(2048); let n = 0; const start = performance.now(); const t = setInterval(() => {
                const due = Math.min(1500, Math.floor((performance.now() - start) * 300 / 1000));
                while (n < due) { n++; const p = Promise.reject(new Error(text)); setTimeout(() => p.catch(() => {}), 0); }
                if (n >= 1500) clearInterval(t);
            }, 5);`), WITHIN_FLOOD, 500);
            const relayedLines = async () => (await sandbox.logs()).filter(line => line.startsWith('Uncaught (in promise) Error: yyy')).length;
            for (let wait = 0; wait < 40 && await relayedLines() < 1500; wait++) await page.waitForTimeout(100);
            const relayed = await relayedLines();
            console.log(`MEASURED ${browserName} N-1 ${mode} mode within the budget: ${describeShare(share)}, ${relayed} relayed`);
            expect(await terminations(page)).toEqual([]);
            expect(await sandbox.state()).toBe('ready');
            // a rejection whose catch runs before the browser's notification is never unhandled: nearly all of them are
            expect(relayed).toBeGreaterThan(1400);
            expect(share.busy).toBeLessThan(0.15); // no documented share (Firefox's 4–7% is listed as measured): the spec's own 15% stands
        });
    }
});

test.describe('L-1 (L): queued calls are posted only when the build is ready', () => {
    // The owner's repro: a call made at once after setConfig() with a large view. When its timeout falls between the
    // wrapper's load and the view's check-in (the window the large view widens), the call times out and must not run:
    // the queue is flushed at `ready`, not at the load. The window's place differs per run and engine, so the call
    // is made with several timeouts, one build each, and every call that timed out before its build's `ready` is checked;
    // a call that timed out after `ready` had been posted may run (it is not in the queue).
    test("strict mode, the owner's repro: a call that times out before `ready` never runs, at any timeout", async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        await sandbox.registerFiles({ 'main.js': `bridge.expose('m', (text) => console.log('L1 ' + text));` });
        const cases: { timeout: number; outcome: string; beforeReady: boolean }[] = [];
        for (const timeout of [5, 20, 40, 60, 80, 100, 130, 160, 200, 300]) {
            cases.push(await page.evaluate(async (timeout) => {
                const el = document.querySelector('web-sandbox') as any;
                const html = '<p>' + 'x'.repeat(880000) + '</p><p>' + timeout + '</p>';
                let readyAt = Infinity;
                const ready = new Promise(resolve => el.addEventListener('ready', () => { readyAt = performance.now(); resolve(null); }, { once: true }));
                el.setConfig({ entry: 'main.js', html });
                let settledAt = 0;
                const outcome = await el.callWithTimeout(timeout, 'm', 'ran ' + timeout).then(() => 'resolved', (e: any) => e.code).finally(() => { settledAt = performance.now(); });
                await ready;
                await el.callWithTimeout(5000, 'm', 'ready ' + timeout); // the positive control; the guest has run what it was sent
                return { timeout, outcome, beforeReady: settledAt < readyAt };
            }, timeout));
        }
        await page.waitForTimeout(300);
        const lines = new Set((await sandbox.logs()).filter(line => line.startsWith('L1 ')));
        const timedOutBeforeReady = cases.filter(entry => entry.outcome === 'TIMEOUT' && entry.beforeReady);
        console.log(`MEASURED ${browserName} L-1: ${timedOutBeforeReady.length} of ${cases.length} calls timed out before ready; ran anyway: ${JSON.stringify(timedOutBeforeReady.filter(entry => lines.has('L1 ran ' + entry.timeout)).map(entry => entry.timeout))}`);
        expect(timedOutBeforeReady.length, 'at least one call timed out before ready').toBeGreaterThan(0);
        for (const entry of timedOutBeforeReady) expect(lines.has('L1 ran ' + entry.timeout), `the call with timeout ${entry.timeout} ran`).toBe(false);
        for (const entry of cases) expect(lines.has('L1 ready ' + entry.timeout), 'the call after ready ran').toBe(true);
    });
});

// A PNG of width × height, so a rendered <img> tells "this file decoded" by its natural size.
function png(width: number, height: number): string {
    const table = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (bytes: Buffer) => {
        let c = 0xffffffff;
        for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([length, body, sum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test.describe('N-4 (D): the view shows what the guest sees', () => {
    // An <img> by id, read in the view from outside: its natural size once it loaded, and what its src attribute holds.
    const image = (id: string) => `(() => { const i = document.getElementById('${id}'); return i && (i.complete || !/^blob:/.test(i.getAttribute('src'))) ? { size: i.naturalWidth + 'x' + i.naturalHeight, src: i.getAttribute('src') } : null; })()`;

    test('a registered image the host unregistered after the build, then removed by the guest, names nothing in the view; another registered image still shows (positive control)', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.registerFiles({ 'pic.png': { base64: png(3, 5) }, 'kept.png': { base64: png(7, 4) } })).toBe('ok');
        expect(await sandbox.mount({ mode: 'strict', guestWrites: true, scriptUnsafe: true })).toBe('ready');
        await page.evaluate(() => (document.querySelector('web-sandbox') as any).unregisterFiles(['pic.png']));
        const removed = await sandbox.inGuest(`await sandboxFiles.remove('pic.png'); sandboxView.render('<img id="pic" src="pic.png"><img id="kept" src="kept.png"><p id="done">done</p>'); return sandboxFiles.list();`);
        expect(removed).toEqual(['kept.png']);
        await waitInView(page, browserName, `!!document.getElementById('done')`, 8000);
        expect((await waitInView<{ size: string }>(page, browserName, image('kept'), 8000)).size).toBe('7x4');
        expect(await waitInView(page, browserName, image('pic'), 8000)).toEqual({ size: '0x0', src: 'pic.png' });
        expect(await page.evaluate(() => (document.querySelector('web-sandbox') as any).listGuestWrites())).toEqual([]);
    });
});
