import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { test, expect, ORIGIN } from './fixture';
import { startNameProxy } from './name-proxy';
import { COOKIE_ENGINE_FACTS, type CookieEngine } from '@src/lib/cookie-facts';

/**
 * The host page's site in each layout of the host page (S74, class A; BD4:ISO-1, BD4:ISO-3; src/lib/host-site.ts). An
 * engine decides whether a request of the sandbox's frames is same-site from the frames above them (WebKit: from the
 * top-level document's URL, cookie-facts.ts), so the site rule's input is every origin whose site can count: the page's
 * own, its top-level URL's, every ancestor's. Where one of them is opaque, or cannot be read (a page of another origin
 * above the host page, on an engine without `location.ancestorOrigins`), the site is undecided, and every entry a
 * cookie carrier of the mode reaches is dropped (COOKIE_CARRIERS).
 *
 * The layouts, with H = app.wsprobe.test (the host page), S = cdn.wsprobe.test (H's sibling), X = cross.wsprobe2.test
 * (another site, the top page in one layout) and E = evil.wsprobe3.test (a site that is no page's):
 *   top-level         H, a plain page: the control, decided on every engine
 *   csp-top           H served with `Content-Security-Policy: sandbox allow-scripts`: an opaque origin, top-level
 *   nested-sandboxed  H in an `<iframe sandbox="allow-scripts">` of a top-level H
 *   nested-other-url  X's URL in an `<iframe sandbox="allow-scripts">` of a top-level H
 *   embedded          H, a plain page, in an iframe of a top-level X
 * In each, in worker and cooperative mode, the guest lists H, S, X and E (`https://` with its `wss://` twin; in
 * cooperative mode also as `images`) and makes a request to each: a WebSocket and a `fetch()` (without credentials), and in
 * cooperative mode an image. A listener for all four names records the `Cookie` header of each request.
 *
 * What holds, on every engine: no request of the guest carries a `Lax` or `Strict` cookie of the host page's site or of
 * the top page's; every listed entry is kept or dropped as the layout says, and every one dropped is named in a warning
 * with its reason; every kept entry's request arrives (the positive control of silence). The controls of each test: a
 * top-level navigation to each name carries every cookie of the jar (the jar holds Lax, Strict and host-only cookies), and
 * a plain sandboxed frame of the host page, without the library, opens a WebSocket to the top page's site, whose
 * handshake on WebKit carries that site's Lax and Strict cookies: what the guest's would carry if the entry were kept.
 */

test.use({ ignoreHTTPSErrors: true });

const NAMES = { H: 'app.wsprobe.test', S: 'cdn.wsprobe.test', X: 'cross.wsprobe2.test', E: 'evil.wsprobe3.test' } as const;
type Name = keyof typeof NAMES;
const TARGETS: Name[] = ['H', 'S', 'X', 'E'];
const LAYOUTS = ['top-level', 'csp-top', 'nested-sandboxed', 'nested-other-url', 'embedded'] as const;
type Layout = (typeof LAYOUTS)[number];

/**
 * What a layout keeps, from the site rule's input there: the names on a readable origin's site (dropped in every mode),
 * and whether the site is decided (else the mode's cookie carriers' entries are dropped too: every `wss://` entry in
 * worker mode, every entry in cooperative mode). `hasAncestorOrigins` is the engine's fact.
 */
function siteOf(layout: Layout, ancestorOrigins: boolean): { onSite: Name[]; decided: boolean } {
    switch (layout) {
        case 'top-level': return { onSite: ['H', 'S'], decided: true };
        case 'csp-top': return { onSite: ['H', 'S'], decided: false }; // the URL's site; its origin is opaque
        case 'nested-sandboxed':
        case 'nested-other-url': return { onSite: ancestorOrigins ? ['H', 'S'] : [], decided: false }; // the ancestor H, where it can be read
        case 'embedded': return ancestorOrigins ? { onSite: ['H', 'S', 'X'], decided: true } : { onSite: ['H', 'S'], decided: false };
    }
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAIAAAAPE8H1AAAAEElEQVR4nGP4z8AAQQxEsgCEuw7yxezkBQAAAABJRU5ErkJggg==', 'base64');
type Hit = { host: string; k: string; cookies: string[]; kind: 'http' | 'ws' };

/**
 * One HTTPS listener for the four names. A request with `?k=<tag>` is recorded with its cookies (an image for `.png`, a
 * plain page for `/plain`, else `ok`, with `Access-Control-Allow-Origin: *`); a WebSocket handshake is recorded, then
 * closed. Anything else is the e2e server's (the harness and its modules), with `Access-Control-Allow-Origin: *` (an
 * opaque page fetches its modules with CORS); the harness asked with `?csp` comes with `sandbox allow-scripts`.
 */
async function startListener() {
    const dir = mkdtempSync(path.join(tmpdir(), 'host-site-layouts-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=wsprobe',
        '-addext', `subjectAltName=${Object.values(NAMES).map(name => `DNS:${name}`).join(',')}`, '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    const hits: Hit[] = [];
    const record = (req: { url?: string; headers: Record<string, string | string[] | undefined> }, kind: Hit['kind']) => {
        const url = new URL(req.url ?? '/', 'https://listener');
        const cookie = String(req.headers.cookie ?? '');
        hits.push({ host: String(req.headers.host ?? '').replace(/:\d+$/, ''), k: url.searchParams.get('k') ?? '', cookies: cookie ? cookie.split(/;\s*/).map(part => part.split('=')[0]!).sort() : [], kind });
    };
    const server = https.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
        const url = new URL(req.url ?? '/', 'https://listener');
        if (url.searchParams.has('k')) {
            record(req, 'http');
            if (url.pathname.endsWith('.png')) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(PNG); return; }
            res.writeHead(200, { 'content-type': url.pathname === '/plain' ? 'text/html' : 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
            res.end(url.pathname === '/plain' ? '<!doctype html><title>plain</title><body>plain</body>' : 'ok');
            return;
        }
        const sandboxed = url.pathname.endsWith('/harness.html') && url.searchParams.has('csp') ? { 'content-security-policy': 'sandbox allow-scripts' } : {};
        fetch(ORIGIN + (req.url ?? '/')).then(async (response) => {
            res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...sandboxed });
            res.end(Buffer.from(await response.arrayBuffer()));
        }, () => { res.writeHead(502); res.end(); });
    });
    server.on('upgrade', (req, socket) => { record(req, 'ws'); socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server.address() as AddressInfo).port,
        hits,
        stop: async () => {
            await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
type Listener = Awaited<ReturnType<typeof startListener>>;

/** The jar: domain cookies of H's site (d_) and X's (xd_), host-only ones of H, S and X (h_, s_, x_), each None, Lax, Strict. */
const jar = () => (['None', 'Lax', 'Strict'] as const).flatMap(sameSite => {
    const s = sameSite.toLowerCase();
    const cookie = (name: string, domain: string) => ({ name, value: '1', domain, path: '/', secure: true, sameSite });
    return [cookie(`d_${s}`, '.wsprobe.test'), cookie(`xd_${s}`, '.wsprobe2.test'), cookie(`h_${s}`, NAMES.H), cookie(`s_${s}`, NAMES.S), cookie(`x_${s}`, NAMES.X)];
});
/** A Lax or Strict cookie of H's site (d_, h_, s_) or of X's (xd_, x_): what a guest request must never carry. */
const FIRST_PARTY = /^(d|h|s|xd|x)_(lax|strict)$/;

let listener: Listener;
const at = (name: Name, scheme = 'https') => `${scheme}://${NAMES[name]}:${listener.port}`;
const seen = (k: string) => listener.hits.filter(hit => hit.k === k);

/** Opens the layout and returns the frame of the host page, whose realm the element runs in. */
async function open(page: Page, layout: Layout): Promise<Frame> {
    if (layout === 'top-level' || layout === 'csp-top') {
        await page.goto(`${at('H')}/test/e2e/harness.html${layout === 'csp-top' ? '?csp' : ''}`);
        return page.mainFrame();
    }
    const top = layout === 'embedded' ? `${at('X')}/plain?k=top` : `${at('H')}/test/e2e/harness.html`;
    await page.goto(top);
    const inner = `${at(layout === 'nested-other-url' ? 'X' : 'H')}/test/e2e/harness.html?inner`;
    await page.evaluate(({ src, sandboxed }) => {
        const frame = document.createElement('iframe');
        if (sandboxed) frame.setAttribute('sandbox', 'allow-scripts');
        frame.style.cssText = 'width:600px;height:400px';
        frame.src = src;
        document.body.appendChild(frame);
    }, { src: inner, sandboxed: layout !== 'embedded' });
    await expect.poll(() => page.frames().some(frame => frame.url().includes('?inner'))).toBe(true);
    return page.frames().find(frame => frame.url().includes('?inner'))!;
}

/** The guest's requests: to each target a WebSocket and a fetch(), in cooperative mode an image; what each WebSocket did. */
const guestCode = (tag: string, cooperative: boolean, urls: Record<Name, string>) => `(async () => {
    const out = {};
    for (const [name, origin] of Object.entries(${JSON.stringify(urls)})) {
        try { new WebSocket(origin.replace('https:', 'wss:') + '/ws?k=${tag}.ws.' + name); out[name] = 'made'; } catch (e) { out[name] = e.name; }
        fetch(origin + '/f?k=${tag}.fetch.' + name).catch(() => {});
        ${cooperative ? "const image = new Image(); image.src = origin + '/a.png?k=" + tag + ".img.' + name; document.body.append(image);" : ''}
    }
    console.log('LAYOUT_RESULT ' + JSON.stringify(out));
})()`;

test.describe("the host page's site in each layout: no guest request carries the host or top site's Lax or Strict cookies", () => {
    test.use({
        proxy: async ({}, use) => {
            const proxy = await startNameProxy();
            await use({ server: proxy.server, bypass: 'localhost,127.0.0.1' }); // the e2e server stays direct
            await proxy.stop();
        },
    });
    test.beforeAll(async () => { listener = await startListener(); });
    test.afterAll(async () => { await listener?.stop(); });

    for (const layout of LAYOUTS) {
        for (const mode of ['worker', 'cooperative'] as const) {
            test(`${layout}, ${mode} mode`, async ({ page, context, browserName }) => {
                test.setTimeout(90_000);
                // ledger: cookies
                const engine = browserName as CookieEngine;
                const facts = COOKIE_ENGINE_FACTS[engine];
                const tag = `${layout}-${mode}-${engine}`;
                await context.addCookies(jar());

                // control: the jar holds every cookie, Lax, Strict and host-only included
                for (const name of ['H', 'S', 'X'] as const) {
                    await page.goto(`${at(name)}/plain?k=${tag}.jar.${name}`);
                    expect(seen(`${tag}.jar.${name}`)[0]?.cookies.filter(cookie => /_(lax|strict)$/.test(cookie)).length, `jar ${name}`).toBeGreaterThanOrEqual(4);
                }

                const warnings: string[] = [];
                page.on('console', message => { if (message.type() === 'warning' && message.text().includes('[Sandbox] origins.')) warnings.push(message.text()); });
                const frame = await open(page, layout);
                await frame.waitForFunction(() => (window as any).harnessReady === true);
                const realm = await frame.evaluate(() => ({ selfOrigin: self.origin, framed: window !== window.top, ancestorOrigins: 'ancestorOrigins' in location }));
                expect(realm.ancestorOrigins, "the engine's fact: location.ancestorOrigins").toBe(facts.hasAncestorOrigins);
                expect(realm.selfOrigin === 'null', 'the layout gives the page an opaque origin').toBe(['csp-top', 'nested-sandboxed', 'nested-other-url'].includes(layout));
                expect(realm.framed).toBe(!['top-level', 'csp-top'].includes(layout));

                // control: a plain sandboxed frame of the host page opens a WebSocket to the top page's site
                const topSite: Name = layout === 'embedded' ? 'X' : 'S';
                await frame.evaluate((url) => {
                    const control = document.createElement('iframe');
                    control.setAttribute('sandbox', 'allow-scripts');
                    control.srcdoc = `<script>new WebSocket(${JSON.stringify(url)})<\/script>`;
                    document.body.appendChild(control);
                }, `${at(topSite, 'wss')}/ws?k=${tag}.control`);
                await expect.poll(() => seen(`${tag}.control`).length, 'the control handshake').toBeGreaterThan(0);
                const control = seen(`${tag}.control`)[0]!.cookies;
                if (engine === 'webkit') expect(control.filter(cookie => FIRST_PARTY.test(cookie)), `the top site's Lax and Strict cookies on a frame's handshake: ${control}`).not.toEqual([]);

                // the guest
                const urls = Object.fromEntries(TARGETS.map(name => [name, at(name)])) as Record<Name, string>;
                const listed = TARGETS.flatMap(name => [at(name), at(name, 'wss')]);
                const config = { mode, scriptUnsafe: true, hostContentSecurityPolicy: false, ...(mode === 'cooperative' ? { capabilities: ['allow-scripts'] } : {}), origins: { connect: listed, ...(mode === 'cooperative' ? { images: TARGETS.map(name => at(name)) } : {}) } };
                const state = await frame.evaluate((config) => new Promise<string>(resolve => {
                    const element = document.querySelector('web-sandbox') as any;
                    element.addEventListener('ready', () => resolve('ready'), { once: true });
                    element.addEventListener('terminated', (event: any) => resolve(`terminated ${event.detail?.reason}`), { once: true });
                    element.setConfig(config);
                }), config);
                expect(state).toBe('ready');
                const kept = await frame.evaluate(() => (document.querySelector('web-sandbox') as any)._origins);
                await frame.evaluate((code) => (document.querySelector('web-sandbox') as any).execute(code), guestCode(tag, mode === 'cooperative', urls));
                await expect.poll(() => frame.evaluate(() => (window as any).sandboxLogs.find((line: string) => line.startsWith('LAYOUT_RESULT ')) ?? null), 'the guest ran').not.toBeNull();
                const made = JSON.parse((await frame.evaluate(() => (window as any).sandboxLogs.find((line: string) => line.startsWith('LAYOUT_RESULT ')))).slice('LAYOUT_RESULT '.length));

                // what the rule keeps, from the layout and the engine's fact
                const { onSite, decided } = siteOf(layout, facts.hasAncestorOrigins);
                const keeps = (name: Name, scheme: string, kind: string) => !onSite.includes(name) && (decided || (mode === 'worker' && kind === 'connect' && scheme === 'https'));
                for (const name of TARGETS) {
                    expect.soft(kept.connect.includes(at(name)), `connect ${name}`).toBe(keeps(name, 'https', 'connect'));
                    expect.soft(kept.connect.includes(at(name, 'wss')), `connect wss ${name}`).toBe(keeps(name, 'wss', 'connect'));
                    if (mode === 'cooperative') expect.soft(kept.images.includes(at(name)), `images ${name}`).toBe(keeps(name, 'https', 'images'));
                    // every entry dropped is named in a warning, with its reason
                    for (const [scheme, kind] of [['https', 'connect'], ['wss', 'connect'], ...(mode === 'cooperative' ? [['https', 'images']] : [])] as const) {
                        if (keeps(name, scheme, kind)) continue;
                        const reason = onSite.includes(name) ? (at(name, scheme) === realm.selfOrigin ? "the host page's own origin" : "on the host page's site") : "the host page's site is undecided";
                        expect.soft(warnings.filter(text => text.startsWith(`[Sandbox] origins.${kind} dropped `) && text.includes(`${at(name, scheme)} (${reason}`)), `${kind} ${scheme} ${name}: ${reason}\n${warnings.join('\n')}`).toHaveLength(1);
                    }
                    // the guest's WebSocket: made where its entry is kept, refused by the gate where it is not
                    expect.soft(made[name], `WebSocket ${name}`).toBe(keeps(name, 'wss', 'connect') ? 'made' : 'SecurityError');
                }

                // every kept entry's request arrives (the positive control of silence); a dropped one's never does
                for (const name of TARGETS) {
                    for (const [kind, scheme, entryKind] of [['ws', 'wss', 'connect'], ['fetch', 'https', 'connect'], ...(mode === 'cooperative' ? [['img', 'https', 'images']] : [])] as const) {
                        const k = `${tag}.${kind}.${name}`;
                        if (keeps(name, scheme, entryKind)) await expect.poll(() => seen(k).length, `${k} arrives`).toBeGreaterThan(0);
                    }
                }
                await page.waitForTimeout(1000);
                for (const name of TARGETS) {
                    for (const [kind, scheme, entryKind] of [['ws', 'wss', 'connect'], ['fetch', 'https', 'connect'], ...(mode === 'cooperative' ? [['img', 'https', 'images']] : [])] as const) {
                        if (!keeps(name, scheme, entryKind)) expect.soft(seen(`${tag}.${kind}.${name}`), `${kind} ${name} was dropped`).toEqual([]);
                    }
                }

                // no request of the guest carries a Lax or Strict cookie of the host page's site or the top page's
                const guest = listener.hits.filter(hit => hit.k.startsWith(`${tag}.`) && /\.(ws|fetch|img)\./.test(hit.k));
                expect(guest.flatMap(hit => hit.cookies.filter(cookie => FIRST_PARTY.test(cookie)).map(cookie => `${hit.k}: ${cookie}`))).toEqual([]);
                // an engine that honours the wrapper's credentialless attribute sends none at all
                if (facts.credentialless) expect(guest.filter(hit => hit.cookies.length > 0).map(hit => `${hit.k}: ${hit.cookies}`)).toEqual([]);
            });
        }
    }
});
