import { test, expect, ORIGIN } from './fixture';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reasonText } from '@src/lib/reasons';

// Two bundles (ADR-009): dist/, the package as `bun run build:lib` writes it, which is the default build and has sealed
// mode alone, and dist-network/, the bundle of the build with the network modes, which the e2e server builds beside it
// (playwright.config.ts). The harness page loads the one the test's build names (package-harness.html).
const BUNDLES = { default: 'dist', network: 'dist-network' } as const;

/**
 * Starts `app` with `grants` on a fresh <packaged-sandbox> in the place of the page's (an element runs one app), and
 * settles to 'ready', `terminated: <reason>`, or `threw: <message>` when start() refuses them, in which case the page's
 * element stays as it was and the refused one is never inserted.
 */
const startPackaged = (page: Page, app: object, grants?: object) => page.evaluate(({ app, grants }) => new Promise<string>(resolve => {
    const sandbox = document.createElement('packaged-sandbox') as any;
    sandbox.addEventListener('ready', () => resolve('ready'), { once: true });
    sandbox.addEventListener('terminated', (event: CustomEvent) => resolve(`terminated: ${event.detail.reason}`), { once: true });
    try {
        sandbox.start(app, grants);
    } catch (error) {
        resolve(`threw: ${(error as Error).message}`);
        return;
    }
    document.querySelector('packaged-sandbox')!.replaceWith(sandbox);
}), { app, grants });

test.describe('the package as published: the default build', () => {
    // (the fixture's default build)
    const reason = reasonText('networkModesOff');

    test('the built package mounts a sealed sandbox under a custom tag: the entry runs in the worker and renders into the view', async ({ page }) => {
        await page.goto(`${ORIGIN}/test/e2e/package-harness.html`);
        await page.waitForFunction(() => (window as any).harnessReady === true);
        const violations: string[] = [];
        page.on('console', m => { if (/Content.Security.Policy|Refused to execute/i.test(m.text())) violations.push(m.text()); });
        const outcome = await startPackaged(page, {
            entry: 'main.js',
            files: { 'main.js': `sandboxView.render('<div style="height: 333px"></div>'); console.log('from the package ' + typeof fetch + ' ' + typeof WebAssembly);` },
        }, { autoResize: true });
        expect(outcome).toBe('ready');
        await page.waitForFunction(() => (window as any).sandboxLogs.includes('from the package undefined undefined'));
        // auto-sizing is the view's own report back to the host, so the element's height is the evidence that the render reached it
        await expect.poll(() => page.evaluate(() => (document.querySelector('packaged-sandbox') as HTMLElement).style.height)).toMatch(/^3[45]\d?px$/);
        expect(violations).toEqual([]);
    });

    test('its viewScriptHash(), in Node without a DOM and in the page, is the hash in the view policy the browser runs, and its bootstrap has no fetch bridge frame', async ({ page }) => {
        const built = await import(pathToFileURL(join(process.cwd(), BUNDLES.default, 'index.js')).href);
        const fromNode = built.viewScriptHash();
        expect(fromNode).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
        await page.goto(`${ORIGIN}/test/e2e/package-harness.html`);
        await page.waitForFunction(() => (window as any).harnessReady === true);
        expect(await startPackaged(page, {})).toBe('ready');
        const [exported, inPolicy, frames, bootstrap] = await page.evaluate(() => {
            const root = (document.querySelector('packaged-sandbox') as HTMLElement).shadowRoot!;
            const srcdoc = root.querySelector('iframe')!.srcdoc;
            return [(window as any).viewScriptHash(), `'${/script-src '(sha256-[A-Za-z0-9+/=]+)'/.exec(srcdoc)![1]}'`, root.querySelectorAll('iframe').length, srcdoc];
        });
        expect([exported, inPolicy]).toEqual([fromNode, fromNode]);
        expect(frames).toBe(1);
        expect(bootstrap).not.toContain('fetch-bridge');
        // the network build's bundle has another bootstrap, with the bridge frame's part, and so another hash
        const network = await import(pathToFileURL(join(process.cwd(), BUNDLES.network, 'index.js')).href);
        expect(network.viewScriptHash()).not.toBe(fromNode);
    });

    test.describe('a config of a network mode or option', () => {
        test.use({ otherBuildConfigs: true }); // the subject: the default build's refusal of what it does not have

        test('is refused whole by start(), with the reason that names the build flag, and the next sealed app builds', async ({ page }) => {
            await page.goto(`${ORIGIN}/test/e2e/package-harness.html`);
            await page.waitForFunction(() => (window as any).harnessReady === true);
            const settled: string[] = [];
            for (const grants of [{ mode: 'strict' }, { mode: 'cooperative', capabilities: ['allow-scripts'] }, { mode: 'worker' }, { origins: { images: ['https://cdn.example'] } }, { mode: 'sealed', fetchBridge: { allow: [] } }]) {
                settled.push(await startPackaged(page, { html: '<p>x</p>' }, grants));
                // the refused element was never inserted: the page's one element is the harness's, with no frame of the refused app
                expect(await page.evaluate(() => [document.querySelectorAll('packaged-sandbox').length, (document.querySelector('packaged-sandbox') as any).started])).toEqual([1, false]);
            }
            settled.push(await startPackaged(page, { html: '<p>sealed</p>' }));
            expect(settled).toEqual([...Array(5).fill(`threw: [Sandbox] start(): ${reason}.`), 'ready']);
            expect(reason).toContain('WEB_SANDBOX_NETWORK_MODES=1');
        });
    });
});

test.describe('the bundle of the build with the network modes', () => {
test.use({ build: 'network' });

// The built bundle stringifies the in-sandbox scripts like the sources do; a bundler transform that
// broke them would only show up here.
test('the built package mounts a working sandbox under a custom tag', async ({ page }) => {
    await page.goto(`${ORIGIN}/test/e2e/package-harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);

    expect(await startPackaged(page, {}, { mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true })).toBe('ready');

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
    expect(await startPackaged(page, {}, { mode: 'strict', scriptUnsafe: true, autoResize: true })).toBe('ready');
    // the render reaches the view only if its bootstrap ran (it creates the render port); auto-sizing is the
    // view's own report back to the host, so the element's height is the evidence, read from outside the view
    await page.evaluate(() => (document.querySelector('packaged-sandbox') as any).execute(`sandboxView.render('<div style="height: 333px"></div>'); console.log('rendered')`));
    await page.waitForFunction(() => (window as any).sandboxLogs.includes('rendered'));
    await expect.poll(() => page.evaluate(() => (document.querySelector('packaged-sandbox') as HTMLElement).style.height)).toMatch(/^3[45]\d?px$/);
    expect(violations).toEqual([]);
    // viewScriptHash() (R1:R4-5) is the bundle's own hash: the one in the view's policy, for a host page's policy
    const [exported, built] = await page.evaluate(() => {
        const srcdoc = (document.querySelector('packaged-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!.srcdoc;
        return [(window as any).viewScriptHash(), `'${/script-src '(sha256-[A-Za-z0-9+/=]+)'/.exec(srcdoc)![1]}'`];
    });
    expect(exported).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
    expect(exported).toBe(built);
});

// R2:C-8: an embedder reads the hash for its own policy at build time, in Node or Bun, from the package it
// ships (docs/API.md, "Host page policy"). Importing the package there must not need a DOM, and the value must be the one
// the browser finds in the view's policy: the bootstrap is one literal of the bundle, so nothing about where the bundle
// runs, or how a consumer's build minifies it, changes the text that is hashed.
test('the built package imports in Node without a DOM, and its viewScriptHash() is the hash in the view policy the browser runs', async ({ page }) => {
    const built = await import(pathToFileURL(join(process.cwd(), BUNDLES.network, 'index.js')).href);
    const fromNode = built.viewScriptHash();
    expect(fromNode).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
    await page.goto(`${ORIGIN}/test/e2e/package-harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    expect(await startPackaged(page, {}, { mode: 'strict' })).toBe('ready');
    const inPolicy = await page.evaluate(() => {
        const srcdoc = (document.querySelector('packaged-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!.srcdoc;
        return `'${/script-src '(sha256-[A-Za-z0-9+/=]+)'/.exec(srcdoc)![1]}'`;
    });
    expect(fromNode).toBe(inPolicy);
});

// AR:A8: the default bootstrap is asserted parser-safe when the
// guest document is built (no "</script", "<script", "<!--" or NUL), and the bundle's function text is what is
// asserted here. Every variant of the bootstrap is built: cooperative mode with files, the module graph, markup
// references, the fetch bridge and auto-sizing, and worker mode, each an element of its own. A text that failed the
// assertion would end the build and never reach 'ready'.
test('the built package passes the parser-safety assertion for every default bootstrap variant (review A8)', async ({ page }) => {
    await page.goto(`${ORIGIN}/test/e2e/package-harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    const files = { 'app.js': 'import "./lib.js"; console.log("module ran")', 'lib.js': 'export {}', 'a.css': 'p { color: red }', 'i.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' };
    const html = '<script type="module" src="app.js"></script><link rel="stylesheet" href="a.css"><img src="i.svg">';
    const outcomes = [
        await startPackaged(page, { html, files }, { mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true, autoResize: true, fetchBridge: { allow: ['https://api.example'] } }),
        await startPackaged(page, { files }, { mode: 'worker', scriptUnsafe: true, fetchBridge: { allow: [] } }),
    ];
    expect(outcomes).toEqual(['ready', 'ready']);
});
});
