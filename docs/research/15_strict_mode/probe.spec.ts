import { test, expect, type Page } from '@playwright/test';
import {
    BOOTSTRAP, INLINE_SCRIPT_POLICY, Listener, UdpListener, clickInView, escapeAttribute, frameStates, hashSource,
    iceProbe, inFrames, inView, inbox, init, markers, mount, viewPolicy, workerResults,
} from './harness';

/**
 * Research 15: measurement probes for the planned strict mode (strict-design.md, "Probes before
 * building" P1–P8), run BEFORE it is built. No library code: harness.ts builds the design's topology
 * (host → wrapper → view with a hash-only policy and one bootstrap → worker from blob:).
 *
 * Every assertion is a measured per-engine fact (Chromium 141, Firefox 146, WebKit 26 — Playwright
 * 1.58), measured 2026-10-13. Where engines differ the test branches on browserName and says what was
 * measured. Evidence: script-run markers read from every frame from outside (Playwright / CDP), the
 * view's securitypolicyviolation events, and for network a loopback HTTPS / UDP listener with a
 * positive control that observes the same action when it is allowed.
 *
 * Run: bun run test:probes (bunx playwright test -c docs/research/15_strict_mode); CI runs it on every engine.
 * Skipped under the repository's root config, which has no server for them.
 */

/** Prints a measured value (the README's findings table is made from these lines). */
const log = (browser: string, name: string, value: unknown) => console.log(`MEASURED ${browser} ${name} ${JSON.stringify(value)}`);

const listener = new Listener();
const udp = new UdpListener();

test.beforeAll(async ({}, testInfo) => {
    if (!testInfo.config.metadata?.strictProbes) return;
    await listener.start();
    await udp.start();
});
test.afterAll(async () => {
    await listener.stop();
    if (udp.port) udp.stop();
});
test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.config.metadata?.strictProbes, 'design probe: run with bun run test:probes (its own config and server)');
    listener.clear();
});

/** A script-run marker: pushes `name` onto globalThis.__ran of the document it runs in. */
const M = (name: string) => `(globalThis.__ran=globalThis.__ran||[]).push('${name}')`;
const srcdoc = (doc: string) => `srcdoc="${escapeAttribute(doc)}"`;
const at = (left: number, top: number, w = 80, h = 40) => `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;border:0;display:block;margin:0`;

/** A worker body that renders `html` once and waits `ms`. */
const renderOnce = (html: string, ms = 800) => `async function main() { post(${JSON.stringify(html)}); await sleep(${ms}); }`;

const VIEW = 'main/outer/d2';

// ---- P1 ----------------------------------------------------------------------------------------

test('P1 the hash-only script-src is inherited by every frame guest markup creates', async ({ page, browserName }) => {
    test.setTimeout(90000);
    const corpus = [
        `<a id="v-jslink" href="javascript:${M('v-jslink')}" style="${at(0, 0)}">v</a>`,
        `<img src="data:," onerror="${M('v-onerror')}">`,
        `<iframe name="c-jslink" style="${at(100, 0)}" ${srcdoc(`<a href="javascript:${M('c-jslink')}" style="position:fixed;inset:0;display:block">c</a>`)}></iframe>`,
        `<iframe name="c-inline" ${srcdoc(`<script>${M('c-inline')}</script>`)}></iframe>`,
        `<iframe name="c-copy" ${srcdoc(`<script>${BOOTSTRAP}</script>`)}></iframe>`,
        `<iframe name="c-handlers" ${srcdoc(`<img src="data:," onerror="${M('c-onerror')}"><svg onload="${M('c-svgload')}"></svg><details open ontoggle="${M('c-toggle')}"></details>`)}></iframe>`,
        `<iframe name="c-jssrc" src="javascript:${M('c-jssrc')}"></iframe>`,
        `<iframe name="c-refresh" ${srcdoc(`<meta http-equiv="refresh" content="0;url=javascript:${M('c-refresh')}">`)}></iframe>`,
        `<iframe name="c-blank"></iframe>`,
        `<iframe name="c-nested" ${srcdoc(`<script>${M('c-nested')}</script><iframe name="g" ${srcdoc(`<script>${M('g-inline')}</script><script>${BOOTSTRAP}</script><iframe name="gg" ${srcdoc(`<script>${M('gg-inline')}</script><script>${BOOTSTRAP}</script>`)}></iframe>`)}></iframe>`)}></iframe>`,
        `<iframe name="c-ice" ${srcdoc(`<script>(${iceProbe(udp.port)})(r => ${M('c-ice-ran')})</script>`)}></iframe>`,
    ].join('');

    for (const forceSandbox of [false, true]) {
        udp.packets = 0;
        const { wrapped } = await mount(page);
        // cancelNav off: the javascript: links are left to the policy alone
        await init(page, wrapped, renderOnce(corpus, 1500), { forceSandbox, cancelNav: false });
        await page.waitForTimeout(1000);
        await clickInView(page, 20, 20); // v-jslink
        await clickInView(page, 120, 20); // the link inside c-jslink
        await page.waitForTimeout(3500); // the ICE probe would report after 3 s

        const states = await frameStates(page, browserName);
        const policies = await inFrames<string>(page, INLINE_SCRIPT_POLICY, browserName);
        const below = policies.filter(p => p.path.startsWith(`${VIEW}/`));
        const ran = await markers(page, browserName);
        log(browserName, `P1 forceSandbox=${forceSandbox}`, { ran, frames: states.length, udp: udp.packets });

        // all 11 created frames exist (frame-src 'none' does not stop srcdoc / about:blank / javascript: frames)
        expect(below.length).toBe(11);
        // every one of them refuses an inline script inserted through its DOM: the view policy is inherited,
        // down to the great-grandchild (gg), the about:blank frame and the javascript: frame
        expect(below.map(p => p.value).filter(v => v !== 'blocked')).toEqual([]);
        expect(await page.evaluate(() => (window as any).windowMessages)).toEqual([]);
        expect(udp.packets).toBe(0); // the ICE probe in c-ice never ran
        if (!forceSandbox) {
            // measured, all engines: only the hashed bootstrap copy runs — in the view and in every
            // unsandboxed frame that carries the exact text (c-copy, g, gg); no inline script, handler,
            // javascript: URL (src, clicked link, meta refresh) runs anywhere
            expect(ran.sort()).toEqual([`${VIEW}:bootstrap`, `${VIEW}/c-copy:bootstrap`, `${VIEW}/c-nested/g/gg:bootstrap`, `${VIEW}/c-nested/g:bootstrap`].sort());
        } else {
            // forced sandbox="": the copies do not run either
            expect(ran).toEqual([`${VIEW}:bootstrap`]);
            const sandboxes = await inView<string[]>(page, `Array.from(document.querySelectorAll('iframe')).map(f => f.getAttribute('sandbox'))`, browserName);
            expect(sandboxes).toEqual(Array(9).fill(''));
        }
        const violations = await inView<string[]>(page, 'globalThis.__violations.map(v => v.directive)', browserName);
        expect(violations).toContain('script-src-attr'); // v-onerror
        expect(violations).toContain('img-src'); // the data: image in the view
    }

    // Which refusals reach the view's listener: frames only, each refusing something of its own.
    const children = [
        `<iframe name="c-inline" ${srcdoc(`<script>${M('c-inline')}</script>`)}></iframe>`,
        `<iframe name="c-handlers" ${srcdoc(`<img src="data:," onerror="${M('c-onerror')}">`)}></iframe>`,
        `<iframe name="c-refresh" ${srcdoc(`<meta http-equiv="refresh" content="0;url=javascript:${M('c-refresh')}">`)}></iframe>`,
        `<iframe name="c-jssrc" src="javascript:${M('c-jssrc')}"></iframe>`,
    ].join('');
    for (const forceSandbox of [false, true]) {
        const { wrapped } = await mount(page);
        await init(page, wrapped, renderOnce(children, 800), { forceSandbox });
        await page.waitForTimeout(1500);
        const violations = await inView<string[]>(page, `globalThis.__violations.map(v => v.directive + ' ' + v.blocked)`, browserName);
        log(browserName, `P1 children-only forceSandbox=${forceSandbox} viewViolations`, violations);
        // Measured: refusals inside created frames (inline script, handler, img-src, refresh) are reported
        // in those frames only — never to the view. Chromium and WebKit report the javascript: frame src
        // to the view (the initiator); Firefox reports nothing to the view.
        expect(violations).toEqual(browserName === 'firefox' ? [] : ['script-src-elem inline']);
    }

    // Control for the UDP listener: the same ICE probe from the host page.
    udp.packets = 0;
    const host = await page.evaluate(`new Promise(res => (${iceProbe(udp.port)})(res))`) as { pc: string; candidates: string[] };
    log(browserName, 'P1 host ICE control', { host, packets: udp.packets });
    expect(host.pc).toBe('function');
    expect(host.candidates).toContain('host');
    if (browserName === 'firefox') {
        // measured: Firefox sends no STUN/TURN traffic to a loopback server even from the host page,
        // so only "the probe never ran" (no marker) is evidence there
        expect(udp.packets).toBe(0);
    } else {
        expect(udp.packets).toBeGreaterThan(0);
    }
});

// ---- P2 ----------------------------------------------------------------------------------------

const REPORTER = `(() => { globalThis.__violations = []; document.addEventListener('securitypolicyviolation', (e) => globalThis.__violations.push(e.effectiveDirective), true); })();`;
const P2_VARIANTS: Record<string, string> = {
    ascii: `${M('ascii')};`,
    'non-ascii': `${M('non-ascii')}; void 'é € 😀     ü';`,
    'lt-amp-quote': `${M('lt-amp-quote')}; if (1 < 2 && "a" !== '&amp;' && '&quot;' !== "\\"") {}`,
    crlf: `${M('crlf')};\r\nvoid 0;\r\n`,
    'lone-cr': `${M('lone-cr')};\rvoid 0;`,
    nul: `${M('nul')}; /*\u0000*/`,
};
/** What the HTML parser makes of script text: CR LF and lone CR become LF, NUL becomes U+FFFD. */
const parsed = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '�');

test('P2 the hash must cover the script text as parsed, not as authored', async ({ page, browserName }) => {
    for (const method of ['authored', 'parsed'] as const) {
        for (const wrapped of [true, false]) { // through the wrapper's srcdoc attribute, or set as a property
            const scripts = [REPORTER, ...Object.values(P2_VARIANTS)];
            const hashes = scripts.map(s => hashSource(method === 'authored' ? s : parsed(s)));
            await mount(page, { scripts, policy: viewPolicy(hashes), wrapped });
            await page.waitForTimeout(300);
            const ran = await inView<string[]>(page, '(globalThis.__ran || [])', browserName, wrapped);
            const violations = await inView<string[]>(page, 'globalThis.__violations', browserName, wrapped);
            log(browserName, `P2 hash=${method} wrapped=${wrapped}`, { ran, violations });
            // Measured, all engines, both delivery paths: non-ASCII (UTF-8), "<", "&amp;" and quotes
            // survive the attribute decoding exactly; CR, CR LF and NUL do not.
            if (method === 'authored') {
                expect(ran).toEqual(['ascii', 'non-ascii', 'lt-amp-quote']);
                expect(violations).toEqual(['script-src-elem', 'script-src-elem', 'script-src-elem']);
            } else {
                expect(ran).toEqual(Object.keys(P2_VARIANTS));
                expect(violations).toEqual([]);
            }
        }
    }
});

// ---- P3 ----------------------------------------------------------------------------------------

const P3_BODY = (L: string, key: string) => `
const L = ${JSON.stringify(L)}, KEY = ${JSON.stringify(key)};
const tryIt = (f) => { try { return 'ok:' + String(f()); } catch (e) { return 'threw:' + errorName(e); } };
async function main() {
  report('started', true);
  report('location', self.location.href.replace(/[0-9a-f-]{36}$/, 'UUID'));
  const blobJs = URL.createObjectURL(new Blob(['self.__importedBlob = true;'], { type: 'text/javascript' }));
  report('importScriptsBlob', tryIt(() => { importScripts(blobJs); return self.__importedBlob === true; }));
  report('importScriptsHttps', tryIt(() => { importScripts(L + '/p3-' + KEY + '-import.js'); return self.__listenerScriptRan === true; }));
  report('eval', tryIt(() => eval('1 + 1')));
  report('Function', tryIt(() => new Function('return 2')()));
  self.__stringTimer = false;
  setTimeout('self.__stringTimer = true', 0);
  await sleep(300);
  report('setTimeoutStringRan', self.__stringTimer);
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  report('wasmCompile', await WebAssembly.compile(wasm).then(() => 'ok', (e) => 'rejected:' + errorName(e)));
  report('wasmModuleSync', tryIt(() => !!new WebAssembly.Module(wasm)));
  report('fetch', await fetch(L + '/p3-' + KEY + '-fetch').then((r) => 'ok:' + r.status, (e) => 'rejected:' + errorName(e)));
  report('typeofWorker', typeof Worker);
  report('peerConnection', Object.getOwnPropertyNames(globalThis).filter((n) => /RTCPeerConnection$/.test(n)));
  report('nestedWorker', await new Promise((resolve) => {
    try {
      const src = "fetch(" + JSON.stringify(L + '/p3-' + KEY + '-nested-fetch') + ").then(() => 'ok', (e) => 'rejected:' + e.name).then((f) => postMessage('ran fetch=' + f + ' eval=' + (() => { try { eval('1'); return 'ok'; } catch (e) { return e.name; } })()))";
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => resolve('error:' + (e.message || 'event'));
      setTimeout(() => resolve('timeout'), 3000);
    } catch (e) { resolve('threw:' + errorName(e)); }
  }));
  report('deleteWorker', delete self.Worker);
  report('afterDelete', { typeofWorker: typeof Worker, inSelf: 'Worker' in self, onProto: 'Worker' in Object.getPrototypeOf(self) });
}`;

test('P3 the worker under the hash-only view policy', async ({ page, browserName }) => {
    test.setTimeout(60000);
    const cases: Record<string, string> = {
        design: viewPolicy([hashSource(BOOTSTRAP)]),
        unsafeEval: viewPolicy([hashSource(BOOTSTRAP)], { scriptSrc: "'unsafe-eval'" }),
        control: viewPolicy([hashSource(BOOTSTRAP)], { scriptSrc: listener.origin, connectSrc: listener.origin }),
    };
    const measured: Record<string, any> = {};
    for (const [key, policy] of Object.entries(cases)) {
        listener.clear();
        const { wrapped } = await mount(page, { policy });
        await init(page, wrapped, P3_BODY(listener.origin, key));
        const results = await workerResults(page);
        await page.waitForTimeout(300);
        const violations = (await inbox(page)).filter(m => m.data.type === 'VIOLATION').map(m => `${m.port}:${m.data.v.directive}`).sort();
        measured[key] = { results, violations, hits: listener.paths(`/p3-${key}`).sort() };
    }
    log(browserName, 'P3', measured);
    const { design, unsafeEval, control } = measured;
    const webkit = browserName === 'webkit';

    // Hash-only policy (the design's default), all engines: the blob: worker starts (worker-src blob:,
    // no script-src hash needed), the policy is inherited, string-to-code is refused.
    expect(design.results).toMatchObject({
        started: true, location: 'blob:null/UUID',
        importScriptsBlob: 'threw:NetworkError', importScriptsHttps: 'threw:NetworkError',
        eval: 'threw:EvalError', Function: 'threw:EvalError', setTimeoutStringRan: false,
        fetch: 'rejected:TypeError', peerConnection: [],
        // a nested worker is admitted (worker-src blob:) and inherits the same policy
        typeofWorker: 'function', nestedWorker: 'ran fetch=rejected:TypeError eval=EvalError',
        // ... so Worker must be deleted before guest code; deleting it leaves no way back
        deleteWorker: true, afterDelete: { typeofWorker: 'undefined', inSelf: false, onProto: false },
    });
    // WebAssembly: refused in Chromium and Firefox; WebKit compiles it in the worker without
    // 'unsafe-eval' or 'wasm-unsafe-eval' (measured).
    expect([design.results.wasmCompile, design.results.wasmModuleSync]).toEqual(webkit ? ['ok', 'ok:true'] : ['rejected:CompileError', 'threw:CompileError']);
    expect(design.hits).toEqual([]); // neither importScripts nor fetch reached the listener

    // Where the worker's refusals are reported (measured):
    //   Chromium: all in the worker (logic port), importScripts as script-src-elem;
    //   Firefox: importScripts refusals fire in the VIEW document, the rest in the worker;
    //   WebKit: no securitypolicyviolation event at all, in the worker or the view.
    const expectedViolations: Record<string, string[]> = {
        chromium: ['logic:connect-src', ...Array(2).fill('logic:script-src-elem'), ...Array(5).fill('logic:script-src')],
        firefox: ['logic:connect-src', ...Array(5).fill('logic:script-src'), ...Array(2).fill('view:script-src-elem')],
        webkit: [],
    };
    expect(design.violations).toEqual(expectedViolations[browserName]!.sort());

    // 'unsafe-eval' re-enables eval, Function, string timers and WebAssembly — in nested workers too.
    expect(unsafeEval.results).toMatchObject({
        eval: 'ok:2', Function: 'ok:2', setTimeoutStringRan: true, wasmCompile: 'ok', wasmModuleSync: 'ok:true',
        importScriptsBlob: 'threw:NetworkError', importScriptsHttps: 'threw:NetworkError', fetch: 'rejected:TypeError',
        nestedWorker: 'ran fetch=rejected:TypeError eval=ok',
    });
    expect(unsafeEval.hits).toEqual([]);

    // Positive control: with the listener in script-src and connect-src, the same three loads arrive.
    expect(control.results).toMatchObject({ importScriptsHttps: 'ok:true', fetch: 'ok:200', nestedWorker: 'ran fetch=ok eval=EvalError', importScriptsBlob: 'threw:NetworkError' });
    expect(control.hits).toEqual(['/p3-control-fetch', '/p3-control-import.js', '/p3-control-nested-fetch']);
});

// ---- P4 ----------------------------------------------------------------------------------------

/** Whether the view document and its worker survived: its marker, a worker round trip, every frame's URL. */
async function viewAlive(page: Page, browserName: string, wrapped: boolean) {
    const ran = await inView<string[]>(page, '(globalThis.__ran || [])', browserName, wrapped);
    const pong = await page.evaluate(() => (window as any).ping(1500));
    const urls = (await inFrames(page, '1', browserName)).map(f => f.url);
    return { view: Array.isArray(ran) && ran.includes('bootstrap'), worker: typeof pong === 'number', urls };
}

test('P4 forms and navigation from rendered markup', async ({ page, browserName }) => {
    test.setTimeout(120000);
    const L = listener.origin;
    const button = (action: string) => `<form action="${action}"><button id="b" style="${at(0, 0)}">go</button></form>`;
    const link = (href: string) => `<a id="a" href="${href}" style="${at(0, 0)}">go</a>`;
    const run = async (o: { html: string; wrapped: boolean; sandbox?: string; cancelNav?: boolean; formAction?: string; click?: boolean }) => {
        listener.clear();
        await mount(page, { policy: viewPolicy([hashSource(BOOTSTRAP)], { formAction: o.formAction }), wrapped: o.wrapped, sandbox: o.sandbox });
        await init(page, o.wrapped, renderOnce(o.html, 500), { cancelNav: o.cancelNav ?? true });
        await page.waitForTimeout(600);
        if (o.click !== false) await clickInView(page, 20, 20); // a trusted click
        await page.waitForTimeout(2000);
        const events = await inView(page, 'globalThis.__events.map(e => e.type)', browserName, o.wrapped);
        return { hits: listener.paths('/p4'), events, ...(await viewAlive(page, browserName, o.wrapped)) };
    };
    const intact = { view: true, worker: true };
    const r: Record<string, any> = {};

    // 4a: does `submit` fire in the view without allow-forms? (the bootstrap listens in capture)
    r.submitNoForms = await run({ html: button(`${L}/p4a`), wrapped: true, sandbox: 'allow-scripts' });
    r.submitForms = await run({ html: button(`${L}/p4a`), wrapped: true });
    // 4b: does preventDefault on a link click stop the navigation? Unwrapped, so only it can.
    r.linkControl = await run({ html: link(`${L}/p4b-off`), wrapped: false, cancelNav: false });
    r.linkCancelled = await run({ html: link(`${L}/p4b-on`), wrapped: false, cancelNav: true });
    // 4c: does a <meta http-equiv=refresh> inserted from a template navigate?
    r.refreshUnwrapped = await run({ html: `<meta http-equiv="refresh" content="0;url=${L}/p4c-unwrapped">`, wrapped: false, click: false });
    r.refreshWrapped = await run({ html: `<meta http-equiv="refresh" content="0;url=${L}/p4c-wrapped">`, wrapped: true, click: false });
    // 4d: a navigation the wrapper's frame-src refuses: does the view (and its worker) survive?
    r.linkWrapped = await run({ html: link(`${L}/p4d-off`), wrapped: true, cancelNav: false });
    r.linkWrappedCancelled = await run({ html: link(`${L}/p4d-on`), wrapped: true, cancelNav: true });
    // 4e: form submission: control (form-action allows the listener), form-action 'none', preventDefault
    r.submitControl = await run({ html: button(`${L}/p4e-control`), wrapped: false, cancelNav: false, formAction: L });
    r.submitFormActionNone = await run({ html: button(`${L}/p4e-none`), wrapped: false, cancelNav: false });
    r.submitCancelled = await run({ html: button(`${L}/p4e-cancel`), wrapped: false, cancelNav: true, formAction: L });
    log(browserName, 'P4', r);

    // 4a — measured: without allow-forms Chromium and Firefox never dispatch `submit`; WebKit does.
    expect(r.submitNoForms.events).toEqual(browserName === 'webkit' ? ['click', 'submit'] : ['click']);
    expect(r.submitForms.events).toEqual(['click', 'submit']);
    expect([r.submitNoForms.hits, r.submitForms.hits]).toEqual([[], []]);
    expect(r.submitForms).toMatchObject(intact);

    // 4b — all engines: the control navigates to the listener; preventDefault stops it.
    expect(r.linkControl.hits).toEqual(['/p4b-off']);
    expect(r.linkControl).toMatchObject({ view: false, worker: false });
    expect(r.linkCancelled).toMatchObject({ hits: [], events: ['click'], ...intact });

    // 4c — all engines: a meta refresh inserted through template/replaceChildren DOES navigate
    // (unwrapped it reaches the listener). Wrapped, frame-src stops it in every engine, but Chromium
    // commits its error page in place of the view, which ends the view and the worker.
    expect(r.refreshUnwrapped.hits).toEqual(['/p4c-unwrapped']);
    expect(r.refreshWrapped.hits).toEqual([]);
    // 4d — the same for a link click the view does not cancel.
    expect(r.linkWrapped.hits).toEqual([]);
    if (browserName === 'chromium') {
        for (const k of ['refreshWrapped', 'linkWrapped']) {
            expect(r[k]).toMatchObject({ view: false, worker: false });
            expect(r[k].urls).toContain('chrome-error://chromewebdata/');
        }
    } else {
        expect(r.refreshWrapped).toMatchObject(intact);
        expect(r.linkWrapped).toMatchObject(intact);
    }
    expect(r.linkWrappedCancelled).toMatchObject({ hits: [], ...intact });

    // 4e — all engines: the control submits to the listener; form-action 'none' alone and preventDefault
    // alone each stop it, and `submit` fires in both.
    expect(r.submitControl.hits).toEqual(['/p4e-control']);
    expect(r.submitFormActionNone).toMatchObject({ hits: [], events: ['click', 'submit'], ...intact });
    expect(r.submitCancelled).toMatchObject({ hits: [], events: ['click', 'submit'], ...intact });
});

// ---- P5 ----------------------------------------------------------------------------------------

test('P5 a blob: URL minted by the worker is usable in the view', async ({ page, browserName }) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="5"></svg>';
    const body = `async function main() {
        const u = URL.createObjectURL(new Blob([${JSON.stringify(svg)}], { type: 'image/svg+xml' }));
        report('url', u.replace(/[0-9a-f-]{36}$/, 'UUID'));
        post('<img id="wimg" src="' + u + '">');
        await sleep(1000);
    }`;
    const workerMinted = `(() => { const i = document.getElementById('wimg'); return i ? i.complete + ':' + i.naturalWidth : 'none'; })()`;
    const viewMinted = `new Promise((res) => { const i = new Image(); i.onload = () => res('load:' + i.naturalWidth); i.onerror = () => res('error'); i.src = URL.createObjectURL(new Blob([${JSON.stringify(svg)}], { type: 'image/svg+xml' })); })`;
    for (const imgSrc of ['blob:', undefined]) {
        const { wrapped } = await mount(page, { policy: viewPolicy([hashSource(BOOTSTRAP)], { imgSrc }) });
        await init(page, wrapped, body);
        const results = await workerResults(page);
        const r = {
            results, workerMinted: await inView<string>(page, workerMinted, browserName), viewMinted: await inView(page, viewMinted, browserName),
            violations: await inView<string[]>(page, 'globalThis.__violations.map(v => v.directive + " " + v.blocked.slice(0, 5))', browserName),
        };
        log(browserName, `P5 img-src=${imgSrc}`, r);
        expect(r.results.url).toBe('blob:null/UUID');
        if (imgSrc) {
            // all engines: the worker's blob: URL (same opaque origin) loads in the view like the view's own
            expect(r).toMatchObject({ workerMinted: 'true:3', viewMinted: 'load:3', violations: [] });
        } else {
            // without blob: in img-src neither loads, and the view reports both
            expect(r.workerMinted).toMatch(/:0$/);
            expect(r.viewMinted).toBe('error');
            // blockedURI is reported as the scheme alone ("blob") in all three engines
            expect(new Set(r.violations as string[])).toEqual(new Set(['img-src blob']));
        }
    }
});

// ---- P6 ----------------------------------------------------------------------------------------

test('P6 scripts in template content: moved never run; cloned SVG scripts do (Chromium, WebKit)', async ({ page, browserName }) => {
    test.setTimeout(90000);
    const scripts: Record<string, string> = {
        inline: `<script>${M('t-inline')}</script>`,
        copy: `<script>${BOOTSTRAP}</script>`,
        svgInline: `<svg><script>${M('t-svg')}</script></svg>`,
        svgCopy: `<svg><script>${BOOTSTRAP}</script></svg>`,
    };
    const all = Object.values(scripts).join('') + '<div id="later"></div>';
    const results: Record<string, any> = {};
    const render = async (html: string, opts: Record<string, unknown>) => {
        const { wrapped } = await mount(page);
        await init(page, wrapped, renderOnce(html, 800), opts);
        await page.waitForTimeout(800);
        // re-insert every script element elsewhere: an already-started script never runs again
        const moved = await inView<number>(page, `(() => { const s = Array.from(document.querySelectorAll('script')); const t = document.getElementById('later') || document.body; s.forEach((e) => t.appendChild(e)); return s.length; })()`, browserName);
        await page.waitForTimeout(300);
        return { markers: await markers(page, browserName), moved, violations: await inView<string[]>(page, 'globalThis.__violations.map(v => v.directive)', browserName) };
    };
    results.moved = await render(all, { stripScripts: false });
    results.movedSync = await render(all, { stripScripts: false, sync: true });
    results.design = await render(all, {});
    for (const [name, html] of Object.entries(scripts)) results[`cloned-${name}`] = await render(html, { stripScripts: false, clone: true });
    log(browserName, 'P6', results);

    // Moving template content into the view (the design): no script runs — not the inline ones, not the
    // hash-admitted copy, not SVG <script> — and none is even checked against the policy, also after being
    // re-inserted elsewhere. All engines.
    for (const k of ['moved', 'movedSync']) expect(results[k]).toEqual({ markers: [`${VIEW}:bootstrap`], moved: 5, violations: [] });
    // the design strips them: only the bootstrap's own script element remains
    expect(results.design).toEqual({ markers: [`${VIEW}:bootstrap`], moved: 1, violations: [] });

    // document.importNode(template.content, true), measured per script: in Chromium and WebKit the cloned
    // SVG <script> elements are fresh — the inline one is checked against the policy and refused, and the
    // hash-admitted copy RUNS in the view. Cloned HTML <script> elements stay inert (no run, no check).
    // Firefox runs and checks none.
    const cloning = browserName !== 'firefox';
    expect(results['cloned-inline']).toMatchObject({ markers: [`${VIEW}:bootstrap`], violations: [] });
    expect(results['cloned-copy']).toMatchObject({ markers: [`${VIEW}:bootstrap`], violations: [] });
    expect(results['cloned-svgInline']).toMatchObject({ markers: [`${VIEW}:bootstrap`], violations: cloning ? ['script-src-elem'] : [] });
    expect(results['cloned-svgCopy'].markers).toEqual(cloning ? [`${VIEW}:bootstrap`, `${VIEW}:bootstrap`] : [`${VIEW}:bootstrap`]);
});

// ---- P7 ----------------------------------------------------------------------------------------

/**
 * Host-side meters, in the host page: the largest gap of a 10 ms interval timer (event-loop lag),
 * and host → worker → host round trips on the logic port every 100 ms (the watchdog's path).
 */
const startMeters = (page: Page) => page.evaluate(() => {
    const w = window as any;
    w.meter = { lagMax: 0, last: performance.now(), pingMax: 0, pings: 0, noPong: 0, on: true };
    w.meterTimer = setInterval(() => { const now = performance.now(); w.meter.lagMax = Math.max(w.meter.lagMax, now - w.meter.last - 10); w.meter.last = now; }, 10);
    (async () => {
        while (w.meter.on) {
            const rtt = await w.ping(5000);
            if (typeof rtt === 'number') { w.meter.pingMax = Math.max(w.meter.pingMax, rtt); w.meter.pings++; } else w.meter.noPong++;
            await new Promise(r => setTimeout(r, 100));
        }
    })();
});
const stopMeters = (page: Page) => page.evaluate(() => {
    const w = window as any;
    w.meter.on = false;
    clearInterval(w.meterTimer);
    return { hostLagMaxMs: Math.round(w.meter.lagMax), workerPingMaxMs: Math.round(w.meter.pingMax), pings: w.meter.pings, noPong: w.meter.noPong };
});

/** Worker body: renders `expr` with one render in flight (waits for VIEW_ACK), for `ms`. */
const ackedFlood = (expr: string, ms: number) => `async function main() {
    const html = ${expr}; let ack = null; onRender((m) => { if (m.type === 'VIEW_ACK' && ack) ack(); });
    const end = performance.now() + ${ms}; let n = 0;
    while (performance.now() < end) { post(html + '<!--' + n + '-->'); n++; await new Promise((r) => { ack = r; }); }
    report('rendered', n);
}`;

const ONE_WORD_1MIB = `'<p>' + 'x'.repeat(1048576 - 32) + '</p>'`;
const MARKUP_1MIB = `'<p>The quick brown fox jumps over the lazy dog, again and again.</p>'.repeat(14900)`; // ≈ 1 MiB
const ONE_WORD_64KIB = `'<p>' + 'x'.repeat(65536 - 32) + '</p>'`;

test('P7 render flood: host responsiveness while the worker renders as fast as it can', async ({ page, browserName }) => {
    test.setTimeout(180000);
    const m: Record<string, any> = {};

    // (a) a burst of 200 x 1 MiB renders, no flow control: the view coalesces to one apply per frame
    {
        const { wrapped } = await mount(page);
        await init(page, wrapped, `async function main() { const big = ${ONE_WORD_1MIB}; const t = performance.now(); for (let i = 0; i < 200; i++) post(big); report('postMs', Math.round(performance.now() - t)); }`);
        await startMeters(page);
        const t0 = Date.now();
        let stats: any;
        for (;;) {
            stats = await inView(page, 'globalThis.__stats', browserName);
            if (stats.received >= 200 || Date.now() - t0 > 60000) break;
            await page.waitForTimeout(50);
        }
        const drainMs = Date.now() - t0;
        await page.waitForTimeout(1000);
        m.burst = { ...(await workerResults(page)), stats, drainMs, ...(await stopMeters(page)) };
    }
    // (b–d) one render in flight (acknowledged), 3 s each
    for (const [key, expr] of Object.entries({ ackedOneWord1MiB: ONE_WORD_1MIB, ackedMarkup1MiB: MARKUP_1MIB, ackedOneWord64KiB: ONE_WORD_64KIB })) {
        const { wrapped } = await mount(page);
        await init(page, wrapped, ackedFlood(expr, 3000), { ack: true });
        await startMeters(page);
        const results = await workerResults(page, 30000);
        m[key] = { ...results, ...(await stopMeters(page)) };
    }
    // (e) an endless flood (256 KiB, no flow control), stopped by the host removing the frame
    {
        const { wrapped } = await mount(page);
        await init(page, wrapped, `async function main() { const big = '<p>' + 'x'.repeat(262144) + '</p>'; for (;;) post(big); }`);
        await page.waitForTimeout(1500);
        const t = Date.now();
        await page.evaluate(() => document.getElementById('outer')!.remove());
        const removeMs = Date.now() - t;
        await page.evaluate(() => {
            const w = window as any;
            w.meter = { lagMax: 0, last: performance.now() };
            w.meterTimer = setInterval(() => { const now = performance.now(); w.meter.lagMax = Math.max(w.meter.lagMax, now - w.meter.last - 10); w.meter.last = now; }, 10);
        });
        await page.waitForTimeout(1500);
        m.endless = { removeMs, hostLagAfterMs: Math.round(await page.evaluate(() => (window as any).meter.lagMax)) };
    }
    log(browserName, 'P7', m);

    // All engines: every render arrives; the view applies only a handful (latest wins per frame);
    // removing the frame stops an endless flood and the host is quiet afterwards. The removal itself
    // took ≤ ~20 ms in Chromium and Firefox, but 0.17–2.7 s of blocked host thread in WebKit.
    expect(m.burst.stats.received).toBe(200);
    expect(m.burst.stats.applied).toBeLessThanOrEqual(20);
    expect(m.endless.removeMs).toBeLessThan(browserName === 'webkit' ? 5000 : 1000);
    expect(m.endless.hostLagAfterMs).toBeLessThan(250);

    if (browserName === 'chromium') {
        // measured: the sandboxed frames run out of process — host lag ≤ ~30 ms in every case
        for (const k of ['burst', 'ackedOneWord1MiB', 'ackedMarkup1MiB', 'ackedOneWord64KiB']) {
            expect(m[k].hostLagMaxMs, k).toBeLessThan(150);
            expect(m[k].workerPingMaxMs, k).toBeLessThan(500);
        }
    } else if (browserName === 'firefox') {
        // measured: the view shares the host's thread; one 1 MiB apply ≈ 150–265 ms of host lag; the
        // unacknowledged burst holds the worker round trip at 0.85–1.1 s; 64 KiB renders ≈ 15–55 ms
        expect(m.burst.workerPingMaxMs).toBeGreaterThan(500);
        for (const k of ['ackedOneWord1MiB', 'ackedMarkup1MiB']) {
            expect(m[k].hostLagMaxMs, k).toBeGreaterThan(100);
            expect(m[k].hostLagMaxMs, k).toBeLessThan(1000);
        }
        expect(m.ackedOneWord64KiB.hostLagMaxMs).toBeLessThan(150);
    } else {
        // measured: the view shares the host's thread; ONE 1 MiB single-word apply blocks the host for
        // ≈ 1.2–1.6 s even with one render in flight; 1 MiB of ordinary markup ≈ 0.3–0.43 s; a 64 KiB
        // single word ≈ 0.12–0.2 s
        expect(m.burst.hostLagMaxMs).toBeGreaterThan(500);
        expect(m.ackedOneWord1MiB.hostLagMaxMs).toBeGreaterThan(500);
        expect(m.ackedMarkup1MiB.hostLagMaxMs).toBeGreaterThan(150);
        expect(m.ackedOneWord64KiB.hostLagMaxMs).toBeGreaterThan(50);
    }
});

// ---- P8 ----------------------------------------------------------------------------------------

test('P8 Referer from rendered markup and a rendered nested frame asking for unsafe-url', async ({ page, browserName }) => {
    // cross: https://127.0.0.1:<port> (cross-site to the host page http://localhost:4466, or STRICT_PROBE_PORT)
    // local: https://localhost:<port> (same host name as the host page)
    const targets = { cross: listener.origin, local: listener.localOrigin };
    const imgSrc = `${listener.origin} ${listener.localOrigin}`;
    const imgs = (prefix: string, attr = '') => Object.entries(targets).map(([k, o]) => `<img src="${o}/p8-${prefix}-${k}.svg"${attr}>`).join('');
    // path → Referer; a path requested twice (Firefox re-requests some images) must agree with itself
    const referers = () => {
        const seen = new Map<string, Set<string | null>>();
        for (const h of listener.hits) {
            const key = h.path.replace(/^\/p8-|\.svg$/g, '');
            seen.set(key, (seen.get(key) ?? new Set()).add(h.referer));
        }
        for (const [key, set] of seen) expect(set.size, `${key} sent different Referers`).toBe(1);
        return Object.fromEntries([...seen].map(([key, set]) => [key, [...set][0]!]));
    };
    const distinctPaths = () => new Set(listener.hits.map(h => h.path)).size;
    const r: Record<string, Record<string, string | null>> = {};

    for (const forceSandbox of [true, false]) {
        listener.clear();
        const html = imgs('view-default') + imgs('view-attr', ' referrerpolicy="unsafe-url"')
            + `<iframe name="p8" ${srcdoc(`<meta name="referrer" content="unsafe-url">${imgs('nested-meta')}${imgs('nested-attr', ' referrerpolicy="unsafe-url"')}`)}></iframe>`;
        const { wrapped } = await mount(page, { policy: viewPolicy([hashSource(BOOTSTRAP)], { imgSrc }) });
        await init(page, wrapped, renderOnce(html, 500), { forceSandbox });
        await expect.poll(distinctPaths, { timeout: 5000 }).toBe(8);
        r[`forceSandbox=${forceSandbox}`] = referers();
    }
    // a <meta name=referrer> rendered into the view body, then images rendered after it
    listener.clear();
    {
        const { wrapped } = await mount(page, { policy: viewPolicy([hashSource(BOOTSTRAP)], { imgSrc }) });
        await init(page, wrapped, `async function main() { post(${JSON.stringify('<meta name="referrer" content="unsafe-url"><div id="x"></div>')}); await sleep(300); post(${JSON.stringify(imgs('view-after-meta'))}, 'x'); await sleep(800); }`);
        await expect.poll(distinctPaths, { timeout: 5000 }).toBe(2);
        r.viewMeta = referers();
    }
    // control: the host page itself asking for unsafe-url — what each engine sends at most
    listener.clear();
    for (const [k, o] of Object.entries(targets)) {
        await page.evaluate(([o, k]) => new Promise(res => { const i = new Image(); i.referrerPolicy = 'unsafe-url'; i.onload = i.onerror = res; i.src = `${o}/p8-host-control-${k}.svg`; }), [o, k]);
    }
    r.hostControl = referers();
    log(browserName, 'P8', r);

    // the host page URL, path and query included (mount=<n> differs per mount); the server's port is the config's
    const port = Number(process.env.STRICT_PROBE_PORT || 4466);
    const hostUrl = expect.stringMatching(new RegExp(`^http://localhost:${port}/host\\.html\\?secret=HOST-SECRET-PATH&mount=\\d+$`));
    const origin = `http://localhost:${port}/`;
    // the control: Chromium sends the full host URL to both; Firefox and WebKit trim cross-site to the origin
    expect(r.hostControl).toEqual({ 'host-control-cross': browserName === 'chromium' ? hostUrl : origin, 'host-control-local': hostUrl });

    for (const key of ['forceSandbox=true', 'forceSandbox=false']) {
        const got = r[key]!;
        // the inherited no-referrer (wrapper <meta>) holds when markup asks for nothing, all engines
        expect([got['view-default-cross'], got['view-default-local']]).toEqual([null, null]);
        for (const a of ['view-attr', 'nested-meta', 'nested-attr']) {
            const pair = [got[`${a}-cross`], got[`${a}-local`]];
            if (browserName === 'chromium') {
                // measured: no Referer at all, whatever the markup asks for
                expect(pair, `${key} ${a}`).toEqual([null, null]);
            } else if (browserName === 'firefox') {
                // measured: the host ORIGIN to both targets (the S15 limit), never the path
                expect(pair, `${key} ${a}`).toEqual([origin, origin]);
            } else {
                // measured: WebKit sends the host page's FULL URL (path and query) to the same-site target,
                // from the view and from a nested frame with sandbox="" alike; the origin cross-site
                expect(pair, `${key} ${a}`).toEqual([origin, hostUrl]);
            }
        }
    }
    // a <meta name=referrer> inserted into the view body changes the view's policy (Firefox, WebKit)
    expect(r.viewMeta).toEqual({
        'view-after-meta-cross': browserName === 'chromium' ? null : origin,
        'view-after-meta-local': browserName === 'chromium' ? null : browserName === 'firefox' ? origin : hostUrl,
    });
});
