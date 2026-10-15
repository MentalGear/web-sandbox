import { test, expect, type SandboxDriver } from './fixture';
import type { MountConfig } from './fixture';
import { useRecorder } from './recorder';

const recorder = useRecorder();

/**
 * Fresh review round 1 (docs/security/REVIEW-ROUND-1-2026-10-15.md): the findings where the browser decides, on
 * Chromium, Firefox and WebKit. Each test failed at 5ede7ba. Evidence: what the host page's sandbox-log listener
 * receives (the harness), and host-page timing measured in the host page.
 */

const MODES: Record<string, MountConfig> = {
    cooperative: { mode: 'cooperative' },
    worker: { mode: 'worker' },
    strict: { mode: 'strict', scriptUnsafe: true },
};

// What structured clone refuses, per realm: a document has nodes; every realm has Events, Responses, Proxies,
// WeakMaps, Promises, functions and Symbols.
const UNCLONABLE = `[() => 1, Symbol('s'), new Event('x'), new Response('r'), new Proxy({}, {}), new WeakMap(), Promise.resolve(1), { f() {} }]`;
const UNCLONABLE_TEXT = '[function] Symbol(s) [object Event] [object Response] [object Object] [object WeakMap] [object Promise] [object Object]';

test.describe('R4-1: the console relay never throws', () => {
    for (const [mode, config] of Object.entries(MODES)) {
        test(`${mode} mode: a line of values clone refuses arrives with each named by its kind, and the guest's console call does not throw`, async ({ sandbox }) => {
            expect(await sandbox.mount(config)).toBe('ready');
            const outcome = await sandbox.inGuest(`
                const values = ${UNCLONABLE};
                ${mode === 'cooperative' ? 'values.push(document.body);' : ''}
                try { console.log('R41', ...values); return 'logged'; } catch (error) { return 'threw ' + error.name; }`);
            expect(outcome).toBe('logged');
            const line = await sandbox.waitForLog(/^R41 /);
            expect(line).toBe(`R41 ${UNCLONABLE_TEXT}${mode === 'cooperative' ? ' [object HTMLBodyElement]' : ''}`);
        });
    }

    test('strict mode, before the worker is attached: an entry that logs unclonable values at its top level starts, and its lines arrive', async ({ sandbox }) => {
        await sandbox.registerFiles({ 'main.js': `console.log('R41 entry', ${UNCLONABLE}[0], ${UNCLONABLE}[3]); console.log('R41 entry done');` });
        expect(await sandbox.mount({ mode: 'strict', entry: 'main.js' })).toBe('ready');
        await sandbox.waitForLog('R41 entry done');
        expect(await sandbox.logs()).toContain('R41 entry [function] [object Response]');
        expect(await sandbox.state()).toBe('ready');
    });
});

test.describe('R4-2, R4-6, R4-7: uncaught errors and unhandled rejections reach sandbox-log', () => {
    // WebKit mutes the errors of the guest document's inline scripts and handlers and of a worker's blob: script: it
    // gives "Script error." and no error object (measured), and that is what arrives.
    test('cooperative mode: classic, module and syntax errors, an inline handler and an unhandled rejection are "Uncaught …" lines (WebKit: muted, "Script error.", except the module)', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({
            mode: 'cooperative',
            html: `<button id="b" onclick="throw new Error('inline')">b</button>
                   <script>throw new Error('classic')</script>
                   <script type="module">throw new Error('module')</script>
                   <script>(</script>
                   <script>Promise.reject(new Error('rejected'))</script>`,
        })).toBe('ready');
        await sandbox.waitForLog('Uncaught (in promise) Error: rejected');
        await page.locator('web-sandbox iframe').contentFrame().locator('iframe').contentFrame().locator('#b').click();
        await sandbox.waitForLog('Uncaught Error: module');
        const muted = browserName === 'webkit';
        if (muted) await expect.poll(async () => (await sandbox.logs()).filter(line => line === 'Uncaught Script error.').length).toBe(3); // classic, syntax, inline
        else await sandbox.waitForLog('Uncaught Error: inline');
        const logs = await sandbox.logs();
        if (!muted) {
            expect(logs).toContain('Uncaught Error: classic');
            expect(logs.some(line => /^Uncaught SyntaxError/.test(line))).toBe(true);
        }
        expect(logs.filter(line => line.startsWith('Uncaught Uncaught'))).toEqual([]);
    });

    for (const mode of ['worker', 'strict'] as const) {
        test(`${mode} mode: a later uncaught error and an unhandled rejection are one line each, "Uncaught" once (WebKit's worker mode: muted)`, async ({ sandbox, browserName }) => {
            expect(await sandbox.mount(MODES[mode]!)).toBe('ready');
            await sandbox.run(`setTimeout(() => { throw new Error('later') }); Promise.reject(new TypeError('promised'));`);
            await sandbox.waitForLog('Uncaught (in promise) TypeError: promised');
            // strict mode: the view's Worker object still has the text WebKit mutes in the worker (in-sandbox-view.ts)
            const line = browserName === 'webkit' && mode === 'worker' ? 'Uncaught Script error.' : 'Uncaught Error: later';
            await sandbox.waitForLog(line);
            const logs = await sandbox.logs();
            expect(logs.filter(entry => entry.includes('later') || entry.includes('Script error'))).toEqual([line]);
            expect(logs.filter(line => line.startsWith('Uncaught Uncaught'))).toEqual([]);
            expect(await sandbox.state()).toBe('ready');
        });
    }

    test('an Error argument arrives as { name, message, stack }', async ({ sandbox, page }) => {
        expect(await sandbox.mount({ mode: 'strict', scriptUnsafe: true })).toBe('ready');
        // a plain object with its own name, message and stack (a cloned Error has no own enumerable fields)
        const detail = page.evaluate(() => new Promise(resolve => {
            window.addEventListener('sandbox-log', (event: any) => {
                const arg = event.detail.args[1];
                if (event.detail.args[0] === 'R47') resolve({ plain: Object.getPrototypeOf(arg) === Object.prototype, keys: Object.keys(arg).sort(), name: arg.name, message: arg.message, stack: typeof arg.stack });
            });
        }));
        await sandbox.run(`console.error('R47', new RangeError('out'))`);
        expect(await detail).toEqual({ plain: true, keys: ['message', 'name', 'stack'], name: 'RangeError', message: 'out', stack: 'string' });
    });
});

test.describe('R3-3: byte budgets on log lines and RPC messages', () => {
    test('strict mode: a 64 MiB typed array logged by the guest crosses as a few bytes; an RPC call past the budget is refused in the guest', async ({ sandbox }) => {
        expect(await sandbox.mount({ mode: 'strict', scriptUnsafe: true })).toBe('ready');
        await sandbox.exposeHost('sink', '(...args) => args.length');
        const outcome = await sandbox.inGuest(`
            console.log('R33', new Uint8Array(64 * 1024 * 1024));
            try { await bridge.call('sink', new Uint8Array(34 * 1024 * 1024)); return 'sent'; } catch (error) { return error.code; }`);
        expect(outcome).toBe('ARGS_NOT_TRANSFERABLE');
        expect(await sandbox.waitForLog(/^R33 /)).toMatch(/^R33 \[\[object Uint8Array\]: past the log line's byte budget/);
        // a positive control: a call within the budget is answered
        expect(await sandbox.inGuest(`return bridge.call('sink', new Uint8Array(1024 * 1024), 2)`)).toBe(2);
    });

    test('strict mode: a 3 s flood of maximal log lines (64 strings of 64 Ki characters each) leaves the host page responsive', async ({ sandbox, page, browserName }) => {
        test.setTimeout(30000);
        expect(await sandbox.mount({ mode: 'strict', scriptUnsafe: true })).toBe('ready');
        const countTicks = () => page.evaluate(() => new Promise<number>(resolve => {
            let count = 0;
            const timer = setInterval(() => count++, 10);
            setTimeout(() => { clearInterval(timer); resolve(count); }, 2500);
        }));
        const idle = await countTicks(); // the control: the same page with the guest idle
        await sandbox.run(`const s = 'x'.repeat(65536); const args = new Array(64).fill(s); const end = Date.now() + 3000;
            while (Date.now() < end) console.log(...args);
            setTimeout(() => console.log('R33 flood done'), 1100); // the budget refills: a line right after a flood is dropped`);
        const ticks = await countTicks();
        await sandbox.waitForLog('R33 flood done', 10000);
        console.log(`MEASURED ${browserName} host ticks (10 ms interval) in 2.5 s: idle ${idle}, during a log flood ${ticks}`);
        expect(ticks).toBeGreaterThan(idle * 0.8); // at 5ede7ba: Firefox 47 of 242, WebKit never finished; now within a few ticks of idle on all three
    });
});

test.describe('R2-2 (cooperative-mode limit, measured): a script-synthesized modifier click opens a new top-level window', () => {
    // The guest's own script dispatches a click with a modifier on its link or on its form's submit button: Chromium
    // opens a new tab at the guest's URL (no user gesture needed while its popup blocker is off, as in Playwright), and
    // for the form it skips form-action 'none', so the form's fields reach the listener; Firefox opens the link only
    // within a user's transient activation (after any click in the guest), never the form; Playwright's WebKit opens
    // none (it opens no tab for a user's own Ctrl+click either: verification.spec.ts, V3's control, a measurement
    // limit). No capability is involved: neither allow-popups nor (for the link) allow-forms. Strict mode has no guest
    // script in its view, so nothing can synthesize a click there; the view also ignores synthetic events (ADR-005).
    const LINK = (origin: string) => `<a id="l" href="${origin}/r22-link">l</a><div id="g" style="width:300px;height:100px;background:#ccc">g</div>`;
    const FORM = (origin: string) => `<form action="${origin}/r22-form" method="get"><input name="q" value="secret"><button id="b">b</button></form><div id="g" style="width:300px;height:100px;background:#ccc">g</div>`;
    const modifierClick = (id: string) => `document.getElementById('${id}').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true }))`;

    async function measure(sandbox: SandboxDriver, html: string, capabilities: string[], script: string, gesture: boolean) {
        expect(await sandbox.mount({ mode: 'cooperative', capabilities: capabilities as any, html })).toBe('ready');
        const page = sandbox.page;
        let opened = 0;
        page.context().on('page', () => { opened++; });
        if (gesture) {
            const box = (await page.locator('web-sandbox').boundingBox())!;
            await page.mouse.click(box.x + 100, box.y + 60); // the user clicks the guest's plain <div>
        }
        recorder.clear();
        await sandbox.run(script);
        await page.waitForTimeout(2000);
        return { opened, heard: recorder.paths('blocked').filter(path => path.startsWith('/r22-')) };
    }

    for (const gesture of [false, true]) {
        test(`a link, ${gesture ? 'after a user click' : 'with no user gesture'}: ${gesture ? 'Chromium and Firefox open it' : 'Chromium opens it'}`, async ({ sandbox, browserName }) => {
            const opens = browserName === 'chromium' || (gesture && browserName === 'firefox');
            expect(await measure(sandbox, LINK(recorder.blocked), ['allow-scripts'], modifierClick('l'), gesture)).toEqual(opens ? { opened: 1, heard: ['/r22-link'] } : { opened: 0, heard: [] });
        });

        test(`a form submit with allow-forms, ${gesture ? 'after a user click' : 'with no user gesture'}: Chromium submits it in a new tab past form-action 'none'`, async ({ sandbox, browserName }) => {
            const opens = browserName === 'chromium';
            expect(await measure(sandbox, FORM(recorder.blocked), ['allow-scripts', 'allow-forms'], modifierClick('b'), gesture)).toEqual(opens ? { opened: 1, heard: ['/r22-form?q=secret'] } : { opened: 0, heard: [] });
        });
    }

    test("control: the same form submitted without a modifier is refused by form-action 'none' on every engine", async ({ sandbox }) => {
        expect(await measure(sandbox, FORM(recorder.blocked), ['allow-scripts', 'allow-forms'], `document.getElementById('b').click()`, false)).toEqual({ opened: 0, heard: [] });
    });
});

export type { SandboxDriver };
