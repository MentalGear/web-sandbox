import { test, expect } from './fixture';

// The build with the network modes (ADR-009): this file's tests mount them. A sealed test names the default build.
test.use({ build: 'network' });

/**
 * Configuration guard rails: a setting that weakens the sandbox, or that the browser would silently
 * discard, is announced on the console, once per instance.
 *   S4  scriptUnsafe: one warning per instance, naming the risk (eval in the guest)
 *   S7  frame-ancestors, report-uri, report-to and sandbox: a <meta> policy discards them, so they are left
 *       out of the guest policy with one warning per directive per instance
 */

const SCRIPT_UNSAFE_WARNING = 'scriptUnsafe is enabled';

test.describe('S4: scriptUnsafe', () => {
    test('warns exactly once per instance across reset(), once for each element that has it, and the risk it names is real', async ({ sandbox, page }) => {
        const warnings: string[] = [];
        page.on('console', m => { if (m.type() === 'warning' && m.text().includes(SCRIPT_UNSAFE_WARNING)) warnings.push(m.text()); });

        expect(await sandbox.mount()).toBe('ready'); // the baseline config enables scriptUnsafe
        expect(await sandbox.reset()).toBe('ready');
        expect(await sandbox.reset()).toBe('ready');
        expect(warnings).toHaveLength(1);
        // each mount is an element of its own: one with scriptUnsafe warns once, one without does not
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
        expect(await sandbox.mount({ scriptUnsafe: false })).toBe('ready');
        expect(warnings).toHaveLength(2);
        expect(await sandbox.mount()).toBe('ready');
        // what the warning names: guest code can compile strings as code
        expect(await sandbox.inGuest(`return eval('6 * 7')`)).toBe(42);

        expect(warnings).toHaveLength(3);
        for (const warning of warnings) expect(warning).toContain('eval');
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

test.describe('S7: directives a <meta> policy discards', () => {
    const IGNORED = ['frame-ancestors', 'report-uri', 'report-to', 'sandbox'];

    test('cannot be configured: named as origins they are dropped, with one warning per name per instance (element), in cooperative and worker mode; the browser has nothing to discard', async ({ sandbox, page, browserName }) => {
        const dropped: string[] = [];
        const discardedByBrowser: string[] = [];
        page.on('console', m => {
            const match = /origins\."([a-z-]+)" was dropped/.exec(m.text());
            if (m.type() === 'warning' && match) dropped.push(match[1]!);
            if (/ignored when delivered via a <meta> element/i.test(m.text())) discardedByBrowser.push(m.text());
        });
        const origins = { 'frame-ancestors': ["'none'"], 'report-uri': ['https://r.example/'], 'report-to': ['g'], 'sandbox': ['allow-scripts'] } as any;

        expect(await sandbox.mount({ origins })).toBe('ready');
        const policy: string = await sandbox.inGuest(`return document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`);
        expect(await sandbox.reset()).toBe('ready');
        expect([...dropped].sort(), 'once per name on the first element, across its reset()').toEqual([...IGNORED].sort());
        // a second element (worker mode) is another instance: once per name again
        expect(await sandbox.mount({ mode: 'worker', origins })).toBe('ready');

        for (const directive of IGNORED) expect(policy).not.toMatch(new RegExp(`(^|; )${directive}( |;)`));
        expect(dropped.sort()).toEqual([...IGNORED, ...IGNORED].sort());
        // Chromium reports each discarded directive on the console; research 11.1 is this channel's positive
        // control (the same message for a policy built by hand). None reaches it from the sandbox now.
        // ledger: discarded-directives-console
        if (browserName === 'chromium') expect(discardedByBrowser).toEqual([]);
    });
});
