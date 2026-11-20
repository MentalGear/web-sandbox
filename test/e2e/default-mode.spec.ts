import { test, expect, ORIGIN, startAs, type CallOutcome } from './fixture';
import type { Page } from '@playwright/test';
import type { SandboxConfig } from '@src/host';
import { inFrames, inView, viewPolicy, waitInView } from './strict-view';
import { servedFilePolicy } from './served-file';

// The build with the network modes (ADR-009), and the default mode beside the named ones: these tests give the build with the network modes sealed configs too.
test.use({ build: 'network', otherBuildConfigs: true });

/**
 * Sealed mode is the default (ADR-008; T8 of docs/research/24_sealed_mode); strict mode is named. These specs apply
 * configs as an embedder writes them, through start() itself on a fresh element, never over BASELINE_CONFIG (which names cooperative
 * mode, the mode the other specs were written for). Each property of the default is held for strict mode too, named.
 * Evidence from outside the library (strict-view.ts): which frames exist, which scripts each document holds and what ran
 * in it, the view's policy; the warning as the host page's console shows it. Positive control: the same html in
 * cooperative mode runs, read the same way, and raises no such warning.
 */

/** A script-run marker: pushes `name` onto globalThis.__ran of the document it runs in. */
const M = (name: string) => `(globalThis.__ran=globalThis.__ran||[]).push('${name}')`;

/** The two modes of strict mode's view, as an embedder names them: the default (no mode) and strict. */
const VIEW_CONFIGS = [
    { name: 'the default (sealed)', config: {}, warning: "[Sandbox] sealed mode (the default) runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`." },
    { name: 'strict, named', config: { mode: 'strict' }, warning: "[Sandbox] strict mode runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`." },
] as const;

/** Starts `config` exactly as given (no baseline) on a fresh element and resolves with 'ready' or 'terminated'. */
const apply = (page: Page, config: SandboxConfig) => page.evaluate((c) => startFresh(c), config as any);
const reset = (page: Page) => page.evaluate(() => whenSettled(s => s.reset()));

/** Every script-run marker on the page, as "path:marker", read from outside. */
async function markers(page: Page, browserName: string): Promise<string[]> {
    const states = await inFrames<string[]>(page, browserName, '(globalThis.__ran || [])');
    return states.flatMap(s => (s.value === 'no-context' ? [] : s.value.map(m => `${s.path}:${m}`)));
}

/** The warnings of the host page's console that are the view's html warning, as they arrive. */
function scriptWarnings(page: Page): string[] {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning' && m.text().includes('runs no script in `html`')) warnings.push(m.text()); });
    return warnings;
}

/** What the view document holds: where its scripts are, its body, how often its bootstrap ran. */
const VIEW_STATE = `({
    scripts: Array.from(document.scripts).map(s => s.parentNode.localName),
    body: document.body.innerHTML,
    runs: globalThis.__sandboxViewRuns,
})`;
// a policy that admits scripts by hash alone: strict mode's view (its bootstrap), sealed mode's file (its guard and the view)
const HASH_ONLY = /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]{43}='(?: 'sha256-[A-Za-z0-9+/]{43}=')?; script-src-attr 'none';/;
/** The view's policy's connect-src (viewPolicy: the srcdoc view's own, or the served file's). */
const connectSrc = async (page: Page, browserName: string) => (await viewPolicy(page, browserName)).split('; ').find(d => d.startsWith('connect-src'));

test.describe('sealed is the default mode; strict is named', () => {
    test("an app started with no option is sealed: a view whose one script is the hashed bootstrap, and whose connect-src stays 'none' with a JSON file in the app; strict mode's has blob: (positive control)", async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness; this case starts its own elements
        const app = { files: { 'data.json': '{}' } };
        expect(await page.evaluate((a) => startFresh({}, a), app)).toBe('ready');
        expect((await inFrames(page, browserName, '1')).map(f => f.path)).toEqual(['main', 'main/wrapper', 'main/wrapper/view']);
        const view = await inView<any>(page, browserName, VIEW_STATE);
        expect(view.scripts).toEqual(['head']);
        // the default's view is the served file's: its policy is the file's constant one
        expect(await viewPolicy(page, browserName)).toBe(servedFilePolicy());
        expect(view.body).toBe('<div id="root"></div>');
        // the default's policy, told apart from strict mode's: a JSON file of the app adds blob: to connect-src in strict
        // mode only (sealed mode reads files with sandboxFiles.read(), which makes no request)
        await expect.poll(() => connectSrc(page, browserName)).toBe("connect-src 'none'");
        expect(await page.evaluate((a) => startFresh({ mode: 'strict' }, a), app)).toBe('ready');
        await expect.poll(() => connectSrc(page, browserName)).toBe('connect-src blob:');
        expect(await page.evaluate((a) => startFresh({}, a), app)).toBe('ready');
        await expect.poll(() => connectSrc(page, browserName)).toBe("connect-src 'none'");
    });

    for (const { name, config, warning } of VIEW_CONFIGS) {
        test(`${name}: a mount with only html renders the cleaned html; the view runs only its bootstrap, once; the worker exposes nothing`, async ({ sandbox, page, browserName }) => {
            void sandbox; // the fixture opens the harness; this case applies its config directly
            expect(await apply(page, { ...config, html: '<h1 id="hello" onclick="x()">Hello</h1><p>world</p>' } as SandboxConfig)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('hello')`);
            const view = await inView<any>(page, browserName, VIEW_STATE);
            expect(view).toEqual({ scripts: ['head'], body: '<h1 id="hello">Hello</h1><p>world</p>', runs: 1 });
            expect(await viewPolicy(page, browserName)).toMatch(HASH_ONLY);
            expect((await inFrames(page, browserName, '1')).map(f => f.path)).toEqual(['main', 'main/wrapper', 'main/wrapper/view']);
            // the worker is there and idle: it answers, and has no method of the guest's (no entry ran)
            const outcome = await page.evaluate(() => settleOutcome((document.querySelector('web-sandbox') as any).callWithTimeout(4000, 'anything')));
            expect((outcome as CallOutcome & { code?: unknown }).code).toBe('UNKNOWN_METHOD');
        });

        test(`${name}: a <script> in html runs in no document, and warns once per element, across its start() and reset(); in cooperative mode the same html runs and does not warn (positive control)`, async ({ sandbox, page, browserName }) => {
            void sandbox;
            const warnings = scriptWarnings(page);
            const html = `<script>${M('inline')}</script><svg><script>${M('svg')}</script></svg><p id="p">p</p>`;
            expect(await apply(page, { ...config, html } as SandboxConfig)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('p')`);
            expect(await reset(page)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('p')`);
            await page.waitForTimeout(500);
            expect(await markers(page, browserName)).toEqual([]);
            expect(warnings).toEqual([warning]);
            // the same app on a second element: it warns once of its own
            expect(await apply(page, { ...config, html } as SandboxConfig)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('p')`);
            await page.waitForTimeout(500);
            expect(await markers(page, browserName)).toEqual([]);
            expect(await inView(page, browserName, `document.scripts.length`)).toBe(1);
            expect(warnings).toEqual([warning, warning]);

            expect(await apply(page, { mode: 'cooperative', capabilities: ['allow-scripts'], html })).toBe('ready');
            await expect.poll(() => markers(page, browserName)).toEqual(['main/wrapper/view:inline', 'main/wrapper/view:svg']);
            expect(warnings).toEqual([warning, warning]);
        });

        test(`${name}: an on* handler in html runs in no document, and warns once per element; in cooperative mode the same html runs (positive control)`, async ({ sandbox, page, browserName }) => {
            void sandbox;
            const warnings = scriptWarnings(page);
            const html = `<details id="d" open ontoggle="${M('ontoggle')}"><summary>s</summary>details</details>`;
            expect(await apply(page, { ...config, html } as SandboxConfig)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('d')`);
            await page.waitForTimeout(500);
            expect(await markers(page, browserName)).toEqual([]);
            expect(warnings).toEqual([warning]);
            // the handler in capitals, on a second element: it runs nowhere either, and that element warns once of its own
            expect(await apply(page, { ...config, html: html.replace('ontoggle', 'ONTOGGLE') } as SandboxConfig)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('d')`);
            await page.waitForTimeout(500);
            expect(await markers(page, browserName)).toEqual([]);
            expect(await inView(page, browserName, `document.getElementById('d').getAttributeNames()`)).toEqual(['id', 'open']);
            expect(warnings).toEqual([warning, warning]);

            expect(await apply(page, { mode: 'cooperative', capabilities: ['allow-scripts'], html })).toBe('ready');
            await expect.poll(() => markers(page, browserName)).toEqual(['main/wrapper/view:ontoggle']);
            expect(warnings).toEqual([warning, warning]);
        });
    }

    test("mode 'iframe' starts nothing: start() throws the reason naming its new name", async ({ sandbox, page }) => {
        void sandbox;
        expect(await startAs(page, { mode: 'iframe', capabilities: ['allow-scripts'] })).toEqual({ refused: `[Sandbox] start(): unknown mode: not strict, sealed, cooperative or worker ('iframe' was renamed 'cooperative').` });
        // the refused element was never inserted: the page's one element is the harness's
        expect(await page.evaluate(() => [document.querySelectorAll('web-sandbox').length, (document.querySelector('web-sandbox') as any).started])).toEqual([1, false]);
        expect(await sandbox.terminations()).toEqual([]);
    });
});

test('the playground opens on its sealed demo preset: both sandboxes are sealed views, the entry renders, no guest script in any document', async ({ page, browserName }) => {
    await page.goto(`${ORIGIN}/playground/index.html`);
    await page.waitForFunction(() => (window as any).SandboxControl?.sandboxElement?.state === 'ready');
    expect(await page.locator('#presetSelect').inputValue()).toBe('sealed-demo');
    expect(JSON.parse(await page.locator('#rulesEditor').inputValue()).mode).toBe('sealed');
    // each sandbox's view: one script (the bootstrap), no policy of its own, and the entry's rendered button; its frame is the
    // served file, under the file's hash-only policy
    const VIEW = `[document.scripts.length, document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length, !!document.getElementById('add')]`;
    const views = async () => (await inFrames(page, browserName, VIEW, path => path === 'main/wrapper/view')).filter(f => f.path === 'main/wrapper/view').map(f => f.value);
    await expect.poll(views, { timeout: 8000 }).toEqual([[1, 0, true], [1, 0, true]]);
    const FILE = `[location.pathname, document.querySelector('meta[http-equiv="Content-Security-Policy"]').content]`;
    const files = (await inFrames<[string, string]>(page, browserName, FILE, path => path === 'main/wrapper')).filter(f => f.path === 'main/wrapper').map(f => f.value);
    expect(files).toEqual([['/dist/sealed-document.html', servedFilePolicy()], ['/dist/sealed-document.html', servedFilePolicy()]]);
    expect(await markers(page, browserName)).toEqual([]);
});
