import type { Page } from '@playwright/test';
import { test, expect, type SandboxDriver } from './fixture';

/**
 * Content auto-sizing (backlog B6): with `autoResize: true` the element's height follows the guest's content
 * height; reports are validated, clamped and rate-limited on the host (src/lib/auto-resize.ts).
 * Reports are guest-supplied, so the refusals below forge them from inside the guest, on the real port.
 */

const MAX_HEIGHT = 100000;
const MAX_UPDATES_PER_SECOND = 30;

// A guest whose content height the host can set through the bridge; answers the root's resulting height.
const RESIZABLE = `<div id="box" style="height:200px"></div><script>
bridge.expose('setHeight', (h) => { document.getElementById('box').style.height = h + 'px'; return document.documentElement.getBoundingClientRect().height; });
</script>`;

// A guest that reports once and then stays put: with no scrollbars, a forged height cannot change its
// root's box, so its own observer stays quiet and every later write comes from a forged report.
const STILL = `<style>html { overflow: hidden }</style><div style="height:200px"></div>`;

const elementHeight = (page: Page) => page.evaluate(() => (document.querySelector('web-sandbox') as HTMLElement).getBoundingClientRect().height);
const inlineHeight = (page: Page) => page.evaluate(() => (document.querySelector('web-sandbox') as HTMLElement).style.height);

// Guest code can reach the port: it catches the bootstrap's own postMessage through the prototype.
async function capturePort(sandbox: SandboxDriver) {
    expect(await sandbox.inGuest(`
        const original = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (...args) { globalThis.__port = this; return original.apply(this, args); };
        console.log('capturing the port');
        MessagePort.prototype.postMessage = original;
        return typeof globalThis.__port;
    `)).toBe('object');
}

// Records every inline height the host writes on the element, from now on.
async function recordWrites(page: Page) {
    await page.evaluate(() => {
        const el = document.querySelector('web-sandbox') as HTMLElement;
        (window as any).heightWrites = [];
        new MutationObserver(() => (window as any).heightWrites.push(el.style.height)).observe(el, { attributes: true, attributeFilter: ['style'] });
    });
}
const writes = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as any).heightWrites]);

test('the element height follows the content as it grows and shrinks, a few frames after the change', async ({ sandbox, page }) => {
    expect(await sandbox.mount({ autoResize: true, html: RESIZABLE })).toBe('ready');
    await expect.poll(() => elementHeight(page)).toBe(216); // 200px of content plus the body's 8px margins

    for (const height of [600, 100, 1500, 40, 900]) {
        const outcome = await page.evaluate(async (height) => {
            const el = document.querySelector('web-sandbox') as any;
            const expected = Math.ceil(await el.call('setHeight', height));
            // Host frames from the call's answer to the new height: the call's own return trip, one guest
            // rendering update for the observer, one host frame for the write (measured: 2 to 4).
            let frames = 0;
            while (el.getBoundingClientRect().height !== expected && frames < 60) {
                await new Promise(resolve => requestAnimationFrame(resolve));
                frames++;
            }
            return { expected, actual: el.getBoundingClientRect().height, frames };
        }, height);
        expect(outcome.actual, `content ${height}px`).toBe(outcome.expected);
        expect(outcome.frames, `content ${height}px`).toBeLessThanOrEqual(6);
    }
});

test('off by default: the element keeps its CSS height, and a forged report does nothing', async ({ sandbox, page }) => {
    expect(await sandbox.mount({ html: '<div style="height:2000px"></div>' })).toBe('ready');
    await capturePort(sandbox);
    await recordWrites(page);
    await sandbox.inGuest(`globalThis.__port.postMessage({ type: 'RESIZE', height: 1234 }); return true;`);
    await page.waitForTimeout(300);

    expect(await writes(page)).toEqual([]);
    expect(await inlineHeight(page)).toBe('');
    expect(await elementHeight(page)).toBe(300); // the harness CSS
});

test('malformed reports are dropped, fractions round up and huge ones are clamped', async ({ sandbox, page }) => {
    expect(await sandbox.mount({ autoResize: true, html: STILL })).toBe('ready');
    await expect.poll(() => inlineHeight(page)).toBe('216px');
    await capturePort(sandbox);
    await recordWrites(page);

    // One at a time, each given longer than the rate cap and a few frames to be (wrongly) written.
    const malformed = [`-1`, `NaN`, `Infinity`, `-Infinity`, `'500'`, `null`, `undefined`, `{}`, `[400]`, `true`, `400n`];
    for (const value of malformed) {
        await sandbox.inGuest(`globalThis.__port.postMessage({ type: 'RESIZE', height: ${value} }); return true;`);
        await page.waitForTimeout(150);
    }
    await sandbox.inGuest(`globalThis.__port.postMessage({ type: 'RESIZE' }); globalThis.__port.postMessage({ type: 'RESIZE', heigth: 400 }); return true;`);
    await page.waitForTimeout(150);
    expect(await writes(page), 'a malformed report was written').toEqual([]);

    // positive control on the same path: valid reports are written, validated
    await sandbox.inGuest(`globalThis.__port.postMessage({ type: 'RESIZE', height: 123.2 }); return true;`);
    await expect.poll(() => inlineHeight(page)).toBe('124px');
    await sandbox.inGuest(`globalThis.__port.postMessage({ type: 'RESIZE', height: 1e12 }); return true;`);
    await expect.poll(() => inlineHeight(page)).toBe(`${MAX_HEIGHT}px`);
    expect(await elementHeight(page)).toBe(MAX_HEIGHT);
    expect(await writes(page)).toEqual(['124px', `${MAX_HEIGHT}px`]);
});

test('a flood of forged reports costs at most one write per frame and 30 per second, and the last report wins', async ({ sandbox, page }) => {
    expect(await sandbox.mount({ autoResize: true, html: STILL })).toBe('ready');
    await expect.poll(() => inlineHeight(page)).toBe('216px');
    await capturePort(sandbox);
    await recordWrites(page);
    await page.evaluate(() => {
        (window as any).hostFrames = 0;
        const tick = () => { (window as any).hostFrames++; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    });
    const started = await page.evaluate(() => performance.now());

    // For at least a second and 10 000 reports, bursts of 200 every few milliseconds, every one a new height
    // (so every host frame finds a new one waiting), then one last height.
    const sent: number = await sandbox.inGuest(`
        let n = 0;
        const end = performance.now() + 1000;
        while (performance.now() < end || n < 10000) {
            for (let i = 0; i < 200; i++) globalThis.__port.postMessage({ type: 'RESIZE', height: 1000 + (n++ % 4000) });
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        globalThis.__port.postMessage({ type: 'RESIZE', height: 777 });
        return n;
    `);
    expect(sent).toBeGreaterThanOrEqual(10000);
    await expect.poll(() => inlineHeight(page)).toBe('777px');
    const { elapsed, frames } = await page.evaluate((started) => ({ elapsed: performance.now() - started, frames: (window as any).hostFrames }), started);
    const written = await writes(page);

    expect(written.at(-1)).toBe('777px');
    expect(written.length, `${written.length} writes in ${Math.round(elapsed)} ms`).toBeLessThanOrEqual(Math.ceil(elapsed / 1000 * MAX_UPDATES_PER_SECOND) + 1);
    expect(written.length, `${written.length} writes in ${frames} host frames`).toBeLessThanOrEqual(frames + 1);
});

test('a guest whose height oscillates every frame does not starve the host', async ({ sandbox, page }) => {
    // Each observer callback flips the content between two heights, so every rendering update reports a new one.
    expect(await sandbox.mount({ autoResize: true, html: `<div id="box"></div><script>
        let tall = false;
        const box = document.getElementById('box');
        new ResizeObserver(() => { tall = !tall; box.style.height = tall ? '2000px' : '100px'; }).observe(document.documentElement);
    </script>` })).toBe('ready');
    await expect.poll(() => inlineHeight(page)).not.toBe('');
    await recordWrites(page);

    // The host's own work during two seconds of oscillation: frames, and the longest gap between timer ticks.
    const host = await page.evaluate(() => new Promise<{ frames: number; longestGap: number }>(resolve => {
        let frames = 0;
        let last = performance.now();
        let longestGap = 0;
        const tick = () => { frames++; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        const timer = setInterval(() => {
            const now = performance.now();
            longestGap = Math.max(longestGap, now - last);
            last = now;
        }, 10);
        setTimeout(() => { clearInterval(timer); resolve({ frames, longestGap }); }, 2000);
    }));
    const written = await writes(page);

    expect(written.length, 'the guest really oscillated').toBeGreaterThan(10);
    expect(written.length).toBeLessThanOrEqual(2 * MAX_UPDATES_PER_SECOND + 1);
    expect(host.frames, 'host frames in 2 s').toBeGreaterThan(20);
    expect(host.longestGap, 'longest gap between host timer ticks (ms)').toBeLessThan(500);
});

test('reset() keeps the height until the new guest reports; turning autoResize off gives the height back to CSS', async ({ sandbox, page }) => {
    expect(await sandbox.mount({ autoResize: true, html: RESIZABLE })).toBe('ready');
    await expect.poll(() => inlineHeight(page)).toBe('216px');
    await sandbox.call('setHeight', 700);
    await expect.poll(() => inlineHeight(page)).toBe('716px');

    // the new guest starts at 200px of content again
    expect(await sandbox.reset()).toBe('ready');
    await expect.poll(() => inlineHeight(page)).toBe('216px');

    expect(await sandbox.mount({ html: RESIZABLE })).toBe('ready');
    expect(await inlineHeight(page)).toBe('');
    expect(await elementHeight(page)).toBe(300);
});

test('worker mode: autoResize has no effect, with one warning per instance', async ({ sandbox, page }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning' && m.text().includes('autoResize')) warnings.push(m.text()); });
    await recordWrites(page);

    expect(await sandbox.mount({ mode: 'worker', autoResize: true })).toBe('ready');
    expect(await sandbox.mount({ mode: 'worker', autoResize: true })).toBe('ready');
    expect(await sandbox.inGuest(`return typeof document`)).toBe('undefined');
    await page.waitForTimeout(300);

    expect(await writes(page)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('worker mode');
});
