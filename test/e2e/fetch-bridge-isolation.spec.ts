import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import { useRecorder } from './recorder';
import type { Page } from '@playwright/test';

/**
 * Where a bridge request runs (BD1:ISO-1, class E-net; ADR-006; src/lib/bridge-frame.ts): the host decides it and the
 * bridge's own frame, an opaque origin of the library's, makes it. So nothing of the host page's fetch environment
 * applies to it: not the host page's Service Worker (a cache-first one would answer from the host app's cache), not a
 * wrapper of the host page's fetch (an auth wrapper would add the user's token), and the target sees `Origin: null`.
 *
 * Evidence: the recorder's listeners outside the browser (recorder.ts) see what left the browser, with its headers; the
 * guest's own result; the host's 'fetch' events. Each test has its positive control: the host page's own request, under
 * the same Service Worker or wrapper, does get the cached data or the token, so the absence in the bridge's is the
 * bridge's doing. Playwright's Firefox never lets a Service Worker control the harness page (the review's probes, and
 * the control below): there the Service Worker test asserts what it can, that the request reached the network.
 */

const recorder = useRecorder();

const PRIVATE = 'PRIVATE-USER-DATA of the signed-in user';
const TOKEN = 'Bearer USER-SESSION-TOKEN';
const STARTUP_BLOCKED = "the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (see docs/API.md#host-page-policy)";
const BRIDGE_REFUSED = "the fetch bridge's frame did not start: the host page's Content-Security-Policy must allow its script, the hash viewScriptHash() returns (see docs/API.md#host-page-policy)";

const bridgeTo = (...allow: string[]) => ({ fetchBridge: { allow } });

// What the guest saw of one sandboxFetch(): status and text, or the refusal.
const fetchInGuest = (url: string) => `
    try {
        const response = await sandboxFetch(${JSON.stringify(url)});
        return { status: response.status, text: await response.text() };
    } catch (e) {
        return { code: e && e.code, message: String(e && e.message) };
    }`;

/** The bridge's frame in the element's shadow root: hidden, sandboxed, after the wrapper; both credentialless (BD3:NEW-5). */
const bridgeFrames = (page: Page) => page.evaluate(() => [...(document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelectorAll('iframe')]
    .map(frame => ({
        sandbox: frame.getAttribute('sandbox'), hidden: frame.hidden,
        credentialless: frame.hasAttribute('credentialless'),
    })));

test("the host page's cache-first Service Worker never answers a bridge request: the request reaches the network, and the guest never sees the host app's cached data", async ({ sandbox, page, browserName }) => {
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/test/e2e/bridge-sw.js', { scope: '/test/e2e/' });
        await navigator.serviceWorker.ready;
    });
    await sandbox.open(); // reloaded, so the worker controls the page from its start
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    const url = `${recorder.allowed}/iso-me`;
    // the host app's own data for that URL, cached as a runtime-caching worker caches a credentialed API response
    await page.evaluate(async ({ url, body }) => {
        const cache = await caches.open('api');
        await cache.put(url, new Response(body, { headers: { 'content-type': 'text/plain' } }));
    }, { url, body: PRIVATE });
    try {
        // positive control: where the worker controls the page, the host page's own request is answered from the cache
        const own = await page.evaluate(async (url) => (await fetch(url)).text(), url);
        // ledger: service-worker-control
        if (browserName === 'firefox') {
            // Playwright's Firefox: the worker never controls the harness, so the control shows nothing either way
            test.info().annotations.push({ type: 'limit', description: `Firefox: Service Worker controlling the harness: ${controlled}` });
        } else {
            expect(controlled).toBe(true);
            expect(own).toBe(PRIVATE);
        }
        recorder.clear();

        expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');
        const result = await sandbox.inGuest(fetchInGuest(url));
        expect(result).toEqual({ status: 200, text: 'ok' }); // the network's answer, never the cache's
        expect(recorder.paths('allowed')).toEqual(['/iso-me']);
        expect(await sandbox.waitForFetch(url)).toMatchObject({ outcome: 'ok', status: 200 });
    } finally {
        await page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); });
    }
});

test("a wrapper of the host page's fetch never applies to a bridge request: an auth wrapper's token never reaches the target", async ({ sandbox, page }) => {
    // the host app's auth wrapper: the user's token on every request to its API origin
    await page.evaluate(({ api, token }) => {
        const original = window.fetch;
        window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (!url.startsWith(api)) return original(input, init);
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            headers.set('authorization', token);
            return original(input, { ...init, headers });
        };
    }, { api: recorder.allowed, token: TOKEN });
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');

    const echo = await sandbox.inGuest(`return (await sandboxFetch('${recorder.allowed}/echo?bridged')).json()`);
    expect(echo.headers.authorization).toBeUndefined();
    const hit = recorder.hits.find(h => h.server === 'allowed' && h.path === '/echo?bridged' && h.method === 'GET')!;
    expect(hit.headers.authorization).toBeUndefined();

    // positive control: the host page's own request goes through the wrapper and carries the token (its GET, after the
    // preflight the header causes)
    await page.evaluate((url) => fetch(url).then(r => r.text()), `${recorder.allowed}/echo?own`);
    expect(recorder.hits.find(h => h.server === 'allowed' && h.path === '/echo?own' && h.method === 'GET')!.headers.authorization).toBe(TOKEN);
});

test('the target sees Origin: null, no Referer and no Cookie, in every mode; the guest has no handle on the frame that made it; the frame is credentialless like the wrapper', async ({ sandbox, page }) => {
    await page.evaluate(() => { document.cookie = 'harness_secret=h1; path=/'; });
    for (const mode of ['strict', 'worker', 'cooperative'] as const) {
        recorder.clear();
        const config = mode === 'cooperative' ? { mode, capabilities: ['allow-scripts' as const], ...bridgeTo(recorder.allowed, ORIGIN) } : { mode, ...bridgeTo(recorder.allowed, ORIGIN) };
        expect(await sandbox.mount(config), mode).toBe('ready');
        const echo = await sandbox.inGuest(`return (await sandboxFetch('${recorder.allowed}/echo?${mode}')).json()`);
        const hit = recorder.hits.find(h => h.server === 'allowed' && h.path === `/echo?${mode}`)!;
        for (const headers of [hit.headers, echo.headers]) {
            expect(headers.origin, mode).toBe('null');
            expect(headers.referer, mode).toBeUndefined();
            expect(headers.cookie, mode).toBeUndefined();
        }
        // the host page's own origin, listed: still Origin: null, and none of its cookies
        const own = await sandbox.inGuest(`return (await sandboxFetch('${ORIGIN}/__echo?${mode}')).json()`);
        expect(own.headers.origin, mode).toBe('null');
        expect(own.headers.cookie, mode).toBeUndefined();
        expect(await bridgeFrames(page), mode).toEqual([
            { sandbox: expect.any(String), hidden: false, credentialless: true }, // the wrapper, first
            { sandbox: 'allow-scripts', hidden: true, credentialless: true }, // (cookies.spec.ts: what the engines make of the attribute)
        ]);
    }
    // the guest's own frame tree: the bridge's frame is in the element's shadow root, which no window lists
    expect(await sandbox.inGuest('return { top: top.length, parent: parent.length }')).toEqual({ top: 0, parent: 1 });
});

test('teardown aborts a request in flight: terminate() and removal close the upstream connection, the frame goes with the environment, and the record is aborted', async ({ sandbox, page }) => {
    for (const end of ['terminate', 'remove'] as const) {
        recorder.clear();
        await page.evaluate(() => { (window as any).sandboxFetches.length = 0; });
        expect(await sandbox.mount(bridgeTo(recorder.allowed)), end).toBe('ready');
        await sandbox.run(`sandboxFetch('${recorder.allowed}/slow?${end}').catch(() => {})`);
        await recorder.waitFor('allowed', `/slow?${end}`);
        const slow = () => recorder.hits.find(h => h.server === 'allowed' && h.path === `/slow?${end}`)!;
        await page.waitForTimeout(500);
        expect(slow().closedEarly, end).toBe(false); // control: left alone, it stays open

        if (end === 'terminate') await page.evaluate(() => (document.querySelector('web-sandbox') as any).terminate());
        else await page.evaluate(() => { const el = document.querySelector('web-sandbox')!; const parent = el.parentNode!; el.remove(); parent.appendChild(el); });
        await expect.poll(() => slow().closedEarly, { message: end }).toBe(true);
        expect(await sandbox.waitForFetch(`${recorder.allowed}/slow?${end}`), end).toMatchObject({ outcome: 'aborted', code: 'FETCH_FAILED' });
        if (end === 'terminate') expect((await bridgeFrames(page)).filter(frame => frame.hidden), end).toEqual([]);
    }
});

/** Opens the harness served with a host policy of its own (vite.config.ts, /__host-policy). */
async function openWithPolicy(page: Page, csp: string | null) {
    await page.goto(`${ORIGIN}/__host-policy${csp ? `?${new URLSearchParams({ csp })}` : ''}`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
}

async function configure(sandbox: SandboxDriver, config: object): Promise<{ type: string; reason: string | null }[]> {
    await sandbox.page.evaluate(() => { (window as any).sandboxEvents.length = 0; });
    await sandbox.page.evaluate((c) => whenSettled(s => s.setConfig(c)), config as any);
    return sandbox.page.evaluate(() => [...(window as any).sandboxEvents]);
}

test.describe('the host page policy', () => {
    test("with the view's hash alone in script-src (what docs/API.md says to allow), the bridge's frame runs: one hash admits both", async ({ sandbox, page }) => {
        await openWithPolicy(page, null);
        const hash = await page.evaluate(() => (window as any).viewScriptHash());
        await openWithPolicy(page, `script-src 'self' 'unsafe-eval' ${hash}; worker-src blob:`);
        expect(await configure(sandbox, { scriptUnsafe: true, ...bridgeTo(recorder.allowed) })).toEqual([{ type: 'ready', reason: null }]);
        expect(await sandbox.inGuest(fetchInGuest(`${recorder.allowed}/iso-hash`))).toEqual({ status: 200, text: 'ok' });
        expect(recorder.paths('allowed')).toEqual(['/iso-hash']);
    });

    test('without the hash, the sandbox fails closed with the documented startup reason, and no request is made', async ({ sandbox, page }) => {
        await openWithPolicy(page, "script-src 'self' 'unsafe-eval'; worker-src blob:");
        expect(await configure(sandbox, { scriptUnsafe: true, ...bridgeTo(recorder.allowed) })).toEqual([{ type: 'terminated', reason: STARTUP_BLOCKED }]);
        await page.waitForTimeout(300);
        expect(recorder.paths('allowed')).toEqual([]);
        expect(await sandbox.fetches()).toEqual([]);
    });

    test("a bridge frame whose script a policy refuses: the bridge fails closed, every request refused with FETCH_FAILED and the reason in its record; the sandbox stays ready", async ({ sandbox, page }) => {
        // The library's documents share one hash, so no host page policy admits the sandbox and refuses only the bridge's
        // frame: here the frame's own policy refuses its script (its hash replaced, in the one srcdoc the element
        // writes for it), which the library sees exactly as a refusal by the host page's policy.
        await page.evaluate(() => {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
            Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
                configurable: true,
                get: descriptor.get,
                set(value: string) {
                    const text = String(value);
                    const replaced = text.includes('data-role="fetch-bridge"') ? text.replace(/script-src 'sha256-[A-Za-z0-9+/=]+'/, `script-src 'sha256-${'A'.repeat(43)}='`) : text;
                    descriptor.set!.call(this, replaced);
                },
            });
        });
        const warnings: string[] = [];
        page.on('console', message => { if (message.type() === 'warning' && message.text().includes("fetch bridge's frame")) warnings.push(message.text()); });
        expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');
        const refused = await sandbox.inGuest(fetchInGuest(`${recorder.allowed}/iso-refused`));
        expect(refused).toMatchObject({ code: 'FETCH_FAILED' });
        expect(await sandbox.waitForFetch(`${recorder.allowed}/iso-refused`)).toMatchObject({ outcome: 'refused', code: 'FETCH_FAILED', reason: BRIDGE_REFUSED, bytes: 0 });
        expect(await sandbox.state()).toBe('ready');
        expect(await sandbox.inGuest('return 1 + 1')).toBe(2);
        expect(recorder.paths('allowed')).toEqual([]);
        expect(warnings).toHaveLength(1);
    });
});
