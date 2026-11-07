import { randomUUID } from 'node:crypto';
import { test, expect } from './fixture';
import { RealisticHost, HOST_BASE, POLICY_HASHES, covering, withPolicySecrets, type HostOptions } from './realistic-host';
import { makerCode, SEALED_MAKERS, STYLE_MAKERS, type Maker } from './sealed-makers';
import { inView, waitInView } from './strict-view';
import { CODE_FROM_STRING_REFUSAL } from '@src/lib/code-from-strings';
import { VIOLATION_EVENT_FIELDS } from '@src/lib/violation';
import { reasonText } from '@src/lib/reasons';

/**
 * The host page's policy can never be checked by sealed guest code (S74, class A: INHERITED_CONTEXT.cspPolicyText and
 * cspReporting; BD6:ISO-1, BD6:ISO-2). The guest's worker inherits the host page's whole policy list through the view, its
 * text and its reporting endpoints with it, and a policy of that list that refuses an action reports it: to the worker (a
 * `securitypolicyviolation` event carrying the page's policy text, its nonce and its report endpoint's key), in Chromium's
 * error text, and to the page's endpoint as a POST with the URL or the string the guest chose.
 *
 * On the realistic host, with a policy that has a script nonce, `'report-sample'` and a report endpoint with a key in its
 * URL, a sealed guest at its default configuration (`setConfig({ entry })`: no mode, no other option) runs every worker
 * maker of the enumeration (sealed-makers.ts: every request maker, every code-from-string sink, every compiler the worker
 * lacks), listens for violations, and reads every string it can. On every engine: the endpoint receives no report, the
 * page's own listener no violation, the guest no trusted event, and no string the guest holds contains the nonce or the key;
 * a positive control shows the endpoint receives the host page's own violation. An `import()` makes the build refuse the
 * entry, so no worker runs. And `report-to`, where the engine delivers to it.
 */

const tag = () => randomUUID().replaceAll('-', '').slice(0, 16);

/** The realistic host's policy with what a production page keeps from the content it embeds: a script nonce, `'report-sample'`, a key in its report endpoint's URL. */
const withSecrets = withPolicySecrets;

const isWorkerMaker = (maker: Maker) => maker.realm === 'worker';
const buildable = SEALED_MAKERS.filter(maker => isWorkerMaker(maker) && maker.outcome !== 'unbuildable');
const unbuildable = SEALED_MAKERS.filter(maker => isWorkerMaker(maker) && maker.outcome === 'unbuildable');

/** Where a maker aims: the host's own API, which records every request that reaches it. */
const makerTarget = (host: RealisticHost, maker: Maker) => host.api(`m-${maker.id}`);

/**
 * The guest: a listener for violations first (capture and bubble), then every buildable worker maker, then each sink once
 * more for its error's text, then a SecurityPolicyViolationEvent of its own, read field by field. It answers everything it
 * saw, which the host searches for the secrets. Holds no `import` followed by `(`: the build would refuse it.
 */
function guest(host: RealisticHost, name: string): string {
    const runs = buildable.map(maker => `results[${JSON.stringify(maker.id)}] = await Promise.race([${makerCode(maker, makerTarget(host, maker))}, new Promise((resolve) => setTimeout(() => resolve('pending'), 3000))]).then(String, (e) => 'threw ' + (e && e.name));`);
    return `sandboxView.render('<p id="m-done">done</p>');
(async () => {
  try {
    const results = {}, messages = {}, heard = [];
    const hear = (e) => { const out = {}; for (const k in e) { try { out[k] = String(e[k]); } catch (x) { out[k] = 'threw'; } } heard.push(out); };
    self.addEventListener('securitypolicyviolation', hear, true);
    self.addEventListener('securitypolicyviolation', hear);
${runs.join('\n')}
    const S = 'imp' + 'ort("https://x.example/")';
    const attempts = { eval: () => eval(S), indirect: () => (0, eval)(S), Function: () => Function(S), async: () => (async () => {}).constructor(S), generator: () => (function* () {}).constructor(S), asyncGenerator: () => (async function* () {}).constructor(S), timeout: () => setTimeout(S), interval: () => setInterval(S, 1000000) };
    for (const k of Object.keys(attempts)) { try { attempts[k](); messages[k] = 'ran'; } catch (e) { messages[k] = e.name + ': ' + e.message; } }
    // (Firefox's worker has no SecurityPolicyViolationEvent interface: nothing to read there)
    const Interface = typeof SecurityPolicyViolationEvent === 'function' ? SecurityPolicyViolationEvent : null;
    const P = Interface ? Interface.prototype : {};
    const accessors = Object.getOwnPropertyNames(P).filter((k) => { const d = Object.getOwnPropertyDescriptor(P, k); return d && typeof d.get === 'function'; });
    const own = Interface ? new Interface('securitypolicyviolation', { documentURI: 'https://d.example/', originalPolicy: 'own-policy', effectiveDirective: 'img-src', violatedDirective: 'img-src', blockedURI: 'https://b.example/', sample: 'own-sample', disposition: 'enforce', statusCode: 200, lineNumber: 3, columnNumber: 4, sourceFile: 'https://s.example/', referrer: 'https://r.example/' }) : {};
    const fields = {};
    for (const k of accessors) fields[k] = own[k];
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // how many it heard, and the first three whole (a line is cut at LOG_MAX_STRING: every event the guest hears carries a policy)
    console.log(${JSON.stringify(name)} + JSON.stringify({ results, messages, heardCount: heard.length, heard: heard.slice(0, 3), accessors, fields, location: String(self.location.href) }));
  } catch (e) {
    console.log(${JSON.stringify(name)} + JSON.stringify({ guestThrew: String(e && e.name) + ": " + String(e && e.message) }));
  }
})();`;
}

/** Runs the guest in a sealed sandbox at its default configuration, and answers what it saw. */
async function runSealedGuest(host: RealisticHost) {
    const name = `SEALEDPOLICY${tag()} `;
    await host.sandbox.clearLogs();
    await host.sandbox.registerFiles({ 'main.js': guest(host, name) });
    const events = await host.configure({ entry: 'main.js' });
    expect(events.at(-1), 'the default sealed build is ready').toEqual({ type: 'ready', reason: null });
    const line = await host.sandbox.waitForLog(name, 60000);
    return JSON.parse(line.slice(line.indexOf(name) + name.length)) as {
        results: Record<string, string>; messages: Record<string, string>; heardCount: number; heard: Record<string, string>[];
        accessors: string[]; fields: Record<string, unknown>; location: string;
    };
}

/** The host page's own violation: proves that its endpoint receives a report on this engine (the positive control). */
async function hostOwnViolation(host: RealisticHost) {
    await host.page.evaluate(() => fetch('https://control.invalid/x').catch(() => {}));
}

test.describe('sealed mode: the host page\'s policy can never be checked by the guest', () => {
    test.describe.configure({ timeout: 120000 });

    test('every worker maker on a host with a nonce, report-sample and a keyed report endpoint: no report, no violation, no event, no secret in reach', async ({ sandbox }) => {
        const secrets = { nonce: `HN${tag()}`, key: `RK${tag()}` };
        const host = await RealisticHost.open(sandbox, { mode: 'sealed', directives: withSecrets(secrets) });
        expect(host.csp).toContain(secrets.nonce);
        expect(host.csp).toContain(secrets.key);
        await host.hits(true);

        const seen = await runSealedGuest(host);
        await host.page.waitForTimeout(2000); // a report the browser sends after the attempt
        const hits = await host.hits();

        // the endpoint received nothing, and no maker's request reached the host's API
        expect(hits.reports, covering('cspReporting', "no report reaches the host page's endpoint")).toEqual([]);
        expect(hits.api.map(hit => hit.name).filter(name => name.startsWith('m-')), covering('cspReporting', 'no maker reaches the network')).toEqual([]);
        expect(await host.cspViolations(), covering('cspReporting', "the host page's own listener hears nothing")).toEqual([]);

        // the guest received no trusted violation, and nothing it holds names the policy's secrets
        expect((seen as { guestThrew?: string }).guestThrew, 'the guest ran to its end').toBeUndefined();
        expect(seen.heardCount, covering('cspPolicyText', 'the guest hears no violation')).toBe(0);
        const reachable = JSON.stringify(seen);
        expect(reachable.includes(secrets.nonce), covering('cspPolicyText', 'no string the guest holds has the nonce')).toBe(false);
        expect(reachable.includes(secrets.key), covering('cspPolicyText', 'no string the guest holds has the report key')).toBe(false);

        // each maker stopped as the enumeration says, every string refused with the library's own text
        expect(seen.results).toEqual(Object.fromEntries(buildable.map(maker => [maker.id, maker.sees])));
        const refusal = `EvalError: ${CODE_FROM_STRING_REFUSAL}`;
        expect(seen.messages, covering('cspPolicyText', "every string refused with the library's text, never the engine's")).toEqual({
            eval: refusal, indirect: refusal, Function: refusal, async: refusal, generator: refusal, asyncGenerator: refusal, timeout: refusal, interval: refusal,
        });

        // every field of a violation event reads blank to guest code, and every field the engine has is classified
        expect(seen.accessors.filter(name => !(name in VIOLATION_EVENT_FIELDS)), 'a field of SecurityPolicyViolationEvent the list does not name').toEqual([]);
        expect(seen.fields).toEqual(Object.fromEntries(seen.accessors.map(name => [name, VIOLATION_EVENT_FIELDS[name]])));

        // the library's own relay still works: the request gate's refusals reach the element
        expect((await sandbox.violations()).filter(v => v.directive === 'connect-src').length).toBeGreaterThan(0);
        expect(await host.state()).toBe('ready');

        // positive control: the endpoint receives the host page's own violation, with the key in the URL it was sent to
        await hostOwnViolation(host);
        await expect.poll(async () => (await host.hits()).reports.length, { message: "the host page's own violation is reported (control)", timeout: 15000 }).toBeGreaterThan(0);
        expect(JSON.stringify((await host.hits()).reports)).toContain('control.invalid');
    });

    test('every import() maker: the build refuses the entry with its reason, so no worker runs and nothing is reported', async ({ sandbox }) => {
        const secrets = { nonce: `HN${tag()}`, key: `RK${tag()}` };
        const host = await RealisticHost.open(sandbox, { mode: 'sealed', directives: withSecrets(secrets) });
        await host.hits(true);
        expect(unbuildable.length).toBe(3);
        for (const maker of unbuildable) {
            await sandbox.registerFiles({ 'main.js': `sandboxView.render('<p>x</p>'); ${makerCode(maker, makerTarget(host, maker))};` });
            const events = await host.configure({ entry: 'main.js' });
            expect(events.at(-1), covering('cspReporting', `${maker.id}: the build refuses an entry that calls import()`)).toEqual({ type: 'terminated', reason: reasonText('entryImport') });
        }
        await host.page.waitForTimeout(2000);
        expect((await host.hits()).reports).toEqual([]);
        // scriptUnsafe, which would hand strings to the platform: refused in sealed mode, with its reason
        await sandbox.registerFiles({ 'main.js': "sandboxView.render('<p>x</p>');" });
        expect((await host.configure({ entry: 'main.js', scriptUnsafe: true })).at(-1), covering('cspPolicyText', 'sealed mode refuses scriptUnsafe')).toEqual({ type: 'terminated', reason: reasonText('sealedScriptUnsafe') });
        // positive control: the same entry without the import() builds
        expect((await host.configure({ entry: 'main.js' })).at(-1)).toEqual({ type: 'ready', reason: null });
    });

    // BD6:ISO-2 (class A: INHERITED_CONTEXT.cspReporting): a style attribute or a <style> element of the guest's would be an
    // inline style that the host page's style-src checks (Chromium as it parses it), refuses where the page lists hashes,
    // and reports to the page's endpoint with its first characters. The view applies every guest style through the CSSOM.
    test('every way the guest styles the view, on a host whose style-src has only the documented hashes, report-sample and a keyed report endpoint: no report, no violation, and every style applies', async ({ sandbox, browserName }) => {
        const secrets = { nonce: `HN${tag()}`, key: `RK${tag()}` };
        const host = await RealisticHost.open(sandbox, { mode: 'sealed', directives: withSecrets(secrets) });
        const styleSrc = /(?:^|; )style-src ([^;]*)/.exec(host.csp)![1]!.split(' ');
        expect(styleSrc, 'the page admits the library by its hashes alone (docs/API.md#host-page-policy)').toEqual(["'self'", POLICY_HASHES.wrapperStyle, POLICY_HASHES.animationStyle, "'report-sample'"]);
        await host.hits(true);

        const name = `SEALEDSTYLES${tag()} `;
        const steps = STYLE_MAKERS.filter(maker => maker.then !== undefined).map(maker => `${maker.then};`).join('\n');
        await host.sandbox.registerFiles({ 'main.js': `sandboxView.render(${JSON.stringify(STYLE_MAKERS.map(maker => maker.markup).join('') + '<p id="s-done-slot"></p>')});
${steps}
sandboxView.render('<b id="s-done">done</b>', 's-done-slot');
console.log(${JSON.stringify(name)} + 'sent');` });
        expect((await host.configure({ entry: 'main.js' })).at(-1), 'the default sealed build is ready').toEqual({ type: 'ready', reason: null });
        await host.sandbox.waitForLog(name, 30000);
        await waitInView(host.page, browserName, "!!document.getElementById('s-done')", 15000);
        await host.page.waitForTimeout(2000); // a report the browser sends after the check

        // every style applies, with no sheet left over from a <style> that was replaced or removed
        const checks = Object.fromEntries(STYLE_MAKERS.map(maker => [maker.id, maker.check.value]));
        const seen = await inView<{ computed: Record<string, string>; adopted: number; sheets: number; inline: number }>(host.page, browserName, `(() => {
            const makers = ${JSON.stringify(STYLE_MAKERS.map(maker => [maker.id, maker.check]))};
            const computed = {};
            for (const [id, check] of makers) { const element = document.getElementById(check.id); computed[id] = element ? getComputedStyle(element).getPropertyValue(check.property) : 'missing'; }
            return { computed, adopted: document.adoptedStyleSheets.length, sheets: document.body.querySelectorAll('noframes').length, inline: document.querySelectorAll('style').length };
        })()`);
        expect(seen, 'the view answered').not.toBe('no-context');
        const view = seen as Exclude<typeof seen, 'no-context'>;
        expect(view.computed, covering('cspReporting', "every guest style applies under a style-src of hashes alone")).toEqual(checks);
        expect(view.adopted, "one constructed stylesheet for each <style> the view shows, none for one it no longer does").toBe(view.sheets);
        expect(view.sheets).toBe(9);
        expect(view.inline, 'no <style> element in the view but the library\'s still stylesheet').toBe(1);

        // nothing reached the endpoint, the page heard nothing, and the view raised no violation of the page's policy: the only
        // ones are the renderer's own reports of the URLs it dropped (keepsUrl, BD7:ISO-1)
        const hits = await host.hits();
        expect(hits.reports, covering('cspReporting', "no report of a guest style reaches the host page's endpoint")).toEqual([]);
        expect(await host.cspViolations(), covering('cspReporting', "the host page's own listener hears nothing")).toEqual([]);
        const dropped = STYLE_MAKERS.flatMap(maker => maker.drops ?? []).sort();
        expect(dropped.length).toBeGreaterThan(0);
        expect((await sandbox.violations()).map(v => String(v.blockedURI)).sort(), covering('cspReporting', 'the view raises no style violation; it reports what it dropped')).toEqual(dropped);
        expect(await host.state()).toBe('ready');

        // positive control: the host page's own inline style is refused and reported, with its sample, on this engine
        await host.page.evaluate(() => document.body.setAttribute('style', 'outline: 1px solid red'));
        await expect.poll(async () => (await host.hits()).reports.length, { message: "the host page's own inline style is reported (control)", timeout: 15000 }).toBeGreaterThan(0);
        expect(JSON.stringify((await host.hits()).reports)).toContain('style-src');
    });

    test('report-to, where the engine delivers to it: the endpoint receives nothing from the guest', async ({ sandbox, browserName }) => {
        // ledger: reporting-api-delivery
        test.skip(browserName !== 'webkit', "the Reporting API delivers no report in this harness on Chromium (the host page's own never arrived in 180 s) and is off on Firefox (measured)");
        const secrets = { nonce: `HN${tag()}`, key: `RK${tag()}` };
        const host = new RealisticHost(sandbox);
        const options: HostOptions = { mode: 'sealed', headers: { 'reporting-endpoints': `csp-ep="${HOST_BASE}/report/${host.session}?sentry_key=${secrets.key}"` }, directives: withSecrets(secrets, 'csp-ep') };
        await host.open(options);
        await host.hits(true);
        const seen = await runSealedGuest(host);
        expect(seen.heardCount).toBe(0);
        // the control, after the guest: the endpoint receives the host page's own report, and nothing else
        await hostOwnViolation(host);
        await expect.poll(async () => (await host.hits()).reports.flat().length, { message: "the host page's own violation is reported (control)", timeout: 60000 }).toBeGreaterThan(0);
        await host.page.waitForTimeout(3000);
        const reports = (await host.hits()).reports.flat() as Array<{ body?: { blockedURL?: string } }>;
        expect(reports.map(report => report.body?.blockedURL ?? '').filter(url => !url.includes('control.invalid')), covering('cspReporting', 'no report-to report from the guest')).toEqual([]);
    });
});
