import { test, expect } from './fixture';
import { inView } from './strict-view';
import { boxOf, mountInput, sleep, take, type Kept } from './view-input';

/**
 * Strict mode's pointer input (research 23), on every engine. The worker subscribes with sandboxView.on() and the view
 * forwards trusted events only, their coordinates clamped to its box, the continuous ones coalesced:
 *   1. the schema: pointer { x, y, id, kind, primary, button, buttons, pressure }, modifiers, time, and `coalesced` on a
 *      move; numbers and constants only; the last move before a release arrives before the pointerup;
 *   2. only trusted events: pointer events dispatched by script in the view (DevTools; no guest script runs there) are
 *      not forwarded, a real press is (positive control);
 *   3. a drag that leaves the view: every coordinate the guest receives is inside the view's box, and nothing arrives
 *      once the button is released, nor from the host page's own moves;
 *   4. coalescing: a burst of moves reaches the guest at most once per animation frame, standing for all of them;
 *   5. flow control: a handler that blocks gets one more frame when it returns, holding only the latest position.
 * Evidence: what the worker's handlers received (kept in the worker, read through the bridge), trusted input from
 * Playwright's mouse, and the view read from outside (strict-view.ts).
 */


test('the schema: a press, a drag and a release, in order, with numbers and constants only', async ({ sandbox, page, browserName }) => {
    await mountInput(sandbox, browserName, `for (const type of ['pointerdown', 'pointermove', 'pointerup']) sandboxView.on(type, 'thumb', keep(type));`);
    const box = await boxOf(page);
    await page.mouse.move(box.x + 30, box.y + 30);
    await sleep(300);
    await take(sandbox); // the hover move
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 45, { steps: 4 });
    await page.mouse.up();
    let kept: Kept[] = [];
    await expect.poll(async () => { kept.push(...await take(sandbox)); return kept.some(k => k.label === 'pointerup'); }).toBe(true);
    const labels = kept.map(k => k.label);
    expect(labels[0]).toBe('pointerdown');
    expect(labels[labels.length - 1]).toBe('pointerup');
    expect(labels.filter(l => l === 'pointermove').length).toBeGreaterThan(0);
    const down = kept[0]!.detail;
    expect(down).toEqual({
        type: 'pointerdown', ids: ['thumb', 'pad'], target: { tag: 'div', id: 'thumb', name: '', value: '', checked: false },
        pointer: { x: 30, y: 30, id: down.pointer.id, kind: 'mouse', primary: true, button: 0, buttons: 1, pressure: 0.5 },
        modifiers: { alt: false, ctrl: false, meta: false, shift: false }, time: down.time,
    });
    expect(Number.isInteger(down.time) && Number.isInteger(down.pointer.id)).toBe(true);
    const moves = kept.filter(k => k.label === 'pointermove').map(k => k.detail);
    for (const move of moves) {
        expect(Object.keys(move).sort()).toEqual(['coalesced', 'ids', 'modifiers', 'pointer', 'target', 'time', 'type']);
        expect(move.coalesced).toBeGreaterThanOrEqual(1);
        expect(move.pointer.buttons).toBe(1);
    }
    expect(moves[moves.length - 1].pointer).toMatchObject({ x: 40, y: 45 }); // the last move, before the release
    expect(kept[kept.length - 1]!.detail.pointer).toMatchObject({ x: 40, y: 45, button: 0, buttons: 0 });
});

test('only trusted pointer events are forwarded: ones dispatched by script in the view are not; a real press is (positive control)', async ({ sandbox, page, browserName }) => {
    await mountInput(sandbox, browserName, `for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) sandboxView.on(type, null, keep(type));`);
    await inView(page, browserName, `(() => {
        const thumb = document.getElementById('thumb');
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) thumb.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 5, clientY: 5, pointerId: 1 }));
        return true;
    })()`);
    await sleep(500);
    expect(await take(sandbox)).toEqual([]);
    const box = await boxOf(page);
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await expect.poll(async () => (await take(sandbox)).map(k => k.label)).toContain('pointerdown');
    await page.mouse.up();
});

test('a drag that leaves the view: every coordinate the guest gets is inside its box; nothing after the release, nothing from the host page', async ({ sandbox, page, browserName }) => {
    await mountInput(sandbox, browserName, `for (const type of ['pointerdown', 'pointermove', 'pointerup']) sandboxView.on(type, null, keep(type));`);
    const box = await boxOf(page);
    const { width, height } = await inView<{ width: number; height: number }>(page, browserName, '({ width: innerWidth, height: innerHeight })') as { width: number; height: number };
    // the host page's own moves, no button held: around the box, never over it
    for (let i = 0; i < 10; i++) { await page.mouse.move(box.x + box.width + 20 + i * 5, box.y + 10 + i * 8); await sleep(20); }
    await sleep(300);
    expect(await take(sandbox)).toEqual([]);
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) { await page.mouse.move(box.x + 100 + i * 30, box.y + 100 + i * 20); await sleep(20); } // far past the right and bottom edges
    for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x - 10 - i * 10, box.y - 5 - i * 10); await sleep(20); } // past the left and top
    await page.mouse.up();
    await sleep(200);
    const pressed = [];
    for (;;) { const k = await take(sandbox); if (k.length === 0) break; pressed.push(...k); await sleep(200); }
    // released outside: nothing more, however the pointer moves
    for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x + box.width + 50 + i * 5, box.y + 80); await sleep(20); }
    await sleep(400);
    expect(await take(sandbox)).toEqual([]);
    expect(pressed.map(k => k.label)).toContain('pointerdown');
    const points = pressed.map(k => k.detail.pointer as { x: number; y: number });
    for (const point of points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(width);
        expect(point.y).toBeLessThanOrEqual(height);
    }
    // the drag reached the edges, clamped there: the guest knows only the projection onto its own box
    const moves = pressed.filter(k => k.label === 'pointermove').map(k => k.detail.pointer);
    expect(moves.some(p => p.x === width || p.y === height)).toBe(true);
});

test('a burst of moves reaches the guest at most once per animation frame, each detail standing for the raw moves it coalesced', async ({ sandbox, page, browserName }) => {
    await mountInput(sandbox, browserName, `sandboxView.on('pointermove', null, keep('move'));`);
    const box = await boxOf(page);
    await page.mouse.move(box.x + 10, box.y + 10);
    await sleep(300);
    await take(sandbox);
    await inView(page, browserName, `(() => { globalThis.__frames = 0; globalThis.__raw = 0; const tick = () => { globalThis.__frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); addEventListener('pointermove', () => { globalThis.__raw++; }, true); return true; })()`);
    const started = Date.now();
    await page.mouse.move(box.x + 380, box.y + 280, { steps: 400 });
    await sleep(400);
    const ms = Date.now() - started;
    const { frames, raw } = await inView<{ frames: number; raw: number }>(page, browserName, '({ frames: globalThis.__frames, raw: globalThis.__raw })') as { frames: number; raw: number };
    const moves: Kept[] = [];
    for (;;) { const k = await take(sandbox); if (k.length === 0) break; moves.push(...k); }
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.length).toBeLessThanOrEqual(frames + 2); // one frame of events a frame at most, while it ran
    expect(moves.reduce((n, k) => n + k.detail.coalesced, 0)).toBe(raw); // and every raw move is counted
    expect(moves[moves.length - 1]!.detail.pointer).toMatchObject({ x: 380, y: 280 });
    test.info().annotations.push({ type: 'measured', description: `${browserName}: ${raw} raw moves in the view, ${moves.length} forwarded over ${ms} ms, ${frames} frames` });
});

test('flow control: a handler that blocks 2 s gets one more frame when it returns, holding only the latest position', async ({ sandbox, page, browserName }) => {
    test.setTimeout(60000);
    await mountInput(sandbox, browserName, `
        let first = true;
        sandboxView.on('pointermove', null, (detail) => {
            kept.push({ label: 'move', detail });
            if (!first) return;
            first = false;
            const until = Date.now() + 2000;
            while (Date.now() < until) {}
        });`);
    const box = await boxOf(page);
    await page.mouse.move(box.x + 10, box.y + 10); // the first move: its handler blocks
    await sleep(200);
    for (let i = 1; i <= 30; i++) { await page.mouse.move(box.x + 10 + i * 10, box.y + 10 + i * 5); await sleep(30); }
    await sleep(3000);
    const moves = await take(sandbox);
    expect(moves.length).toBeGreaterThanOrEqual(2);
    // what was raised while the handler blocked arrived as one frame: the latest position, standing for the others
    const after = moves.slice(1);
    expect(after.length).toBeLessThanOrEqual(2);
    expect(after[after.length - 1]!.detail.pointer).toMatchObject({ x: 310, y: 160 });
    expect(after.reduce((n, k) => n + k.detail.coalesced, 0)).toBeGreaterThan(5);
    expect(await sandbox.state()).toBe('ready');
});
