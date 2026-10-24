import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, ORIGIN } from './fixture';
import { inView, waitInView } from './strict-view';

/**
 * No request of strict mode carries a cookie, on any engine (S74, class A: STRICT_COOKIE_CARRIERS is empty). Its two
 * would-be carriers are the view's loads and a WebSocket handshake of its worker.
 *
 * The view makes no load with a cookie (BD2:ISO-2, docs/research/21_crossorigin_loads/README.md). The engine chooses the
 * credentials of an element's load and of a load CSS makes; the renderer takes the choice: every img, video, audio and
 * link it keeps carries crossorigin="anonymous" from before it is connected (RENDER_CROSSORIGIN_ELEMENTS), and the
 * loads no attribute reaches keep no network URL (a poster, which Firefox loads without CORS; every url(), @import,
 * image-set() and @font-face source of guest CSS and of a registered stylesheet). Without that, Firefox and WebKit
 * attach the listed origin's SameSite=None cookie to every one of these loads, and WebKit the host site's Lax, Strict
 * and host-only cookies to a same-site target (research 21; Chromium sends none only because the wrapper is
 * credentialless).
 *
 * Evidence is the listener's: the Cookie header of every request that reached it, outside the browser. Each world has
 * its positive control: a plain sandboxed srcdoc frame of the host page, which is never credentialless, loads an image
 * from the same origins without the attribute, and the listener sees cookies on it.
 *
 *   cross-site   the harness page on localhost; the listed origin https://127.0.0.1:P, another site, with its
 *                SameSite=None cookie.
 *   opaque-host  the harness page served as https://app.wsprobe.test (H) with `Content-Security-Policy: sandbox
 *                allow-scripts`, as a site of user content serves its pages: the page's origin is opaque, so it has no
 *                site of its own and the library keeps every entry, with a warning (host-site.ts, limitHostReach).
 *                Listed: a sibling, https://cdn.wsprobe.test (S, the site of the page's URL, with domain cookies of
 *                every SameSite kind and host-only ones) and https://cross.wsprobe2.test (X, another site). A page with
 *                a tuple origin cannot list an origin on its own site (onHostSite refuses it from `self.origin` alone,
 *                with nothing of the page to deceive), so a sandboxed host page is the one through which a same-site
 *                target is listed at all; the loads that reach S show that the construction, not the site rule, keeps
 *                the cookies off. The names reach the listener through a CONNECT proxy of this spec's
 *                (startNameProxy), so no DNS entry is needed.
 * Both run on every engine. In each, the worker also tries a WebSocket to every target (and, in opaque-host, to the host
 * page's own origin H, whose host-only cookies are in the jar too): strict mode keeps no `wss://` entry and its request
 * gate refuses every WebSocket, so each attempt is a SecurityError with the gate's report, and no handshake reaches the
 * listener, which records one (the positive control: a plain sandboxed frame's handshakes reach it).
 *
 * And the costs of the construction, on every engine: an origin that answers CORS still renders (images, media, and a
 * seek in a 7 MB video through Range requests); one that does not fails, and each failed load is reported as a
 * `violation` of its directive.
 */

test.use({ ignoreHTTPSErrors: true });
const NAMES = { H: 'app.wsprobe.test', S: 'cdn.wsprobe.test', X: 'cross.wsprobe2.test' } as const;

/** The host page's header in the opaque-host world: a sandboxed document, whose origin is opaque. */
const OPAQUE_HOST_CSP = 'sandbox allow-scripts';

/**
 * The names' resolver: an HTTP proxy that tunnels a CONNECT to any `.test` host to the same port on 127.0.0.1 and
 * refuses everything else. The opaque-host world's context uses it (`proxy`), on every engine, for every host but
 * localhost and 127.0.0.1; the browser never resolves the names itself.
 */
async function startNameProxy() {
    const server = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
    const tunnels = new Set<net.Socket>(); // a tunnel leaves the server's connections: closed by stop() itself
    server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
        tunnels.add(client);
        client.on('close', () => tunnels.delete(client));
        const target = /^([a-z0-9.-]+\.test):(\d+)$/i.exec(req.url ?? '');
        if (!target) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
        const upstream = net.connect(Number(target[2]), '127.0.0.1', () => {
            tunnels.add(upstream);
            upstream.on('close', () => tunnels.delete(upstream));
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        stop: () => new Promise<void>(resolve => {
            server.close(() => resolve());
            server.closeAllConnections();
            for (const socket of tunnels) socket.destroy();
        }),
    };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAIAAAAPE8H1AAAAEElEQVR4nGP4z8AAQQxEsgCEuw7yxezkBQAAAABJRU5ErkJggg==', 'base64');
const VTT = 'WEBVTT\n\n00:00.000 --> 00:05.000\nhello\n';
const FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf'];

function wav(seconds: number): Buffer {
    const samples = 8000 * seconds;
    const b = Buffer.alloc(44 + samples * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), 44 + i * 2);
    return b;
}

/** A 12 s noise clip, about 7 MB: a seek to 75 % of it needs a Range request. A long WAV where ffmpeg is missing. */
function longMedia(dir: string): { type: string; bytes: Buffer } {
    const file = path.join(dir, 'v.webm');
    try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25,geq=random(1)*255:128:128', '-t', '12', '-c:v', 'libvpx', '-b:v', '5M', '-minrate', '5M', '-maxrate', '5M', '-g', '25', '-an', file], { stdio: 'ignore' });
        return { type: 'video/webm', bytes: readFileSync(file) };
    } catch {
        return { type: 'audio/wav', bytes: wav(400) };
    }
}

type Hit = { host: string; k: string; cookies: string[]; origin: string; mode: string; range: string; status: number; websocket?: true };

/**
 * One HTTPS listener for 127.0.0.1 and the three names. `/cors/<file>?k=<id>` answers with `Access-Control-Allow-Origin: *`,
 * `/nocors/<file>` without it; media answers Range requests (206). Anything else is the e2e server's (the harness and
 * its modules), passed through with `Access-Control-Allow-Origin: *` (an opaque page fetches its modules with CORS);
 * the harness asked with `?opaque` comes with OPAQUE_HOST_CSP.
 */
async function startListener(seek = true) {
    const dir = mkdtempSync(path.join(tmpdir(), 'view-credentials-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=wsprobe',
        '-addext', `subjectAltName=IP:127.0.0.1,${Object.values(NAMES).map(name => `DNS:${name}`).join(',')}`, '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    const font = FONTS.find(candidate => existsSync(candidate));
    const assets: Record<string, { type: string; bytes: Buffer; ranges?: true }> = {
        'a.png': { type: 'image/png', bytes: PNG },
        'e.wav': { type: 'audio/wav', bytes: wav(1), ranges: true },
        'g.vtt': { type: 'text/vtt', bytes: Buffer.from(VTT) },
        'f.ttf': { type: 'font/ttf', bytes: font ? readFileSync(font) : Buffer.from('not a font') },
        's.css': { type: 'text/css', bytes: Buffer.from('*{--imported:1}') },
        'v': { ...(seek ? longMedia(dir) : { type: 'audio/wav', bytes: wav(1) }), ranges: true },
    };
    const hits: Hit[] = [];
    const server = https.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
        const url = new URL(req.url ?? '/', 'https://listener');
        const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
        const match = /^\/(cors|nocors)\/([^/]+)$/.exec(url.pathname);
        if (!match && !url.searchParams.has('k')) {
            // the host page and its modules, from the e2e server
            const page = url.pathname.endsWith('/harness.html') && url.searchParams.has('opaque') ? { 'content-security-policy': OPAQUE_HOST_CSP } : {};
            fetch(ORIGIN + (req.url ?? '/')).then(async (response) => {
                res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...page });
                res.end(Buffer.from(await response.arrayBuffer()));
            }, () => { res.writeHead(502); res.end(); });
            return;
        }
        const cookie = String(req.headers.cookie ?? '');
        const hit: Hit = {
            host, k: url.searchParams.get('k') ?? '', cookies: cookie ? cookie.split(/;\s*/).map(part => part.split('=')[0]!) : [],
            origin: String(req.headers.origin ?? '-'), mode: String(req.headers['sec-fetch-mode'] ?? '-'), range: String(req.headers.range ?? '-'), status: 0,
        };
        hits.push(hit);
        const asset = match ? assets[match[2]!.replace(/\.webm$|\.long$/, '')] : undefined;
        if (!match || !asset) {
            hit.status = 404;
            res.writeHead(404);
            res.end();
            return;
        }
        const headers: Record<string, string | number> = { 'cache-control': 'no-store', 'content-type': asset.type, ...(match[1] === 'cors' ? { 'access-control-allow-origin': '*' } : {}) };
        const range = asset.ranges ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '')) : null;
        if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = Math.min(range[2] ? Number(range[2]) : asset.bytes.length - 1, asset.bytes.length - 1);
            hit.status = 206;
            res.writeHead(206, { ...headers, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${asset.bytes.length}`, 'content-length': end - start + 1 });
            res.end(asset.bytes.subarray(start, end + 1));
            return;
        }
        hit.status = 200;
        res.writeHead(200, { ...headers, 'content-length': asset.bytes.length, ...(asset.ranges ? { 'accept-ranges': 'bytes' } : {}) });
        res.end(asset.bytes);
    });
    // a WebSocket handshake is recorded with its cookies, then refused: the evidence of a socket's attempt
    server.on('upgrade', (req, socket) => {
        const url = new URL(req.url ?? '/', 'https://listener');
        const cookie = String(req.headers.cookie ?? '');
        hits.push({ host: String(req.headers.host ?? '').replace(/:\d+$/, ''), k: url.searchParams.get('k') ?? '', cookies: cookie ? cookie.split(/;\s*/).map(part => part.split('=')[0]!) : [], origin: String(req.headers.origin ?? '-'), mode: 'websocket', range: '-', status: 0, websocket: true });
        socket.destroy();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        port,
        hits,
        seekType: assets.v!.type,
        stop: async () => {
            await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

type Listener = Awaited<ReturnType<typeof startListener>>;

const cookie = (name: string, domain: string, sameSite: 'None' | 'Lax' | 'Strict') => ({ name, value: '1', domain, path: '/', secure: true, sameSite });

/** A world: which origins are listed, the cookies the jar holds for them, and the origins a WebSocket is tried to. */
interface World {
    targets: Record<string, string>; // name → listed origin
    cookies: ReturnType<typeof cookie>[];
    sockets: Record<string, string>; // name → origin: the targets, and in opaque-host the host page's own
}

const crossSiteWorld = (listener: Listener): World => ({
    targets: { X: `https://127.0.0.1:${listener.port}` },
    cookies: [cookie('x_none', '127.0.0.1', 'None')],
    sockets: { X: `https://127.0.0.1:${listener.port}` },
});

const opaqueHostWorld = (listener: Listener): World => ({
    targets: { S: `https://${NAMES.S}:${listener.port}`, X: `https://${NAMES.X}:${listener.port}` },
    sockets: { H: `https://${NAMES.H}:${listener.port}`, S: `https://${NAMES.S}:${listener.port}`, X: `https://${NAMES.X}:${listener.port}` },
    cookies: [
        ...(['None', 'Lax', 'Strict'] as const).flatMap(site => [cookie(`d_${site.toLowerCase()}`, '.wsprobe.test', site), cookie(`xd_${site.toLowerCase()}`, '.wsprobe2.test', site)]),
        ...(['None', 'Lax'] as const).flatMap(site => [cookie(`h_${site.toLowerCase()}`, NAMES.H, site), cookie(`s_${site.toLowerCase()}`, NAMES.S, site), cookie(`x_${site.toLowerCase()}`, NAMES.X, site)]),
    ],
});

/** The markup of one run: every kind of load the view keeps or drops, for every target, each with its own id `k`. */
function markup(targets: Record<string, string>, tag: string): { html: string; stylesheet: string; kept: string[]; dropped: string[] } {
    let html = '';
    let stylesheet = '';
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const [name, origin] of Object.entries(targets)) {
        const u = (k: string, file: string) => `${origin}/cors/${file}?k=${tag}.${name}.${k}`;
        html += `<img id="${name}-img" src="${u('img', 'a.png')}" alt="">
<img id="${name}-srcset" srcset="${u('srcset', 'a.png')} 1x" alt="">
<picture><source srcset="${u('picsource', 'a.png')}"><img id="${name}-picture" alt=""></picture>
<img id="${name}-usecred" crossorigin="use-credentials" src="${u('usecred', 'a.png')}" alt="">
<video id="${name}-video" src="${u('video', 'e.wav')}" poster="${u('poster', 'a.png')}" preload="auto"><track default kind="subtitles" src="${u('track', 'g.vtt')}"></video>
<video preload="auto"><source src="${u('videosource', 'e.wav')}" type="audio/wav"></video>
<audio id="${name}-audio" src="${u('audio', 'e.wav')}" preload="auto"></audio>
<audio preload="auto"><source src="${u('audiosource', 'e.wav')}" type="audio/wav"></audio>
<div style="width:5px;height:5px;background-image:url('${u('styleattr', 'a.png')}')"></div>
<style>@import url("${u('import', 's.css')}"); .${name}-bg{width:5px;height:5px;background:url("${u('stylebg', 'a.png')}")} .${name}-set{width:5px;height:5px;background-image:image-set("${u('imageset', 'a.png')}" 1x)} @font-face{font-family:F${name};src:url("${u('font', 'f.ttf')}")} .${name}-font{font-family:F${name}}</style>
<div class="${name}-bg"></div><div class="${name}-set"></div><p class="${name}-font">font</p>
<div class="${name}-own">own</div>\n`;
        stylesheet += `@import url("${u('linkimport', 's.css')}"); .${name}-own{width:9px;background:url("${u('linkbg', 'a.png')}")} @font-face{font-family:L${name};src:url("${u('linkfont', 'f.ttf')}")} .${name}-own{font-family:L${name}}\n`;
        kept.push(...['img', 'srcset', 'picsource', 'usecred', 'video', 'audio'].map(k => `${tag}.${name}.${k}`));
        dropped.push(...['poster', 'styleattr', 'import', 'stylebg', 'imageset', 'font', 'linkimport', 'linkbg', 'linkfont'].map(k => `${tag}.${name}.${k}`));
    }
    return { html: `${html}<link rel="stylesheet" href="own.css">`, stylesheet, kept, dropped };
}

/** The positive control: a plain sandboxed srcdoc frame of the host page loads an image from each target, without crossorigin. */
async function controlFrame(page: Page, targets: Record<string, string>, tag: string) {
    const images = Object.entries(targets).map(([name, origin]) => `<img src="${origin}/cors/a.png?k=${tag}.${name}.control">`).join('');
    await page.evaluate((html) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.srcdoc = html;
        document.body.appendChild(frame);
    }, images);
}

const seen = (listener: Listener, k: string) => listener.hits.filter(hit => hit.k === k);

for (const worldName of ['cross-site', 'opaque-host'] as const) {
    test.describe(`strict mode: no request carries a cookie (${worldName})`, () => {
        let listener: Listener;
        let world: World;
        let siteWarnings: string[];
        if (worldName === 'opaque-host') {
            test.use({
                proxy: async ({}, use) => {
                    const proxy = await startNameProxy();
                    await use({ server: proxy.server, bypass: 'localhost,127.0.0.1' }); // the fixture's own harness stays direct
                    await proxy.stop();
                },
            });
        }
        test.beforeAll(async () => {
            listener = await startListener();
        });
        test.afterAll(async () => {
            await listener?.stop();
        });
        test.beforeEach(async ({ sandbox, page, context }) => {
            world = worldName === 'opaque-host' ? opaqueHostWorld(listener) : crossSiteWorld(listener);
            await context.addCookies(world.cookies);
            siteWarnings = [];
            page.on('console', message => { if (message.type() === 'warning' && message.text().includes('whose origin is opaque')) siteWarnings.push(message.text()); });
            if (worldName === 'opaque-host') {
                await page.goto(`https://${NAMES.H}:${listener.port}/test/e2e/harness.html?opaque`);
                await page.waitForFunction(() => (window as any).harnessReady === true);
                expect(await page.evaluate(() => self.origin), 'the host page is a sandboxed document').toBe('null');
            }
            listener.hits.length = 0;
            await sandbox.clearViolations();
        });

        test('every load kind: no request carries a cookie; element loads arrive as CORS requests and render, the rest is dropped and reported', async ({ sandbox, page, browserName }) => {
            test.setTimeout(60000);
            const tag = `${worldName}-${browserName}`;
            // positive control: the same jar sends cookies with a plain frame's image
            await controlFrame(page, world.targets, tag);
            for (const name of Object.keys(world.targets)) await expect.poll(() => seen(listener, `${tag}.${name}.control`).length, `control ${name}`).toBeGreaterThan(0);
            for (const name of Object.keys(world.targets)) expect(seen(listener, `${tag}.${name}.control`)[0]!.cookies.length, `control ${name} carries cookies`).toBeGreaterThan(0);

            const run = markup(world.targets, tag);
            const warnings: string[] = [];
            page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
            await sandbox.registerFiles({ 'main.js': `sandboxView.render(${JSON.stringify(run.html)});`, 'own.css': run.stylesheet });
            const origins = Object.values(world.targets);
            expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', origins: { images: origins, media: origins, styles: origins, fonts: origins } })).toBe('ready');
            // the opaque host page keeps the same-site target listed, and says so (#71); a page with a tuple origin lists none
            if (worldName === 'opaque-host') expect(siteWarnings.some(text => text.includes(`origins.images lists ${world.targets.S}`)), siteWarnings.join('\n')).toBe(true);
            for (const k of run.kept) await expect.poll(() => seen(listener, k).length, k).toBeGreaterThan(0);
            await page.waitForTimeout(1500); // what CSS would load once styled, and the media's later requests

            // no request of the view carried a cookie, whatever it was, to any target
            const fromView = listener.hits.filter(hit => !hit.k.endsWith('.control'));
            expect(fromView.filter(hit => hit.cookies.length > 0).map(hit => `${hit.k}: ${hit.cookies.join(',')}`)).toEqual([]);
            for (const hit of fromView) {
                expect(hit.origin, hit.k).toBe('null');
                if (hit.mode !== '-') expect(hit.mode, hit.k).toBe('cors');
            }
            // nothing that no attribute reaches left the view
            expect(fromView.filter(hit => run.dropped.includes(hit.k)).map(hit => hit.k)).toEqual([]);
            // the CORS origins rendered: images decoded, media has its metadata
            for (const name of Object.keys(world.targets)) {
                expect(await waitInView<boolean>(page, browserName, `['img', 'srcset', 'picture', 'usecred'].every(id => document.getElementById('${name}-' + id).naturalWidth === 3)`, 8000), name).toBe(true);
                expect(await waitInView<boolean>(page, browserName, `['video', 'audio'].every(id => document.getElementById('${name}-' + id).readyState >= 1)`, 8000), name).toBe(true);
            }
            // every element that loads carries the renderer's attribute, the guest's use-credentials replaced
            const attributes = await inView<string[]>(page, browserName, `[...document.querySelectorAll('img, video, audio, link')].map(e => e.getAttribute('crossorigin'))`);
            expect(Array.isArray(attributes) && attributes.length > 0 && attributes.every(value => value === 'anonymous')).toBe(true);
            // every network URL CSS or a poster named is reported, with its directive; the registered stylesheet's, once
            const violations = (await sandbox.violations()).map(v => `${v.directive} ${new URL(v.blockedURI).searchParams.get('k')}`);
            for (const name of Object.keys(world.targets)) {
                for (const [directive, k] of [['img-src', 'poster'], ['img-src', 'styleattr'], ['style-src', 'import'], ['img-src', 'stylebg'], ['img-src', 'imageset'], ['font-src', 'font']]) {
                    expect(violations, `${name} ${k}`).toContain(`${directive} ${tag}.${name}.${k}`);
                }
            }
            expect(warnings.filter(text => text.includes('registered stylesheet "own.css"'))).toHaveLength(1);
        });

        test('the worker opens no WebSocket: each one, to every target and the host page\'s own origin, is refused and reported, and no handshake leaves', async ({ sandbox, page, browserName }) => {
            test.setTimeout(60000);
            const tag = `${worldName}-${browserName}-ws`;
            const sockets = Object.entries(world.sockets);
            const wssOf = (origin: string) => origin.replace(/^https:/, 'wss:');
            // positive control: a plain sandboxed frame of the host page opens a handshake to each, which the listener records
            // (with the cookies its engine attaches, which a strict guest's handshake would carry)
            // ledger: cookies
            await page.evaluate((urls) => {
                const frame = document.createElement('iframe');
                frame.setAttribute('sandbox', 'allow-scripts');
                frame.srcdoc = `<script>for (const url of ${JSON.stringify(urls)}) { try { new WebSocket(url); } catch (e) {} }<\/script>`;
                document.body.appendChild(frame);
            }, sockets.map(([name, origin]) => `${wssOf(origin)}/ws?k=${tag}.${name}.control`));
            for (const [name] of sockets) await expect.poll(() => seen(listener, `${tag}.${name}.control`).filter(hit => hit.websocket).length, `control ${name}`).toBeGreaterThan(0);

            // every target listed for fetch() and with its wss:// twin, as cooperative and worker mode would take a socket
            const listed = Object.values(world.sockets);
            const connect = [...listed, ...listed.map(wssOf)];
            expect(await sandbox.mount({ mode: 'strict', origins: { connect }, ...(worldName === 'opaque-host' ? { hostContentSecurityPolicy: false } : {}) })).toBe('ready');
            const outcome = await sandbox.inGuest(`
                const out = {};
                for (const [name, url] of ${JSON.stringify(sockets.map(([name, origin]) => [name, `${wssOf(origin)}/ws?k=${tag}.${name}.sandbox`]))}) {
                    try { new WebSocket(url); out[name] = 'made'; } catch (e) { out[name] = e.name + ': ' + e.message; }
                }
                return out;
            `);
            expect(outcome).toEqual(Object.fromEntries(sockets.map(([name]) => [name, 'SecurityError: WebSocket refused by the sandbox: strict mode opens no WebSocket'])));
            const reports = (await sandbox.violations()).filter(v => v.directive === 'connect-src' && v.blockedURI.includes('.sandbox')).map(v => new URL(v.blockedURI).searchParams.get('k'));
            expect(reports.sort()).toEqual(sockets.map(([name]) => `${tag}.${name}.sandbox`).sort());
            await page.waitForTimeout(800);
            expect(listener.hits.filter(hit => hit.k.endsWith('.sandbox'))).toEqual([]);
        });

        test('an origin that answers CORS plays and seeks through Range requests; one that does not fails, reported', async ({ sandbox, page, browserName }) => {
            test.setTimeout(60000);
            const tag = `${worldName}-${browserName}-media`;
            const [name, origin] = Object.entries(world.targets).at(-1)!;
            const k = (kind: string) => `${tag}.${kind}`;
            const html = `<video id="seek" src="${origin}/cors/v.long?k=${k('seek')}" preload="metadata" muted></video>`
                + `<img id="refused" src="${origin}/nocors/a.png?k=${k('nocors-img')}" alt=""><audio id="refused-audio" src="${origin}/nocors/e.wav?k=${k('nocors-audio')}" preload="auto"></audio>`;
            await sandbox.registerFiles({ 'main.js': `sandboxView.render(${JSON.stringify(html)});` });
            expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', origins: { images: [origin], media: [origin] } })).toBe('ready');

            // seek to 75 % of the clip once its metadata is in; a seek that far needs ranged requests
            expect(await waitInView<boolean>(page, browserName, `document.getElementById('seek').readyState >= 1`, 15000), name).toBe(true);
            await inView(page, browserName, `(() => { const v = document.getElementById('seek'); window.__seeked = false; v.addEventListener('seeked', () => { window.__seeked = true; }, { once: true }); v.currentTime = v.duration * 0.75; return true; })()`);
            expect(await waitInView<boolean>(page, browserName, `window.__seeked === true && document.getElementById('seek').currentTime > document.getElementById('seek').duration * 0.7`, 15000)).toBe(true);
            const media = seen(listener, k('seek'));
            expect(media.some(hit => hit.status === 206 && hit.range !== '-'), JSON.stringify(media)).toBe(true);
            expect(media.filter(hit => hit.cookies.length > 0)).toEqual([]);

            // no Access-Control-Allow-Origin: the request left without a cookie, failed, and each failure is reported
            await expect.poll(async () => (await sandbox.violations()).map(v => `${v.directive} ${new URL(v.blockedURI).searchParams.get('k')}`).sort(), { timeout: 10000 })
                .toEqual([`img-src ${k('nocors-img')}`, `media-src ${k('nocors-audio')}`]);
            expect(await inView<number>(page, browserName, `document.getElementById('refused').naturalWidth`)).toBe(0);
            for (const kind of ['nocors-img', 'nocors-audio']) expect(seen(listener, k(kind)).flatMap(hit => hit.cookies), kind).toEqual([]);
            expect(listener.hits.filter(hit => hit.k.startsWith(tag) && hit.cookies.length > 0)).toEqual([]);
        });
    });
}
