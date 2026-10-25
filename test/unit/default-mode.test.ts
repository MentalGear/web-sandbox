import { describe, it, expect, vi, afterEach } from 'vitest';
import { viewBootstrapHash, viewBootstrapText } from '@src/lib/in-sandbox-view';
import { sealedViewPolicy, strictViewPolicy } from '@src/lib/csp/csp-generator';
import { NO_ORIGINS, type SandboxOrigins } from '@src/lib/csp/origins';
import { scriptInMarkup } from '@src/lib/markup-scripts';
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
const SEALED_POLICY = () => sealedViewPolicy({ fileKinds: new Set(), bootstrapHash: viewBootstrapHash(), scriptUnsafe: false });
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

describe('html that holds script warns once per element, in the default mode and in strict mode', () => {
    it('a script, then a handler, across setConfig(), reset() and load(): one warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        el.setConfig({ html: '<p>clean</p>' });
        expect(scriptWarnings(warn)).toEqual([]);
        el.setConfig({ html: '<script>console.log(1)</script>' });
        el.reset();
        el.load('<button onclick="go()">go</button>');
        el.setConfig({ mode: 'sealed', html: '<svg onload="1"></svg>' });
        expect(scriptWarnings(warn)).toEqual([SCRIPT_WARNING]);
    });

    it('strict mode, named, says it in its own words, once per element', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        el.setConfig({ mode: 'strict', html: '<script>console.log(1)</script>' });
        el.reset();
        el.load('<button onclick="go()">go</button>');
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('runs no script in `html`'))).toEqual([STRICT_SCRIPT_WARNING]);
    });

    it('each element warns for itself', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (let i = 0; i < 2; i++) {
            const el = await element();
            document.body.appendChild(el);
            el.setConfig({ html: '<script>1</script>' });
        }
        expect(scriptWarnings(warn)).toHaveLength(2);
    });

    it('a handler alone warns', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        el.load('<img src="x" onerror="1">');
        expect(scriptWarnings(warn)).toEqual([SCRIPT_WARNING]);
    });

    it('no warning: cooperative and worker mode, markup without script, data-on* attributes, an element not in the document', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        el.setConfig({ html: '<script>1</script>' }); // detached: nothing is built, nothing is said yet
        expect(scriptWarnings(warn)).toEqual([]);
        document.body.appendChild(el);
        expect(scriptWarnings(warn)).toEqual([SCRIPT_WARNING]); // built on insertion

        const other = await element();
        document.body.appendChild(other);
        other.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], html: '<script>1</script><p onclick="1">p</p>' });
        other.setConfig({ mode: 'worker', html: '<script>1</script>' });
        other.setConfig({ html: '<p data-onclick="x">text: &lt;script&gt; onclick=</p>' });
        expect(scriptWarnings(warn)).toEqual([SCRIPT_WARNING]);
    });
});
