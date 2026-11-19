import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, buildOfMode } from './fixture';
import { useRecorder } from './recorder';
import { clickInSandbox, inView, waitInView } from './strict-view';
import { VIEW_MODES } from './view-modes';
import { INERT_HREF, RENDER_RULES, sanitizeRender, VIEW_LINK_CLICK_STOPS, VIEW_MAX_DEPTH, VIEW_RENDER_MAX_LENGTH } from '@src/lib/in-sandbox-view';
import { MAX_LINKS } from '@src/lib/links';
import { fromPreset } from './presets';

/**
 * `links` on every engine (design 02, "links: the user's click on a listed link opens it"; I6): the user's real click on
 * a link whose href is a listed URL opens exactly that URL in a new tab, with no opener and no referrer, and nothing else
 * the app or its user can do makes the host page call `window.open` at all: a click on an unlisted link, on an SVG link
 * with a listed href, on a label or a button inside a marked link, a middle click, the guest's focus and renders and calls
 * after a click elsewhere. The listed URLs are the suite's recorder listener (useRecorder), never the public internet.
 *
 * The host page's `window.open` is wrapped by an init script that records every call (and then makes it), so "nothing
 * opens" here is "the host page never asked", whatever the engine's popup blocker would do: Playwright's builds have it
 * off (research 30). test/e2e/links-popup-blocker.spec.ts runs the same click with the blocker on, on Chromium and Firefox.
 */

const recorder = useRecorder();

// The host page's window.open, recorded (in the host page only: an init script runs in every frame).
async function recordOpens(page: Page) {
    await page.addInitScript(() => {
        if (window !== window.top) return;
        const opens: unknown[][] = [];
        Object.defineProperty(window, 'linkOpens', { value: opens });
        const open = window.open;
        window.open = function (this: Window, ...args: unknown[]) {
            opens.push(args.map(String));
            return Reflect.apply(open, this, args);
        } as typeof window.open;
    });
}
const opens = (page: Page) => page.evaluate(() => (window as any).linkOpens as string[][]);

// Every page the context opens from now on, with the URL it was opened at.
function tabsOf(context: BrowserContext) {
    const tabs: Page[] = [];
    context.on('page', tab => tabs.push(tab));
    return tabs;
}

const BOX = 'position:absolute;display:block;width:120px;height:40px;margin:0';
const markup = (a: string, b: string, unlisted: string) => [
    `<a id="a" href="${a}" style="${BOX};left:10px;top:10px;background:#ccd">listed A</a>`,
    `<a id="u" href="${unlisted}" style="${BOX};left:150px;top:10px">unlisted</a>`,
    `<a id="b" href="${b}" style="position:absolute;display:block;left:10px;top:70px;width:300px;height:40px;margin:0"><label id="lab" style="display:inline-block;width:80px;height:40px">label</label><button id="btn" style="width:80px;height:40px">button</button><span id="bs" style="display:inline-block;width:80px;height:40px">span</span></a>`,
    `<svg id="svg" style="position:absolute;left:10px;top:130px" width="120" height="40"><a id="svga" href="${a}"><rect width="120" height="40" fill="#cdc"></rect></a></svg>`,
    `<p id="off" style="${BOX};left:150px;top:130px">off</p>`,
    '<p id="ready" style="position:absolute;left:0;bottom:0;margin:0">ready</p>',
].join('');

// The guest: every way it has to ask for a link without the user's click on one, run in the 5 seconds after the user's
// click on #off (the popup blocker's window, research 30). Its own record of what it did comes back through `take`.
const ENTRY = `
    const kept = [];
    bridge.expose('take', () => kept.splice(0));
    sandboxView.on('click', 'off', async () => {
        kept.push('off');
        sandboxView.set('a', { focus: true });
        sandboxView.render('<a id="a" href="' + LISTED + '" style="position:absolute;display:block;left:150px;top:130px;width:120px;height:40px">moved</a>', null);
        for (const name of ['sandbox:open', 'sandbox:link', 'sandbox:links', 'open', 'openLink']) {
            try { await bridge.call(name, 0); kept.push(name + ' answered'); } catch (error) { kept.push(name + ' ' + error.code); }
        }
        kept.push('done');
    });
`;

const at = { a: [70, 30], u: [210, 30], lab: [50, 90], btn: [130, 90], bs: [210, 90], svga: [70, 150], off: [210, 150] } as const;
type Spot = keyof typeof at;
const click = (page: Page, spot: Spot) => clickInSandbox(page, at[spot][0], at[spot][1]);

for (const mode of VIEW_MODES) test.describe(`${mode} mode`, () => {
    test.use({ build: buildOfMode(mode) });

    test('a real click on a marked link opens exactly the listed URL in a new tab, with no opener and no referrer; the link\'s href in the view stays inert', async ({ sandbox, page, context, browserName }) => {
        const A = `${recorder.allowed}/link/a`;
        const B = `${recorder.allowed}/link/b?x=1`;
        await recordOpens(page);
        await sandbox.open();
        const tabs = tabsOf(context);
        expect(await sandbox.mount({ mode, links: [A, B], html: markup(A, B, `${recorder.blocked}/unlisted`) })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('ready')`);
        expect(await inView(page, browserName, `[document.getElementById('a').getAttribute('href'), document.getElementById('b').href]`)).toEqual([INERT_HREF, INERT_HREF]);

        await click(page, 'a');
        await expect.poll(() => tabs.length).toBe(1);
        await recorder.waitFor('allowed', '/link/a');
        expect(await opens(page)).toEqual([[A, '_blank', 'noopener,noreferrer']]);
        const tab = tabs[0]!;
        await tab.waitForLoadState('domcontentloaded');
        expect(tab.url()).toBe(A);
        expect(await tab.evaluate(() => [window.opener, document.referrer])).toEqual([null, '']);
        const hit = recorder.hits.find(entry => entry.path === '/link/a')!;
        expect(hit.headers.referer ?? '').toBe(''); // none (Playwright's WebKit sends the header empty)
        expect(page.url()).toContain('/test/e2e/harness.html'); // the host page stayed where it was

        // inside a marked link: the second listed URL
        await click(page, 'bs');
        await expect.poll(() => tabs.length).toBe(2);
        expect((await opens(page))[1]).toEqual([B, '_blank', 'noopener,noreferrer']);
    });
});

test.describe('sealed mode: nothing else opens a tab', () => {
    test('a click on an unlisted link, an SVG link with a listed href, a label or a button inside a marked link, a middle click, and the guest\'s focus, renders and calls after a click elsewhere: the host page never calls window.open', async ({ sandbox, page, context, browserName }) => {
        const A = `${recorder.allowed}/link/a`;
        const B = `${recorder.allowed}/link/b`;
        await recordOpens(page);
        await sandbox.open();
        const tabs = tabsOf(context);
        await sandbox.registerFiles({ 'main.js': `const LISTED = ${JSON.stringify(A)};${ENTRY}` });
        expect(await sandbox.mount({ mode: 'sealed', entry: 'main.js', links: [A, B], html: markup(A, B, `${recorder.blocked}/unlisted`) })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('ready')`);

        for (const spot of ['u', 'svga', 'lab', 'btn'] as const) await click(page, spot);
        const box = (await page.locator('web-sandbox').boundingBox())!;
        await page.mouse.click(box.x + at.a[0], box.y + at.a[1], { button: 'middle' });
        await click(page, 'off'); // the guest's turn, within the 5 seconds of this click
        await expect.poll(async () => (await sandbox.call('take') as string[]).includes('done') ? 'done' : 'waiting', { timeout: 10000 }).toBe('done');
        await page.waitForTimeout(1000);
        expect(await opens(page)).toEqual([]);
        expect(tabs).toEqual([]);
        expect(recorder.paths('allowed')).toEqual([]);
        expect(recorder.paths('blocked')).toEqual([]);

        // positive control, on the link the guest moved under #off: the user's click on it opens it
        await click(page, 'off');
        await expect.poll(() => tabs.length).toBe(1);
        expect(await opens(page)).toEqual([[A, '_blank', 'noopener,noreferrer']]);
    });

    test('Enter on a focused marked link is the click: it opens the listed URL', async ({ sandbox, page, context, browserName }) => {
        const A = `${recorder.allowed}/link/enter`;
        await recordOpens(page);
        await sandbox.open();
        const tabs = tabsOf(context);
        await sandbox.registerFiles({ 'main.js': `bridge.expose('focus', () => { sandboxView.set('a', { focus: true }); return true; });` });
        expect(await sandbox.mount({ mode: 'sealed', entry: 'main.js', links: [A], html: markup(A, `${recorder.blocked}/b`, `${recorder.blocked}/unlisted`) })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('ready')`);
        await click(page, 'off'); // the view has the user's focus, so set({ focus }) may move it
        await sandbox.call('focus');
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'a'`);
        expect(await opens(page)).toEqual([]);
        await page.keyboard.press('Enter');
        await expect.poll(() => tabs.length).toBe(1);
        expect(await opens(page)).toEqual([[A, '_blank', 'noopener,noreferrer']]);
    });

    // A held key (docs/design/REVIEW-3.md, finding 1): a keydown, nine auto-repeats and a keyup on the marked link the
    // guest focused, the guest moving the focus to the other marked link on every keydown it hears. The host page calls
    // window.open once, for the link focused when the key went down, on every engine.
    test('a held Enter on a focused marked link, the guest moving the focus on every keydown: one window.open, for the first press', async ({ sandbox, page, context, browserName }) => {
        const A = `${recorder.allowed}/link/held-a`;
        const B = `${recorder.allowed}/link/held-b`;
        await recordOpens(page);
        await sandbox.open();
        const tabs = tabsOf(context);
        await sandbox.registerFiles({ 'main.js': `
            bridge.expose('focus', () => { sandboxView.set('a', { focus: true }); return true; });
            sandboxView.on('keydown', 'a', () => sandboxView.set('b', { focus: true }));
            sandboxView.on('keydown', 'b', () => sandboxView.set('a', { focus: true }));` });
        expect(await sandbox.mount({ mode: 'sealed', entry: 'main.js', links: [A, B], html: markup(A, B, `${recorder.blocked}/unlisted`) })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('ready')`);
        await click(page, 'off'); // the view has the user's focus, so set({ focus }) may move it
        await sandbox.call('focus');
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'a'`);
        expect(await opens(page)).toEqual([]);
        await page.keyboard.down('Enter');
        for (let i = 0; i < 9; i++) {
            await page.waitForTimeout(80);
            await page.keyboard.down('Enter'); // Playwright marks a second down of a held key as a repeat
        }
        await page.keyboard.up('Enter');
        await page.waitForTimeout(2000);
        expect(await opens(page)).toEqual([[A, '_blank', 'noopener,noreferrer']]);
        expect(tabs.length).toBe(1);
    });

    test('the playground\'s preset: a guest that asks for its link without the user\'s click on it opens nothing', async ({ sandbox, page, context, browserName }) => {
        const preset = fromPreset('links-without-the-click');
        const target = `${recorder.allowed}/preset`;
        await recordOpens(page);
        await sandbox.open();
        const tabs = tabsOf(context);
        await sandbox.registerFiles(preset.files);
        expect(await sandbox.mount({ ...preset.rules, links: [target], html: preset.aimedAt(target) })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('decoy')`);
        await clickInSandbox(page, 300, 250); // a click elsewhere in the view: the guest's 5 seconds
        await page.waitForTimeout(2000);
        expect(await opens(page)).toEqual([]);
        expect(tabs).toEqual([]);
        expect(recorder.paths('allowed')).toEqual([]);
        // positive control: the user's own click on the listed link
        await clickInSandbox(page, 60, 30);
        await expect.poll(() => tabs.length).toBe(1);
        expect(await opens(page)).toEqual([[target, '_blank', 'noopener,noreferrer']]);
    });
});

// The cost of `links` in the view (CONTRIBUTING.md, "A new mitigation is a new cost"): the renderer looks every HTML
// <a>'s href up among the listed URLs (at most MAX_LINKS), once, in the flush, which the view's time budget charges, and the click's
// request walks from the target to its link, at most VIEW_MAX_DEPTH elements. Measured in the view's own document, as the
// renderer's other passes are (strict-view-budget.spec.ts, S73): one render of VIEW_RENDER_MAX_LENGTH characters of links
// whose hrefs each miss every listed URL, one of them by its last character only (every comparison made), parsed and cleaned with no list and
// with MAX_LINKS URLs; the walk from an element VIEW_MAX_DEPTH deep, through the getters the view captures; and the
// held-key listeners (docs/design/REVIEW-3.md, finding 1): a trusted keydown's and keyup's flag, and its read by the click.
test.describe('sealed mode: the cost', () => {
    test('marking adds little to a render\'s parse and clean, and the click\'s walk is bounded by the depth', async ({ sandbox, page, browserName }) => {
        test.setTimeout(60000);
        expect(await sandbox.mount({ mode: 'sealed', html: '<div id="a"></div>' })).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('a')`);
        type Cost = { anchors: number; length: number; none: number; full: number; marked: number; walk: number; depth: number; keys: number; sent: number; without: number; withListeners: number };
        await inView(page, browserName, `(window.__links = null, setTimeout(() => {
            const sanitize = (${sanitizeRender.toString()});
            const rules = ${JSON.stringify(RENDER_RULES)};
            const listed = [];
            for (let i = 0; i < ${MAX_LINKS}; i++) listed.push('https://docs.example.com/guide/' + String(100000 + i) + '-y');
            let html = '';
            let anchors = 0;
            for (let i = 0; html.length < ${VIEW_RENDER_MAX_LENGTH} - 100; i++, anchors++) html += '<a href="https://docs.example.com/guide/' + String(100000 + (i % ${MAX_LINKS})) + '-x">a</a>';
            const switches = { animations: false, autoplay: false, stylesheets: true };
            const cleaned = (links) => {
                const template = document.createElement('template');
                template.innerHTML = html;
                const context = { target: 'div', animating: [], origins: {}, refused: [], urls: 0, loads: [], links, marked: [] };
                sanitize(template.content, () => null, () => false, (css) => css, rules, switches, { elements: 50000, depth: 256, urls: 1000 }, context);
                return context.marked.length;
            };
            // the best of 3 rounds of 10 runs, after 5 to warm up (Firefox's clock moves in whole milliseconds)
            const timed = (run) => {
                for (let i = 0; i < 5; i++) run();
                let best = Infinity;
                for (let round = 0; round < 3; round++) {
                    const t = performance.now();
                    for (let i = 0; i < 10; i++) run();
                    best = Math.min(best, (performance.now() - t) / 10);
                }
                return best;
            };
            // the click's walk, as the view makes it: up from the target through the captured getters, to the link
            let deepest = document.createElement('a');
            const link = deepest;
            let depth = 1;
            for (; depth < ${VIEW_MAX_DEPTH}; depth++) { const span = document.createElement('span'); deepest.appendChild(span); deepest = span; }
            const call = Reflect.apply;
            const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
            const nodeTypeOf = getter(Node.prototype, 'nodeType'), parentOf = getter(Node.prototype, 'parentNode'), localNameOf = getter(Element.prototype, 'localName'), namespaceOf = getter(Element.prototype, 'namespaceURI');
            const stops = ${JSON.stringify(VIEW_LINK_CLICK_STOPS)};
            const marks = new WeakMap([[link, 0]]);
            const walk = () => {
                for (let n = deepest; n && call(nodeTypeOf, n, []) === 1; n = call(parentOf, n, [])) {
                    if (call(namespaceOf, n, []) === 'http://www.w3.org/1999/xhtml' && stops.indexOf(call(localNameOf, n, [])) >= 0) return -1;
                    if (call(localNameOf, n, []) !== 'a' && !call(Element.prototype.hasAttribute, n, ['href'])) continue;
                    const index = marks.get(n);
                    return index === undefined ? -1 : index;
                }
                return -1;
            };
            const walked = timed(() => { for (let i = 0; i < 100; i++) walk(); }) / 100;
            // the held-key listeners as the view has them, on the events a held key raises: a keydown, its click, a keyup
            let keyHeld = false;
            const onKeydown = (event) => { if (!event.isTrusted) return; keyHeld = event.repeat === true; };
            const onKeyup = (event) => { if (event.isTrusted) keyHeld = false; };
            const onClick = (event) => (!event.isTrusted || keyHeld) ? -1 : 0;
            // a dispatched event is never trusted, so the events are stand-ins with the members the listeners read
            const press = { isTrusted: true, repeat: true }, release = { isTrusted: true }, clicked = { isTrusted: true };
            let sent = 0;
            const keys = timed(() => { for (let i = 0; i < 100000; i++) { onKeydown(press); sent += onClick(clicked) + 1; onKeyup(release); } }) / 100000;
            // and what three more listeners on the window cost the browser's dispatch of a keydown, a click and a keyup
            const target = document.getElementById('a');
            const raised = [new KeyboardEvent('keydown', { bubbles: true }), new MouseEvent('click', { bubbles: true }), new KeyboardEvent('keyup', { bubbles: true })];
            const dispatched = () => timed(() => { for (let i = 0; i < 1000; i++) for (let e = 0; e < 3; e++) target.dispatchEvent(raised[e]); }) / 1000;
            const without = dispatched();
            addEventListener('keydown', onKeydown, true);
            addEventListener('keyup', onKeyup, true);
            addEventListener('click', onClick, true);
            const withListeners = dispatched();
            removeEventListener('keydown', onKeydown, true);
            removeEventListener('keyup', onKeyup, true);
            removeEventListener('click', onClick, true);
            window.__links = { anchors, length: html.length, none: timed(() => cleaned([])), full: timed(() => cleaned(listed)), marked: cleaned(listed), walk: walked, depth, keys, sent, without, withListeners };
        }, 0), true)`);
        const cost = await waitInView<Cost>(page, browserName, `window.__links`, 50000);
        console.log(`MEASURED ${browserName} links: a ${cost.length}-character render of ${cost.anchors} links, parsed and cleaned: ${cost.none.toFixed(2)} ms with no list, ${cost.full.toFixed(2)} ms with ${MAX_LINKS} listed URLs, all missed (+${Math.round(((cost.full - cost.none) / cost.none) * 100)}%); the click's walk from ${cost.depth} deep: ${(cost.walk * 1000).toFixed(1)} µs; the held-key listeners: ${(cost.keys * 1e6).toFixed(1)} ns a keydown, its click and its keyup, and their dispatch ${(cost.without * 1000).toFixed(2)} µs without them, ${(cost.withListeners * 1000).toFixed(2)} µs with them; best of 3 rounds of 10`);
        expect(cost.length).toBeLessThanOrEqual(VIEW_RENDER_MAX_LENGTH);
        expect(cost.marked).toBe(0);
        expect(cost.depth).toBe(VIEW_MAX_DEPTH);
        // the spec's own bounds (no documented share: the marking runs in the flush, which the view's time budget charges)
        expect(cost.full).toBeLessThan(cost.none * 1.5);
        expect(cost.walk).toBeLessThan(1);
        expect(cost.sent).toBe(0); // a click during a repeat is no request
        expect(cost.keys).toBeLessThan(0.01);
        expect(cost.withListeners).toBeLessThan(0.05);
    });
});
