import { test, expect, ORIGIN, type CallOutcome } from './fixture';
import type { Page } from '@playwright/test';
import type { SandboxConfig } from '@src/host';
import { inFrames, inView, waitInView } from './strict-view';

/**
 * Strict mode is the default (ADR-005 amendment "strict is the default"; backlog S48). These specs apply configs as an
 * embedder writes them, through setConfig() itself, never over BASELINE_CONFIG (which names cooperative mode, the mode
 * the other specs were written for). Evidence from outside the library (strict-view.ts): which frames exist, which
 * scripts each document holds and what ran in it; the warning as the host page's console shows it. Positive control:
 * the same html in cooperative mode runs, read the same way, and raises no such warning.
 */

/** A script-run marker: pushes `name` onto globalThis.__ran of the document it runs in. */
const M = (name: string) => `(globalThis.__ran=globalThis.__ran||[]).push('${name}')`;

const SCRIPT_WARNING = "[Sandbox] strict mode (the default) runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.";

/** Applies `config` exactly as given (no baseline) and resolves with 'ready' or 'terminated'. */
const apply = (page: Page, config: SandboxConfig) => page.evaluate((c) => whenSettled(s => s.setConfig(c)), config as any);
const reset = (page: Page) => page.evaluate(() => whenSettled(s => s.reset()));
const load = (page: Page, html: string) => page.evaluate((markup) => whenSettled(s => s.load(markup)), html);

/** Every script-run marker on the page, as "path:marker", read from outside. */
async function markers(page: Page, browserName: string): Promise<string[]> {
    const states = await inFrames<string[]>(page, browserName, '(globalThis.__ran || [])');
    return states.flatMap(s => (s.value === 'no-context' ? [] : s.value.map(m => `${s.path}:${m}`)));
}

/** The warnings of the host page's console that are the strict-html warning, as they arrive. */
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

test.describe('strict is the default mode', () => {
    test('the harness element, inserted and never configured, is strict: a view whose one script is the hashed bootstrap', async ({ sandbox, page, browserName }) => {
        await page.waitForFunction(() => (document.querySelector('web-sandbox') as any).state === 'ready');
        expect(await sandbox.state()).toBe('ready');
        expect((await inFrames(page, browserName, '1')).map(f => f.path)).toEqual(['main', 'main/wrapper', 'main/wrapper/view']);
        const view = await inView<any>(page, browserName, VIEW_STATE);
        expect(view.scripts).toEqual(['head']);
        expect(view.policy).toMatch(HASH_ONLY);
        expect(view.body).toBe('<div id="root"></div>');
    });

    test('a default-config mount with only html renders the cleaned html; the view runs only its bootstrap, once; the worker exposes nothing', async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness; this case applies its config directly
        expect(await apply(page, { html: '<h1 id="hello" onclick="x()">Hello</h1><p>world</p>' })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('hello')`);
        const view = await inView<any>(page, browserName, VIEW_STATE);
        expect(view).toEqual({ scripts: ['head'], policy: expect.stringMatching(HASH_ONLY), body: '<h1 id="hello">Hello</h1><p>world</p>', runs: 1 });
        expect((await inFrames(page, browserName, '1')).map(f => f.path)).toEqual(['main', 'main/wrapper', 'main/wrapper/view']);
        // the worker is there and idle: it answers, and has no method of the guest's (no entry ran)
        const outcome = await page.evaluate(() => settleOutcome((document.querySelector('web-sandbox') as any).callWithTimeout(4000, 'anything')));
        expect((outcome as CallOutcome & { code?: unknown }).code).toBe('UNKNOWN_METHOD');
    });

    test('a <script> in html runs in no document, and warns once across setConfig(), reset() and load(); in cooperative mode the same html runs and does not warn (positive control)', async ({ sandbox, page, browserName }) => {
        void sandbox;
        const warnings = scriptWarnings(page);
        const html = `<script>${M('inline')}</script><svg><script>${M('svg')}</script></svg><p id="p">p</p>`;
        expect(await apply(page, { html })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('p')`);
        expect(await reset(page)).toBe('ready');
        expect(await load(page, html)).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('p')`);
        await page.waitForTimeout(500);
        expect(await markers(page, browserName)).toEqual([]);
        expect(await inView(page, browserName, `document.scripts.length`)).toBe(1);
        expect(warnings).toEqual([SCRIPT_WARNING]);

        expect(await apply(page, { mode: 'cooperative', capabilities: ['allow-scripts'], html })).toBe('ready');
        await expect.poll(() => markers(page, browserName)).toEqual(['main/wrapper/view:inline', 'main/wrapper/view:svg']);
        expect(warnings).toEqual([SCRIPT_WARNING]);
    });

    test('an on* handler in html runs in no document, and warns once; in cooperative mode the same html runs (positive control)', async ({ sandbox, page, browserName }) => {
        void sandbox;
        const warnings = scriptWarnings(page);
        const html = `<details id="d" open ontoggle="${M('ontoggle')}"><summary>s</summary>details</details>`;
        expect(await apply(page, { html })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('d')`);
        expect(await load(page, html.replace('ontoggle', 'ONTOGGLE'))).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('d')`);
        await page.waitForTimeout(500);
        expect(await markers(page, browserName)).toEqual([]);
        expect(await inView(page, browserName, `document.getElementById('d').getAttributeNames()`)).toEqual(['id', 'open']);
        expect(warnings).toEqual([SCRIPT_WARNING]);

        expect(await apply(page, { mode: 'cooperative', capabilities: ['allow-scripts'], html })).toBe('ready');
        await expect.poll(() => markers(page, browserName)).toEqual(['main/wrapper/view:ontoggle']);
        expect(warnings).toEqual([SCRIPT_WARNING]);
    });

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

test('the playground opens on its strict demo preset: both sandboxes are strict views, the entry renders, no guest script in any document', async ({ page, browserName }) => {
    await page.goto(`${ORIGIN}/playground/index.html`);
    await page.waitForFunction(() => (window as any).SandboxControl?.sandboxElement?.state === 'ready');
    expect(await page.locator('#presetSelect').inputValue()).toBe('strict-demo');
    expect(JSON.parse(await page.locator('#rulesEditor').inputValue()).mode).toBe('strict');
    // each sandbox's view: one script (the bootstrap) under a hash-only policy, and the entry's rendered button
    const VIEW = `[document.scripts.length, document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.split(';')[1].trim().slice(0, 19), !!document.getElementById('add')]`;
    const views = async () => (await inFrames(page, browserName, VIEW, path => path === 'main/wrapper/view')).filter(f => f.path === 'main/wrapper/view').map(f => f.value);
    await expect.poll(views, { timeout: 8000 }).toEqual([[1, "script-src 'sha256-", true], [1, "script-src 'sha256-", true]]);
    expect(await markers(page, browserName)).toEqual([]);
});
