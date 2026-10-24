import type { Page } from '@playwright/test';
import { test, expect, type SandboxDriver } from '../../../test/e2e/fixture';
import { inView, waitInView } from '../../../test/e2e/strict-view';
import { idleBaseline, ticks, busyOf } from '../../../test/e2e/host-share';

/*
 * Research 23's design probe: pointer events prototyped by rewriting the view's source in flight (as research 16's
 * measure.spec.ts does; the bootstrap's hash is computed from the served text), to measure the design before the input
 * path existed. Its rewrites target a view without that path, and it asserts that each one applies, so on the shipped
 * view it stops at that assertion: the figures of the research note's design sections are its own, on the view it was
 * written for. The shipped path is measured by measure.spec.ts beside it.
 *   WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/23_view_input/probe.spec.ts --project=chromium --workers=1
 */
test.skip(!process.env.WEB_SANDBOX_MEASURE, 'a measurement, run on demand (WEB_SANDBOX_MEASURE=1)');
test.describe.configure({ mode: 'serial' });

async function rewriteView(page: Page) {
    await page.route('**/src/lib/in-sandbox-view.ts**', async (route) => {
        const response = await route.fetch();
        const original = await response.text();
        let source = original;
        source = source.replace(/VIEW_EVENT_TYPES = \[([^\]]*)\]/, (_w, list) => `VIEW_EVENT_TYPES = [${list}, "pointerdown", "pointermove", "pointerup"]`);
        // probe state in the view, and a raw listener for what the view receives at all (outside its box included)
        source = source.replace(/(const runs = \(g\.__sandboxViewRuns \|\| 0\) \+ 1;)/,
            `g.__p = { seq: 0, ts: {}, tin: {}, applied: {}, painted: {}, inFrame: {}, raw: [], flushes: 0, capture: false };
            addEventListener('pointermove', (e) => { g.__p.raw.push([Math.round(e.clientX), Math.round(e.clientY), e.buttons, Math.round(performance.now())]); }, true);
            addEventListener('pointerdown', (e) => { if (g.__p.capture && e.target && e.target.setPointerCapture) { try { e.target.setPointerCapture(e.pointerId); g.__p.captured = true; } catch (x) { g.__p.captureError = String(x); } } }, true);
            $1`);
        source = source.replace(/(if \(event\.type === ["']keydown["']\) detail\.key = clamp\(event\.key \|\| ["']{2}\);)/,
            `$1 if (event.type.indexOf('pointer') === 0) { const s = ++g.__p.seq; detail.x = event.clientX; detail.y = event.clientY; detail.seq = s; g.__p.ts[s] = event.timeStamp; g.__p.tin[s] = performance.now(); }`);
        source = source.replace(/const flush = \((\w*)\) => \{/, (_w, p) => `const flush = (${p}) => { g.__p.flushes++; for (let i = 0; i < pending.length; i++) { const m = /\\/\\*(\\d+)\\*\\//.exec(pending[i].html || ''); const s = m ? +m[1] : (pending[i].fields && pending[i].fields.seq); if (!s) continue; g.__p.applied[s] = performance.now(); g.__p.inFrame[s] = ${p}; const mark = () => { g.__p.painted[s] = performance.now(); }; if (${p}) setTimeout(mark, 0); else requestAnimationFrame(() => setTimeout(mark, 0)); }`);
        // a prototype set(id, { transform }): the view writes one inline property of one element
        source = source.replace(/const fieldsOf = \((\w+)\) => \{\s*const fields = \{\};/, (w, d) => `${w} if (typeof ${d}.transform === 'string') fields.transform = ${d}.transform; if (typeof ${d}.seq === 'number') fields.seq = ${d}.seq;`);
        source = source.replace(/const applySet = \((\w+), (\w+)\) => \{/, (w, id, f) => `${w} if (${f}.transform !== undefined) { const t = elementInBody(${id}); if (t) t.style.setProperty('transform', ${f}.transform); }`);
        source = source.replace(/\} else if \(key === (["'])checked\1 \|\| key === \1focus\1\) \{/, (w) => `} else if (key === 'transform' || key === 'seq') { ${w}`);
        const patches = [/"pointermove"/, /g\.__p = \{/, /detail\.seq = s/, /g\.__p\.flushes\+\+/, /fields\.transform = /, /setProperty\('transform'/, /key === 'transform' \|\| key === 'seq'/];
        for (const p of patches) expect(p.test(source), `patch ${p}`).toBe(true);
        await route.fulfill({ response, body: source });
    });
}

const MARKUP = '<style id="st"></style><div id="pad" style="position:absolute;inset:0;touch-action:none;user-select:none"></div><div id="box" style="position:absolute;left:0;top:0;width:40px;height:40px;background:red;pointer-events:none"></div>';
const ENTRIES: Record<string, string> = {
    none: `sandboxView.render(${JSON.stringify(MARKUP)});`,
    forward: `sandboxView.render(${JSON.stringify(MARKUP)}); sandboxView.on('pointermove', null, () => {});`,
    respond: `sandboxView.render(${JSON.stringify(MARKUP)}); sandboxView.on('pointermove', null, (d) => sandboxView.text('st', '#box{transform:translate(' + d.x + 'px,' + d.y + 'px)}/*' + d.seq + '*/'));`,
};
const COOPERATIVE = `<div id="pad" style="position:absolute;inset:0;touch-action:none"></div><div id="box" style="position:absolute;left:0;top:0;width:40px;height:40px;background:red;pointer-events:none"></div>
<script>
const box = document.getElementById('box'); const out = [];
addEventListener('pointermove', (e) => { const t0 = performance.now(); box.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
  requestAnimationFrame(() => setTimeout(() => out.push([e.timeStamp, t0, performance.now()]), 0)); });
bridge.expose('probeResults', () => out.splice(0));
</script>`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Trusted moves at `hz` over the sandbox's box, on a circle; returns the count sent and the time it took. */
function startMoves(page: Page, box: { x: number; y: number }, hz: number) {
    let running = true;
    let sent = 0;
    const started = Date.now();
    const done = (async () => {
        const period = 1000 / hz;
        let next = Date.now();
        while (running) {
            const a = sent / 20;
            await page.mouse.move(box.x + 200 + 120 * Math.cos(a), box.y + 150 + 100 * Math.sin(a));
            sent++;
            next += period;
            const wait = next - Date.now();
            if (wait > 0) await sleep(wait);
        }
        return { sent, ms: Date.now() - started };
    })();
    return { stop: async () => { running = false; return done; } };
}

const pct = (values: number[], p: number) => {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10;
};

async function mountStrict(sandbox: SandboxDriver, page: Page, browserName: string, entry: string) {
    await sandbox.registerFiles({ 'main.js': entry });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js' })).toBe('ready');
    await waitInView(page, browserName, `!!document.getElementById('box')`);
}

test('latency and host cost of a 60 Hz pointer drag, strict (prototype) vs cooperative', async ({ sandbox, page, browserName }) => {
    test.setTimeout(240000);
    await rewriteView(page);
    await sandbox.open();
    const box = (await page.locator('web-sandbox').boundingBox())!;
    const idle = await idleBaseline(page);
    const results: Record<string, unknown> = { engine: browserName, idleTicksPerSecond: idle.count / (idle.ms / 1000) };

    for (const name of ['none', 'forward', 'respond']) {
        await mountStrict(sandbox, page, browserName, ENTRIES[name]!);
        await page.mouse.move(box.x + 10, box.y + 10);
        await sleep(300);
        const before = await inView<string>(page, browserName, 'JSON.stringify({ seq: __p.seq, flushes: __p.flushes })');
        const moves = startMoves(page, box, 60);
        await sleep(500);
        const window = await ticks(page, 4000);
        const sent = await moves.stop();
        await sleep(300);
        const p = JSON.parse(await inView<string>(page, browserName, 'JSON.stringify(__p)') as string);
        const b = JSON.parse(before as string);
        const seqs = Object.keys(p.painted).map(Number).filter(s => s > b.seq);
        const total = seqs.map(s => p.painted[s] - p.ts[s]);
        const fromView = seqs.map(s => p.painted[s] - p.tin[s]);
        const toApply = seqs.map(s => p.applied[s] - p.tin[s]);
        const render = seqs.map(s => p.painted[s] - p.applied[s]);
        const dispatch = Object.keys(p.tin).map(Number).filter(s => s > b.seq).map(s => p.tin[s] - p.ts[s]);
        results[name] = {
            movesSentPerSecond: Math.round(sent.sent / (sent.ms / 1000)),
            viewPointermovesForwarded: p.seq - b.seq,
            flushes: p.flushes - b.flushes,
            painted: seqs.length,
            hostBusyPercent: Math.round(busyOf(window.count, 4000, idle) * 100),
            hostLongestGapMs: window.longest,
            latencyEventToPaint: { p50: pct(total, 0.5), p95: pct(total, 0.95) },
            latencyViewForwardToPaint: { p50: pct(fromView, 0.5), p95: pct(fromView, 0.95) },
            forwardToApplied: { p50: pct(toApply, 0.5), p95: pct(toApply, 0.95) },
            appliedToRendered: { p50: pct(render, 0.5), p95: pct(render, 0.95) },
            eventTimeStampToForward: { p50: pct(dispatch, 0.5), p95: pct(dispatch, 0.95) },
            inFrameShare: seqs.length ? Math.round(100 * seqs.filter(s => p.inFrame[s]).length / seqs.length) : null,
        };
    }

    // cooperative baseline: the guest's own handler in its document (what any iframe gets)
    expect(await sandbox.mount({ mode: 'cooperative', html: COOPERATIVE })).toBe('ready');
    await page.mouse.move(box.x + 10, box.y + 10);
    await sleep(300);
    await page.evaluate(() => (document.querySelector('web-sandbox') as any).call('probeResults'));
    const moves = startMoves(page, box, 60);
    await sleep(500);
    const window = await ticks(page, 4000);
    const sent = await moves.stop();
    await sleep(300);
    const out = await page.evaluate(() => (document.querySelector('web-sandbox') as any).call('probeResults')) as [number, number, number][];
    results.cooperative = {
        movesSentPerSecond: Math.round(sent.sent / (sent.ms / 1000)),
        painted: out.length,
        hostBusyPercent: Math.round(busyOf(window.count, 4000, idle) * 100),
        hostLongestGapMs: window.longest,
        latencyEventToPaint: { p50: pct(out.map(o => o[2] - o[0]), 0.5), p95: pct(out.map(o => o[2] - o[0]), 0.95) },
        latencyHandlerToPaint: { p50: pct(out.map(o => o[2] - o[1]), 0.5), p95: pct(out.map(o => o[2] - o[1]), 0.95) },
    };
    console.log(`MEASURED ${JSON.stringify(results)}`);
});

test('a burst of moves: how many pointermoves reach the view (does the engine coalesce per frame?)', async ({ sandbox, page, browserName }) => {
    test.setTimeout(60000);
    await rewriteView(page);
    await sandbox.open();
    const box = (await page.locator('web-sandbox').boundingBox())!;
    await mountStrict(sandbox, page, browserName, ENTRIES.forward!);
    await page.mouse.move(box.x + 20, box.y + 20);
    await sleep(200);
    const before = await inView<number>(page, browserName, '__p.raw.length') as number;
    const t = Date.now();
    await page.mouse.move(box.x + 380, box.y + 280, { steps: 400 });
    const ms = Date.now() - t;
    await sleep(300);
    const after = await inView<number>(page, browserName, '__p.raw.length') as number;
    const resolution = await inView<string>(page, browserName, `(() => { const d = new Set(); let last = performance.now(); for (let i = 0; i < 200000 && d.size < 50; i++) { const n = performance.now(); if (n !== last) { d.add(Math.round((n - last) * 1000) / 1000); last = n; } } return JSON.stringify([...d].sort((a, b) => a - b).slice(0, 5)); })()`);
    console.log(`MEASURED ${JSON.stringify({ engine: browserName, burst: { sent: 400, ms, receivedInView: after - before, perSecond: Math.round((after - before) / (ms / 1000)) }, viewPerformanceNowSteps: resolution })}`);
});

test('a drag that leaves the view: what pointermoves outside its box reach it, with and without setPointerCapture', async ({ sandbox, page, browserName }) => {
    test.setTimeout(60000);
    await rewriteView(page);
    await sandbox.open();
    const box = (await page.locator('web-sandbox').boundingBox())!;
    const out: Record<string, unknown> = { engine: browserName, box };
    for (const capture of [false, true]) {
        await mountStrict(sandbox, page, browserName, ENTRIES.forward!);
        if (capture) await inView(page, browserName, '(__p.capture = true)');
        await page.mouse.move(box.x + 100, box.y + 100);
        await sleep(100);
        await inView(page, browserName, '(__p.raw = [], true)');
        await page.mouse.down();
        for (let i = 1; i <= 20; i++) { await page.mouse.move(box.x + 100 + i * 30, box.y + 100 + i * 20); await sleep(20); } // far past the right and bottom edges
        for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x + 450 + i * 10, box.y + 50); await sleep(20); } // right of it, inside the page
        await page.mouse.up();
        await sleep(100);
        for (let i = 1; i <= 5; i++) { await page.mouse.move(box.x + 600 + i * 5, box.y + 80); await sleep(20); } // button up, outside
        await sleep(200);
        const raw = JSON.parse(await inView<string>(page, browserName, 'JSON.stringify({ raw: __p.raw, captured: !!__p.captured, err: __p.captureError || null, w: innerWidth, h: innerHeight })') as string);
        const outside = raw.raw.filter((r: [number, number, number]) => r[0] < 0 || r[1] < 0 || r[0] > raw.w || r[1] > raw.h);
        out[capture ? 'withCapture' : 'noCapture'] = { received: raw.raw.length, outsideBox: outside.length, outsideWithButtonsUp: outside.filter((r: [number, number, number]) => r[2] === 0).length, upSample: outside.filter((r: [number, number, number]) => r[2] === 0).map((r: [number, number, number]) => r.slice(0, 2)), all: raw.raw.map((r: [number, number, number]) => r.slice(0, 3)), sampleOutside: outside.slice(0, 3), maxX: Math.max(...raw.raw.map((r: [number, number, number]) => r[0])), minY: Math.min(...raw.raw.map((r: [number, number, number]) => r[1])), captured: raw.captured, err: raw.err };
    }
    console.log(`MEASURED ${JSON.stringify(out)}`);
});

test('a 60 Hz drag over a heavy view (10 000 elements): the view budget throttles the updates, the host share stays bounded', async ({ sandbox, page, browserName }) => {
    test.setTimeout(180000);
    await rewriteView(page);
    await sandbox.open();
    const box = (await page.locator('web-sandbox').boundingBox())!;
    const idle = await idleBaseline(page);
    const heavy = MARKUP + '<div style="position:absolute;top:0;left:0;opacity:0.3;pointer-events:none">' + '<span>x </span>'.repeat(10000) + '</div>';
    await mountStrict(sandbox, page, browserName, `sandboxView.render(${JSON.stringify(heavy)}); sandboxView.on('pointermove', null, (d) => sandboxView.text('st', '#box{transform:translate(' + d.x + 'px,' + d.y + 'px)}/*' + d.seq + '*/'));`);
    await page.mouse.move(box.x + 10, box.y + 10);
    await sleep(1000);
    const before = JSON.parse(await inView<string>(page, browserName, 'JSON.stringify({ seq: __p.seq, flushes: __p.flushes })') as string);
    const moves = startMoves(page, box, 60);
    await sleep(500);
    const window = await ticks(page, 4000);
    await moves.stop();
    await sleep(500);
    const p = JSON.parse(await inView<string>(page, browserName, 'JSON.stringify(__p)') as string);
    const seqs = Object.keys(p.painted).map(Number).filter(s => s > before.seq);
    const total = seqs.map(s => p.painted[s] - p.ts[s]);
    const render = seqs.map(s => p.painted[s] - p.applied[s]);
    console.log(`MEASURED ${JSON.stringify({ engine: browserName, heavy: { forwarded: p.seq - before.seq, flushes: p.flushes - before.flushes, painted: seqs.length, hostBusyPercent: Math.round(busyOf(window.count, 4000, idle) * 100), longestGapMs: window.longest, eventToPaint: { p50: pct(total, 0.5), p95: pct(total, 0.95) }, appliedToRendered: { p50: pct(render, 0.5), p95: pct(render, 0.95) } } })}`);
});

test('a 60 Hz drag over a heavy view, with a prototype set(id, { transform }) instead of a stylesheet text', async ({ sandbox, page, browserName }) => {
    test.setTimeout(180000);
    await rewriteView(page);
    await sandbox.open();
    const box = (await page.locator('web-sandbox').boundingBox())!;
    const idle = await idleBaseline(page);
    const out: Record<string, unknown> = { engine: browserName };
    for (const n of [0, 10000]) {
        const heavy = MARKUP + '<div style="position:absolute;top:0;left:0;opacity:0.3;pointer-events:none">' + '<span>x </span>'.repeat(n) + '</div>';
        await mountStrict(sandbox, page, browserName, `sandboxView.render(${JSON.stringify(heavy)}); sandboxView.on('pointermove', null, (d) => sandboxView.set('box', { transform: 'translate(' + d.x + 'px,' + d.y + 'px)', seq: d.seq }));`);
        await page.mouse.move(box.x + 10, box.y + 10);
        await sleep(1000);
        const before = JSON.parse(await inView<string>(page, browserName, 'JSON.stringify({ seq: __p.seq, flushes: __p.flushes })') as string);
        const moves = startMoves(page, box, 60);
        await sleep(500);
        const window = await ticks(page, 4000);
        await moves.stop();
        await sleep(500);
        const p = JSON.parse(await inView<string>(page, browserName, 'JSON.stringify(__p)') as string);
        const seqs = Object.keys(p.painted).map(Number).filter(s => s > before.seq);
        const total = seqs.map(s => p.painted[s] - p.ts[s]);
        const render = seqs.map(s => p.painted[s] - p.applied[s]);
        out[`elements${n}`] = { forwarded: p.seq - before.seq, flushes: p.flushes - before.flushes, painted: seqs.length, hostBusyPercent: Math.round(busyOf(window.count, 4000, idle) * 100), longestGapMs: window.longest, eventToPaint: { p50: pct(total, 0.5), p95: pct(total, 0.95) }, appliedToRendered: { p50: pct(render, 0.5), p95: pct(render, 0.95) } };
    }
    console.log(`MEASURED ${JSON.stringify(out)}`);
});

test('host cost of an uncoalesced burst of moves (as fast as the driver sends them), per subscription', async ({ sandbox, page, browserName }) => {
    test.setTimeout(180000);
    await rewriteView(page);
    await sandbox.open();
    const box = (await page.locator('web-sandbox').boundingBox())!;
    const idle = await idleBaseline(page);
    const out: Record<string, unknown> = { engine: browserName };
    for (const name of ['none', 'forward', 'respond']) {
        await mountStrict(sandbox, page, browserName, ENTRIES[name]!);
        await page.mouse.move(box.x + 20, box.y + 20);
        await sleep(200);
        let running = true;
        const loop = (async () => { let k = 0; while (running) { k++; await page.mouse.move(box.x + 20 + (k % 2) * 360, box.y + 20 + (k % 2) * 260, { steps: 50 }); } })();
        await sleep(500);
        const before = await inView<string>(page, browserName, 'JSON.stringify({ raw: __p.raw.length, seq: __p.seq, flushes: __p.flushes })');
        const window = await ticks(page, 3000);
        const after = await inView<string>(page, browserName, 'JSON.stringify({ raw: __p.raw.length, seq: __p.seq, flushes: __p.flushes })');
        running = false;
        await loop;
        const b = JSON.parse(before as string), a = JSON.parse(after as string);
        out[name] = { hostBusyPercent: Math.round(busyOf(window.count, 3000, idle) * 100), longestGapMs: window.longest, pointermovesInViewPerSecond: Math.round((a.raw - b.raw) / 3), forwardedPerSecond: Math.round((a.seq - b.seq) / 3), flushesPerSecond: Math.round((a.flushes - b.flushes) / 3) };
    }
    console.log(`MEASURED ${JSON.stringify(out)}`);
});
