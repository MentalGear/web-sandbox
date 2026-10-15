import { test, expect } from '@playwright/test';
import { ORIGIN } from './fixture';

// The built bundle stringifies the in-sandbox scripts like the sources do; a bundler transform that
// broke them would only show up here.
test('the built package mounts a working sandbox under a custom tag', async ({ page }) => {
    await page.goto(`${ORIGIN}/test/e2e/package-harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);

    const outcome = await page.evaluate(() => new Promise<string>(resolve => {
        const sandbox = document.querySelector('packaged-sandbox') as any;
        sandbox.addEventListener('ready', () => resolve('ready'), { once: true });
        sandbox.addEventListener('terminated', () => resolve('terminated'), { once: true });
        sandbox.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true });
    }));
    expect(outcome).toBe('ready');

    await page.evaluate(() => (document.querySelector('packaged-sandbox') as any).execute('console.log("from the package " + window.origin)'));
    await page.waitForFunction(() => (window as any).sandboxLogs.includes('from the package null'));
});

// Strict mode admits its view bootstrap by the hash of the text the page actually serves (ADR-005): the
// bundle's function text differs from the sources', so the hash must be computed from it, at run time.
test('the built package runs strict mode: the view bootstrap is admitted by its hash and renders what the worker sends', async ({ page }) => {
    await page.goto(`${ORIGIN}/test/e2e/package-harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    const violations: string[] = [];
    page.on('console', m => { if (/Content.Security.Policy|Refused to execute/i.test(m.text())) violations.push(m.text()); });
    const outcome = await page.evaluate(() => new Promise<string>(resolve => {
        const sandbox = document.querySelector('packaged-sandbox') as any;
        sandbox.addEventListener('ready', () => resolve('ready'), { once: true });
        sandbox.addEventListener('terminated', () => resolve('terminated'), { once: true });
        sandbox.setConfig({ mode: 'strict', scriptUnsafe: true, autoResize: true });
    }));
    expect(outcome).toBe('ready');
    // the render reaches the view only if its bootstrap ran (it creates the render port); auto-sizing is the
    // view's own report back to the host, so the element's height is the evidence, read from outside the view
    await page.evaluate(() => (document.querySelector('packaged-sandbox') as any).execute(`sandboxView.render('<div style="height: 333px"></div>'); console.log('rendered')`));
    await page.waitForFunction(() => (window as any).sandboxLogs.includes('rendered'));
    await expect.poll(() => page.evaluate(() => (document.querySelector('packaged-sandbox') as HTMLElement).style.height)).toMatch(/^3[45]\d?px$/);
    expect(violations).toEqual([]);
    // viewScriptHash() (review round 1, R4-5) is the bundle's own hash: the one in the view's policy, for a host page's policy
    const [exported, built] = await page.evaluate(() => {
        const srcdoc = (document.querySelector('packaged-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!.srcdoc;
        return [(window as any).viewScriptHash(), `'${/script-src '(sha256-[A-Za-z0-9+/=]+)'/.exec(srcdoc)![1]}'`];
    });
    expect(exported).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
    expect(exported).toBe(built);
});

// Review A8 (docs/security/ADVERSARIAL-REVIEW-2026-10.md): the default bootstrap is asserted parser-safe when the
// guest document is built (no "</script", "<script", "<!--" or NUL), and the bundle's function text is what is
// asserted here. Every variant of the bootstrap is built: cooperative mode with files, the module graph, markup
// references, the fetch bridge and auto-sizing, and worker mode. A text that failed the assertion would throw in
// setConfig() and never reach 'ready'.
test('the built package passes the parser-safety assertion for every default bootstrap variant (review A8)', async ({ page }) => {
    await page.goto(`${ORIGIN}/test/e2e/package-harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    const outcomes = await page.evaluate(async () => {
        const sandbox = document.querySelector('packaged-sandbox') as any;
        sandbox.registerFiles({ 'app.js': 'import "./lib.js"; console.log("module ran")', 'lib.js': 'export {}', 'a.css': 'p { color: red }', 'i.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
        const settle = (config: object) => new Promise<string>(resolve => {
            const done = (event: Event) => { sandbox.removeEventListener('ready', done); sandbox.removeEventListener('terminated', done); resolve(event.type); };
            sandbox.addEventListener('ready', done);
            sandbox.addEventListener('terminated', done);
            try { sandbox.setConfig(config); } catch (error) { resolve('threw: ' + String(error)); }
        });
        const html = '<script type="module" src="app.js"></script><link rel="stylesheet" href="a.css"><img src="i.svg">';
        return [
            await settle({ mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true, autoResize: true, fetchBridge: { allow: ['https://api.example'] }, html }),
            await settle({ mode: 'worker', scriptUnsafe: true, fetchBridge: { allow: [] } }),
        ];
    });
    expect(outcomes).toEqual(['ready', 'ready']);
});
