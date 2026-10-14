import { test, expect } from './fixture';
import { fromPreset } from './presets';

/**
 * workerExecutionTimeout is a budget for code still running (backlog B8, ADR-003 amendment 2026-10-14): each
 * execute() gets its own, the guest reports when the code returned, and code still running at the deadline ends
 * the sandbox with a 'terminated' event, like the watchdog. Evidence: the element's state and events, and the
 * guest's own globals (an environment that was rebuilt has lost them).
 */

const preset = fromPreset('worker-timeout');
const REASON = 'the executed code ran longer than workerExecutionTimeout';

// Records every 'terminated' reason and every state change the element announces, from the host page.
async function watch(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        const s = document.querySelector('web-sandbox') as any;
        (window as any).terminations = [];
        (window as any).readies = 0;
        s.addEventListener('terminated', (e: CustomEvent) => (window as any).terminations.push(e.detail.reason));
        s.addEventListener('ready', () => (window as any).readies++);
    });
}

for (const mode of ['worker', 'strict'] as const) {
    test.describe(`${mode} mode`, () => {
        test('code still running at the deadline terminates the sandbox: the host line, then terminated with the reason; reset() recovers', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ ...preset.rules, mode })).toBe('ready');
            await watch(page);
            await sandbox.run(preset.code);
            await sandbox.waitForLog('Execution Timeout', 5000);
            await expect.poll(() => sandbox.state(), { timeout: 5000 }).toBe('terminated');
            expect(await page.evaluate(() => [(window as any).terminations, (window as any).readies])).toEqual([[REASON], 0]);
            expect(await page.evaluate(() => (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe'))).toBeNull();

            expect(await sandbox.reset()).toBe('ready');
            expect(await sandbox.inGuest('return "alive after reset"')).toBe('alive after reset');
        });

        test('code that returned within the budget ends its timer: no line, no termination, no rebuild, the guest keeps its state past the deadline (positive control)', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode, scriptUnsafe: true, workerExecutionTimeout: 300 })).toBe('ready');
            await watch(page);
            await sandbox.run('globalThis.kept = 42; console.log("returned")');
            await sandbox.waitForLog('returned');
            await page.waitForTimeout(900);
            expect(await sandbox.state()).toBe('ready');
            expect(await page.evaluate(() => [(window as any).terminations, (window as any).readies])).toEqual([[], 0]);
            expect(await sandbox.inGuest('return globalThis.kept')).toBe(42);
            expect((await sandbox.logs()).filter(line => line.includes('Execution Timeout'))).toEqual([]);
        });
    });
}
