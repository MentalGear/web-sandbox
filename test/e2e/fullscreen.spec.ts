import { test, expect } from './fixture';

const CHECK = `console.log('FULLSCREEN_ENABLED ' + document.fullscreenEnabled)`;

test('fullscreen is not available by default', async ({ sandbox }) => {
    await sandbox.mount();

    await sandbox.run(CHECK);

    expect(await sandbox.waitForLog('FULLSCREEN_ENABLED')).toBe('FULLSCREEN_ENABLED false');
});

test('fullscreen in "capabilities" is dropped with a warning', async ({ sandbox, page }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });

    await sandbox.mount({ capabilities: ['allow-scripts', 'fullscreen' as any] });
    await sandbox.run(CHECK);

    expect(await sandbox.waitForLog('FULLSCREEN_ENABLED')).toBe('FULLSCREEN_ENABLED false');
    expect(warnings.join('\n')).toContain('"fullscreen" is not allowed in "capabilities"');
});

test('the unsafeCapabilities opt-in grants fullscreen through both frames, and warns', async ({ sandbox, page }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });

    await sandbox.mount({ unsafeCapabilities: ['fullscreen'] });
    await sandbox.run(CHECK);

    expect(await sandbox.waitForLog('FULLSCREEN_ENABLED')).toBe('FULLSCREEN_ENABLED true');
    expect(warnings.join('\n')).toContain('unsafe capability "fullscreen" is enabled');

    // it is a Permissions Policy feature, not a sandbox flag
    const frame = await page.evaluate(() => {
        const iframe = (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe');
        return { sandbox: iframe.getAttribute('sandbox'), allow: iframe.getAttribute('allow') };
    });
    expect(frame).toEqual({ sandbox: 'allow-scripts', allow: 'fullscreen' });
});
