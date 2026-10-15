import { describe, it, expect, vi, afterEach } from 'vitest';
import { viewBootstrapHash, viewBootstrapText } from '@src/lib/in-sandbox-view';
import { scriptInMarkup } from '@src/lib/markup-scripts';
import type { SandboxConfig } from '@src/host';
import type { SandboxOrigins } from '@src/lib/csp/origins';

/**
 * Strict mode is the default (ADR-005 amendment "strict is the default"): a config that names no mode builds the
 * strict view, and markup that would run script in cooperative mode is said, once per element, to run none.
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

const SCRIPT_WARNING = "[Sandbox] strict mode (the default) runs no script in `html`; name a registered file in `entry`, or choose `mode: 'cooperative'`.";
const scriptWarnings = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map(c => String(c[0])).filter(m => m === SCRIPT_WARNING);

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('a config that names no mode is strict', () => {
    it.each([['inserted, never configured', undefined], ['setConfig({})', {}], ['setConfig with html only', { html: '<p>hi</p>' }]])('%s: the view document holds only the policy and the hashed bootstrap', async (_, config) => {
        const el = await element();
        document.body.appendChild(el);
        if (config) el.setConfig(config);
        expect(el._config.mode).toBe('strict');
        const inner = innerOf(el);
        const scripts = [...inner.querySelectorAll('script')].map(script => script.textContent);
        expect(scripts).toEqual([viewBootstrapText()]);
        expect(inner.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')).toContain(`script-src ${viewBootstrapHash()}; script-src-attr 'none'`);
        expect(inner.body.children).toHaveLength(0); // no guest bytes: the html travels to the view in INIT_VIEW
        expect(wrapperOf(el)!.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    });

    it("origins.scripts with no mode is dropped (strict takes none), with one warning; with mode 'cooperative' it is kept", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        el.setConfig({ origins: { scripts: ['https://cdn.example'] } });
        expect(el._origins.scripts).toEqual([]);
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.startsWith('[Sandbox] origins.scripts is not used in strict mode'))).toHaveLength(1);
        el.setConfig({ mode: 'cooperative', origins: { scripts: ['https://cdn.example'] } });
        expect(el._origins.scripts).toEqual(['https://cdn.example']);
    });

    it('the types say the same: a config without a mode is a strict config', () => {
        // @ts-expect-error 'iframe' was renamed 'cooperative'
        const renamed: SandboxConfig = { mode: 'iframe' };
        // @ts-expect-error no mode means strict mode, which takes no origins.scripts
        const strictScripts: SandboxConfig = { origins: { scripts: ['https://cdn.example'] } };
        // @ts-expect-error not even through a variable
        const strictFromVariable: SandboxConfig = { origins: { scripts: ['https://cdn.example'] } as SandboxOrigins };
        const strict: SandboxConfig = { html: '<p>hi</p>', origins: { images: ['https://cdn.example'] } };
        const cooperative: SandboxConfig = { mode: 'cooperative', origins: { scripts: ['https://cdn.example'] } };
        expect([renamed, strictScripts, strictFromVariable, strict, cooperative]).toHaveLength(5);
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

describe('strict html that holds script warns once per element', () => {
    it('a script, then a handler, across setConfig(), reset() and load(): one warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await element();
        document.body.appendChild(el);
        el.setConfig({ html: '<p>clean</p>' });
        expect(scriptWarnings(warn)).toEqual([]);
        el.setConfig({ html: '<script>console.log(1)</script>' });
        el.reset();
        el.load('<button onclick="go()">go</button>');
        el.setConfig({ mode: 'strict', html: '<svg onload="1"></svg>' });
        expect(scriptWarnings(warn)).toEqual([SCRIPT_WARNING]);
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
