import { test, expect, ORIGIN } from './fixture';
import { fromPreset } from './presets';

// The build with the network modes (ADR-009): this file's tests mount them. A sealed test names the default build.
test.use({ build: 'network' });

/**
 * The capability-filter presets (backlog T4): each runs with its own rules, which ask for a capability the
 * sandbox must not grant, and asserts the refusal itself (start() throws it, naming the capability) plus, where one
 * exists, a positive control showing that the same payload does what it tries once the capability is really granted.
 * The payload runs with the rules the embedder is left with once it takes the refused capability out (`granted`).
 */

const sandboxAttribute = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const outer = (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe') as HTMLIFrameElement;
    return outer.getAttribute('sandbox') ?? '';
});

test('allow-same-origin is refused, and without it the guest origin stays opaque', async ({ sandbox, page }) => {
    const preset = fromPreset('allow-same-origin');
    await expect(sandbox.mount(preset.rules)).rejects.toThrow('[Sandbox] start(): "allow-same-origin" is not allowed in "capabilities".');
    expect(await sandbox.mount(preset.granted)).toBe('ready');

    const logs = await sandbox.runUntilDone(preset.code);

    expect(logs).toContain('PASS: Origin is opaque. Filter working.');
    expect(logs.filter(l => l.startsWith('PWN_'))).toEqual([]);
    expect(await sandboxAttribute(page)).not.toContain('allow-same-origin');
});

test('allow-top-navigation is refused, and without it the top navigation throws', async ({ sandbox, page }) => {
    const preset = fromPreset('allow-top-nav');
    const before = page.url();
    await expect(sandbox.mount(preset.rules)).rejects.toThrow('[Sandbox] start(): "allow-top-navigation" is not allowed in "capabilities".');
    expect(await sandbox.mount(preset.granted)).toBe('ready');

    const logs = await sandbox.runUntilDone(preset.code);
    await page.waitForTimeout(300);

    expect(logs.find(l => l.startsWith('PASS: Top navigation blocked'))).toBeDefined();
    expect(logs.filter(l => l.startsWith('PWN_'))).toEqual([]);
    expect(page.url()).toBe(before);
    expect(await sandboxAttribute(page)).not.toContain('allow-top-navigation');
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

test('allow-popups-to-escape-sandbox is refused: without it, a popup the guest opens keeps the sandbox', async ({ sandbox, page, context, browserName }) => {
    const preset = fromPreset('allow-popups-escape');
    const target = `${ORIGIN}/test/e2e/harness.html?popup`;
    await expect(sandbox.mount(preset.rules)).rejects.toThrow('[Sandbox] start(): "allow-popups-to-escape-sandbox" is not allowed in "capabilities".');
    expect(await sandbox.mount(preset.granted)).toBe('ready');
    expect(await sandboxAttribute(page)).toContain('allow-popups');
    expect(await sandboxAttribute(page)).not.toContain('allow-popups-to-escape-sandbox');

    const popupPromise = context.waitForEvent('page');
    const logs = await sandbox.runUntilDone(preset.aimedAt(target));
    // Chromium: the wrapper frame is credentialless, so its popups open without an opener and window.open() returns null
    // (S74); the popup is the evidence there, and is checked below
    // ledger: popup-opener
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
