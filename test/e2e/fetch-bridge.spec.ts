import { test, expect, ORIGIN } from './fixture';
import { useRecorder, wss } from './recorder';

/**
 * The host-mediated fetch bridge (backlog B5, ADR-006): sandboxFetch() in the guest, made by the host under
 * the bridge discipline (src/lib/fetch-bridge.ts), reported as a 'fetch' event.
 *
 * Evidence (backlog T5): the guest's own outcome (a refusal's code, asserted from inside the guest), the
 * host's 'fetch' event, and the two listeners outside the browser (recorder.ts): ALLOWED is listed in
 * fetchBridge.allow, BLOCKED never is unless a positive control lists it. Every refusal below has a positive
 * control showing that the same request, permitted, does reach a listener. Both listeners are on loopback
 * (127.0.0.1), so every request to them is also the "loopback only when listed" case.
 */

const recorder = useRecorder();

const MiB = 1024 * 1024;

// Runs a sandboxFetch() call in the guest and settles to what the guest saw: the response's status, text and
// url, or the refusal's code and message.
const fetchInGuest = (url: string, init: string = 'undefined') => `
    try {
        const response = await sandboxFetch(${JSON.stringify(url)}, ${init});
        return { status: response.status, text: await response.text(), url: response.url, ok: response.ok };
    } catch (e) {
        return { code: e && e.code, message: String(e && e.message), isError: e instanceof Error };
    }`;

const bridgeTo = (...allow: string[]) => ({ fetchBridge: { allow } });

test('an allowlisted origin is reached, its response handed to the guest whole, and the request is logged', async ({ sandbox }) => {
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');

    const result = await sandbox.inGuest(`
        const response = await sandboxFetch('${recorder.allowed}/echo?x=1#fragment', { method: 'post', headers: { 'content-type': 'text/plain' }, body: 'hello' });
        return { status: response.status, url: response.url, header: response.headers.get('x-recorder'), echo: await response.json(), isResponse: response instanceof Response };
    `);

    expect(result.status).toBe(200);
    expect(result.isResponse).toBe(true);
    expect(result.url).toBe(`${recorder.allowed}/echo?x=1`);
    expect(result.header).toBe('echo');
    expect(result.echo.method).toBe('POST');
    expect(result.echo.body).toBe('hello');
    expect(recorder.paths('allowed')).toEqual(['/echo?x=1']);
    const record = await sandbox.waitForFetch(`${recorder.allowed}/echo`);
    expect(record).toMatchObject({ sandbox: 'main', method: 'POST', url: `${recorder.allowed}/echo?x=1`, outcome: 'ok', status: 200 });
    expect(record.bytes).toBeGreaterThan(0);
    expect(record.code).toBeUndefined();
});

test("a cookie set on the harness origin never reaches it through the bridge, though the host page's own request carries it", async ({ sandbox, page }) => {
    await page.evaluate(() => { document.cookie = 'harness_secret=h1; path=/'; });
    expect(await sandbox.mount(bridgeTo(ORIGIN))).toBe('ready');

    const bridged = await sandbox.inGuest(`return (await sandboxFetch('${ORIGIN}/__echo?bridged')).json()`);
    expect(bridged.headers.cookie).toBeUndefined();
    expect(bridged.headers.referer).toBeUndefined();

    // positive control: the same request from the host page (credentials 'same-origin', the default) carries it
    const own = await page.evaluate(async (url) => (await fetch(url)).json(), `${ORIGIN}/__echo?own`);
    expect(String(own.headers.cookie)).toContain('harness_secret=h1');
});

test('the request carries no credentials and no referrer; the target sees the host origin, never its URL', async ({ sandbox, context, page }) => {
    // A cookie for the listener's host, which a credentialed request there would carry, and one on the harness origin.
    await context.addCookies([{ name: 'listener_secret', value: 'l1', domain: '127.0.0.1', path: '/', secure: true, sameSite: 'None' }]);
    await page.evaluate(() => { document.cookie = 'harness_secret=h1; path=/'; });
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');

    const echo = await sandbox.inGuest(`return (await sandboxFetch('${recorder.allowed}/echo')).json()`);

    const hit = recorder.hits.find(h => h.server === 'allowed' && h.path === '/echo')!;
    for (const headers of [hit.headers, echo.headers]) {
        expect(headers.cookie).toBeUndefined();
        expect(headers.authorization).toBeUndefined();
        expect(headers.referer).toBeUndefined();
        expect(headers.origin).toBe(ORIGIN);
    }

    // positive control: the cookie is in the jar and goes where credentials apply (a first-party navigation)
    const control = await context.newPage();
    await control.goto(`${recorder.allowed}/cookie-control`);
    await control.close();
    const controlHit = recorder.hits.find(h => h.server === 'allowed' && h.path === '/cookie-control')!;
    expect(String(controlHit.headers.cookie)).toContain('listener_secret=l1');
});

test('an origin not in the allowlist is refused before any request, with FETCH_NOT_ALLOWED', async ({ sandbox }) => {
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');

    const refused = await sandbox.inGuest(fetchInGuest(`${recorder.blocked}/not-allowed`));

    expect(refused).toMatchObject({ code: 'FETCH_NOT_ALLOWED', isError: true });
    expect((await sandbox.waitForFetch(`${recorder.blocked}/not-allowed`))).toMatchObject({ outcome: 'refused', code: 'FETCH_NOT_ALLOWED', method: 'GET', bytes: 0 });
    await sandbox.page.waitForTimeout(300);
    expect(recorder.paths('blocked')).toEqual([]);

    // positive control: the same request reaches that listener once its origin is listed
    expect(await sandbox.mount(bridgeTo(recorder.blocked))).toBe('ready');
    expect(await sandbox.inGuest(fetchInGuest(`${recorder.blocked}/not-allowed`))).toMatchObject({ status: 200, text: 'ok' });
    expect(recorder.paths('blocked')).toEqual(['/not-allowed']);
});

test('loopback, private and localhost names are refused unless listed: every spelling of the blocked listener', async ({ sandbox }) => {
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');
    const port = new URL(recorder.blocked).port;
    const spellings = [
        `https://localhost:${port}/a`, `https://sub.localhost:${port}/b`, `https://[::1]:${port}/c`,
        `https://[::ffff:127.0.0.1]:${port}/d`, `https://2130706433:${port}/e`, `https://0x7f.1:${port}/f`, `https://127.1:${port}/g`,
    ];

    for (const url of spellings) {
        const refused = await sandbox.inGuest(fetchInGuest(url));
        expect(refused.code, url).toBe('FETCH_NOT_ALLOWED');
        // one text to the guest for every unlisted origin (broad review CB6); the host's record says why
        expect(refused.message, url).toMatch(/ is not in fetchBridge\.allow$/);
        expect(refused.message, url).not.toContain('private');
        expect((await sandbox.waitForFetch(new URL(url).origin)).reason, url).toContain('loopback, private or link-local');
    }
    await sandbox.page.waitForTimeout(300);
    expect(recorder.paths('blocked')).toEqual([]);
    // positive control: the listed loopback origin works (the first test), and so does this one when listed
    expect(await sandbox.mount(bridgeTo(recorder.allowed, `https://127.0.0.1:${port}`))).toBe('ready');
    expect(await sandbox.inGuest(fetchInGuest(`https://127.1:${port}/listed`))).toMatchObject({ status: 200 });
    expect(recorder.paths('blocked')).toEqual(['/listed']);
});

test("the host page's own origin is refused unless listed", async ({ sandbox }) => {
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');
    const harness = `${ORIGIN}/test/e2e/harness.html`;

    const refused = await sandbox.inGuest(fetchInGuest(harness));
    expect(refused.code).toBe('FETCH_NOT_ALLOWED');
    // the guest is told what it is told for any unlisted origin (broad review CB6): nothing says which origin embeds it
    expect(refused.message).toBe(`[sandboxFetch] FETCH_NOT_ALLOWED: ${ORIGIN} is not in fetchBridge.allow`);
    expect((await sandbox.waitForFetch(harness)).reason).toContain("host page's own origin");

    // positive control: listed, the same request succeeds (a plain-http origin, listed exactly)
    expect(await sandbox.mount(bridgeTo(ORIGIN))).toBe('ready');
    const listed = await sandbox.inGuest(fetchInGuest(harness));
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('Sandbox e2e harness');
});

test('a redirect from an allowlisted origin to another is refused with FETCH_REDIRECT, and the other origin records nothing', async ({ sandbox, page }) => {
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');
    const redirect = `${recorder.allowed}/redirect?to=${encodeURIComponent(`${recorder.blocked}/after-redirect`)}`;

    expect(await sandbox.inGuest(fetchInGuest(redirect))).toMatchObject({ code: 'FETCH_REDIRECT' });
    expect(await sandbox.waitForFetch(`${recorder.allowed}/redirect`)).toMatchObject({ outcome: 'failed', code: 'FETCH_REDIRECT' });
    expect(recorder.paths('allowed')).toEqual([redirect.slice(recorder.allowed.length)]);
    await page.waitForTimeout(500);
    expect(recorder.paths('blocked')).toEqual([]);

    // positive control: a fetch from the host page that follows redirects does reach the other origin
    await page.evaluate((url) => fetch(url, { mode: 'no-cors' }).catch(() => {}), redirect);
    await recorder.waitFor('blocked', '/after-redirect');
});

test('a response body over maxBytes is refused with FETCH_TOO_LARGE: by its Content-Length unread, or once the bytes read pass the cap, closing the upstream connection', async ({ sandbox }) => {
    const maxBytes = 64 * 1024;
    expect(await sandbox.mount({ fetchBridge: { allow: [recorder.allowed], maxBytes } })).toBe('ready');

    // positive control: a body under the cap arrives whole
    const small = await sandbox.inGuest(`const r = await sandboxFetch('${recorder.allowed}/stream?bytes=60000'); return (await r.arrayBuffer()).byteLength;`);
    expect(small).toBe(60000);

    // declared too large: refused before reading anything
    expect(await sandbox.inGuest(fetchInGuest(`${recorder.allowed}/declared?bytes=${10 * MiB}`))).toMatchObject({ code: 'FETCH_TOO_LARGE' });
    expect(await sandbox.waitForFetch(`${recorder.allowed}/declared`)).toMatchObject({ outcome: 'failed', code: 'FETCH_TOO_LARGE', status: 200, bytes: 0 });

    // undeclared: read until the cap is passed, then the stream is cancelled and the request aborted
    expect(await sandbox.inGuest(fetchInGuest(`${recorder.allowed}/stream?bytes=${10 * MiB}`))).toMatchObject({ code: 'FETCH_TOO_LARGE' });
    const record = await sandbox.waitForFetch(`${recorder.allowed}/stream?bytes=${10 * MiB}`);
    expect(record).toMatchObject({ outcome: 'failed', code: 'FETCH_TOO_LARGE' });
    expect(record.bytes).toBeGreaterThan(maxBytes);
    // one chunk past the cap; engines deliver chunks of up to about 0.5 MiB (measured 48 KiB to 520 KiB)
    expect(record.bytes).toBeLessThanOrEqual(maxBytes + MiB);
    // upstream: both streamed responses were cut off long before their 10 MiB
    for (const path of ['/declared', '/stream?bytes=10']) {
        const hit = () => recorder.hits.find(h => h.server === 'allowed' && h.path.startsWith(path))!;
        await expect.poll(() => hit().closedEarly, { message: path }).toBe(true);
        expect(hit().bytesSent!).toBeLessThan(10 * MiB);
    }
});

test('reset() during a slow response aborts the upstream request: the listener sees the connection closed', async ({ sandbox, page }) => {
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');
    await sandbox.run(`sandboxFetch('${recorder.allowed}/slow').then(() => console.log('SLOW settled'), () => console.log('SLOW settled'))`);
    await recorder.waitFor('allowed', '/slow');
    const slow = () => recorder.hits.find(h => h.server === 'allowed' && h.path === '/slow')!;

    // control: left alone, the connection stays open
    await page.waitForTimeout(700);
    expect(slow().closedEarly).toBe(false);

    expect(await sandbox.reset()).toBe('ready');
    await expect.poll(() => slow().closedEarly).toBe(true);
    expect(await sandbox.waitForFetch(`${recorder.allowed}/slow`)).toMatchObject({ outcome: 'aborted', code: 'FETCH_FAILED' });
    expect((await sandbox.logs()).filter(l => l.startsWith('SLOW'))).toEqual([]); // the old guest is gone
});

test('a request that outlives timeoutMs is refused with FETCH_TIMEOUT and torn down upstream', async ({ sandbox }) => {
    expect(await sandbox.mount({ fetchBridge: { allow: [recorder.allowed], timeoutMs: 500 } })).toBe('ready');

    const started = Date.now();
    expect(await sandbox.inGuest(fetchInGuest(`${recorder.allowed}/slow`))).toMatchObject({ code: 'FETCH_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await sandbox.waitForFetch(`${recorder.allowed}/slow`)).toMatchObject({ outcome: 'failed', code: 'FETCH_TIMEOUT', status: 200 });
    await expect.poll(() => recorder.hits.find(h => h.server === 'allowed' && h.path === '/slow')?.closedEarly).toBe(true);
});

test('methods and request headers come from allowlists: no Cookie, no Authorization unless configured', async ({ sandbox }) => {
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');

    const refusals = await sandbox.inGuest(`
        const codes = {};
        for (const [name, init] of [
            ['put', { method: 'PUT', body: 'x' }],
            ['bogus method', { method: 'G E T' }],
            ['cookie', { headers: { cookie: 'a=b' } }],
            ['authorization', { headers: { authorization: 'Bearer t' } }],
            ['custom header', { headers: { 'x-api-key': 'k' } }],
            ['get with body', { method: 'GET', body: 'x' }],
            ['blob body', { method: 'POST', body: new Blob(['x']) }],
        ]) {
            try { await sandboxFetch('${recorder.allowed}/echo?case=' + encodeURIComponent(name), init); codes[name] = 'resolved'; }
            catch (e) { codes[name] = e.code || e.name; }
        }
        return codes;
    `);
    expect(refusals).toEqual({
        'put': 'FETCH_NOT_ALLOWED', 'bogus method': 'FETCH_NOT_ALLOWED', 'cookie': 'FETCH_NOT_ALLOWED',
        'authorization': 'FETCH_NOT_ALLOWED', 'custom header': 'FETCH_NOT_ALLOWED', 'get with body': 'FETCH_NOT_ALLOWED',
        'blob body': 'TypeError', // refused by sandboxFetch itself, in the guest
    });
    await sandbox.page.waitForTimeout(300);
    expect(recorder.paths('allowed')).toEqual([]);
    const reported = (await sandbox.fetches()).find(r => r.url.includes('bogus'))!;
    expect(reported.method).toBe(''); // a guest-supplied method that is not a method is not reported as one

    // positive control: configured, the method and the header go through
    expect(await sandbox.mount({ fetchBridge: { allow: [recorder.allowed], methods: ['GET', 'PUT'], headers: ['Authorization', 'cookie'] } })).toBe('ready');
    const echo = await sandbox.inGuest(`return (await sandboxFetch('${recorder.allowed}/echo', { method: 'PUT', body: 'x', headers: { authorization: 'Bearer t' } })).json()`);
    expect(echo.method).toBe('PUT');
    expect(echo.headers.authorization).toBe('Bearer t');
});

test('the guest policy is unchanged: with the bridge on, a direct fetch and WebSocket to the same origin are refused by CSP', async ({ sandbox }) => {
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');

    const direct = await sandbox.inGuest(`
        const fetched = await fetch('${recorder.allowed}/direct').then(() => 'loaded', () => 'refused');
        const socket = await new Promise(resolve => {
            try {
                const ws = new WebSocket('${wss(recorder.allowed)}/direct-ws');
                ws.onopen = () => resolve('open');
                ws.onerror = () => resolve('refused');
            } catch (e) { resolve('refused'); }
        });
        const bridged = (await sandboxFetch('${recorder.allowed}/bridged')).status;
        return { fetched, socket, bridged };
    `);

    expect(direct).toEqual({ fetched: 'refused', socket: 'refused', bridged: 200 });
    expect(await sandbox.waitForViolation('connect-src', `${recorder.allowed}/direct`)).toBeTruthy();
    expect(await sandbox.waitForViolation('connect-src', `${wss(recorder.allowed)}/direct-ws`)).toBeTruthy();
    expect(recorder.paths('allowed')).toEqual(['/bridged']);
});

test('off by default: no sandboxFetch, and calling the reserved method directly is refused without a request', async ({ sandbox }) => {
    expect(await sandbox.mount()).toBe('ready');

    expect(await sandbox.inGuest(`return typeof sandboxFetch`)).toBe('undefined');
    const outcome = await sandbox.guestOutcome(`bridge.call('sandbox:fetch', { url: '${recorder.blocked}/direct-call' })`);
    expect(outcome).toMatchObject({ status: 'rejected', code: 'FETCH_NOT_ALLOWED' });
    await sandbox.page.waitForTimeout(300);
    expect(recorder.paths('blocked')).toEqual([]);
    expect(await sandbox.fetches()).toEqual([]);
});

test('the reserved name cannot be taken: expose() refuses it on the host and in the guest, and the bridge keeps working', async ({ sandbox, page }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning' && m.text().includes('reserved')) warnings.push(m.text()); });
    await sandbox.exposeHost('sandbox:fetch', '() => ({ status: 200, statusText: "", headers: [], body: new Uint8Array(0), url: "forged" })');
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');
    await sandbox.exposeGuest('sandbox:fetch', '() => "guest"');

    expect(await sandbox.inGuest(fetchInGuest(`${recorder.blocked}/taken`))).toMatchObject({ code: 'FETCH_NOT_ALLOWED' });
    expect(await sandbox.inGuest(fetchInGuest(`${recorder.allowed}/still-bridged`))).toMatchObject({ status: 200, text: 'ok' });
    expect(await sandbox.callOutcome('sandbox:fetch')).toMatchObject({ status: 'rejected', code: 'UNKNOWN_METHOD' });
    expect(warnings).toHaveLength(1);
});

test('at most maxConcurrent requests are in flight; one more is refused with FETCH_BUSY', async ({ sandbox }) => {
    expect(await sandbox.mount({ fetchBridge: { allow: [recorder.allowed], maxConcurrent: 2 } })).toBe('ready');
    await sandbox.run(`for (let i = 0; i < 2; i++) sandboxFetch('${recorder.allowed}/slow').catch(() => {})`);
    await expect.poll(() => recorder.paths('allowed').length).toBe(2);

    expect(await sandbox.inGuest(fetchInGuest(`${recorder.allowed}/third`))).toMatchObject({ code: 'FETCH_BUSY' });
    expect(recorder.paths('allowed')).toEqual(['/slow', '/slow']);
    expect(await sandbox.reset()).toBe('ready'); // ends the two slow requests
});

test('guest-supplied fields are validated before they are reported', async ({ sandbox }) => {
    expect(await sandbox.mount(bridgeTo(recorder.allowed))).toBe('ready');

    await sandbox.inGuest(`
        for (const request of [{ url: 'x'.repeat(5000) }, { url: 42, method: 7 }, null, 'https://a.test/']) {
            await bridge.call('sandbox:fetch', request).catch(() => {});
        }
        return true;
    `);
    const records = await sandbox.fetches();
    expect(records.map(r => r.outcome)).toEqual(['refused', 'refused', 'refused', 'refused']);
    expect(records[0]!.url).toHaveLength(2048);
    expect(records.slice(1).map(r => [r.url, r.method])).toEqual([['', ''], ['', 'GET'], ['', 'GET']]);
});

test('worker mode: sandboxFetch reaches an allowlisted origin and refuses the rest', async ({ sandbox }) => {
    expect(await sandbox.mount({ mode: 'worker', ...bridgeTo(recorder.allowed) })).toBe('ready');

    expect(await sandbox.inGuest(fetchInGuest(`${recorder.allowed}/from-worker`))).toMatchObject({ status: 200, text: 'ok' });
    expect(await sandbox.inGuest(fetchInGuest(`${recorder.blocked}/from-worker`))).toMatchObject({ code: 'FETCH_NOT_ALLOWED' });
    expect(recorder.paths('allowed')).toEqual(['/from-worker']);
    expect(recorder.paths('blocked')).toEqual([]);
});
