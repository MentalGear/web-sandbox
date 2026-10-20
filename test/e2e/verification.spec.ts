import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import { useRecorder, wss } from './recorder';
import { WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from '@src/lib/worker-globals';

/**
 * Independent verification 2026-10-14 (docs/archive/reviews/VERIFICATION-2026-10-14.md), where browser behaviour decides:
 *   V1  a guest worker (worker mode, strict mode) keeps only the allowlisted globals: Firefox sent a worker's
 *       EventSource (and loaded a worker's FontFace) past the policy; every other network API of a worker is gone or
 *       governed. A worker the guest creates in cooperative mode is a realm of its own (residual, measured).
 *   V2  a strict entry's synchronous console lines arrive (they were lost before the logic port was attached);
 *   V3  the user's modifier clicks and Ctrl/Shift+Enter on a guest link open a new top-level tab in Chromium and
 *       Firefox (cooperative mode, platform behaviour: a limit, measured); strict mode opens none;
 *   L1  a guest's timers, promise loops and nested workers stop at terminate() and reset();
 *   L2  an announcement a frame the guest creates posts to top is never accepted;
 *   PD7 the playground acts only on messages from its own window;
 *   H1  the guest's fragment navigations add entries to the tab's session history (residual, measured).
 * Evidence (T5): the recorder's listeners outside the browser, with a positive control beside each negative.
 */

const recorder = useRecorder();

// The globals the library itself puts on the worker after the allowlist ran (bridge, sandboxFiles, sandboxFetch,
// sandboxView, and strict mode's per-build entry marker).
const LIBRARY_GLOBALS = ['bridge', 'sandboxFiles', 'sandboxFetch', 'sandboxView'];

// Every network-capable thing a worker global has offered on some engine, aimed at the blocked listener.
const ATTEMPTS = (blocked: string) => `
    const attempt = (name, fn) => { try { const r = fn(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) {} };
    attempt('EventSource', () => new EventSource('${blocked}/v1-es?x=1'));
    attempt('WebTransport', () => new WebTransport('${blocked}/v1-wt'));
    attempt('WebSocketStream', () => new WebSocketStream('${wss(blocked)}/v1-wss'));
    attempt('FontFace', () => new FontFace('v1', 'url(${blocked}/v1-font.woff)').load());
    attempt('fonts', () => fonts.load('12px v1'));
    attempt('caches', () => caches.open('v1').then((c) => c.add('${blocked}/v1-cache')));
    attempt('serviceWorker', () => navigator.serviceWorker.register('${blocked}/v1-sw.js'));
    attempt('Notification', () => new Notification('v1', { icon: '${blocked}/v1-icon.png' }));
    attempt('sendBeacon', () => navigator.sendBeacon('${blocked}/v1-beacon', 'x'));
    attempt('Worker', () => new Worker(URL.createObjectURL(new Blob(["fetch('${blocked}/v1-nested').catch(() => {}); try { new EventSource('${blocked}/v1-nested-es') } catch (e) {}"], { type: 'text/javascript' }))));
    attempt('SharedWorker', () => new SharedWorker(URL.createObjectURL(new Blob(["fetch('${blocked}/v1-shared').catch(() => {})"], { type: 'text/javascript' }))));
    attempt('import', () => import('${blocked}/v1-dynamic.js'));
    attempt('importScripts', () => importScripts('${blocked}/v1-import.js'));
    attempt('fetch', () => fetch('${blocked}/v1-fetch', { mode: 'no-cors' }));
    attempt('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', '${blocked}/v1-xhr', false); x.send(); });
    attempt('WebSocket', () => new WebSocket('${wss(blocked)}/v1-ws'));
    attempt('compileStreaming', () => WebAssembly.compileStreaming(fetch('${blocked}/v1-wasm')));
`;

test.describe('V1: a guest worker keeps only the allowlisted globals; every request it can make is governed by the policy', () => {
    for (const mode of ['worker', 'strict'] as const) {
        test(`${mode} mode: new EventSource() to an origin connect-src blocks reaches nothing (Firefox sent it); fetch to the allowed listener arrives (positive control)`, async ({ sandbox }) => {
            expect(await sandbox.mount({ mode, origins: { connect: [recorder.allowed] } })).toBe('ready');
            await sandbox.run(`try { new EventSource('${recorder.blocked}/es?x=1'); } catch (e) {} fetch('${recorder.allowed}/es-control').catch(() => {});`);
            await recorder.waitFor('allowed', '/es-control');
            await sandbox.page.waitForTimeout(1000);
            expect(recorder.paths('blocked')).toEqual([]);
        });

        test(`${mode} mode: the worker's globals are the allowlist and nothing else, and no network API of any engine reaches the blocked listener; fetch, XMLHttpRequest, WebSocket${mode === 'worker' ? ' and importScripts' : ''} reach the allowed one (positive controls)`, async ({ sandbox }) => {
            const origins = { connect: [recorder.allowed, wss(recorder.allowed)], fonts: [recorder.allowed] };
            // importScripts' positive control needs a script origin, which only worker mode takes (strict has no scripts kind)
            expect(await sandbox.mount(mode === 'worker' ? { mode, origins: { ...origins, scripts: [recorder.allowed] } } : { mode, origins })).toBe('ready');
            const seen = await sandbox.inGuest(`
                // a WebIDL constant (a non-configurable primitive, Chromium's TEMPORARY) cannot be deleted and requests nothing
                const isConstant = (owner, n) => { const d = Object.getOwnPropertyDescriptor(owner, n); return !d.configurable && 'value' in d && Object(d.value) !== d.value; };
                const names = Object.getOwnPropertyNames(globalThis).filter((n) => !isConstant(globalThis, n));
                for (let p = Object.getPrototypeOf(globalThis); p && p !== EventTarget.prototype; p = Object.getPrototypeOf(p)) names.push(...Object.getOwnPropertyNames(p).filter((n) => n !== 'constructor' && !isConstant(p, n)));
                const navigatorMembers = Object.getOwnPropertyNames(Object.getPrototypeOf(navigator)).filter((n) => n !== 'constructor');
                return { names: [...new Set(names)].sort(), navigatorMembers: navigatorMembers.sort() };
            `);
            const allowed = new Set([...WORKER_GLOBALS, ...LIBRARY_GLOBALS]);
            expect(seen.names.filter((name: string) => !allowed.has(name) && !name.startsWith('__sandboxEntryRan_'))).toEqual([]);
            expect(seen.navigatorMembers.filter((name: string) => !WORKER_NAVIGATOR_MEMBERS.includes(name))).toEqual([]);

            await sandbox.run(ATTEMPTS(recorder.blocked) + `
                fetch('${recorder.allowed}/v1-fetch-control').catch(() => {});
                const x = new XMLHttpRequest(); x.open('GET', '${recorder.allowed}/v1-xhr-control'); x.send();
                new WebSocket('${wss(recorder.allowed)}/v1-ws-control');
                ${mode === 'worker' ? `importScripts('${recorder.allowed}/v1-import-control.js');` : ''}
            `);
            for (const control of ['/v1-fetch-control', '/v1-xhr-control', '/v1-ws-control', ...(mode === 'worker' ? ['/v1-import-control.js'] : [])]) {
                await recorder.waitFor('allowed', control);
            }
            await sandbox.page.waitForTimeout(1500);
            expect(recorder.paths('blocked')).toEqual([]);
        });
    }

    test('positive control of the evidence: an EventSource the policy allows reaches the allowed listener (cooperative mode, the document)', async ({ sandbox }) => {
        expect(await sandbox.mount({ origins: { connect: [recorder.allowed] } })).toBe('ready');
        await sandbox.run(`new EventSource('${recorder.allowed}/es-allowed?x=1');`);
        await recorder.waitFor('allowed', '/es-allowed');
        expect(recorder.hits.find(hit => hit.path.startsWith('/es-allowed'))?.headers.accept).toBe('text/event-stream');
    });

    test('residual (measured), cooperative mode: a worker the guest creates is a realm of its own; Firefox sends its EventSource and loads its FontFace past the policy, Chromium and WebKit do not', async ({ sandbox, browserName }) => {
        expect(await sandbox.mount({ origins: { connect: [recorder.allowed] } })).toBe('ready');
        const body = `try { new EventSource('${recorder.blocked}/v1-guest-worker-es') } catch (e) {} try { new FontFace('v1', 'url(${recorder.blocked}/v1-guest-worker-font.woff)').load().catch(() => {}) } catch (e) {} fetch('${recorder.allowed}/v1-guest-worker-control').catch(() => {});`;
        await sandbox.run(`new Worker(URL.createObjectURL(new Blob([${JSON.stringify(body)}], { type: 'text/javascript' })));`);
        await recorder.waitFor('allowed', '/v1-guest-worker-control'); // the guest's worker runs (positive control)
        await sandbox.page.waitForTimeout(1000);
        expect(recorder.paths('blocked').sort()).toEqual(browserName === 'firefox' ? ['/v1-guest-worker-es', '/v1-guest-worker-font.woff'] : []);
    });
});

// ---- V2: a strict entry's synchronous console lines -------------------------------------------------------------

test('V2: a strict entry\'s synchronous console lines arrive as sandbox-log, in order, before its asynchronous ones (before: only the asynchronous ones did)', async ({ sandbox }) => {
    await sandbox.registerFiles({ 'main.js': `console.log('V2 sync 1'); console.info('V2 sync 2'); console.warn('V2 sync 3'); setTimeout(() => console.log('V2 async'), 0);` });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js' })).toBe('ready');
    await sandbox.waitForLog('V2 async');
    expect((await sandbox.logs()).filter(line => line.startsWith('V2 '))).toEqual(['V2 sync 1', 'V2 sync 2', 'V2 sync 3', 'V2 async']);
});

// ---- V3: modifier clicks and Enter on a guest link (a cooperative-mode limit, measured) ------------------------

const LINKS = (origin: string) => `<style>body{margin:0}</style><a id="l" href="${origin}/v3-html" style="display:block;width:300px;height:40px">link</a>`
    + `<svg width="300" height="40" style="display:block"><a id="s" href="${origin}/v3-svg"><rect width="300" height="40" fill="#ccc"/></a></svg>`;

// The user's own actions on a guest link that open a new top-level browsing context: modifier clicks and the middle
// button on an HTML and an SVG link, and Ctrl/Shift+Enter on a focused one. For each: the pages opened, and the paths
// the recorder heard (outside the browser).
async function userLinkActions(sandbox: SandboxDriver, focusLink: () => Promise<void>) {
    const page = sandbox.page;
    const context = page.context();
    let opened = 0;
    context.on('page', () => { opened++; });
    const box = (await page.locator('web-sandbox').boundingBox())!;
    const html = { x: box.x + 50, y: box.y + 20 };
    const svg = { x: box.x + 50, y: box.y + 60 };
    const withKey = async (key: string, at: { x: number; y: number }) => { await page.keyboard.down(key); await page.mouse.click(at.x, at.y); await page.keyboard.up(key); };
    const actions: [string, () => Promise<void>][] = [
        ['Ctrl+click (HTML)', () => withKey('Control', html)],
        ['Shift+click (HTML)', () => withKey('Shift', html)],
        ['middle click (HTML)', () => page.mouse.click(html.x, html.y, { button: 'middle' })],
        ['Ctrl+click (SVG)', () => withKey('Control', svg)],
        ['middle click (SVG)', () => page.mouse.click(svg.x, svg.y, { button: 'middle' })],
        ['Ctrl+Enter (HTML)', async () => { await focusLink(); await page.keyboard.press('Control+Enter'); }],
        ['Shift+Enter (HTML)', async () => { await focusLink(); await page.keyboard.press('Shift+Enter'); }],
    ];
    const results: Record<string, { pages: number; heard: string[] }> = {};
    for (const [name, act] of actions) {
        recorder.clear();
        opened = 0;
        await act();
        await page.waitForTimeout(1500);
        results[name] = { pages: opened, heard: recorder.paths('blocked').filter(path => path.startsWith('/v3-')) };
        for (const other of context.pages()) if (other !== page) await other.close();
    }
    return results;
}

const linkActionsOpen = (opens: boolean) => {
    const one = (path: string) => ({ pages: opens ? 1 : 0, heard: opens ? [path] : [] });
    return {
        'Ctrl+click (HTML)': one('/v3-html'), 'Shift+click (HTML)': one('/v3-html'), 'middle click (HTML)': one('/v3-html'),
        'Ctrl+click (SVG)': one('/v3-svg'), 'middle click (SVG)': one('/v3-svg'),
        'Ctrl+Enter (HTML)': one('/v3-html'), 'Shift+Enter (HTML)': one('/v3-html'),
    };
};

test.describe('V3: the user\'s modifier clicks and Enter on a guest link (cooperative mode: a platform limit, measured; strict mode: nothing opens)', () => {
    test('cooperative mode without allow-popups: Chromium and Firefox open a new tab at the guest\'s URL, which no policy governs; WebKit opens none (see the control below: a measurement limit)', async ({ sandbox, browserName }) => {
        expect(await sandbox.mount({ html: LINKS(recorder.blocked) })).toBe('ready');
        const results = await userLinkActions(sandbox, () => sandbox.run(`document.getElementById('l').focus()`));
        expect(results).toEqual(linkActionsOpen(browserName !== 'webkit'));
    });

    test('positive control of the method, with allow-popups: a click on a target=_blank link opens a tab that reaches the listener on every engine; a Ctrl+click opens one in Chromium and Firefox, and none in Playwright\'s WebKit even here (so WebKit\'s "none" above is a limit of the measurement, not a refusal)', async ({ sandbox, browserName }) => {
        const html = LINKS(recorder.blocked) + `<a id="t" target="_blank" href="${recorder.blocked}/v3-target" style="display:block;width:300px;height:40px">t</a>`;
        expect(await sandbox.mount({ html, unsafeCapabilities: ['allow-popups'] })).toBe('ready');
        const page = sandbox.page;
        const box = (await page.locator('web-sandbox').boundingBox())!;
        const popup = page.context().waitForEvent('page');
        await page.mouse.click(box.x + 50, box.y + 100);
        await (await popup).close();
        await recorder.waitFor('blocked', '/v3-target');

        let opened = 0;
        page.context().on('page', () => { opened++; });
        await page.keyboard.down('Control');
        await page.mouse.click(box.x + 50, box.y + 20);
        await page.keyboard.up('Control');
        await page.waitForTimeout(1500);
        expect([opened, recorder.paths('blocked').includes('/v3-html')]).toEqual(browserName === 'webkit' ? [0, false] : [1, true]);
    });

    test('strict mode: every rendered link is inert (about:blank#): no action opens a tab or reaches the guest\'s URL, on any engine', async ({ sandbox }) => {
        expect(await sandbox.mount({ mode: 'strict' })).toBe('ready');
        await sandbox.run(`sandboxView.render(${JSON.stringify(LINKS(recorder.blocked))})`);
        await sandbox.page.waitForTimeout(500);
        const page = sandbox.page;
        const box = (await page.locator('web-sandbox').boundingBox())!;
        const results = await userLinkActions(sandbox, async () => { await page.mouse.click(box.x + 350, box.y + 150); await page.keyboard.press('Tab'); });
        expect(results).toEqual(linkActionsOpen(false));
    });
});

// ---- L1: a guest cannot outlive terminate() or reset() ------------------------------------------------------------

// A guest that tries to keep running: an interval, a chain of timeouts, a promise loop over a slow fetch, and (where
// the mode has one) a nested worker of its own, each fetching the allowed listener.
const OUTLIVE = (origin: string) => `
    setInterval(() => fetch('${origin}/l1-interval').catch(() => {}), 50);
    (function again() { setTimeout(() => { fetch('${origin}/l1-timeout').catch(() => {}); again(); }, 70); })();
    (async () => { for (;;) { await fetch('${origin}/l1-promise').catch(() => {}); await new Promise((r) => setTimeout(r, 60)); } })();
    if (typeof Worker === 'function') new Worker(URL.createObjectURL(new Blob(["setInterval(() => fetch('${origin}/l1-worker').catch(() => {}), 50)"], { type: 'text/javascript' })));
`;

test.describe('L1: a guest cannot outlive terminate() or reset()', () => {
    for (const mode of ['cooperative', 'worker'] as const) {
        for (const ending of ['terminate', 'reset'] as const) {
            test(`${mode} mode, ${ending}(): timers, a promise loop${mode === 'cooperative' ? ' and a nested worker' : ''} all stop; they ran before (positive control)`, async ({ sandbox }) => {
                expect(await sandbox.mount({ mode, origins: { connect: [recorder.allowed] } })).toBe('ready');
                await sandbox.run(OUTLIVE(recorder.allowed));
                for (const path of ['/l1-interval', '/l1-timeout', '/l1-promise', ...(mode === 'cooperative' ? ['/l1-worker'] : [])]) await recorder.waitFor('allowed', path);
                if (ending === 'terminate') await sandbox.page.evaluate(() => (document.querySelector('web-sandbox') as any).terminate('L1'));
                else expect(await sandbox.reset()).toBe('ready');
                await sandbox.page.waitForTimeout(300); // requests already on their way
                recorder.clear();
                await sandbox.page.waitForTimeout(1500);
                expect(recorder.paths('allowed')).toEqual([]);
            });
        }
    }
});

// ---- L2: a forged announcement to the top window is never accepted -------------------------------------------------

test.describe('L2: an announcement posted to top by a frame the guest creates is never accepted (the guest frame\'s own forgery ends its environment: broad-review.spec.ts, PD8)', () => {
    test('a frame the guest creates posts SANDBOX_PORT with a port to top: the host does not take it, the bridge stays the guest\'s, the forged port hears nothing', async ({ sandbox, page }) => {
        expect(await sandbox.mount({ html: '<p>guest</p>', watchdogTimeout: 2000 })).toBe('ready');
        await page.evaluate(() => {
            (window as any).terminations = [];
            (window as any).forgedDelivered = 0;
            document.querySelector('web-sandbox')!.addEventListener('terminated', (e) => (window as any).terminations.push((e as CustomEvent).detail.reason));
            window.addEventListener('message', (e) => { if (e.data?.type === 'SANDBOX_PORT' && e.data.forged) (window as any).forgedDelivered++; }, true);
        });
        // the nested frame keeps announcing for a while, and reports anything its ports receive to the guest
        await sandbox.run(`
            globalThis.__forgedHeard = [];
            addEventListener('message', (e) => { if (e.data && e.data.forgedHeard) __forgedHeard.push(e.data.forgedHeard); });
            const f = document.createElement('iframe');
            f.srcdoc = '<script>let n = 0; const t = setInterval(() => { const c = new MessageChannel(); c.port1.onmessage = (e) => parent.postMessage({ forgedHeard: JSON.stringify(e.data) }, "*"); top.postMessage({ type: "SANDBOX_PORT", forged: true }, "*", [c.port2]); if (++n > 40) clearInterval(t); }, 25);<\\/script>';
            document.body.append(f);
        `);
        await page.waitForTimeout(2500); // the watchdog pings the real port meanwhile
        expect(await page.evaluate(() => (window as any).forgedDelivered)).toBeGreaterThan(10); // positive control: they reach top
        await sandbox.exposeGuest('twice', '(x) => x * 2');
        expect(await sandbox.call('twice', 21)).toBe(42);
        expect(await page.evaluate(() => (window as any).terminations)).toEqual([]);
        expect(await sandbox.inGuest('return __forgedHeard')).toEqual([]);
    });
});

// ---- PD7: the playground acts only on its own messages ----------------------------------------------------------

test('PD7: the playground ignores a RESET_COMPLETE posted by the guest (it reloads only for its own window\'s message: positive control)', async ({ page }) => {
    await page.goto(`${ORIGIN}/playground/index.html`);
    await page.waitForFunction(() => !!(window as any).SandboxControl);
    const ready = await page.evaluate(() => new Promise<string>((resolve) => {
        const el = (window as any).SandboxControl.sandboxElement;
        el.addEventListener('ready', () => resolve('ready'), { once: true });
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true, html: '<p>pd7</p>' });
        setTimeout(() => resolve('timeout'), 8000);
    }));
    expect(ready).toBe('ready');
    await page.evaluate(() => { (window as any).__pd7NotReloaded = true; });
    await page.evaluate(() => (window as any).SandboxControl.sandboxElement.execute(`parent.parent.postMessage({ type: 'RESET_COMPLETE' }, '*')`));
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as any).__pd7NotReloaded)).toBe(true);
    // positive control: the page's own message reloads it
    await Promise.all([page.waitForEvent('load'), page.evaluate(() => window.postMessage({ type: 'RESET_COMPLETE' }, '*'))]);
    expect(await page.evaluate(() => (window as any).__pd7NotReloaded)).toBeUndefined();
});

// ---- H1: session history (a cooperative-mode limit, measured) -----------------------------------------------------

test.describe('H1 (residual, measured): the guest adds entries to the tab\'s session history; the host URL itself never changes', () => {
    test('fragment navigations: one entry each, on every engine, so the host page\'s back button first walks the guest\'s', async ({ sandbox, page }) => {
        expect(await sandbox.mount({ html: '<p>guest</p>' })).toBe('ready');
        const before = await page.evaluate(() => history.length);
        const url = page.url();
        await sandbox.run(`location.hash = 'h1'; setTimeout(() => { location.hash = 'h2'; }, 50);`);
        await page.waitForTimeout(500);
        expect(page.url()).toBe(url);
        expect(await page.evaluate(() => history.length) - before).toBe(2);
    });

    test('a navigation the wrapper refuses: one entry in Chromium (it commits an error page), none in Firefox and WebKit', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ html: '<p>guest</p>' })).toBe('ready');
        const before = await page.evaluate(() => history.length);
        const url = page.url();
        await sandbox.run(`location.href = 'https://example.invalid/h1-refused';`);
        await page.waitForTimeout(1500);
        expect(page.url()).toBe(url);
        expect(await page.evaluate(() => history.length) - before).toBe(browserName === 'chromium' ? 1 : 0);
    });
});
