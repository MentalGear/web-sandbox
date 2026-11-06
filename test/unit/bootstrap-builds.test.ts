import { afterEach, describe, expect, it } from 'vitest';
import { createBroker } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { STRICT_DIRECTIVE, viewBootstrapSource, viewBootstrapText, VIEW_OPTIONS } from '@src/lib/in-sandbox-view';

/**
 * Every build hands the guest's bootstrap the byte measure (BD3:TST-10, class P): the bootstrap measures what it posts with
 * the one measure of `call()` (structured-size.ts), and a build that left it out would post unmeasured, which only the
 * Chromium e2e (exact-budget.spec.ts) noticed for the strict worker. The text of each of the three builds (strict, cooperative
 * and worker mode) carries the measure and the broker whole, once each.
 */
afterEach(() => { document.body.replaceChildren(); });

async function build(mode: 'strict' | 'cooperative' | 'worker') {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig({ mode, ...(mode === 'strict' ? { entry: 'main.js' } : {}) });
    if (mode === 'strict') el.registerFiles({ 'main.js': 'void 0' });
    const prepared = el._prepareBuild();
    let text: string = mode === 'strict' ? prepared.strictInit.workerSource : prepared.iframe.srcdoc;
    for (let i = 0; i < 4; i++) text = text.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    return text;
}

// Worker mode's frame holds the worker's whole source as one string literal, so the functions stand there escaped.
const escaped = (code: string) => JSON.stringify(code).slice(1, -1).replaceAll('<', '\\u003c');
const occurrences = (text: string, part: string) => text.split(part).length - 1;
const either = (text: string, code: string) => occurrences(text, code) + occurrences(text, escaped(code));

describe('the guest bootstrap of every build carries the byte measure and the broker', () => {
    for (const mode of ['strict', 'cooperative', 'worker'] as const) {
        it(`${mode} mode: createSizeOf and createBroker, whole, once each`, async () => {
            const text = await build(mode);
            expect(either(text, createSizeOf.toString()), 'createSizeOf').toBe(1);
            expect(either(text, createBroker.toString()), 'createBroker').toBe(1);
        });
    }
});

/**
 * Every source the library generates for a sandbox realm is strict-mode code (BD5:CHL-3, class G): V8 gives
 * `Error.prepareStackTrace`, which guest code sets, the functions of sloppy-mode frames only. A source with no guest code
 * starts with the directive; strict mode's worker source, which carries the entry, has it at the head of the prelude's
 * function, which holds all of the library's code there, and the entry keeps the semantics of the script it was written as.
 */
describe('every generated source starts strict', () => {
    const decode = (text: string) => {
        let out = text;
        for (let i = 0; i < 4; i++) out = out.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
        return out;
    };
    const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
    async function element(config: Record<string, unknown>, files?: Record<string, string>) {
        const { defineWebSandbox } = await import('@src/host');
        defineWebSandbox();
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        if (files) el.registerFiles(files);
        el.setConfig(config);
        return el;
    }
    const guestScript = (el: any) => parse(parse(el.shadowRoot.querySelector('iframe').srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!).head.querySelector('script')!.textContent!;

    for (const mode of ['strict', 'sealed'] as const) {
        it(`${mode} mode: the worker source is the prelude's function, strict from its first statement, then the entry in its own function, then the marker`, async () => {
            const el = await element({ mode, entry: 'main.js' }, { 'main.js': 'void "the entry"' });
            const source: string = el._prepareBuild().strictInit.workerSource;
            expect(source.startsWith(`(function (g) {${STRICT_DIRECTIVE}`)).toBe(true);
            // after the prelude's call, only the entry's function and the marker's call
            const head = '})(this);\n(function () {\n';
            const entry = `${head}void "the entry"\n}).call(this);\n`;
            const at = source.lastIndexOf(entry);
            expect(at, "the prelude's function, called, then the entry").toBeGreaterThan(0);
            expect(source.slice(at + entry.length)).toMatch(/^[A-Za-z_$][\w$]*\(\);\n$/);
            expect(source.indexOf('void "the entry"'), 'the entry is nowhere else').toBe(at + head.length);
        });
    }

    it("cooperative mode: the guest document's bootstrap script starts with the directive", async () => {
        const el = await element({ mode: 'cooperative', capabilities: ['allow-scripts'], html: '<p>x</p>' });
        expect(guestScript(el).startsWith(STRICT_DIRECTIVE)).toBe(true);
    });

    it("worker mode: the frame's bootstrap script and the worker's source it holds each start with the directive", async () => {
        const el = await element({ mode: 'worker' });
        const script = guestScript(el);
        expect(script.startsWith(STRICT_DIRECTIVE)).toBe(true);
        const literal = /\)\((".*?(?<!\\)"), "web-sandbox"\);\}$/s.exec(script);
        expect(literal, "the worker's source as the frame holds it").not.toBeNull();
        expect((JSON.parse(literal![1]!) as string).startsWith(`${STRICT_DIRECTIVE}(function (g, postToFrame) {`)).toBe(true);
    });

    it("the view's and the bridge frame's bootstrap: its function is strict from its first statement and holds the whole text; the view's probe worker is strict too", () => {
        for (const text of [viewBootstrapText(), viewBootstrapSource(VIEW_OPTIONS)]) {
            expect(text.startsWith(`(function () {${STRICT_DIRECTIVE}`)).toBe(true);
            expect(text.endsWith('})();')).toBe(true);
            expect(text).toContain(`"${STRICT_DIRECTIVE}postMessage(0)"`);
        }
    });

    it('the directive makes the code after it strict where it stands (positive control of the shape the checks above look for)', () => {
        expect(new Function(`return (function () {${STRICT_DIRECTIVE}return this; })();`)()).toBeUndefined();
        expect(new Function(`${STRICT_DIRECTIVE}return (function () { return this; })();`)()).toBeUndefined();
        expect(new Function('return (function () { return this; })();')()).toBe(globalThis);
    });
});
