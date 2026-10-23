import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type SandboxDriver } from './fixture';
import { useRecorder } from './recorder';

/**
 * The host site's cookies on a guest request (S74, class A; THREAT-MODEL, `INHERITED_CONTEXT.cookies`). Every wrapper
 * iframe is `credentialless`: Chromium loads it, and everything nested in it, with an empty, ephemeral cookie jar, so no
 * request of the sandbox carries a cookie. Firefox and WebKit ignore the attribute (their facts: cookie-facts.ts).
 *
 * Evidence is the listener's, outside the browser: the `Cookie` header of each request that reached it. Each test has
 * its positive control: the same requests from a plain sandboxed `srcdoc` frame that the host page makes itself (not
 * credentialless) do carry the cookie, so the absence in the sandbox's is the attribute's doing. Cookies are set in the
 * context's jar, as `SameSite=None; Secure` (the host page's `localhost` and the recorder's `127.0.0.1` are two sites).
 */

const recorder = useRecorder();

const COOKIES = ['ws_none'];
const cookiesFor = (domain: string) => COOKIES.map(name => ({ name, value: '1', domain, path: '/', secure: true, sameSite: 'None' as const }));

/** A listener on `localhost`, another port: the same site as the harness page (the scheme and the registrable domain). */
async function sameSiteListener() {
    const hits: { path: string; cookie: string | undefined }[] = [];
    const server = http.createServer((req, res) => {
        hits.push({ path: req.url ?? '', cookie: req.headers.cookie });
        const image = (req.url ?? '').includes('kind=img');
        res.writeHead(200, { 'content-type': image ? 'image/svg+xml' : 'text/plain', 'access-control-allow-origin': '*' });
        res.end(image ? '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="5"></svg>' : 'ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    return {
        origin,
        hits,
        stop: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
    };
}

/** The requests a guest makes in each way it can without a CORS answer: credentialed fetch, `no-cors` POST, an image. */
const requests = (origin: string, tag: string, withImage: boolean) => `
    const base = ${JSON.stringify(`${origin}/probe?tag=${tag}`)};
    await fetch(base + '&kind=include', { credentials: 'include' }).catch(() => {});
    await fetch(base + '&kind=nocors', { mode: 'no-cors', credentials: 'include', method: 'POST', body: 'x' }).catch(() => {});
    ${withImage ? "await new Promise(done => { const image = new Image(); image.onload = image.onerror = done; image.src = base + '&kind=img'; });" : ''}
    return 'sent';`;

/** The same requests from a plain sandboxed `srcdoc` frame of the host page's: the positive control. */
async function plainFrameRequests(sandbox: SandboxDriver, origin: string, tag: string) {
    await sandbox.page.evaluate(({ code }) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.srcdoc = `<script>(async () => { ${code} })()<\/script>`;
        document.body.appendChild(frame);
    }, { code: requests(origin, tag, true).replace('return \'sent\';', '') });
}

type Hit = { path: string; cookie: string | undefined };
const hitsOf = (hits: Hit[], tag: string) => hits.filter(hit => hit.path.includes(`tag=${tag}`));
const kinds = (hits: Hit[]) => hits.map(hit => /kind=(\w+)/.exec(hit.path)![1]).sort();
const ALL_KINDS = ['img', 'include', 'nocors'];

test('every mode: the wrapper iframe carries the credentialless attribute, and the sandbox is ready on this engine', async ({ sandbox, page, browserName }) => {
    for (const mode of ['strict', 'cooperative', 'worker'] as const) {
        expect(await sandbox.mount({ mode }), mode).toBe('ready');
        const attribute = await page.evaluate(() => {
            const frame = (document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!;
            return { present: frame.hasAttribute('credentialless'), reflected: 'credentialless' in frame ? (frame as any).credentialless : undefined };
        });
        expect(attribute.present, mode).toBe(true);
        // Chromium reflects it; Firefox and WebKit have no such property, and ignore the attribute
        // ledger: cookies
        expect(attribute.reflected, `${mode} on ${browserName}`).toBe(browserName === 'chromium' ? true : undefined);
    }
});

test.describe('Chromium: no request of the sandbox carries a cookie', () => {
    // ledger: cookies
    test.skip(({ browserName }) => browserName !== 'chromium', 'credentialless frames are a Chromium feature; the other engines are in cookie-facts.ts');

    test('a same-site origin is dropped in every mode, so nothing reaches it and no cookie of the host site can', async ({ sandbox, context }) => {
        const listener = await sameSiteListener();
        try {
            await context.addCookies(cookiesFor('localhost'));
            // positive control: a plain sandboxed frame of the host page's carries the cookie to the same listener
            await plainFrameRequests(sandbox, listener.origin, 'control');
            await expect.poll(() => kinds(hitsOf(listener.hits, 'control'))).toEqual(ALL_KINDS);
            for (const hit of hitsOf(listener.hits, 'control')) expect(hit.cookie, hit.path).toContain('ws_none=1');

            const origins = { connect: [listener.origin], images: [listener.origin] };
            for (const mode of ['strict', 'cooperative', 'worker'] as const) {
                expect(await sandbox.mount({ mode, origins }), mode).toBe('ready');
                expect(await sandbox.inGuest(requests(listener.origin, mode, mode === 'cooperative')), mode).toBe('sent');
                await sandbox.page.waitForTimeout(300);
                expect(hitsOf(listener.hits, mode), mode).toEqual([]);
            }
        } finally {
            await listener.stop();
        }
    });

    test('a cross-site listed origin gets none of its own cookies either, in strict, cooperative and worker mode', async ({ sandbox, context }) => {
        await context.addCookies(cookiesFor('127.0.0.1'));
        const origins = { connect: [recorder.allowed], images: [recorder.allowed] };
        const fetched = (tag: string) => recorder.hits.filter(hit => hit.server === 'allowed' && hit.path.includes(`tag=${tag}`));

        // positive control: a plain sandboxed frame of the host page's carries the cookie
        await plainFrameRequests(sandbox, recorder.allowed, 'control');
        await expect.poll(() => fetched('control').length).toBe(3);
        for (const hit of fetched('control')) expect(String(hit.headers.cookie), hit.path).toContain('ws_none=1');

        for (const mode of ['strict', 'cooperative', 'worker'] as const) {
            expect(await sandbox.mount({ mode, origins }), mode).toBe('ready');
            expect(await sandbox.inGuest(requests(recorder.allowed, mode, mode === 'cooperative')), mode).toBe('sent');
            const hits = fetched(mode);
            expect(hits.length, mode).toBe(mode === 'cooperative' ? 3 : 2);
            for (const hit of hits) expect(hit.headers.cookie, `${mode} ${hit.path}`).toBeUndefined();
        }
    });

    test('strict mode: an image the view renders from a cross-site listed origin carries no cookie', async ({ sandbox, context }) => {
        await context.addCookies(cookiesFor('127.0.0.1'));
        await sandbox.registerFiles({ 'main.js': `sandboxView.render('<img src="${recorder.allowed}/pixel.svg?tag=view" alt="">');` });
        expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', origins: { images: [recorder.allowed] } })).toBe('ready');
        await recorder.waitFor('allowed', '/pixel.svg?tag=view');
        const hit = recorder.hits.find(candidate => candidate.path.startsWith('/pixel.svg?tag=view'))!;
        expect(hit.headers.cookie).toBeUndefined();
        expect(hit.headers.referer).toBeUndefined();
    });

    test('a popup the guest opens with allow-popups has no opener: window.open() returns null, and the page opens', async ({ sandbox, context }) => {
        const popups: string[] = [];
        context.on('page', page => popups.push(page.url()));
        expect(await sandbox.mount({ mode: 'cooperative', unsafeCapabilities: ['allow-popups'] })).toBe('ready');
        const target = `${recorder.allowed}/popup?tag=popup`;
        expect(await sandbox.inGuest(`return { handle: window.open(${JSON.stringify(target)}) !== null }`)).toEqual({ handle: false });
        await recorder.waitFor('allowed', '/popup?tag=popup');
        await expect.poll(() => popups.length).toBe(1);
    });
});
