import { test, expect, ORIGIN } from './fixture';
import { TERMINATION_REASONS } from '@src/lib/reasons';
import { waitInView, inFrames } from './strict-view';
import {
    RealisticHost, covering, guestBattery, startSiblingApi, cookieNames, hitsNamed, HOST_COOKIES, HOST_TOKEN,
    type Directives,
} from './realistic-host';
import type { Page } from '@playwright/test';

/**
 * The library's core flows on a host page that looks like a production application (realistic-host.ts: a strict CSP that
 * admits the library the way docs/API.md#host-page-policy says, Trusted Types enforced with a default policy, a cache-first
 * Service Worker and an Authorization `fetch` wrapper for the application's own API, cookies on the host site with SameSite
 * None, Lax and Strict, and optionally cross-origin isolation), in strict mode (the default, and with `origins` and
 * `fetchBridge`), cooperative mode and worker mode. Each assertion names the INHERITED_CONTEXT row it covers
 * (`covering('row', …)`, src/lib/inherited-context.ts); test/unit/realistic-host-coverage.test.ts fails on a row no
 * assertion of this spec or of the directive matrix names.
 *
 * Evidence is the test server's, outside the browser (realistic-host-server.ts): each request that reached the application's API
 * with the headers it carried, each request its Service Worker handled, each CSP report; and a listener on another port
 * for the origins a guest may reach (realistic-host.ts, startSiblingApi). Every test has its positive control: the
 * application's own request, on the same page, does carry the cookies and the token and does go through the Service Worker, so
 * their absence in the sandbox's is the library's doing.
 */

test.use({ ignoreHTTPSErrors: true });

const TERMINATED_BY_HOST = TERMINATION_REASONS.host.text;
const READY = [{ type: 'ready', reason: null }];
const CACHED = 'HOST-CACHED-PRIVATE-DATA';

/** The host's connect-src and img-src, widened to the origins a test lists (the policy narrows `origins`: docs/API.md#host-page-policy). */
const allowing = (...origins: string[]) => (base: Directives): Directives => ({
    ...base,
    'connect-src': [...base['connect-src']!, ...origins],
    'img-src': [...base['img-src']!, ...origins],
});

/** Heights of the wrapper and of the frame inside it, read from outside. */
async function frameHeights(page: Page, browserName: string): Promise<number[]> {
    const values = await inFrames<number>(page, browserName, 'innerHeight', (path) => path === 'main/wrapper' || path === 'main/wrapper/view');
    return values.filter(v => v.value !== 'no-context').map(v => v.value as number);
}

/**
 * The host page's own violation, so that the channels the quiet checks read are known to work on this engine; what the page
 * has reported and been sent at this point is the baseline, and the library's writes after it must add nothing.
 */
async function quietBaseline(host: RealisticHost) {
    await host.page.evaluate(() => fetch('https://control.invalid/x').catch(() => {}));
    await expect.poll(() => host.cspViolations(), { message: 'the page reports its own connect-src violation (the control)' }).toHaveLength(1);
    await host.page.waitForTimeout(500); // a report-uri post is sent after the event
    return { violations: await host.cspViolations(), reports: (await host.hits()).reports.length, consoleErrors: [...host.consoleErrors] };
}

async function expectQuiet(host: RealisticHost, baseline: Awaited<ReturnType<typeof quietBaseline>>, label: string) {
    await host.page.waitForTimeout(500);
    expect(await host.cspViolations(), covering('trustedTypesRequirement', `${label}: the library's own writes give the host page no securitypolicyviolation event`)).toEqual(baseline.violations);
    expect((await host.hits()).reports.length, covering('trustedTypesRequirement', `${label}: nor a CSP report to the page's report-uri`)).toBe(baseline.reports);
    expect(host.consoleErrors, covering('trustedTypesRequirement', `${label}: nor a console error`)).toEqual(baseline.consoleErrors);
    expect(await host.ttDefaultCalls(), covering('trustedTypesDefault', `${label}: the host's Trusted Types default policy is never asked for a string of the library's`)).toEqual([]);
    expect(await host.reportedErrors(), covering('hostRealmGlobals', `${label}: the host's error reporter sees no error or rejection of the library's host code`)).toEqual([]);
    expect(host.pageErrors, covering('hostRealmGlobals', `${label}: nor an uncaught exception`)).toEqual([]);
    expect(await host.page.evaluate(() => (window as any).sandboxViolations), covering('trustedTypesRequirement', `${label}: nor a 'violation' event of the element`)).toEqual([]);
}

/** The Service Worker reports each request it handled after answering it: waits for the entries of one API name. */
async function expectServiceWorkerLog(host: RealisticHost, name: string, expected: string[]) {
    await expect.poll(async () => (await host.hits()).serviceWorker.filter(entry => entry.path.endsWith(`/${name}`)).map(entry => entry.from), { message: `the host's Service Worker handled ${name}` }).toEqual(expected);
}

/** The host's own request, the positive control of every test below: its cookies, its token, its Service Worker. */
async function ownRequestControl(host: RealisticHost, name: string, browserName: string) {
    const worker = await host.serviceWorker();
    expect(worker.registered, 'the host page registered its Service Worker').toBe(true);
    test.info().annotations.push({ type: 'service-worker', description: `controlling the page: ${worker.controlled}` });
    const first = await host.hostFetch(name);
    const second = await host.hostFetch(name);
    const hits = await host.hits();
    const own = hitsNamed(hits.api, name);
    // the application's own request reached the server once, with its cookies and its token (the wrapper added it)
    expect(own[0]!.headers.authorization, "the application's own request carries the user's token").toBe(HOST_TOKEN);
    // (WebKit does not send a Secure cookie to this http test server, though it stores it; a production host is https)
    // ledger: secure-cookie-over-http
    const secureOnHttp = browserName === 'webkit' ? HOST_COOKIES.filter(cookie => !cookie.attributes.includes('Secure')) : HOST_COOKIES;
    expect(cookieNames(own[0]!.headers.cookie), "the application's own request carries the host cookies").toEqual(secureOnHttp.map(cookie => cookie.name).sort());
    if (worker.controlled) {
        // and the second answer came from the Service Worker's cache, without reaching the server
        expect(own, 'the cache-first Service Worker answers the second request').toHaveLength(1);
        expect(second.body).toBe(first.body);
        await expectServiceWorkerLog(host, name, ['network', 'cache']);
    } else {
        expect(own).toHaveLength(2);
    }
    return worker;
}

test.describe('strict mode (the default)', () => {
    test('the default configuration starts on the production host, renders, runs its worker, and stops cleanly', async ({ sandbox, page, browserName }) => {
        const host = await RealisticHost.open(sandbox, { mode: 'strict' });
        const baseline = await quietBaseline(host);
        await host.page.evaluate(() => { (window as any).sandboxEvents.length = 0; });

        const events = await host.embed('strict', { guest: "return { origin: self.origin, isolated: self.crossOriginIsolated, document: typeof document };" });
        expect(events, covering('cspScript', "the view bootstrap's hash in the page's script-src admits strict mode: ready, and it stays ready")).toEqual(READY);
        await waitInView(page, browserName, `!!document.getElementById('hello')`);
        expect(await host.guestResult(), covering('cspWorker', "the guest's worker started under worker-src 'self' blob:")).toEqual({ origin: 'null', isolated: false, document: 'undefined' });
        expect(await frameHeights(page, browserName), covering('cspStyle', "the wrapper style's hash admits the wrapper's style: the frames fill the element")).toEqual([300, 300]);
        expect(await host.state(), covering('cspBaseUri', "base-uri 'self' about: admits the wrapper's <base>: the sandbox is ready")).toBe('ready');
        expect(await host.sandbox.terminations(), covering('cspBaseUri', 'and no termination was recorded')).toEqual([]);
        expect(host.consoleWarnings.filter(line => line.startsWith('[Sandbox]')), covering('cspStyle', 'and the element warned of no refused style')).toEqual([]);
        await expectQuiet(host, baseline, 'strict mode, default configuration');

        // stops cleanly: terminate() ends the environment, leaves no frame, and the host page is its own again
        await page.evaluate(() => (document.querySelector('web-sandbox') as any).terminate());
        expect(await host.state(), covering('thread', 'terminate() ends the sandbox')).toBe('terminated');
        expect(await host.frames(), covering('thread', 'and removes every frame it held')).toBe(0);
        expect((await host.sandbox.terminations()).map(entry => entry.reason), covering('thread', 'with the reason the host gave')).toEqual([TERMINATED_BY_HOST]);
        expect(await page.evaluate(() => 1 + 1), covering('thread', 'the host page answers')).toBe(2);
        expect(await host.hostFetch('after'), covering('thread', "and its own API works after the sandbox ended")).toMatchObject({ status: 200 });
    });

    test('with origins and a fetchBridge: no request of the guest or of the bridge carries a host cookie or the Authorization header, none passes through the host Service Worker, and the bridge answers from the network', async ({ sandbox, browserName }) => {
        const sibling = await startSiblingApi();
        try {
            const host = await RealisticHost.open(sandbox, { mode: 'strict', directives: allowing(ORIGIN, sibling.sameSite, sibling.crossSite) });
            await host.seedCache('priv', CACHED);
            const worker = await ownRequestControl(host, 'control', browserName);
            // the application's own read of the URL the bridge will fetch: the Service Worker's cache answers it
            expect((await host.hostFetch('priv')).body, covering('serviceWorker', "positive control: the host's own request is answered from the cache")).toBe(worker.controlled ? CACHED : '{"name":"priv","n":1}');
            await expectServiceWorkerLog(host, 'priv', worker.controlled ? ['cache'] : []);
            await host.hits(true);

            const events = await host.embed('strict', {
                origins: { connect: [sibling.sameSite, sibling.crossSite, ORIGIN] },
                fetchBridge: { allow: [ORIGIN, sibling.sameSite, sibling.crossSite] },
                guest: guestBattery({
                    direct: { same: `${sibling.sameSite}/api/same`, cross: `${sibling.crossSite}/api/cross`, own: host.api('own-direct') },
                    bridge: { bridged: host.api('priv'), bsame: `${sibling.sameSite}/api/bsame`, bcross: `${sibling.crossSite}/api/bcross` },
                }),
            });
            expect(events).toEqual(READY);
            const guest = await host.guestResult();
            const hits = await host.hits();
            const reached = [...hits.api.map(hit => ({ at: 'host', ...hit })), ...sibling.hits.map(hit => ({ at: 'sibling', ...hit }))];

            // the bridge: from its own frame, so none of the host page's fetch environment applies
            expect(guest['bridged:bridge'], covering('serviceWorker', "the bridge's request is answered by the network, never by the host's cache")).toEqual({ name: 'priv', n: 1 });
            const bridged = hitsNamed(hits.api, 'priv');
            expect(bridged, covering('serviceWorker', "the bridge's request reached the server")).toHaveLength(1);
            expect(hits.serviceWorker.filter(entry => entry.path.endsWith('/priv')), covering('serviceWorker', "and the host's Service Worker did not handle it")).toEqual([]);
            expect(bridged[0]!.headers.authorization, covering('hostRealmGlobals', "the host's fetch wrapper did not apply to it: no Authorization header")).toBeUndefined();
            expect(bridged[0]!.headers.cookie, covering('cookies', 'the bridge sends no host cookie')).toBeUndefined();
            expect(bridged[0]!.headers.referer, covering('referrer', "nor the host page's URL as a Referer")).toBeUndefined();
            expect(bridged[0]!.headers.origin, covering('documentOrigin', "the bridge's frame has an opaque origin")).toBe('null');
            expect(sibling.named('bsame').concat(sibling.named('bcross')), covering('cookies', 'the bridge reached both siblings')).toHaveLength(2);

            // the guest's own requests: an origin on the host page's site is dropped in strict mode, another site's is kept
            expect(hitsNamed(hits.api, 'own-direct'), covering('cookies', "the host page's own origin listed in origins.connect is dropped in strict mode: nothing reached its API")).toEqual([]);
            expect(sibling.named('same'), covering('cookies', 'an origin on the host page\'s site is dropped in strict mode: nothing reached it')).toEqual([]);
            expect(sibling.named('cross').length, covering('cookies', "an origin on another site is kept (the positive control of the drop above)")).toBeGreaterThan(0);

            for (const hit of reached) {
                const label = `${hit.at} ${hit.method} ${hit.name}`;
                expect(hit.headers.cookie, covering('cookies', `${label}: no host cookie (${browserName})`)).toBeUndefined();
                expect(hit.headers.authorization, covering('hostRealmGlobals', `${label}: no Authorization header`)).toBeUndefined();
                expect(hit.headers.referer, covering('referrer', `${label}: no Referer`)).toBeUndefined();
                expect(hit.headers.origin, covering('documentOrigin', `${label}: Origin: null`)).toBe('null');
            }
            const fetched = await host.page.evaluate(() => (window as any).sandboxFetches as { outcome: string }[]);
            expect(fetched.map(record => record.outcome), covering('hostRealmGlobals', "the element's 'fetch' events record the bridge's three requests")).toEqual(['ok', 'ok', 'ok']);
        } finally {
            await sibling.stop();
        }
    });

    // docs/API.md#host-page-policy: the host page's connect-src narrows `origins.connect` and `fetchBridge.allow`, the same on
    // every engine: the library applies the page's policy itself (host-csp.ts reads it once; host-connect.ts parses it), where the
    // engines differ on what a `'self'` source admits in a sandboxed frame (CONNECT_ENGINE_FACTS). `'none'` and `'self'` both
    // refuse the listed origin.
    for (const value of ["'none'", "'self'"]) {
        test(`the host page's connect-src ${value} narrows origins and the bridge's allow list on every engine; admitting the origin is all that changes`, async ({ sandbox, browserName }) => {
            const sibling = await startSiblingApi();
            try {
                const guest = guestBattery({ direct: { cross: `${sibling.crossSite}/api/cross` }, bridge: { bcross: `${sibling.crossSite}/api/bcross` } });
                const config = { origins: { connect: [sibling.crossSite] }, fetchBridge: { allow: [sibling.crossSite] }, guest };

                const narrowed = await RealisticHost.open(sandbox, { mode: 'strict', directives: base => ({ ...base, 'connect-src': [value] }) });
                expect(await narrowed.embed('strict', config)).toEqual(READY);
                const seen = await narrowed.guestResult();
                await narrowed.page.waitForTimeout(300);
                expect(sibling.hits, covering('cspFetch', `connect-src ${value} on the host page: neither the guest's own request nor the bridge's reached the listed origin (${browserName})`)).toEqual([]);
                expect(String(seen['bcross:bridge']), covering('cspFetch', 'the bridge refused the request (the guest sees an error code)')).toMatch(/^ERR /);
                expect(narrowed.consoleWarnings.filter(text => text.startsWith('[Sandbox] origins.connect dropped') || text.startsWith('[Sandbox] fetchBridge.allow dropped')), covering('cspFetch', 'the library dropped the origin from both lists, with a warning for each, before it wrote the policies')).toHaveLength(2);
                expect(await narrowed.state(), covering('cspFetch', 'the refusal does not end the sandbox')).toBe('ready');

                sibling.hits.length = 0;
                const admitted = await RealisticHost.open(sandbox, { mode: 'strict', directives: allowing(sibling.crossSite) });
                expect(await admitted.embed('strict', config)).toEqual(READY);
                expect((await admitted.guestResult())['bcross:bridge'], covering('cspFetch', 'with the origin in connect-src, the same configuration reaches it through the bridge')).toEqual({ sibling: true });
                expect(sibling.named('cross').length, covering('cspFetch', 'and directly')).toBeGreaterThan(0);
            } finally {
                await sibling.stop();
            }
        });
    }
});

test.describe('cooperative mode', () => {
    test("starts on the production host (script-src 'unsafe-inline', Trusted Types enforced), runs the guest's inline script, and stops cleanly", async ({ sandbox, page, browserName }) => {
        const host = await RealisticHost.open(sandbox, { mode: 'cooperative' });
        const baseline = await quietBaseline(host);
        const events = await host.embed('cooperative', { guest: 'return { ran: true };' });
        expect(events, covering('cspScript', "script-src 'unsafe-inline' admits the bootstrap and the guest's inline script")).toEqual(READY);
        expect(await host.guestResult(), covering('trustedTypesRequirement', 'the guest inherits the Trusted Types requirement and its script still ran (written through the policy)')).toEqual({ ran: true });
        const guestFrames = (await inFrames<number>(page, browserName, 'innerHeight', (path) => path.split('/').length === 3)).filter(v => v.value !== 'no-context').map(v => v.value);
        expect(guestFrames, covering('cspStyle', "style-src 'unsafe-inline' admits the wrapper's style: the guest frame fills the element")).toEqual([300]);
        expect(await host.state(), covering('cspBaseUri', "base-uri 'self' about: admits the wrapper's <base>")).toBe('ready');
        await expectQuiet(host, baseline, 'cooperative mode');

        const sandboxFlags = await page.evaluate(() => [...(document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelectorAll('iframe')].map(frame => ({ sandbox: frame.getAttribute('sandbox'), allow: frame.getAttribute('allow') })));
        expect(sandboxFlags, covering('permissionsPolicy', "the host's Permissions-Policy only narrows: the frame delegates nothing (no allow attribute)")).toEqual([{ sandbox: 'allow-scripts', allow: null }]);
        expect(sandboxFlags[0]!.sandbox, covering('uiSurfaces', 'and carries no top-navigation, popup or same-origin flag')).not.toMatch(/top-navigation|popups|same-origin|modals|pointer-lock/);

        await page.evaluate(() => (document.querySelector('web-sandbox') as any).terminate());
        expect(await host.state(), covering('thread', 'terminate() ends it')).toBe('terminated');
        expect(await host.frames(), covering('thread', 'and removes its frames')).toBe(0);
    });

    test("the guest document reads nothing of the host page: an opaque origin, the srcdoc URL, an inert base, no referrer, no cookie or storage, and it cannot navigate the host", async ({ sandbox, page, browserName }) => {
        const host = await RealisticHost.open(sandbox, { mode: 'cooperative' });
        await page.evaluate(() => { document.cookie = 'script_visible=1; path=/'; });
        const facts = `
            const tryIt = (fn) => { try { return fn(); } catch (e) { return 'ERR ' + e.name; } };
            out.origin = self.origin;
            out.href = tryIt(() => String(location.href));
            out.base = tryIt(() => document.baseURI);
            out.referrer = tryIt(() => document.referrer);
            out.cookie = tryIt(() => document.cookie);
            out.storage = tryIt(() => localStorage.getItem('host_token'));
            out.ancestors = tryIt(() => Array.from(location.ancestorOrigins || []));
            out.topNav = tryIt(() => { top.location.href = ${JSON.stringify(`${ORIGIN}/__realistic-host/hijacked`)}; return 'no throw'; });`;
        expect(await host.embed('cooperative', { guest: guestBattery({}, facts) })).toEqual(READY);
        const guest = await host.guestResult();
        await page.waitForTimeout(500);

        expect(guest.origin, covering('documentOrigin', "the guest's origin is opaque")).toBe('null');
        expect(guest.href, covering('documentOrigin', "and its URL is about:srcdoc, not the host page's")).toBe('about:srcdoc');
        expect(guest.base, covering('cspBaseUri', "the guest's base URL is about:blank, not the host page's URL")).toBe('about:blank');
        expect(guest.referrer, covering('referrer', 'the guest document has no referrer')).toBe('');
        expect(String(guest.cookie), covering('documentOrigin', "the guest reads none of the host's cookies (WebKit answers an empty string, the others throw)")).not.toMatch(/hs_|script_visible/);
        expect(String(guest.storage), covering('documentOrigin', "and none of the host's storage")).toMatch(/^ERR SecurityError$/);
        // location.ancestorOrigins: the host origin, which is not a secret (documented as a cooperative limit; Firefox has none)
        const ancestors: string[] = guest.ancestors;
        expect(ancestors.filter(origin => origin !== 'null' && origin !== ORIGIN), covering('ancestorOrigins', 'the guest sees at most the host origin and the opaque wrapper')).toEqual([]);
        // ledger: ancestor-origins
        if (browserName === 'firefox') expect(ancestors, covering('ancestorOrigins', 'Firefox has no ancestorOrigins')).toEqual([]);
        else expect(ancestors, covering('ancestorOrigins', 'the host origin is shown to the guest (documented)')).toEqual(['null', ORIGIN]);
        expect(page.url(), covering('uiSurfaces', "the guest's attempt to navigate the top window did not move the host page")).toContain('/__realistic-host/page?');
        expect(String(guest.topNav), covering('uiSurfaces', 'and threw in the guest')).toMatch(/^ERR /);
    });

    test('the network battery: the guest, its images and the bridge carry no host cookie, the host page site is not reachable, and never the Authorization header, a Referer or the Service Worker', async ({ sandbox, browserName }) => {
        const sibling = await startSiblingApi();
        try {
            const host = await RealisticHost.open(sandbox, { mode: 'cooperative', directives: allowing(ORIGIN, sibling.sameSite, sibling.crossSite) });
            await host.seedCache('priv', CACHED);
            const worker = await ownRequestControl(host, 'control', browserName);
            await host.hostFetch('priv');
            await expectServiceWorkerLog(host, 'priv', worker.controlled ? ['cache'] : []);
            await host.hits(true);

            const events = await host.embed('cooperative', {
                origins: { connect: [sibling.sameSite, sibling.crossSite, ORIGIN], images: [sibling.sameSite, sibling.crossSite] },
                fetchBridge: { allow: [ORIGIN, sibling.sameSite, sibling.crossSite] },
                guest: guestBattery({
                    direct: { same: `${sibling.sameSite}/api/same`, cross: `${sibling.crossSite}/api/cross` },
                    images: { sameimg: `${sibling.sameSite}/api/same.svg`, crossimg: `${sibling.crossSite}/api/cross.svg` },
                    bridge: { bridged: host.api('priv'), bsame: `${sibling.sameSite}/api/bsame`, bcross: `${sibling.crossSite}/api/bcross` },
                }),
            });
            expect(events).toEqual(READY);
            const guest = await host.guestResult();
            const hits = await host.hits();

            // an origin on the host page's site is dropped in every mode (with a warning): the guest's fetch, no-cors POST and image to it are refused
            const sameSiteHits = [...sibling.named('same'), ...sibling.named('same.svg')];
            expect(sameSiteHits, covering('cookies', "no request of the guest reaches the host page's site: the origin is dropped, so no engine's cookie rule applies")).toEqual([]);
            const crossSiteHits = [...sibling.named('cross'), ...sibling.named('cross.svg')];
            expect(crossSiteHits.length, covering('cookies', 'the requests to another site arrived')).toBe(3);
            for (const hit of crossSiteHits) expect(hit.headers.cookie, covering('cookies', `another site gets none of the host's cookies — ${hit.method} ${hit.name}`)).toBeUndefined();

            for (const hit of [...sibling.hits, ...hits.api]) {
                const label = `${hit.method} ${hit.name}`;
                expect(hit.headers.authorization, covering('hostRealmGlobals', `${label}: the host's fetch wrapper adds its Authorization header to its own requests only`)).toBeUndefined();
                expect(hit.headers.referer, covering('referrer', `${label}: the guest sends no Referer`)).toBeUndefined();
            }
            const bridged = hitsNamed(hits.api, 'priv');
            expect(guest['bridged:bridge'], covering('serviceWorker', "the bridge's request is answered by the network, not the host's cache")).toEqual({ name: 'priv', n: 1 });
            expect(bridged, covering('serviceWorker', 'and reached the server')).toHaveLength(1);
            expect(bridged[0]!.headers.cookie, covering('cookies', 'with no host cookie')).toBeUndefined();
            expect(hits.serviceWorker.filter(entry => entry.path.endsWith('/priv')), covering('serviceWorker', 'and the host Service Worker did not handle it')).toEqual([]);
            expect(worker.registered).toBe(true);
            for (const name of ['bsame', 'bcross']) {
                const bridgeHit = sibling.named(name)[0]!;
                expect(bridgeHit.headers.cookie, covering('cookies', `the bridge sends no cookie, to the host page's site either (${name})`)).toBeUndefined();
                expect(bridgeHit.headers.origin, covering('documentOrigin', `Origin: null (${name})`)).toBe('null');
            }
        } finally {
            await sibling.stop();
        }
    });
});

test.describe('worker mode', () => {
    test('on the production host (Trusted Types enforced): the worker starts through the policy and answers, quietly, and stops cleanly', async ({ sandbox, page }) => {
        const host = await RealisticHost.open(sandbox, { mode: 'worker' });
        const baseline = await quietBaseline(host);
        const events = await host.embed('worker');
        expect(events, covering('cspWorker', "worker-src 'self' blob: admits the worker")).toEqual(READY);
        // UNKNOWN_METHOD is the worker's broker answering; TIMEOUT would mean no worker ran
        expect(await host.sandbox.callWithTimeoutOutcome(4000, 'nothing-exposed'), covering('trustedTypesRequirement', 'the frame started its worker through the Trusted Types policy: the worker answers')).toMatchObject({ status: 'rejected', code: 'UNKNOWN_METHOD' });
        await expectQuiet(host, baseline, 'worker mode');
        await page.evaluate(() => (document.querySelector('web-sandbox') as any).terminate());
        expect(await host.state(), covering('thread', 'terminate() ends the worker sandbox')).toBe('terminated');
        expect(await host.frames(), covering('thread', 'and removes its frames')).toBe(0);
    });

    test("on a host that admits execute() (no Trusted Types, 'unsafe-eval'): the worker's requests and the bridge's carry no host cookie or Authorization header, and none passes through the host Service Worker", async ({ sandbox, browserName }) => {
        const sibling = await startSiblingApi();
        try {
            const host = await RealisticHost.open(sandbox, { mode: 'worker', guestCode: 'execute', directives: allowing(ORIGIN, sibling.sameSite, sibling.crossSite) });
            await host.seedCache('priv', CACHED);
            const worker = await ownRequestControl(host, 'control', browserName);
            await host.hostFetch('priv');
            await expectServiceWorkerLog(host, 'priv', worker.controlled ? ['cache'] : []);
            await host.hits(true);

            const events = await host.embed('worker', {
                origins: { connect: [sibling.sameSite, sibling.crossSite] },
                fetchBridge: { allow: [ORIGIN, sibling.sameSite, sibling.crossSite] },
                guest: guestBattery({
                    direct: { same: `${sibling.sameSite}/api/same`, cross: `${sibling.crossSite}/api/cross` },
                    bridge: { bridged: host.api('priv'), bsame: `${sibling.sameSite}/api/bsame` },
                }),
            });
            expect(events).toEqual(READY);
            const guest = await host.guestResult();
            const hits = await host.hits();

            expect(sibling.named('same'), covering('cookies', "the worker's requests to the host page's site are refused: the origin is dropped")).toEqual([]);
            for (const hit of sibling.named('cross')) expect(hit.headers.cookie, covering('cookies', 'another site gets none of the host cookies')).toBeUndefined();
            for (const hit of [...sibling.hits, ...hits.api]) {
                expect(hit.headers.authorization, covering('hostRealmGlobals', `${hit.name}: no Authorization header`)).toBeUndefined();
                expect(hit.headers.referer, covering('referrer', `${hit.name}: no Referer`)).toBeUndefined();
            }
            expect(guest['bridged:bridge'], covering('serviceWorker', "the bridge's request is answered by the network, not the host's cache")).toEqual({ name: 'priv', n: 1 });
            expect(hits.serviceWorker.filter(entry => entry.path.endsWith('/priv')), covering('serviceWorker', 'the host Service Worker did not handle it')).toEqual([]);
            expect(hitsNamed(hits.api, 'priv')[0]!.headers.cookie, covering('cookies', 'the bridge sends no host cookie')).toBeUndefined();
        } finally {
            await sibling.stop();
        }
    });
});

test.describe('cross-origin isolation (COOP same-origin, COEP require-corp): not supported on any engine', () => {
    // docs/API.md#host-page-policy: a host page that is cross-origin isolated (COOP and COEP) is not supported, on any engine and
    // in every mode. The element reads the host page's `crossOriginIsolated` before it creates a frame (host.ts, `_buildRefusal`)
    // and ends the sandbox with `environmentIsolated`; the frames' bootstraps read the same row as defence in depth (what an
    // engine's opaque-origin frames read of the page's isolation does not matter: Chromium's read false, Firefox's and WebKit's
    // true). The outcome is the same on all three engines: no frame, nothing of the guest ran.
    const ISOLATED = TERMINATION_REASONS.environmentIsolated.text;

    for (const mode of ['strict', 'cooperative', 'worker'] as const) {
        test(`${mode} mode on an isolated host: ends with the isolation reason, builds no frame, runs nothing of the guest`, async ({ sandbox, page, browserName }) => {
            const host = await RealisticHost.open(sandbox, { mode, isolation: true, guestCode: mode === 'worker' ? 'execute' : 'none' });
            expect(await page.evaluate(() => self.crossOriginIsolated), 'the host page is cross-origin isolated').toBe(true);
            // (the page's own first build, before the embed below, is refused the same way: only this embed's termination is counted)
            const terminatedBefore = (await host.sandbox.terminations()).length;
            await host.embed(mode, { guest: "return { isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer };" });
            await expect.poll(() => host.page.evaluate(() => (window as any).sandboxEvents.at(-1)), { message: covering('coep', `the sandbox ends with the isolation reason on ${browserName}`) }).toEqual({ type: 'terminated', reason: ISOLATED });
            expect(await host.state(), covering('coep', 'and the sandbox is terminated with that reason, never a silent partial state')).toBe('terminated');
            expect((await host.sandbox.terminations()).slice(terminatedBefore).map(entry => entry.reason), covering('coep', 'exactly once')).toEqual([ISOLATED]);
            expect(await host.frames(), covering('coep', 'no frame was created')).toBe(0);
            await expect(host.guestResult(1500), covering('coep', 'and nothing of the guest ran')).rejects.toThrow();
        });
    }
});

test.describe('teardown', () => {
    for (const mode of ['cooperative', 'strict'] as const) {
        test(`${mode}: removing the element while the host has focus and lifecycle listeners throws nothing at the host, leaves no frame, and the host page answers`, async ({ sandbox, page }) => {
            const host = await RealisticHost.open(sandbox, { mode });
            // positive control: the host's own focus reaches its listeners
            await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<input id="host-input">'); document.getElementById('host-input')!.focus(); });
            expect(await page.evaluate(() => (window as any).hostLifecycle as string[]), covering('eventDispatch', "positive control: the host's own focus reaches its focus listeners")).toContain('focusin');
            const guest = mode === 'cooperative' ? "document.body.insertAdjacentHTML('beforeend', '<input id=\"i\">'); document.getElementById('i').focus(); return { focused: true };" : 'return { focused: false };';
            expect(await host.embed(mode, { guest })).toEqual(READY);
            await host.guestResult();
            await page.evaluate(() => { const element = document.querySelector('web-sandbox') as HTMLElement; (window as any).removedElement = element; element.remove(); });
            await page.waitForTimeout(300);
            expect(await host.reportedErrors(), covering('eventDispatch', "the host's focus, blur and pagehide listeners ran inside the removal without an error reaching the page")).toEqual([]);
            expect(host.pageErrors, covering('eventDispatch', 'nor an uncaught exception')).toEqual([]);
            expect(await page.evaluate(() => (window as any).removedElement.shadowRoot.querySelectorAll('iframe').length), covering('eventDispatch', 'the removed element holds no frame')).toBe(0);
            // a new element on the same page builds afterwards: the removal left no state behind
            const next = await page.evaluate(() => new Promise<string>(resolve => {
                const element = document.createElement('web-sandbox') as any;
                element.addEventListener('ready', () => resolve('ready'), { once: true });
                element.addEventListener('terminated', () => resolve('terminated'), { once: true });
                element.setConfig({ mode: 'cooperative' });
                document.body.appendChild(element);
            }));
            expect(next, covering('eventDispatch', 'and a new element builds on the same page')).toBe('ready');
            expect(await host.hostFetch('after'), covering('thread', 'the host page works after the sandbox was removed')).toMatchObject({ status: 200 });
        });
    }
});
