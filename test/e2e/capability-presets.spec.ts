import { test, expect, ORIGIN } from './fixture';
import { fromPreset } from './presets';

/**
 * The capability-filter presets (backlog T4): each runs with its own rules, which ask for a capability the
 * sandbox must not grant, and asserts the refusal itself plus, where one exists, a positive control showing
 * that the same payload does what it tries once the capability is really granted.
 */

const sandboxAttribute = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const outer = (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe') as HTMLIFrameElement;
    return outer.getAttribute('sandbox') ?? '';
});

const dropWarnings = (page: import('@playwright/test').Page) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning' && m.text().includes('was dropped')) warnings.push(m.text()); });
    return warnings;
};

test('allow-same-origin is dropped with a warning, and the guest origin stays opaque', async ({ sandbox, page }) => {
    const preset = fromPreset('allow-same-origin');
    const warnings = dropWarnings(page);
    expect(await sandbox.mount(preset.rules)).toBe('ready');

    const logs = await sandbox.runUntilDone(preset.code);

    expect(logs).toContain('PASS: Origin is opaque. Filter working.');
    expect(logs.filter(l => l.startsWith('PWN_'))).toEqual([]);
    expect(await sandboxAttribute(page)).not.toContain('allow-same-origin');
    expect(warnings.join('\n')).toContain('"allow-same-origin" is not allowed in "capabilities"');
});

test('allow-top-navigation is dropped with a warning, and the top navigation throws', async ({ sandbox, page }) => {
    const preset = fromPreset('allow-top-nav');
    const warnings = dropWarnings(page);
    const before = page.url();
    expect(await sandbox.mount(preset.rules)).toBe('ready');

    const logs = await sandbox.runUntilDone(preset.code);
    await page.waitForTimeout(300);

    expect(logs.find(l => l.startsWith('PASS: Top navigation blocked'))).toBeDefined();
    expect(logs.filter(l => l.startsWith('PWN_'))).toEqual([]);
    expect(page.url()).toBe(before);
    expect(await sandboxAttribute(page)).not.toContain('allow-top-navigation');
    expect(warnings.join('\n')).toContain('"allow-top-navigation" is not allowed in "capabilities"');
});

test('alert() shows no dialog without allow-modals; with the explicit opt-in it does', async ({ sandbox, page }) => {
    const preset = fromPreset('alert-test');
    let dialogs = 0;
    page.on('dialog', dialog => { dialogs++; void dialog.dismiss(); });

    expect(await sandbox.mount(preset.rules)).toBe('ready');
    expect(await sandbox.runUntilDone(preset.code)).toContain('ALERT_RETURNED');
    await page.waitForTimeout(300);
    expect(dialogs).toBe(0);

    // positive control: the same payload with allow-modals granted through unsafeCapabilities
    expect(await sandbox.mount({ ...preset.rules, unsafeCapabilities: ['allow-modals'] })).toBe('ready');
    await sandbox.clearLogs();
    expect(await sandbox.runUntilDone(preset.code)).toContain('ALERT_RETURNED');
    expect(dialogs).toBe(1);
});

test('allow-popups-to-escape-sandbox is dropped: a popup the guest opens keeps the sandbox', async ({ sandbox, page, context, browserName }) => {
    const preset = fromPreset('allow-popups-escape');
    const warnings = dropWarnings(page);
    const target = `${ORIGIN}/test/e2e/harness.html?popup`;
    expect(await sandbox.mount(preset.rules)).toBe('ready');
    expect(await sandboxAttribute(page)).toContain('allow-popups');
    expect(await sandboxAttribute(page)).not.toContain('allow-popups-to-escape-sandbox');
    expect(warnings.join('\n')).toContain('"allow-popups-to-escape-sandbox" is not allowed in "capabilities"');

    const popupPromise = context.waitForEvent('page');
    const logs = await sandbox.runUntilDone(preset.aimedAt(target));
    // Chromium: the wrapper frame is credentialless, so its popups open without an opener and window.open() returns null
    // (S74); the popup is the evidence there, and is checked below
    expect(logs.find(l => l.startsWith(browserName === 'chromium' ? 'PWN_INFO: window.open() returned no window' : 'PWN_INFO: Popup opened'))).toBeDefined();
    const popup = await popupPromise;
    await popup.waitForURL(target);
    expect(await popup.evaluate(() => window.origin)).toBe('null');
    await popup.close();

    // positive control: the same window.open from a frame that does have the escape flag gives the page its own origin
    const escapedPromise = context.waitForEvent('page');
    await page.evaluate((code) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
        frame.srcdoc = `<script>${code}<\/script>`;
        document.body.appendChild(frame);
    }, preset.aimedAt(target));
    const escaped = await escapedPromise;
    await escaped.waitForURL(target);
    expect(await escaped.evaluate(() => window.origin)).toBe(ORIGIN);
    await escaped.close();
});
