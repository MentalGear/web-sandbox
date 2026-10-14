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
        sandbox.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true });
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
});
