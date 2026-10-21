import { test, expect } from './fixture';

// allow-pointer-lock lets a guest hide the cursor and capture relative input: an unsafe capability, like fullscreen.

const flagsOf = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const frame = (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe') as HTMLIFrameElement;
    return { outer: frame.getAttribute('sandbox'), inner: new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('iframe')?.getAttribute('sandbox') ?? null };
});

test('allow-pointer-lock in "capabilities" is dropped with a warning, in cooperative and strict mode', async ({ sandbox, page }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });

    await sandbox.mount({ mode: 'cooperative', capabilities: ['allow-scripts', 'allow-pointer-lock' as any] });
    expect(await flagsOf(page)).toEqual({ outer: 'allow-scripts', inner: 'allow-scripts' });
    await sandbox.mount({ mode: 'strict', capabilities: ['allow-pointer-lock' as any] });
    expect(await flagsOf(page)).toEqual({ outer: 'allow-scripts allow-forms', inner: 'allow-scripts allow-forms' });
    expect(warnings.filter(w => w.includes('"allow-pointer-lock" is not allowed in "capabilities"')).length).toBeGreaterThanOrEqual(1);
});

test('unsafeCapabilities grants allow-pointer-lock in cooperative mode, and warns; strict mode drops it', async ({ sandbox, page }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });

    await sandbox.mount({ mode: 'cooperative', capabilities: ['allow-scripts'], unsafeCapabilities: ['allow-pointer-lock'] });
    expect(await flagsOf(page)).toEqual({ outer: 'allow-scripts allow-pointer-lock', inner: 'allow-scripts allow-pointer-lock' });
    expect(warnings.join('\n')).toContain('unsafe capability "allow-pointer-lock" is enabled');

    await sandbox.mount({ mode: 'strict', unsafeCapabilities: ['allow-pointer-lock'] });
    expect(await flagsOf(page)).toEqual({ outer: 'allow-scripts allow-forms', inner: 'allow-scripts allow-forms' });
    expect(warnings.join('\n')).toContain('unsafeCapabilities are not available in strict mode and were dropped: allow-pointer-lock.');
});
