import https from 'node:https';
import dns from 'node:dns/promises';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, ORIGIN } from './fixture';
import { inView, waitInView } from './strict-view';

/**
 * Strict mode's view makes no load with a cookie, on any engine (S74, BD2:ISO-2, docs/research/21_crossorigin_loads/README.md; class A). The engine chooses the
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
 *   cross-site  the harness page on localhost; the listed origin https://127.0.0.1:P, another site, with its
 *               SameSite=None cookie. Runs everywhere.
 *   names       the harness page served as https://app.wsprobe.test (H); listed: a sibling, https://cdn.wsprobe.test
 *               (S, the host page's own site, with every SameSite kind and host-only cookies) and
 *               https://cross.wsprobe2.test (X, another site). The library drops a listed origin on the host page's
 *               site, so the page's cookie-domain probe (host-site.ts) is made to answer "the host itself", as a probe
 *               that cannot tell would: S stays listed, and the loads that reach it show that the construction, not the
 *               site rule, keeps the cookies off. Needs one line in /etc/hosts (HOSTS_LINE) and skips without it.
 *
 * And the costs of the construction, on every engine: an origin that answers CORS still renders (images, media, and a
 * seek in a 7 MB video through Range requests); one that does not fails, and each failed load is reported as a
 * `violation` of its directive. `origins.withoutCors` is the embedder's way out, per origin: such an origin is loaded
 * the classic way, without CORS and with its own cookies where the engine sends them, and every other keeps the rule.
 */

test.use({ ignoreHTTPSErrors: true });
// The browsers read the proxy settings from the environment: a machine with HTTPS_PROXY would send the names to it.
for (const name of ['NO_PROXY', 'no_proxy']) process.env[name] = `${process.env[name] ?? ''},.test`;

const NAMES = { H: 'app.wsprobe.test', S: 'cdn.wsprobe.test', X: 'cross.wsprobe2.test' } as const;
const HOSTS_LINE = `127.0.0.1 ${Object.values(NAMES).join(' ')}`;

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

type Hit = { host: string; k: string; cookies: string[]; origin: string; mode: string; range: string; status: number };

/**
 * One HTTPS listener for 127.0.0.1 and the three names. `/cors/<file>?k=<id>` answers with `Access-Control-Allow-Origin: *`,
 * `/nocors/<file>` without it; media answers Range requests (206). Anything else asked of H is the e2e server's (the
 * harness and its modules), passed through.
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
        if (!match && host === NAMES.H) {
            // the host page and its modules, from the e2e server
            fetch(ORIGIN + (req.url ?? '/')).then(async (response) => {
                res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/plain', 'cache-control': 'no-store' });
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
    server.on('upgrade', (_req, socket) => socket.destroy());
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

async function namesResolve(): Promise<boolean> {
    try {
        for (const name of Object.values(NAMES)) if ((await dns.lookup(name)).address !== '127.0.0.1') return false;
        return true;
    } catch {
        return false;
    }
}

const cookie = (name: string, domain: string, sameSite: 'None' | 'Lax' | 'Strict') => ({ name, value: '1', domain, path: '/', secure: true, sameSite });

/** A world: which origins are listed, and the cookies the jar holds for them. */
interface World {
    targets: Record<string, string>; // name → listed origin
    cookies: ReturnType<typeof cookie>[];
}

const crossSiteWorld = (listener: Listener): World => ({
    targets: { X: `https://127.0.0.1:${listener.port}` },
    cookies: [cookie('x_none', '127.0.0.1', 'None')],
});

const namesWorld = (listener: Listener): World => ({
    targets: { S: `https://${NAMES.S}:${listener.port}`, X: `https://${NAMES.X}:${listener.port}` },
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

for (const worldName of ['cross-site', 'names'] as const) {
    test.describe(`strict view loads carry no cookie (${worldName})`, () => {
        let listener: Listener;
        let world: World;
        test.beforeAll(async () => {
            listener = await startListener();
        });
        test.afterAll(async () => {
            await listener?.stop();
        });
        test.beforeEach(async ({ sandbox, page, context }) => {
            if (worldName === 'names') test.skip(!(await namesResolve()), `add this line to /etc/hosts: ${HOSTS_LINE}`);
            world = worldName === 'names' ? namesWorld(listener) : crossSiteWorld(listener);
            await context.addCookies(world.cookies);
            if (worldName === 'names') {
                // The page's cookie-domain probe (host-site.ts) finds no parent domain the jar accepts, as a probe that
                // cannot tell would, so it takes the page's host for its site and keeps the sibling listed. The jar, and
                // what the browser attaches from it, is untouched.
                await page.addInitScript(() => {
                    if (window !== window.top) return;
                    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
                    Object.defineProperty(Document.prototype, 'cookie', {
                        configurable: true,
                        get() { return descriptor.get!.call(this); },
                        set(value: string) { if (!/;\s*domain=/i.test(value)) descriptor.set!.call(this, value); },
                    });
                });
                await page.goto(`https://${NAMES.H}:${listener.port}/test/e2e/harness.html`);
                await page.waitForFunction(() => (window as any).harnessReady === true);
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

test.describe('origins.withoutCors: a listed origin loads without CORS, with its own cookies where the engine sends them; every other keeps the rule', () => {
    let free: Listener; // in withoutCors
    let strict: Listener; // not
    test.beforeAll(async () => {
        free = await startListener(false);
        strict = await startListener(false);
    });
    test.afterAll(async () => {
        await free?.stop();
        await strict?.stop();
    });

    test('loads of the listed origin need no Access-Control-Allow-Origin and carry its cookie (Firefox, WebKit; Chromium none); the other needs it and carries none', async ({ sandbox, page, context, browserName }) => {
        test.setTimeout(60000);
        const W = `https://127.0.0.1:${free.port}`;
        const N = `https://127.0.0.1:${strict.port}`;
        await context.addCookies([cookie('x_none', '127.0.0.1', 'None')]); // a host-only cookie of 127.0.0.1: both listeners, any port
        const html = `<img id="w" src="${W}/nocors/a.png?k=w.img" alt=""><audio id="wa" src="${W}/nocors/e.wav?k=w.audio" preload="auto"></audio>`
            + `<div id="wcss" style="width:5px;height:5px;background:url(${W}/nocors/a.png?k=w.css)"></div><video id="wp" poster="${W}/nocors/a.png?k=w.poster"></video>`
            + `<img id="n" src="${N}/nocors/a.png?k=n.nocors" alt=""><img id="c" src="${N}/cors/a.png?k=n.cors" alt=""><div style="width:5px;height:5px;background:url(${N}/cors/a.png?k=n.css)"></div>`;
        await sandbox.registerFiles({ 'main.js': `sandboxView.render(${JSON.stringify(html)});` });
        expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', origins: { images: [W, N], media: [W, N], withoutCors: [W] } })).toBe('ready');

        for (const k of ['w.img', 'w.audio', 'w.css', 'w.poster']) await expect.poll(() => seen(free, k).length, k).toBeGreaterThan(0);
        // the listed origin, without Access-Control-Allow-Origin: rendered, loaded the classic way
        expect(await waitInView<boolean>(page, browserName, `document.getElementById('w').naturalWidth === 3 && document.getElementById('wa').readyState >= 1`, 8000)).toBe(true);
        expect(await inView(page, browserName, `['w', 'wa', 'wp', 'n', 'c'].map(id => document.getElementById(id).getAttribute('crossorigin'))`)).toEqual([null, null, null, 'anonymous', 'anonymous']);
        // and its own cookie rides on it where the engine attaches third-party cookies to such a load
        // ledger: cookies
        const expected = browserName === 'chromium' ? [] : ['x_none'];
        for (const k of ['w.img', 'w.audio', 'w.css']) for (const hit of seen(free, k)) expect(hit.cookies, k).toEqual(expected);

        // the other origin: CORS required, no cookie, and its CSS URL is dropped
        await expect.poll(() => seen(strict, 'n.nocors').length).toBeGreaterThan(0);
        expect(await waitInView<boolean>(page, browserName, `document.getElementById('c').naturalWidth === 3`, 8000)).toBe(true);
        expect(await inView<number>(page, browserName, `document.getElementById('n').naturalWidth`)).toBe(0);
        await page.waitForTimeout(500);
        expect(strict.hits.filter(hit => hit.cookies.length > 0)).toEqual([]);
        expect(seen(strict, 'n.css')).toEqual([]);
        const violations = (await sandbox.violations()).map(v => `${v.directive} ${new URL(v.blockedURI).searchParams.get('k')}`);
        expect(violations).toEqual(expect.arrayContaining(['img-src n.nocors', 'img-src n.css']));
        expect(violations.filter(line => line.includes(' w.'))).toEqual([]);
    });
});
