import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import { inView, waitInView } from './strict-view';
import type { Page } from '@playwright/test';
import { idleBaseline, loadedShare, MARGIN } from './host-share';

// The host page's busy share with the view's animations running, against its idle baseline before the sandbox
// (./host-share.ts): the best of 2 windows of 1.5 s, 3 s in all.
const ANIMATED = { windows: 2, ms: 1500 };

/**
 * The strict view's switches where the browser decides (research 16): whether the still stylesheet of
 * `allowAnimations: false` stops every animation and transition vector a guest has, what that leaves of the host page's
 * thread, what a host page's style-src that refuses the stylesheet does, and what `allowAutoplay` leaves on media. The
 * library's own logic is unit-tested in test/unit/view-switches.test.ts. Each test failed before the switches existed,
 * but the positive controls.
 *
 * Evidence is read from outside (strict-view.ts): the view's document.getAnimations(), which lists CSS animations and
 * transitions, those on pseudo-elements included, its computed styles, and the host page's own ticks.
 */

const SPIN = '@keyframes spin { from { margin-left: 0 } to { margin-left: 40px } }';

// Every vector a guest has, in one render: unlayered !important, its own named and anonymous layers, pseudo-elements,
// inline !important (plain, prefixed, through a custom property), and the inline declarations the renderer reads
// (R4:C-2: an escaped name, upper case, a prefixed transition, var() in a longhand and in a shorthand,
// `all` beside an animation, a keyword after a shorthand, `inherit` from an animated parent), SVG <style> and an SVG
// style attribute, @starting-style,
// a scroll-driven animation, a registered custom property, a registered stylesheet and one it @imports.
const VECTORS = `
    <style>
        ${SPIN}
        @property --turn { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
        @keyframes turn { to { --turn: 360deg } }
        .unlayered { animation: spin 1s infinite !important }
        @layer guest { .named { animation: spin 1s infinite !important } }
        @layer { .anonymous { animation: spin 1s infinite !important } }
        .before::before, .after::after { content: 'x'; display: inline-block; animation: spin 1s infinite !important }
        li.marker::marker { animation: spin 1s infinite !important }
        input.thumb::-webkit-slider-thumb { animation: spin 1s infinite !important }
        input.thumb::-moz-range-thumb { animation: spin 1s infinite !important }
        input.file::file-selector-button { animation: spin 1s infinite !important }
        .starting { transition: opacity 30s !important; opacity: 1 }
        @starting-style { .starting { opacity: 0 } }
        .scrolled { animation: spin linear both !important; animation-timeline: scroll(root) !important }
        .property { animation: turn 1s infinite !important }
        .transition { transition: color 30s !important }
    </style>
    <link rel="stylesheet" href="anim.css">
    <p class="unlayered">a</p><p class="named">b</p><p class="anonymous">c</p>
    <p class="before">d</p><p class="after">e</p><ul><li class="marker">f</li></ul>
    <input class="thumb" type="range"><input class="file" type="file">
    <p class="starting">g</p><p class="scrolled">h</p><p class="property">i</p><p class="transition" id="transition">j</p>
    <p class="linked">k</p><p class="imported">l</p>
    <p style="animation: spin 1s infinite !important">m</p>
    <p style="-webkit-animation: spin 1s infinite">n</p>
    <p style="--a: spin 1s infinite; animation: var(--a) !important">o</p>
    <p style="transition: opacity 30s !important; opacity: 0.5" id="inline-transition">p</p>
    <p style="anim\\61tion: spin 1s infinite !important">r</p>
    <p style="ANIMATION: SPIN 1S INFINITE">s</p>
    <p style="-webkit-transition: opacity 30s; opacity: 0.5">t</p>
    <p style="--n: spin; animation-name: var(--n); animation-duration: 1s; animation-iteration-count: infinite">u</p>
    <p style="all: unset; animation: spin 1s infinite !important">v</p>
    <p style="--k: spin 1s infinite; all: unset; animation: var(--k) !important">w</p>
    <p style="transition: all 30s; transition-property: revert-layer; opacity: 0.5">x</p>
    <div style="animation: spin 1s infinite"><p style="animation: inherit">y</p></div>
    <svg width="40" height="40"><style>rect { animation: spin 1s infinite !important }</style>
        <rect width="10" height="10"/><circle r="5" cx="20" cy="20" style="animation: spin 1s infinite !important"/></svg>
    <math><mi style="animation: spin 1s infinite !important">q</mi></math>`;

const FILES = {
    'anim.css': `@import url(imp.css); ${SPIN} .linked { animation: spin 1s infinite !important }`,
    'imp.css': `${SPIN} .imported { animation: spin 1s infinite !important }`,
};

async function mountVectors(sandbox: SandboxDriver, config: Record<string, unknown>) {
    await sandbox.registerFiles({ ...FILES, 'main.js': `sandboxView.render(${JSON.stringify(VECTORS)});` });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', ...config })).toBe('ready');
}

const animationsInView = (page: Page, browserName: string) =>
    inView<string[]>(page, browserName, `document.getAnimations().map(a => (a.constructor.name) + ' ' + (a.animationName || a.transitionProperty || '') + ' ' + ((a.effect && a.effect.target && (a.effect.target.className && a.effect.target.className.baseVal !== undefined ? a.effect.target.localName : a.effect.target.className || a.effect.target.localName)) || '') + (a.effect && a.effect.pseudoElement ? a.effect.pseudoElement : ''))`);

test.describe('allowAnimations', () => {
    test('the default (false): no animation and no transition runs in the view', async ({ sandbox, page, browserName }) => {
        await mountVectors(sandbox, {});
        await waitInView(page, browserName, `document.querySelectorAll('.linked, .imported').length === 2`, 10000);
        await page.waitForTimeout(500); // the registered stylesheets load
        expect(await animationsInView(page, browserName)).toEqual([]);
        expect(await inView(page, browserName, `document.head.firstElementChild.localName + ' ' + document.head.firstElementChild.textContent.slice(0, 7)`)).toBe('style @layer{');
    });

    test('positive control, true: the vectors animate in the view', async ({ sandbox, page, browserName }) => {
        await mountVectors(sandbox, { allowAnimations: true });
        // The linked stylesheet (and the one it @imports) loads after the markup: the elements are there, and the inline
        // vectors already animate (21 of the 23), while the sheets' animations are not yet. So wait for what is asserted
        // below, the animations of the linked and of the imported element, not for their elements and a count that the
        // inline vectors reach alone.
        await waitInView(page, browserName, `document.querySelectorAll('.linked, .imported').length === 2 && document.getAnimations().length > 16 && ['linked', 'imported'].every(name => document.getAnimations().some(a => a.effect && a.effect.target && a.effect.target.className === name))`, 10000);
        const running = await animationsInView(page, browserName) as string[];
        console.log(`MEASURED ${browserName} allowAnimations true: ${running.length} animations: ${running.join(', ')}`);
        for (const expected of ['unlayered', 'named', 'anonymous', 'linked', 'imported', 'property', 'scrolled', '::before', '::after', '::marker', 'rect', 'circle', ' mi']) {
            expect(running.some(entry => entry.includes(expected)), expected).toBe(true);
        }
    });

    test('false: no animation and no transition runs in the view, whatever the guest declares; elements keep their end state', async ({ sandbox, page, browserName }) => {
        await mountVectors(sandbox, { allowAnimations: false });
        await waitInView(page, browserName, `document.querySelectorAll('.linked, .imported').length === 2`, 10000);
        await page.waitForTimeout(500); // the registered stylesheets load
        // they did apply: the end state of a transition from @starting-style, the import's rules reached the view
        expect(await inView(page, browserName, `getComputedStyle(document.querySelector('.starting')).opacity`)).toBe('1');
        expect(await inView(page, browserName, `getComputedStyle(document.querySelector('.imported')).animationName`)).toBe('none');
        expect(await animationsInView(page, browserName)).toEqual([]);
        expect(await inView(page, browserName, `getComputedStyle(document.getElementById('transition')).transitionDuration`)).toBe('0s');
        // an inline transition's declarations are gone from the attribute (an inline !important beats any layer)
        expect(await inView(page, browserName, `document.getElementById('inline-transition').getAttribute('style')`)).not.toMatch(/transition/);
        // a change that a transition would animate shows its end state at once
        await inView(page, browserName, `document.getElementById('transition').style.color = 'rgb(255, 0, 0)'`);
        expect(await inView(page, browserName, `document.getAnimations().length + ' ' + getComputedStyle(document.getElementById('transition')).color`)).toBe('0 rgb(255, 0, 0)');
        // and the stylesheet is the view head's first element, before the bootstrap
        expect(await inView(page, browserName, `document.head.firstElementChild.localName + ' ' + document.head.firstElementChild.textContent.slice(0, 7)`)).toBe('style @layer{');
    });

    test("5000 animated elements: false leaves the host page its ticks; true takes them where the view shares the host page's thread", async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        const entry = `sandboxView.render('<style>${SPIN} i { display: block; height: 1px; animation: spin 1s infinite alternate }</style>' + '<i></i>'.repeat(5000));`;
        await sandbox.registerFiles({ 'main.js': entry });
        const idle = await idleBaseline(page);
        const measured: Record<string, number> = {};
        for (const allowAnimations of [false, true]) {
            expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', allowAnimations })).toBe('ready');
            await waitInView(page, browserName, `document.getElementsByTagName('i').length === 5000`, 10000);
            await page.waitForTimeout(1000);
            measured[String(allowAnimations)] = (await loadedShare(page, idle, ANIMATED)).busy;
        }
        console.log(`MEASURED ${browserName} 5000 animated elements, busy share against ${idle.count} idle ticks per ${idle.ms} ms: allowAnimations false ${Math.round(measured.false! * 100)}%, true ${Math.round(measured.true! * 100)}%`);
        // docs/API.md: false "brings every vector back to idle", so nothing past the measure's own margin
        expect(measured.false).toBeLessThanOrEqual(MARGIN);
        expect(measured.true, 'positive control: the animations take the host page\'s thread (the view shares it here)').toBeGreaterThan(0.3);
    });

    // The parts of form controls are pseudo-elements of the engines' own (::-webkit-slider-thumb, ::-moz-range-thumb,
    // ::file-selector-button), which document.getAnimations() does not list: what they cost is read on the host page.
    // The positive control reads the effect itself, in the view, with the most direct signal each engine gives (not the
    // host page's ticks with `true`, a margin that depends on the machine): the animation name the parts compute
    // to where the engine computes style for them (Chromium: the file button; Firefox: the file button and the range
    // thumb), and where it computes none for them (WebKit), the pixels of the element in six samples 90 ms apart, which
    // change while the parts' colours and widths animate and do not when they cannot.
    test("form-control parts: 300 animated range thumbs and file buttons: false leaves the host page its ticks, and no part animates", async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        // the animation name the parts compute to, where the engine computes style for them
        const COMPUTED_PARTS: Record<string, [string, string][]> = {
            // ledger: form-control-parts
            chromium: [['file', '::file-selector-button']],
            firefox: [['file', '::file-selector-button'], ['range', '::-moz-range-thumb']],
            webkit: [],
        };
        const partAnimations = () => inView<string[]>(page, browserName, `(() => {
            const inputs = { range: document.querySelector('input[type=range]'), file: document.querySelector('input[type=file]') };
            return ${JSON.stringify(COMPUTED_PARTS[browserName] ?? [])}.map(([input, part]) => getComputedStyle(inputs[input], part).animationName);
        })()`);
        // how many distinct pictures of the element six samples 90 ms apart show
        const pictures = async () => {
            const seen = new Set<string>();
            for (let i = 0; i < 6; i++) {
                seen.add((await page.locator('web-sandbox').screenshot({ animations: 'allow' })).toString('base64'));
                await page.waitForTimeout(90);
            }
            return seen.size;
        };
        const parts = '::-webkit-slider-thumb, ::-moz-range-thumb, ::file-selector-button';
        const style = `@keyframes paint { from { background-color: red; width: 10px } to { background-color: blue; width: 20px } } `
            + parts.split(', ').map(part => `input${part} { animation: paint 0.5s infinite alternate !important }`).join(' ');
        const entry = `sandboxView.render('<style>${style}</style>' + '<input type="range"><input type="file">'.repeat(150));`;
        await sandbox.registerFiles({ 'main.js': entry });
        const idle = await idleBaseline(page);
        let busyFalse = 1;
        const computed: Record<string, string[]> = {};
        const distinct: Record<string, number> = {};
        for (const allowAnimations of [false, true]) {
            expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', allowAnimations })).toBe('ready');
            await waitInView(page, browserName, `document.getElementsByTagName('input').length === 300`, 10000);
            await page.waitForTimeout(1000);
            if (!allowAnimations) busyFalse = (await loadedShare(page, idle, ANIMATED)).busy;
            computed[String(allowAnimations)] = await partAnimations() as string[];
            // ledger: form-control-parts
            if (browserName === 'webkit') distinct[String(allowAnimations)] = await pictures();
        }
        console.log(`MEASURED ${browserName} 300 animated form-control parts: busy share against ${idle.count} idle ticks per ${idle.ms} ms, allowAnimations false ${Math.round(busyFalse * 100)}%; computed animation names false ${JSON.stringify(computed.false)}, true ${JSON.stringify(computed.true)}`
            + (browserName === 'webkit' ? `; distinct pictures of 6: false ${distinct.false}, true ${distinct.true}` : ''));
        // the guarantee
        expect(busyFalse).toBeLessThanOrEqual(MARGIN); // docs/API.md: false brings every vector back to idle
        // the positive control (true), and the same signal with false
        // ledger: form-control-parts
        if (browserName === 'webkit') {
            expect(distinct.true, 'positive control: the parts animate with true').toBeGreaterThan(1);
            expect(distinct.false).toBe(1);
        } else {
            expect(computed.true!.length).toBeGreaterThan(0);
            expect(computed.true, 'positive control: the parts animate with true').toEqual(computed.true!.map(() => 'paint'));
            expect(computed.false).toEqual(computed.true!.map(() => 'none'));
        }
    });
});

test.describe('allowAutoplay', () => {
    for (const [config, kept] of [[{}, false], [{ allowAutoplay: true }, true]] as const) {
        test(`${JSON.stringify(config)}: <video autoplay> and <audio autoplay> ${kept ? 'keep' : 'lose'} autoplay in the view`, async ({ sandbox, page, browserName }) => {
            await sandbox.registerFiles({ 'main.js': `sandboxView.render('<video id="v" autoplay muted loop></video><audio id="a" autoplay></audio>');` });
            expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', ...config })).toBe('ready');
            await waitInView(page, browserName, `document.getElementById('a')`);
            expect(await inView(page, browserName, `[document.getElementById('v').autoplay, document.getElementById('a').autoplay, document.getElementById('v').loop]`)).toEqual([kept, kept, true]);
        });
    }
});

test.describe("allowAnimations: false under a host page's style-src", () => {
    const STILL_HASH_PLACEHOLDER = '<still>';
    async function open(page: Page, csp: string) {
        await page.goto(`${ORIGIN}/__host-policy?${new URLSearchParams({ csp })}`);
        await page.waitForFunction(() => (window as any).harnessReady === true);
    }
    async function hashes(page: Page) {
        await open(page, '');
        return page.evaluate(async () => {
            const { VIEW_STILL_STYLE } = await import('/src/lib/in-sandbox-view.ts' as string);
            const { scriptHashSource } = await import('/src/lib/csp/script-hash.ts' as string);
            const { WRAPPER_STYLE } = await import('/src/lib/frame-documents.ts' as string);
            return { view: (window as any).viewScriptHash(), still: scriptHashSource(VIEW_STILL_STYLE), wrapper: scriptHashSource(WRAPPER_STYLE) };
        });
    }

    for (const allowed of [false, true]) {
        test(allowed ? "the still stylesheet's hash in style-src: in force, the guest's stylesheets apply, nothing animates" : "style-src without it: the guest's stylesheets go instead, nothing animates, and the element says what to allow", async ({ sandbox, page, browserName }) => {
            const { view, still, wrapper } = await hashes(page);
            const csp = `script-src 'self' ${view}; worker-src blob:; style-src 'self' blob: ${wrapper}${allowed ? ` ${STILL_HASH_PLACEHOLDER}` : ''}`.replace(STILL_HASH_PLACEHOLDER, still);
            await open(page, csp);
            const warnings: string[] = [];
            page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
            await sandbox.registerFiles({ ...FILES, 'main.js': `sandboxView.render('<link rel="stylesheet" href="anim.css"><p class="linked">k</p><p style="animation: spin 1s infinite !important">m</p>');` });
            const settled = await page.evaluate((c) => whenSettled(s => s.setConfig(c)), { entry: 'main.js', allowAnimations: false } as any);
            expect(settled).toBe('ready');
            await waitInView(page, browserName, `document.querySelector('.linked')`);
            await page.waitForTimeout(500);
            expect(await inView(page, browserName, `document.querySelectorAll('link[rel=stylesheet]').length`)).toBe(allowed ? 1 : 0);
            expect(await animationsInView(page, browserName)).toEqual([]);
            const said = warnings.filter(text => text.includes('stops animations'));
            expect(said).toEqual(allowed ? [] : [`[Sandbox] allowAnimations is false, and the host page's style-src refuses the view's stylesheet that stops animations, so the view shows no guest stylesheet (<style>, <link rel="stylesheet">). Allow 'unsafe-inline' or ${still} in style-src (see docs/API.md#host-page-policy).`]);
        });
    }
});
