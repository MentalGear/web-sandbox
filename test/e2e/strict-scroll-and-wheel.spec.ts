import { test, expect } from './fixture';
import { inView, waitInView } from './strict-view';
import { boxOf, mountInput, sleep, take, type Kept } from './view-input';

/**
 * Strict mode's wheel and scroll input, and set({ scroll }) (research 23), on every engine:
 *   1. wheel: the deltas of the events a frame coalesced are summed, per element and unit, with where the pointer was;
 *   2. a virtual list: the guest renders the rows of the visible range from its scroll events, and jumps with
 *      set({ scroll }), which scrolls that element only, never the view's document nor the host page;
 *   3. a guest that answers its own scroll events with set({ scroll }) loops at most once per animation frame: the
 *      scroll event that set raises is trusted, and coalesced like the user's.
 */

const LIST = '<div id="list" style="position:absolute;left:0;top:0;width:300px;height:200px;overflow:auto"><div id="spacer" style="position:relative;height:200000px"><div id="rows"></div></div></div><p id="ready" style="position:absolute;left:0;bottom:0;margin:0">ready</p>';
const VIRTUAL = `
    const ROW = 20;
    let first = -1;
    const show = (top) => {
        const start = Math.floor(top / ROW);
        if (start === first) return;
        first = start;
        let rows = '';
        for (let i = start; i < start + 12; i++) rows += '<div style="height:20px">row ' + i + '</div>';
        sandboxView.render('<div id="win" style="position:absolute;left:0;right:0;top:' + start * ROW + 'px">' + rows + '</div>', 'rows');
    };
    show(0);
    sandboxView.on('scroll', 'list', (detail) => { kept.push({ label: 'scroll', detail }); show(detail.scroll.top); });
    bridge.expose('jump', (top) => { sandboxView.set('list', { scroll: { top } }); return true; });`;

test('wheel: the deltas of what a frame coalesced are summed, with the pointer where it was', async ({ sandbox, page, browserName }) => {
    await mountInput(sandbox, browserName, `sandboxView.on('wheel', 'pad', keep('wheel'));`);
    const box = await boxOf(page);
    await page.mouse.move(box.x + 50, box.y + 60);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 100);
    await sleep(800);
    const wheels: Kept[] = [];
    for (;;) { const k = await take(sandbox); if (k.length === 0) break; wheels.push(...k); await sleep(100); }
    expect(wheels.length).toBeGreaterThan(0);
    const first = wheels[0]!.detail;
    expect(Object.keys(first).sort()).toEqual(['coalesced', 'ids', 'modifiers', 'pointer', 'target', 'time', 'type', 'wheel']);
    expect(first.pointer).toEqual({ x: 50, y: 60 });
    expect(first.ids).toEqual(['pad']);
    const units = new Set(wheels.map(k => k.detail.wheel.unit));
    expect(units.size).toBe(1);
    const dy = wheels.reduce((n, k) => n + k.detail.wheel.dy, 0);
    const raw = wheels.reduce((n, k) => n + k.detail.coalesced, 0);
    expect(raw).toBe(6);
    if (units.has('pixel')) expect(dy).toBe(600);
    else expect(dy).toBeGreaterThan(0);
    test.info().annotations.push({ type: 'measured', description: `${browserName}: ${wheels.length} wheel details for 6 wheel events, unit ${[...units][0]}, dy ${dy}` });
});

test('a virtual list: scroll events drive what the guest renders; set({ scroll }) scrolls that element only, never the view nor the host page', async ({ sandbox, page, browserName }) => {
    await page.evaluate(() => { document.body.style.height = '5000px'; }); // a host page that could scroll
    await mountInput(sandbox, browserName, VIRTUAL, LIST);
    const box = await boxOf(page);
    await page.mouse.move(box.x + 100, box.y + 100);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 400);
    // the rows shown follow the list's scroll position, once it rests
    const shownMatches = `(() => { const list = document.getElementById('list'); const win = document.getElementById('win'); return list.scrollTop > 0 && !!win && win.firstChild.textContent === 'row ' + Math.floor(list.scrollTop / 20); })()`;
    await waitInView(page, browserName, shownMatches, 8000);
    const scrolled = await take(sandbox);
    expect(scrolled.length).toBeGreaterThan(0);
    const last = scrolled[scrolled.length - 1]!.detail;
    expect(Object.keys(last).sort()).toEqual(['coalesced', 'ids', 'scroll', 'target', 'time', 'type']);
    expect(last.ids).toEqual(['list']);
    expect(last.scroll).toMatchObject({ height: 200000, clientHeight: 200 });
    expect(await page.evaluate(() => scrollY)).toBe(0); // the wheel over the list scrolled the list, not the host page

    // the guest jumps: that element scrolls, the scroll event it raises re-renders the window
    expect(await sandbox.call('jump', 5000)).toBe(true);
    await waitInView(page, browserName, `(() => { const win = document.getElementById('win'); return !!win && win.firstChild.textContent === 'row 250'; })()`, 8000);
    expect(await inView(page, browserName, `[document.getElementById('list').scrollTop, document.scrollingElement.scrollTop, scrollY]`)).toEqual([5000, 0, 0]);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await sandbox.state()).toBe('ready');
});

test("a guest that answers its own scroll events with set({ scroll }) loops at most once per animation frame", async ({ sandbox, page, browserName }) => {
    await mountInput(sandbox, browserName, `
        let n = 0;
        sandboxView.on('scroll', 'list', (detail) => { n++; sandboxView.set('list', { scroll: { top: detail.scroll.top > 50 ? 0 : 100 } }); });
        bridge.expose('count', () => n);
        bridge.expose('start', () => { sandboxView.set('list', { scroll: { top: 100 } }); return true; });`, LIST);
    await inView(page, browserName, `(() => { globalThis.__frames = 0; const tick = () => { globalThis.__frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
    expect(await sandbox.call('start')).toBe(true);
    await sleep(500);
    const before = { n: await sandbox.call<number>('count'), frames: await inView<number>(page, browserName, 'globalThis.__frames') as number };
    await sleep(2000);
    const after = { n: await sandbox.call<number>('count'), frames: await inView<number>(page, browserName, 'globalThis.__frames') as number };
    const loops = after.n - before.n;
    const frames = after.frames - before.frames;
    expect(loops).toBeGreaterThan(5); // it does loop
    expect(loops).toBeLessThanOrEqual(frames + 2); // and at most once a frame
    expect(await sandbox.state()).toBe('ready');
    test.info().annotations.push({ type: 'measured', description: `${browserName}: ${loops} scroll answers in 2 s, ${frames} frames` });
});
