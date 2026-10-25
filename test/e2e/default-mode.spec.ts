import { test, expect, ORIGIN, type CallOutcome } from './fixture';
import type { Page } from '@playwright/test';
import type { SandboxConfig } from '@src/host';
import { inFrames, inView, waitInView } from './strict-view';

/**
 * Sealed mode is the default (ADR-008; T8 of docs/research/24_sealed_mode); strict mode is named. These specs apply
 * configs as an embedder writes them, through setConfig() itself, never over BASELINE_CONFIG (which names cooperative
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

/** Applies `config` exactly as given (no baseline) and resolves with 'ready' or 'terminated'. */
const apply = (page: Page, config: SandboxConfig) => page.evaluate((c) => whenSettled(s => s.setConfig(c)), config as any);
const reset = (page: Page) => page.evaluate(() => whenSettled(s => s.reset()));
const load = (page: Page, html: string) => page.evaluate((markup) => whenSettled(s => s.load(markup)), html);

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

/** What the view document holds: where its scripts are, its policy, its body, how often its bootstrap ran. */
const VIEW_STATE = `({
    scripts: Array.from(document.scripts).map(s => s.parentNode.localName),
    policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    body: document.body.innerHTML,
    runs: globalThis.__sandboxViewRuns,
})`;
const HASH_ONLY = /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]{43}='; script-src-attr 'none';/;
const CONNECT_SRC = `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.split('; ').find(d => d.startsWith('connect-src'))`;

test.describe('sealed is the default mode; strict is named', () => {
    test("the harness element, inserted and never configured, is sealed: a view whose one script is the hashed bootstrap, and whose connect-src stays 'none' with a JSON file registered; strict mode's has blob: (positive control)", async ({ sandbox, page, browserName }) => {
        await page.waitForFunction(() => (document.querySelector('web-sandbox') as any).state === 'ready');
        expect(await sandbox.state()).toBe('ready');
        expect((await inFrames(page, browserName, '1')).map(f => f.path)).toEqual(['main', 'main/wrapper', 'main/wrapper/view']);
        const view = await inView<any>(page, browserName, VIEW_STATE);
        expect(view.scripts).toEqual(['head']);
        expect(view.policy).toMatch(HASH_ONLY);
        expect(view.body).toBe('<div id="root"></div>');
        // the default's policy, told apart from strict mode's: a registered JSON file adds blob: to connect-src in strict
        // mode only (sealed mode reads files with sandboxFiles.read(), which makes no request)
        expect(await sandbox.registerFiles({ 'data.json': '{}' })).toBe('ok');
        expect(await reset(page)).toBe('ready');
        await expect.poll(() => inView(page, browserName, CONNECT_SRC)).toBe("connect-src 'none'");
        expect(await apply(page, { mode: 'strict' })).toBe('ready');
        await expect.poll(() => inView(page, browserName, CONNECT_SRC)).toBe('connect-src blob:');
        expect(await apply(page, {})).toBe('ready');
        await expect.poll(() => inView(page, browserName, CONNECT_SRC)).toBe("connect-src 'none'");
    });

    for (const { name, config, warning } of VIEW_CONFIGS) {
        test(`${name}: a mount with only html renders the cleaned html; the view runs only its bootstrap, once; the worker exposes nothing`, async ({ sandbox, page, browserName }) => {
            void sandbox; // the fixture opens the harness; this case applies its config directly
            expect(await apply(page, { ...config, html: '<h1 id="hello" onclick="x()">Hello</h1><p>world</p>' } as SandboxConfig)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('hello')`);
            const view = await inView<any>(page, browserName, VIEW_STATE);
            expect(view).toEqual({ scripts: ['head'], policy: expect.stringMatching(HASH_ONLY), body: '<h1 id="hello">Hello</h1><p>world</p>', runs: 1 });
            expect((await inFrames(page, browserName, '1')).map(f => f.path)).toEqual(['main', 'main/wrapper', 'main/wrapper/view']);
            // the worker is there and idle: it answers, and has no method of the guest's (no entry ran)
            const outcome = await page.evaluate(() => settleOutcome((document.querySelector('web-sandbox') as any).callWithTimeout(4000, 'anything')));
            expect((outcome as CallOutcome & { code?: unknown }).code).toBe('UNKNOWN_METHOD');
        });

        test(`${name}: a <script> in html runs in no document, and warns once across setConfig(), reset() and load(); in cooperative mode the same html runs and does not warn (positive control)`, async ({ sandbox, page, browserName }) => {
            void sandbox;
            const warnings = scriptWarnings(page);
            const html = `<script>${M('inline')}</script><svg><script>${M('svg')}</script></svg><p id="p">p</p>`;
            expect(await apply(page, { ...config, html } as SandboxConfig)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('p')`);
            expect(await reset(page)).toBe('ready');
            expect(await load(page, html)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('p')`);
            await page.waitForTimeout(500);
            expect(await markers(page, browserName)).toEqual([]);
            expect(await inView(page, browserName, `document.scripts.length`)).toBe(1);
            expect(warnings).toEqual([warning]);

            expect(await apply(page, { mode: 'cooperative', capabilities: ['allow-scripts'], html })).toBe('ready');
            await expect.poll(() => markers(page, browserName)).toEqual(['main/wrapper/view:inline', 'main/wrapper/view:svg']);
            expect(warnings).toEqual([warning]);
        });

        test(`${name}: an on* handler in html runs in no document, and warns once; in cooperative mode the same html runs (positive control)`, async ({ sandbox, page, browserName }) => {
            void sandbox;
            const warnings = scriptWarnings(page);
            const html = `<details id="d" open ontoggle="${M('ontoggle')}"><summary>s</summary>details</details>`;
            expect(await apply(page, { ...config, html } as SandboxConfig)).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('d')`);
            expect(await load(page, html.replace('ontoggle', 'ONTOGGLE'))).toBe('ready');
            await waitInView(page, browserName, `!!document.getElementById('d')`);
            await page.waitForTimeout(500);
            expect(await markers(page, browserName)).toEqual([]);
            expect(await inView(page, browserName, `document.getElementById('d').getAttributeNames()`)).toEqual(['id', 'open']);
            expect(warnings).toEqual([warning]);

            expect(await apply(page, { mode: 'cooperative', capabilities: ['allow-scripts'], html })).toBe('ready');
            await expect.poll(() => markers(page, browserName)).toEqual(['main/wrapper/view:ontoggle']);
            expect(warnings).toEqual([warning]);
        });
    }

    test("mode 'iframe' starts nothing: terminated with the reason naming its new name", async ({ sandbox, page }) => {
        void sandbox;
        const reason = await page.evaluate(() => new Promise<string>(resolve => {
            const s = document.querySelector('web-sandbox') as any;
            s.addEventListener('terminated', (e: CustomEvent) => resolve(e.detail.reason), { once: true });
            s.setConfig({ mode: 'iframe', capabilities: ['allow-scripts'] });
        }));
        expect(reason).toBe(`unknown mode "iframe" ('iframe' was renamed 'cooperative')`);
        expect(await sandbox.state()).toBe('terminated');
        expect(await page.evaluate(() => (document.querySelector('web-sandbox') as any).shadowRoot.querySelectorAll('iframe').length)).toBe(0);
    });
});

test('the playground opens on its sealed demo preset: both sandboxes are sealed views, the entry renders, no guest script in any document', async ({ page, browserName }) => {
    await page.goto(`${ORIGIN}/playground/index.html`);
    await page.waitForFunction(() => (window as any).SandboxControl?.sandboxElement?.state === 'ready');
    expect(await page.locator('#presetSelect').inputValue()).toBe('sealed-demo');
    expect(JSON.parse(await page.locator('#rulesEditor').inputValue()).mode).toBe('sealed');
    // each sandbox's view: one script (the bootstrap) under a hash-only policy, and the entry's rendered button
    const VIEW = `[document.scripts.length, document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.split(';')[1].trim().slice(0, 19), !!document.getElementById('add')]`;
    const views = async () => (await inFrames(page, browserName, VIEW, path => path === 'main/wrapper/view')).filter(f => f.path === 'main/wrapper/view').map(f => f.value);
    await expect.poll(views, { timeout: 8000 }).toEqual([[1, "script-src 'sha256-", true], [1, "script-src 'sha256-", true]]);
    expect(await markers(page, browserName)).toEqual([]);
});
