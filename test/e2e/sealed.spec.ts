import { test, expect, startAs, ORIGIN } from './fixture';
import { pageDocumentUrl } from './library';
import { servedFilePolicy } from './served-file';
import type { Page } from '@playwright/test';
import type { SandboxConfig } from '@src/host';
import { CROSSING_TEXTS } from '@src/lib/minted-errors';
import { useRecorder } from './recorder';
import { inFrames, inView, waitInView } from './strict-view';
import { reasonText } from '@src/lib/reasons';

/**
 * Sealed mode (docs/research/24_sealed_mode, ADR-008), the default: strict mode's view and worker with no network. A smoke test on every engine: a sealed sandbox renders and runs an app from its files, as an embedder
 * starts it (start() itself, no baseline and no scriptUnsafe); a guest request is refused and reported and the
 * listener sees nothing, while the same request from strict mode with the listener in `origins` reaches it (positive
 * control); and a sealed config that names `origins` or `fetchBridge`, with the mode written or left out, is refused
 * with its reason: start() throws it, and the element it was given to is never inserted. Evidence from outside the library
 * (strict-view.ts): the frames, the served file's URL and policy, and the view's body.
 */

const recorder = useRecorder();

/** The sources of a policy that name the network: a scheme, a host, `*`, `'self'` or `data:` (a hash admits a text). */
const networkSourcesOf = (policy: string) => policy.split(';').flatMap(part => part.trim().split(/\s+/).slice(1)).filter(source => /^(https?:|wss?:|data:|\*|'self')|\./.test(source) && !source.startsWith("'sha256-"));

const REASON = "origins and fetchBridge open the network, which sealed mode (the default) does not have: set `mode: 'strict'`";

const NETWORK_MODES_OFF = reasonText('networkModesOff');
/** Starts `config` exactly as given (no baseline) on a fresh element: 'ready', 'terminated', or start()'s `{ refused }`. */
const apply = (page: Page, config: SandboxConfig) => startAs(page, config);
/** start()'s refusal of `reason`, as its message carries it. */
const refusedWith = (reason: string) => ({ refused: `[Sandbox] start(): ${reason}.` });
/** The page's elements: their number, and the state, frames and markup of the first. */
const elements = (page: Page) => page.evaluate(() => {
    const all = [...document.querySelectorAll('web-sandbox')] as any[];
    return [all.length, all[0].state, all[0].shadowRoot.querySelectorAll('iframe').length, all[0]._config.html];
});

const APP = `
sandboxView.render('<h1 id="hello">Hello</h1><p id="count">0</p>', 'root');
let count = 0;
bridge.expose('add', (n) => { count += n; sandboxView.text('count', String(count)); return count; });
`;

test.describe('sealed mode', () => {
    test('renders and runs: an entry from the files draws the view and answers a call; the view holds only the hashed bootstrap under a policy with no network source', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.registerFiles({ 'main.js': APP, 'style.css': 'h1 { color: rgb(1, 2, 3); }' })).toBe('ok');
        expect(await apply(page, { mode: 'sealed', entry: 'main.js', html: '<link rel="stylesheet" href="style.css"><div id="root"></div>' })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('hello')`, 8000);
        expect(await sandbox.call('add', 2)).toBe(2);
        expect(await sandbox.call('add', 3)).toBe(5);
        await waitInView(page, browserName, `document.getElementById('count').textContent === '5'`);
        expect((await inFrames(page, browserName, '1')).map(f => f.path)).toEqual(['main', 'main/wrapper', 'main/wrapper/view']);
        // the view's frame is the served file (design 03): its policy is the file's one <meta>, which the view inherits
        const file = (await inFrames<{ url: string; policy: string }>(page, browserName, `({ url: location.href, policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content })`, path => path === 'main/wrapper')).find(f => f.path === 'main/wrapper')!.value;
        expect(file).toEqual({ url: `${ORIGIN}${pageDocumentUrl('default')}`, policy: servedFilePolicy() });
        expect(networkSourcesOf(servedFilePolicy())).toEqual([]);
        const view = await inView<{ scripts: number; policies: number; color: string }>(page, browserName, `({
            scripts: document.scripts.length,
            policies: document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length,
            color: getComputedStyle(document.getElementById('hello')).color,
        })`);
        expect(view).toEqual({
            scripts: 1,
            policies: 0, // one policy, the file's
            color: 'rgb(1, 2, 3)', // the registered stylesheet, through its blob: URL
        });
        expect(await sandbox.state()).toBe('ready');
    });

    test.describe('the default build has no other mode', () => {
        test('a sealed config that names a network option is refused with the reason that names the build flag, and a sealed config without it builds again', async ({ sandbox, page }) => {
            for (const network of [{ origins: { images: ['https://cdn.example'] } }, { fetchBridge: { allow: ['https://api.example'] } }, { origins: {} }]) {
                for (const mode of [{}, { mode: 'sealed' }]) {
                    expect(await apply(page, { ...mode, html: '<p>x</p>', ...network } as SandboxConfig), JSON.stringify({ ...mode, ...network })).toEqual(refusedWith(NETWORK_MODES_OFF));
                    // nothing of it was stored: the page's one element, the harness's, still has no app
                    expect(await page.evaluate(() => [document.querySelectorAll('web-sandbox').length, (document.querySelector('web-sandbox') as any).started])).toEqual([1, false]);
                }
            }
            expect(await sandbox.terminations()).toEqual([]);
            expect(await apply(page, { html: '<p>x</p>' })).toBe('ready');
        });

        test.describe('a config of a network mode', () => {
            test.use({ otherBuildConfigs: true }); // the subject: what the default build does with a config it does not have the mode of

            test('is refused whole with the same reason, in strict, cooperative and worker mode; nothing of it is applied and no frame is built', async ({ sandbox, page }) => {
                expect(await apply(page, { html: '<p id="kept">kept</p>' })).toBe('ready');
                for (const config of [{ mode: 'strict', html: '<p>x</p>' }, { mode: 'cooperative', capabilities: ['allow-scripts'], html: '<script>top.postMessage("ran", "*")</script>' }, { mode: 'worker' }]) {
                    expect(await apply(page, config as unknown as SandboxConfig), config.mode).toEqual(refusedWith(NETWORK_MODES_OFF));
                    // the refused element was never inserted, and the running one is as it was
                    expect(await elements(page), config.mode).toEqual([1, 'ready', 1, '<p id="kept">kept</p>']);
                }
                expect(await sandbox.terminations()).toEqual([]);
                // the refusal leaves its element without an app, and a sealed app then starts on it
                expect(await page.evaluate(() => {
                    const element = document.createElement('web-sandbox') as any;
                    let refused = '';
                    try { element.start({ html: '<p>x</p>' }, { mode: 'cooperative' }); } catch (error) { refused = String((error as Error).message); }
                    const after = element.started;
                    element.start({ html: '<p id="again">again</p>' });
                    return [refused.length > 0, after, element.started];
                })).toEqual([true, false, true]);
                expect(await apply(page, { html: '<p id="again">again</p>' })).toBe('ready');
            });
        });
    });

    test.describe('beside strict mode, in the build with the network modes', () => {
    // these tests give that build sealed configs on purpose: its own sealed mode, and its refusals of a network option
    test.use({ build: 'network', otherBuildConfigs: true });

    test('no network: a sealed guest has no fetch (feature-detected, nothing to refuse or report), sandboxFetch() is FETCH_NOT_ALLOWED from the guest itself (nothing reaches the host), a raw bridge.call of sandbox:fetch reaches the host and is refused, and the listener sees nothing; strict mode with the listener in origins reaches it, and its sandboxFetch() asks the host (positive control)', async ({ sandbox, page }) => {
        const probe = (path: string) => `
            const fetched = typeof fetch === 'undefined' ? 'absent' : await fetch('${recorder.allowed}${path}').then(() => 'sent', (e) => e.name);
            const bridged = await sandboxFetch('${recorder.allowed}${path}-bridge').then(() => 'sent', (e) => e.code);
            return { fetched, bridged };
        `;
        // every sandbox:fetch request that reaches an element, counted where it arrives (the reserved method's handler, of
        // every element: each app below is a fresh one)
        await page.evaluate(() => {
            const prototype = customElements.get('web-sandbox')!.prototype as any;
            const handle = prototype._handleFetch;
            (window as any).hostFetches = 0;
            prototype._handleFetch = function (...args: unknown[]) {
                (window as any).hostFetches++;
                return handle.apply(this, args);
            };
        });
        const hostFetches = () => page.evaluate(() => (window as any).hostFetches as number);
        // the guest's code is its entry: sealed mode has no execute() (it refuses scriptUnsafe)
        expect(await sandbox.inEntry({ mode: 'sealed' }, probe('/sealed'))).toEqual({ fetched: 'absent', bridged: 'FETCH_NOT_ALLOWED' });
        expect(await sandbox.violations(), 'no gate, so no report: nothing was attempted that a policy refused').toEqual([]);
        await sandbox.page.waitForTimeout(500);
        expect(recorder.paths('allowed')).toEqual([]);
        expect(await hostFetches()).toBe(0);
        // the guest can call the reserved method itself (BD5:TST-5): sandboxFetch() sends nothing, but bridge.call('sandbox:fetch') reaches
        // the host's handler, which has no bridge in a sealed build and refuses it, and the listener still sees nothing
        const raw = await sandbox.inEntry({ mode: 'sealed' }, `return await bridge.call('sandbox:fetch', { url: '${recorder.allowed}/sealed-raw', method: 'POST', body: 'x' }).then(() => 'sent', (e) => e.code);`);
        expect(raw).toBe('FETCH_NOT_ALLOWED');
        expect(await hostFetches()).toBe(1);
        await sandbox.page.waitForTimeout(500);
        expect(recorder.paths('allowed')).toEqual([]);

        expect(await sandbox.mount({ mode: 'strict', origins: { connect: [recorder.allowed] } })).toBe('ready');
        expect(await sandbox.inGuest(probe('/strict'))).toEqual({ fetched: 'sent', bridged: 'FETCH_NOT_ALLOWED' });
        await recorder.waitFor('allowed', '/strict');
        expect(await hostFetches()).toBe(2); // without fetchBridge the host refuses it (a new element: the count goes on from the raw call)
    });

    // BD6:TST-1: the reserved method is registered by every build. A sealed build that follows a strict one with a fetch bridge
    // answers `FETCH_NOT_ALLOWED` (the host's console says "the fetch bridge is off"; the guest receives the code's fixed
    // text, BD7:CHL-2); the previous build's handler, closed over its aborted bridge, would answer FETCH_FAILED, and that
    // bridge would be what a sealed guest's raw call reaches.
    test("a sealed build after a strict one with a fetch bridge refuses the guest's raw call of sandbox:fetch as off, and the listener sees nothing", async ({ sandbox, page }) => {
        const warnings: string[] = [];
        page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
        const raw = `return await bridge.call('sandbox:fetch', { url: '${recorder.allowed}/after-bridge', method: 'POST', body: 'x' }).then(() => 'sent', (e) => e.code + ': ' + e.message);`;
        expect(await sandbox.mount({ mode: 'strict', fetchBridge: { allow: [recorder.allowed] }, hostContentSecurityPolicy: false })).toBe('ready');
        expect(await sandbox.inGuest(raw)).toBe('sent'); // the bridge is on in the strict build (positive control)
        await recorder.waitFor('allowed', '/after-bridge');
        recorder.clear();
        // (sealed mode runs no execute(): the same call is the sealed guest's entry, on the next element)
        expect(await sandbox.inEntry({ mode: 'sealed' }, raw)).toBe(`FETCH_NOT_ALLOWED: FETCH_NOT_ALLOWED: ${CROSSING_TEXTS.FETCH_NOT_ALLOWED}`);
        expect(warnings.filter(text => text.startsWith('[Sandbox] "sandbox:fetch" failed') && text.includes('the fetch bridge is off'))).toHaveLength(1);
        await sandbox.page.waitForTimeout(500);
        expect(recorder.paths('allowed')).toEqual([]);
    });

    test('a sealed config with scriptUnsafe: true is refused with its reason, nothing of it is applied; strict mode keeps the option', async ({ sandbox, page }) => {
        void sandbox;
        for (const config of [{ scriptUnsafe: true }, { mode: 'sealed', scriptUnsafe: true, html: '<p>x</p>' }]) {
            expect(await apply(page, config as SandboxConfig), JSON.stringify(config)).toEqual(refusedWith("scriptUnsafe runs strings as code, which sealed mode (the default) does not: set `mode: 'strict'`, in a build with the network modes (WEB_SANDBOX_NETWORK_MODES=1)"));
        }
        expect(await apply(page, { mode: 'strict', scriptUnsafe: true, html: '<p>x</p>', hostContentSecurityPolicy: false })).toBe('ready');
    });

    test('a sealed config that names origins is refused: start() throws the reason, and a sealed config without it builds', async ({ sandbox, page }) => {
        void sandbox;
        expect(await apply(page, { mode: 'sealed', origins: { images: [recorder.allowed] } } as unknown as SandboxConfig)).toEqual(refusedWith(REASON));
        expect(await apply(page, { mode: 'sealed', html: '<p>ok</p>' })).toBe('ready');
    });

    test("a config with no mode that names origins or fetchBridge is refused the same way (sealed is the default); the fix the reason names, mode: 'strict', builds", async ({ sandbox, page }) => {
        void sandbox;
        for (const network of [{ origins: { images: [recorder.allowed] } }, { fetchBridge: { allow: [recorder.allowed] } }]) {
            expect(await apply(page, { html: '<p>x</p>', ...network } as unknown as SandboxConfig), JSON.stringify(network)).toEqual(refusedWith(REASON));
            // the refused element was never inserted: the page still has the one element it had
            expect(await page.evaluate(() => document.querySelectorAll('web-sandbox').length)).toBe(1);
            expect(await apply(page, { mode: 'strict', html: '<p>x</p>', hostContentSecurityPolicy: false, ...network } as SandboxConfig), JSON.stringify(network)).toBe('ready');
        }
    });
    });
});
