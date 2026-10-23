import { test, expect, ORIGIN, type SandboxDriver } from './fixture';

/**
 * The cookie-domain probe in each engine (S74, class A; src/lib/host-site.ts). The registrable domain of the host page
 * is the browser's to say: the probe sets a test cookie with `Domain=` each parent of the host name and keeps the first
 * the browser accepts, so the library bundles no public-suffix list. This spec runs the library's own module (the dev
 * server's build of it, evaluated in the page as a module) in a page at each host name below, served by routing, and
 * checks the three engines' public-suffix handling against what the library needs: an ordinary name, a multi-label
 * suffix (`co.uk`) and a private-section suffix (`github.io`).
 *
 * The probe leaves nothing behind: the page's cookie jar is empty afterwards.
 */

test.use({ ignoreHTTPSErrors: true });

const CASES: ReadonlyArray<[host: string, registrable: string]> = [
    ['app.example.com', 'example.com'],
    ['example.com', 'example.com'],
    ['a.b.c.example.com', 'example.com'],
    ['www.example.co.uk', 'example.co.uk'],
    ['example.co.uk', 'example.co.uk'],
    ['user.github.io', 'user.github.io'],
    ['deep.user.github.io', 'user.github.io'],
    ['app.example.test', 'example.test'],
];

async function moduleSource(): Promise<string> {
    const response = await fetch(`${ORIGIN}/src/lib/host-site.ts`);
    expect(response.status).toBe(200);
    const source = await response.text();
    expect(source, 'the module is self-contained (no import)').not.toMatch(/^\s*import\s/m);
    return source;
}

for (const [host, registrable] of CASES) {
    test(`a page at ${host}: the registrable domain is ${registrable}, and the probe leaves no cookie`, async ({ page }) => {
        await page.route(`https://${host}/**`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>host</title>' }));
        await page.goto(`https://${host}/`);
        const source = await moduleSource();
        const result = await page.evaluate(async (text) => {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
            const probe = await import(url);
            URL.revokeObjectURL(url);
            const first = probe.probeRegistrableDomain(location.hostname, document);
            return { first, again: probe.hostRegistrableDomain(location.hostname), jar: document.cookie };
        }, source);
        expect(result).toEqual({ first: registrable, again: registrable, jar: '' });
    });
}

test('a page whose cookies are blocked gets null: the caller keeps its name check', async ({ page }) => {
    await page.route('https://app.example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>host</title>' }));
    await page.goto('https://app.example.com/');
    const source = await moduleSource();
    const result = await page.evaluate(async (text) => {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
        const probe = await import(url);
        URL.revokeObjectURL(url);
        // a document whose cookie accessor keeps nothing, as a browser that blocks cookies has it
        const refusing = { get cookie() { return ''; }, set cookie(_: string) {} };
        return { blocked: probe.probeRegistrableDomain(location.hostname, refusing), address: probe.probeRegistrableDomain('127.0.0.1', refusing), none: probe.probeRegistrableDomain(location.hostname, undefined) };
    }, source);
    expect(result).toEqual({ blocked: null, address: '127.0.0.1', none: null });
});

test.describe("an origin on the host page's site is dropped in every mode, with one warning", () => {
    // the harness page and its own origin: the same site, in every engine. A same-site request would carry the host site's
    // cookies in some engines (cookie-facts.ts), so no mode admits one: the policy lists nothing and the request is refused.
    const request = `try { await fetch(${JSON.stringify(`${ORIGIN}/test/e2e/pixel.png`)}); } catch (e) {} return 'sent';`;
    const connectViolations = async (sandbox: SandboxDriver) => {
        await sandbox.page.waitForTimeout(500);
        return (await sandbox.violations()).filter(v => v.directive === 'connect-src' && v.blockedURI.includes('/test/e2e/pixel.png'));
    };

    for (const mode of ['strict', 'cooperative', 'worker'] as const) {
        test(`${mode}: the origin is dropped with one warning and the guest request is refused by connect-src${mode === 'strict' ? ' (WebKit raises no violation reports in workers)' : ''}`, async ({ sandbox, page, browserName }) => {
            const warnings: string[] = [];
            page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
            expect(await sandbox.mount({ mode, origins: { connect: [ORIGIN] } })).toBe('ready');
            expect(await sandbox.inGuest(request)).toBe('sent');
            // a strict or worker guest's fetch runs in a worker, whose reports WebKit does not raise: there the warning is the evidence
            if (mode === 'cooperative' || browserName !== 'webkit') expect((await connectViolations(sandbox)).length).toBeGreaterThan(0);
            expect(warnings.filter(text => text.includes(`origins.connect dropped ${ORIGIN} (the host page's own origin`))).toHaveLength(1);
            expect(warnings.filter(text => text.includes(`origins.connect lists ${ORIGIN}`))).toEqual([]);
        });
    }
});
