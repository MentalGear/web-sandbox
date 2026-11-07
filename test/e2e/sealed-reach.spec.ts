import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixture';
import { RealisticHost, covering, withPolicySecrets, type PolicySecrets } from './realistic-host';
import { E2E_PORT } from './server';
import { inView } from './strict-view';
import { ENTRY_DONE_PREFIX } from '@src/lib/in-sandbox-view';
import { LIBRARY_GUEST_GLOBALS, surfaceOf } from '@src/lib/sealed-reach';
import { STRICT_WORKER_GLOBALS, STRICT_WORKER_NAVIGATOR_MEMBERS } from '@src/lib/worker-globals';

/**
 * Class A, closed by enumeration (S74; SEALED_REACH, src/lib/sealed-reach.ts): everything a sealed guest can reach is
 * classified against every row of INHERITED_CONTEXT, and test/unit/sealed-reach.test.ts holds the table to the code's lists.
 * This spec holds it to the engines:
 *   - the sealed worker's global object is the allowlist and the library's names, nothing else, and what the table says of
 *     the worker's own scope holds (its origin, URL and base, no `ancestorOrigins`, no isolation, nothing the prelude removes);
 *   - every member of every global the sealed worker keeps, called with a URL, with a string of code and with nothing, on
 *     the realistic host whose policy has a nonce, `'report-sample'` and a keyed report endpoint, makes no request, raises no
 *     violation, sends no report and puts no secret of the policy in an error's text: the cells `none` and `neutralised` of
 *     the policy and network rows, over the whole domain, members included;
 *   - the one bit of the `secureContext` row: the sealed worker of a host page served from a name that is not potentially
 *     trustworthy against one on a loopback host, where every name that differs must be a `remains` cell of that row;
 *   - the residuals of the view (`cspFetch.blobLoads`, `cspReporting.blobLoads`): on a page whose `img-src` refuses `blob:`, a
 *     registered image is refused and reported to the endpoint naming only `blob`, and the guest hears nothing; and the cells
 *     the CSSOM neutralises (`cspStyle`, `cspReporting`): the guest's style attribute and `<style>` apply under that page's
 *     `style-src` of hashes alone, with no violation and no report.
 */

const tag = () => randomUUID().replaceAll('-', '').slice(0, 16);
const secretsOf = (): PolicySecrets => ({ nonce: `HN${tag()}`, key: `RK${tag()}` });

/** The host page's own violation: its endpoint receives a report on this engine (the positive control). */
const hostOwnViolation = (host: RealisticHost) => host.page.evaluate(() => fetch('https://control.invalid/x').catch(() => {}));

test.describe('sealed mode: what the guest can reach, against every inherited row', () => {
    test.describe.configure({ timeout: 180000 });

    test("the sealed worker's global object is the allowlist and the library's names, and its own scope is what the table says", async ({ sandbox }) => {
        await sandbox.open();
        const seen = await sandbox.inEntry<Record<string, any>>({ mode: 'sealed' }, `
            // a WebIDL constant (a non-configurable primitive, Chromium's TEMPORARY) cannot be deleted and requests nothing
            const isConstant = (owner, n) => { const d = Object.getOwnPropertyDescriptor(owner, n); return !d.configurable && 'value' in d && Object(d.value) !== d.value; };
            const names = Object.getOwnPropertyNames(globalThis).filter((n) => !isConstant(globalThis, n));
            for (let p = Object.getPrototypeOf(globalThis); p && p !== EventTarget.prototype; p = Object.getPrototypeOf(p)) names.push(...Object.getOwnPropertyNames(p).filter((n) => n !== 'constructor' && !isConstant(p, n)));
            return {
                names: [...new Set(names)].sort(),
                navigatorMembers: Object.getOwnPropertyNames(Object.getPrototypeOf(navigator)).filter((n) => n !== 'constructor').sort(),
                ancestorOrigins: 'ancestorOrigins' in self.location,
                location: String(self.location.href), origin: self.origin,
                base: (() => { try { return new URL('x', self.location.href).href; } catch (e) { return 'unresolved: ' + e.name; } })(),
                crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer,
                createObjectURL: typeof URL.createObjectURL, webAssembly: typeof WebAssembly, importScripts: typeof importScripts,
            };
        `);
        const library = LIBRARY_GUEST_GLOBALS as readonly string[];
        const names = (seen.names as string[]).filter(name => !name.startsWith(ENTRY_DONE_PREFIX));
        expect(names.filter(name => !STRICT_WORKER_GLOBALS.includes(name) && !library.includes(name)), "a global of the sealed worker that is neither the allowlist's nor the library's").toEqual([]);
        for (const name of library) expect(names, name).toContain(name);
        expect(names.filter(name => !surfaceOf(name)), 'a global of the sealed worker with no surface in SEALED_REACH').toEqual([]);
        expect((seen.navigatorMembers as string[]).filter(name => !STRICT_WORKER_NAVIGATOR_MEMBERS.includes(name))).toEqual([]);
        // the cells of the worker's own scope (probe)
        expect(seen.ancestorOrigins, covering('ancestorOrigins', "the worker's location has no ancestorOrigins")).toBe(false);
        expect(seen.location, covering('documentOrigin', "the worker's URL is its own blob: URL")).toMatch(/^blob:null\/[0-9a-f-]{36}$/);
        expect(seen.base, covering('cspBaseUri', "a relative URL resolves against the worker's own blob: URL, which resolves none: never against the document's base")).toBe('unresolved: TypeError');
        expect(seen.origin, covering('documentOrigin', "the worker's origin is opaque")).toBe('null');
        expect(seen.crossOriginIsolated, covering('coep', 'not isolated')).toBe(false);
        expect(seen.sharedArrayBuffer, covering('coep', 'no shared memory')).toBe('undefined');
        // what the prelude and the strict allowlist remove
        expect([seen.createObjectURL, seen.webAssembly, seen.importScripts]).toEqual(['undefined', 'undefined', 'undefined']);
    });

    test('every member of every global the sealed worker keeps, called with a URL, a string of code and nothing: no request, no violation, no report, no secret', async ({ sandbox }) => {
        const secrets = secretsOf();
        const host = await RealisticHost.open(sandbox, { mode: 'sealed', directives: withPolicySecrets(secrets) });
        expect(host.csp).toContain(secrets.nonce);
        await host.hits(true);
        const events = await host.embed('sealed', { guest: sweep(host.api('sweep')) });
        expect(events.at(-1), 'the sealed build is ready').toEqual({ type: 'ready', reason: null });
        const swept = await host.guestResult<{ calls: number; members: number; globals: number; instances: number; heard: number; thrown?: string }>(150000);
        expect(swept.thrown, 'the sweep ran to its end').toBeUndefined();
        const texts = await sandbox.call<string[]>('sweepTexts');
        await host.page.waitForTimeout(2000); // a report the browser sends after the attempt
        const hits = await host.hits();

        expect(hits.reports, covering('cspReporting', "no member makes the browser report to the host page's endpoint")).toEqual([]);
        expect(hits.api.map(hit => hit.name).filter(name => name.startsWith('sweep')), covering('cspFetch', 'no member reaches the network')).toEqual([]);
        expect(await host.cspViolations(), covering('cspReporting', "the host page's own listener hears nothing")).toEqual([]);
        expect(swept.heard, covering('cspPolicyText', 'the guest hears no violation')).toBe(0);
        const reachable = JSON.stringify(texts);
        expect(reachable.includes(secrets.nonce), covering('cspPolicyText', "no error's text has the nonce")).toBe(false);
        expect(reachable.includes(secrets.key), covering('cspPolicyText', "no error's text has the report key")).toBe(false);
        expect(await host.state(), 'the sweep ends nothing').toBe('ready');
        // the sweep reached the domain: every global, and members by the thousand (positive evidence)
        test.info().annotations.push({ type: 'sweep', description: JSON.stringify(swept) });
        expect(swept.globals).toBeGreaterThan(180);
        expect(swept.members).toBeGreaterThan(1500);

        // positive control: the endpoint receives the host page's own violation
        await hostOwnViolation(host);
        await expect.poll(async () => (await host.hits()).reports.length, { message: "the host page's own violation is reported (control)", timeout: 15000 }).toBeGreaterThan(0);
    });

    test("the view's residual: a registered file, on a page that refuses it, is refused and reported naming only blob, and the guest hears nothing; the guest's styles apply there, unchecked", async ({ sandbox, browserName }) => {
        const secrets = secretsOf();
        // the realistic page without `blob:` in `img-src`; its `style-src` (the documented hashes) has no 'unsafe-inline'
        const directives = (base: Record<string, string[]>) => ({ ...withPolicySecrets(secrets)(base), 'img-src': ["'self'"] });
        const host = await RealisticHost.open(sandbox, { mode: 'sealed', directives });
        expect(host.csp).not.toContain("'unsafe-inline'");
        await host.hits(true);
        await sandbox.clearViolations();
        const attribute = 'color: rgb(1, 2, 3)';
        const sheet = '#sel { color: rgb(4, 5, 6) }';
        expect(await sandbox.registerFiles({ 'dot.png': { base64: DOT_PNG, type: 'image/png' } })).toBe('ok');
        const events = await host.embed('sealed', {
            guest: `
                let heard = 0;
                self.addEventListener('securitypolicyviolation', () => { heard++; }, true);
                sandboxView.render(${JSON.stringify(`<p id="sty" style="${attribute}">s</p><style>${sheet}</style><p id="sel">e</p><img id="img" src="dot.png" alt="">`)});
                await new Promise((resolve) => setTimeout(resolve, 2000));
                return { heard };
            `,
        });
        expect(events.at(-1)).toEqual({ type: 'ready', reason: null });
        const guest = await host.guestResult<{ heard: number }>(30000);
        expect(guest.heard, covering('cspPolicyText', "the view's refusals never reach the worker")).toBe(0);

        // the guest's styles applied in the view, through the CSSOM; its image did not: the page's img-src refused it
        const view = await inView<{ styled: string; sheet: string; image: number }>(host.page, browserName, `({ styled: getComputedStyle(document.getElementById('sty')).color, sheet: getComputedStyle(document.getElementById('sel')).color, image: document.getElementById('img').naturalWidth })`);
        expect(view, 'the view is reachable').not.toBe('no-context');
        if (view === 'no-context') return;
        await host.page.waitForTimeout(2000); // a report the browser sends after the refusal
        expect(view.styled, covering('cspStyle', "the guest's style attribute applies under a style-src of hashes alone (cssomDeclaration)")).toBe('rgb(1, 2, 3)');
        expect(view.sheet, covering('cspStyle', "the guest's <style> applies under a style-src of hashes alone (adoptedSheets)")).toBe('rgb(4, 5, 6)');
        expect(view.image, covering('cspFetch', "a page's img-src without blob: refuses a registered image")).toBe(0);

        // the element reports the one refusal as a violation, naming only blob: no style is checked
        const violations = (await sandbox.violations()).map(violation => [violation.directive, violation.blockedURI]);
        expect([...new Set(violations.map(([directive]) => directive))], covering('cspFetch', 'the refusal is reported as a violation, and no style is')).toEqual(['img-src']);
        for (const [, blocked] of violations) expect(blocked).toBe('blob');

        // what reached the page's endpoint names only blob, with no sample: nothing of the guest's styles
        // ledger: view-report-delivery
        const delivered = VIEW_REPORT_DELIVERY[browserName as keyof typeof VIEW_REPORT_DELIVERY];
        const reports = (await host.hits()).reports.map(report => (report as { 'csp-report'?: Record<string, unknown> })['csp-report'] ?? {});
        expect(reports.map(report => String(report['violated-directive'])), covering('cspReporting', "the page's endpoint receives what the engine reports from the view: the registered image, never a style")).toEqual(delivered ? ['img-src'] : []);
        for (const report of reports) {
            expect(String(report['blocked-uri']), covering('cspReporting', 'a report names blob as blocked')).toBe('blob');
            expect(String(report['script-sample'] ?? ''), covering('cspReporting', 'a report carries no sample of the guest')).toBe('');
        }
    });
});

// ---- the secure context: one bit ------------------------------------------------------------------------------------------

/** An HTTP proxy for names under `.test`: forwards each request to the e2e server, as `localhost`. */
async function startPlainProxy() {
    const server = http.createServer((req, res) => {
        let target: URL;
        try {
            target = new URL(req.url ?? '');
        } catch {
            res.writeHead(400);
            res.end();
            return;
        }
        if (!target.hostname.endsWith('.test')) {
            res.writeHead(403);
            res.end();
            return;
        }
        const headers = { ...req.headers, host: `localhost:${E2E_PORT}` };
        const upstream = http.request({ host: 'localhost', port: E2E_PORT, path: `${target.pathname}${target.search}`, method: req.method, headers }, (answer) => {
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(upstream);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        stop: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
    };
}

/**
 * Every global of the sealed worker and every member it leads to, as paths: `Name`; each own member of the value and of
 * every object of its prototype chain (`Name.member`, `Name^1.member` one level up, …); for an interface, the same of its
 * prototype (`Name.prototype.member`, …); and for every member of a namespace object whose value is an object (a getter's
 * included: `crypto.subtle`, `navigator.mediaCapabilities`), the same of that object. Symbol-keyed members too.
 */
const PATHS = `
    const paths = [];
    const keysOf = (o) => [...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o).map(String)];
    const chain = (prefix, o) => {
        for (let p = o, depth = 0; p && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p), depth++) {
            for (const k of keysOf(p)) paths.push(prefix + (depth ? '^' + depth : '') + '.' + k);
        }
    };
    const names = new Set();
    for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    for (const n of names) {
        if (n.startsWith(${JSON.stringify(ENTRY_DONE_PREFIX)})) continue;
        paths.push(n);
        if (n === 'self' || n === 'globalThis') continue;
        let v; try { v = self[n]; } catch (e) { continue; }
        if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
        chain(n, v);
        if (typeof v === 'function' && v.prototype && typeof v.prototype === 'object') chain(n + '.prototype', v.prototype);
        if (typeof v !== 'object') continue;
        for (let p = v; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
            for (const k of Object.getOwnPropertyNames(p)) {
                let member; try { member = v[k]; } catch (e) { continue; }
                if (member && typeof member === 'object') chain(n + '.' + k, member);
            }
        }
    }
    const all = [...new Set(paths)].sort();
    bridge.expose('paths', () => all);
    return { isSecureContext: self.isSecureContext, count: all.length };
`;

test.describe("the secureContext row: the sealed worker is the same whatever the host page's URL", () => {
    test.describe.configure({ timeout: 120000 });
    test.use({
        proxy: async ({}, use) => {
            const proxy = await startPlainProxy();
            await use({ server: proxy.server, bypass: 'localhost,127.0.0.1' }); // the e2e server stays direct
            await proxy.stop();
        },
    });

    test('a host page on a URL that is not potentially trustworthy and one on a loopback host: no name of the sealed worker differs, and isSecureContext reads false on both', async ({ sandbox }) => {
        const read = async (origin?: string) => {
            const host = await RealisticHost.open(sandbox, { mode: 'sealed', serviceWorker: false, cookies: false, ...(origin ? { origin } : {}) });
            const page = await host.page.evaluate(() => self.isSecureContext);
            expect((await host.embed('sealed', { guest: PATHS })).at(-1)).toEqual({ type: 'ready', reason: null });
            const worker = await host.guestResult<{ isSecureContext: boolean; count: number }>(30000);
            return { page, worker: worker.isSecureContext, paths: await sandbox.call<string[]>('paths') };
        };
        const insecure = await read(`http://app.insecure.test:${E2E_PORT}`);
        const loopback = await read();
        expect([insecure.page, loopback.page], 'the control: the host page itself is not secure on the name, and is on the loopback host').toEqual([false, true]);
        expect(loopback.paths.length, 'the paths reach the members of every kept global (positive evidence)').toBeGreaterThan(3000);

        const before = new Set(insecure.paths);
        const after = new Set(loopback.paths);
        const differing = [...new Set([...insecure.paths.filter(path => !after.has(path)), ...loopback.paths.filter(path => !before.has(path))])].sort();
        expect(differing, covering('secureContext', 'no name or member of the sealed worker depends on the host page being a secure context')).toEqual([]);
        expect([insecure.worker, loopback.worker], covering('secureContext', 'isSecureContext reads false on both, as on every engine')).toEqual([false, false]);
    });
});

/**
 * Whether the engine delivers a report of the view's refusals to the page's endpoint (measured; research 25): Chromium and
 * Firefox do, WebKit sends none from the view (it raises the violation there, and reports the host page's own).
 */
// ledger: view-report-delivery
const VIEW_REPORT_DELIVERY = { chromium: true, firefox: true, webkit: false } as const;

/** A 1×1 PNG, a registered file the view loads as an image. */
const DOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The sweep: every global the sealed worker keeps but the library's and `close` (which ends the worker), constructed and
 * called with `U` (a URL of the host's API), with `S` (a string of code that imports `U`) and with nothing; each static
 * member, and each member of an instance it could make, of the object itself (a namespace) and of one more object a getter
 * returns, called or read the same way. A promise is given 30 ms. It answers how many it called, and keeps every error's
 * text for the host (`sweepTexts`).
 */
function sweep(target: string): string {
    return `
        const U = ${JSON.stringify(target)};
        const S = 'imp' + 'ort(' + JSON.stringify(U) + ')';
        const ARGS = [[U], [S], [], [1, 1], [[U], U]];
        const SKIP = new Set(['self', 'globalThis', 'close', 'reportError', 'console', ${(LIBRARY_GUEST_GLOBALS as readonly string[]).map(name => JSON.stringify(name)).join(', ')}]);
        let heard = 0;
        self.addEventListener('securitypolicyviolation', () => { heard++; }, true);
        self.addEventListener('securitypolicyviolation', () => { heard++; });
        const texts = new Set();
        let calls = 0, members = 0, globals = 0, instances = 0;
        const note = (e) => { try { texts.add(String(e && e.message).slice(0, 400)); } catch (x) {} };
        // what a call returned, but never a thenable: an async function that returned one would take on its rejection
        const settle = async (run) => {
            calls++;
            try {
                const value = run();
                const thenable = value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
                if (!thenable) return value;
                try { await Promise.race([value, new Promise((resolve) => setTimeout(resolve, 30))]); } catch (e) { note(e); }
                return undefined;
            } catch (e) { note(e); return undefined; }
        };
        const deeper = [];
        const member = async (target, key, owner) => {
            const descriptor = Object.getOwnPropertyDescriptor(owner, key);
            if (!descriptor) return;
            members++;
            if (descriptor.get) {
                const got = await settle(() => descriptor.get.call(target));
                if (got && typeof got === 'object' && Object.getPrototypeOf(got) !== Object.prototype) deeper.push(got);
                return;
            }
            if (typeof descriptor.value === 'function') for (const args of ARGS) await settle(() => descriptor.value.apply(target, args));
        };
        const sweepObject = async (value) => {
            for (let p = value; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
                for (const key of Object.getOwnPropertyNames(p)) if (key !== 'constructor') await member(value, key, p);
            }
        };
        const names = new Set();
        for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) names.add(n);
        for (const name of [...names].sort()) {
            if (SKIP.has(name) || name.startsWith(${JSON.stringify(ENTRY_DONE_PREFIX)})) continue;
            let value;
            try { value = self[name]; } catch (e) { continue; }
            if (typeof value === 'function') {
                globals++;
                const made = [];
                for (const args of ARGS) {
                    const made1 = await settle(() => new value(...args));
                    if (made1 && typeof made1 === 'object') made.push(made1);
                }
                for (const args of ARGS) await settle(() => value(...args));
                for (const key of Object.getOwnPropertyNames(value)) if (!['prototype', 'length', 'name', 'caller', 'arguments'].includes(key)) await member(value, key, value);
                const prototype = value.prototype;
                if (made.length > 0 && prototype && typeof prototype === 'object') {
                    instances++;
                    for (const key of Object.getOwnPropertyNames(prototype)) if (key !== 'constructor') await member(made[0], key, prototype);
                }
            } else if (value && typeof value === 'object') {
                globals++;
                await sweepObject(value);
            }
        }
        const seen = new Set();
        for (const value of deeper.splice(0)) {
            const prototype = Object.getPrototypeOf(value);
            if (seen.has(prototype)) continue;
            seen.add(prototype);
            await sweepObject(value);
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        bridge.expose('sweepTexts', () => [...texts]);
        return { calls, members, globals, instances, heard };
    `;
}
