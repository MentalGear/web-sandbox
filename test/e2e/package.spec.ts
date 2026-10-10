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
