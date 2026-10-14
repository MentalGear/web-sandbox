import type { Page } from '@playwright/test';
import { test, expect, type SandboxDriver } from './fixture';
import { useRecorder, wss } from './recorder';

/**
 * Broad review 2026-10-14 (docs/security/BROAD-REVIEW-2026-10-14.md), where browser behaviour decides:
 *   CB1  the guest's port is announced by the bootstrap, never handed into the guest: document.open() before the
 *        wrapper's load leaves no listener of the guest's holding a port of ours;
 *   PD8  a second announcement from the guest's window (it reloaded itself, rewrote its document so a bootstrap ran
 *        again, or forged one) ends the environment with a reason;
 *   CB3  a call made while loading that timed out never runs later; a guest that never finishes its document is
 *        ready and alive (S46), not held `loading`;
 *   CB7  an element moved into another document stops its guest and builds nothing there;
 *   PD1  no worker loads from data: (WebKit ran a data: SharedWorker outside the guest policy);
 *   PD2  fetch() with keepalive is refused in the guest realm (Firefox sent it past connect-src);
 *   PD3  DNS prefetching is off in the guest document; preconnect is a measured residual;
 *   PD4  the guest's history traversal never moves the host page (Firefox, WebKit);
 *   PD5  focus and the clipboard: measured residuals;
 *   PD6  the guest cannot name its frame, so host named targets never reach it;
 *   PD7  a guest's own messages reach the embedder's window listeners, which tell them apart by event.source;
 *   PA2  where the host's parse put a file reference, the guest's parse of the rewritten markup puts it too, or nowhere.
 * Evidence (T5): read outside the sandbox — the host's own events and state, the host page's URL and window, the
 * recorder's listeners (requests and TCP connections) — with a positive control beside each negative. Per-engine
 * residuals are asserted as measured, so a change in an engine fails here.
 */

const recorder = useRecorder();

const guestWindowOf = `(document.querySelector('web-sandbox')).shadowRoot.querySelector('iframe').contentWindow.frames[0]`;

// Records 'terminated' reasons on the host page from now on.
async function recordTerminations(page: Page) {
    await page.evaluate(() => {
        (window as any).terminations = [];
        document.querySelector('web-sandbox')!.addEventListener('terminated', (e) => (window as any).terminations.push((e as CustomEvent).detail.reason));
    });
}
const terminations = (page: Page) => page.evaluate(() => [...(window as any).terminations] as string[]);

const SECOND_ANNOUNCEMENT = 'the guest frame announced itself again (it reloaded or rewrote its document)';
const LOAD_TIMEOUT_MS = 5000; // src/host.ts

// ---- CB1 ------------------------------------------------------------------------------------------------

test.describe('CB1: no listener in the guest realm ever holds a port of ours', () => {
    test("document.open() before the wrapper's load: the guest's own listener sees messages (positive control) but never a port, and nothing it posts reaches the host", async ({ sandbox, page }) => {
        // The image holds the guest's load (and, before, the host's INIT_PORT) open while the guest erases every
        // listener of its window with document.open() and installs its own.
        const html = `<script>
            globalThis.__portsSeen = 0; globalThis.__messages = 0;
            setTimeout(() => {
                document.open();
                addEventListener('message', (e) => {
                    __messages++;
                    if (e.ports && e.ports.length) { __portsSeen++; e.ports[0].postMessage({ type: 'LOG', level: 'log', args: ['CB1-CAPTURED'] }); }
                });
                document.write('<p id="rewritten">rewritten</p>');
                document.close();
            }, 0);
        </script><img src="${recorder.allowed}/delay?ms=1500">`;
        expect(await sandbox.mount({ html, connectionsAllowed: { 'img-src': [recorder.allowed] } })).toBe('ready');
        await page.evaluate((expr) => (0, eval)(expr).postMessage({ type: 'hello' }, '*'), guestWindowOf); // positive control
        await sandbox.exposeGuest('twice', '(x) => x * 2');
        expect(await sandbox.call('twice', 21)).toBe(42); // the bridge works both ways
        expect(await sandbox.inGuest('return { messages: __messages > 0, ports: __portsSeen, rewritten: !!document.getElementById("rewritten") }')).toEqual({ messages: true, ports: 0, rewritten: true });
        await page.waitForTimeout(300);
        expect((await sandbox.logs()).filter(line => line.includes('CB1-CAPTURED'))).toEqual([]);
    });

    test('another frame on the host page that posts an announcement to the host window is not heard: the guest\'s own is (guarantee)', async ({ sandbox, page }) => {
        await page.evaluate(() => {
            const frame = document.createElement('iframe');
            document.body.append(frame);
            (window as any).strangerHeard = [];
            const run = (frame.contentWindow as any).Function('heard', `
                return setInterval(() => {
                    const channel = new MessageChannel();
                    channel.port1.onmessage = (e) => heard.push(JSON.stringify(e.data));
                    parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [channel.port2]);
                }, 5);`);
            (window as any).strangerTimer = run((window as any).strangerHeard);
        });
        await recordTerminations(page);
        expect(await sandbox.mount({})).toBe('ready');
        await sandbox.exposeGuest('echo', '(x) => x');
        expect(await sandbox.call('echo', 'mine')).toBe('mine');
        await page.waitForTimeout(300);
        expect(await terminations(page)).toEqual([]);
        expect(await page.evaluate(() => (window as any).strangerHeard)).toEqual([]);
    });
});

// ---- PD8 ------------------------------------------------------------------------------------------------

test.describe('PD8: a second announcement from the guest window ends the environment', () => {
    // [name, guest markup, code run after 'ready']
    const CASES: [string, string, string][] = [
        ['location.reload()', '<p>guest</p>', `location.reload()`],
        ['a <meta refresh> without a URL in the guest markup', '<meta http-equiv="refresh" content="1"><p>guest</p>', ''],
        ['document.open() writing the bootstrap again', '<p>guest</p>', `const text = document.scripts[0].textContent; document.open(); document.write('<scr' + 'ipt>' + text + '</scr' + 'ipt>'); document.close();`],
        ['a forged announcement with a port', '<p>guest</p>', `const c = new MessageChannel(); parent.parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [c.port2]);`],
        ['a forged announcement without a port', '<p>guest</p>', `parent.parent.postMessage({ type: 'SANDBOX_PORT' }, '*');`],
    ];
    for (const [name, html, code] of CASES) {
        test(`${name}: terminated with the reason (Firefox's refresh: by the watchdog)`, async ({ sandbox, page, browserName }) => {
            await recordTerminations(page);
            // the watchdog (3 s) is the backstop where no bootstrap runs again: measured, Firefox refreshes this frame
            // to a document without one (no second announcement), and the frame's old document stops answering
            expect(await sandbox.mount({ html, watchdogTimeout: 3000 })).toBe('ready');
            if (code) await sandbox.run(code);
            const expected = !code && browserName === 'firefox' ? 'the guest stopped responding (watchdog)' : SECOND_ANNOUNCEMENT;
            await expect.poll(() => terminations(page), { timeout: 8000 }).toEqual([expected]);
            expect(await sandbox.state()).toBe('terminated');
        });
    }

    test("the guest's other messages to the host page do not end it, and reach the embedder's listeners, which tell them apart by event.source (PD7, positive control)", async ({ sandbox, page }) => {
        expect(await sandbox.mount({ html: '<p>guest</p>' })).toBe('ready');
        await recordTerminations(page);
        await page.evaluate((expr) => {
            (window as any).heardFromGuest = [];
            window.addEventListener('message', (e) => {
                if (e.source === (0, eval)(expr)) (window as any).heardFromGuest.push(e.data);
            });
        }, guestWindowOf);
        await sandbox.run(`parent.parent.postMessage({ type: 'RESET_COMPLETE' }, '*'); parent.parent.postMessage({ type: 'sandbox_port' }, '*');`);
        await expect.poll(() => page.evaluate(() => (window as any).heardFromGuest.length)).toBe(2);
        await page.waitForTimeout(300);
        expect(await terminations(page)).toEqual([]);
        expect(await sandbox.state()).toBe('ready');
    });
});

// ---- CB3 ------------------------------------------------------------------------------------------------

test.describe('CB3: calls while loading, and the load deadline', () => {
    test('a call made while loading that timed out never runs when the port arrives; a call still waiting does (positive control)', async ({ sandbox, page }) => {
        const html = `<script>globalThis.__counted = 0; bridge.expose('count', () => ++__counted); bridge.expose('counted', () => __counted);</script>`;
        const outcome = await page.evaluate(({ html, config }) => new Promise<any>((resolve) => {
            const el = document.querySelector('web-sandbox') as any;
            el.setConfig({ ...config, html });
            const settled = (outcome: string) => ({ outcome, state: el.state });
            const timedOut = el.callWithTimeout(50, 'count').then(() => settled('resolved'), (e: any) => settled(e.code));
            const waiting = el.call('counted');
            // `loading` lasts only until the guest checks in (S46), tens of ms: the host's thread is held past the
            // call's timeout instead, so the timeout is due before the frame (on this thread) can even start loading.
            // The state when it settled is asserted: 'loading' is the precondition of this test.
            const until = performance.now() + 300;
            while (performance.now() < until) { /* hold the host's thread */ }
            el.addEventListener('ready', async () => resolve({ timedOut: await timedOut, waiting: await waiting }), { once: true });
        }), { html, config: { capabilities: ['allow-scripts'], scriptUnsafe: true } });
        expect(outcome).toEqual({ timedOut: { outcome: 'TIMEOUT', state: 'loading' }, waiting: 0 });
        await page.waitForTimeout(200);
        expect(await sandbox.call('counted')).toBe(0);
    });

    // Since S46 `ready` is the guest's check-in, so a guest that never finishes its document is ready like any other.
    // Before, Chromium and WebKit kept it `loading` until LOAD_TIMEOUT_MS ended it, and Firefox completed the load.
    test(`a guest document that never finishes parsing (document.open() without close) is ready and stays alive past LOAD_TIMEOUT_MS: calls it is sent wait and time out, the watchdog keeps hearing it; one that closes its document answers (positive control)`, async ({ sandbox, page }) => {
        await recordTerminations(page);
        const reopening = (close: boolean) => `<script>bridge.expose('alive', () => 'alive'); setTimeout(() => { document.open(); document.write('<p>reopened</p>');${close ? ' document.close();' : ''} }, 0)</script>`;
        expect(await sandbox.mount({ html: reopening(false), watchdogTimeout: 1000 })).toBe('ready');
        await page.waitForTimeout(300); // the guest has reopened its document
        expect(await sandbox.callWithTimeoutOutcome(500, 'alive')).toMatchObject({ status: 'rejected', code: 'TIMEOUT' });
        await page.waitForTimeout(LOAD_TIMEOUT_MS); // past the load deadline, and five watchdog budgets
        expect([await sandbox.state(), await terminations(page)]).toEqual(['ready', []]);
        expect(await sandbox.mount({ html: reopening(true) })).toBe('ready');
        await page.waitForTimeout(300);
        expect(await sandbox.call('alive')).toBe('alive');
    });
});

// ---- CB7 ------------------------------------------------------------------------------------------------

test('CB7: moved into another document, the element stops its guest and builds nothing there (one warning); moved back, it builds again', async ({ sandbox, page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
    expect(await sandbox.mount({ html: `<script>setInterval(() => fetch('${recorder.allowed}/tick').catch(() => {}), 50)</script>`, connectionsAllowed: { 'connect-src': [recorder.allowed] } })).toBe('ready');
    await recorder.waitFor('allowed', '/tick'); // positive control: the guest runs
    const away = await page.evaluate(async () => {
        const el = document.querySelector('web-sandbox') as any;
        const frame = document.createElement('iframe');
        document.body.append(frame);
        await new Promise(resolve => setTimeout(resolve, 100));
        frame.contentDocument!.body.append(el);
        await new Promise(resolve => setTimeout(resolve, 300));
        return { iframes: el.shadowRoot.querySelectorAll('iframe').length, state: el.state ?? 'no state getter' };
    });
    // Firefox gives the adopted element the other document's HTMLElement prototype: no state getter there
    expect(away.iframes).toBe(0);
    expect(['idle', 'no state getter']).toContain(away.state);
    recorder.clear();
    await page.waitForTimeout(800);
    expect(recorder.paths('allowed')).toEqual([]); // the guest stopped
    expect(warnings.filter(text => text.includes('inserted into a document of another window'))).toHaveLength(1);

    const back = await page.evaluate(() => new Promise<string>((resolve) => {
        const el = document.querySelectorAll('iframe')[0]!.contentDocument!.querySelector('web-sandbox') as any;
        el.addEventListener('ready', () => resolve(el.state), { once: true });
        document.body.append(el);
        setTimeout(() => resolve('timeout'), 6000);
    }));
    expect(back).toBe('ready');
    await recorder.waitFor('allowed', '/tick'); // and its new guest runs
});

// ---- PD1 ------------------------------------------------------------------------------------------------

test.describe('PD1: no worker loads from data:', () => {
    test('a data: SharedWorker and a data: Worker reach nothing (WebKit ran the SharedWorker outside the policy); a blob: worker under the same policy reaches the allowed listener (positive control)', async ({ sandbox }) => {
        expect(await sandbox.mount({ connectionsAllowed: { 'connect-src': [recorder.allowed] } })).toBe('ready');
        const body = (prefix: string, origin: string) => `fetch('${origin}/${prefix}-fetch').catch(() => {}); try { importScripts('${origin}/${prefix}-import.js'); } catch (e) {} try { new WebSocket('${wss(origin)}/${prefix}-ws'); } catch (e) {}`;
        const constructed = await sandbox.inGuest(`
            const source = 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(body('pd1', recorder.blocked))});
            const r = {};
            try { new SharedWorker(source); r.shared = 'constructed'; } catch (e) { r.shared = e.name; }
            try { new Worker(source); r.worker = 'constructed'; } catch (e) { r.worker = e.name; }
            new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`fetch('${recorder.allowed}/pd1-blob-control')`)}], { type: 'text/javascript' })));
            return r;
        `);
        await recorder.waitFor('allowed', '/pd1-blob-control');
        await sandbox.page.waitForTimeout(1000);
        expect(recorder.paths('blocked')).toEqual([]);
        // every engine refuses the data: worker load by the guest policy and reports it (constructors may still return)
        expect(constructed).toBeDefined();
        expect((await sandbox.violations()).some(v => v.directive === 'worker-src' && v.blockedURI.startsWith('data'))).toBe(true);
    });
});

// ---- PD2 ------------------------------------------------------------------------------------------------

test.describe('PD2: fetch() with keepalive is refused in the guest realm', () => {
    for (const mode of ['iframe', 'worker'] as const) {
        test(`${mode} mode: keepalive to a listener the policy blocks is refused (Firefox sent it before); an ordinary fetch to the allowed one arrives (positive control)`, async ({ sandbox, browserName }) => {
            expect(await sandbox.mount({ mode, connectionsAllowed: { 'connect-src': [recorder.allowed] } })).toBe('ready');
            const outcome = await sandbox.inGuest(`
                const tryFetch = (url, init) => fetch(url, init).then(() => 'sent', (e) => e.name + ': ' + e.message);
                return {
                    init: await tryFetch('${recorder.blocked}/pd2-init', { keepalive: true, method: 'POST', body: 'x' }),
                    request: await tryFetch(new Request('${recorder.blocked}/pd2-request', { keepalive: true })),
                    control: await tryFetch('${recorder.allowed}/pd2-control', { method: 'POST', body: 'x' }),
                };
            `);
            // measured: Firefox's Request does not keep keepalive (its getter reads false), so that request is an ordinary
            // one, which connect-src refuses; the listener below is the evidence either way
            expect(outcome).toEqual({
                init: 'TypeError: fetch() with keepalive is not available in the sandbox',
                request: browserName === 'firefox' ? 'TypeError: NetworkError when attempting to fetch resource.' : 'TypeError: fetch() with keepalive is not available in the sandbox',
                control: 'sent',
            });
            await sandbox.page.waitForTimeout(500);
            expect(recorder.paths('blocked')).toEqual([]);
            expect(recorder.paths('allowed')).toEqual(['/pd2-control']);
        });
    }

    test('residual (measured): a frame the guest creates has the platform\'s fetch; Firefox still sends its keepalive request past connect-src', async ({ sandbox, browserName }) => {
        expect(await sandbox.mount({ connectionsAllowed: { 'connect-src': [recorder.allowed] } })).toBe('ready');
        await sandbox.run(`const f = document.createElement('iframe'); f.srcdoc = ${JSON.stringify(`<script>fetch('${recorder.blocked}/pd2-nested', { keepalive: true, method: 'POST', body: 'x' }).catch(() => {}); fetch('${recorder.allowed}/pd2-nested-control').catch(() => {});</script>`)}; document.body.append(f);`);
        await recorder.waitFor('allowed', '/pd2-nested-control'); // the nested frame's scripts run (positive control)
        await sandbox.page.waitForTimeout(800);
        expect(recorder.paths('blocked')).toEqual(browserName === 'firefox' ? ['/pd2-nested'] : []);
    });
});

// ---- PD3 ------------------------------------------------------------------------------------------------

test.describe('PD3: DNS prefetching and preconnect', () => {
    test('the guest document turns DNS prefetching off, ahead of guest markup (guarantee)', async ({ sandbox }) => {
        expect(await sandbox.mount({ html: '<p>x</p>' })).toBe('ready');
        expect(await sandbox.inGuest(`const m = document.head.children; return [m[0].httpEquiv, m[1].httpEquiv, m[1].content];`)).toEqual(['Content-Security-Policy', 'x-dns-prefetch-control', 'off']);
    });

    test('residual (measured): <link rel=preconnect> opens a connection to an origin the policy blocks in WebKit only; an allowed fetch connects (positive control of the counter)', async ({ sandbox, browserName }) => {
        const html = `<link rel="preconnect" href="${recorder.blocked}"><link rel="dns-prefetch" href="${recorder.blocked}"><script>fetch('${recorder.allowed}/pd3-control').catch(() => {})</script>`;
        expect(await sandbox.mount({ html, connectionsAllowed: { 'connect-src': [recorder.allowed] } })).toBe('ready');
        await recorder.waitFor('allowed', '/pd3-control');
        await sandbox.page.waitForTimeout(1500);
        expect(recorder.connections.allowed).toBeGreaterThan(0);
        expect(recorder.paths('blocked')).toEqual([]); // no request either way
        if (browserName === 'webkit') expect(recorder.connections.blocked).toBeGreaterThan(0);
        else expect(recorder.connections.blocked).toBe(0);
    });
});

// ---- PD4 ------------------------------------------------------------------------------------------------

test.describe('PD4: the guest never moves the host page through history', () => {
    test('history.back(), go(-1) and the Navigation API from the guest leave the host URL as it is; the host\'s own history.back() works (positive control)', async ({ sandbox, page }) => {
        expect(await sandbox.mount({ html: '<p>guest</p>' })).toBe('ready');
        await page.evaluate(() => history.pushState({}, '', '?pd4=1'));
        await page.evaluate(() => history.pushState({}, '', '?pd4=2'));
        const before = page.url();
        await sandbox.run(`history.back(); history.go(-1); history.go(-2); if (typeof navigation === 'object' && navigation) navigation.back();`);
        await page.waitForTimeout(1000);
        expect(page.url()).toBe(before);
        expect(await sandbox.state()).toBe('ready');
        await page.evaluate(() => history.back());
        await expect.poll(() => page.url()).toContain('?pd4=1');
    });

    test('residual (measured): a frame the guest creates traverses the tab\'s history in Firefox and WebKit', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ html: '<p>guest</p>' })).toBe('ready');
        await page.evaluate(() => history.pushState({}, '', '?pd4=nested'));
        await sandbox.run(`const f = document.createElement('iframe'); f.srcdoc = '<script>history.back()<\\/script>'; document.body.append(f);`);
        await page.waitForTimeout(1000);
        if (browserName === 'chromium') expect(page.url()).toContain('?pd4=nested');
        else expect(page.url()).not.toContain('?pd4=nested');
    });
});

// ---- PD5 ------------------------------------------------------------------------------------------------

test.describe('PD5: focus and the clipboard (residuals, measured)', () => {
    test('guest code can take focus from the host page where the engine lets a frame do so, and keystrokes then go to it', async ({ sandbox, page, browserName }) => {
        await page.evaluate(() => { const input = document.createElement('input'); input.id = 'host-input'; document.body.prepend(input); input.focus(); });
        expect(await sandbox.mount({ html: '<input id="g">' })).toBe('ready');
        await sandbox.run(`const g = document.getElementById('g'); g.addEventListener('input', () => console.log('PD5-KEY ' + g.value)); g.focus();`);
        await page.waitForTimeout(300);
        const active = await page.evaluate(() => document.activeElement?.localName);
        await page.keyboard.type('abc');
        await page.waitForTimeout(300);
        const guestKeys = (await sandbox.logs()).filter(line => line.startsWith('PD5-KEY')).at(-1) ?? null;
        const hostValue = await page.evaluate(() => (document.getElementById('host-input') as HTMLInputElement).value);
        const measured = { chromium: ['web-sandbox', 'PD5-KEY abc', ''], firefox: ['web-sandbox', null, ''], webkit: ['input', null, 'abc'] }[browserName as 'chromium'];
        expect([active, guestKeys, hostValue]).toEqual(measured);
    });

    test('the clipboard: navigator.clipboard.writeText() and execCommand("copy") from guest code, without and with a user\'s click in the guest, and writeText() in the click\'s own handler', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ html: '<textarea id="t">x</textarea>' })).toBe('ready');
        const attempt = () => sandbox.inGuest(`
            const written = await navigator.clipboard.writeText('PD5').then(() => 'written', (e) => e.name);
            const t = document.getElementById('t'); t.select();
            let copied; try { copied = document.execCommand('copy'); } catch (e) { copied = e.name; }
            return { written, copied };
        `);
        const without = await attempt();
        await page.frameLocator('web-sandbox >>> iframe').frameLocator('iframe').locator('#t').click();
        const withClick = await attempt();
        // writeText() called in the click's own handler (independent verification 2026-10-14): WebKit's activation does
        // not last until the call above, which runs a moment later through execute(); in the handler WebKit writes too
        await sandbox.run(`document.getElementById('t').addEventListener('click', () => navigator.clipboard.writeText('PD5').then(() => console.log('PD5-HANDLER written'), (e) => console.log('PD5-HANDLER ' + e.name)), { once: true });`);
        await page.frameLocator('web-sandbox >>> iframe').frameLocator('iframe').locator('#t').click();
        const inHandler = (await sandbox.waitForLog('PD5-HANDLER')).slice('PD5-HANDLER '.length);
        console.log('PD5 clipboard', browserName, JSON.stringify({ without, withClick, inHandler }));
        const measured = {
            chromium: { without: { written: 'NotAllowedError', copied: false }, withClick: { written: 'NotAllowedError', copied: true }, inHandler: 'NotAllowedError' },
            firefox: { without: { written: 'NotAllowedError', copied: false }, withClick: { written: 'written', copied: true }, inHandler: 'written' },
            webkit: { without: { written: 'NotAllowedError', copied: false }, withClick: { written: 'NotAllowedError', copied: false }, inHandler: 'written' },
        }[browserName as 'chromium'];
        expect({ without, withClick, inHandler }).toEqual(measured);
    });
});

// ---- PD6 ------------------------------------------------------------------------------------------------

test.describe('PD6: the guest cannot name its frame', () => {
    const openNamed = (page: Page, name: string) => page.evaluate(({ name, expr }) => {
        const guest = (0, eval)(expr);
        const nested = guest.length > 0 ? guest[0] : null; // an index that does not exist is a SecurityError cross-origin
        const w = window.open('', name);
        const result = { guest: w === guest, nested: nested !== null && w === nested, other: w !== null && w !== guest && w !== nested };
        if (result.other) w!.close();
        return result;
    }, { name, expr: guestWindowOf });

    test('window.name set, deleted and redefined by the guest: window.open() on the host page with that name never returns the guest frame', async ({ sandbox, page }) => {
        expect(await sandbox.mount({ html: '<p>guest</p>' })).toBe('ready');
        await sandbox.run(`window.name = 'pd6-set';`);
        expect((await openNamed(page, 'pd6-set')).guest).toBe(false);
        await sandbox.run(`delete window.name; window.name = 'pd6-deleted';`);
        expect((await openNamed(page, 'pd6-deleted')).guest).toBe(false);
        await sandbox.run(`Object.defineProperty(window, 'name', { value: 'pd6-defined', configurable: true });`);
        expect((await openNamed(page, 'pd6-defined')).guest).toBe(false);
        expect(await sandbox.inGuest(`return window.name`)).toBe('pd6-defined'); // a data property of the guest's own, nothing more
    });

    test('residual (measured): a frame the guest creates with a name is a target the host page reaches (the lookup works: positive control)', async ({ sandbox, page }) => {
        expect(await sandbox.mount({ html: '<iframe name="pd6-nested" srcdoc="<p>nested</p>"></iframe>' })).toBe('ready');
        expect(await openNamed(page, 'pd6-nested')).toEqual({ guest: false, nested: true, other: false });
    });
});

// ---- PA2 ------------------------------------------------------------------------------------------------

/**
 * Markup whose parse could differ between the host's inert DOMParser (scripting off, a whole document) and the guest's
 * parser (scripting on, after the bootstrap in <head>, through document.write()): noscript, template, foreign content,
 * tables, raw text and RCDATA, CR, NUL and BOM characters.
 */
const PA2_CORPUS = [
    '<img src="f0.svg">',
    '<noscript><img src="f0.svg"></noscript><img src="f1.svg">',
    '<template><img src="f0.svg"></template><img src="f1.svg">',
    '<svg><image href="f0.svg"></image><img src="f1.svg"></svg>',
    '<math><mi><img src="f0.svg"></mi></math>',
    '<svg><foreignObject><img src="f0.svg"></foreignObject></svg>',
    '<table><img src="f0.svg"><tr><td><img src="f1.svg"></td></tr></table>',
    '<select><img src="f0.svg"><option>o</option></select>',
    '<textarea><img src="f0.svg"></textarea><img src="f1.svg">',
    '<title><img src="f0.svg"></title><img src="f1.svg">',
    '<style>p{background:url(f0.svg)}</style><p style="background:url(f1.svg)">p</p>',
    '<img src="\rf0.svg"><img src="f1.svg\r">',
    '<img src="f0\u0000.svg"><img src="﻿f1.svg">',
    '﻿<img src="f0.svg">',
    '<img srcset="f0.svg 1x, f1.svg 2x">',
    '<picture><source srcset="f0.svg"><img src="f1.svg"></picture>',
    '<video poster="f0.svg"></video><audio src="f1.svg"></audio>',
    '<frameset><frame src="f0.svg"></frameset>',
    '<head><link rel="icon" href="f0.svg"></head><body><img src="f1.svg"></body>',
    '<p><img src="f0.svg"</p><img src="f1.svg">',
    '<!-- <img src="f0.svg"> --><img src="f1.svg">',
    '<img src=f0.svg/><iframe srcdoc="<img src=f1.svg>"></iframe>',
];

test('PA2: every file reference the host placed lands on the same (namespace, element, attribute) in the guest, or nowhere', async ({ sandbox, page }) => {
    await sandbox.registerFiles({ 'f0.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'f1.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    for (const html of PA2_CORPUS) {
        // the host's placement: parse the markup as the library does and read where each sentinel went
        const host = await page.evaluate(async (html) => {
            const { rewriteMarkupReferences } = await import('/src/lib/markup-references.ts' as string);
            const nonce = 'a'.repeat(32);
            const parts = rewriteMarkupReferences(html, new Map([['f0.svg', 'image/svg+xml'], ['f1.svg', 'image/svg+xml']]), nonce);
            if (!parts) return [];
            const marked = parts.map((part: unknown, i: number) => (i % 2 === 0 ? part : `marker-${(Array.isArray(part) ? part[0] : part)}`)).join('');
            const doc = new DOMParser().parseFromString(marked, 'text/html');
            const placed: string[] = [];
            for (const element of doc.querySelectorAll('*')) {
                for (const attribute of element.getAttributeNames()) {
                    const value = element.getAttribute(attribute)!;
                    for (const path of ['f0.svg', 'f1.svg']) if (value.includes(`marker-${path}`)) placed.push(`${element.namespaceURI} ${element.localName} ${attribute} ${path}`);
                }
                if (element.localName === 'style' && (element.textContent ?? '').includes('marker-f0.svg')) placed.push(`${element.namespaceURI} style #text f0.svg`);
            }
            return placed.sort();
        }, html);
        expect(await sandbox.mount({ html, connectionsAllowed: { 'img-src': ['blob:'] } }), html).toBe('ready');
        const guest = await sandbox.inGuest(`
            const urls = { [sandboxFiles.url('f0.svg')]: 'f0.svg', [sandboxFiles.url('f1.svg')]: 'f1.svg' };
            const placed = [];
            for (const element of document.querySelectorAll('*')) {
                for (const attribute of element.getAttributeNames()) {
                    const value = element.getAttribute(attribute);
                    for (const [url, path] of Object.entries(urls)) if (value.includes(url)) placed.push(element.namespaceURI + ' ' + element.localName + ' ' + attribute + ' ' + path);
                }
                if (element.localName === 'style') for (const [url, path] of Object.entries(urls)) if ((element.textContent || '').includes(url)) placed.push(element.namespaceURI + ' style #text ' + path);
            }
            return placed.sort();
        `);
        // the guest's placements are a subset of the host's: never another element or attribute
        for (const placement of guest) expect(host, `${JSON.stringify(html)}: ${placement}`).toContain(placement);
    }
});
