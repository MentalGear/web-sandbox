import type { Page } from '@playwright/test';
import { expect, type SandboxDriver } from './fixture';
import { waitInView } from './strict-view';

/**
 * Helpers of the strict view input specs (research 23): a strict sandbox whose worker keeps what its handlers receive,
 * read back through the bridge.
 */

/** A pad filling the view, with a thumb in it. */
export const PAD = '<div id="pad" style="position:absolute;inset:0;touch-action:none;user-select:none"><div id="thumb" style="position:absolute;left:20px;top:20px;width:40px;height:40px;background:#c33"></div></div><p id="ready" style="position:absolute;left:0;bottom:0;margin:0">ready</p>';

/** Mounts strict mode rendering `markup`, with `entry` run after it; every detail a handler made with `keep(label)` gets is kept. */
export async function mountInput(sandbox: SandboxDriver, browserName: string, entry: string, markup = PAD) {
    await sandbox.registerFiles({ 'main.js': `
        const kept = [];
        const keep = (label) => (detail) => { kept.push({ label, detail }); };
        bridge.expose('take', () => kept.splice(0));
        sandboxView.render(${JSON.stringify(markup)});
        ${entry}
    ` });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js' })).toBe('ready');
    await waitInView(sandbox.page, browserName, `!!document.getElementById('ready')`);
}

export type Kept = { label: string; detail: any };

/** What the handlers kept since the last take. */
export const take = (sandbox: SandboxDriver) => sandbox.call<Kept[]>('take');

/** Everything the handlers keep until they stop: taken until a take comes back empty. */
export async function drain(sandbox: SandboxDriver, pause = 200): Promise<Kept[]> {
    const all: Kept[] = [];
    for (;;) {
        const kept = await take(sandbox);
        if (kept.length === 0) return all;
        all.push(...kept);
        await new Promise(resolve => setTimeout(resolve, pause));
    }
}

/** The sandbox element's box on the page. */
export async function boxOf(page: Page) {
    return (await page.locator('web-sandbox').boundingBox())!;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
