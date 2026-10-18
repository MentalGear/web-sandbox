import { describe, it, expect, vi, afterEach } from 'vitest';
import { inSandboxView, RENDER_RULES, sanitizeRender, VIEW_OPTIONS, VIEW_STILL_PSEUDO_ELEMENTS, VIEW_STILL_STYLE, type RenderSwitches } from '@src/lib/in-sandbox-view';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { scriptHashSource } from '@src/lib/csp/script-hash';

/**
 * The strict view's two switches, `allowAnimations` (default true) and `allowAutoplay` (default false), where the
 * library's own logic decides: the renderer (what a style attribute and a media element keep), the view's still
 * stylesheet (its text, and that the view puts it first and checks it is in force), and the element's configuration
 * (values, warnings, other modes, the equal-config comparison). What the browsers make of the stylesheet is in
 * test/e2e/view-switches.spec.ts. Each test failed before the switches existed, but the positive controls (animations on,
 * both switches on) and the equal-config comparison, which compares the whole config and so held already.
 */

const SWITCHES: RenderSwitches = { animations: true, autoplay: false, stylesheets: true };

function render(html: string, switches: Partial<RenderSwitches>) {
    const template = document.createElement('template');
    template.innerHTML = html;
    sanitizeRender(template.content, () => null, () => false, RENDER_RULES, { ...SWITCHES, ...switches });
    return template.content;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('the renderer', () => {
    it('animations off: every animation and transition declaration leaves a style attribute, shorthands, longhands, prefixed and var() alike; the rest stays', () => {
        const fragment = render([
            '<p id="a" style="color: red; animation: spin 1s infinite !important; transition: color 1s; --x: 1s; transition-duration: var(--x); animation-name: spin; margin: 0">x</p>',
            '<p id="b" style="animation: spin 1s infinite">only an animation</p>',
            '<svg><rect id="c" style="fill: red; animation-name: spin; transition-property: fill" width="1" height="1"/></svg>',
        ].join(''), { animations: false });
        const a = fragment.getElementById('a')!.getAttribute('style')!;
        expect(a).not.toMatch(/animation|transition/);
        expect(a).toMatch(/color: red/);
        expect(a).toMatch(/margin: 0/);
        expect(fragment.getElementById('b')!.hasAttribute('style')).toBe(false); // nothing left: no attribute
        const c = fragment.getElementById('c')!.getAttribute('style')!;
        expect(c).not.toMatch(/animation|transition/);
        expect(c).toMatch(/fill: red/);
    });

    it('animations off: a style attribute on an element whose namespace has no CSSOM declaration here (MathML in jsdom) is dropped, failing closed', () => {
        const fragment = render('<math><mi id="m" style="animation: spin 1s infinite">x</mi></math>', { animations: false });
        const mi = fragment.getElementById('m') ?? fragment.querySelector('mi')!;
        expect(mi.hasAttribute('style')).toBe(typeof (globalThis as any).MathMLElement === 'function');
        expect(mi.getAttribute('style') ?? '').not.toMatch(/animation/);
    });

    it('animations on: style attributes are left as written', () => {
        const style = 'color: red; animation: spin 1s infinite !important; transition: color 1s';
        expect(render(`<p id="a" style="${style}">x</p>`, { animations: true }).getElementById('a')!.getAttribute('style')).toBe(style);
    });

    it('autoplay off: video and audio lose autoplay and keep the rest; on: they keep it', () => {
        const markup = '<video id="v" autoplay muted loop controls></video><audio id="a" autoplay loop></audio>';
        const off = render(markup, { autoplay: false });
        expect(off.getElementById('v')!.getAttributeNames().sort()).toEqual(['controls', 'id', 'loop', 'muted']);
        expect(off.getElementById('a')!.getAttributeNames().sort()).toEqual(['id', 'loop']);
        const on = render(markup, { autoplay: true });
        expect(on.getElementById('v')!.hasAttribute('autoplay')).toBe(true);
        expect(on.getElementById('a')!.hasAttribute('autoplay')).toBe(true);
    });

    it('stylesheets off (the still stylesheet was refused): every <style>, HTML and SVG, and every stylesheet link go; an icon link stays', () => {
        const isMinted = (url: string) => url.startsWith('blob:null/');
        const files: Record<string, { url: string; type: string }> = { 'a.css': { url: 'blob:null/a', type: 'text/css' }, 'i.png': { url: 'blob:null/i', type: 'image/png' } };
        const run = (stylesheets: boolean) => {
            const template = document.createElement('template');
            template.innerHTML = '<style>p{}</style><svg><style>rect{}</style></svg><link rel="stylesheet" href="a.css"><link rel="icon" href="i.png"><p>x</p>';
            sanitizeRender(template.content, (path) => files[path] ?? null, isMinted, RENDER_RULES, { ...SWITCHES, stylesheets });
            return Array.from(template.content.querySelectorAll('*')).map(e => e.localName + (e.getAttribute('rel') ? `[${e.getAttribute('rel')}]` : ''));
        };
        expect(run(true)).toEqual(['style', 'svg', 'style', 'link[stylesheet]', 'link[icon]', 'p']);
        expect(run(false)).toEqual(['svg', 'link[icon]', 'p']);
    });
});

describe('the still stylesheet (VIEW_STILL_STYLE)', () => {
    it('one anonymous layer: no animation and no transition, !important, on every element and each pseudo-element in a rule of its own', () => {
        expect(VIEW_STILL_STYLE.startsWith('@layer{')).toBe(true);
        expect(VIEW_STILL_STYLE.endsWith('}}')).toBe(true);
        const rules = VIEW_STILL_STYLE.slice('@layer{'.length, -1).split('}').filter(Boolean);
        const declarations = 'animation:none!important;transition:none!important';
        expect(rules.map(rule => rule.slice(rule.indexOf('{') + 1))).toEqual(rules.map(() => declarations));
        const selectors = rules.map(rule => rule.slice(0, rule.indexOf('{')));
        expect(selectors).toEqual(['*', ...VIEW_STILL_PSEUDO_ELEMENTS.map(name => `*::${name}`)]);
        for (const selector of selectors) expect(selector, 'one selector per rule').not.toMatch(/,/);
        for (const name of ['before', 'after', 'marker', 'placeholder', 'selection', 'backdrop', 'file-selector-button', '-webkit-slider-thumb', '-moz-range-thumb']) {
            expect(VIEW_STILL_PSEUDO_ELEMENTS as readonly string[]).toContain(name);
        }
        expect(VIEW_OPTIONS.stillStyle).toBe(VIEW_STILL_STYLE);
    });
});

describe('the view bootstrap: the switches from INIT_VIEW', () => {
    const originalWorker = (globalThis as any).Worker;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
        document.head.replaceChildren();
    });

    async function startView(init: Record<string, unknown>) {
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            postMessage() {}
        };
        new Function(`(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${JSON.stringify(VIEW_OPTIONS)});`)();
        const logic = new MessageChannel(), view = new MessageChannel();
        const toHost: any[] = [];
        view.port2.onmessage = (event) => toHost.push(event.data);
        const html = '<p id="p" style="color: red; animation: spin 1s infinite">x</p><style id="s">p{}</style><video id="v" autoplay></video>';
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html, ...init }, source: window, ports: [logic.port1, view.port1] }));
        await new Promise(resolve => setTimeout(resolve, 20));
        view.port2.close();
        logic.port2.close();
        return { ready: toHost.find(frame => frame.type === 'VIEW_READY') };
    }
    const stillSheets = () => Array.from(document.head.querySelectorAll('style')).filter(style => style.textContent === VIEW_STILL_STYLE);

    it('allowAnimations true, allowAutoplay true: no still stylesheet; inline animations, <style> and autoplay stay', async () => {
        const { ready } = await startView({ allowAnimations: true, allowAutoplay: true });
        expect(stillSheets()).toHaveLength(0);
        expect(ready.stillStyleRefused).toBeUndefined();
        expect(document.getElementById('p')!.getAttribute('style')).toMatch(/animation/);
        expect(document.getElementById('s')).not.toBeNull();
        expect(document.getElementById('v')!.hasAttribute('autoplay')).toBe(true);
    });

    it('allowAnimations false: the still stylesheet is the head\'s first element before anything is rendered, and inline animations go', async () => {
        document.head.innerHTML = '<meta name="referrer" content="no-referrer"><script>/* the bootstrap */</script>';
        const { ready } = await startView({ allowAnimations: false, allowAutoplay: false });
        expect(stillSheets()).toHaveLength(1);
        expect(document.head.firstElementChild).toBe(stillSheets()[0]);
        expect(document.getElementById('p')!.getAttribute('style')).not.toMatch(/animation/);
        expect(document.getElementById('v')!.hasAttribute('autoplay')).toBe(false);
        // jsdom applies no cascade layers, so the view's probe finds the sheet not in force: the guest's stylesheets go
        // (the path a host page's style-src that refuses the sheet takes in a browser), and the check-in says so
        expect(ready.stillStyleRefused).toBe(true);
        expect(document.getElementById('s')).toBeNull();
    });

    it('anything but a literal true is the safe side of each switch: left out, or not a boolean', async () => {
        for (const init of [{}, { allowAnimations: 'yes', allowAutoplay: 1 }]) {
            await startView(init);
            expect(stillSheets()).toHaveLength(1);
            expect(document.getElementById('v')!.hasAttribute('autoplay')).toBe(false);
            delete (globalThis as any).__sandboxViewRuns;
            document.head.replaceChildren();
            document.body.replaceChildren();
        }
    });
});

describe('the configuration: allowAnimations and allowAutoplay', () => {
    async function element() {
        const { defineWebSandbox } = await import('@src/host');
        defineWebSandbox();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        const warnings = () => warn.mock.calls.map(call => String(call[0])).filter(message => /allowAnimations|allowAutoplay/.test(message));
        // what the view is told (INIT_VIEW): read right after setConfig(), before the wrapper loads
        const init = (config: Record<string, unknown>) => {
            el.setConfig(config);
            const { allowAnimations, allowAutoplay } = el._strictInit;
            return { allowAnimations, allowAutoplay };
        };
        return { el, warnings, init };
    }

    it('the defaults: animations allowed, no autoplay; left out and undefined alike', async () => {
        const { init, warnings } = await element();
        expect(init({})).toEqual({ allowAnimations: true, allowAutoplay: false });
        expect(init({ allowAnimations: undefined, allowAutoplay: undefined })).toEqual({ allowAnimations: true, allowAutoplay: false });
        expect(warnings()).toEqual([]);
    });

    it('a boolean is itself', async () => {
        const { init, warnings } = await element();
        expect(init({ allowAnimations: false, allowAutoplay: true })).toEqual({ allowAnimations: false, allowAutoplay: true });
        expect(init({ allowAnimations: true, allowAutoplay: false })).toEqual({ allowAnimations: true, allowAutoplay: false });
        expect(warnings()).toEqual([]);
    });

    it('any other value is false, the safe side, with one warning per element', async () => {
        const { init, warnings } = await element();
        for (const value of ['false', 0, 1, null, 'yes', {}, []]) {
            expect(init({ allowAnimations: value, allowAutoplay: value })).toEqual({ allowAnimations: false, allowAutoplay: false });
        }
        init({ allowAnimations: 'yes', allowAutoplay: 'yes' }); // the same value again: no second warning
        const said = warnings();
        expect(said).toHaveLength(10); // per switch: "false", a number, null, "yes", an object (shown() names a type, not a value)
        expect(said).toContain('[Sandbox] allowAnimations must be a boolean; "yes" was taken as false: animations and transitions are removed from the view.');
        expect(said).toContain('[Sandbox] allowAutoplay must be a boolean; "yes" was taken as false: media in the view does not autoplay.');
    });

    it('ignored in cooperative and worker mode, with one warning each per element, the way entry is', async () => {
        const { el, warnings } = await element();
        el.setConfig({ mode: 'cooperative', allowAnimations: false, allowAutoplay: true });
        el.setConfig({ mode: 'worker', allowAnimations: 'x', allowAutoplay: true });
        el.setConfig({ mode: 'cooperative', allowAnimations: undefined });
        expect(warnings()).toEqual([
            '[Sandbox] "allowAnimations" is used only in strict mode and was ignored.',
            '[Sandbox] "allowAutoplay" is used only in strict mode and was ignored.',
        ]);
    });

    it('part of the equal-config comparison: the same config rebuilds nothing, a changed switch rebuilds', async () => {
        const { el } = await element();
        for (const [name, other] of [['allowAnimations', true], ['allowAutoplay', false]] as const) {
            const config = { mode: 'strict', [name]: !other };
            el.setConfig(config);
            el._state = 'ready'; // as after the view's check-in
            const frame = el.shadowRoot.querySelector('iframe');
            el.setConfig(structuredClone(config));
            expect(el.shadowRoot.querySelector('iframe'), `${name}: the same`).toBe(frame);
            el.setConfig({ ...config, [name]: other });
            expect(el.shadowRoot.querySelector('iframe'), `${name}: changed`).not.toBe(frame);
        }
    });

    it("the view's check-in says the host page refused the still stylesheet: one warning per element, with its hash", async () => {
        const { el } = await element();
        el.setConfig({ mode: 'strict', allowAnimations: false });
        const { port1 } = new MessageChannel();
        el._viewPort = port1;
        const warn = vi.mocked(console.warn);
        el._onViewMessage(port1, { type: 'VIEW_READY', width: 400, height: 300, stillStyleRefused: true });
        el._state = 'loading';
        el._onViewMessage(port1, { type: 'VIEW_READY', width: 400, height: 300, stillStyleRefused: true });
        const said = warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('stops animations'));
        expect(said).toEqual([`[Sandbox] allowAnimations is false, and the host page's style-src refuses the view's stylesheet that stops animations, so the view shows no guest stylesheet (<style>, <link rel="stylesheet">). Allow 'unsafe-inline' or '${scriptHashSource(VIEW_STILL_STYLE)}' in style-src (see docs/API.md#host-page-policy).`]);
        port1.close();
    });
});
