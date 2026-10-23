import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import { useRecorder, wss, type Recorder } from './recorder';
import { CONNECT_ENGINE_FACTS, type ConnectEngine } from '@src/lib/connect-facts';
import { DECOY_HOST, DECOY_URL } from '@src/lib/host-csp';
import { HOST_SOURCE_RULES } from '@src/lib/csp/host-connect';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';

/**
 * The library's connect lists mean the same on every engine (ADR-007; INHERITED_CONTEXT.cspFetch;
 * docs/API.md#host-page-policy, #origins). Two rules, both applied by the library itself because the engines differ
 * (CONNECT_ENGINE_FACTS, src/lib/connect-facts.ts):
 *  - the host page's `connect-src` narrows `origins.connect` and `fetchBridge.allow` before the guest's and the
 *    bridge's policies are written, whether the page sent it as a header or as a `<meta>`; the policy comes from
 *    `hostContentSecurityPolicy`, or is read once per page by one deliberate violation (host-csp.ts) that reaches
 *    neither the network nor the DNS;
 *  - a `wss://h` entry is kept only beside `https://h`, and the pair admits both `fetch()` and `WebSocket`.
 * Every test asserts the same outcome on all three engines, and has its positive control in the same file: the same
 * configuration on a page whose policy admits the origin reaches the listener.
 */

const recorder = useRecorder();

/** The host page's policy, as a header or as a `<meta>` (vite.config.ts, /__host-policy). */
type HostPolicy = { csp?: string; meta?: string };

async function openHost(page: Page, policy: HostPolicy = {}) {
    const query = new URLSearchParams();
    if (policy.csp) query.set('csp', policy.csp);
    if (policy.meta) query.set('meta', policy.meta);
    await page.goto(`${ORIGIN}/__host-policy?${query}`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
}

/** A console line of the read's decoy: its name, or the engine's own words for its refused port (Chromium's carries no name). */
const isDecoyLine = (text: string) => text.includes(DECOY_HOST) || /ERR_UNSAFE_PORT|restricted network port/.test(text);

/** What the page's console says, as it goes: the library's warnings, and every line of the read's decoy. */
function watch(page: Page) {
    const warnings: string[] = [];
    const decoyLines: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
        if (isDecoyLine(message.text())) decoyLines.push(message.text());
    });
    return { warnings, decoyLines };
}

/** The host page's own `securitypolicyviolation` events (an error tracker's listener), from before its scripts run. */
async function listenForHostViolations(page: Page) {
    await page.addInitScript(() => {
        if (window !== window.top) return;
        const seen: string[] = [];
        Object.defineProperty(window, 'hostViolations', { value: seen });
        document.addEventListener('securitypolicyviolation', (event) => { seen.push(`${event.violatedDirective} ${event.blockedURI}`); });
    });
}
const hostViolations = (page: Page) => page.evaluate(() => [...((window as any).hostViolations ?? [])] as string[]);

type Mode = 'strict' | 'cooperative';

/** Mounts `mode` with `connect` origins and the bridge's allowlist; the guest runs nothing of its own. */
async function mountConnect(sandbox: SandboxDriver, mode: Mode, extra: Record<string, unknown> = {}) {
    const config: Record<string, unknown> = { mode, scriptUnsafe: true, ...extra };
    if (mode === 'strict') {
        await sandbox.registerFiles({ 'main.js': 'void 0' });
        config.entry = 'main.js';
    } else {
        config.capabilities = ['allow-scripts'];
    }
    return sandbox.mount(config as any);
}

/** The `connect-src` of the guest's policy as built, read from the wrapper's document. */
async function guestConnectSrc(page: Page): Promise<string> {
    const srcdoc = await page.evaluate(() => (document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!.srcdoc);
    const found = /connect-src ([^;"]*)/.exec(srcdoc);
    expect(found, 'the wrapper carries the guest policy').not.toBeNull();
    // (a registered file adds blob: to connect-src, whatever is listed: the origins are the rest)
    const origins = found![1]!.split(' ').filter(source => source !== '' && source !== 'blob:').join(' ');
    return origins === '' ? "'none'" : origins;
}

/** The bridge frame's policy as built: its `connect-src`. */
async function bridgeConnectSrc(page: Page): Promise<string> {
    const srcdocs = await page.evaluate(() => [...(document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelectorAll('iframe')].map(frame => frame.srcdoc));
    expect(srcdocs.length, 'the wrapper and the bridge frame').toBe(2);
    const found = /connect-src ([^;"]*)/.exec(srcdocs[1]!);
    expect(found, 'the bridge frame carries its policy').not.toBeNull();
    return found![1]!.trim();
}

/** The guest's requests to `url`: a fetch(), a WebSocket on its wss:// form, and the bridge's sandboxFetch(), each settled. */
async function guestRequests(sandbox: SandboxDriver, url: string) {
    return sandbox.inGuest<{ fetch: string; socket: string; bridge: string }>(`
        const outcome = (promise) => promise.then(() => 'ok', (error) => String((error && error.code) || (error && error.name) || error));
        const socket = (target) => new Promise((resolve) => {
            let ws;
            try { ws = new WebSocket(target); } catch (error) { resolve('threw ' + error.name); return; }
            ws.onopen = () => { resolve('open'); ws.close(); };
            ws.onerror = () => resolve('error');
            setTimeout(() => resolve('timeout'), 4000);
        });
        return {
            fetch: await outcome(fetch(${JSON.stringify(`${url}/guest-fetch`)}, { cache: 'no-store' })),
            socket: await socket(${JSON.stringify(`${wss(url)}/guest-socket`)}),
            bridge: await outcome(sandboxFetch(${JSON.stringify(`${url}/guest-bridge`)})),
        };`);
}

/** Whether the engine logs a line for the decoy though the page's policy admits it (its refused port: CONNECT_ENGINE_FACTS). */
const logsWhenAdmitted = (browserName: string) => CONNECT_ENGINE_FACTS[browserName as ConnectEngine].decoyLogsWhenAdmitted;

const reached = (recorder: Recorder) => recorder.paths('allowed').map(path => path.split('?')[0]).sort();

for (const mode of ['strict', 'cooperative'] as const) {
    for (const delivery of ['header', 'meta'] as const) {
        const policy = (value: string): HostPolicy => (delivery === 'header' ? { csp: value } : { meta: value });

        test.describe(`${mode} mode, the host page's connect-src as a ${delivery}`, () => {
            test("connect-src 'self' drops the listed origins from the guest's policy and the bridge's, and nothing reaches the listener", async ({ sandbox, page }) => {
                const { warnings, decoyLines } = watch(page);
                await openHost(page, policy("connect-src 'self'"));
                expect(await mountConnect(sandbox, mode, { origins: { connect: [recorder.allowed, wss(recorder.allowed)] }, fetchBridge: { allow: [recorder.allowed] } })).toBe('ready');

                expect(await guestConnectSrc(page), 'the policy lists no origin').toBe("'none'");
                expect(await bridgeConnectSrc(page), "nor does the bridge's").toBe("'none'");
                expect(warnings.filter(text => text.startsWith('[Sandbox] origins.connect dropped')), 'one warning for the connect list').toHaveLength(1);
                expect(warnings.filter(text => text.startsWith('[Sandbox] fetchBridge.allow dropped')), 'and one for the bridge').toHaveLength(1);
                expect(decoyLines.length, 'the read caused its violation, on every engine').toBeGreaterThan(0);

                expect(await guestRequests(sandbox, recorder.allowed)).toEqual({ fetch: 'TypeError', socket: expect.stringMatching(/^(error|threw)/), bridge: 'FETCH_NOT_ALLOWED' });
                await page.waitForTimeout(300);
                expect(reached(recorder), 'nothing the guest tried reached the listener').toEqual([]);
                expect(await sandbox.state()).toBe('ready');
            });

            test('positive control: a policy that admits the origins keeps them, and the same requests arrive', async ({ sandbox, page }) => {
                const { warnings } = watch(page);
                await openHost(page, policy(`connect-src 'self' ${recorder.allowed} ${wss(recorder.allowed)}`));
                expect(await mountConnect(sandbox, mode, { origins: { connect: [recorder.allowed, wss(recorder.allowed)] }, fetchBridge: { allow: [recorder.allowed] } })).toBe('ready');

                expect(await guestConnectSrc(page)).toBe(`${recorder.allowed} ${wss(recorder.allowed)}`);
                expect(await bridgeConnectSrc(page)).toBe(recorder.allowed);
                expect(warnings.filter(text => /dropped/.test(text))).toEqual([]);
                expect(await guestRequests(sandbox, recorder.allowed)).toEqual({ fetch: 'ok', socket: 'open', bridge: 'ok' });
                expect(reached(recorder)).toEqual(['/guest-bridge', '/guest-fetch', '/guest-socket']);
            });
        });
    }
}

test.describe('what the host page sees of the read', () => {
    test('its own securitypolicyviolation listeners see nothing, the policy is read once per page, and a build with no connect origin reads nothing', async ({ sandbox, page }) => {
        const { decoyLines } = watch(page);
        await listenForHostViolations(page);
        await openHost(page, { csp: "connect-src 'self'" });

        expect(await mountConnect(sandbox, 'strict')).toBe('ready');
        await page.waitForTimeout(300);
        expect(decoyLines, 'a build that lists no connect origin and no bridge origin reads nothing').toEqual([]);

        expect(await mountConnect(sandbox, 'strict', { origins: { connect: [recorder.allowed] } })).toBe('ready');
        await page.waitForTimeout(300);
        const first = decoyLines.length;
        expect(first, 'the first build that lists one reads').toBeGreaterThan(0);
        expect(await hostViolations(page), "the page's own listener saw no violation: the read runs in a frame of the library's").toEqual([]);

        expect(await sandbox.reset()).toBe('ready');
        expect(await mountConnect(sandbox, 'strict', { origins: { connect: [recorder.allowed, 'https://127.0.0.1:9'] } })).toBe('ready');
        await page.waitForTimeout(300);
        expect(decoyLines.length, 'once per page load: later builds use what was read').toBe(first);
    });

    test('a page with no policy of its own: the read finds none, the origins stay, and no warning is said', async ({ sandbox, page, browserName }) => {
        const { warnings, decoyLines } = watch(page);
        await openHost(page);
        expect(await mountConnect(sandbox, 'strict', { origins: { connect: [recorder.allowed] }, fetchBridge: { allow: [recorder.allowed] } })).toBe('ready');
        expect(await guestConnectSrc(page)).toBe(recorder.allowed);
        expect(warnings.filter(text => /dropped|could not be read/.test(text))).toEqual([]);
        if (logsWhenAdmitted(browserName)) expect(decoyLines.length, `${browserName} logs the decoy's refused port though nothing refuses it`).toBeGreaterThan(0);
        else expect(decoyLines, 'a policy that refuses nothing causes no violation, and the engine logs nothing').toEqual([]);
    });
});

test.describe('hostContentSecurityPolicy overrides the read', () => {
    test("a string is used as it is: the page is not read, and a policy that names the origin keeps it though the page's own does not", async ({ sandbox, page }) => {
        const { warnings, decoyLines } = watch(page);
        await openHost(page, { csp: "connect-src 'self'" });
        expect(await mountConnect(sandbox, 'strict', { origins: { connect: [recorder.allowed] }, hostContentSecurityPolicy: `connect-src ${recorder.allowed}` })).toBe('ready');
        expect(await guestConnectSrc(page), 'the given policy admits it').toBe(recorder.allowed);
        expect(warnings.filter(text => /dropped/.test(text))).toEqual([]);
        expect(decoyLines, 'no read').toEqual([]);
    });

    test('a string that refuses the origin drops it on a page that has no policy; several policies are an intersection', async ({ sandbox, page }) => {
        const { warnings, decoyLines } = watch(page);
        await openHost(page);
        expect(await mountConnect(sandbox, 'strict', { origins: { connect: [recorder.allowed, 'https://other.example'] }, hostContentSecurityPolicy: `connect-src ${recorder.allowed} https://other.example, connect-src https://other.example` })).toBe('ready');
        expect(await guestConnectSrc(page)).toBe('https://other.example');
        expect(warnings.filter(text => text.startsWith('[Sandbox] origins.connect dropped'))).toEqual([expect.stringContaining(recorder.allowed)]);
        expect(decoyLines).toEqual([]);
    });

    test('false skips the narrowing and the read', async ({ sandbox, page }) => {
        const { warnings, decoyLines } = watch(page);
        await openHost(page, { csp: "connect-src 'self'" });
        expect(await mountConnect(sandbox, 'strict', { origins: { connect: [recorder.allowed] }, hostContentSecurityPolicy: false })).toBe('ready');
        expect(await guestConnectSrc(page), 'the library drops nothing').toBe(recorder.allowed);
        expect(warnings.filter(text => /dropped/.test(text))).toEqual([]);
        expect(decoyLines).toEqual([]);
    });

    test('a value that is neither is ignored with a warning, and the page is read', async ({ sandbox, page }) => {
        const { warnings, decoyLines } = watch(page);
        await openHost(page, { csp: "connect-src 'self'" });
        expect(await mountConnect(sandbox, 'strict', { origins: { connect: [recorder.allowed] }, hostContentSecurityPolicy: 5 })).toBe('ready');
        expect(warnings.filter(text => text.startsWith('[Sandbox] hostContentSecurityPolicy must be a string or false'))).toHaveLength(1);
        expect(await guestConnectSrc(page)).toBe("'none'");
        expect(decoyLines.length).toBeGreaterThan(0);
    });
});

// ---- what the parser keeps, every engine admits -----------------------------------------------------------------------

/**
 * The claim that makes the narrowing uniform: an origin the parser keeps is admitted by every engine, so the lists the
 * library writes mean the same in all of them (and one it drops is dropped everywhere, whatever the engine would have
 * done). Checked here against the engine itself, with the inherited policy left to the browser (`hostContentSecurityPolicy:
 * false`): for each policy of HOST_SOURCE_RULES' examples that admits an origin, the guest's request to it must raise no
 * violation of the page's policy. A violation is the browser's own verdict, whatever the network would have done with a
 * name that does not exist. The controls show the channel works, and that CONNECT_ENGINE_FACTS (which the docs render) is
 * what each engine does with the sources the parser does not take.
 */
test.describe('the parser keeps only what every engine admits', () => {
    const admitted = new Map<string, string[]>();
    for (const rule of HOST_SOURCE_RULES) {
        for (const [policy, origin, keeps] of rule.examples) {
            // (a policy with default-src would also refuse the harness page's own script)
            if (!keeps || !/^(https|wss):/.test(origin) || !policy.startsWith('connect-src') || /default-src|script-src/i.test(policy)) continue;
            admitted.set(policy, [...new Set([...(admitted.get(policy) ?? []), origin])]);
        }
    }

    /** The origins `requests` named, each requested from the guest, and the ones the page's policy raised a violation for. */
    async function refusedByThePage(sandbox: SandboxDriver, page: Page, policy: string, requests: string[]): Promise<string[]> {
        await openHost(page, { csp: policy });
        const listed = [...new Set(requests.flatMap(origin => (origin.startsWith('wss:') ? [origin, `https:${origin.slice(4)}`] : [origin])))];
        expect(await mountConnect(sandbox, 'cooperative', { origins: { connect: listed }, hostContentSecurityPolicy: false })).toBe('ready');
        await sandbox.clearViolations();
        await sandbox.inGuest(`
            const stop = new AbortController();
            for (const origin of ${JSON.stringify(requests)}) {
                if (origin.startsWith('wss:')) { try { const socket = new WebSocket(origin + '/x'); socket.onerror = () => {}; setTimeout(() => socket.close(), 50); } catch (error) {} }
                else fetch(origin + '/x', { cache: 'no-store', signal: stop.signal }).catch(() => {});
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
            stop.abort();
            return 1;`);
        const violations = await sandbox.violations();
        return requests.filter(origin => violations.some(violation => violation.blockedURI.startsWith(`${origin}/x`)));
    }

    test('every origin a policy of the grammar table admits raises no violation of the page\'s policy', async ({ sandbox, page, browserName }) => {
        test.setTimeout(240_000);
        const refused: string[] = [];
        for (const [policy, origins] of admitted) {
            for (const origin of await refusedByThePage(sandbox, page, policy, origins)) refused.push(`${browserName}: "${policy}" admitted ${origin}, the page's policy refused it`);
        }
        expect(admitted.size, 'the table has policies that admit').toBeGreaterThan(10);
        expect(refused).toEqual([]);
    });

    test("controls: the channel works, and CONNECT_ENGINE_FACTS is what each engine does with 'self' and with a host written without a scheme", async ({ sandbox, page, browserName }) => {
        const facts = CONNECT_ENGINE_FACTS[browserName as ConnectEngine];
        const named = ['https://a.example.test'];
        const other = ['https://b.example.test'];
        expect(await refusedByThePage(sandbox, page, 'connect-src https://a.example.test', other), `${browserName}: a source that names another host refuses this one`).toEqual(other);
        expect(await refusedByThePage(sandbox, page, 'connect-src https://a.example.test', named), `${browserName}: and admits the one it names`).toEqual([]);
        expect(await refusedByThePage(sandbox, page, "connect-src 'self'", other), `${browserName}: 'self' ${facts.selfAdmitsOtherOrigins ? 'admits' : 'refuses'} an origin it does not name`).toEqual(facts.selfAdmitsOtherOrigins ? [] : other);
        const bare = await refusedByThePage(sandbox, page, 'connect-src a.example.test', named);
        expect(bare, `${browserName}: a host without a scheme ${facts.bareHostAdmitted === 'no' ? 'refuses' : 'admits'} the origin it names`).toEqual(facts.bareHostAdmitted === 'no' ? named : []);
        const withPort = await refusedByThePage(sandbox, page, 'connect-src a.example.test:8443', ['https://a.example.test:8443']);
        expect(withPort, `${browserName}: and with a port written, ${facts.bareHostAdmitted === 'yes' ? 'admits' : 'refuses'} it`).toEqual(facts.bareHostAdmitted === 'yes' ? [] : ['https://a.example.test:8443']);
        const upgraded = await refusedByThePage(sandbox, page, 'connect-src http://a.example.test:8443', ['https://a.example.test:8443']);
        expect(upgraded, `${browserName}: http://h:P ${facts.upgradedSchemeWithPort ? 'admits' : 'refuses'} https://h:P`).toEqual(facts.upgradedSchemeWithPort ? [] : ['https://a.example.test:8443']);
    });
});

// ---- the read reaches neither the network nor the DNS ------------------------------------------------------------------

/**
 * A proxy that logs every connection the browser asks for outside loopback and refuses it. A browser resolves a name
 * itself only for a request it sends directly; through a proxy the name is the proxy's to resolve, so a decoy request
 * that was attempted at all shows here by name (`CONNECT name:port`), and one that never left the browser's own checks
 * shows nothing, on every engine. (The resolver itself was watched in the research, with a private resolver: no query for
 * the decoy name on any engine. That setup needs a mount namespace, so it is not repeated here.)
 */
async function loggingProxy(): Promise<{ server: Server; hits: string[]; url: string }> {
    const hits: string[] = [];
    const server = createServer((request, response) => {
        hits.push(`http ${request.url}`);
        response.writeHead(502).end();
    });
    server.on('connect', (request, socket) => {
        hits.push(`connect ${request.url}`);
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const proxied = test.extend<{ logging: { hits: string[]; url: string } }>({
    logging: async ({}, use) => {
        const { server, hits, url } = await loggingProxy();
        await use({ hits, url });
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    },
    // the context the page and the sandbox fixture run in goes through the proxy; loopback (the test server) does not
    context: async ({ browser, logging }, use) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true, proxy: { server: logging.url, bypass: 'localhost,127.0.0.1' } });
        await use(context);
        await context.close();
    },
});

proxied.describe('the read of the page\'s policy', () => {
    proxied('causes no request and no DNS lookup: the decoy never reaches the proxy, on a page that refuses it and on one that admits it', async ({ sandbox, page, logging, browserName }) => {
        const { decoyLines } = watch(page);
        // positive control: the proxy sees what leaves the browser for another host
        await openHost(page);
        await page.evaluate(() => fetch('https://control.invalid/x').catch(() => {}));
        await expect.poll(() => logging.hits.filter(hit => hit.includes('control.invalid'))).not.toEqual([]);

        logging.hits.length = 0;
        expect(await mountConnect(sandbox, 'strict', { origins: { connect: ['https://api.example'] }, fetchBridge: { allow: ['https://api.example'] } })).toBe('ready');
        await page.waitForTimeout(500);
        if (!logsWhenAdmitted(browserName)) expect(decoyLines, 'a page with no policy: nothing refused the decoy').toEqual([]);
        const admitted = decoyLines.length;
        expect(logging.hits.filter(hit => hit.includes(DECOY_HOST)), 'the decoy never reached the proxy (a page that admits it)').toEqual([]);

        await openHost(page, { csp: "connect-src 'self'" });
        logging.hits.length = 0;
        expect(await mountConnect(sandbox, 'strict', { origins: { connect: ['https://api.example'] }, fetchBridge: { allow: ['https://api.example'] } })).toBe('ready');
        await page.waitForTimeout(500);
        expect(decoyLines.length, 'the policy refused the decoy, so the read happened').toBeGreaterThan(admitted);
        expect(logging.hits.filter(hit => hit.includes(DECOY_HOST)), 'the decoy never reached the proxy (a page that refuses it)').toEqual([]);
        expect(logging.hits.filter(hit => hit.includes('invalid')), 'and nothing else left for a host of that name').toEqual([]);
    });
});

/**
 * The decoy is plain http so that it also sees a policy that admits https only (`connect-src https:`). On an https page it
 * is mixed content, and the read needs the page's policy to be checked first: here an https page (a route answers for a name
 * that never reaches the network) runs the read's own steps by hand, in a frame like the element's, on every engine.
 */
test.describe('the decoy on an https page', () => {
    for (const [policy, refused] of [["connect-src 'self'", true], ['connect-src https:', true], ['connect-src http:', false], ['connect-src *', false], ['', false]] as const) {
        test(`${policy || 'no policy'}: the page's policy is checked before mixed content, so the decoy ${refused ? 'reports it' : 'reports nothing'}`, async ({ page }) => {
            await page.route('https://secure.test/**', (route) => route.fulfill({
                status: 200, contentType: 'text/html', headers: policy ? { 'content-security-policy': policy } : {}, body: '<!doctype html><title>t</title><body>x</body>',
            }));
            await page.goto('https://secure.test/');
            const texts = await page.evaluate(async (decoy) => {
                const frame = document.createElement('iframe');
                frame.hidden = true;
                const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
                document.body.append(frame);
                await loaded;
                const seen: string[] = [];
                frame.contentDocument!.addEventListener('securitypolicyviolation', (event) => { seen.push((event as SecurityPolicyViolationEvent).originalPolicy); });
                await (frame.contentWindow as Window & typeof globalThis).fetch(decoy, { cache: 'no-store' }).catch(() => {});
                await new Promise((resolve) => setTimeout(resolve, 100));
                frame.remove();
                return seen;
            }, DECOY_URL);
            expect(texts).toEqual(refused ? [policy] : []);
        });
    }
});

// ---- scheme widening ---------------------------------------------------------------------------------------------------

test.describe('a wss:// entry needs its https:// twin, and the pair admits both on every engine', () => {
    for (const mode of ['strict', 'cooperative'] as const) {
        test(`${mode} mode: wss:// alone is dropped with a warning, https:// alone admits fetch() only, the pair admits both`, async ({ sandbox, page }) => {
            const { warnings } = watch(page);
            await openHost(page);

            // wss alone: dropped, so neither a fetch() nor a socket arrives (on WebKit a wss:// source alone would have admitted the fetch())
            expect(await mountConnect(sandbox, mode, { origins: { connect: [wss(recorder.allowed)] } })).toBe('ready');
            expect(warnings.filter(text => text.startsWith('[Sandbox] origins.connect entry') && text.includes('needs')), 'the warning names the twin').toEqual([expect.stringContaining(`"${recorder.allowed}"`)]);
            expect(await guestConnectSrc(page)).toBe("'none'");
            expect(await guestRequests(sandbox, recorder.allowed)).toMatchObject({ fetch: 'TypeError', socket: expect.stringMatching(/^(error|threw)/) });
            await page.waitForTimeout(200);
            expect(reached(recorder), 'wss:// alone admitted nothing').toEqual([]);

            // https alone: the fetch() arrives, the socket does not
            expect(await mountConnect(sandbox, mode, { origins: { connect: [recorder.allowed] } })).toBe('ready');
            expect(await guestRequests(sandbox, recorder.allowed)).toMatchObject({ fetch: 'ok', socket: expect.stringMatching(/^(error|threw)/) });
            await page.waitForTimeout(200);
            expect(reached(recorder), 'https:// alone admits the fetch() and no socket').toEqual(['/guest-fetch']);

            // the pair: both
            recorder.clear();
            expect(await mountConnect(sandbox, mode, { origins: { connect: [recorder.allowed, wss(recorder.allowed)] } })).toBe('ready');
            expect(await guestRequests(sandbox, recorder.allowed)).toMatchObject({ fetch: 'ok', socket: 'open' });
            expect(reached(recorder), 'the pair admits both').toEqual(['/guest-fetch', '/guest-socket']);
            expect(recorder.hits.find(hit => hit.path.startsWith('/guest-socket'))?.websocket).toBe(true);
        });
    }

    test('the engine facts the rule rests on name every engine the suite runs on', () => {
        expect(Object.keys(CONNECT_ENGINE_FACTS)).toEqual(['chromium', 'firefox', 'webkit']);
    });
});
