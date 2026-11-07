import { describe, it, expect, vi, afterEach } from 'vitest';
import { VIEW_RENDER_MAX_LENGTH, viewBootstrapHash, viewBootstrapText } from '@src/lib/in-sandbox-view';
import { ConfigRefusal, normaliseConfig } from '@src/lib/config-schema';
import { reasonText, TERMINATION_REASONS } from '@src/lib/reasons';
import { sealedViewPolicy, strictViewPolicy } from '@src/lib/csp/csp-generator';
import { NO_ORIGINS, type SandboxOrigins } from '@src/lib/csp/origins';
import { scriptInMarkup } from '@src/lib/markup-scripts';
import { runBootstrap } from './sandbox-environment';
import type { SandboxConfig } from '@src/host';

/**
 * Sealed mode is the default (ADR-008; T8 of docs/research/24_sealed_mode): a config that names no mode builds strict
 * mode's view with sealed mode's policy, and markup that would run script in cooperative mode is said, once per
 * element, to run none. Strict mode, named, builds the same view with its own policy: the same property, held for it.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe');
const innerSourceOf = (el: HTMLElement) => parse(wrapperOf(el)!.srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!;
const innerOf = (el: HTMLElement) => parse(innerSourceOf(el));

async function element() {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    return document.createElement('web-sandbox') as any;
}

const SCRIPT_WARNING = "[Sandbox] sealed mode (the default) runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.";
const STRICT_SCRIPT_WARNING = "[Sandbox] strict mode runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.";
const scriptWarnings = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map(c => String(c[0])).filter(m => m === SCRIPT_WARNING);

// A registered JSON file: strict mode admits blob: in connect-src for it, sealed mode never does (connect-src 'none'),
// so the two modes' policies differ and policy equality tells them apart.
const FILES = { 'data.json': '{}' };
const SEALED_POLICY = () => sealedViewPolicy({ fileKinds: new Set(), bootstrapHash: viewBootstrapHash() });
const STRICT_POLICY = () => strictViewPolicy({ origins: NO_ORIGINS, fileKinds: new Set(['connect']), bootstrapHash: viewBootstrapHash(), scriptUnsafe: false });

/** What the element built: the view's scripts, its policy, its body, the wrapper's flags, the frames of the shadow root. */
function built(el: any) {
    const inner = innerOf(el);
    return {
        scripts: [...inner.querySelectorAll('script')].map(script => script.textContent),
        policy: inner.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content'),
        body: inner.body.children.length, // no guest bytes: the html travels to the view in INIT_VIEW
        flags: wrapperOf(el)!.getAttribute('sandbox'),
        frames: el.shadowRoot.querySelectorAll('iframe').length, // the wrapper only: no bridge frame
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('T8: a config that names no mode is sealed', () => {
    it.each([['inserted, never configured', undefined], ['setConfig({})', {}], ['setConfig with html only', { html: '<p>hi</p>' }]])('%s: the view document holds only the sealed policy and the hashed bootstrap', async (_, config) => {
        const el = await element();
        el.registerFiles(FILES);
        document.body.appendChild(el);
        if (config) el.setConfig(config);
        expect(el._config.mode).toBe('sealed');
        expect(built(el)).toEqual({ scripts: [viewBootstrapText()], policy: SEALED_POLICY(), body: 0, flags: 'allow-scripts allow-forms', frames: 1 });
        expect(Object.keys(el._strictInit)).not.toContain('origins'); // sealed mode's INIT_VIEW names no origins
    });

    it.each([['mode only', { mode: 'strict' }], ['mode and html', { mode: 'strict', html: '<p>hi</p>' }]])("strict, named (%s): the same view and bootstrap, with strict mode's policy", async (_, config) => {
        expect(STRICT_POLICY()).not.toBe(SEALED_POLICY());
        const el = await element();
        el.registerFiles(FILES);
        document.body.appendChild(el);
        el.setConfig(config);
        expect(el._config.mode).toBe('strict');
        expect(built(el)).toEqual({ scripts: [viewBootstrapText()], policy: STRICT_POLICY(), body: 0, flags: 'allow-scripts allow-forms', frames: 1 });
    });

    it("origins.scripts with mode 'strict' is dropped (strict takes none), with one warning; with mode 'cooperative' it is kept", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        el.setConfig({ mode: 'strict', origins: { scripts: ['https://cdn.example'] } });
        expect(el._origins.scripts).toEqual([]);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.startsWith('[Sandbox] origins.scripts is not used in strict mode'))).toHaveLength(1);
        el.setConfig({ mode: 'cooperative', origins: { scripts: ['https://cdn.example'] } });
        expect(el._origins.scripts).toEqual(['https://cdn.example']);
    });

    it('the types say the same: a config without a mode is a sealed config, and strict mode is named', () => {
        // @ts-expect-error 'iframe' was renamed 'cooperative'
        const renamed: SandboxConfig = { mode: 'iframe' };
        // @ts-expect-error no mode means sealed mode, which takes no origins (test/unit/sealed-mode.test.ts, T1)
        const noModeOrigins: SandboxConfig = { html: '<p>hi</p>', origins: { images: ['https://cdn.example'] } };
        // @ts-expect-error strict mode takes no origins.scripts
        const strictScripts: SandboxConfig = { mode: 'strict', origins: { scripts: ['https://cdn.example'] } };
        // @ts-expect-error not even through a variable
        const strictFromVariable: SandboxConfig = { mode: 'strict', origins: { scripts: ['https://cdn.example'] } as SandboxOrigins };
        const sealed: SandboxConfig = { html: '<p>hi</p>' };
        const strict: SandboxConfig = { mode: 'strict', html: '<p>hi</p>', origins: { images: ['https://cdn.example'] } };
        const cooperative: SandboxConfig = { mode: 'cooperative', origins: { scripts: ['https://cdn.example'] } };
        expect([renamed, noModeOrigins, strictScripts, strictFromVariable, sealed, strict, cooperative]).toHaveLength(7);
    });
});

// BD7:LIM-3 (class E-cpu): `html` had no size cap, and the view parses the whole of its initial markup before its renderer
// can refuse any of it. Markup longer than one render (the initial view is one) is refused where it arrives.
describe('html longer than one render is refused at configuration, by setConfig() and load() (BD7:LIM-3)', () => {
    const LONG = `<p>${'x'.repeat(VIEW_RENDER_MAX_LENGTH)}</p>`;
    const FITS = `<p>${'x'.repeat(VIEW_RENDER_MAX_LENGTH - 7)}</p>`;
    const reasons = (el: any) => {
        const seen: string[] = [];
        el.addEventListener('terminated', (event: CustomEvent) => seen.push(event.detail.reason));
        return seen;
    };
    const settled = () => new Promise(resolve => setTimeout(resolve, 0));

    it('the schema refuses it in strict and sealed mode, named or the default, with its reason; one that fits, and cooperative and worker mode, are kept', () => {
        const host = { hostOrigin: 'https://host.example', hostSites: ['https://host.example'] };
        expect(FITS.length).toBe(VIEW_RENDER_MAX_LENGTH);
        for (const config of [{ html: LONG }, { mode: 'sealed', html: LONG }, { mode: 'strict', html: LONG }]) {
            const { value, refusal } = normaliseConfig(config, host);
            expect(value, JSON.stringify(config.mode)).toBeNull();
            expect((refusal as ConfigRefusal).reason).toBe(reasonText('htmlTooLong'));
        }
        for (const config of [{ html: FITS }, { mode: 'strict', html: FITS }, { mode: 'cooperative', html: LONG }, { mode: 'worker', html: LONG }]) {
            expect(normaliseConfig(config, host).refusal, `${config.mode} ${config.html.length}`).toBeNull();
        }
        expect(TERMINATION_REASONS.htmlTooLong.decidedBy).toBe('config');
    });

    it('setConfig() keeps nothing of it; load() keeps the html it had; both end the build with the reason, and the view never gets it', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        const seen = reasons(el);
        el.setConfig({ html: '<p>kept</p>' });
        el.setConfig({ html: LONG });
        await settled();
        expect(el.state).toBe('terminated');
        expect(el._config.html).toBe('<p>kept</p>');
        el.setConfig({ html: '<p>kept</p>' });
        expect(el.state).toBe('loading');
        el.load(LONG);
        await settled();
        expect(el.state).toBe('terminated');
        expect(seen).toEqual([reasonText('htmlTooLong'), reasonText('htmlTooLong')]);
        expect(el._config.html).toBe('<p>kept</p>');
        expect(el._strictInit).toBeNull();
        el.reset(); // the html it kept builds
        expect(el.state).toBe('loading');
        expect(el._strictInit.html).toBe('<p>kept</p>');
        el.load(FITS);
        expect(el._strictInit.html).toBe(FITS);
    });
});

describe('scriptInMarkup: script elements and handler attributes, read with an inert parser', () => {
    it.each([
        ['an HTML script', '<script>1</script>'],
        ['an HTML script, upper case', '<SCRIPT src="a.js"></SCRIPT>'],
        ['a module script with no content', '<script type="module" src="app.js"></script>'],
        ['an SVG script', '<svg><script>1</script></svg>'],
        ['an SVG script, mixed case', '<svg><ScRiPt href="x.js"/></svg>'],
        ['a script in MathML', '<math><mi><script>1</script></mi></math>'],
        ['a handler in HTML', '<img src="x" onerror="1">'],
        ['a handler, upper case', '<p ONCLICK="1">p</p>'],
        ['a handler, mixed case', '<details open onToggle="1"></details>'],
        ['a handler with no value', '<body onload>'],
        ['a handler on SVG', '<svg onload="1"></svg>'],
        ['a handler on an SVG child', '<svg><rect ONCLICK="1"/></svg>'],
        ['a handler on MathML', '<math><mi onclick="1">x</mi></math>'],
        ['a script inside a template', '<template><script>1</script></template>'],
        ['a handler inside a declarative shadow root', '<div><template shadowrootmode="open"><b onclick="1">b</b></template></div>'],
        ['a script after a lot of markup', `${'<p>x</p>'.repeat(5000)}<script>1</script>`],
    ])('%s', (_, html) => {
        expect(scriptInMarkup(html)).toBe(true);
    });

    it.each([
        ['nothing', ''],
        ['plain markup', '<main id="app"><h1>Hi</h1><button id="go">Go</button></main>'],
        ['the word script in text', '<p>&lt;script&gt;alert(1)&lt;/script&gt; and onclick="x"</p>'],
        ['onclick= in text', '<p>onclick=1 onload=2</p>'],
        ['script in a comment', '<!-- <script>1</script> <p onclick="1"> -->'],
        ['script in a textarea (text)', '<textarea><script>1</script></textarea>'],
        ['script in a title (text)', '<title><script>1</script></title>'],
        ['script in a style (text)', '<style>/* <script>1</script> */ p { color: red }</style>'],
        ['handler text in an attribute value', '<a title="onclick=1" href="#onload">a</a>'],
        ['data-on* attributes', '<div data-onclick="1" data-on="x" data-onload="2"></div>'],
        ['aria and other attributes that contain "on"', '<button aria-pressed="false" contenteditable="false" ion="1">b</button>'],
        ['an attribute named on', '<div on="1"></div>'],
        ['a noscript, read as markup with scripting off', '<noscript><p>no script</p></noscript>'],
    ])('no false positive: %s', (_, html) => {
        expect(scriptInMarkup(html)).toBe(false);
    });

    it('never runs anything and loads nothing it reads', () => {
        const before = (globalThis as any).__scriptInMarkupRan;
        expect(scriptInMarkup('<script>globalThis.__scriptInMarkupRan = 1</script><img src="x" onerror="globalThis.__scriptInMarkupRan = 2">')).toBe(true);
        expect((globalThis as any).__scriptInMarkupRan).toBe(before);
    });
});

// BD7:LIM-1 (class A, the host realm): the element read `html` with the host page's DOMParser to decide this warning, and
// Chromium checks the host page's policy as it parses (a style attribute against style-src, with its sample reported; a
// <base> against base-uri, with the guest's URL reported). The view's renderer notes what it drops of the initial view
// (VIEW_INITIAL), and the element warns from that: a strict or sealed build reads no markup in the host page's realm.
describe('html that holds script warns once per element, from what the view dropped of it (BD7:LIM-1)', () => {
    // The view's notice of what it dropped of the initial view, on the element's current view port.
    const viewDropped = (el: any, dropped: unknown) => {
        const { port1 } = new MessageChannel();
        el._viewPort = port1;
        el._onViewMessage(port1, { type: 'VIEW_INITIAL', dropped });
        port1.close();
    };

    it('a script, then a handler, across setConfig(), reset() and load(): one warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        el.setConfig({ html: '<p>clean</p>' });
        viewDropped(el, ['reference']);
        expect(scriptWarnings(warn)).toEqual([]);
        el.setConfig({ html: '<script>console.log(1)</script>' });
        viewDropped(el, ['script']);
        el.reset();
        viewDropped(el, ['script']);
        el.load('<button onclick="go()">go</button>');
        viewDropped(el, ['handler']);
        expect(scriptWarnings(warn)).toEqual([SCRIPT_WARNING]);
    });

    it('strict mode, named, says it in its own words, once per element', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        el.setConfig({ mode: 'strict', html: '<script>console.log(1)</script>' });
        viewDropped(el, ['script', 'handler', 'reference']);
        el.load('<button onclick="go()">go</button>');
        viewDropped(el, ['handler']);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('runs no script in `html`'))).toEqual([STRICT_SCRIPT_WARNING]);
    });

    it('each element warns for itself', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (let i = 0; i < 2; i++) {
            const el = await element();
            document.body.appendChild(el);
            el.setConfig({ html: '<script>1</script>' });
            viewDropped(el, ['script']);
        }
        expect(scriptWarnings(warn)).toHaveLength(2);
    });

    it('no warning: notes that name neither (a reference, nothing, what is not a list), and a mode with no view', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        for (const dropped of [['reference'], [], 'script', null, { 0: 'script', length: 1 }, ['reference', 'x', 'y', 'script']]) viewDropped(el, dropped);
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], html: '<script>1</script>' });
        viewDropped(el, ['script']);
        expect(scriptWarnings(warn)).toEqual([]);
        el.setConfig({ html: '<img src="x" onerror="1">' });
        viewDropped(el, ['handler']); // positive control: a handler alone warns
        expect(scriptWarnings(warn)).toEqual([SCRIPT_WARNING]);
    });

    it("a strict or sealed build parses no markup in the host page's realm: setConfig(), load(), reset() and insertion; cooperative mode's documented parse is seen (positive control)", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const parses = vi.spyOn(DOMParser.prototype, 'parseFromString');
        const html = '<p style="color: red">a</p><style>p { color: blue }</style><svg><style>rect { fill: red }</style></svg><base href="https://x.example/?secret=1"><script>1</script><img src="x" onerror="1">';
        const el = await element();
        el.setConfig({ html });
        document.body.appendChild(el); // insertion builds
        el.setConfig({ mode: 'strict', html });
        el.reset();
        el.load(html);
        el.setConfig({ html: `${html}<i>sealed</i>` });
        el.load(html);
        expect(el.state).toBe('loading');
        expect(parses.mock.calls.length, 'DOMParser calls of strict and sealed builds').toBe(0);
        el.setConfig({ mode: 'cooperative', html }); // no allow-scripts: the element says what will not run, read with an inert parser
        expect(parses.mock.calls.length, "cooperative mode's documented host-side parse").toBeGreaterThan(0);
    });
});

describe('the view says what it dropped of the initial view, once a build (VIEW_INITIAL)', () => {
    const originalWorker = (globalThis as any).Worker;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
    });

    // The view's bootstrap in this document with a fake Worker, given `html` as its initial view: what it posts the host.
    const initialView = (html: string) => {
        vi.spyOn(URL, 'createObjectURL').mockImplementation((() => 'blob:view/1') as typeof URL.createObjectURL);
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            postMessage() {}
        };
        runBootstrap(viewBootstrapText());
        const logic = new MessageChannel(), view = new MessageChannel();
        const fromView: any[] = [];
        view.port2.onmessage = (event) => fromView.push(event.data);
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html }, source: window, ports: [logic.port1, view.port1] }));
        return fromView;
    };
    const settled = () => new Promise(resolve => setTimeout(resolve, 20));

    it('its scripts and handlers, once each, after the check-in; nothing when it dropped neither', async () => {
        const dropping = initialView('<p onclick="a()">a</p><script>b()</script><svg onload="c()"><script>d()</script></svg><img src="missing.png">');
        await settled();
        expect(dropping.map(frame => frame.type).filter(type => type === 'VIEW_READY' || type === 'VIEW_INITIAL')).toEqual(['VIEW_READY', 'VIEW_INITIAL']);
        expect(dropping.find(frame => frame.type === 'VIEW_INITIAL')).toEqual({ type: 'VIEW_INITIAL', dropped: ['handler', 'script', 'reference'] });
        document.body.replaceChildren();
        const clean = initialView('<p data-onclick="x">clean</p>');
        await settled();
        expect(clean.map(frame => frame.type)).not.toContain('VIEW_INITIAL');
    });
});
