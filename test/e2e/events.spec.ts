import { test, expect } from './fixture';

/**
 * Per-instance events (backlog B3, ADR-003). 'sandbox-log' is dispatched on the sandbox element and
 * bubbles: a listener on an element hears only that sandbox, a listener on window hears every sandbox
 * with the element as event.target, and SandboxDevTools (which listens on its element) prints its
 * sandbox's logs and no other's.
 */

const MODES = ['iframe', 'worker', 'strict'] as const;

for (const mode of MODES) {
    test(`each sandbox element receives only its own logs; a window listener receives both, targeted at their element (${mode})`, async ({ sandbox, page }) => {
        expect(await sandbox.mount({ mode })).toBe('ready');
        expect(await sandbox.mountSecond({ mode })).toBe('ready');

        await page.evaluate(() => {
            const first = document.querySelector('web-sandbox') as any;
            const second = document.getElementById('second') as any;
            const text = (e: Event) => ((e as CustomEvent).detail?.args || []).map(String).join(' ');
            const seen = { first: [] as string[], second: [] as string[], window: [] as { target: string; text: string }[] };
            (window as any).seen = seen;
            first.addEventListener('sandbox-log', (e: Event) => seen.first.push(text(e)));
            second.addEventListener('sandbox-log', (e: Event) => seen.second.push(text(e)));
            window.addEventListener('sandbox-log', (e: Event) => {
                const target = e.target === first ? 'first' : e.target === second ? 'second' : 'other';
                seen.window.push({ target, text: text(e) });
            });
            first.execute('console.log("FROM_FIRST")');
            second.execute('console.log("FROM_SECOND")');
        });
        await sandbox.waitForLog('FROM_FIRST');
        await sandbox.waitForLog('FROM_SECOND');

        const seen = await page.evaluate(() => (window as any).seen);
        const probes = (lines: string[]) => lines.filter(line => line.startsWith('FROM_'));
        expect(probes(seen.first)).toEqual(['FROM_FIRST']);
        expect(probes(seen.second)).toEqual(['FROM_SECOND']);
        expect(seen.window).toContainEqual({ target: 'first', text: 'FROM_FIRST' });
        expect(seen.window).toContainEqual({ target: 'second', text: 'FROM_SECOND' });
        expect(seen.window.filter((entry: { target: string }) => entry.target === 'other')).toEqual([]);
    });
}

test('the worker execution-timeout log is dispatched on its own sandbox element', async ({ sandbox, page }) => {
    expect(await sandbox.mount({ mode: 'worker', workerExecutionTimeout: 300 })).toBe('ready');
    await page.evaluate(() => {
        const s = document.querySelector('web-sandbox') as any;
        (window as any).onElement = [];
        s.addEventListener('sandbox-log', (e: Event) => (window as any).onElement.push({
            onSelf: e.target === s,
            text: ((e as CustomEvent).detail?.args || []).join(' '),
        }));
    });

    await sandbox.run('while (true) {}');
    await sandbox.waitForLog('Execution Timeout');

    expect(await page.evaluate(() => (window as any).onElement)).toContainEqual({ onSelf: true, text: 'Execution Timeout' });
});

test('SandboxDevTools prints its own sandbox\'s guest logs, not another sandbox\'s, and stops when deactivated', async ({ sandbox, page }) => {
    expect(await sandbox.mount()).toBe('ready');
    expect(await sandbox.mountSecond()).toBe('ready');

    await page.evaluate(async () => {
        const modulePath = '/src/devtools.ts'; // served by the dev server; a variable keeps tsc from resolving it
        const { SandboxDevTools } = await import(modulePath);
        // Record what the HOST page prints. The guest's own console is another realm, so only DevTools lands here.
        const printed: string[] = [];
        (window as any).printed = printed;
        console.log = (...args: unknown[]) => { printed.push('log: ' + args.map(String).join(' ')); };
        console.groupCollapsed = (...args: unknown[]) => { printed.push('group: ' + args.map(String).join(' ')); };
        const devtools = new SandboxDevTools(document.querySelector('web-sandbox') as HTMLElement);
        (window as any).devtools = devtools;
        devtools.activate();
    });

    await sandbox.run('console.log("DEVTOOLS_PROBE")');
    await page.evaluate(() => (document.getElementById('second') as any).execute('console.log("OTHER_SANDBOX")'));
    await sandbox.waitForLog('DEVTOOLS_PROBE');
    await sandbox.waitForLog('OTHER_SANDBOX'); // delivered to the page, so DevTools had its chance to print it

    await page.evaluate(() => (window as any).devtools.deactivate());
    await sandbox.run('console.log("AFTER_DEACTIVATE")');
    await sandbox.waitForLog('AFTER_DEACTIVATE');

    const printed: string[] = await page.evaluate(() => (window as any).printed);
    expect(printed).toContainEqual(expect.stringMatching(/^group: %c\[Sandbox\] LOG \(guest\)/));
    // the guest's values follow a fixed first argument, so none is read as a format string (review B3)
    expect(printed).toContainEqual(expect.stringMatching(/^log: +DEVTOOLS_PROBE$/));
    expect(printed.filter(line => line.includes('OTHER_SANDBOX'))).toEqual([]);
    expect(printed.filter(line => line.includes('AFTER_DEACTIVATE'))).toEqual([]);
});
