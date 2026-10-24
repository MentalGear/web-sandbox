import { test, expect, type SandboxDriver } from './fixture';
import { useRecorder, wss } from './recorder';
import { GATE_SOURCE_FILE } from '@src/lib/violation';
import { COOKIE_ENGINE_FACTS, type CookieEngine } from '@src/lib/cookie-facts';

/**
 * The request gate (src/lib/in-sandbox-script.ts; S74): in every guest realm, fetch(), XMLHttpRequest and WebSocket admit
 * exactly the origins of the guest policy's connect-src, refuse everything else before the browser sees it, the same way
 * on every engine, and report each refusal themselves, with one shape. fetch() and XMLHttpRequest send no credentials.
 * Strict mode opens no WebSocket (it has no cookie carrier, STRICT_COOKIE_CARRIERS): its gate refuses every one, a listed
 * origin's too, with the same shape, and its `origins.connect` keeps no `wss://` entry; a streamed fetch() response, read
 * as it arrives, is what replaces a socket there. The platform's originals cannot be recovered from the realm.
 *
 * Evidence: the recorder's listeners outside the browser (recorder.ts), with a positive control beside each negative: the
 * admitted requests reach the allowed listener, and the same credentialed requests from a plain sandboxed frame of the host
 * page's carry the cookie.
 */

const recorder = useRecorder();
const MODES = ['cooperative', 'worker', 'strict'] as const;
const GATE = 'refused by the sandbox: the origin is not in its origins.connect';
const NO_SOCKET = 'refused by the sandbox: strict mode opens no WebSocket';
/** What `new WebSocket()` to an origin connect-src does not list throws, by mode. */
const socketRefusal = (mode: (typeof MODES)[number]) => `SecurityError: WebSocket ${mode === 'strict' ? NO_SOCKET : GATE}`;

// Every refused request a guest can make with the three request makers, and how each one ended, as the guest sees it.
const REFUSED = (blocked: string) => `
    const xhrEvents = (url) => new Promise((resolve) => {
        const x = new XMLHttpRequest();
        const seen = [];
        for (const type of ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'loadend']) {
            x.addEventListener(type, () => seen.push(type + ':' + x.readyState + (type === 'error' ? ':' + x.status : '')));
        }
        x.open('GET', url);
        x.send();
        setTimeout(() => resolve(seen), 300);
    });
    const xhrSync = (url) => { const x = new XMLHttpRequest(); x.open('GET', url, false); try { x.send(); return 'sent'; } catch (e) { return e.name + ' ' + x.readyState; } };
    const socket = (url) => { try { new WebSocket(url); return 'made'; } catch (e) { return e.name + ': ' + e.message; } };
    return {
        fetch: await fetch('${blocked}/gate-fetch').then(() => 'sent', (e) => e.name + ': ' + e.message),
        noCors: await fetch('${blocked}/gate-no-cors', { mode: 'no-cors', method: 'POST', body: 'x' }).then(() => 'sent', (e) => e.name + ': ' + e.message),
        xhr: await xhrEvents('${blocked}/gate-xhr'),
        xhrSync: xhrSync('${blocked}/gate-xhr-sync'),
        webSocket: socket('${wss(blocked)}/gate-ws'),
        webSocketHttps: socket('${blocked}/gate-ws-https'),
    };
`;

const gateReports = async (sandbox: SandboxDriver) => {
    await sandbox.page.waitForTimeout(300);
    return (await sandbox.violations()).map(({ sandbox: _, ...report }) => report);
};

test.describe('a refused request: one outcome and one report on every engine, in every mode', () => {
    for (const mode of MODES) {
        test(`${mode} mode: fetch, a no-cors fetch, XMLHttpRequest (asynchronous and synchronous) and WebSocket to an origin connect-src does not list`, async ({ sandbox }) => {
            expect(await sandbox.mount({ mode, origins: { connect: [recorder.allowed, wss(recorder.allowed)] } })).toBe('ready');
            expect(await sandbox.inGuest(REFUSED(recorder.blocked))).toEqual({
                fetch: `TypeError: fetch() ${GATE}`,
                noCors: `TypeError: fetch() ${GATE}`,
                xhr: ['readystatechange:1', 'loadstart:1', 'readystatechange:4', 'error:4:0', 'loadend:4'],
                xhrSync: 'NetworkError 4',
                webSocket: socketRefusal(mode),
                webSocketHttps: socketRefusal(mode),
            });
            const source = mode === 'strict' ? { source: 'logic' } : {};
            expect(await gateReports(sandbox)).toEqual([
                `${recorder.blocked}/gate-fetch`, `${recorder.blocked}/gate-no-cors`, `${recorder.blocked}/gate-xhr`,
                `${recorder.blocked}/gate-xhr-sync`, `${wss(recorder.blocked)}/gate-ws`, `${wss(recorder.blocked)}/gate-ws-https`,
            ].map(blockedURI => ({ directive: 'connect-src', blockedURI, sourceFile: GATE_SOURCE_FILE, ...source })));
            await sandbox.page.waitForTimeout(500);
            expect(recorder.paths('blocked')).toEqual([]);
        });
    }
});

test.describe('an admitted request works as the platform\'s', () => {
    for (const mode of MODES) {
        const opens = mode !== 'strict';
        test(`${mode} mode: fetch, XMLHttpRequest${opens ? ' and a WebSocket' : ''} to the listed origin reach it, with no report${opens ? '' : '; a WebSocket to it is refused and reported, and its wss:// entry dropped with a warning'}`, async ({ sandbox, page }) => {
            const warnings: string[] = [];
            page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
            expect(await sandbox.mount({ mode, origins: { connect: [recorder.allowed, wss(recorder.allowed)] } })).toBe('ready');
            const dropped = `origins.connect entry "${wss(recorder.allowed)}" was dropped: strict mode opens no WebSocket`;
            expect(warnings.filter(text => text.includes(dropped)), mode).toHaveLength(opens ? 0 : 1);
            const outcome = await sandbox.inGuest(`
                const fetched = await fetch('${recorder.allowed}/ok-fetch').then((r) => r.status + ' ' + r.url, (e) => e.name);
                const xhr = await new Promise((resolve) => {
                    const x = new XMLHttpRequest();
                    x.onload = () => resolve(x.status + ' ' + x.responseText + ' ' + x.readyState);
                    x.onerror = () => resolve('error');
                    x.open('GET', '${recorder.allowed}/ok-xhr');
                    x.send();
                });
                const xhrSync = (() => { const x = new XMLHttpRequest(); x.open('GET', '${recorder.allowed}/ok-xhr-sync', false); x.send(); return x.status; })();
                const socket = await new Promise((resolve) => {
                    let s;
                    try { s = new WebSocket('${wss(recorder.allowed)}/ok-ws'); } catch (e) { resolve(e.name + ': ' + e.message); return; }
                    s.onopen = () => { resolve('open ' + (s instanceof WebSocket) + ' ' + s.url); s.close(); };
                    s.onerror = () => resolve('error');
                });
                return { fetched, xhr, xhrSync, socket };
            `);
            expect(outcome).toEqual({
                fetched: `200 ${recorder.allowed}/ok-fetch`,
                xhr: '200 ok 4',
                xhrSync: 200,
                socket: opens ? `open true ${wss(recorder.allowed)}/ok-ws` : socketRefusal(mode),
            });
            for (const path of ['/ok-fetch', '/ok-xhr', '/ok-xhr-sync', ...(opens ? ['/ok-ws'] : [])]) await recorder.waitFor('allowed', path);
            expect(await gateReports(sandbox)).toEqual(opens ? [] : [{ directive: 'connect-src', blockedURI: `${wss(recorder.allowed)}/ok-ws`, sourceFile: GATE_SOURCE_FILE, source: 'logic' }]);
            // strict mode: no handshake reached the listener, which the other modes' sockets reach (the positive control)
            if (!opens) expect(recorder.hits.filter(hit => hit.websocket)).toEqual([]);
        });
    }
});

test.describe('strict mode: a streamed fetch() response is read as it arrives (what replaces a socket)', () => {
    test('the first chunk of a response that never ends reaches the guest', async ({ sandbox }) => {
        expect(await sandbox.mount({ mode: 'strict', origins: { connect: [recorder.allowed] } })).toBe('ready');
        const outcome = await sandbox.inGuest(`
            const response = await fetch('${recorder.allowed}/slow');
            const reader = response.body.getReader();
            const first = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve('timed out'), 5000))]);
            if (first === 'timed out') return { first };
            await reader.cancel();
            return { status: response.status, done: first.done, text: new TextDecoder().decode(first.value) };
        `);
        // the listener sends one chunk and never ends the response (recorder.ts, /slow): what the guest read, it read
        // before the end, as it arrived
        expect(outcome).toEqual({ status: 200, done: false, text: 'first chunk; the rest never comes' });
        expect(recorder.hits.filter(hit => hit.path === '/slow').map(hit => hit.bytesSent)).toEqual([34]);
    });
});

test.describe('credentials: never on fetch() or XMLHttpRequest, on any engine', () => {
    const COOKIE = { name: 'ws_gate', value: '1', domain: '127.0.0.1', path: '/', secure: true, sameSite: 'None' as const };
    const credentialed = (origin: string, tag: string) => `
        await fetch('${origin}/cred-include?tag=${tag}', { credentials: 'include' }).catch(() => {});
        await fetch('${origin}/cred-no-cors?tag=${tag}', { mode: 'no-cors', credentials: 'include', method: 'POST', body: 'x' }).catch(() => {});
        await new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('GET', '${origin}/cred-xhr?tag=${tag}'); x.withCredentials = true; x.onloadend = resolve; x.send(); });
        await new Promise((resolve) => { let s; try { s = new WebSocket('${wss(origin)}/cred-ws?tag=${tag}'); } catch (e) { resolve(); return; } s.onopen = () => { s.close(); resolve(); }; s.onerror = resolve; });
    `;
    const cookiesOf = (tag: string) => Object.fromEntries(recorder.hits.filter(hit => hit.server === 'allowed' && hit.path.endsWith(`tag=${tag}`))
        .map(hit => [hit.path.slice(1, hit.path.indexOf('?')), String(hit.headers.cookie ?? '')]));

    test('every mode: a credentialed fetch, a no-cors one and an XMLHttpRequest with withCredentials carry no cookie; a WebSocket handshake carries what the engine sends (cookie-facts.ts), and strict mode makes none', async ({ sandbox, context, browserName }) => {
        await context.addCookies([COOKIE]);
        // positive control: a plain sandboxed frame of the host page's sends the cookie with a credentialed fetch
        await sandbox.page.evaluate((code) => {
            const frame = document.createElement('iframe');
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.srcdoc = `<script>(async () => { ${code} })()<\/script>`;
            document.body.appendChild(frame);
        }, credentialed(recorder.allowed, 'control'));
        await expect.poll(() => Object.keys(cookiesOf('control')).sort()).toEqual(['cred-include', 'cred-no-cors', 'cred-ws', 'cred-xhr']);
        expect(cookiesOf('control')['cred-include']).toContain('ws_gate=1');

        // ledger: cookies
        const handshake = (COOKIE_ENGINE_FACTS[browserName as CookieEngine].sends.crossSite as readonly string[]).includes('None');
        for (const mode of MODES) {
            expect(await sandbox.mount({ mode, origins: { connect: [recorder.allowed, wss(recorder.allowed)] } }), mode).toBe('ready');
            expect(await sandbox.inGuest(credentialed(recorder.allowed, mode) + `return 'sent';`), mode).toBe('sent');
            // strict mode: no handshake at all (STRICT_COOKIE_CARRIERS); the other modes' handshakes are its positive control
            const made = mode === 'strict' ? ['cred-include', 'cred-no-cors', 'cred-xhr'] : ['cred-include', 'cred-no-cors', 'cred-ws', 'cred-xhr'];
            await expect.poll(() => Object.keys(cookiesOf(mode)).sort(), mode).toEqual(made);
            const seen = cookiesOf(mode);
            expect({ include: seen['cred-include'], noCors: seen['cred-no-cors'], xhr: seen['cred-xhr'] }, mode).toEqual({ include: '', noCors: '', xhr: '' });
            // the handshake cannot be stripped: as the engine's cookie facts say (engine-specific, documented)
            if (mode !== 'strict') expect(seen['cred-ws']!.includes('ws_gate=1'), `${mode} WebSocket handshake`).toBe(handshake);
        }
        await sandbox.page.waitForTimeout(300);
        expect(Object.keys(cookiesOf('strict')), 'strict mode: no WebSocket handshake').not.toContain('cred-ws');
    });
});

test.describe('the originals cannot be recovered from the guest\'s realm', () => {
    // Every way to a request maker a guest might try: the global object and its prototypes, each prototype's
    // `constructor`, an instance's, a new global lookup through Function and indirect eval, and (cooperative) a frame the
    // guest creates. Each one found is then used against the blocked listener: none may reach it, and every attempt is
    // refused by the gate (one report each).
    const RECOVER = (blocked: string) => `
        const found = [];
        const add = (kind, how, value) => { if (typeof value === 'function') found.push([kind, how, value]); };
        const names = ['fetch', 'XMLHttpRequest', 'WebSocket'];
        let depth = 0;
        for (let o = globalThis; o; o = Object.getPrototypeOf(o), depth++) {
            for (const name of names) { const d = Object.getOwnPropertyDescriptor(o, name); if (d) add(name, 'chain ' + depth, d.value); }
        }
        add('XMLHttpRequest', 'prototype.constructor', XMLHttpRequest.prototype.constructor);
        add('XMLHttpRequest', 'instance', Object.getPrototypeOf(new XMLHttpRequest()).constructor);
        add('WebSocket', 'prototype.constructor', WebSocket.prototype.constructor);
        add('fetch', 'Function', Function('return fetch')());
        add('XMLHttpRequest', 'Function this', new Function('return this')().XMLHttpRequest);
        add('WebSocket', 'indirect eval', (0, eval)('WebSocket'));
        add('fetch', 'self', self.fetch);
        const frames = [];
        if (typeof document !== 'undefined') {
            for (const how of ['about:blank', 'srcdoc']) {
                const frame = document.createElement('iframe');
                if (how === 'srcdoc') frame.srcdoc = '<p>x</p>';
                document.body.append(frame);
                await new Promise((resolve) => setTimeout(resolve, 100));
                for (const name of names) {
                    try { add(name, how + ' frame', frame.contentWindow[name]); frames.push(how + ' ' + name + ' read'); } catch (e) { frames.push(how + ' ' + name + ' ' + e.name); }
                }
            }
        }
        const same = found.every(([kind, , value]) => value === globalThis[kind]);
        let attempt = 0;
        for (const [kind, , value] of found) {
            const url = '${blocked}/recover-' + attempt++;
            if (kind === 'fetch') await value.call(globalThis, url).catch(() => {});
            if (kind === 'XMLHttpRequest') { const x = new value(); x.open('GET', url); x.send(); }
            if (kind === 'WebSocket') { try { new value(url.replace('https:', 'wss:')); } catch (e) {} }
        }
        const open = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'open').value;
        const send = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send').value;
        const x = new XMLHttpRequest();
        open.call(x, 'GET', '${blocked}/recover-' + attempt++);
        send.call(x);
        return { attempts: attempt, same, frames, kinds: [...new Set(found.map(([kind]) => kind))].sort() };
    `;

    for (const mode of MODES) {
        test(`${mode} mode: through prototypes, constructor, Function and eval${mode === 'cooperative' ? ', and frames it creates' : ''}, the guest finds only the gated functions, and none of them reaches the blocked listener`, async ({ sandbox }) => {
            expect(await sandbox.mount({ mode, origins: { connect: [recorder.allowed] } })).toBe('ready');
            const result = await sandbox.inGuest(RECOVER(recorder.blocked));
            expect(result.same).toBe(true);
            expect(result.kinds).toEqual(['WebSocket', 'XMLHttpRequest', 'fetch']);
            // a frame the guest creates has an opaque origin of its own: cross-origin, so nothing of it is readable here
            expect(result.frames).toEqual(mode === 'cooperative' ? ['about:blank', 'srcdoc'].flatMap(how => ['fetch', 'XMLHttpRequest', 'WebSocket'].map(name => `${how} ${name} SecurityError`)) : []);
            await sandbox.page.waitForTimeout(800);
            expect(recorder.paths('blocked')).toEqual([]);
            const reports = (await sandbox.violations()).filter(v => v.sourceFile === GATE_SOURCE_FILE && v.blockedURI.includes('/recover-'));
            expect(reports).toHaveLength(result.attempts);
        });
    }
});
