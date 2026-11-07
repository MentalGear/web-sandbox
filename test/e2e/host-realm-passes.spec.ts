import { randomUUID } from 'node:crypto';
import { test, expect } from './fixture';
import { RealisticHost, covering, withPolicySecrets } from './realistic-host';
import { STYLE_MAKERS } from './sealed-makers';
import { inView, waitInView } from './strict-view';

/**
 * The host realm reads no markup of a strict or sealed build (BD7:LIM-1; HOST_PASSES, src/lib/host-passes.ts; class A's
 * third realm). The element read the config's `html` with the host page's DOMParser to decide its warning about scripts,
 * and Chromium checks the host page's policy as it parses: each style attribute, `<style>` and SVG `<style>` against
 * `style-src` (reported with a sample of the guest's CSS under `'report-sample'`, and raised on the host page as
 * `securitypolicyviolation`), and a guest `<base>` against `base-uri` (reported with the guest's whole URL).
 *
 * On the realistic host, with a policy that has `'report-sample'` and a keyed report endpoint, markup that holds every
 * style maker of sealed-host-policy.spec.ts and an absolute `<base>` with a secret in its query goes to a sealed sandbox
 * at its default configuration through every way `html` reaches a build: setConfig({ html }), load(), reset() and the
 * insertion of an element configured before. On every engine: the endpoint receives no report, the host page's listener
 * hears no violation, and the view shows the markup with its styles. A positive control shows the endpoint receives the
 * host page's own violation, so a report would have arrived.
 */

const tag = () => randomUUID().replaceAll('-', '').slice(0, 16);

test.describe("a strict or sealed build's markup reaches no parser of the host page's realm", () => {
    test.describe.configure({ timeout: 120000 });

    test('style makers and an absolute <base> through setConfig({ html }), load(), reset() and insertion: no report, no violation on the host page', async ({ sandbox, browserName }) => {
        const secrets = { nonce: `HN${tag()}`, key: `RK${tag()}` };
        const host = await RealisticHost.open(sandbox, { mode: 'sealed', directives: withPolicySecrets(secrets) });
        const { page } = host;
        expect(host.csp).toContain("style-src 'self'");
        expect(host.csp).toMatch(/base-uri 'self' about:/);
        const baseSecret = `BS${tag()}`;
        const html = `<base href="https://base.example/app/?token=${baseSecret}">${STYLE_MAKERS.map(maker => maker.markup).join('')}<p id="h-done">done</p>`;
        await host.hits(true);

        // setConfig({ html }): the default mode, sealed
        expect((await host.configure({ html })).at(-1), 'setConfig({ html }) builds').toEqual({ type: 'ready', reason: null });
        await waitInView(page, browserName, "!!document.getElementById('h-done')", 15000);
        // load(), and reset()
        expect(await page.evaluate((markup) => whenSettled(s => s.load(markup)), `${html}<i>load</i>`)).toBe('ready');
        expect(await page.evaluate(() => whenSettled(s => s.reset()))).toBe('ready');
        // an element configured before its insertion builds on insertion
        const inserted = await page.evaluate((markup) => new Promise<string>((resolve) => {
            const element = document.createElement('web-sandbox') as HTMLElement & { setConfig(config: object): void };
            element.id = 'inserted';
            element.setConfig({ html: markup });
            element.addEventListener('ready', () => resolve('ready'));
            element.addEventListener('terminated', (event: any) => resolve(`terminated: ${event.detail?.reason}`));
            document.body.appendChild(element);
        }), `${html}<i>inserted</i>`);
        expect(inserted, 'the inserted element builds').toBe('ready');
        await page.waitForTimeout(2000); // a report the browser sends after the parse

        // the view shows the markup with its styles: the parse it needs is the view's own
        const applied = await inView<Record<string, string>>(page, browserName, `(() => {
            const out = {};
            for (const [id, check] of ${JSON.stringify(STYLE_MAKERS.filter(maker => maker.then === undefined).map(maker => [maker.id, maker.check]))}) {
                const element = document.getElementById(check.id);
                out[id] = element ? getComputedStyle(element).getPropertyValue(check.property) : 'missing';
            }
            return out;
        })()`);
        expect(applied).toEqual(Object.fromEntries(STYLE_MAKERS.filter(maker => maker.then === undefined).map(maker => [maker.id, maker.check.value])));

        const hits = await host.hits();
        const reported = JSON.stringify(hits.reports);
        expect(hits.reports, covering('cspReporting', "no report of the guest's markup reaches the host page's endpoint")).toEqual([]);
        expect(reported.includes(baseSecret), covering('cspReporting', "no report carries the guest's <base> URL")).toBe(false);
        expect(await host.cspViolations(), covering('cspReporting', "the host page's own listener hears nothing")).toEqual([]);
        expect(hits.api.filter(hit => JSON.stringify(hit).includes(baseSecret)), 'nothing requested the <base> URL').toEqual([]);
        expect(await host.state()).toBe('ready');

        // positive control: the host page's own inline style is refused and reported on this engine
        await page.evaluate(() => document.body.setAttribute('style', 'outline: 1px solid red'));
        await expect.poll(async () => (await host.hits()).reports.length, { message: "the host page's own inline style is reported (control)", timeout: 15000 }).toBeGreaterThan(0);
        expect(JSON.stringify((await host.hits()).reports)).toContain('style-src');
    });
});
