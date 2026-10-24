import type { BrowserContext, Page, Request as PlaywrightRequest } from '@playwright/test';
import { test, expect, ORIGIN, type SandboxDriver } from './fixture';

/**
 * The host page's site in each engine (S74, class A; src/lib/host-site.ts): every mode drops an `origins` entry on the
 * host page's site, decided from `self.origin` of the element's realm by a rule that reads nothing of the page's cookie
 * jar or of its document's URL. So a host page that changes either decides the same:
 *   cookie-gate  a page whose `document.cookie` setter keeps back every name it does not know (a consent manager's gate)
 *   srcdoc       the element in a same-origin `srcdoc` frame of the page (`location.origin` is 'null' there)
 *   blank-dom    the element in an `about:blank` frame the page built with DOM calls (the same)
 * In each, a sibling of the page (`api.`) and the page's own origin are dropped from `images` and `connect` with the
 * warning, and nothing reaches them: not the view's images, not the worker's `fetch()` or `WebSocket`. Another site's
 * origin, kept, is the positive control: its image arrives through the same route.
 *
 * The host names are served by routing (no DNS): the page and the library's modules (proxied from the e2e server) at
 * APP, and recorders at API and OTHER.
 */

const APP = 'https://app.ws-site.test';
const API = 'https://api.ws-site.test';
const OTHER = 'https://cdn.ws-other.test';

test.use({ ignoreHTTPSErrors: true });

test.describe("an origin on the host page's site is dropped in every mode, with one warning", () => {
    // the harness page and its own origin: the same site, in every engine. A same-site request would carry the host site's
    // cookies in some engines (cookie-facts.ts), so no mode admits one: the policy lists nothing and the request is refused.
    const request = `try { await fetch(${JSON.stringify(`${ORIGIN}/test/e2e/pixel.png`)}); } catch (e) {} return 'sent';`;
    const connectViolations = async (sandbox: SandboxDriver) => {
        await sandbox.page.waitForTimeout(500);
        return (await sandbox.violations()).filter(v => v.directive === 'connect-src' && v.blockedURI.includes('/test/e2e/pixel.png'));
    };

    for (const mode of ['strict', 'cooperative', 'worker'] as const) {
        test(`${mode}: the origin is dropped with one warning and the guest request is refused and reported`, async ({ sandbox, page }) => {
            const warnings: string[] = [];
            page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
            expect(await sandbox.mount({ mode, origins: { connect: [ORIGIN] } })).toBe('ready');
            expect(await sandbox.inGuest(request)).toBe('sent');
            // the request gate refuses and reports it, in every mode and on every engine
            expect((await connectViolations(sandbox)).length).toBeGreaterThan(0);
            expect(warnings.filter(text => text.includes(`origins.connect dropped ${ORIGIN} (the host page's own origin`))).toHaveLength(1);
            expect(warnings.filter(text => text.includes(`origins.connect lists ${ORIGIN}`))).toEqual([]);
        });
    }
});

// The element's realm in each variant: a module script that defines the element there and hands the page a mount().
const MOUNTER = (library: string) => `
import { defineWebSandbox } from ${JSON.stringify(library)};
defineWebSandbox();
const realm = { selfOrigin: self.origin, locationOrigin: location.origin, href: location.href };
top.__mount = (config, code) => new Promise((resolve) => {
    const el = document.createElement('web-sandbox');
    el.style.cssText = 'display:block;width:300px;height:120px';
    el.registerFiles({ 'main.js': 'void 0' });
    el.addEventListener('ready', () => { el.execute(code); resolve({ state: 'ready', realm }); }, { once: true });
    el.addEventListener('terminated', (e) => resolve({ state: 'terminated ' + e.detail.reason, realm }), { once: true });
    el.setConfig(config);
    document.body.append(el);
});
top.__ready = true;
`;

const COOKIE_GATE = `<script>
(() => {
    // a consent manager's gate: writes of cookie names it does not know are kept back, reads pass through
    const native = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    window.__keptBack = [];
    Object.defineProperty(Document.prototype, 'cookie', {
        configurable: true, enumerable: true,
        get() { return native.get.call(this); },
        set(value) { if (/^\\s*session=/.test(String(value))) native.set.call(this, value); else window.__keptBack.push(String(value)); },
    });
})();
</script>`;

function hostPage(variant: 'cookie-gate' | 'srcdoc' | 'blank-dom'): string {
    const library = `${APP}/src/host.ts`;
    const module = (text: string) => `<script type="module">${text}</script>`;
    if (variant === 'cookie-gate') return `<!doctype html><meta charset="utf-8"><title>host</title>${COOKIE_GATE}<body>${module(MOUNTER(library))}</body>`;
    if (variant === 'srcdoc') {
        const inner = `<!doctype html><meta charset="utf-8"><body>${module(MOUNTER(library))}</body>`;
        return `<!doctype html><meta charset="utf-8"><title>host</title><body><iframe id="pane" style="width:400px;height:200px"></iframe>
<script>document.getElementById('pane').srcdoc = ${JSON.stringify(inner).replaceAll('</', '<\\/')};</script></body>`;
    }
    return `<!doctype html><meta charset="utf-8"><title>host</title><body><script>
const frame = document.createElement('iframe');
frame.style.cssText = 'width:400px;height:200px';
document.body.append(frame);
// Firefox replaces the frame's initial about:blank with a second one at its load: write into the document that stays
let written = null;
const write = () => {
    const doc = frame.contentDocument;
    if (!doc || !doc.body || doc === written) return;
    written = doc;
    const script = doc.createElement('script');
    script.type = 'module';
    script.textContent = ${JSON.stringify(MOUNTER(library)).replaceAll('</', '<\\/')};
    doc.body.append(script);
};
frame.addEventListener('load', () => setTimeout(write, 0));
setTimeout(write, 200);
</script></body>`;
}

type Hit = { host: string; path: string };

async function serve(context: BrowserContext, variant: 'cookie-gate' | 'srcdoc' | 'blank-dom', hits: Hit[]) {
    const record = (request: PlaywrightRequest) => {
        const url = new URL(request.url());
        hits.push({ host: url.host, path: url.pathname + url.search });
    };
    const pixel = { status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="5"></svg>' };
    await context.route(`${APP}/**`, async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/host.html') return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'set-cookie': 'session=1; Path=/; Secure; SameSite=None' }, body: hostPage(variant) });
        if (url.pathname.startsWith('/probe')) { record(route.request()); return route.fulfill(pixel); }
        // the library's modules, from the e2e server, as the page's own
        const response = await route.fetch({ url: `${ORIGIN}${url.pathname}${url.search}`, headers: {} });
        return route.fulfill({ response });
    });
    for (const origin of [API, OTHER]) {
        await context.route(`${origin}/**`, route => { record(route.request()); return route.fulfill(pixel); });
        await context.routeWebSocket(`${origin.replace('https://', 'wss://')}/**`, ws => { hits.push({ host: new URL(ws.url()).host, path: 'websocket' }); ws.close(); });
    }
}

async function mountIn(page: Page, variant: 'cookie-gate' | 'srcdoc' | 'blank-dom') {
    await page.goto(`${APP}/host.html`);
    await page.waitForFunction(() => (window as any).__ready === true);
    const config = {
        mode: 'strict', entry: 'main.js', scriptUnsafe: true, hostContentSecurityPolicy: false,
        origins: { images: [API, APP, OTHER], connect: [API, API.replace('https://', 'wss://'), APP] },
        html: `<img src="${API}/probe?view-img"><img src="${APP}/probe?view-own"><img src="${OTHER}/probe?view-other">`,
    };
    const code = `
        fetch(${JSON.stringify(`${API}/probe?worker-fetch`)}).catch(() => {});
        fetch(${JSON.stringify(`${APP}/probe?worker-own`)}).catch(() => {});
        try { new WebSocket(${JSON.stringify(`${API.replace('https://', 'wss://')}/probe?worker-ws`)}); } catch (e) {}`;
    return page.evaluate(([config, code]) => (window as any).__mount(config, code), [config, code] as const);
}

for (const variant of ['cookie-gate', 'srcdoc', 'blank-dom'] as const) {
    test(`${variant}: a sibling and the page's own origin are dropped, with the warning, and nothing reaches them`, async ({ page, context }) => {
        const hits: Hit[] = [];
        const warnings: string[] = [];
        page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
        await serve(context, variant, hits);
        const { state, realm } = await mountIn(page, variant);
        expect(state).toBe('ready');
        expect(realm.selfOrigin).toBe(APP);
        if (variant !== 'cookie-gate') expect(realm.locationOrigin, "the document's URL says nothing of the page's origin there").toBe('null');

        // the positive control: another site's image arrives through the same routing
        await expect.poll(() => hits.filter(hit => hit.host === new URL(OTHER).host).length, { timeout: 10_000 }).toBeGreaterThan(0);
        await page.waitForTimeout(1000);
        for (const kind of ['images', 'connect']) {
            const dropped = warnings.filter(text => text.startsWith(`[Sandbox] origins.${kind} dropped `));
            expect(dropped, kind).toHaveLength(1);
            expect(dropped[0], kind).toContain(`${API} (on the host page's site)`);
            expect(dropped[0], kind).toContain(`${APP} (the host page's own origin)`);
        }
        expect(hits.filter(hit => hit.host !== new URL(OTHER).host), 'nothing reaches the host page\'s site').toEqual([]);
        if (variant === 'cookie-gate') expect(await page.evaluate(() => (window as any).__keptBack), 'the library wrote no cookie').toEqual([]);
    });
}
