import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixture';
import type { SandboxConfig } from '@src/host';
import { GATE_SOURCE_FILE } from '@src/lib/violation';
import { clickInSandbox, waitInView } from './strict-view';
import { makerCode, makerUrl, SEALED_MAKERS, type Maker, type MakerScheme } from './sealed-makers';

/**
 * Sealed mode makes no request, on any engine (docs/research/24_sealed_mode, step 3). Every request maker a sealed guest can
 * reach (sealed-makers.ts, the one enumeration, tied to the library's own lists by test/unit/sealed-makers.test.ts) is aimed
 * at a listener outside the browser, an HTTPS server that also answers WebSocket handshakes and a plain-HTTP one, whose
 * site holds a SameSite=None cookie in the jar. A sealed sandbox configured as an embedder does (setConfig() itself: no
 * baseline, no scriptUnsafe, no hostContentSecurityPolicy) runs them all: the worker's makers from its entry, the view's
 * markup, `set({ css })` values and a registered stylesheet, and the clicks that would follow a link, a ping or a form.
 *
 * The listener sees nothing: no request, no WebSocket handshake, no TCP connection. And each attempt is stopped and reported
 * where the library reports it (sealed-makers.ts, SealedOutcome): the request gate's refusal and its `connect-src` report;
 * `sandboxFetch()`'s FETCH_NOT_ALLOWED in the guest; a worker global the allowlist keeps out; the renderer's drop and its
 * report; the element's warning for the registered stylesheet.
 *
 * Positive controls, in this file: strict mode with the listener in every `origins` list (and `hostContentSecurityPolicy:
 * false`, as the harness page sends no policy) runs the same entry, and every maker strict mode admits reaches the listener,
 * without a cookie; and a plain sandboxed frame of the host page makes the same requests as a document makes them, which
 * reach it, with the jar's cookie. Which makers reach it in each control on every engine is measured and written in the
 * enumeration (`strict`, `frame`), with the reason where a maker is in neither (`note`): one that reaches it on some engines only is left out.
 */

test.use({ ignoreHTTPSErrors: true });

type Hit = { scheme: 'https' | 'http'; path: string; websocket: boolean; cookie: string };

/** The listener: HTTPS (and its WebSocket handshakes) and plain HTTP on loopback, each recording every request and connection. */
async function startListener() {
    const dir = mkdtempSync(path.join(tmpdir(), 'sealed-no-network-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    const hits: Hit[] = [];
    const connections = { https: 0, http: 0 };
    const sockets = new Set<Socket>();
    const respond = (scheme: Hit['scheme']) => (req: http.IncomingMessage, res: http.ServerResponse) => {
        hits.push({ scheme, path: req.url ?? '/', websocket: false, cookie: String(req.headers.cookie ?? '') });
        res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
        res.end('ok');
    };
    const secure = https.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) }, respond('https'));
    const plain = http.createServer(respond('http'));
    secure.on('upgrade', (req, socket) => {
        hits.push({ scheme: 'https', path: req.url ?? '/', websocket: true, cookie: String(req.headers.cookie ?? '') });
        socket.destroy();
    });
    for (const [scheme, server] of [['https', secure], ['http', plain]] as const) {
        server.on('connection', (socket: Socket) => {
            connections[scheme]++;
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    }
    const portOf = (server: http.Server) => (server.address() as AddressInfo).port;
    const origins: Record<MakerScheme, string> = {
        https: `https://127.0.0.1:${portOf(secure)}`,
        http: `http://127.0.0.1:${portOf(plain)}`,
        wss: `wss://127.0.0.1:${portOf(secure)}`,
    };
    return {
        origins,
        hits,
        connections,
        clear() {
            hits.length = 0;
            connections.https = 0;
            connections.http = 0;
        },
        async stop() {
            for (const socket of sockets) socket.destroy();
            await Promise.all([secure, plain].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

type Listener = Awaited<ReturnType<typeof startListener>>;

/** The id a path of the listener names (`/m/<id>`), or null. */
const makerOf = (hitPath: string) => /^\/m\/([^/?#]+)/.exec(hitPath)?.[1] ?? null;

const byRealm = (realm: Maker['realm']) => SEALED_MAKERS.filter(maker => maker.realm === realm);

/** The entry: renders every view maker, sets every `set({ css })` maker, runs every worker maker, and answers 'results'. */
function entry(origins: Record<MakerScheme, string>): string {
    const markup = byRealm('view').map(maker => makerCode(maker, makerUrl(maker, origins))).join('')
        + '<link rel="stylesheet" href="net.css"><div class="m-sheet-bg"></div><div class="m-sheet-set"></div><p class="m-sheet-font">sheet</p>'
        + '<div id="m-set-target" style="width:5px;height:5px">set</div><p id="m-done">done</p>';
    const sets = byRealm('set-css').map(maker => `try { sandboxView.set('m-set-target', { css: ${makerCode(maker, makerUrl(maker, origins))} }); } catch (e) { results[${JSON.stringify(maker.id)}] = e.name; }`);
    const runs = byRealm('worker').map(maker => `results[${JSON.stringify(maker.id)}] = await Promise.race([${makerCode(maker, makerUrl(maker, origins))}, new Promise((resolve) => setTimeout(() => resolve('pending'), 3000))]).then(String, (e) => 'threw ' + e.name);`);
    return `const results = {};
sandboxView.render(${JSON.stringify(markup)});
bridge.expose('set', () => {
${sets.join('\n')}
});
const work = (async () => {
${runs.join('\n')}
})();
bridge.expose('results', () => work.then(() => results));`;
}

/** The registered stylesheet the view links: every stylesheet maker's rules. */
const stylesheet = (origins: Record<MakerScheme, string>) => byRealm('stylesheet').map(maker => makerCode(maker, makerUrl(maker, origins))).join('\n');

/** Applies `config` exactly as given (setConfig() itself: no baseline) and resolves with 'ready' or 'terminated'. */
const apply = (page: Page, config: SandboxConfig) => page.evaluate((c) => whenSettled(s => s.setConfig(c)), config as any);

/** Runs every maker in a sandbox of `config`, with the clicks that would follow; resolves with what the worker's makers saw. */
async function runMakers(sandbox: { registerFiles: (files: Record<string, string>) => Promise<string>; call: <T>(method: string) => Promise<T> }, page: Page, browserName: string, listener: Listener, config: SandboxConfig) {
    expect(await sandbox.registerFiles({ 'main.js': entry(listener.origins), 'net.css': stylesheet(listener.origins) })).toBe('ok');
    expect(await apply(page, config)).toBe('ready');
    await waitInView(page, browserName, `!!document.getElementById('m-done')`, 10000);
    await sandbox.call('set'); // once the element it sets is in the view
    for (const maker of SEALED_MAKERS.filter(maker => maker.click)) {
        const box = await waitInView<{ x: number; y: number } | null>(page, browserName, `(() => { const r = document.getElementById(${JSON.stringify(maker.click)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await clickInSandbox(page, box!.x, box!.y);
    }
    const seen = await sandbox.call<Record<string, string>>('results');
    await page.waitForTimeout(1500); // what a load, a navigation or a ping would send after the attempt
    return seen;
}

const COOKIE = { name: 'sealed_probe', value: '1', domain: '127.0.0.1', path: '/', secure: true, sameSite: 'None' as const };

test.describe('sealed mode: no request leaves, from any maker the guest can reach', () => {
    let listener: Listener;
    test.beforeAll(async () => { listener = await startListener(); });
    test.afterAll(async () => { await listener?.stop(); });
    test.beforeEach(async ({ context }) => {
        await context.addCookies([COOKIE]);
        listener.clear();
    });

    test('every maker is stopped and reported where the library reports it, and the listener sees no request, handshake or connection', async ({ sandbox, page, browserName }) => {
        test.setTimeout(60000);
        const warnings: string[] = [];
        page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
        const seen = await runMakers(sandbox, page, browserName, listener, { mode: 'sealed', entry: 'main.js' });

        // nothing reached the listener: no request, no handshake, not even a connection (a preconnect sends none)
        expect(listener.hits.map(hit => `${hit.scheme} ${hit.path}`)).toEqual([]);
        expect(listener.connections).toEqual({ https: 0, http: 0 });

        // the worker: each maker failed in the guest as its outcome says
        const workerMakers = byRealm('worker');
        expect(seen).toEqual(Object.fromEntries(workerMakers.map(maker => [maker.id, maker.sees])));

        // the reports: the gate's for its makers, the renderer's for every URL it dropped (with its directive)
        const violations = await sandbox.violations();
        const reported = (maker: Maker) => violations.filter(v => v.blockedURI === makerUrl({ ...maker, scheme: maker.reportedAs ?? maker.scheme }, listener.origins));
        for (const maker of SEALED_MAKERS) {
            const reports = reported(maker);
            if (maker.outcome === 'gate') expect(reports.map(v => `${v.directive} ${v.sourceFile}`), maker.id).toEqual([`connect-src ${GATE_SOURCE_FILE}`]);
            else if (maker.outcome === 'dropped') expect(reports.map(v => v.directive), maker.id).toContain(maker.directive);
            // the browser's own refusal, reported where the engine raises one in a worker (not WebKit)
            // ledger: worker-violation-reports
            else if (maker.outcome === 'policy') expect(reports.map(v => v.directive), maker.id).toEqual(browserName === 'webkit' ? [] : ['script-src-elem']);
            else expect(reports, maker.id).toEqual([]);
        }
        // the registered stylesheet: built without its network URLs, said once
        expect(warnings.filter(text => text.includes('registered stylesheet "net.css"') && text.includes('sealed mode has no network'))).toHaveLength(1);
        expect(await sandbox.state()).toBe('ready');
    });

    test('positive control: strict mode with the listener in every origins list runs the same makers, and each one strict mode admits reaches it, with no cookie', async ({ sandbox, page, browserName }) => {
        test.setTimeout(60000);
        const listed = [listener.origins.https, listener.origins.http];
        await runMakers(sandbox, page, browserName, listener, {
            mode: 'strict', entry: 'main.js', hostContentSecurityPolicy: false,
            origins: { connect: listed, images: listed, media: listed, styles: listed, fonts: listed },
        });
        const reached = new Set(listener.hits.map(hit => makerOf(hit.path)));
        const expected = SEALED_MAKERS.filter(maker => maker.strict);
        expect(expected.length).toBe(12);
        expect(expected.map(maker => maker.id).filter(id => !reached.has(id))).toEqual([]);
        expect(listener.hits.filter(hit => hit.cookie !== '').map(hit => hit.path)).toEqual([]);
    });

    test('positive control: a plain sandboxed frame of the host page makes the same requests, and they reach the listener, with the jar\'s cookie', async ({ page, browserName }) => {
        // each maker as a document makes it (sealed-makers.ts, `frame`: the navigations and the makers a document does not have
        // are left out): the worker's from a script, the view's as markup, set({ css }) as a style, the stylesheet inline
        const makers = SEALED_MAKERS.filter(maker => maker.frame);
        expect(makers.length).toBe(35);
        const url = (maker: Maker) => makerUrl(maker, listener.origins);
        const script = [
            ...makers.filter(maker => maker.realm === 'worker').map(maker => `try { ${makerCode(maker, url(maker))}; } catch (e) {}`),
            ...makers.filter(maker => maker.realm === 'set-css').map(maker => `{ const css = ${makerCode(maker, url(maker))}; for (const name in css) document.getElementById('m-set-target').style.setProperty(name, css[name]); }`),
        ].join('\n');
        const html = makers.filter(maker => maker.realm === 'view').map(maker => makerCode(maker, url(maker))).join('')
            + `<style>${makers.filter(maker => maker.realm === 'stylesheet').map(maker => makerCode(maker, url(maker))).join('\n')}</style>`
            + '<div class="m-sheet-bg"></div><div class="m-sheet-set"></div><p class="m-sheet-font">sheet</p>'
            + '<div id="m-set-target" style="width:5px;height:5px;background-image:var(--m-image)">set</div>'
            + `<script>${script}</script>`;
        await page.evaluate((srcdoc) => {
            const frame = document.createElement('iframe');
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.srcdoc = srcdoc;
            document.body.appendChild(frame);
        }, html);
        const missing = () => makers.map(maker => maker.id).filter(id => !listener.hits.some(hit => makerOf(hit.path) === id));
        await expect.poll(missing, { timeout: 10000 }).toEqual([]);
        expect(listener.hits.some(hit => hit.cookie.includes('sealed_probe=1'))).toBe(true);
    });
});
