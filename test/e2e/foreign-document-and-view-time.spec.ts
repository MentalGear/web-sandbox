import { test, expect, type MountConfig } from './fixture';
import { busyShare, describeShare, viewBound } from './host-share';

/**
 * Findings of R2 where the browser decides, on Chromium, Firefox and WebKit. The host page's own policy
 * (R2:C-5, R2:C-6) is in host-policy.spec.ts, the package's hash (R2:C-8) in package.spec.ts.
 */

const MODES: Record<string, MountConfig> = {
    cooperative: { mode: 'cooperative' },
    worker: { mode: 'worker' },
    strict: { mode: 'strict', scriptUnsafe: true },
    sealed: { mode: 'sealed', scriptUnsafe: true },
};

// RPC_MAX_BYTES is 33 MiB: 18 million UTF-16 code units are past it.
const PAST_BUDGET = 18_000_000;
// (A RegExp is measured by its source too, unit-tested: WebKit refuses a pattern this long before it is ever returned.)

test.describe("Review round 2, L-1 and L-5: in another window's document", () => {
    test('the element keeps its methods (Firefox too), builds nothing whatever starts a build, and refuses calls at once', async ({ sandbox, page }) => {
        expect(await sandbox.mount({ mode: 'cooperative' })).toBe('ready');
        const result = await page.evaluate(async () => {
            const el = document.querySelector('web-sandbox') as any;
            const frame = document.createElement('iframe');
            document.body.appendChild(frame);
            await new Promise(resolve => setTimeout(resolve, 50));
            const events: string[] = [];
            el.addEventListener('ready', () => events.push('ready'));
            el.addEventListener('terminated', () => events.push('terminated'));
            let filesChanged = 0;
            el.addEventListener('fileschanged', () => filesChanged++);
            frame.contentDocument!.body.appendChild(el);
            const methods = ['reset', 'load', 'setConfig', 'call', 'registerFiles'].every(name => typeof el[name] === 'function');
            const states = [el.state];
            el.reset();
            states.push(el.state);
            el.load('<p>x</p><script>parent.parent.postMessage("GUEST RAN", "*")</script>');
            states.push(el.state);
            el.setConfig({ mode: 'cooperative', origins: 5 });
            states.push(el.state);
            el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] }); // usable again: still nothing built here
            states.push(el.state);
            el.registerFiles({ 'a.txt': 'a' });
            const code = await el.call('anything').then(() => 'resolved', (error: any) => error.code);
            await new Promise(resolve => setTimeout(resolve, 300));
            const frames = el.shadowRoot.querySelectorAll('iframe').length;
            document.body.appendChild(el); // positive control: back in its own document, it builds
            return { methods, states, code, events, frames, filesChanged, back: el.state };
        });
        expect(result).toEqual({ methods: true, states: ['idle', 'idle', 'idle', 'idle', 'idle'], code: 'TERMINATED', events: [], frames: 0, filesChanged: 1, back: 'loading' });
    });
});

test.describe('C-3: what a call answers is measured as it is posted, by an allow-list', () => {
    for (const [mode, config] of Object.entries(MODES)) {
        test(`${mode} mode: a guest method answering a large Error or ImageData is refused RESULT_NOT_TRANSFERABLE (each measured ~16 bytes before); a small answer resolves`, async ({ sandbox }) => {
            expect(await sandbox.mount(config)).toBe('ready');
            await sandbox.exposeGuest('bigError', `() => new Error('x'.repeat(${PAST_BUDGET}))`);
            await sandbox.exposeGuest('bigImage', `() => new ImageData(3000, 3000)`); // 36 MB of pixels
            await sandbox.exposeGuest('twoFaced', `() => { let reads = 0; return { get x() { return ++reads === 1 ? 'small' : 'x'.repeat(${PAST_BUDGET}); } }; }`);
            await sandbox.exposeGuest('small', `() => ({ list: [1, 'two', 3n], when: new Date(0), re: /a/g })`);
            const outcomes = await sandbox.page.evaluate(async (names) => {
                const el = document.querySelector('web-sandbox') as any;
                const results: Record<string, unknown> = {};
                for (const name of names) {
                    results[name] = await el.callWithTimeout(20000, name).then(
                        (value: any) => (name === 'twoFaced' ? `resolved ${String(value?.x).length}` : name === 'small' ? `resolved ${value.list.length} ${value.re.source}` : 'resolved'),
                        (error: any) => error.code,
                    );
                }
                return results;
            }, ['bigError', 'bigImage', 'twoFaced', 'small']);
            expect(outcomes).toEqual({
                bigError: 'RESULT_NOT_TRANSFERABLE',
                bigImage: 'RESULT_NOT_TRANSFERABLE',
                twoFaced: 'resolved 5', // the snapshot measured is the one posted: the getter is read once
                small: 'resolved 3 a',
            });
        });
    }
});

// R2:M-3: what the view's operations cost the host page's thread, which the view shares in WebKit and Firefox
// (and in Chromium depending on its process model), measured from the host page as its busy share against its own idle
// baseline (./host-share.ts), and bounded by the view's time budget as the suite asserts it (docs/API.md, "The view's
// cost to the host page", (a): 20%, plus the measure's 10 points). Each flood stays within every budget the view counts
// in characters.

const VIEW_FLOODS: [string, string][] = [
    ['re-rendering 37 449 empty elements without pause', `
        sandboxView.render('<div id="a"></div>');
        globalThis.flood = () => {
            const html = '<i></i>'.repeat(37449); // 262 143 characters: within VIEW_RENDER_MAX_LENGTH and VIEW_MAX_ELEMENTS
            const end = Date.now() + 11000;
            const timer = setInterval(() => {
                sandboxView.render(html, 'a');
                if (Date.now() > end) { clearInterval(timer); console.log('M3 flood done'); }
            }, 5);
        };`],
    ['set() of a 250 000-character textarea value 4 times a second', `
        sandboxView.render('<textarea id="t" rows="40" cols="120"></textarea>');
        globalThis.flood = () => {
            const end = Date.now() + 11000;
            let n = 0;
            const timer = setInterval(() => {
                sandboxView.set('t', { value: 'x'.repeat(250000) + (n++) });
                if (Date.now() > end) { clearInterval(timer); console.log('M3 flood done'); }
            }, 250);
        };`],
];

test.describe("M-3: the view's work is budgeted by the time it takes, not only by its characters", () => {
    for (const [name, entry] of VIEW_FLOODS) {
        test(`${name}: the host page keeps all but the view's share of its ticks`, async ({ sandbox, page, browserName }) => {
            test.setTimeout(90000);
            await sandbox.registerFiles({ 'main.js': entry });
            expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', scriptUnsafe: true })).toBe('ready');
            await page.evaluate(() => document.querySelector('web-sandbox')!.addEventListener('terminated', (e: any) => { (window as any).__lastTerminated = e.detail.reason; }));
            await page.waitForTimeout(300);
            // sustained, not the first operation: one operation's own cost (one textarea's paint, 1.3–1.7 s in WebKit) is
            // not something a rate can bound; what follows it is (a warm-up of 2 s)
            const share = await busyShare(page, () => sandbox.run('flood()'), undefined, 2000);
            // The second operation past VIEW_MAX_OPERATION_MS within VIEW_OVERRUN_WINDOW_MS ends the sandbox (R5:M-2,
            // S72): in WebKit the first set() of the textarea, its value and its first paint, takes longer
            // than 2 s, an overrun the sandbox survives; a later set() past it ends the sandbox with that reason. The
            // host page keeps its ticks either way.
            await expect.poll(async () => (await sandbox.logs()).includes('M3 flood done') || (await sandbox.state()) === 'terminated', { timeout: 30000 }).toBe(true);
            const state = await sandbox.state();
            console.log(`MEASURED ${browserName} M-3 ${name}: ${describeShare(share)}; the sandbox ${state}`);
            if (state === 'terminated') expect(await page.evaluate(() => (window as any).__lastTerminated)).toBe('the view spent more than 2000 ms on one operation twice within 5 minutes');
            expect(share.busy).toBeLessThanOrEqual(viewBound(false));
        });
    }
});
