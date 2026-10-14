import type { Page } from '@playwright/test';
import { test, expect } from './fixture';
import { useRecorder } from './recorder';

/**
 * `ready` means the guest's startup script checked in (backlog S46; ADR-002 and ADR-003 amendments): the host is
 * ready when it accepts the bootstrap's announcement, not when the wrapper frame has loaded (which waits for the
 * guest document's own subresources). The guest's calls and execute() wait in the guest until its document is
 * parsed (the startup gate, src/lib/in-sandbox-script.ts), so methods its classic scripts expose are there when a
 * call runs. Without allow-scripts no bootstrap runs, and `ready` still comes with the wrapper's load.
 * Evidence (T5): read outside the guest — the host's events, state and timing, the wrapper frame's own load event on
 * the host page, the recorder's listener — with a positive control beside each negative.
 */

const recorder = useRecorder();

const SECOND_LOAD = 'the sandbox frame loaded a second time';
const SECOND_ANNOUNCEMENT = 'the guest frame announced itself again (it reloaded or rewrote its document)';
const LOAD_TIMEOUT = 'the sandbox did not finish loading';

// Builds an environment from `config` (merged over the baseline) and reports, in ms from setConfig(), when 'ready'
// fired and when the wrapper frame's own load event reached the host page, with the state at that load.
async function readyAndLoad(page: Page, config: Record<string, unknown>) {
    return page.evaluate((config) => new Promise<{ readyAt: number; loadedAt: number; stateAtLoad: string; terminated: string | null }>((resolve) => {
        const el = document.querySelector('web-sandbox') as any;
        const started = performance.now();
        let readyAt = -1;
        let terminated: string | null = null;
        el.addEventListener('ready', () => { readyAt = performance.now() - started; }, { once: true });
        el.addEventListener('terminated', (e: CustomEvent) => { terminated = e.detail.reason; }, { once: true });
        el.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true, ...config });
        el.shadowRoot.querySelector('iframe').addEventListener('load', () => {
            resolve({ readyAt, loadedAt: performance.now() - started, stateAtLoad: el.state, terminated });
        }, { once: true });
    }), config);
}

const scriptsFrom = (origin: string) => ({ 'script-src': ["'unsafe-inline'", origin] });

test.describe('S46: ready when the guest checks in', () => {
    test("'ready' fires before a 2 s image has loaded; the image still loads, and the wrapper's load after 'ready' changes nothing (positive control)", async ({ sandbox, page }) => {
        const html = `<script>bridge.expose('image', () => { const i = document.getElementById('slow'); return [i.complete, i.naturalWidth]; });</script><img id="slow" src="${recorder.allowed}/delay?ms=2000">`;
        const report = await readyAndLoad(page, { html, connectionsAllowed: { 'img-src': [recorder.allowed] } });
        expect(report.terminated).toBeNull();
        expect(report.readyAt).toBeGreaterThanOrEqual(0);
        expect(report.loadedAt).toBeGreaterThanOrEqual(1900); // the wrapper's load waited for the image
        expect(report.loadedAt - report.readyAt).toBeGreaterThan(1000); // 'ready' did not
        expect(report.stateAtLoad).toBe('ready');
        await recorder.waitFor('allowed', '/delay?ms=2000');
        expect(await sandbox.call('image')).toEqual([true, 3]); // the image loaded in the guest
        expect(await sandbox.state()).toBe('ready');
    });

    test('a call made before ready and one made at ready reach a method a classic script exposes after a slow-loading script, at the end of the body; execute() runs after the guest\'s scripts', async ({ sandbox, page }) => {
        const html = `<script>bridge.expose('early', () => 'early');</script>`
            + `<script src="${recorder.allowed}/delay.js?ms=1500"></script><p>body</p>`
            + `<script>globalThis.__late = true; bridge.expose('late', () => ({ ran: globalThis.__recorderRan }));</script>`;
        const report = await page.evaluate((config) => new Promise<any>((resolve) => {
            const el = document.querySelector('web-sandbox') as any;
            const started = performance.now();
            el.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true, ...config });
            const queued = settleOutcome(el.call('late'));
            el.execute(`console.log('EXECUTED_AFTER ' + typeof globalThis.__recorderRan + ' ' + (globalThis.__late === true))`);
            el.addEventListener('ready', async () => {
                const readyAt = performance.now() - started;
                const atReady = settleOutcome(el.call('late'));
                const early = settleOutcome(el.call('early'));
                resolve({ readyAt, queued: await queued, atReady: await atReady, early: await early, settledAt: performance.now() - started });
            }, { once: true });
        }), { html, connectionsAllowed: scriptsFrom(recorder.allowed) });
        expect(report.readyAt).toBeLessThan(1000); // before the slow script arrived
        expect(report.settledAt).toBeGreaterThanOrEqual(1400); // the calls waited for the parser
        expect(report.queued).toEqual({ status: 'resolved', value: { ran: 1 } });
        expect(report.atReady).toEqual({ status: 'resolved', value: { ran: 1 } });
        expect(report.early).toEqual({ status: 'resolved', value: 'early' });
        expect(await sandbox.waitForLog('EXECUTED_AFTER')).toBe('EXECUTED_AFTER number true');
        await recorder.waitFor('allowed', '/delay.js?ms=1500');
    });

    test('calls and execute() sent while the guest document is parsed keep their order (one queue)', async ({ sandbox, page }) => {
        void sandbox; // opens the harness
        const html = `<script src="${recorder.allowed}/delay.js?ms=800"></script>`
            + `<script>globalThis.__order = []; bridge.expose('note', (tag) => { __order.push(tag); return __order.slice(); });</script>`;
        const order = await page.evaluate((config) => new Promise<unknown>((resolve) => {
            const el = document.querySelector('web-sandbox') as any;
            el.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true, ...config });
            el.addEventListener('ready', async () => {
                el.execute(`__order.push('exec1')`);
                el.call('note', 'call1');
                el.execute(`__order.push('exec2')`);
                resolve(await el.call('note', 'call2'));
            }, { once: true });
        }), { html, connectionsAllowed: scriptsFrom(recorder.allowed) });
        expect(order).toEqual(['exec1', 'call1', 'exec2', 'call2']);
    });

    test('the wrapper navigated after ready but before its first load: terminated as a second load; nothing is handed to the new document', async ({ sandbox, page }) => {
        const html = `<img src="${recorder.allowed}/delay?ms=2000">`;
        const outcome = await page.evaluate((config) => new Promise<unknown>((resolve) => {
            const el = document.querySelector('web-sandbox') as any;
            el.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true, ...config });
            el.addEventListener('ready', () => {
                el.addEventListener('terminated', (e: CustomEvent) => resolve({ reason: e.detail.reason, state: el.state }), { once: true });
                el.shadowRoot.querySelector('iframe').srcdoc = '<p>a document the host did not write</p>';
                setTimeout(() => resolve('nothing'), 4000);
            }, { once: true });
        }), { html, connectionsAllowed: { 'img-src': [recorder.allowed] } });
        expect(outcome).toEqual({ reason: SECOND_LOAD, state: 'terminated' });
        await sandbox.run('console.log("after terminate")');
        await page.waitForTimeout(300);
        expect(await sandbox.logs()).not.toContain('after terminate');
    });

    test('an announcement the guest forges while its document loads ends the environment (PD8 unchanged)', async ({ sandbox, page }) => {
        await page.evaluate(() => {
            (window as any).terminations = [];
            document.querySelector('web-sandbox')!.addEventListener('terminated', (e) => (window as any).terminations.push((e as CustomEvent).detail.reason));
        });
        const html = `<script>parent.parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [new MessageChannel().port2]);</script><img src="${recorder.allowed}/delay?ms=1000">`;
        await sandbox.mount({ html, connectionsAllowed: { 'img-src': [recorder.allowed] } });
        await expect.poll(() => page.evaluate(() => (window as any).terminations)).toEqual([SECOND_ANNOUNCEMENT]);
        expect(await sandbox.state()).toBe('terminated');
    });

    test("without allow-scripts no bootstrap checks in: 'ready' comes with the wrapper's load, after the guest's images", async ({ sandbox, page }) => {
        void sandbox; // opens the harness
        const html = `<img src="${recorder.allowed}/delay?ms=600">`;
        const report = await readyAndLoad(page, { html, capabilities: [], scriptUnsafe: false, connectionsAllowed: { 'img-src': [recorder.allowed] } });
        expect(report.terminated).toBeNull();
        expect(report.readyAt).toBeGreaterThanOrEqual(500);
        expect(report.stateAtLoad).toBe('ready');
        await recorder.waitFor('allowed', '/delay?ms=600');
    });

    test('without allow-scripts, LOAD_TIMEOUT_MS still bounds the wait for that load', async ({ sandbox }) => {
        const html = `<img src="${recorder.allowed}/delay?ms=8000">`;
        const outcome = await sandbox.page.evaluate((config) => new Promise<unknown>((resolve) => {
            const el = document.querySelector('web-sandbox') as any;
            const started = performance.now();
            el.addEventListener('ready', () => resolve('ready'), { once: true });
            el.addEventListener('terminated', (e: CustomEvent) => resolve({ reason: e.detail.reason, after: performance.now() - started }), { once: true });
            el.setConfig(config);
        }), { html, capabilities: [], connectionsAllowed: { 'img-src': [recorder.allowed] } });
        expect(outcome).toMatchObject({ reason: LOAD_TIMEOUT });
        expect((outcome as { after: number }).after).toBeGreaterThanOrEqual(4900);
    });
});
