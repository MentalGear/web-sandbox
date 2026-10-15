import { test, expect, type SandboxDriver } from './fixture';
import { inView, waitInView } from './strict-view';
import type { Page } from '@playwright/test';

/**
 * The strict view's budget (review round 1, R1-1 and R1-2; ADR-005 amendment 2026-10-15). The view runs on the host
 * page's thread in Firefox and WebKit, and in Chromium depending on its process model, so what it renders is host work.
 * Bounded now by construction, and measured from the host page (ticks of a 10 ms interval, idle against loaded):
 *   - the characters the view holds, text, comments and attributes alike (its body's serialization), counted over the
 *     document a render would leave, like elements (VIEW_MAX_CHARACTERS);
 *   - the characters the view applies per second (VIEW_RENDER_CHARACTERS_PER_SECOND): a render past it waits, and the
 *     worker's next render waits for it (flow control), so a guest cannot keep the host busy with renders that fit;
 *   - no element whose layout cost grows faster than the markup (Firefox's line breaking over <wbr>: 43 000 of them
 *     stalled its host about 20 s).
 * Each test failed at 5ede7ba.
 */

const countTicks = (page: Page, ms = 2500) => page.evaluate((duration) => new Promise<number>(resolve => {
    let count = 0;
    const timer = setInterval(() => count++, 10);
    setTimeout(() => { clearInterval(timer); resolve(count); }, duration);
}), ms);

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
    const idle = await countTicks(page);
    await sandbox.run('flood()');
    const loaded = await countTicks(page);
    await sandbox.waitForLog('R11 flood done', 20000);
    const held = await inView<number>(page, browserName, 'document.body.innerHTML.length');
    console.log(`MEASURED ${browserName} R1-1 host ticks in 2.5 s: idle ${idle}, during the render flood ${loaded}; view characters ${held}`);
    expect(loaded).toBeGreaterThan(idle * 0.5);
    expect(held).toBeLessThanOrEqual(4 * 262144);
    // renders past the budget were refused, acknowledged, and said in the guest's log
    expect(await sandbox.logs()).toContain('[Sandbox] sandboxView.render: the view refused a render: the view would hold more than 1048576 characters; nothing of it was applied.');
});

test('R1-2: 43 000 <wbr> elements (within the element budget) leave the host page responsive (Firefox stalled about 20 s)', async ({ sandbox, page, browserName }) => {
    test.setTimeout(60000);
    await mountEntry(sandbox, `globalThis.wbr = () => { sandboxView.render('<p id="w">' + 'x<wbr>'.repeat(43000) + '</p>'); console.log('R12 rendered'); };`);
    const idle = await countTicks(page, 2000);
    const started = Date.now();
    await sandbox.run('wbr()');
    const loaded = await countTicks(page, 2000);
    // from the render to its layout: Firefox laid out 43 000 <wbr> in about 23 s at 5ede7ba
    await waitInView(page, browserName, `!!document.getElementById('w') && document.getElementById('w').getBoundingClientRect().height > 0`, 40000);
    const shown = Date.now() - started;
    console.log(`MEASURED ${browserName} R1-2 host ticks in 2 s: idle ${idle}, after rendering 43 000 <wbr> ${loaded}; shown after ${shown} ms`);
    expect(loaded).toBeGreaterThan(idle * 0.5);
    expect(shown).toBeLessThan(5000);
    expect(await inView<number>(page, browserName, `document.getElementsByTagName('wbr').length`)).toBe(0);
    expect(await inView<number>(page, browserName, `document.getElementById('w').textContent.length`)).toBe(43000); // unwrapped: the text stays
});
