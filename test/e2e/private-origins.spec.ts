import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import type { Page } from '@playwright/test';

/**
 * A loopback, private or link-local origin in `origins.*` (or `fetchBridge.allow`) is kept only when the host page is itself
 * on such a host (a developer's machine); on any other page it is dropped with a warning, in every mode, on every engine
 * (src/lib/config-schema.ts, `limitHostReach`; THREAT-MODEL, "Private network"). The page here is an https page at a public
 * name that a route answers with the harness (nothing leaves the browser), and the control is the same configuration on the
 * loopback harness, which keeps the entries.
 */

test.use({ ignoreHTTPSErrors: true });

const PUBLIC = 'https://cdn.elsewhere.example';
const PRIVATE = ['http://127.0.0.1:9', 'https://192.168.1.5:8080', 'https://printer.local', 'https://host.docker.internal'];

/** Serves `https://app.public.example/...` from the dev server, so the harness runs on an https page at a public name. */
async function openPublicHost(sandbox: SandboxDriver) {
    const { page } = sandbox;
    await page.route('https://app.public.example/**', async (route) => {
        const url = new URL(route.request().url());
        // (fetched by node, not by route.fetch(): the browser project's own network settings stay out of it)
        const served = await fetch(`${ORIGIN}${url.pathname}${url.search}`);
        await route.fulfill({ status: served.status, contentType: served.headers.get('content-type') ?? 'text/plain', body: Buffer.from(await served.arrayBuffer()) });
    });
    await page.goto('https://app.public.example/test/e2e/harness.html');
    await page.waitForFunction(() => (window as any).harnessReady === true);
}

/** The `connect-src` and `img-src` the wrapper frame carries, as built. */
async function guestSources(page: Page) {
    const srcdoc = await page.evaluate(() => (document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!.srcdoc);
    const read = (directive: string) => (new RegExp(`${directive} ([^;"]*)`).exec(srcdoc)?.[1] ?? '').split(' ').filter(source => source !== '' && source !== 'blob:' && source !== 'data:');
    return { connect: read('connect-src'), img: read('img-src') };
}

for (const mode of ['strict', 'cooperative', 'worker'] as const) {
    test(`${mode}: on a public https host page the private-network entries are dropped with one warning per list and the public one is kept; on a loopback page all are kept`, async ({ sandbox, page }) => {
        const warnings: string[] = [];
        page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
        const config = {
            mode,
            hostContentSecurityPolicy: false,
            origins: { connect: [PUBLIC, ...PRIVATE], images: [PUBLIC, 'http://127.0.0.1:9'] },
            ...(mode === 'strict' ? { entry: 'main.js' } : {}),
        };
        const mount = async () => {
            if (mode === 'strict') await sandbox.registerFiles({ 'main.js': 'void 0' });
            return sandbox.mount(config as any);
        };

        await openPublicHost(sandbox);
        expect(await mount()).toBe('ready');
        const away = await guestSources(page);
        expect(away.connect, 'only the public origin is left').toContain(PUBLIC);
        for (const entry of PRIVATE) expect(away.connect.join(' '), entry).not.toContain(entry);
        expect(away.img.join(' ')).not.toContain('127.0.0.1');
        // one warning for each list that had entries dropped, naming them all
        const dropped = (kind: string) => warnings.filter(text => text.includes(`origins.${kind} dropped `) && text.includes('a loopback, private or link-local host'));
        expect(dropped('connect'), 'one warning for origins.connect').toHaveLength(1);
        for (const entry of PRIVATE) expect(dropped('connect')[0], entry).toContain(entry);
        expect(dropped('images'), 'and one for origins.images').toHaveLength(1);
        expect(dropped('images')[0]).toContain('http://127.0.0.1:9');
        expect(warnings.filter(text => text.includes(` lists `) && text.includes('a loopback, private or link-local host'))).toEqual([]);

        // the control: the harness on the loopback host keeps the same entries (and says so)
        warnings.length = 0;
        await sandbox.open();
        expect(await mount()).toBe('ready');
        const home = await guestSources(page);
        for (const entry of PRIVATE) expect(home.connect.join(' '), `${entry} is kept on a loopback page`).toContain(entry.replace(/^wss:/, 'https:'));
        expect(warnings.some(text => text.includes(' lists http://127.0.0.1:9'))).toBe(true);
    });
}
