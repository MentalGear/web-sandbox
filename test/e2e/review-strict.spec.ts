import { test, expect, type SandboxDriver } from './fixture';
import { inView, waitInView } from './strict-view';
import type { SandboxConfig } from '@src/host';

/**
 * Adversarial review 2026-10, strict mode and files (docs/security/ADVERSARIAL-REVIEW-2026-10.md):
 *   C1  every blob: URL that resolves in the view names a registered file: the worker's own source URL is revoked
 *       once the worker exists, and a worker's copy of a JavaScript file is inert as a stylesheet;
 *   C2  the entry runs in its own scope: its top-level declarations cannot replace the globals the prelude
 *       captures and deletes, and an entry that escapes its scope does not start;
 *   C3  the prelude's lists reach no inherited setter: guest code watching every array write sees none of them,
 *       and flow control holds;
 *   C4  (measured) the view's violation cap is shared with the guest's own refused loads;
 *   C5  (measured, residual) a rendered link keeps its href: user-agent actions on it are outside the page.
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
    test("the worker's own source URL resolves in the view but renders nothing: referenced from <style> text and a CSS-escaped style attribute (which the renderer does not inspect), it applies no rule and decodes as no image", async ({ sandbox, page, browserName }) => {
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
                startsWithPrelude: typeof text === 'string' && text.startsWith('(function (g) {'),
                image,
                ruleApplied: getComputedStyle(document.getElementById('c1')).width === '66px',
                escapedKept: document.getElementById('bg').getAttribute('style').includes('6f b:'),
            };
        })()`);
        expect(r).toEqual({ startsWithPrelude: true, image: 'error', ruleApplied: false, escapedKept: true });
    });

    test("a worker's copies of registered files resolve in the view: a copy of a JavaScript file is refused as a stylesheet (its type), a copy of a stylesheet applies (positive control): neither shows more than the registered content", async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'rule.js': '#viaJs { width: 77px }', 'rule.css': '#viaCss { width: 55px }' });
        expect(await sandbox.mount(strict())).toBe('ready');
        const urls = await sandbox.inGuest(`return { js: sandboxFiles.url('rule.js'), css: sandboxFiles.url('rule.css') }`);
        await render(sandbox, browserName, `<style>@import url("${urls.js}"); @import url("${urls.css}");</style><i id="viaJs" style="display:block"></i><i id="viaCss" style="display:block"></i>`);
        await waitInView(page, browserName, `getComputedStyle(document.getElementById('viaCss')).width === '55px'`, 8000);
        expect(await inView(page, browserName, `getComputedStyle(document.getElementById('viaJs')).width`)).not.toBe('77px');
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

test('C4 (measured): the view\'s violation cap is shared with the guest\'s own refused loads: 150 refused images in rendered markup use it up, one warning, and a later refusal in the view goes unreported', async ({ sandbox, page, browserName }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning' && m.text().includes('CSP violations')) warnings.push(m.text()); });
    expect(await sandbox.mount(strict())).toBe('ready');
    let markup = '';
    for (let i = 0; i < 150; i++) markup += `<img src="https://attacker.test/flood-${i}.svg">`;
    await render(sandbox, browserName, markup);
    await expect.poll(async () => (await sandbox.violations()).filter(v => v.source === 'view').length, { timeout: 8000 }).toBe(100);
    await render(sandbox, browserName, '<img src="https://attacker.test/after-cap.svg">', 'done-2');
    await page.waitForTimeout(800);
    const view = (await sandbox.violations()).filter(v => v.source === 'view');
    expect(view).toHaveLength(100);
    expect(view.some(v => v.blockedURI.includes('after-cap'))).toBe(false);
    expect(warnings.length).toBeLessThanOrEqual(1); // the view stops forwarding at the cap itself; the host warns only past it
});

test('C5 (measured, residual): a rendered link keeps its href, so the user agent\'s own actions on it (open in a new tab, drag) are outside what the view can cancel; clicks are cancelled (G4)', async ({ sandbox, page, browserName }) => {
    expect(await sandbox.mount(strict())).toBe('ready');
    await render(sandbox, browserName, '<a id="l" href="https://attacker.test/ua-action">link</a>');
    expect(await inView(page, browserName, `document.getElementById('l').getAttribute('href')`)).toBe('https://attacker.test/ua-action');
});

