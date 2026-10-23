import { test, expect, HARNESS, OFFSITE_ORIGIN, ORIGIN, type SandboxDriver } from './fixture';
import type { SandboxConfig } from '@src/host';
import type { OriginKind } from '@src/lib/csp/origins';
import { useRecorder, wss } from './recorder';

/**
 * Precondition probe for "δ blob-URL files" (docs/archive/research/blob-delivery-probe.md): the host pushes
 * file contents over the broker and the guest turns each into a blob: URL created in its OWN realm,
 * plus an import map so module specifiers resolve to those URLs. These specs pin, per engine, what
 * that design relies on:
 *   1. today's default CSP refuses every guest-created blob: subresource (only worker-src lists blob:)
 *   2. adding `blob:` to five directives admits them, in cooperative and worker mode
 *   3. which module-resolution scheme works in all three engines
 *   4. a blob: URL never crosses realms (host -> guest, guest -> host, guest -> guest)
 *   5a. the guest policy never contains 'self' (backlog S14), in cooperative and worker mode
 *   5. `blob:` adds no egress: blob-loaded code runs under the same CSP, and a blob: document can
 *      neither replace the guest frame nor open a new browsing context
 *   6. strict MIME checking applies to blob responses (replaces C2's MIME defect)
 * Where engines differ, each engine's measured behaviour is asserted explicitly, never skipped.
 * Tests describe the GUARANTEE each case proves.
 */

// The policy δ needs: blob: for five kinds of load (worker-src always lists it). It is the library's own template
// (src/lib/csp/csp-generator.ts) with blob: for those kinds, exactly as registered files of those types make it; no
// config can add blob: (ADR-007). The probes set it on the page's element class without registering files, so that
// no import map of the library's joins the probes' own (section 3), and a probe's blob: URLs are its own.
const DELTA_KINDS: OriginKind[] = ['scripts', 'styles', 'images', 'fonts', 'connect'];

async function withBlob(sandbox: SandboxDriver, kinds: OriginKind[] = DELTA_KINDS) {
    await sandbox.page.evaluate(async (kinds) => {
        const { cooperativePolicy } = await import('/src/lib/csp/csp-generator.ts' as string);
        const element = customElements.get('web-sandbox')!.prototype as any;
        element._guestPolicy = function (this: any) {
            return cooperativePolicy({ origins: this._origins, fileKinds: new Set(kinds), scriptUnsafe: this._config.scriptUnsafe === true });
        };
    }, kinds);
}

/** Mounts with the δ policy: blob: for `kinds` (default: all five). */
async function mountWithBlob(sandbox: SandboxDriver, config: SandboxConfig = {}, kinds: OriginKind[] = DELTA_KINDS) {
    await withBlob(sandbox, kinds);
    return sandbox.mount(config);
}

// An origin no config allowlists; matched in any scheme.

// A 304-byte WOFF2 with one glyph ("A", 4 em wide), generated for this spec with fontTools'
// FontBuilder. The width tells "font applied" apart from "fallback font".
const FONT_WOFF2_B64 = 'd09GMgABAAAAAAEwAAoAAAAAAowAAADpAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANAowQgE2AiQDCAsGAAQgBWYHJhvjARAeB7k56pLDFCnWfE6J578/zHP/f1tT6ngFDnWwCAZ8TZYgDTMhaNyqblM8Hs/b4xOfzkgaEQTCoMQRhHx63CIIsOXalgQeGBRwFlAEpwsdDrqxs2Q52OSYo80T9fFdNlCKAjhOccr7FpjfArglGzo2u8GmsoVSgtP/f+383wiABgoNYywCCkSqMljisVm5eLng4osLIAjnu82mHbyOe3+E++ensUcr83aBroHQt/6xMgceIFpe8pWgKQFNi7KfhzFBQDMy0aUmYt2qUWmW7ZyxC3ea/aR+QAK1AsO1QYLjexZS6O57AA==';

type Probe = [label: string, kind: string, options?: Record<string, unknown>];

/**
 * Installed in the guest realm (document or worker) by execute(). Each probe creates its blob in
 * the guest's own realm (unless given a `url`) and settles to 'ok' or a failure string; any CSP
 * violation it caused is appended as ' csp=<effectiveDirective>' (inside a worker, engines differ in
 * which violations they deliver to the worker's own listener; see section 1).
 */
function installGuestProbes(fontB64: string) {
    const g: any = globalThis;
    const violations: string[] = [];
    g.addEventListener('securitypolicyviolation', (e: any) => violations.push(e.effectiveDirective));
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const blob = (body: BlobPart, type: string) => URL.createObjectURL(new Blob([body], { type }));
    const error = (e: any) => 'error:' + (e && e.name ? e.name : String(e));
    let n = 0;

    const kinds: Record<string, (o: any) => Promise<string>> = {
        script: ({ module = false, type = 'text/javascript', url }) => new Promise(resolve => {
            const key = '__probeScript' + (++n);
            const s = document.createElement('script');
            if (module) s.type = 'module';
            s.src = url || blob(`globalThis.${key} = 1;`, type);
            s.onload = () => setTimeout(() => resolve(url || g[key] === 1 ? 'ok' : 'loaded-not-run'), 20);
            s.onerror = () => resolve('error');
            document.head.appendChild(s);
        }),
        dynamicImport: async ({ type = 'text/javascript', url }) => {
            try {
                const m = await import(url || blob('export const v = 1;', type));
                return url || m.v === 1 ? 'ok' : 'bad-module';
            } catch (e) { return error(e); }
        },
        stylesheet: ({ type = 'text/css', url }) => new Promise(resolve => {
            const id = 'probe' + (++n);
            const d = document.createElement('div'); d.id = id; document.body.appendChild(d);
            const l = document.createElement('link'); l.rel = 'stylesheet';
            l.href = url || blob(`#${id} { width: 123px; }`, type);
            l.onload = () => resolve(url || getComputedStyle(d).width === '123px' ? 'ok' : 'loaded-not-applied');
            l.onerror = () => resolve('error');
            document.head.appendChild(l);
        }),
        image: ({ type = 'image/svg+xml', url }) => new Promise(resolve => {
            const i = new Image();
            i.onload = () => resolve(url || i.naturalWidth === 7 ? 'ok' : 'wrong-size');
            i.onerror = () => resolve('error');
            i.src = url || blob('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"></svg>', type);
        }),
        font: async ({ type = 'font/woff2' }) => {
            const family = 'probefont' + (++n);
            const bytes = Uint8Array.from(atob(fontB64), c => c.charCodeAt(0));
            const style = document.createElement('style');
            style.textContent = `@font-face { font-family: ${family}; src: url(${blob(bytes, type)}); }`;
            document.head.appendChild(style);
            const span = document.createElement('span');
            span.style.cssText = `font: 16px ${family}, monospace`;
            span.textContent = 'A';
            document.body.appendChild(span);
            try { await document.fonts.load(`16px ${family}`); } catch (e) { return error(e); }
            const face = [...(document.fonts as any)].find((f: any) => f.family.replace(/"/g, '') === family);
            // the glyph is 64px wide at 16px; any fallback font is far narrower
            return face?.status === 'loaded' && span.getBoundingClientRect().width > 50 ? 'ok' : 'error:' + face?.status;
        },
        fetch: async ({ url }) => {
            try { return 'ok:' + (await (await fetch(url || blob('hello', 'text/plain'))).text()); }
            catch (e) { return error(e); }
        },
        xhr: ({ url }) => new Promise(resolve => {
            try {
                const x = new XMLHttpRequest();
                x.open('GET', url);
                x.onload = () => resolve('ok:' + x.responseText);
                x.onerror = () => resolve('error');
                x.send();
            } catch (e) { resolve(error(e)); }
        }),
        worker: ({ module = false, url }) => new Promise(resolve => {
            try {
                const w = new Worker(url || blob('postMessage("up")', 'text/javascript'), { type: module ? 'module' : 'classic' });
                w.onmessage = () => { resolve('ok'); w.terminate(); };
                w.onerror = (e: any) => { e.preventDefault?.(); resolve('error'); };
            } catch (e) { resolve(error(e)); }
        }),
        importScripts: async ({ type = 'text/javascript', url }) => {
            const key = '__probeImported' + (++n);
            try {
                g.importScripts(url || blob(`globalThis.${key} = 1;`, type));
                return url || g[key] === 1 ? 'ok' : 'not-run';
            } catch (e) { return error(e); }
        },
    };

    g.__runProbes = async (probes: [string, string, any][]) => {
        const results: Record<string, string> = {};
        for (const [label, kind, options] of probes) {
            const before = violations.length;
            let result = await Promise.race([kinds[kind]!(options || {}), sleep(4000).then(() => 'timeout')]);
            await sleep(80); // violation events are queued as tasks
            const seen = [...new Set(violations.slice(before))];
            if (seen.length) result += ' csp=' + seen.join(',');
            results[label] = result;
        }
        return results;
    };
}

let probeRun = 0;
async function runProbes(sandbox: any, probes: Probe[]): Promise<Record<string, string>> {
    const tag = `PROBES_${++probeRun} `;
    await sandbox.run(`(${installGuestProbes.toString()})(${JSON.stringify(FONT_WOFF2_B64)});
        __runProbes(${JSON.stringify(probes)}).then(r => console.log(${JSON.stringify(tag)} + JSON.stringify(r)));`);
    const line: string = await sandbox.waitForLog(tag, 60000);
    return JSON.parse(line.slice(tag.length));
}

// ---- 1 + 2: which loads the policy admits ----------------------------------------------------

const IFRAME_LOADS: Probe[] = [
    ['classic <script src>', 'script'],
    ['<script type=module src>', 'script', { module: true }],
    ['import()', 'dynamicImport'],
    ['<link rel=stylesheet>', 'stylesheet'],
    ['<img> (svg)', 'image'],
    ['@font-face (woff2)', 'font'],
    ['fetch()', 'fetch'],
    ['new Worker() classic', 'worker'],
    ['new Worker() module', 'worker', { module: true }],
];

const WORKER_LOADS: Probe[] = [
    ['importScripts()', 'importScripts'],
    ['import()', 'dynamicImport'],
    ['fetch()', 'fetch'],
    ['nested Worker classic', 'worker'],
    ['nested Worker module', 'worker', { module: true }],
];

// Chromium refuses a MODULE worker whose blob: URL was created in an opaque-origin document, under
// any policy (a bare error event, no CSP violation); a data: module worker and the same blob module
// worker on a normal origin both start. Firefox and WebKit start it.
// ledger: module-worker-opaque-blob
const moduleWorker = (browserName: string) => (browserName === 'chromium' ? 'error' : 'ok');

test.describe('1. default CSP: guest-created blob: subresources are refused', () => {
    test('cooperative mode: every load except a classic worker is refused, each by its own directive', async ({ sandbox, browserName }) => {
        expect(await sandbox.mount()).toBe('ready');
        expect(await runProbes(sandbox, IFRAME_LOADS)).toEqual({
            'classic <script src>': 'error csp=script-src-elem',
            '<script type=module src>': 'error csp=script-src-elem',
            'import()': 'error:TypeError csp=script-src-elem',
            '<link rel=stylesheet>': 'error csp=style-src-elem',
            '<img> (svg)': 'error csp=img-src',
            '@font-face (woff2)': 'error:NetworkError csp=font-src',
            'fetch()': 'error:TypeError csp=connect-src',
            // worker-src lists blob: by default
            'new Worker() classic': 'ok',
            'new Worker() module': moduleWorker(browserName),
        });
    });

    test('worker mode: importScripts, import() and fetch of a blob are refused; there are no nested workers (independent verification V1)', async ({ sandbox, browserName }) => {
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
        // Every engine refuses; which violations reach the worker's own securitypolicyviolation
        // listener differs: Chromium delivers all three, Firefox only fetch's, WebKit none.
        // ledger: worker-violation-reports
        const csp = (directive: string, engines: string[]) => (engines.includes(browserName) ? ` csp=${directive}` : '');
        expect(await runProbes(sandbox, WORKER_LOADS)).toEqual({
            'importScripts()': 'error:NetworkError' + csp('script-src-elem', ['chromium']),
            'import()': 'error:TypeError' + csp('script-src-elem', ['chromium']),
            'fetch()': 'error:TypeError' + csp('connect-src', ['chromium', 'firefox']),
            // the worker keeps only the allowlisted globals (src/lib/worker-globals.ts): a nested worker would be a realm
            // the library's prelude never reaches
            'nested Worker classic': 'error:ReferenceError',
            'nested Worker module': 'error:ReferenceError',
        });
    });
});

test.describe('2. with blob: added, guest-created blob: subresources load', () => {
    test('cooperative mode: script, module, import(), stylesheet, image, font, fetch and classic worker all load', async ({ sandbox, browserName }) => {
        expect(await mountWithBlob(sandbox)).toBe('ready');
        expect(await runProbes(sandbox, IFRAME_LOADS)).toEqual({
            'classic <script src>': 'ok',
            '<script type=module src>': 'ok',
            'import()': 'ok',
            '<link rel=stylesheet>': 'ok',
            '<img> (svg)': 'ok',
            '@font-face (woff2)': 'ok',
            'fetch()': 'ok:hello',
            'new Worker() classic': 'ok',
            'new Worker() module': moduleWorker(browserName),
        });
    });

    test('worker mode (a classic worker): importScripts, import() and fetch of a blob all load; no nested worker, whatever the policy (independent verification V1)', async ({ sandbox }) => {
        expect(await mountWithBlob(sandbox, { mode: 'worker' })).toBe('ready');
        expect(await runProbes(sandbox, WORKER_LOADS)).toEqual({
            'importScripts()': 'ok',
            'import()': 'ok',
            'fetch()': 'ok:hello',
            'nested Worker classic': 'error:ReferenceError',
            'nested Worker module': 'error:ReferenceError',
        });
    });

    test('each directive admits only its own load type: blob: in script-src alone leaves styles, images, fonts and fetch refused', async ({ sandbox }) => {
        expect(await mountWithBlob(sandbox, {}, ['scripts'])).toBe('ready');
        expect(await runProbes(sandbox, IFRAME_LOADS.slice(0, 7))).toEqual({
            'classic <script src>': 'ok',
            '<script type=module src>': 'ok',
            'import()': 'ok',
            '<link rel=stylesheet>': 'error csp=style-src-elem',
            '<img> (svg)': 'error csp=img-src',
            '@font-face (woff2)': 'error:NetworkError csp=font-src',
            'fetch()': 'error:TypeError csp=connect-src',
        });
    });
});

// ---- 3: module resolution ----------------------------------------------------------------------

/**
 * Guest markup for one resolution scenario: a classic bootstrap (the shape δ's would take) that
 * creates blob modules with `mk`, registers import maps with `addMap`, runs `body` and leaves its
 * results in __r. `before` is guest markup placed ahead of the bootstrap.
 */
function resolutionScenario(body: string, before = '') {
    return `${before}<script>
        globalThis.__r = {};
        const mk = (source) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const addMap = (imports) => {
            const s = document.createElement('script');
            s.type = 'importmap';
            s.textContent = JSON.stringify({ imports });
            document.head.appendChild(s);
        };
        const attempt = async (specifier) => {
            try { return 'ok:' + (await import(specifier)).out; }
            catch (e) { return 'error:' + e.name; }
        };
        globalThis.__done = (async () => { ${body} })()
            .catch(e => { __r.thrown = e.name + ': ' + e.message; })
            .then(() => new Promise(r => setTimeout(r, 200)));
    </script>`;
}

async function runScenario(sandbox: any, body: string, before = ''): Promise<Record<string, string>> {
    expect(await mountWithBlob(sandbox)).toBe('ready');
    expect(await sandbox.load(resolutionScenario(body, before))).toBe('ready');
    await sandbox.run(`__done.then(() => console.log('SCENARIO ' + JSON.stringify(__r)))`);
    const line: string = await sandbox.waitForLog('SCENARIO ', 10000);
    return JSON.parse(line.slice('SCENARIO '.length));
}

// Firefox (146) honours only the FIRST import map of a document, and none at all once a module
// script has been prepared or import() called; Chromium and WebKit merge later maps.
// ledger: import-map-later
const laterMapHonoured = (browserName: string) => browserName !== 'firefox';

test.describe('3. module resolution between blob: modules', () => {
    test('one import map with bare and full-URL keys links a static import chain; a shared module evaluates once', async ({ sandbox }) => {
        const r = await runScenario(sandbox, `
            const U = mk("globalThis.__utilsEvaluated = (globalThis.__utilsEvaluated || 0) + 1; export const v = 'u';");
            const W = mk("import { v } from 'app/utils.js'; export const out = 'w' + v;");
            const M = mk("import { v } from 'app/utils.js'; import { out as w } from 'https://vfs.invalid/app/w.js'; export const out = v + w;");
            addMap({ 'app/utils.js': U, 'https://vfs.invalid/app/w.js': W, 'app/main.js': M });
            __r.dynamic = await attempt('app/main.js');
            await new Promise(res => {
                const s = document.createElement('script');
                s.type = 'module';
                s.textContent = "import { out } from 'app/main.js'; globalThis.__inline = out;";
                document.head.appendChild(s);
                setTimeout(res, 300);
            });
            __r.inlineModule = String(globalThis.__inline);
            await new Promise(res => {
                const s = document.createElement('script');
                s.type = 'module';
                s.src = mk("import { out } from 'app/main.js'; globalThis.__external = out;");
                s.onload = s.onerror = res;
                document.head.appendChild(s);
            });
            __r.blobModuleScript = String(globalThis.__external);
            __r.evaluations = String(globalThis.__utilsEvaluated);
        `);
        expect(r).toEqual({ dynamic: 'ok:uwu', inlineModule: 'uwu', blobModuleScript: 'uwu', evaluations: '1' });
    });

    // A relative specifier never resolves against the importing blob: URL (its path is opaque), so the
    // specifier stays as written. The guest document's base URL is about:blank (S15), against which
    // './utils.js' and '/app/utils.js' cannot be resolved either, so those import-map keys stay as written
    // too. Firefox and WebKit then match specifier to key literally (as the import maps spec reads) and
    // the import succeeds through the guest's own map; Chromium refuses it.
    test('relative specifiers inside a blob: module never resolve against its blob: URL; they match the guest\'s own literal map keys in Firefox and WebKit only', async ({ sandbox, browserName }) => {
        const r = await runScenario(sandbox, `
            const U = mk("export const out = 'u';");
            // one map for everything: Firefox ignores a second one
            addMap({
                './utils.js': U,
                '/app/utils.js': U,
                'https://vfs.invalid/app/utils.js': U,
                'https://vfs.invalid/app/main.js': mk("import { out as v } from './utils.js'; export const out = v;"),
            });
            __r.relative = await attempt(mk("import { out as v } from './utils.js'; export const out = v;"));
            __r.rootRelative = await attempt(mk("import { out as v } from '/app/utils.js'; export const out = v;"));
            // mapping the importer under a full-URL key does not change its base URL: still the blob
            __r.relativeUnderMappedKey = await attempt('https://vfs.invalid/app/main.js');
            const meta = await import(mk("export const out = import.meta.url; export let resolved; try { resolved = import.meta.resolve('./x.js'); } catch (e) { resolved = 'throws:' + e.name; }"));
            __r.importMetaUrl = meta.out.startsWith('blob:null/') ? 'blob:null/<uuid>' : meta.out;
            __r.importMetaResolve = meta.resolved;
        `);
        // ledger: blob-module-literal-key
        const viaLiteralKey = browserName === 'chromium' ? 'error:TypeError' : 'ok:u';
        expect(r).toEqual({
            relative: viaLiteralKey,
            rootRelative: viaLiteralKey,
            relativeUnderMappedKey: viaLiteralKey,
            importMetaUrl: 'blob:null/<uuid>',
            importMetaResolve: 'throws:TypeError',
        });
    });

    test('rewritten specifiers work everywhere: relative imports rewritten to full virtual URLs, one map registered before any module', async ({ sandbox }) => {
        // What δ's bootstrap would do: every relative specifier in a module's source is resolved against
        // that file's virtual URL (new URL(spec, 'https://vfs.invalid/<path>')) before the blob is made.
        const r = await runScenario(sandbox, `
            const BASE = 'https://vfs.invalid/';
            const files = {
                'src/main.js': "import { a } from './lib/a.js'; import { b } from '../shared/b.js'; export const out = a + b;",
                'src/lib/a.js': "import { b } from '../../shared/b.js'; export const a = 'a' + b;",
                'shared/b.js': "export const b = 'b';",
            };
            const rewrite = (path, source) => source.replace(/(from\\s*['"])(\\.{1,2}\\/[^'"]+)(['"])/g,
                (_, pre, spec, post) => pre + new URL(spec, BASE + path).href + post);
            const imports = {};
            for (const [path, source] of Object.entries(files)) imports[BASE + path] = mk(rewrite(path, source));
            addMap(imports);
            __r.main = await attempt(BASE + 'src/main.js');
            // a specifier the map does not cover falls through to a real fetch of the virtual URL,
            // which the policy refuses (asserted in section 5 too): resolution fails closed
            __r.unmapped = await attempt(BASE + 'missing.js');
        `);
        expect(r).toEqual({ main: 'ok:abb', unmapped: 'error:TypeError' });
    });

    test('a bootstrap placed before guest markup can register the map ahead of the guest\'s own module scripts', async ({ sandbox }) => {
        // the bootstrap is the scenario's inline classic script; the guest's module script follows it in markup
        expect(await mountWithBlob(sandbox)).toBe('ready');
        expect(await sandbox.load(`<script>
            const mk = (s) => URL.createObjectURL(new Blob([s], { type: 'text/javascript' }));
            const s = document.createElement('script');
            s.type = 'importmap';
            s.textContent = JSON.stringify({ imports: { 'app/x.js': mk("export const out = 'from-map';") } });
            document.head.appendChild(s);
        </script><script type="module">import { out } from 'app/x.js'; globalThis.__guestModule = out;</script>`)).toBe('ready');
        await sandbox.run(`setTimeout(() => console.log('GUEST_MODULE ' + globalThis.__guestModule), 100)`);
        expect(await sandbox.waitForLog('GUEST_MODULE')).toBe('GUEST_MODULE from-map');
    });

    test('module workers do not see the document\'s import map; a static import of a document-created blob: URL works where module workers start', async ({ sandbox, browserName }) => {
        const r = await runScenario(sandbox, `
            const X = mk("export const out = 'x';");
            addMap({ 'app/x.js': X });
            const spawn = (source) => new Promise(res => {
                const w = new Worker(mk(source), { type: 'module' });
                w.onmessage = e => { res('ok:' + e.data); w.terminate(); };
                w.onerror = e => { e.preventDefault(); res('error'); };
                setTimeout(() => res('timeout'), 3000);
            });
            __r.bareSpecifier = await spawn("import { out } from 'app/x.js'; postMessage(out);");
            __r.blobUrlSpecifier = await spawn("import { out } from '" + X + "'; postMessage(out);");
        `);
        // Chromium cannot start a blob: module worker from this opaque origin at all (section 1)
        // ledger: module-worker-opaque-blob
        expect(r).toEqual(browserName === 'chromium'
            ? { bareSpecifier: 'error', blobUrlSpecifier: 'error' }
            : { bareSpecifier: 'error', blobUrlSpecifier: 'ok:x' });
    });

    test('a second import map, before any module: honoured by Chromium and WebKit, ignored by Firefox', async ({ sandbox, browserName }) => {
        const r = await runScenario(sandbox, `
            addMap({ 'one/x.js': mk("export const out = 'one';") });
            addMap({ 'two/y.js': mk("export const out = 'two';") });
            __r.first = await attempt('one/x.js');
            __r.second = await attempt('two/y.js');
        `);
        expect(r).toEqual({ first: 'ok:one', second: laterMapHonoured(browserName) ? 'ok:two' : 'error:TypeError' });
    });

    test('an import map added after import(): honoured by Chromium and WebKit, ignored by Firefox', async ({ sandbox, browserName }) => {
        const r = await runScenario(sandbox, `
            await import(mk("export const out = 1;"));
            addMap({ 'late/x.js': mk("export const out = 'late';") });
            __r.late = await attempt('late/x.js');
        `);
        expect(r).toEqual({ late: laterMapHonoured(browserName) ? 'ok:late' : 'error:TypeError' });
    });

    test('an import map added after a module script in markup: honoured by Chromium and WebKit, ignored by Firefox', async ({ sandbox, browserName }) => {
        const r = await runScenario(sandbox, `
            await new Promise(res => setTimeout(res, 100));
            addMap({ 'after/x.js': mk("export const out = 'after';") });
            __r.after = await attempt('after/x.js');
        `, `<script type="module">globalThis.__earlyModule = 1;</script>`);
        expect(r).toEqual({ after: laterMapHonoured(browserName) ? 'ok:after' : 'error:TypeError' });
    });
});

// ---- 4: blob: URLs stay in the realm that created them ----------------------------------------

test.describe('4. blob: URLs do not cross realms', () => {
    // Host-created URLs: blob:<ORIGIN>/<uuid>
    const hostBlobs = () => {
        const mk = (s: string, t: string) => URL.createObjectURL(new Blob([s], { type: t }));
        return {
            classic: mk('globalThis.__hostBlobRan = 1; console.log("HOST_BLOB_RAN")', 'text/javascript'),
            module: mk('console.log("HOST_BLOB_RAN"); export const v = 1;', 'text/javascript'),
            css: mk('body { width: 1px }', 'text/css'),
            svg: mk('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"></svg>', 'image/svg+xml'),
            text: mk('host-only', 'text/plain'),
        };
    };

    test('cooperative mode: a blob: URL created by the host page loads as nothing in the guest, and not because of CSP', async ({ sandbox, page, browserName }) => {
        // blob: is allowed in every directive here, so a refusal is the blob store's origin check, not the policy
        expect(await mountWithBlob(sandbox)).toBe('ready');
        const u = await page.evaluate(hostBlobs);
        const results = await runProbes(sandbox, [
            ['classic <script src>', 'script', { url: u.classic }],
            ['<script type=module src>', 'script', { module: true, url: u.module }],
            ['import()', 'dynamicImport', { url: u.module }],
            ['<link rel=stylesheet>', 'stylesheet', { url: u.css }],
            ['<img>', 'image', { url: u.svg }],
            ['fetch()', 'fetch', { url: u.text }],
            ['XMLHttpRequest', 'xhr', { url: u.text }],
            ['new Worker()', 'worker', { url: u.classic }],
        ]);
        expect(results).toEqual({
            'classic <script src>': 'error',
            '<script type=module src>': 'error',
            'import()': 'error:TypeError',
            '<link rel=stylesheet>': 'error',
            '<img>': 'error',
            'fetch()': 'error:TypeError',
            'XMLHttpRequest': 'error',
            // Chromium's Worker constructor throws on a cross-origin URL; Firefox and WebKit fire error
            // ledger: cross-origin-worker-errors
            'new Worker()': browserName === 'chromium' ? 'error:SecurityError' : 'error',
        });
        expect((await sandbox.logs()).filter(l => l.includes('HOST_BLOB_RAN'))).toEqual([]);
    });

    test('worker mode: a host-created blob: URL cannot be imported or fetched by the guest worker', async ({ sandbox, page, browserName }) => {
        expect(await mountWithBlob(sandbox, { mode: 'worker' })).toBe('ready');
        const u = await page.evaluate(hostBlobs);
        expect(await runProbes(sandbox, [
            ['importScripts()', 'importScripts', { url: u.classic }],
            ['import()', 'dynamicImport', { url: u.module }],
            ['fetch()', 'fetch', { url: u.text }],
        ])).toEqual({
            // Firefox reports the cross-origin importScripts as a SecurityError, the others as a network error
            // ledger: cross-origin-worker-errors
            'importScripts()': browserName === 'firefox' ? 'error:SecurityError' : 'error:NetworkError',
            'import()': 'error:TypeError',
            'fetch()': 'error:TypeError',
        });
        expect((await sandbox.logs()).filter(l => l.includes('HOST_BLOB_RAN'))).toEqual([]);
    });

    test('a guest-created blob: URL resolves for neither the host page nor a second sandbox', async ({ sandbox, page }) => {
        expect(await mountWithBlob(sandbox)).toBe('ready');
        await sandbox.run(`console.log('GUEST_URLS ' + JSON.stringify({
            text: URL.createObjectURL(new Blob(['guest-only'], { type: 'text/plain' })),
            svg: URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"></svg>'], { type: 'image/svg+xml' })),
        }))`);
        const urls = JSON.parse((await sandbox.waitForLog('GUEST_URLS ')).slice('GUEST_URLS '.length));
        expect(urls.text).toMatch(/^blob:null\//);

        const host = await page.evaluate(async ({ text, svg }) => {
            const out: Record<string, string> = {};
            try { out.fetch = 'ok:' + await (await fetch(text)).text(); } catch (e: any) { out.fetch = 'error:' + e.name; }
            out.img = await new Promise(res => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('error'); i.src = svg; });
            return out;
        }, urls);
        expect(host).toEqual({ fetch: 'error:TypeError', img: 'error' });

        expect(await sandbox.mountSecond()).toBe('ready'); // the element class has the δ policy (withBlob)
        await page.evaluate((url) => (document.querySelector('#second') as any).execute(`
            fetch(${JSON.stringify(url)}).then(r => r.text()).then(
                t => console.log('SECOND_SANDBOX ok:' + t), e => console.log('SECOND_SANDBOX error:' + e.name))`), urls.text);
        expect(await sandbox.waitForLog('SECOND_SANDBOX ')).toBe('SECOND_SANDBOX error:TypeError');
    });
});

// ---- 5: blob: adds no egress --------------------------------------------------------------------
//
// Evidence (backlog T5): every attempt targets a listener outside the browser (recorder.ts), which must
// stay silent; each refusal is the guest's own load outcome and, where the engine raises one, its CSP
// violation reported on the host (S5; in a worker, Chromium reports all, Firefox fetch and WebSocket only,
// WebKit none). Positive control: the last test of section 5 sends the same attempts to an allowlisted
// origin, and every one succeeds and reaches the listener.

const recorder = useRecorder();

// Guest code that tries every outbound channel it has and logs how each settled.
const outboundAttempts = (target: string) => `
    const report = (k, v) => console.log('OUTBOUND ' + k + ' ' + v);
    fetch('${target}/fetch').then(() => report('fetch', 'reached'), () => report('fetch', 'refused'));
    import('${target}/module.js').then(() => report('import', 'reached'), () => report('import', 'refused'));
    if (typeof document !== 'undefined') {
        const i = new Image(); i.onload = () => report('img', 'reached'); i.onerror = () => report('img', 'refused'); i.src = '${target}/img.svg';
    } else {
        try { importScripts('${target}/script.js'); report('importScripts', 'reached'); } catch (e) { report('importScripts', 'refused'); }
    }
    try { const ws = new WebSocket('${wss(target)}/ws'); ws.onopen = () => report('websocket', 'reached'); ws.onerror = () => report('websocket', 'refused'); } catch (e) { report('websocket', 'refused'); }
`;

// The violations each engine reports on the host for outboundAttempts(target), in cooperative or worker mode.
function outboundViolations(target: string, mode: 'cooperative' | 'worker', browserName: string): string[] {
    const fetch = `connect-src ${target}/fetch`;
    const websocket = `connect-src ${wss(target)}/ws`;
    const imported = `script-src-elem ${target}/module.js`;
    if (mode === 'cooperative') return [fetch, websocket, `img-src ${target}/img.svg`, imported].sort();
    // ledger: worker-violation-reports
    if (browserName === 'chromium') return [fetch, websocket, imported, `script-src-elem ${target}/script.js`].sort();
    if (browserName === 'firefox') return [fetch, websocket].sort();
    return []; // WebKit raises no violations in workers
}

async function reportedViolations(sandbox: any): Promise<string[]> {
    await sandbox.page.waitForTimeout(300); // violation events are queued as tasks, then cross the port
    const all: { directive: string; blockedURI: string }[] = await sandbox.violations();
    return [...new Set(all.map(v => `${v.directive} ${v.blockedURI}`))].sort();
}

// ---- 5a: no 'self' in the guest policy (backlog S14) ---------------------------------------------
//
// With a script-src of 'self' 'unsafe-inline' in this opaque-origin guest, WebKit lets 'self' admit ANY https
// origin (the request leaves the machine and the script runs), Chromium resolves it to the host page's origin,
// Firefox matches nothing. So the guest policy never
// contains 'self' (ADR-007: it is not an origin): not by default, and dropped with a warning when
// configured. These tests run identically on every engine.

const SELF_WARNING = `[Sandbox] origins.scripts entry "'self'" was dropped`;
const HOST_SCRIPT = `${ORIGIN}/playground/test-assets/script.js`;

// Guest markup that reads its own policy, loads scripts from a non-allowlisted origin three ways (and,
// with `withHost`, one from the host origin), and logs how each settled plus the script-src
// violations it saw, once the port is up (the shipping config has no execute()). A script that
// reached the listener would run and count itself in __recorderRan.
const scriptSourceProbe = (target: string, withHost: boolean) => `<script>
    const r = { violations: [] };
    addEventListener('securitypolicyviolation', e => r.violations.push(e.effectiveDirective + ' ' + new URL(e.blockedURI).pathname));
    const load = (url, module) => new Promise(res => {
        const s = document.createElement('script');
        if (module) s.type = 'module';
        s.src = url; s.onload = () => res('load'); s.onerror = () => res('refused');
        document.head.appendChild(s);
    });
    (async () => {
        r.policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
        r.classic = await load('${target}/classic.js');
        r.module = await load('${target}/module.js', true);
        r.dynamicImport = await import('${target}/import.js').then(() => 'load', () => 'refused');
        ${withHost ? `r.hostOrigin = await load('${HOST_SCRIPT}');` : ''}
        r.ran = globalThis.__recorderRan || 0;
        setTimeout(() => { r.violations.sort(); console.log('SCRIPT_SOURCES ' + JSON.stringify(r)); }, 800);
    })();
</script>`;

function collectWarnings(page: any): string[] {
    const warnings: string[] = [];
    page.on('console', (m: any) => { if (m.type() === 'warning') warnings.push(m.text()); });
    return warnings;
}

async function scriptSourceOutcome(sandbox: any, withHost: boolean, origins?: SandboxConfig['origins']) {
    // the shipping configuration: no scriptUnsafe, guest markup only
    expect(await sandbox.mount({ scriptUnsafe: false, html: scriptSourceProbe(recorder.blocked, withHost), ...(origins ? { origins } : {}) })).toBe('ready');
    const line: string = await sandbox.waitForLog('SCRIPT_SOURCES ', 8000);
    return { reached: recorder.paths('blocked'), ...JSON.parse(line.slice('SCRIPT_SOURCES '.length)) };
}

const REFUSED_ATTACKER = { classic: 'refused', module: 'refused', dynamicImport: 'refused', ran: 0 };
const ATTACKER_VIOLATIONS = ['script-src-elem /classic.js', 'script-src-elem /import.js', 'script-src-elem /module.js'];

test.describe("5a. the guest policy never contains 'self'", () => {
    test('shipping default: no script loads from another origin or the host origin, each refused by script-src', async ({ sandbox, page }) => {
        const warnings = collectWarnings(page);
        const { policy, violations, ...outcome } = await scriptSourceOutcome(sandbox, true);
        expect(policy.toLowerCase()).not.toContain("'self'");
        expect(outcome).toEqual({ reached: [], ...REFUSED_ATTACKER, hostOrigin: 'refused' });
        expect(violations).toEqual([...ATTACKER_VIOLATIONS, 'script-src-elem /playground/test-assets/script.js'].sort());
        expect(warnings.filter(w => w.includes("'self'"))).toEqual([]);
    });

    test("a configured 'self' is dropped with one warning; the explicit origin stays and other origins are refused", async ({ sandbox, page }) => {
        // No host-origin load here: whether the allowlisted http://localhost loads is not what this asserts.
        const warnings = collectWarnings(page);
        const { policy, violations, ...outcome } = await scriptSourceOutcome(sandbox, false, { scripts: ["'self'", OFFSITE_ORIGIN] });
        expect(policy).toContain(`script-src 'unsafe-inline' ${OFFSITE_ORIGIN};`);
        expect(policy.toLowerCase()).not.toContain("'self'");
        expect(outcome).toEqual({ reached: [], ...REFUSED_ATTACKER });
        expect(violations).toEqual(ATTACKER_VIOLATIONS);
        expect(warnings.filter(w => w.includes(SELF_WARNING))).toHaveLength(1);
    });

    const workerCases: [string, SandboxConfig['origins'] | undefined][] = [
        ['default policy', undefined],
        ["'self' configured", { scripts: ["'self'"] }],
    ];
    for (const [label, origins] of workerCases) {
        test(`worker mode, ${label}: importScripts and import() from another origin are refused, nothing reaches the network`, async ({ sandbox, page }) => {
            const warnings = collectWarnings(page);
            // worker mode has no markup: guest code arrives through execute(), hence scriptUnsafe (the fixture's)
            expect(await sandbox.mount({ mode: 'worker', ...(origins ? { origins } : {}) })).toBe('ready');
            await sandbox.run(`(async () => {
                const r = {};
                try { importScripts('${recorder.blocked}/imported.js'); r.importScripts = 'load'; } catch (e) { r.importScripts = 'refused'; }
                try { importScripts('${ORIGIN}/playground/test-assets/script.js'); r.hostOrigin = 'load'; } catch (e) { r.hostOrigin = 'refused'; }
                r.dynamicImport = await import('${recorder.blocked}/import.js').then(() => 'load', () => 'refused');
                r.ran = globalThis.__recorderRan || 0;
                console.log('WORKER_SOURCES ' + JSON.stringify(r));
            })()`);
            const line = await sandbox.waitForLog('WORKER_SOURCES ', 8000);
            expect(JSON.parse(line.slice('WORKER_SOURCES '.length))).toEqual({ importScripts: 'refused', hostOrigin: 'refused', dynamicImport: 'refused', ran: 0 });
            expect(recorder.paths('blocked')).toEqual([]);
            expect(warnings.filter(w => w.includes(SELF_WARNING))).toHaveLength(origins ? 1 : 0);
        });
    }
});

test.describe('5. blob: in the policy adds no egress', () => {
    for (const [name, wrap] of [
        ['classic blob: script', (src: string) => `const s = document.createElement('script'); s.src = URL.createObjectURL(new Blob([${JSON.stringify(src)}], { type: 'text/javascript' })); document.head.appendChild(s);`],
        ['blob: module', (src: string) => `import(URL.createObjectURL(new Blob([${JSON.stringify(src)}], { type: 'text/javascript' })));`],
    ] as const) {
        test(`a ${name} runs under the guest's CSP: every outbound channel is refused`, async ({ sandbox, browserName }) => {
            expect(await mountWithBlob(sandbox)).toBe('ready');
            await sandbox.run(wrap(outboundAttempts(recorder.blocked)));
            for (const channel of ['fetch', 'import', 'img', 'websocket']) {
                expect(await sandbox.waitForLog(`OUTBOUND ${channel} `)).toBe(`OUTBOUND ${channel} refused`);
            }
            expect(await reportedViolations(sandbox)).toEqual(outboundViolations(recorder.blocked, 'cooperative', browserName));
            expect(recorder.hits.filter(hit => hit.server === 'blocked')).toEqual([]);
        });
    }

    test('a blob: stylesheet runs under the guest\'s CSP: its url() to another origin is refused', async ({ sandbox }) => {
        expect(await mountWithBlob(sandbox)).toBe('ready');
        await sandbox.run(`
            const l = document.createElement('link'); l.rel = 'stylesheet';
            l.href = URL.createObjectURL(new Blob(['@import url("${recorder.blocked}/import.css"); body { background-image: url("${recorder.blocked}/bg.svg"); }'], { type: 'text/css' }));
            document.head.appendChild(l);
        `);
        expect(await sandbox.waitForViolation('style-src-elem', `${recorder.blocked}/import.css`)).toBeTruthy();
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('worker mode: a blob: script pulled in with importScripts runs under the guest\'s CSP', async ({ sandbox, browserName }) => {
        expect(await mountWithBlob(sandbox, { mode: 'worker' })).toBe('ready');
        await sandbox.run(`importScripts(URL.createObjectURL(new Blob([${JSON.stringify(outboundAttempts(recorder.blocked))}], { type: 'text/javascript' })));`);
        for (const channel of ['importScripts', 'fetch', 'import', 'websocket']) {
            expect(await sandbox.waitForLog(`OUTBOUND ${channel} `)).toBe(`OUTBOUND ${channel} refused`);
        }
        expect(await reportedViolations(sandbox)).toEqual(outboundViolations(recorder.blocked, 'worker', browserName));
        expect(recorder.hits.filter(hit => hit.server === 'blocked')).toEqual([]);
    });

    test('positive control: the same attempts to an allowlisted origin all succeed and reach the listener, in cooperative and worker mode, with no violation', async ({ sandbox }) => {
        const allowed = recorder.allowed;
        await withBlob(sandbox);
        const origins = { scripts: [allowed], styles: [allowed], images: [allowed], connect: [allowed, wss(allowed)] };
        const expectedPaths = { cooperative: ['/fetch', '/img.svg', '/module.js', '/ws'], worker: ['/fetch', '/module.js', '/script.js', '/ws'] };
        for (const mode of ['cooperative', 'worker'] as const) {
            recorder.clear();
            await sandbox.clearLogs();
            await sandbox.clearViolations();
            expect(await sandbox.mount({ mode, origins })).toBe('ready');
            const attempts = JSON.stringify(outboundAttempts(allowed));
            await sandbox.run(mode === 'cooperative'
                ? `import(URL.createObjectURL(new Blob([${attempts}], { type: 'text/javascript' })));`
                : `importScripts(URL.createObjectURL(new Blob([${attempts}], { type: 'text/javascript' })));`);
            for (const channel of mode === 'cooperative' ? ['fetch', 'import', 'img', 'websocket'] : ['importScripts', 'fetch', 'import', 'websocket']) {
                expect(await sandbox.waitForLog(`OUTBOUND ${channel} `), `${mode} ${channel}`).toBe(`OUTBOUND ${channel} reached`);
            }
            for (const path of expectedPaths[mode]) await recorder.waitFor('allowed', path);
            expect(await sandbox.violations()).toEqual([]);
        }
    });

    // A blob: document the guest creates, used as a navigation target.
    const BLOB_DOC = `URL.createObjectURL(new Blob(['<p>blob document</p>'], { type: 'text/html' }))`;
    const SELF_NAVIGATIONS: Record<string, string> = {
        'location.href': `location.href = ${BLOB_DOC};`,
        'window.open(_self)': `window.open(${BLOB_DOC}, '_self');`,
        'link click': `const a = document.createElement('a'); a.href = ${BLOB_DOC}; document.body.appendChild(a); a.click();`,
        'form submission': `const f = document.createElement('form'); f.action = ${BLOB_DOC}; document.body.appendChild(f); f.submit();`,
    };

    // Every frame's markup, as far as Playwright can read it.
    const frameMarkup = (page: any): Promise<string[]> => Promise.all(page.frames().map((f: any) =>
        f.evaluate(() => document.documentElement.outerHTML).catch(() => '')));

    for (const [name, code] of Object.entries(SELF_NAVIGATIONS)) {
        test(`a blob: document cannot replace the guest frame (${name})`, async ({ sandbox, page, browserName }) => {
            expect(await mountWithBlob(sandbox)).toBe('ready');
            await sandbox.run(`globalThis.__original = 'still-here'; setTimeout(() => { ${code} }, 0);`);
            await page.waitForTimeout(1500);

            expect(page.frames().map(f => f.url()).filter(u => u.startsWith('blob:'))).toEqual([]);
            expect((await frameMarkup(page)).filter(m => m.includes('blob document'))).toEqual([]);
            expect(await sandbox.state()).toBe('ready');

            await sandbox.run(`console.log('ORIGINAL_DOCUMENT ' + globalThis.__original)`);
            // ledger: refused-navigation-history
            if (browserName === 'chromium' && name !== 'form submission') {
                // Chromium commits its error page in place of a frame navigation refused by the wrapper's
                // frame-src — the same as for an https: target (research 14). The original guest document
                // is gone, and the frame holds chrome-error://, never the blob: document.
                const others = page.frames().map(f => f.url()).filter(u => u !== HARNESS && u !== '' && u !== 'about:srcdoc');
                expect(others.filter(u => u !== 'chrome-error://chromewebdata/')).toEqual([]);
                await expect(sandbox.waitForLog('ORIGINAL_DOCUMENT', 2000)).rejects.toThrow();
                return;
            }
            // Firefox and WebKit refuse the navigation and keep the original document (and the form
            // submission never starts anywhere: allow-forms is off and form-action is 'none').
            expect(await sandbox.waitForLog('ORIGINAL_DOCUMENT')).toBe('ORIGINAL_DOCUMENT still-here');
        });
    }

    test('a blob: document cannot be loaded into a nested frame', async ({ sandbox, page }) => {
        expect(await mountWithBlob(sandbox)).toBe('ready');
        await sandbox.run(`const f = document.createElement('iframe'); f.src = ${BLOB_DOC}; document.body.appendChild(f);`);
        await page.waitForTimeout(1500);
        expect(page.frames().map(f => f.url()).filter(u => u.startsWith('blob:'))).toEqual([]);
    });

    test('a blob: document cannot open a new browsing context', async ({ sandbox, context, page }) => {
        let opened = 0;
        context.on('page', () => opened++);
        expect(await mountWithBlob(sandbox)).toBe('ready');
        // Chromium and WebKit return null without allow-popups, Firefox throws
        await sandbox.run(`
            try { console.log('OPEN ' + (window.open(${BLOB_DOC}) ? 'opened' : 'refused')); }
            catch (e) { console.log('OPEN refused'); }
            const a = document.createElement('a'); a.href = ${BLOB_DOC}; a.target = '_blank'; document.body.appendChild(a); a.click();
        `);
        expect(await sandbox.waitForLog('OPEN')).toBe('OPEN refused');
        await page.waitForTimeout(1000);
        expect(opened).toBe(0);
        expect(context.pages()).toHaveLength(1);
    });
});

// ---- 6: MIME ---------------------------------------------------------------------------------

test.describe('6. blob: MIME types', () => {
    test('cooperative mode: modules and stylesheets need the right type; classic scripts, fonts and images are lenient as measured', async ({ sandbox, browserName }) => {
        expect(await mountWithBlob(sandbox)).toBe('ready');
        expect(await runProbes(sandbox, [
            ['module text/javascript', 'script', { module: true, type: 'text/javascript' }],
            ['module application/javascript', 'script', { module: true, type: 'application/javascript' }],
            ['module text/css', 'script', { module: true, type: 'text/css' }],
            ['module text/plain', 'script', { module: true, type: 'text/plain' }],
            ['module (no type)', 'script', { module: true, type: '' }],
            ['import() text/plain', 'dynamicImport', { type: 'text/plain' }],
            ['stylesheet text/css', 'stylesheet', { type: 'text/css' }],
            ['stylesheet text/plain', 'stylesheet', { type: 'text/plain' }],
            ['stylesheet (no type)', 'stylesheet', { type: '' }],
            ['classic text/plain', 'script', { type: 'text/plain' }],
            ['classic image/png', 'script', { type: 'image/png' }],
            ['svg image/svg+xml', 'image', { type: 'image/svg+xml' }],
            ['svg text/plain', 'image', { type: 'text/plain' }],
            ['font font/woff2', 'font', { type: 'font/woff2' }],
            ['font text/plain', 'font', { type: 'text/plain' }],
        ])).toEqual({
            'module text/javascript': 'ok',
            'module application/javascript': 'ok',
            // strict MIME checking for module scripts, all engines
            'module text/css': 'error',
            'module text/plain': 'error',
            'module (no type)': 'error',
            'import() text/plain': 'error:TypeError',
            'stylesheet text/css': 'ok',
            // standards-mode stylesheets: Chromium fires load but ignores the sheet; Firefox and WebKit fire error
            // ledger: blob-mime-checks
            'stylesheet text/plain': browserName === 'chromium' ? 'loaded-not-applied' : 'error',
            // an EMPTY blob type is accepted as a stylesheet by all three engines
            'stylesheet (no type)': 'ok',
            // classic scripts are not MIME-checked except image/* (and audio/video/csv) — enforced by WebKit only for blobs
            'classic text/plain': 'ok',
            'classic image/png': browserName === 'webkit' ? 'error' : 'ok',
            'svg image/svg+xml': 'ok',
            // SVG is never sniffed: it needs its type
            'svg text/plain': 'error',
            // fonts are sniffed, so their type does not matter
            'font font/woff2': 'ok',
            'font text/plain': 'ok',
        });
    });

    test('worker mode: importScripts MIME checking differs by engine; import() is strict everywhere', async ({ sandbox, browserName }) => {
        expect(await mountWithBlob(sandbox, { mode: 'worker' })).toBe('ready');
        // Firefox and WebKit refuse a non-JavaScript type for importScripts (as the HTML spec requires); Chromium runs it
        // ledger: import-scripts-mime
        const strict = browserName === 'chromium' ? 'ok' : 'error:NetworkError';
        expect(await runProbes(sandbox, [
            ['importScripts text/javascript', 'importScripts', { type: 'text/javascript' }],
            ['importScripts text/plain', 'importScripts', { type: 'text/plain' }],
            ['importScripts image/png', 'importScripts', { type: 'image/png' }],
            ['import() text/plain', 'dynamicImport', { type: 'text/plain' }],
        ])).toEqual({
            'importScripts text/javascript': 'ok',
            'importScripts text/plain': strict,
            'importScripts image/png': strict,
            'import() text/plain': 'error:TypeError',
        });
    });
});
