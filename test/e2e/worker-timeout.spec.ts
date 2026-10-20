import { test, expect } from './fixture';
import { fromPreset } from './presets';

/**
 * workerExecutionTimeout (backlog B8; ADR-003 amendments 2026-10-14): each execute() gets its own deadline, at which
 * the guest's event loop must be free (focused review F2: the host pings, only a free loop answers), and a loop still
 * busy then ends the sandbox with a 'terminated' event, like the watchdog. Evidence: the element's state and
 * events, and the guest's own globals (an environment that was rebuilt has lost them). The evasions (a scheduled
 * loop, a replaced Function) are in inert-files-and-smil.spec.ts.
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

        test('code that returned within the budget leaves the event loop free at the deadline: no line, no termination, no rebuild, the guest keeps its state past the deadline and its grace (positive control)', async ({ sandbox, page }) => {
            expect(await sandbox.mount({ mode, scriptUnsafe: true, workerExecutionTimeout: 300 })).toBe('ready');
            await watch(page);
            await sandbox.run('globalThis.kept = 42; console.log("returned")');
            await sandbox.waitForLog('returned');
            await page.waitForTimeout(300 + 1500); // the deadline and the grace (EXECUTION_TIMEOUT_GRACE_MS)
            expect(await sandbox.state()).toBe('ready');
            expect(await page.evaluate(() => [(window as any).terminations, (window as any).readies])).toEqual([[], 0]);
            expect(await sandbox.inGuest('return globalThis.kept')).toBe(42);
            expect((await sandbox.logs()).filter(line => line.includes('Execution Timeout'))).toEqual([]);
        });
    });
}
