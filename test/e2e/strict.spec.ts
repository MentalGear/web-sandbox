import { test, expect, type SandboxDriver } from './fixture';
import { useRecorder } from './recorder';
import { clickInSandbox, inFrames, inView, waitInView } from './strict-view';
import type { SandboxConfig } from '@src/host';

/**
 * Strict mode (ADR-005; backlog S6, S13, S17). Guest code runs only in a worker; the view document runs only
 * the library's bootstrap, admitted by its hash, and shows what the worker renders through
 * sandboxView.render(). Guarantees asserted here, per engine:
 *   G1  no guest script runs in any document: rendered markup never runs (inline, handlers, SVG script,
 *       javascript: URLs), and every nested browsing context and document-level control is REMOVED before
 *       insertion (A1) — asserted absent, not merely inert — including copies of the hashed bootstrap;
 *   G2  guest logic is confined to the worker: no Worker, SharedWorker, WebAssembly (without scriptUnsafe),
 *       URL.createObjectURL or RTCPeerConnection there, and no frame or document to reach;
 *   G4  no navigation: link and submit defaults are cancelled, and nothing reaches a listener;
 *   A5  a view that stops answering ends the sandbox with a reason;
 *   A8  the view shows only blob: URLs it minted itself, for registered files;
 *   and the entry contract: an entry that fails to start ends the sandbox; a later error does not.
 * Evidence (T5): what ran and what exists is read from every document from outside (strict-view.ts, never
 * through the library); violations as the host dispatches them; network on the recorder's listeners, with
 * positive controls in this file.
 */

const recorder = useRecorder();

/** A script-run marker: pushes `name` onto globalThis.__ran of the document it runs in. */
const M = (name: string) => `(globalThis.__ran=globalThis.__ran||[]).push('${name}')`;
const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const srcdoc = (doc: string) => `srcdoc="${escapeAttribute(doc)}"`;
const at = (left: number, top: number) => `position:absolute;left:${left}px;top:${top}px;width:80px;height:40px;display:block;margin:0`;

const strict = (config: Partial<SandboxConfig> = {}): Partial<SandboxConfig> => ({ mode: 'strict', ...config });

/** Renders from the worker (execute() runs there) and waits until the view shows `doneId`. */
async function render(sandbox: SandboxDriver, browserName: string, html: string, doneId = 'done', into: string | null = null) {
    await sandbox.run(`sandboxView.render(${JSON.stringify(html + `<p id="${doneId}">done</p>`)}, ${JSON.stringify(into)})`);
    // through the prototype: rendered markup may clobber document.getElementById (see the clobbering test)
    await waitInView(sandbox.page, browserName, `!!Document.prototype.getElementById.call(document, ${JSON.stringify(doneId)})`, 8000);
}

/** Every script-run marker on the page, as "path:marker", read from outside. */
async function markers(sandbox: SandboxDriver, browserName: string): Promise<string[]> {
    const states = await inFrames<string[]>(sandbox.page, browserName, '(globalThis.__ran || [])');
    return states.flatMap(s => (s.value === 'no-context' ? [] : s.value.map(m => `${s.path}:${m}`)));
}

const REMOVED = ['iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe', 'script', 'meta', 'base', 'noscript', 'template', 'link'];

// ---- G1: rendered markup never runs, and frames / controls are absent ---------------------------------

test.describe('G1 rendered markup', () => {
    test('a script corpus rendered into the view: nothing runs anywhere, every frame and document-level control is absent, refusals are reported as view violations (A6; the labels and caps: violations.spec.ts)', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(strict({ connectionsAllowed: { 'img-src': [recorder.allowed] } }))).toBe('ready');
        const bootstrap = await inView<string>(page, browserName, `document.head.querySelector('script').textContent`);
        expect(typeof bootstrap === 'string' && bootstrap.length > 1000).toBe(true);

        const corpus = [
            `<script>${M('inline')}</script>`,
            `<img id="img-handler" src="data:," onerror="${M('onerror')}">`,
            `<svg onload="${M('svg-onload')}"><script>${M('svg-script')}</script><script href="data:text/javascript,${M('svg-script-href')}"></script></svg>`,
            `<details open ontoggle="${M('ontoggle')}"><summary>s</summary></details>`,
            `<a id="jslink" href="javascript:${M('javascript-link')}" style="${at(0, 0)}">js</a>`,
            // the hash-admitted bootstrap, verbatim, as HTML and SVG script and inside a frame
            `<script>${bootstrap}</script>`,
            `<svg><script>${bootstrap}</script></svg>`,
            `<iframe ${srcdoc(`<script>${bootstrap}</script>`)}></iframe>`,
            // nested browsing contexts, any depth and namespace
            `<iframe ${srcdoc(`<script>${M('frame-inline')}</script><iframe ${srcdoc(`<script>${M('grandchild')}</script>`)}></iframe>`)}></iframe>`,
            `<iframe src="javascript:${M('javascript-frame')}"></iframe>`,
            `<iframe src="${recorder.blocked}/frame"></iframe>`,
            `<svg><foreignObject><iframe ${srcdoc(`<script>${M('foreign-object')}</script>`)}></iframe></foreignObject></svg>`,
            `<math><iframe></iframe><annotation-xml encoding="text/html"><iframe ${srcdoc(`<script>${M('math')}</script>`)}></iframe></annotation-xml></math>`,
            `<object data="data:text/html,<script>${M('object')}</script>"></object>`,
            `<embed src="data:text/html,<script>${M('embed')}</script>">`,
            '<frameset><frame></frameset><portal src="about:blank"></portal><fencedframe></fencedframe>',
            // document-level controls
            `<meta http-equiv="refresh" content="0;url=javascript:${M('refresh')}">`,
            `<meta http-equiv="refresh" content="0;url=${recorder.blocked}/refresh">`,
            '<meta name="referrer" content="unsafe-url">',
            `<meta http-equiv="Content-Security-Policy" content="script-src *">`,
            `<base href="${recorder.blocked}/">`,
            `<link rel="prefetch" href="${recorder.blocked}/prefetch"><link rel="preload" as="image" href="${recorder.blocked}/preload.svg"><link rel="stylesheet" href="${recorder.blocked}/sheet.css"><link rel="dns-prefetch" href="${recorder.blocked}">`,
            `<noscript><img src="${recorder.blocked}/noscript.svg"></noscript>`,
            `<template><script>${M('template')}</script></template><template shadowrootmode="open"><script>${M('shadow')}</script></template>`,
            // the positive control for the network channel: an allowed image, rendered
            `<img id="allowed" src="${recorder.allowed}/rendered.svg">`,
        ].join('');
        await render(sandbox, browserName, corpus);
        await recorder.waitFor('allowed', '/rendered.svg');
        await page.waitForTimeout(800);
        await clickInSandbox(page, 20, 20); // the javascript: link: a trusted click
        await page.waitForTimeout(1500);

        // nothing ran, in any document; the view's bootstrap ran exactly once
        expect(await markers(sandbox, browserName)).toEqual([]);
        expect(await inView(page, browserName, 'globalThis.__sandboxViewRuns')).toBe(1);
        // no frame exists below the view
        const frames = (await inFrames(page, browserName, '1')).map(f => f.path);
        expect(frames).toEqual(['main', 'main/wrapper', 'main/wrapper/view']);
        // every removed element type is absent from the view's body; the head is the library's own
        const view = await inView<any>(page, browserName, `({
            removed: Array.from(document.body.querySelectorAll(${JSON.stringify(REMOVED.join(','))})).map(e => e.localName),
            head: Array.from(document.head.children).map(e => e.localName),
            shadowRoots: Array.from(document.querySelectorAll('*')).filter(e => e.shadowRoot).length,
            kept: ['img-handler', 'jslink', 'allowed'].filter(id => document.getElementById(id)),
            url: location.href,
        })`);
        expect(view).toEqual({ removed: [], head: ['meta', 'meta', 'script'], shadowRoots: 0, kept: ['img-handler', 'jslink', 'allowed'], url: 'about:srcdoc' });

        // the refusals the view raised arrived, labelled 'view' (A6): the handler attribute, the data: image
        await sandbox.waitForViolation('script-src-attr', '');
        const reported = (await sandbox.violations()).map(v => `${v.source} ${v.directive}`);
        expect(reported).toContain('view script-src-attr');
        expect(reported).toContain('view img-src');
        // nothing reached the blocked listener; the allowed image did (positive control)
        expect(recorder.paths('blocked')).toEqual([]);
        expect(recorder.paths('allowed')).toEqual(['/rendered.svg']);
    });

    test('DOM clobbering by rendered markup changes nothing the view does: forms and named elements shadowing the methods it uses are still cleaned, links inside them still cancelled, later renders still applied', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(strict())).toBe('ready');
        // Document and HTMLFormElement let named elements override built-ins: document.body, form.hasAttribute …
        const shadow = (names: string[]) => names.map(n => `<input name="${n}">`).join('');
        await render(sandbox, browserName, [
            '<img name="body"><img name="getElementById"><img name="createElement"><img name="documentElement">',
            `<form id="f">${shadow(['getAttributeNames', 'getAttribute', 'localName', 'namespaceURI', 'remove', 'replaceChildren', 'hasAttribute', 'setAttribute', 'removeAttribute', 'id', 'parentNode', 'nodeType', 'contains'])}<iframe></iframe><script>${M('clobber')}</script></form>`,
            `<a href="${recorder.blocked}/clobbered"><form>${shadow(['hasAttribute', 'hasAttributeNS', 'localName', 'parentNode', 'nodeType'])}<span style="${at(0, 0)}">x</span></form></a>`,
        ].join(''));
        expect(await inView(page, browserName, `[Document.prototype.querySelectorAll.call(document, 'body iframe, body script').length, !!Document.prototype.getElementById.call(document, 'f')]`)).toEqual([0, true]);
        await clickInSandbox(page, 20, 20);
        await page.waitForTimeout(1500);
        expect(recorder.paths('blocked')).toEqual([]);
        expect(await inView(page, browserName, 'location.href + " " + globalThis.__sandboxViewRuns')).toBe('about:srcdoc 1');
        await render(sandbox, browserName, '<b>inside the clobbering form</b>', 'into-form', 'f');
        await render(sandbox, browserName, '<p>after</p>', 'after');
        expect(await markers(sandbox, browserName)).toEqual([]);
    });

    test('positive control for the marker channel: the same inline script in a default iframe-mode sandbox runs and is read from outside', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ html: `<script>${M('control')}</script>` })).toBe('ready');
        await expect.poll(() => markers(sandbox, browserName)).toEqual(['main/wrapper/view:control']);
    });

    test('renders replace the body or the element named by `into`; a target outside the body or missing is ignored; the initial html is the first view', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(strict({ html: '<main id="app"><p id="initial">initial</p></main>' }))).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('initial')`);
        await render(sandbox, browserName, '<b>first</b>', 'into-app', 'app');
        expect(await inView(page, browserName, `document.body.innerHTML`)).toBe('<main id="app"><b>first</b><p id="into-app">done</p></main>');
        await sandbox.run(`sandboxView.render('<i>never</i>', 'missing'); sandboxView.render('<p id="last">last</p>')`);
        await waitInView(page, browserName, `!!document.getElementById('last')`);
        expect(await inView(page, browserName, `document.body.innerHTML`)).toBe('<p id="last">last</p>');
    });

    test('sandboxView.render refuses what the view would not apply: html over 256 Ki characters, a non-string, a bad target', async ({ sandbox }) => {
        expect(await sandbox.mount(strict())).toBe('ready');
        const r = await sandbox.inGuest(`
            const attempt = (f) => { try { f(); return 'ok'; } catch (e) { return e.name; } };
            return {
                max: attempt(() => sandboxView.render('x'.repeat(262144))),
                over: attempt(() => sandboxView.render('x'.repeat(262145))),
                nonString: attempt(() => sandboxView.render({ toString() { return '<p>'; } })),
                badTarget: attempt(() => sandboxView.render('<p>', 42)),
                emptyTarget: attempt(() => sandboxView.render('<p>', '')),
                frozen: Object.isFrozen(sandboxView),
            };
        `);
        expect(r).toEqual({ max: 'ok', over: 'RangeError', nonString: 'TypeError', badTarget: 'TypeError', emptyTarget: 'TypeError', frozen: true });
    });
});

// ---- G4: no navigation ----------------------------------------------------------------------------------

test.describe('G4 navigation', () => {
    test('link, area, SVG and MathML links, fragment links and form submits are cancelled: the view stays, nothing reaches the listener', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(strict())).toBe('ready');
        const B = recorder.blocked;
        await render(sandbox, browserName, [
            `<a href="${B}/link" style="${at(0, 0)}">a</a>`,
            `<a href="${B}/blank" target="_blank" style="${at(100, 0)}">blank</a>`,
            `<a href="#fragment" style="${at(200, 0)}">frag</a>`,
            `<svg style="${at(0, 50)}" width="80" height="40"><a href="${B}/svg"><rect width="80" height="40"/></a></svg>`,
            `<svg style="${at(100, 50)}" width="80" height="40"><a><animate attributeName="href" values="${B}/animated" dur="1s" repeatCount="indefinite"/><rect width="80" height="40"/></a></svg>`,
            `<math style="${at(200, 50)}" href="${B}/mathml"><mi>mathml</mi></math>`,
            `<img usemap="#m" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="80" height="40" style="${at(0, 100)}"><map name="m"><area shape="rect" coords="0,0,80,40" href="${B}/area"></map>`,
            `<form action="${B}/form" method="post"><button style="${at(100, 100)}">submit</button></form>`,
            `<form action="${B}/form-get"><input name="q" value="x" style="${at(200, 100)}"></form>`,
        ].join(''));
        for (const [x, y] of [[20, 20], [120, 20], [220, 20], [20, 70], [120, 70], [220, 70], [20, 120], [120, 120]]) {
            await clickInSandbox(page, x!, y!);
            await page.waitForTimeout(150);
        }
        await clickInSandbox(page, 220, 120); // focus the input, then implicit submission
        // Only press Enter once the input has focus: otherwise the key never reaches the form and the
        // "no navigation" assertion below would pass without testing implicit submission at all.
        await waitInView(page, browserName, `document.activeElement && document.activeElement.name === 'q'`);
        await page.keyboard.press('Enter');
        await clickInSandbox(page, 20, 20); // and a middle click on a link
        await page.mouse.click((await page.locator('web-sandbox').boundingBox())!.x + 20, (await page.locator('web-sandbox').boundingBox())!.y + 20, { button: 'middle' });
        await page.waitForTimeout(2000);

        expect(recorder.paths('blocked')).toEqual([]);
        expect(page.context().pages()).toHaveLength(1);
        // the view is the same document, still applying renders
        expect(await inView(page, browserName, 'location.href + " " + globalThis.__sandboxViewRuns')).toBe('about:srcdoc 1');
        await render(sandbox, browserName, '<p>after</p>', 'after');
        expect(await sandbox.state()).toBe('ready');
    });

    test('positive control for the listener and the click: the same link on the host page reaches it', async ({ sandbox, page }) => {
        await page.evaluate((href) => {
            const a = document.createElement('a');
            a.href = href; a.textContent = 'host link'; a.id = 'host-link'; a.target = 'control';
            document.body.prepend(a);
            const frame = document.createElement('iframe'); frame.name = 'control'; document.body.append(frame);
        }, `${recorder.allowed}/host-link`);
        await page.click('#host-link');
        await recorder.waitFor('allowed', '/host-link');
        void sandbox;
    });
});

// ---- G2: the worker ----------------------------------------------------------------------------------------

test.describe('G2 the worker', () => {
    test('guest code runs in a worker with no Worker, SharedWorker, URL.createObjectURL, RTCPeerConnection or document; its location is its own blob: URL', async ({ sandbox }) => {
        expect(await sandbox.mount(strict())).toBe('ready');
        const r = await sandbox.inGuest(`return {
            names: ['Worker', 'SharedWorker', 'WebAssembly', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'document', 'window', 'parent'].filter(n => n in globalThis),
            createObjectURL: typeof URL.createObjectURL,
            onPrototype: 'Worker' in Object.getPrototypeOf(globalThis),
            href: location.href.replace(/[0-9a-f-]{36}$/, 'UUID'),
            importScripts: typeof importScripts,
            sandboxView: typeof sandboxView, bridge: typeof bridge, sandboxFiles: typeof sandboxFiles,
            stringCode: (() => { try { return eval('1 + 1'); } catch (e) { return e.name; } })(),
        }`);
        // scriptUnsafe is on in the baseline config, so eval and WebAssembly stay; the next test turns it off
        expect(r).toEqual({ names: ['WebAssembly'], createObjectURL: 'undefined', onPrototype: false, href: 'blob:null/UUID', importScripts: 'function', sandboxView: 'object', bridge: 'object', sandboxFiles: 'object', stringCode: 2 });
    });

    test('without scriptUnsafe: no eval, Function or WebAssembly in the worker; an entry reports through the bridge', async ({ sandbox, page }) => {
        await sandbox.registerFiles({ 'main.js': `
            const attempt = (f) => { try { return 'ran ' + f(); } catch (e) { return e.name; } };
            bridge.call('report', {
                eval: attempt(() => eval('1 + 1')),
                fn: attempt(() => new Function('return 2')()),
                wasm: typeof WebAssembly,
                worker: typeof Worker,
            });` });
        await sandbox.exposeHost('report', '(value) => { window.strictReport = value; return true; }');
        expect(await sandbox.mount(strict({ scriptUnsafe: false, entry: 'main.js' }))).toBe('ready');
        await page.waitForFunction(() => (window as any).strictReport !== undefined);
        expect(await page.evaluate(() => (window as any).strictReport)).toEqual({ eval: 'EvalError', fn: 'EvalError', wasm: 'undefined', worker: 'undefined' });
    });

    test('importScripts and fetch obey the inherited policy: refused off the allowlist, fetch allowed to connect-src (positive control)', async ({ sandbox }) => {
        expect(await sandbox.mount(strict({ connectionsAllowed: { 'connect-src': [recorder.allowed] } }))).toBe('ready');
        const r = await sandbox.inGuest(`
            let imported;
            try { importScripts('${recorder.blocked}/import.js'); imported = 'ran'; } catch (e) { imported = e.name; }
            const blocked = await fetch('${recorder.blocked}/fetch').then(() => 'reached', (e) => e.name);
            const allowed = await fetch('${recorder.allowed}/fetch').then((r) => r.status, (e) => e.name);
            return { imported, blocked, allowed };
        `);
        expect(r).toEqual({ imported: 'NetworkError', blocked: 'TypeError', allowed: 200 });
        await recorder.waitFor('allowed', '/fetch');
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('the render port is out of guest reach: patching MessagePort, MessageEvent, EventTarget and Function prototypes, and listening for messages, yields no port that reaches the view', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'main.js': `
            const seen = new Set();
            const keep = (port) => { if (port instanceof MessagePort) seen.add(port); };
            const original = MessagePort.prototype.postMessage;
            MessagePort.prototype.postMessage = function (...args) { keep(this); return original.apply(this, args); };
            const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
            Object.defineProperty(MessagePort.prototype, 'onmessage', { configurable: true, get() { return onmessage.get.call(this); }, set(v) { keep(this); onmessage.set.call(this, v); } });
            const ports = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'ports');
            Object.defineProperty(MessageEvent.prototype, 'ports', { configurable: true, get() { const p = ports.get.call(this); p.forEach(keep); return p; } });
            const add = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (...args) { if (this instanceof MessagePort) keep(this); return add.apply(this, args); };
            const reflectApply = Reflect.apply;
            Function.prototype.call = function (self, ...args) { keep(self); return reflectApply(this, self, args); };
            Function.prototype.apply = function (self, args) { keep(self); return reflectApply(this, self, args || []); };
            Reflect.apply = function (f, self, args) { keep(self); return reflectApply(f, self, args); };
            self.addEventListener('message', (e) => { keep(e.ports[0]); keep(e.ports[1]); }, true);
            self.onmessage = (e) => { keep(e.ports[0]); keep(e.ports[1]); };
            globalThis.tryAllPorts = () => {
                for (const port of seen) reflectApply(original, port, [{ type: 'VIEW_RENDER', html: '<p id="bypass">bypass</p>', into: null }]);
                return seen.size;
            };
        ` });
        expect(await sandbox.mount(strict({ entry: 'main.js' }))).toBe('ready');
        await render(sandbox, browserName, '<p>honest</p>', 'honest');
        const tried = await sandbox.inGuest('return tryAllPorts()');
        await page.waitForTimeout(800);
        // the guest saw no port at all: since review B2 the logic port is as far out of reach as the render port
        expect(tried).toBe(0);
        expect(await inView(page, browserName, `!!document.getElementById('bypass')`)).toBe(false);
        await render(sandbox, browserName, '<p>still honest</p>', 'honest-2'); // positive control: the library's path still works
    });
});

// ---- the entry ----------------------------------------------------------------------------------------------

test.describe('the entry', () => {
    test('the entry runs first, as a classic script in a function scope of its own: its top-level declarations are local (review C2), `this` is the global object', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'app.js': `var declared = 'local'; function greet() { return 'hi'; } globalThis.shared = 'global';
            sandboxView.render('<h1 id="title">' + greet() + '</h1>');
            bridge.expose('declared', () => [typeof declared, self.declared, typeof greet, self.shared, this === self]);` });
        expect(await sandbox.mount(strict({ entry: 'app.js' }))).toBe('ready');
        await waitInView(page, browserName, `document.getElementById('title') && document.getElementById('title').textContent === 'hi'`);
        expect(await sandbox.call('declared')).toEqual(['string', undefined, 'function', 'global', true]);
    });

    for (const [label, source] of [['a syntax error', 'let = ;'], ['a throw at its top level', 'throw new Error("entry broke")']] as const) {
        test(`an entry with ${label} ends the sandbox: terminated with "the guest entry failed to start", the error logged`, async ({ sandbox, page }) => {
            await sandbox.registerFiles({ 'bad.js': source });
            await page.evaluate(() => {
                const s = document.querySelector('web-sandbox') as any;
                (window as any).termination = null;
                s.addEventListener('terminated', (e: CustomEvent) => { (window as any).termination = e.detail.reason; }, { once: true });
            });
            await sandbox.mount(strict({ entry: 'bad.js' }));
            await page.waitForFunction(() => (window as any).termination !== null, null, { timeout: 5000 });
            expect(await page.evaluate(() => (window as any).termination)).toBe('the guest entry failed to start');
            expect(await sandbox.state()).toBe('terminated');
            expect(await sandbox.waitForLog('the guest entry failed to start:')).toBeTruthy();
        });
    }

    test('an error after the entry ran is logged and does not end the sandbox', async ({ sandbox, page }) => {
        await sandbox.registerFiles({ 'later.js': `setTimeout(() => { throw new Error('later failure'); }, 50); bridge.expose('alive', () => true);` });
        expect(await sandbox.mount(strict({ entry: 'later.js' }))).toBe('ready');
        expect(await sandbox.waitForLog('later failure')).toContain('Uncaught');
        await page.waitForTimeout(300);
        expect(await sandbox.state()).toBe('ready');
        expect(await sandbox.call('alive')).toBe(true);
    });

    test('an entry that is not a registered JavaScript file ends the build with a reason', async ({ sandbox }) => {
        await sandbox.registerFiles({ 'data.json': '{}' });
        expect(await sandbox.mount(strict({ entry: 'missing.js' }))).toBe('terminated');
        expect(await sandbox.mount(strict({ entry: 'data.json' }))).toBe('terminated');
        expect(await sandbox.page.evaluate(() => new Promise(resolve => {
            const s = document.querySelector('web-sandbox') as any;
            s.addEventListener('terminated', (e: CustomEvent) => resolve(e.detail.reason), { once: true });
            s.setConfig({ mode: 'strict', entry: 'nope.js' });
        }))).toBe('the guest entry "nope.js" is not a registered JavaScript file');
    });
});

// ---- A5: a view that stops answering ----------------------------------------------------------------------

test('A5: a view that is gone (reloaded, so it never gets its ports back) ends the sandbox with "the sandbox view stopped responding"', async ({ sandbox, page, browserName }) => {
    test.setTimeout(30000);
    expect(await sandbox.mount(strict())).toBe('ready');
    await page.evaluate(() => {
        const s = document.querySelector('web-sandbox') as any;
        (window as any).termination = null;
        (window as any).started = performance.now();
        s.addEventListener('terminated', (e: CustomEvent) => { (window as any).termination = { reason: e.detail.reason, after: performance.now() - (window as any).started }; }, { once: true });
    });
    await inView(page, browserName, 'location.reload()');
    await page.waitForFunction(() => (window as any).termination !== null, null, { timeout: 12000 });
    const termination = await page.evaluate(() => (window as any).termination);
    expect(termination.reason).toBe('the sandbox view stopped responding');
    // VIEW_LIVENESS_TIMEOUT_MS (5 s): between one and 1.25 budgets after the last answer, plus slack
    expect(termination.after).toBeLessThan(5000 * 1.25 + 2000);
});

// ---- files in the view (A8, ADR-004 amendment) ------------------------------------------------------------

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="5"></svg>';

test.describe('files', () => {
    test('rendered markup names registered files by path: the view mints its own blob: URLs for images and stylesheets (with their url() references); the worker gets every file through sandboxFiles', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({
            'img/logo.svg': SVG,
            'css/site.css': '#styled { width: 7px; height: 9px; display: block; background: url(../img/logo.svg); }',
            'lib.js': 'export const x = 1;',
            'data.json': '{"answer":42}',
        });
        expect(await sandbox.mount(strict())).toBe('ready');
        await render(sandbox, browserName, '<link rel="stylesheet" href="css/site.css"><img id="logo" src="./img/logo.svg"><i id="styled"></i><img id="unregistered" src="img/missing.svg">');
        await waitInView(page, browserName, `document.getElementById('logo').complete && document.getElementById('logo').naturalWidth === 3`);
        const r = await inView<any>(page, browserName, `({
            logo: document.getElementById('logo').getAttribute('src').slice(0, 10),
            sheet: document.querySelector('link').getAttribute('href').slice(0, 10),
            styled: getComputedStyle(document.getElementById('styled')).width,
            unregistered: document.getElementById('unregistered').getAttribute('src'),
            viewFiles: sandboxFiles.list(),
        })`);
        // the view holds no JavaScript file
        expect(r).toEqual({ logo: 'blob:null/', sheet: 'blob:null/', styled: '7px', unregistered: 'img/missing.svg', viewFiles: ['css/site.css', 'data.json', 'img/logo.svg'] });
        const worker = await sandbox.inGuest(`return { list: sandboxFiles.list(), json: JSON.parse(await sandboxFiles.text('data.json')).answer, url: sandboxFiles.url('lib.js').slice(0, 10) }`);
        expect(worker).toEqual({ list: ['css/site.css', 'data.json', 'img/logo.svg', 'lib.js'], json: 42, url: 'blob:null/' });
        expect((await sandbox.violations()).filter(v => v.source === 'view')).toEqual([]);
    });

    test('A8: a blob: URL the view did not mint is removed from rendered markup, wherever it appears; the policy has blob: only where a registered type needs it, never in script-src', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'img/logo.svg': SVG, 'app.js': 'void 0' });
        expect(await sandbox.mount(strict())).toBe('ready');
        const workerUrl = await sandbox.inGuest(`return sandboxFiles.url('img/logo.svg')`);
        await render(sandbox, browserName, `<img id="w" src="${workerUrl}"><img id="t" src=" b\tlob:${workerUrl.slice(5)}"><a id="a" href="${workerUrl}">x</a><img id="ok" src="img/logo.svg">`);
        const r = await inView<any>(page, browserName, `({
            w: document.getElementById('w').hasAttribute('src'), t: document.getElementById('t').hasAttribute('src'),
            a: document.getElementById('a').getAttribute('href'), ok: document.getElementById('ok').getAttribute('src').startsWith('blob:'),
            policy: document.querySelector('meta[http-equiv]').content,
        })`);
        expect(r).toMatchObject({ w: false, t: false, a: 'about:blank#', ok: true }); // a link's href is the inert constant (S24)
        expect(r.policy).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=' 'unsafe-eval'; /);
        expect(r.policy).not.toMatch(/script-src[^;]*blob:/);
        expect(r.policy).toContain('img-src blob:');
    });
});

// ---- configuration ----------------------------------------------------------------------------------------

test.describe('configuration', () => {
    test('sandbox flags are allow-scripts allow-forms plus safe capabilities; unsafe capabilities are dropped with one warning; a configured script-src is replaced with one', async ({ sandbox, page }) => {
        const warnings: string[] = [];
        page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
        expect(await sandbox.mount(strict({ capabilities: ['allow-pointer-lock'], unsafeCapabilities: ['allow-popups', 'fullscreen'], connectionsAllowed: { 'script-src': ['https://cdn.example'] } }))).toBe('ready');
        expect(await sandbox.reset()).toBe('ready');
        const attributes = await page.evaluate(() => {
            const frame = (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe') as HTMLIFrameElement;
            const inner = new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('iframe')!;
            return { outer: frame.getAttribute('sandbox'), inner: inner.getAttribute('sandbox'), allow: frame.getAttribute('allow'), innerAllow: inner.getAttribute('allow') };
        });
        expect(attributes).toEqual({ outer: 'allow-scripts allow-forms allow-pointer-lock', inner: 'allow-scripts allow-forms allow-pointer-lock', allow: null, innerAllow: null });
        expect(warnings.filter(w => w.includes('not available in strict mode'))).toHaveLength(1);
        expect(warnings.filter(w => w.includes('"connectionsAllowed.script-src" is fixed in strict mode'))).toHaveLength(1);
    });

    test('fetchBridge: sandboxFetch works from the worker (B5), each request logged', async ({ sandbox }) => {
        expect(await sandbox.mount(strict({ fetchBridge: { allow: [recorder.allowed] } }))).toBe('ready');
        const r = await sandbox.inGuest(`const response = await sandboxFetch('${recorder.allowed}/bridged'); return { status: response.status, direct: await fetch('${recorder.blocked}/direct').then(() => 'reached', e => e.name) };`);
        expect(r).toEqual({ status: 200, direct: 'TypeError' });
        await recorder.waitFor('allowed', '/bridged');
        expect((await sandbox.waitForFetch(`${recorder.allowed}/bridged`)).outcome).toBe('ok');
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('autoResize: the view reports its height (B6); the worker cannot post a RESIZE on the logic port', async ({ sandbox, page, browserName }) => {
        await page.addStyleTag({ content: 'web-sandbox { height: 50px }' });
        expect(await sandbox.mount(strict({ autoResize: true }))).toBe('ready');
        await render(sandbox, browserName, '<div style="height: 420px"></div>', 'tall');
        await expect.poll(() => page.evaluate(() => (document.querySelector('web-sandbox') as HTMLElement).getBoundingClientRect().height), { timeout: 5000 }).toBeGreaterThan(420);
        const before = await page.evaluate(() => (document.querySelector('web-sandbox') as HTMLElement).style.height);
        // only the view's reports count; the worker cannot even reach its own (logic) port to post one (review B2)
        await sandbox.run(`globalThis.__port = null; const o = MessagePort.prototype.postMessage; MessagePort.prototype.postMessage = function (m, ...r) { globalThis.__port = this; this.postMessage = o; return o.call(this, m, ...r); }; console.log('forge')`);
        await sandbox.waitForLog('forge');
        expect(await sandbox.inGuest('return globalThis.__port')).toBeNull();
        await page.waitForTimeout(400);
        expect(await page.evaluate(() => (document.querySelector('web-sandbox') as HTMLElement).style.height)).toBe(before);
    });

    test('workerExecutionTimeout terminates the sandbox when executed code is still running in strict mode too; reset() recovers', async ({ sandbox }) => {
        expect(await sandbox.mount(strict({ workerExecutionTimeout: 300 }))).toBe('ready');
        await sandbox.run('while (true) {}');
        expect(await sandbox.waitForLog('Execution Timeout', 4000)).toBeTruthy();
        await expect.poll(() => sandbox.state(), { timeout: 4000 }).toBe('terminated');
        expect(await sandbox.reset()).toBe('ready');
    });
});
