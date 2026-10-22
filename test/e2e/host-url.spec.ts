import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, HARNESS, ORIGIN } from './fixture';

/**
 * Backlog S15: the guest cannot learn the host page's URL. The harness is opened at a URL with a
 * distinctive query and fragment, so any value that carries the host page's path, query or fragment is
 * detectable. Guarantees, per engine, cooperative and worker mode:
 *   1. nothing the guest's own document or location exposes carries the host page URL: its base URL is
 *      the wrapper's inert about:blank (src/lib/frame-documents.ts), document.referrer is empty, and
 *      relative URLs in guest markup fail closed (no request at all);
 *   2. no request the guest sends carries the host page URL in Referer, even when the guest asks for
 *      `unsafe-url` itself; at most the host origin, and only where the platform sends it;
 *   3. the worker's location is its own blob: URL, and its requests carry no Referer.
 * Where the platform gives the host away and the library cannot stop it, the test asserts the measured
 * per-engine value, so a change in either direction is noticed (platform limits, docs/BACKLOG.md S15):
 *   - location.ancestorOrigins lists the host origin (Chromium, WebKit; Firefox has no such property);
 *   - Firefox and WebKit put the host origin in Referer on image requests when the guest picks a
 *     referrer policy that allows it;
 *   - WebKit: a frame the guest creates sees the host page URL without its fragment as document.referrer.
 *
 * Referer is recorded by a local HTTPS server (upgrade-insecure-requests is always on, and WebKit
 * upgrades even a loopback http: URL), with a certificate made per run. Every request a test expects is
 * awaited at the server, so a request the evidence missed fails the test instead of passing it. The same
 * server answers as https://127.0.0.1:<port> (cross-site to the harness) and as https://localhost:<port>
 * (same host name as the harness, so same-site but for the scheme).
 *
 * Strict mode (ADR-005, research 15 P8), section 4: guest code runs only in the worker, whose location is
 * its own blob: URL, and every request it or its rendered markup makes carries no Referer and no host
 * origin, in all three engines, also to a same-site target and also when the markup asks for unsafe-url:
 * the renderer removes <meta> and forces referrerpolicy="no-referrer" (A1). The control is the host page
 * itself asking for unsafe-url, which shows what each engine would send (WebKit: the full URL same-site).
 */

const SECRET = 'S15-SECRET-7f3a';
const HOST_URL = `${HARNESS}?token=${SECRET}#frag-${SECRET}`;
const HOST_URL_WITHOUT_FRAGMENT = `${HARNESS}?token=${SECRET}`;
const HOST_ORIGIN_REFERER = `${ORIGIN}/`;

// Anything that names the host page beyond its origin: its path, its query or its fragment.
const revealsHostUrl = (value: unknown) => /S15-SECRET|harness|test\/e2e/.test(JSON.stringify(value));

// ---- the recording server --------------------------------------------------------------------

type Hit = { id: string; referer: string | null; origin: string | null };
const servers: https.Server[] = [];
let certDir: string;
let REC = '';
let REC_SAME_SITE = '';
const hits: Hit[] = [];

test.beforeAll(async () => {
    certDir = mkdtempSync(path.join(tmpdir(), 's15-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
    const tls = { key: readFileSync(path.join(certDir, 'key.pem')), cert: readFileSync(path.join(certDir, 'cert.pem')) };
    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
        const id = new URL(req.url ?? '/', 'https://x').searchParams.get('id') ?? '';
        hits.push({ id, referer: req.headers.referer ?? null, origin: (req.headers.origin as string | undefined) ?? null });
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
    };
    // the same port on 127.0.0.1 and ::1, so "localhost" reaches it whichever address the browser tries
    const v4 = https.createServer(tls, handler);
    await new Promise<void>(resolve => v4.listen(0, '127.0.0.1', resolve));
    servers.push(v4);
    const port = (v4.address() as AddressInfo).port;
    const v6 = https.createServer(tls, handler);
    await new Promise<void>(resolve => { v6.once('error', () => resolve()); v6.listen(port, '::1', resolve); });
    if (v6.listening) servers.push(v6);
    REC = `https://127.0.0.1:${port}`;
    REC_SAME_SITE = `https://localhost:${port}`;
});

test.afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    if (certDir) rmSync(certDir, { recursive: true, force: true });
});

let run = 0;
/** Waits until the server has seen every id, and returns each one's Referer (null: none sent). */
async function referers(ids: string[]): Promise<Record<string, string | null>> {
    await expect.poll(() => ids.filter(id => !hits.some(h => h.id === id)), { timeout: 5000 }).toEqual([]);
    return Object.fromEntries(ids.map(id => [id, hits.find(h => h.id === id)!.referer]));
}

test.use({ ignoreHTTPSErrors: true }); // the recorder's certificate is self-signed

test.beforeEach(async ({ sandbox }) => {
    await sandbox.open(`?token=${SECRET}#frag-${SECRET}`);
    expect(await sandbox.page.evaluate(() => location.href)).toBe(HOST_URL);
});

// ---- 1. what the guest can read ----------------------------------------------------------------

const READ_EVERYTHING = `
    const r = {};
    const violations = [];
    addEventListener('securitypolicyviolation', e => violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, documentURI: e.documentURI, referrer: e.referrer, sourceFile: e.sourceFile }));
    r.baseURI = document.baseURI;
    r.URL = document.URL;
    r.documentURI = document.documentURI;
    r.locationHref = location.href;
    r.referrer = document.referrer;
    r.ancestorOrigins = location.ancestorOrigins ? Array.from(location.ancestorOrigins) : null;
    r.navigationEntries = performance.getEntriesByType('navigation').map(e => e.name);
    r.stack = String(new Error('probe').stack);
    const link = document.createElement('a'); link.href = 'relative/page?x=1#y'; r.relativeHref = link.href;
    const fragment = document.createElement('a'); fragment.href = '#here'; r.fragmentHref = fragment.href;
    try { r.resolved = new URL('relative', document.baseURI).href; } catch (e) { r.resolved = 'unresolvable'; }
    // a <base> the guest adds is refused by its base-uri 'none'; the base URL stays the inherited one
    const base = document.createElement('base'); base.href = 'https://evil.example/'; document.head.appendChild(base);
    r.baseURIAfterGuestBase = document.baseURI;
    base.remove();
    r.importMetaUrl = await new Promise(res => {
        globalThis.__reportMetaUrl = res;
        const s = document.createElement('script'); s.type = 'module'; s.textContent = '__reportMetaUrl(import.meta.url)';
        document.head.appendChild(s);
        setTimeout(() => res('timeout'), 3000);
    });
    const image = (src) => new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = src; });
    r.relativeImage = await image('relative.png');
    r.blockedImage = await image('https://attacker.test/img'); // a violation, to read the event's fields
    // a frame the guest creates, with the most revealing referrer policy it can ask for
    r.nested = await new Promise(res => {
        const frame = document.createElement('iframe');
        frame.setAttribute('referrerpolicy', 'unsafe-url');
        frame.srcdoc = '<meta name="referrer" content="unsafe-url"><script>parent.postMessage({ nestedReport: { referrer: document.referrer, baseURI: document.baseURI, ancestorOrigins: location.ancestorOrigins ? Array.from(location.ancestorOrigins) : null } }, "*")<\\/script>';
        addEventListener('message', e => { if (e.source === frame.contentWindow && e.data && e.data.nestedReport) res(e.data.nestedReport); });
        document.body.appendChild(frame);
        setTimeout(() => res('timeout'), 3000);
    });
    await new Promise(res => setTimeout(res, 300)); // violation events are queued as tasks
    r.violations = violations;
    return r;
`;

test('cooperative mode: nothing the guest document or location exposes carries the host page URL', async ({ sandbox, browserName }) => {
    expect(await sandbox.mount()).toBe('ready');
    const r = await sandbox.inGuest(READ_EVERYTHING);

    expect(r).toMatchObject({
        baseURI: 'about:blank',
        URL: 'about:srcdoc',
        documentURI: 'about:srcdoc',
        locationHref: 'about:srcdoc',
        referrer: '',
        // relative URLs cannot be resolved against about:blank: they fail closed
        relativeHref: 'relative/page?x=1#y',
        fragmentHref: 'about:blank#here',
        resolved: 'unresolvable',
        baseURIAfterGuestBase: 'about:blank',
        importMetaUrl: 'about:blank',
        relativeImage: 'error',
        blockedImage: 'error',
    });
    // the relative image sent nothing, not even a request for CSP to refuse; only the guest <base> and
    // the attacker image were refused, and no violation report names the host page
    expect([...new Set(r.violations.map((v: any) => v.directive))].sort()).toEqual(['base-uri', 'img-src']);
    expect(r.violations.every((v: any) => v.referrer === '')).toBe(true);

    // Platform limits, asserted as measured. ancestorOrigins cannot be set by a page, and a no-referrer
    // policy on the frames does not mask it in Chromium 141 or WebKit 26: the host ORIGIN shows.
    const hasAncestorOrigins = browserName !== 'firefox';
    expect(r.ancestorOrigins).toEqual(hasAncestorOrigins ? ['null', ORIGIN] : null);
    expect(r.nested.baseURI).toBe('about:blank');
    expect(r.nested.ancestorOrigins).toEqual(hasAncestorOrigins ? ['null', 'null', ORIGIN] : null);
    // WebKit takes the referrer of a frame's navigation from the first non-srcdoc document up the tree
    // (FrameLoader::outgoingReferrer), which is the host page, with no check for the opaque origin in
    // between: a frame the guest creates with referrerpolicy="unsafe-url" sees the host page URL minus
    // its fragment. No document or attribute the library controls changes that.
    expect(r.nested.referrer).toBe(browserName === 'webkit' ? HOST_URL_WITHOUT_FRAGMENT : '');

    // everything else: no path, query or fragment of the host page anywhere
    const { nested, ...own } = r;
    expect(revealsHostUrl(own)).toBe(false);
    expect(revealsHostUrl({ ...nested, referrer: undefined })).toBe(false);
    expect(JSON.stringify(r)).not.toContain(`frag-${SECRET}`); // the full URL, fragment included, never
});

// ---- 2. what the guest's requests carry ----------------------------------------------------------

// Requests to the recorder: image and fetch, each with the default policy and with unsafe-url asked for
// per request, plus an image from a frame the guest creates (which, in WebKit, holds the host URL as its referrer).
const requestsBody = (prefix: string) => `
    const id = (kind) => '${REC}/r?id=${prefix}-' + kind;
    const image = (kind, policy) => new Promise(res => { const i = new Image(); if (policy) i.referrerPolicy = policy; i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = id(kind); });
    const r = {};
    r.image = await image('image');
    r.imageUnsafe = await image('imageUnsafe', 'unsafe-url');
    r.fetch = await fetch(id('fetch'), { mode: 'no-cors' }).then(() => 'loaded', () => 'error');
    r.fetchUnsafe = await fetch(id('fetchUnsafe'), { mode: 'no-cors', referrerPolicy: 'unsafe-url' }).then(() => 'loaded', () => 'error');
    r.nestedImage = await new Promise(res => {
        const frame = document.createElement('iframe');
        frame.setAttribute('referrerpolicy', 'unsafe-url');
        frame.srcdoc = '<meta name="referrer" content="unsafe-url"><img referrerpolicy="unsafe-url" src="' + id('nestedImage') + '" onload="parent.postMessage({ nestedImage: \\'loaded\\' }, \\'*\\')" onerror="parent.postMessage({ nestedImage: \\'error\\' }, \\'*\\')">';
        addEventListener('message', e => { if (e.source === frame.contentWindow && e.data && e.data.nestedImage) res(e.data.nestedImage); });
        document.body.appendChild(frame);
        setTimeout(() => res('timeout'), 3000);
    });
    return r;
`;
const KINDS = ['image', 'imageUnsafe', 'fetch', 'fetchUnsafe', 'nestedImage'];

for (const guestMeta of [false, true]) {
    const label = guestMeta ? 'with the guest\'s own <meta name="referrer" content="unsafe-url">' : 'with the inherited policy';
    test(`cooperative mode, ${label}: no request carries the host page URL in Referer; at most the host origin, where the engine sends it`, async ({ sandbox, browserName }) => {
        const prefix = `t${++run}${guestMeta ? 'meta' : 'plain'}`;
        expect(await sandbox.mount({
            origins: { images: [REC], connect: [REC] },
            ...(guestMeta ? { html: '<head><meta name="referrer" content="unsafe-url"></head><body></body>' } : {}),
        })).toBe('ready');
        const outcomes = await sandbox.inGuest(requestsBody(prefix));
        expect(outcomes).toEqual(Object.fromEntries(KINDS.map(kind => [kind, 'loaded'])));

        const seen = await referers(KINDS.map(kind => `${prefix}-${kind}`));
        const byKind = Object.fromEntries(KINDS.map(kind => [kind, seen[`${prefix}-${kind}`]]));

        // fetch never carries one; Chromium sends none at all (an opaque origin has no referrer, as the
        // Fetch spec says). Firefox and WebKit send the host ORIGIN on image requests whenever the policy
        // in force allows a referrer: never by default (the wrapper's no-referrer is inherited), but the
        // guest can ask for one, per request or with its own <meta>, and no document can stop that.
        const originOnImages = browserName !== 'chromium';
        expect(byKind).toEqual({
            image: originOnImages && guestMeta ? HOST_ORIGIN_REFERER : null,
            imageUnsafe: originOnImages ? HOST_ORIGIN_REFERER : null,
            fetch: null,
            fetchUnsafe: null,
            nestedImage: originOnImages ? HOST_ORIGIN_REFERER : null,
        });
        expect(revealsHostUrl(byKind)).toBe(false);
    });
}

test('cooperative mode, residual S18: a guest asking for unsafe-url sends a same-site target the host ORIGIN in Firefox and the FULL host URL in WebKit (measured; strict mode closes it, section 4)', async ({ sandbox, browserName }) => {
    const prefix = `t${++run}samesite`;
    expect(await sandbox.mount({ origins: { images: [REC_SAME_SITE] } })).toBe('ready');
    const outcome = await sandbox.inGuest(`
        const image = (kind, policy) => new Promise(res => { const i = new Image(); if (policy) i.referrerPolicy = policy; i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = '${REC_SAME_SITE}/r?id=${prefix}-' + kind; });
        return { image: await image('image'), imageUnsafe: await image('imageUnsafe', 'unsafe-url') };
    `);
    expect(outcome).toEqual({ image: 'loaded', imageUnsafe: 'loaded' });
    const seen = await referers([`${prefix}-image`, `${prefix}-imageUnsafe`]);
    // by default nothing (the inherited no-referrer); asked for, the engine decides (research 15, P8)
    expect(seen[`${prefix}-image`]).toBeNull();
    expect(seen[`${prefix}-imageUnsafe`]).toBe({ chromium: null, firefox: HOST_ORIGIN_REFERER, webkit: HOST_URL_WITHOUT_FRAGMENT }[browserName]);
});

// ---- 3. worker mode ---------------------------------------------------------------------------------

test('worker mode: the worker sees only its own blob: URL, and its requests carry no Referer even with unsafe-url', async ({ sandbox }) => {
    const prefix = `t${++run}worker`;
    expect(await sandbox.mount({ mode: 'worker', origins: { connect: [REC] } })).toBe('ready');
    const r = await sandbox.inGuest(`
        const id = (kind) => '${REC}/r?id=${prefix}-' + kind;
        return {
            href: self.location.href,
            origin: self.origin,
            stack: String(new Error('probe').stack),
            hasDocument: typeof document !== 'undefined',
            fetch: await fetch(id('fetch'), { mode: 'no-cors' }).then(() => 'loaded', () => 'error'),
            fetchUnsafe: await fetch(id('fetchUnsafe'), { mode: 'no-cors', referrerPolicy: 'unsafe-url' }).then(() => 'loaded', () => 'error'),
        };
    `);

    expect(r).toMatchObject({ origin: 'null', hasDocument: false, fetch: 'loaded', fetchUnsafe: 'loaded' });
    expect(r.href).toMatch(/^blob:null\/[0-9a-f-]+$/);
    expect(revealsHostUrl(r)).toBe(false);
    expect(await referers([`${prefix}-fetch`, `${prefix}-fetchUnsafe`])).toEqual({ [`${prefix}-fetch`]: null, [`${prefix}-fetchUnsafe`]: null });
});

// ---- 4. strict mode ----------------------------------------------------------------------------------------

test('strict mode: the worker sees only its own blob: URL; no request from the worker or from rendered markup carries a Referer or the host origin, even when the markup asks for unsafe-url, and a same-site listener is dropped from the policy (control: the host page)', async ({ sandbox, browserName }) => {
    const prefix = `t${++run}strict`;
    const targets = { cross: REC, same: REC_SAME_SITE };
    // the same-site listener is listed too: strict mode drops it from the policy (S74), so nothing of the worker's or the
    // view's reaches it, with or without a referrer (the host page's own control below does)
    expect(await sandbox.mount({ mode: 'strict', origins: { images: [REC, REC_SAME_SITE], connect: [REC, REC_SAME_SITE] } })).toBe('ready');

    const worker = await sandbox.inGuest(`
        const r = { href: self.location.href, origin: self.origin, stack: String(new Error('probe').stack), names: ['document', 'parent', 'top', 'opener', 'frames'].filter(n => n in globalThis) };
        for (const [site, origin] of Object.entries(${JSON.stringify(targets)})) {
            r['fetch-' + site] = await fetch(origin + '/r?id=${prefix}-fetch-' + site, { referrerPolicy: 'unsafe-url' }).then(() => 'loaded', () => 'error');
        }
        return r;
    `);
    expect(worker).toMatchObject({ origin: 'null', names: [], 'fetch-cross': 'loaded', 'fetch-same': 'error' });
    expect(worker.href).toMatch(/^blob:null\/[0-9a-f-]+$/);
    expect(revealsHostUrl(worker)).toBe(false);

    // rendered markup asking for a referrer every way it can: attribute, <meta> before the image, a nested
    // frame with its own <meta>, CSS, and a link with ping (the renderer removes or neutralises each)
    const kinds = ['default', 'attr', 'meta', 'css', 'frame'];
    const markup = (site: string, origin: string) => [
        `<img src="${origin}/r?id=${prefix}-default-${site}">`,
        `<img referrerpolicy="unsafe-url" src="${origin}/r?id=${prefix}-attr-${site}">`,
        `<meta name="referrer" content="unsafe-url"><img src="${origin}/r?id=${prefix}-meta-${site}">`,
        `<div style="width:1px;height:1px;background-image:url('${origin}/r?id=${prefix}-css-${site}')"></div>`,
        `<iframe srcdoc="&lt;meta name=referrer content=unsafe-url&gt;&lt;img referrerpolicy=unsafe-url src='${origin}/r?id=${prefix}-frame-${site}'&gt;"></iframe>`,
        `<a ping="${origin}/r?id=${prefix}-ping-${site}" href="${origin}/r?id=${prefix}-link-${site}">x</a>`,
    ].join('');
    await sandbox.run(`sandboxView.render(${JSON.stringify(Object.entries(targets).map(([site, origin]) => markup(site, origin)).join(''))})`);
    const expected = ['cross'].flatMap(site => [...kinds.filter(k => k !== 'frame').map(k => `${prefix}-${k}-${site}`), `${prefix}-fetch-${site}`]);
    const seen = await referers(expected);
    await sandbox.page.waitForTimeout(500);
    // the frame and the ping never exist (A1), so they never request anything
    expect(hits.filter(h => /-(frame|ping|link)-/.test(h.id) && h.id.startsWith(prefix))).toEqual([]);
    expect(hits.filter(h => h.id.startsWith(prefix) && h.id.endsWith('-same')), 'nothing reached the same-site listener').toEqual([]);
    expect(Object.values(seen)).toEqual(expected.map(() => null));
    // no Origin header naming the host either: none on the images; 'null' (the opaque origin) on the worker's fetch
    for (const id of expected) {
        const origins = hits.filter(h => h.id === id).map(h => h.origin);
        expect(origins.every(o => o === null || o === 'null'), `${id}: ${origins}`).toBe(true);
    }

    // control: the host page asking for unsafe-url — what each engine sends at most (research 15, P8)
    const control: Record<string, string> = {};
    for (const [site, origin] of Object.entries(targets)) {
        const id = `${prefix}-host-control-${site}`;
        await sandbox.page.evaluate(([src]) => new Promise(res => { const i = new Image(); i.referrerPolicy = 'unsafe-url'; i.onload = i.onerror = res; i.src = src!; }), [`${origin}/r?id=${id}`]);
        control[site] = (await referers([id]))[id]!;
    }
    expect(control).toEqual({ cross: browserName === 'chromium' ? HOST_URL_WITHOUT_FRAGMENT : HOST_ORIGIN_REFERER, same: HOST_URL_WITHOUT_FRAGMENT });
});
