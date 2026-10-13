import { test, expect } from './fixture';

/**
 * Configuration guard rails: a setting that weakens the sandbox, or that the browser would silently
 * discard, is announced on the console, once per instance.
 *   S4  scriptUnsafe: one warning per instance, naming the risk (eval in the guest)
 */

const SCRIPT_UNSAFE_WARNING = 'scriptUnsafe is enabled';

test.describe('S4: scriptUnsafe', () => {
    test('warns exactly once per instance across reset() and setConfig(), and the risk it names is real', async ({ sandbox, page }) => {
        const warnings: string[] = [];
        page.on('console', m => { if (m.type() === 'warning' && m.text().includes(SCRIPT_UNSAFE_WARNING)) warnings.push(m.text()); });

        expect(await sandbox.mount()).toBe('ready'); // the baseline config enables scriptUnsafe
        expect(await sandbox.reset()).toBe('ready');
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
        expect(await sandbox.mount({ scriptUnsafe: false })).toBe('ready');
        expect(await sandbox.mount()).toBe('ready');
        // what the warning names: guest code can compile strings as code
        expect(await sandbox.inGuest(`return eval('6 * 7')`)).toBe(42);

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('eval');
    });

    test('with scriptUnsafe off there is no warning and the guest cannot eval', async ({ sandbox, page }) => {
        const warnings: string[] = [];
        page.on('console', m => { if (m.type() === 'warning' && m.text().includes(SCRIPT_UNSAFE_WARNING)) warnings.push(m.text()); });
        await sandbox.exposeHost('report', '(value) => { window.evalReport = value; return true; }');

        expect(await sandbox.mount({ scriptUnsafe: false, html: `<script>
            let outcome;
            try { outcome = 'ran ' + eval('6 * 7'); } catch (e) { outcome = 'refused ' + e.name; }
            bridge.call('report', outcome);
        </script>` })).toBe('ready');
        await page.waitForFunction(() => (window as any).evalReport !== undefined);

        expect(await page.evaluate(() => (window as any).evalReport)).toBe('refused EvalError');
        expect(warnings).toEqual([]);
    });
});
