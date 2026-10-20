import { test, expect, type SandboxDriver } from './fixture';
import { inView, waitInView } from './strict-view';
import { busyShare, describeShare, lag, startLag, viewBound } from './host-share';
import { VIEW_MAX_OPERATION_MS } from '@src/lib/in-sandbox-view';

/**
 * The strict view's budget (R1:R1-1 and R1:R1-2; ADR-005). The view runs on the host
 * page's thread in Firefox and WebKit, and in Chromium depending on its process model, so what it renders is host work.
 * Bounded by construction, and measured from the host page (its busy share against its own idle baseline,
 * ./host-share.ts):
 *   - the characters the view holds, text, comments and attributes alike (its body's serialization), counted over the
 *     document a render would leave, like elements (VIEW_MAX_CHARACTERS);
 *   - the characters the view applies per second (VIEW_RENDER_CHARACTERS_PER_SECOND): a render past it waits, and the
 *     worker's next render waits for it (flow control), so a guest cannot keep the host busy with renders that fit;
 *   - no element whose layout cost grows faster than the markup (Firefox's line breaking over <wbr>: 43 000 of them
 *     stalled its host about 20 s).
 */

async function mountEntry(sandbox: SandboxDriver, source: string) {
    await sandbox.registerFiles({ 'main.js': source });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', scriptUnsafe: true })).toBe('ready');
}

test('R1-1: renders of 261 000 characters of text into 200 targets every 20 ms leave the host page responsive; the view holds at most VIEW_MAX_CHARACTERS', async ({ sandbox, page, browserName }) => {
    test.setTimeout(60000);
    await mountEntry(sandbox, `
        let targets = '';
        for (let i = 0; i < 200; i++) targets += '<div id="t' + i + '"></div>';
        sandboxView.render(targets);
        globalThis.flood = () => {
            const text = 'x'.repeat(261000); // within VIEW_RENDER_MAX_LENGTH (262144)
            let n = 0;
            const end = Date.now() + 3000;
            const timer = setInterval(() => {
                sandboxView.render(text, 't' + (n++ % 200));
                if (Date.now() > end) { clearInterval(timer); console.log('R11 flood done'); }
            }, 20);
        };`);
    await page.waitForTimeout(300);
    // within the 3 s flood: the best of 2 windows of 1.25 s after 300 ms
    const share = await busyShare(page, () => sandbox.run('flood()'), { windows: 2, ms: 1250 }, 300);
    await sandbox.waitForLog('R11 flood done', 20000);
    const held = await inView<number>(page, browserName, 'document.body.innerHTML.length');
    console.log(`MEASURED ${browserName} R1-1 during the render flood: ${describeShare(share)}; view characters ${held}`);
    expect(share.busy).toBeLessThanOrEqual(viewBound(false)); // docs/API.md (a): 20%, plus the measure's 10 points
    expect(held).toBeLessThanOrEqual(4 * 262144);
    // renders past the budget were refused, acknowledged, and said in the guest's log: the queued renders keep being
    // applied after the flood, at the view's rates (characters, and its time per second: R2:M-3), so the
    // refusal can come after the flood's end (WebKit, whose renders of this text take longest)
    await sandbox.waitForLog('[Sandbox] sandboxView.render: the view refused a render: the view would hold more than 1048576 characters; nothing of it was applied.', 30000);
});

test('R1-2: 43 000 <wbr> elements (within the element budget) leave the host page responsive (Firefox stalled about 20 s)', async ({ sandbox, page, browserName }) => {
    test.setTimeout(60000);
    await mountEntry(sandbox, `globalThis.wbr = () => { sandboxView.render('<p id="w">' + 'x<wbr>'.repeat(43000) + '</p>'); console.log('R12 rendered'); };`);
    // one operation, so not a share: its stall, against the bound docs/API.md states for one operation, (b)
    // (VIEW_MAX_OPERATION_MS; a second past it within VIEW_OVERRUN_WINDOW_MS ends the sandbox). A share over one window
    // after it measured the machine: 61% on a machine at load average 18, against 1% idle
    await startLag(page);
    const started = Date.now();
    await sandbox.run('wbr()');
    // from the render to its layout (unbounded, Firefox lays out 43 000 <wbr> in about 23 s)
    await waitInView(page, browserName, `!!document.getElementById('w') && document.getElementById('w').getBoundingClientRect().height > 0`, 40000);
    const shown = Date.now() - started;
    await page.waitForTimeout(500);
    const stall = await lag(page);
    console.log(`MEASURED ${browserName} R1-2 after rendering 43 000 <wbr>: the host page's longest stall ${stall} ms; shown after ${shown} ms`);
    expect(stall).toBeLessThan(VIEW_MAX_OPERATION_MS);
    expect(await sandbox.state()).toBe('ready');
    expect(shown).toBeLessThan(5000);
    expect(await inView<number>(page, browserName, `document.getElementsByTagName('wbr').length`)).toBe(0);
    expect(await inView<number>(page, browserName, `document.getElementById('w').textContent.length`)).toBe(43000); // unwrapped: the text stays
});

// R3:C-2: the time budget charges only the rendering a view measured after a flush (in-sandbox-view.ts, the gap meter),
// not the wall time to the next animation frame from a callback queued per flush. A hidden or off-screen view runs no
// frame, so every flush meanwhile would leave a callback that, once the view showed again, charged its whole age: hidden
// 5 s with one render applied meanwhile, the next render would wait 18.3 s (Chromium under display:none and off-screen,
// Firefox under display:none, WebKit off-screen).
const HIDINGS: [string, string, string][] = [
    ['display:none', `el.style.display = 'none'`, `el.style.display = ''`],
    ['off-screen', `el.style.marginTop = '20000px'`, `el.style.marginTop = ''`],
];

test.describe('C-2: a view hidden for 5 s, with a render applied meanwhile, applies the next render at once when shown', () => {
    for (const [name, hide, show] of HIDINGS) {
        test(name, async ({ sandbox, page, browserName }) => {
            test.setTimeout(60000);
            await mountEntry(sandbox, `sandboxView.render('<p id="a">0</p>'); globalThis.show = (n) => sandboxView.text('a', String(n));`);
            await waitInView(page, browserName, `document.getElementById('a') && document.getElementById('a').textContent === '0'`);
            const style = (code: string) => page.evaluate((source) => new Function('el', source)(document.querySelector('web-sandbox')), code);
            await style(hide);
            const hidden = Date.now();
            await page.waitForTimeout(300);
            await sandbox.run('show(1)');
            await waitInView(page, browserName, `document.getElementById('a').textContent === '1'`, 3000); // applied while hidden
            await page.waitForTimeout(Math.max(0, 5000 - (Date.now() - hidden)));
            await style(show);
            await page.waitForTimeout(500); // the frames resume
            const started = Date.now();
            await sandbox.run('show(2)');
            await waitInView(page, browserName, `document.getElementById('a').textContent === '2'`, 30000);
            const applied = Date.now() - started;
            console.log(`MEASURED ${browserName} C-2 ${name}: the render after showing applied in ${applied} ms`);
            expect(applied).toBeLessThan(1500);
        });
    }
});

// R3:M-5: the time budget charges the rendering it measured, in full, not less one frame's length per flush (the wait
// to the next frame past 16.7 ms), which let a flood of operations whose rendering takes long take 22–25% of the host
// page's thread against its 20% budget. Re-rendering 37 449 empty elements
// without pause, as in R2:M-3's flood: the host page's busy share stays within the budget, 20%, plus the
// measure's margin, 10 points (a 10 ms interval on a shared machine; docs/API.md).
test('M-5: under a flood of re-renders the view takes about its budget of the host page, not more', async ({ sandbox, page, browserName }) => {
    test.setTimeout(90000);
    await mountEntry(sandbox, `
        sandboxView.render('<div id="a"></div>');
        globalThis.flood = () => {
            const html = '<i></i>'.repeat(37449);
            const end = Date.now() + 14000;
            const timer = setInterval(() => {
                sandboxView.render(html, 'a');
                if (Date.now() > end) { clearInterval(timer); console.log('M5 flood done'); }
            }, 5);
        };`);
    await page.waitForTimeout(300);
    const share = await busyShare(page, () => sandbox.run('flood()'), undefined, 2000);
    await sandbox.waitForLog('M5 flood done', 30000);
    console.log(`MEASURED ${browserName} M-5 under the flood: ${describeShare(share)}`);
    expect(share.busy).toBeLessThanOrEqual(viewBound(false));
});
