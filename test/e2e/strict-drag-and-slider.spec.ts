import { test, expect } from './fixture';
import { inView, waitInView } from './strict-view';
import { boxOf, drain, mountInput, sleep } from './view-input';

/**
 * Strict mode's in-view drag and custom controls (research 23), on every engine, built from guest code in the worker
 * only: the view captures the pointer for the guest (pointerCapture), tells it its elements' rectangles (rect), and the
 * guest moves elements with set({ css }):
 *   1. a drag: the thumb follows the pointer through set({ css: { transform } }), and keeps receiving the moves after
 *      the pointer has left it (captured); a native drag of the link inside it does not take the gesture;
 *   2. a custom slider: the value follows the pointer over the track, clamped at its ends, also past the view's edge;
 *   3. set({ css }) names only VIEW_STYLE_PROPERTIES: anything else is a TypeError in the guest.
 */

const DRAG = '<div id="pad" style="position:absolute;inset:0;touch-action:none;user-select:none">'
    + '<div id="thumb" style="position:absolute;left:20px;top:20px;width:40px;height:40px;background:#c33"><a id="grip" href="#">grip</a></div></div>'
    + '<p id="ready" style="position:absolute;left:0;bottom:0;margin:0">ready</p>';

test('a drag: the thumb follows the pointer through set({ css }), captured, and a native drag inside it does not take the gesture', async ({ sandbox, page, browserName }) => {
    await mountInput(sandbox, browserName, `
        let start = null;
        sandboxView.on('pointerdown', 'thumb', (d) => { kept.push({ label: 'down', detail: d }); start = { x: d.pointer.x, y: d.pointer.y }; }, { pointerCapture: true, rect: true });
        sandboxView.on('pointermove', 'thumb', (d) => {
            if (!start) return;
            sandboxView.set('thumb', { css: { transform: 'translate(' + (d.pointer.x - start.x) + 'px, ' + (d.pointer.y - start.y) + 'px)' } });
        });
        sandboxView.on('pointerup', 'thumb', (d) => { kept.push({ label: 'up', detail: d }); start = null; });
        sandboxView.on('pointercancel', null, (d) => kept.push({ label: 'cancel', detail: d }));`, DRAG);
    const box = await boxOf(page);
    await page.mouse.move(box.x + 30, box.y + 30); // on the grip, a link
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) { await page.mouse.move(box.x + 30 + i * 8, box.y + 30 + i * 5); await sleep(16); }
    await page.mouse.up();
    await waitInView(page, browserName, `(() => { const r = document.getElementById('thumb').getBoundingClientRect(); return r.left === 180 && r.top === 120; })()`, 8000);
    const kept = await drain(sandbox);
    expect(kept.map(k => k.label)).toEqual(['down', 'up']); // no pointercancel: no native drag took it
    expect(kept[0]!.detail.box).toEqual({ x: 20, y: 20, width: 40, height: 40 });
    expect(kept[1]!.detail.ids).toEqual(['thumb', 'pad']); // the release went to the captured thumb, though the pointer was far from it
    expect(await inView(page, browserName, `document.getElementById('thumb').getAttribute('style')`)).toContain('transform: translate(160px, 100px)');
});

test('a custom slider: the value follows the pointer over the track, clamped at its ends, also past the edge of the view', async ({ sandbox, page, browserName }) => {
    const SLIDER = '<div id="track" style="position:absolute;left:50px;top:100px;width:300px;height:20px;background:#ddd;touch-action:none">'
        + '<div id="knob" style="position:absolute;left:0;top:0;width:10px;height:20px;background:#33c"></div></div>'
        + '<output id="out" style="position:absolute;left:0;top:0">0</output><p id="ready" style="position:absolute;left:0;bottom:0;margin:0">ready</p>';
    await mountInput(sandbox, browserName, `
        let dragging = false;
        const to = (d) => {
            const value = Math.round(Math.min(1, Math.max(0, (d.pointer.x - d.box.x) / d.box.width)) * 100);
            sandboxView.set('knob', { css: { left: (value * 2.9) + 'px' } });
            sandboxView.text('out', String(value));
            kept.push({ label: 'value', detail: { value, box: d.box } });
        };
        sandboxView.on('pointerdown', 'track', (d) => { dragging = true; to(d); }, { pointerCapture: true, rect: true });
        sandboxView.on('pointermove', 'track', (d) => { if (dragging) to(d); }, { rect: true });
        sandboxView.on('pointerup', 'track', () => { dragging = false; });`, SLIDER);
    const box = await boxOf(page);
    await page.mouse.move(box.x + 125, box.y + 110); // a quarter along the track
    await page.mouse.down();
    await waitInView(page, browserName, `document.getElementById('out').textContent === '25'`);
    for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x + 125 + i * 40, box.y + 110 + i * 3); await sleep(16); } // past the track, and past the view
    await waitInView(page, browserName, `document.getElementById('out').textContent === '100'`);
    for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x + 500 - i * 60, box.y + 140); await sleep(16); } // back, past the start
    await page.mouse.up();
    await waitInView(page, browserName, `document.getElementById('out').textContent === '0'`);
    const values = (await drain(sandbox)).map(k => k.detail);
    expect(values[0]!.box).toEqual({ x: 50, y: 100, width: 300, height: 20 });
    expect(Math.max(...values.map(v => v.value))).toBe(100);
    expect(await inView(page, browserName, `document.getElementById('knob').style.left`)).toBe('0px');
});

test('set({ css }) names only VIEW_STYLE_PROPERTIES and takes strings: anything else is a TypeError in the guest', async ({ sandbox, browserName }) => {
    await mountInput(sandbox, browserName, '', DRAG);
    const r = await sandbox.inGuest(`
        const attempt = (css) => { try { sandboxView.set('thumb', { css }); return 'ok'; } catch (e) { return e.name; } };
        return [attempt({ 'background-image': 'url(https://example.com/x.png)' }), attempt({ animation: 'spin 1s infinite' }), attempt({ position: 'fixed' }),
            attempt({ opacity: 1 }), attempt({ '--x': 'y'.repeat(1025) }), attempt({ opacity: '0.5', '--x': '1', cursor: 'grab' })];
    `);
    expect(r).toEqual(['TypeError', 'TypeError', 'TypeError', 'TypeError', 'RangeError', 'ok']);
    await waitInView(sandbox.page, browserName, `document.getElementById('thumb').style.opacity === '0.5'`);
});
