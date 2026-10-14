import { test, expect, type SandboxDriver } from './fixture';
import { clickInSandbox, inView, waitInView } from './strict-view';
import { INERT_HREF } from '@src/lib/in-sandbox-view';
import type { SandboxConfig } from '@src/host';

/**
 * Adversarial review 2026-10, strict mode and files (docs/security/ADVERSARIAL-REVIEW-2026-10.md):
 *   C1  every blob: URL that resolves in the view names a registered file: the worker's own source URL is revoked
 *       once the worker has run its script (follow-up audit 2026-10-14), and the worker keeps working after it in
 *       every engine; a worker's copy of a JavaScript file is inert as a stylesheet;
 *   C2  the entry runs in its own scope: its top-level declarations cannot replace the globals the prelude
 *       captures and deletes, and an entry that escapes its scope does not start;
 *   C3  the prelude's lists reach no inherited setter: guest code watching every array write sees none of them,
 *       and flow control holds;
 *   C4  the view's violations are counted per directive (follow-up audit 2026-10-14): the guest's own refused loads
 *       of one kind cannot hide a report of another;
 *   C5  a rendered link stays a link with one inert href (backlog S24, option B): the user agent's own actions on
 *       it (copy, open in a new tab, drag) carry nothing of the guest's, and clicks are still cancelled and delivered.
 * Evidence (T5): the view's state read from outside (strict-view.ts), the host's events, and the guest's own view
 * through execute(); a positive control beside each negative.
 */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="5"></svg>';
const strict = (config: Partial<SandboxConfig> = {}): Partial<SandboxConfig> => ({ mode: 'strict', ...config });

async function render(sandbox: SandboxDriver, browserName: string, html: string, doneId = 'done') {
    await sandbox.run(`sandboxView.render(${JSON.stringify(html + `<p id="${doneId}">done</p>`)})`);
    await waitInView(sandbox.page, browserName, `!!document.getElementById(${JSON.stringify(doneId)})`, 8000);
}

test.describe('C1: the view renders no blob: content but registered files', () => {
    test("the worker's own source URL is revoked once the worker has run its script: the view can no longer fetch it, and referenced from <style> text and a CSS-escaped style attribute (which the renderer does not inspect) it applies no rule and decodes as no image", async ({ sandbox, page, browserName }) => {
        // the entry carries a CSS rule inside a JS comment: lenient CSS parsing of the worker source would apply it
        await sandbox.registerFiles({ 'main.js': '/*\n}#c1 { width: 66px }\n*/ void 0;', 'img/logo.svg': SVG, 'a.css': 'p {}' });
        expect(await sandbox.mount(strict({ entry: 'main.js' }))).toBe('ready');
        const workerUrl: string = await sandbox.inGuest('return location.href');
        expect(workerUrl).toMatch(/^blob:/);
        const escaped = 'bl\\6f b:' + workerUrl.slice(5); // "blob:" with a CSS escape, invisible to the attribute check
        await render(sandbox, browserName, `<style>@import url("${workerUrl}");</style><i id="c1" style="display:block"></i><i id="bg" style="display:block;width:3px;height:5px;background-image:url(${escaped})"></i>`);
        const r = await inView<any>(page, browserName, `(async () => {
            const text = await fetch(${JSON.stringify(workerUrl)}).then((r) => r.text(), (e) => e.name);
            const image = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('decoded'); i.onerror = () => resolve('error'); i.src = ${JSON.stringify(workerUrl)}; });
            return {
                fetched: text,
                image,
                ruleApplied: getComputedStyle(document.getElementById('c1')).width === '66px',
                escapedKept: document.getElementById('bg').getAttribute('style').includes('6f b:'),
            };
        })()`);
        expect(r).toEqual({ fetched: 'TypeError', image: 'error', ruleApplied: false, escapedKept: true });
    });

    test("a worker's copies of registered files resolve in the view: a copy of a JavaScript file is refused as a stylesheet (its type), a copy of a stylesheet applies (positive control): neither shows more than the registered content", async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'rule.js': '#viaJs { width: 77px }', 'rule.css': '#viaCss { width: 55px }' });
        expect(await sandbox.mount(strict())).toBe('ready');
        const urls = await sandbox.inGuest(`return { js: sandboxFiles.url('rule.js'), css: sandboxFiles.url('rule.css') }`);
        await render(sandbox, browserName, `<style>@import url("${urls.js}"); @import url("${urls.css}");</style><i id="viaJs" style="display:block"></i><i id="viaCss" style="display:block"></i>`);
        await waitInView(page, browserName, `getComputedStyle(document.getElementById('viaCss')).width === '55px'`, 8000);
        expect(await inView(page, browserName, `getComputedStyle(document.getElementById('viaJs')).width`)).not.toBe('77px');
    });

    test("after the revocation the worker keeps working, in WebKit too: sandboxFiles url/read/text, fetches of its own blob: URLs, Blob reads, execute(), and error text from execute() and from later uncaught errors of the entry's code and of executed code", async ({ sandbox, page, browserName }) => {
        const bytes = Buffer.from([0, 1, 2, 250, 255]).toString('base64');
        // lateThrow is code of the revoked script: in WebKit its uncaught errors read "Script error." inside the
        // worker after the revocation, so the view logs them with the text it still has (in-sandbox-view.ts)
        await sandbox.registerFiles({ 'main.js': 'globalThis.entryRan = true; globalThis.lateThrow = () => setTimeout(() => { throw new Error("entry-late"); }, 0);', 'note.txt': 'héllo', 'data.bin': { base64: bytes } });
        expect(await sandbox.mount(strict({ entry: 'main.js' }))).toBe('ready');
        const workerUrl: string = await sandbox.inGuest('return location.href');
        // the evidence that the revocation happened: the view, read from outside, can no longer fetch the source
        await waitInView(page, browserName, `fetch(${JSON.stringify(workerUrl)}).then(() => false, () => true)`, 8000);
        const r = await sandbox.inGuest(`
            const url = sandboxFiles.url('note.txt');
            return {
                entryRan: globalThis.entryRan === true,
                viaUrl: await (await fetch(url)).text(),
                text: await sandboxFiles.text('note.txt'),
                read: Array.from(await sandboxFiles.read('data.bin')),
                blob: await new Blob(['abc']).text(),
                again: await (await fetch(sandboxFiles.url('data.bin'))).arrayBuffer().then(b => b.byteLength),
            };
        `);
        expect(r).toEqual({ entryRan: true, viaUrl: 'héllo', text: 'héllo', read: [0, 1, 2, 250, 255], blob: 'abc', again: 5 });
        await sandbox.run('throw new Error("after-revoke-sync")');
        expect(await sandbox.waitForLog('after-revoke-sync')).toContain('after-revoke-sync');
        await sandbox.run('lateThrow()');
        expect(await sandbox.waitForLog(/Uncaught.*entry-late/)).toMatch(/Error: entry-late/);
        await sandbox.run('setTimeout(() => { throw new Error("after-revoke-late"); }, 0)');
        expect(await sandbox.waitForLog(/Uncaught.*after-revoke-late/)).toMatch(/Error: after-revoke-late/);
        expect((await sandbox.logs()).filter(line => line.includes('Script error.'))).toEqual([]);
        expect(await sandbox.state()).toBe('ready');
    });
});

test.describe('C2: the entry runs in its own scope', () => {
    test('top-level declarations named like the globals the prelude uses are local: Worker stays deleted, Reflect intact, nothing leaks to the global; `this` is the global object', async ({ sandbox, page }) => {
        await sandbox.registerFiles({ 'main.js': `
            function Worker() {}
            function Reflect() {}
            function WebAssembly() {}
            function MessagePort() {}
            var helper = 1;
            bridge.call('report', { thisIsGlobal: this === globalThis, localWorker: typeof Worker, localReflect: typeof Reflect });
        ` });
        await sandbox.exposeHost('report', '(v) => { window.c2 = v; return true; }');
        expect(await sandbox.mount(strict({ entry: 'main.js', scriptUnsafe: false }))).toBe('ready');
        await page.waitForFunction(() => (window as any).c2 !== undefined);
        expect(await page.evaluate(() => (window as any).c2)).toEqual({ thisIsGlobal: true, localWorker: 'function', localReflect: 'function' });
        // the global ones, seen from a later script (execute() needs scriptUnsafe, so read them through the bridge)
        await sandbox.exposeHost('report2', '(v) => { window.c2b = v; return true; }');
        await sandbox.registerFiles({ 'main.js': `bridge.call('report2', { Worker: typeof globalThis.Worker, Reflect: typeof globalThis.Reflect, apply: typeof Reflect.apply, WebAssembly: typeof globalThis.WebAssembly, helper: typeof globalThis.helper, sandboxView: typeof sandboxView });` });
        expect(await sandbox.mount(strict({ entry: 'main.js', scriptUnsafe: false }))).toBe('ready');
        await page.waitForFunction(() => (window as any).c2b !== undefined);
        expect(await page.evaluate(() => (window as any).c2b)).toEqual({ Worker: 'undefined', Reflect: 'object', apply: 'function', WebAssembly: 'undefined', helper: 'undefined', sandboxView: 'object' });
    });

    test('an entry declared in its own scope cannot replace a global for later code either: after the first entry, typeof Worker is still "undefined" for guest code', async ({ sandbox }) => {
        await sandbox.registerFiles({ 'main.js': 'function Worker() {} var x = 1;' });
        expect(await sandbox.mount(strict({ entry: 'main.js' }))).toBe('ready');
        expect(await sandbox.inGuest('return [typeof Worker, typeof SharedWorker, typeof x]')).toEqual(['undefined', 'undefined', 'undefined']);
    });

    test('an entry that closes its scope early and declares at the top level of the script does not start: terminated with "the guest entry failed to start", naming the declaration', async ({ sandbox }) => {
        await sandbox.registerFiles({ 'main.js': `}).call(this); function Worker() {} (function () {` });
        expect(await sandbox.mount(strict({ entry: 'main.js' }))).toBe('ready');
        await expect.poll(() => sandbox.state(), { timeout: 8000 }).toBe('terminated');
        expect(await sandbox.waitForLog('the guest entry failed to start')).toMatch(/the entry declares "Worker" at the top level/);
    });
});

test('C3: guest code watching every array write (a Proxy in Array.prototype\'s chain) sees none of the prelude\'s lists, and renders and events still flow, one at a time', async ({ sandbox, page, browserName }) => {
    expect(await sandbox.mount(strict())).toBe('ready');
    await sandbox.run(`
        globalThis.__writes = 0;
        Object.setPrototypeOf(Array.prototype, new Proxy(Object.create(Object.prototype), {
            set(target, key, value, receiver) { globalThis.__writes++; return Reflect.defineProperty(receiver, key, { value, writable: true, enumerable: true, configurable: true }); },
        }));
        const own = []; own[0] = 1; // positive control: a write of the guest's own reaches the trap
        globalThis.__control = globalThis.__writes;
        globalThis.__writes = 0;
        sandboxView.on('click', null, () => {});
        sandboxView.on('input', 'a', () => {});
        for (let i = 0; i < 5; i++) sandboxView.render('<p id="t' + i + '">' + i + '</p><div id="slot' + i + '"></div>', i === 0 ? null : 'slot' + (i - 1));
        globalThis.__afterCalls = globalThis.__writes;
    `);
    await waitInView(page, browserName, `!!document.getElementById('t4')`, 8000);
    expect(await sandbox.inGuest('return { control: __control, afterCalls: __afterCalls, total: __writes }')).toEqual({ control: 1, afterCalls: 0, total: 0 });
});

test('C4: the view counts violations per directive: 150 refused images in rendered markup use up the img-src count (100 reported), and a later handler attribute is still reported as script-src-attr', async ({ sandbox, page, browserName }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning' && m.text().includes('CSP violations')) warnings.push(m.text()); });
    expect(await sandbox.mount(strict())).toBe('ready');
    let markup = '';
    for (let i = 0; i < 150; i++) markup += `<img src="https://attacker.test/flood-${i}.svg">`;
    await render(sandbox, browserName, markup);
    await expect.poll(async () => (await sandbox.violations()).filter(v => v.source === 'view' && v.directive === 'img-src').length, { timeout: 8000 }).toBe(100);
    // the image is refused (img-src, past its count now), and its error event meets the refused handler attribute
    await render(sandbox, browserName, '<img id="h" src="https://attacker.test/after-cap.svg" onerror="void 0">', 'done-2');
    const handler = await sandbox.waitForViolation('script-src-attr', 'inline', 8000);
    expect(handler.source).toBe('view');
    await page.waitForTimeout(500);
    const view = (await sandbox.violations()).filter(v => v.source === 'view');
    expect(view.filter(v => v.directive === 'img-src')).toHaveLength(100);
    expect(view.some(v => v.blockedURI.includes('after-cap'))).toBe(false); // img-src's own count is used up
    expect(warnings.length).toBeLessThanOrEqual(1); // the view stops forwarding at each count itself; the host warns only past it
});

test.describe('C5: a rendered link stays a link, but its href is one inert constant (backlog S24, option B)', () => {
    const MARK = 'MARKER-c5';
    const LINKS = `<a id="l" href="https://attacker.test/ua-action?m=${MARK}" style="display:block;position:absolute;left:0;top:0;width:120px;height:30px">link</a>`
        + `<svg width="40" height="40" style="position:absolute;left:0;top:200px"><a id="s" href="https://attacker.test/svg?m=${MARK}" xlink:href="https://attacker.test/xlink?m=${MARK}"><rect width="40" height="40"/></a></svg>`
        + `<map name="m"><area id="ar" href="https://attacker.test/area?m=${MARK}" shape="rect" coords="0,0,10,10"></map>`;

    test("the view, read from outside: every link's href is the constant, the guest's URL is nowhere in the document; the link matches :link and :any-link, is focusable and has the role link; a drag carries only the constant", async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(strict())).toBe('ready');
        await render(sandbox, browserName, LINKS);
        const r = await inView<any>(page, browserName, `(() => {
            const a = document.getElementById('l');
            const s = document.getElementById('s');
            a.focus();
            return {
                attr: a.getAttribute('href'), href: a.href, area: document.getElementById('ar').getAttribute('href'),
                svg: s.getAttribute('href'), xlink: s.getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
                marked: document.documentElement.outerHTML.includes(${JSON.stringify(MARK)}),
                link: a.matches(':link'), anyLink: a.matches(':any-link'), tabIndex: a.tabIndex, focused: document.activeElement === a,
            };
        })()`);
        expect(r).toEqual({ attr: INERT_HREF, href: INERT_HREF, area: INERT_HREF, svg: INERT_HREF, xlink: INERT_HREF, marked: false, link: true, anyLink: true, tabIndex: 0, focused: true });
        const view = page.frameLocator('web-sandbox iframe').frameLocator('iframe');
        expect(await view.getByRole('link', { name: 'link' }).count()).toBe(1);

        // a real drag from the page's mouse, the drag data read in the view by a listener added from outside
        await inView(page, browserName, `(() => { window.__drags = []; document.addEventListener('dragstart', (e) => window.__drags.push({ uri: e.dataTransfer.getData('text/uri-list'), text: e.dataTransfer.getData('text/plain') }), true); return true; })()`);
        await page.mouse.move((await page.locator('web-sandbox').boundingBox())!.x + 20, (await page.locator('web-sandbox').boundingBox())!.y + 15);
        await page.mouse.down();
        await page.mouse.move((await page.locator('web-sandbox').boundingBox())!.x + 80, (await page.locator('web-sandbox').boundingBox())!.y + 140, { steps: 8 });
        await page.mouse.up();
        const drags = await waitInView<any[]>(page, browserName, `window.__drags.length > 0 && window.__drags`, 5000);
        for (const drag of drags) {
            expect(drag.uri).toBe(INERT_HREF);
            expect([INERT_HREF, '']).toContain(drag.text); // WebKit puts no text/plain on a link drag
        }
    });

    test('positive control: a real click and Enter on the focused link are still cancelled and still delivered to the worker by id; nothing navigates', async ({ sandbox, page, browserName }) => {
        await page.evaluate(() => { (window as any).viewClicks = []; });
        await sandbox.exposeHost('clicked', '(ids) => { window.viewClicks.push(ids); return true; }');
        await sandbox.registerFiles({ 'main.js': `sandboxView.render(${JSON.stringify(LINKS + '<p id="done">done</p>')}); sandboxView.on('click', 'l', (e) => bridge.call('clicked', e.ids));` });
        expect(await sandbox.mount(strict({ entry: 'main.js' }))).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('done')`, 8000);
        await clickInSandbox(page, 20, 15);
        await expect.poll(() => page.evaluate(() => (window as any).viewClicks.length), { timeout: 5000 }).toBe(1);
        await inView(page, browserName, `document.getElementById('l').focus()`);
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'l'`); // keys go to the focused frame
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => (window as any).viewClicks), { timeout: 5000 }).toEqual([['l'], ['l']]);
        await page.waitForTimeout(500);
        expect(await inView(page, browserName, `location.href + ' ' + !!document.getElementById('l')`)).toBe('about:srcdoc true');
        expect(await sandbox.state()).toBe('ready');
        expect(page.url()).toMatch(/harness\.html$/);
    });
});

