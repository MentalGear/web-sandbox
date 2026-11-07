import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cssReferences, keepsUrl, keptCss, withKeptReferences } from '@src/lib/css-references';
import { FileStore, viewStylesheets } from '@src/lib/files';
import { RENDER_ATTRIBUTES, RENDER_RULES, RENDER_URL_ATTRIBUTES, sanitizeRender, type RenderContext } from '@src/lib/in-sandbox-view';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';
import { parseAsView } from './view-parse';

/**
 * The one rule for a URL in the view (BD7:ISO-1; class A, closed by an allowlist, docs/research/18_finding_classes): every
 * position the view loads from keeps a URL only as one of keepsUrl's cases (css-references.ts): a URL the view minted, the
 * empty URL, a fragment-only URL in an SVG reference property, and in a text position a string that names no URL. A rule
 * that named the bad schemes instead left every other one in guest CSS, and the host page's policy reported each refusal
 * to its endpoint with the scheme whole, a channel the guest wrote into.
 *
 * The domain is enumerated: every position (each URL attribute of the renderer, each SVG reference attribute, each way CSS
 * names a URL, in each place guest CSS reaches the view: a style attribute, a `<style>`, a registered stylesheet, and the
 * text an operation applies) × a set of URLs that holds every kind of scheme (special, local, filesystem, extension,
 * file, mailto, a random one), every spelling the URL parser or CSS reads alike (escaped, whitespace, C0 controls, letter
 * case), a URL the view minted and one it did not, a relative URL, a fragment and the empty URL. A source scan holds that
 * no other scheme test over guest URLs exists in src/.
 */

const MINTED = 'blob:null/0b2f6a1e-2c43-4a8f-9d1e-5b6c7d8e9f00';
const REGISTERED = 'img/minted.png'; // a registered file's path, which the registered-path rewrite makes MINTED
const RANDOM = `zq${randomUUID().replaceAll('-', '').slice(0, 10)}.v1+a-b`;

/** Every kind of URL a guest can write, by what it is. */
const URLS: Readonly<Record<string, string>> = {
    http: 'http://x.example/a.png', https: 'https://x.example/a.png', ws: 'ws://x.example/a', wss: 'wss://x.example/a', ftp: 'ftp://x.example/a',
    file: 'file:///etc/passwd', data: 'data:image/png;base64,AAAA', aboutBlank: 'about:blank', about: 'about:x', javascript: 'javascript:alert(1)',
    blobUnminted: 'blob:null/1c2d3e4f-0000-4000-8000-000000000000', filesystem: 'filesystem:https://x.example/temporary/a',
    chromeExtension: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.png', mozExtension: 'moz-extension://3f1a/a.png',
    safariExtension: 'safari-web-extension://3f1a/a.png', chrome: 'chrome://favicon/x', resource: 'resource://gre/a', mailto: 'mailto:a@b.example',
    tel: 'tel:+1', viewSource: 'view-source:https://x.example/', jar: 'jar:https://x.example/a.jar!/b', random: `${RANDOM}:x`,
    long: `${'z'.repeat(400)}:x`, upper: 'HTTPS://x.example/a', leadingSpace: ' zq:x', leadingTab: '\tzq:x', innerTab: 'z\tq:x', innerNewline: 'z\nq:x',
    c0: '\u0001\u0002zq:x', trailingSpace: 'zq:x ', minted: MINTED, mintedSpaced: ` ${MINTED}`, registered: REGISTERED, relative: 'a.png',
    rootRelative: '/a.png', schemeRelative: '//x.example/a.png', query: '?q', fragment: '#x', fragmentSpaced: ' #x', empty: '',
};

/** Whether the URL parser resolves `value` against the view's base: an absolute URL or a fragment (about:blank's path is opaque). */
const resolves = (value: string) => {
    try {
        return !!new URL(value, 'about:blank');
    } catch {
        return false;
    }
};

// ---- markup ------------------------------------------------------------------------------------------------------------

/** HTML for an attribute value. */
const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Each URL attribute of the renderer in a context where it loads, with the type a registered file of that load has. */
const MARKUP: Readonly<Record<string, { html: (v: string) => string; read: (f: DocumentFragment) => string | null; type: string; resolved: boolean }>> = {
    'img src': { html: v => `<img id="e" src="${v}">`, read: f => f.getElementById('e')!.getAttribute('src'), type: 'image/png', resolved: true },
    'img srcset': { html: v => `<img id="e" srcset="${v} 1x">`, read: f => f.getElementById('e')!.getAttribute('srcset'), type: 'image/png', resolved: false },
    'source srcset': { html: v => `<picture><source id="e" srcset="${v} 1x"><img></picture>`, read: f => f.getElementById('e')!.getAttribute('srcset'), type: 'image/png', resolved: false },
    'source src': { html: v => `<video><source id="e" src="${v}"></video>`, read: f => f.getElementById('e')!.getAttribute('src'), type: 'video/mp4', resolved: true },
    'video src': { html: v => `<video id="e" src="${v}"></video>`, read: f => f.getElementById('e')!.getAttribute('src'), type: 'video/mp4', resolved: true },
    'video poster': { html: v => `<video id="e" poster="${v}"></video>`, read: f => f.getElementById('e')!.getAttribute('poster'), type: 'image/png', resolved: true },
    'audio src': { html: v => `<audio id="e" src="${v}"></audio>`, read: f => f.getElementById('e')!.getAttribute('src'), type: 'audio/mpeg', resolved: true },
    'track src': { html: v => `<video><track id="e" src="${v}"></video>`, read: f => f.getElementById('e')!.getAttribute('src'), type: 'text/vtt', resolved: true },
    'link href': { html: v => `<link id="e" rel="stylesheet" href="${v}">`, read: f => f.getElementById('e')?.getAttribute('href') ?? null, type: 'text/css', resolved: true },
};

function renderMarkup(html: string, type: string) {
    const { template, markup } = parseAsView(html);
    const context: RenderContext = { target: 'body', animating: [], origins: {}, refused: [], urls: 0, loads: [], css: [], markup };
    const minted = (url: string) => url === MINTED;
    const css = (text: string, dropped: [string, string][], property: string) => keptCss(text, dropped, property, minted);
    sanitizeRender(template.content, path => (path === REGISTERED ? { url: MINTED, type } : null), url => keepsUrl(url, minted), css, RENDER_RULES, { animations: true, autoplay: true, stylesheets: true }, undefined, context);
    return { fragment: template.content, context };
}

// ---- CSS ---------------------------------------------------------------------------------------------------------------

/** A character as a CSS escape: the same character to CSS. */
const escape = (ch: string) => `\\${ch.charCodeAt(0).toString(16)} `;
/** `value` as a CSS string, every control character, quote and backslash escaped, and with `letters` every letter too. */
const cssString = (value: string, letters = false) => `"${[...value].map(ch => (ch.charCodeAt(0) < 32 || ch === '"' || ch === '\\' || (letters && /[a-z]/i.test(ch)) ? escape(ch) : ch)).join('')}"`;
/** `value` as the inside of an unquoted url token, everything a url token cannot hold escaped, and with `letters` every letter. */
const urlToken = (value: string, letters = false) => [...value].map(ch => (/[\s"'()\\\u0000-\u001f\u007f]/.test(ch) || (letters && /[a-z]/i.test(ch)) ? escape(ch) : ch)).join('');

interface CssPosition {
    /** The declaration (or rule, where `sheet`) naming V; `{S}` is V as a CSS string, `{U}` as a url token's text. */
    readonly css: string;
    /** Only in a stylesheet: an at-rule. */
    readonly sheet?: boolean;
    /** An SVG reference property: a fragment names an element of the document and loads nothing there. */
    readonly local?: boolean;
    /** A text position: a string CSS reads as a URL only where var() carries it into one. */
    readonly text?: boolean;
    /** Cut off by the end of the input: only at the end of a source. */
    readonly unclosed?: boolean;
    /** A reference that can name a registered image (cssReferences, `files` scope): a registered stylesheet's slot. */
    readonly slot?: boolean;
}

/** Every way CSS names a URL (cssReferences, `loads` scope). */
const CSS_POSITIONS: Readonly<Record<string, CssPosition>> = {
    'url token': { css: 'background-image: url({U})', slot: true },
    'url() string': { css: 'background-image: url({S})', slot: true },
    'image-set() string': { css: 'background-image: image-set({S} 1x)', slot: true },
    '-webkit-image-set() string': { css: 'background-image: -webkit-image-set({S} 1x)', slot: true },
    'image-set() url': { css: 'background-image: image-set(url({S}) 1x)', slot: true },
    'src() string': { css: 'background-image: src({S})' },
    'image() string': { css: 'background-image: image({S})' },
    'cursor': { css: 'cursor: url({S}), auto', slot: true },
    'list-style-image': { css: 'list-style-image: url({U})', slot: true },
    'border-image': { css: 'border-image: url({S}) 30', slot: true },
    'mask-border': { css: '-webkit-mask-box-image: url({S})', slot: true },
    'content': { css: 'content: url({S})', slot: true },
    'unclosed url token': { css: 'background-image: url({U}', unclosed: true },
    'unclosed string': { css: 'background-image: url({S}', unclosed: true, slot: true },
    '@import string': { css: '@import {S};', sheet: true },
    '@import url()': { css: '@import url({S}) screen;', sheet: true },
    '@import src()': { css: '@import src({S});', sheet: true },
    '@font-face src': { css: '@font-face { font-family: f; src: url({S}) format("woff2") }', sheet: true },
    'fill (a reference property)': { css: 'fill: url({S})', local: true, slot: true },
    'clip-path (a reference property)': { css: 'clip-path: url({U})', local: true, slot: true },
    'mask (a reference property)': { css: 'mask: url({S}) alpha', local: true, slot: true },
    'a custom property (text)': { css: '--u: {S}', text: true },
    'content text': { css: 'content: {S}', text: true },
};

const writeCss = (position: CssPosition, value: string, letters = false) =>
    position.css.replace('{S}', cssString(value, letters)).replace('{U}', urlToken(value, letters));
/** The sources `position` is tried in: a declaration list, a rule, a rule in a block of an at-rule; an at-rule alone. */
const sourcesOf = (position: CssPosition, declaration: string) => {
    if (position.sheet) return [declaration];
    if (position.unclosed) return [declaration, `p { ${declaration}`];
    return [declaration, `p { ${declaration} }`, `@media screen { p { ${declaration} } }`];
};

/** Whether the rule keeps `value` at `position`, written apart from the code: what the domain is to hold. */
const keptAt = (value: string, position: { local?: boolean; text?: boolean }, minted: string) =>
    value === minted || value === '' || (position.local === true && value.startsWith('#')) || (position.text === true && !resolves(value));

describe('keepsUrl: the one rule, over the domain (BD7:ISO-1)', () => {
    const minted = (url: string) => url === MINTED;

    it('every URL attribute of the renderer keeps only a URL the view minted (a registered path made one), or the empty URL', () => {
        // the positions are the renderer's own list, every one of them
        expect(Object.keys(MARKUP).sort()).toEqual(RENDER_URL_ATTRIBUTES.map(([element, name]) => `${element} ${name}`).sort());
        const wrong: string[] = [];
        for (const [position, { html, read, type, resolved }] of Object.entries(MARKUP)) {
            for (const [name, value] of Object.entries(URLS)) {
                // as written, and with its first letter a character reference: the same value to the parser
                for (const spelled of [attribute(value), attribute(value).replace(/[a-z]/i, ch => `&#x${ch.charCodeAt(0).toString(16)};`)]) {
                    const { fragment, context } = renderMarkup(html(spelled), type);
                    const kept = read(fragment);
                    // (white space around a srcset candidate is the list's, not the URL's)
                    const minted = value === MINTED || (value === ` ${MINTED}` && position.endsWith('srcset'));
                    // (an empty srcset value leaves " 1x": its URL is "1x"; a <link> needs a file to name)
                    const keeps = minted || (value === REGISTERED && resolved) || (value === '' && position !== 'link href' && !position.endsWith('srcset'));
                    // a dropped URL is reported; a <link> that names no minted file goes whole, unreported (sanitizeRender)
                    const reports = keeps || position === 'link href' ? 0 : 1;
                    if ((kept !== null) !== keeps || context.refused.length !== reports) wrong.push(`${position} ${name} ${JSON.stringify(spelled)}: ${kept} ${JSON.stringify(context.refused)}`);
                }
            }
        }
        expect(wrong).toEqual([]);
    });

    it('every SVG reference attribute keeps only a fragment of the document (and the empty URL)', () => {
        const wrong: string[] = [];
        for (const property of RENDER_ATTRIBUTES.svgLocalReferences) {
            for (const [name, value] of Object.entries(URLS)) {
                const { fragment } = renderMarkup(`<svg><rect id="e" ${property}="${attribute(`url(${cssString(value)})`)}"/></svg>`, 'image/png');
                const kept = fragment.getElementById('e')!.getAttribute(property);
                const keeps = keptAt(value, { local: true }, MINTED);
                if ((kept === `url(${cssString(value)})`) !== keeps) wrong.push(`${property} ${name}: ${kept}`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it('every way CSS names a URL, written plainly or with every letter escaped, as a declaration list and as a stylesheet', () => {
        const wrong: string[] = [];
        for (const [position, at] of Object.entries(CSS_POSITIONS)) {
            for (const [name, value] of Object.entries(URLS)) {
                for (const letters of [false, true]) {
                    for (const source of sourcesOf(at, writeCss(at, value, letters))) {
                        const dropped: [string, string][] = [];
                        keptCss(source, dropped, '', minted);
                        if ((dropped.length === 0) !== keptAt(value, at, MINTED)) wrong.push(`${position} ${name} ${JSON.stringify(source)}`);
                    }
                }
            }
        }
        expect(wrong).toEqual([]);
    });

    it('in a style attribute and a <style> the view renders: the same, and what is dropped is reported', () => {
        const wrong: string[] = [];
        for (const [position, at] of Object.entries(CSS_POSITIONS)) {
            for (const [name, value] of Object.entries(URLS)) {
                const declaration = writeCss(at, value);
                const html = (at.sheet ? '' : `<p id="a" style="${attribute(declaration)}">a</p>`) + `<style>${sourcesOf(at, declaration).at(at.sheet ? 0 : 1)}</style>`;
                const { context } = renderMarkup(html, 'image/png');
                const places = at.sheet ? 1 : 2;
                const expected = keptAt(value, at, MINTED) ? 0 : places;
                if (context.refused.length !== expected) wrong.push(`${position} ${name}: ${JSON.stringify(context.refused)}`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it('in a registered stylesheet: only a reference to a registered file (its slot, the view\'s blob: URL) and the same fragments and text', () => {
        const wrong: string[] = [];
        for (const [position, at] of Object.entries(CSS_POSITIONS)) {
            const files: Record<string, string | Uint8Array> = { [REGISTERED]: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
            const names = Object.keys(URLS);
            names.forEach((name, i) => { files[`s${i}.css`] = sourcesOf(at, writeCss(at, URLS[name]!)).at(at.sheet ? 0 : 1)!; });
            const store = new FileStore(() => {});
            store.register(files);
            const { dropped } = viewStylesheets(store.snapshot());
            names.forEach((name, i) => {
                const value = URLS[name]!;
                const isDropped = dropped.some(drop => drop.path === `s${i}.css`);
                // a registered path is a slot where the reference can name a registered image (not @import, @font-face, src(), image())
                const slot = value === REGISTERED && at.slot === true;
                if (isDropped === (slot || keptAt(value, at, '\u0000none'))) wrong.push(`${position} ${name}`);
            });
        }
        expect(wrong).toEqual([]);
    });

    it('withKeptReferences takes every reference cssReferences finds in loads scope, and keeps exactly what keepsUrl keeps', () => {
        const source = Object.values(CSS_POSITIONS).filter(at => !at.sheet && !at.unclosed).map(at => Object.values(URLS).map(value => writeCss(at, value)).join('; ')).join('; ');
        const found = cssReferences(`p { ${source} }`, 'loads');
        const asked: string[] = [];
        withKeptReferences(`p { ${source} }`, cssReferences, (url, property, text) => { asked.push(url); return keepsUrl(url, minted, property, text); }, [], '');
        expect(asked).toEqual(found.map(reference => reference.url));
    });

    it('a fragment is local only in a declaration the tokenizer can name: not after a bracket that matches nothing, nor in a nested rule\'s block', () => {
        const local = (css: string) => cssReferences(css, 'loads').map(reference => reference.property);
        expect(local('fill: url(#a); p:hover { background: url(#b) } clip-path: url(#c)')).toEqual(['fill', 'background', 'clip-path']);
        expect(local('fill: ( ] ; background-image: url(#a)')).toEqual(['']);
        expect(local('p { fill: image-set(} url(#a)) }')).toEqual(['']);
        expect(local('--x: { fill: url(#a) }; f\\69 ll: url(#b); FILL: url(#c)')).toEqual(['fill', 'fill', 'fill']);
    });
});

// ---- the source scan -----------------------------------------------------------------------------------------------------

/** A scheme as a test names it: one of the schemes, or the grammar of any. */
const SCHEME = /(?:^|[^a-z-])(?:https?|wss?|blob|data|about|javascript|ftp|file|filesystem|mailto|tel|view-source|jar|chrome|resource|[a-z]+-extension)\??\)?:|https\?|\[a-zA-Z\]\[a-zA-Z0-9\+\.-\]|\[a-z\]\[a-z0-9\+\.-\]/i;
const SCHEME_NAME = /^(?:https?|wss?|blob|data|about|javascript|ftp|file|filesystem|mailto|tel|view-source|jar|chrome|resource)$/i;
const COMPARISONS = new Set([SyntaxKind.EqualsEqualsEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken, SyntaxKind.EqualsEqualsToken, SyntaxKind.ExclamationEqualsToken, SyntaxKind.CaseKeyword]);
const STRING_TESTS = ['startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'includes'];

/** The scheme tests in a text: a regular expression that names a scheme, and a comparison or string test with one. */
function schemeTests(text: string): string[] {
    const tokens = tokenize(text);
    const found: string[] = [];
    tokens.forEach((token, i) => {
        if (token.kind === SyntaxKind.RegularExpressionLiteral && SCHEME.test(token.text)) found.push(token.text);
        const isString = token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
        if (!isString) return;
        const value = token.text.slice(1, -1);
        const scheme = SCHEME_NAME.test(value.replace(/:$/, '')) || /^[a-z][a-z0-9+.-]*:$/i.test(value);
        const compared = COMPARISONS.has(tokens[i - 1]?.kind as SyntaxKind) || COMPARISONS.has(tokens[i + 1]?.kind as SyntaxKind);
        const tested = tokens[i - 1]?.kind === SyntaxKind.OpenParenToken && STRING_TESTS.includes(tokens[i - 2]?.text ?? '') && /^[a-z][a-z0-9+.-]*:/i.test(value);
        if ((scheme && compared) || tested) found.push(token.text);
    });
    return found;
}

/**
 * Every scheme test over a URL in src/, by file, and why it is no rule of what the view keeps. A new one fails until it is
 * here, and the rule's own functions have none.
 */
const SCHEME_TESTS: Readonly<Record<string, { readonly count: number; readonly why: string }>> = {
    'src/lib/csp/host-connect.ts': { count: 6, why: "it reads the embedder's Content-Security-Policy text (hostContentSecurityPolicy), not a guest URL" },
    'src/lib/csp/origins.ts': { count: 2, why: "it pairs the embedder's typed origins (`origins`), not a guest URL" },
    'src/lib/fetch-bridge.ts': { count: 2, why: "the fetch bridge's request policy (strict mode's network option; sealed mode refuses every call): what the bridge sends, behind its allowlist of typed origins, never what the view keeps" },
    'src/lib/in-sandbox-script.ts': { count: 9, why: "the worker's request gate: a guest request is admitted only by the guest policy's typed connect-src sources (sealed mode has none), and the scheme only shapes the refusal it reports and a WebSocket's URL; never what the view keeps" },
    'src/lib/origin.ts': { count: 1, why: "it reads the embedder's origins as written (`origins`, `fetchBridge.allow`), not a guest URL" },
    'src/lib/in-sandbox-view.ts': { count: 3, why: "inSandboxView reads what the platform reports of loads the view already kept (a failed load's source, a resource timing entry), never what it keeps; and an input's type `file`" },
};

describe('the source scan: no scheme test over guest URLs in src/ but the classified ones, and none in the rule (BD7:ISO-1)', () => {
    const root = join(__dirname, '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
        }
    };
    walk(join(root, 'src'));

    it('every file of src/ has only its classified scheme tests', () => {
        const counts: Record<string, number> = {};
        for (const file of files) {
            const found = schemeTests(readFileSync(file, 'utf8'));
            if (found.length > 0) counts[relative(root, file)] = found.length;
        }
        expect(counts).toEqual(Object.fromEntries(Object.entries(SCHEME_TESTS).map(([file, { count }]) => [file, count])));
    });

    it("the rule's own functions, and every function that applies it, test no scheme", () => {
        for (const fn of [keepsUrl, withKeptReferences, cssReferences, keptCss, sanitizeRender, viewStylesheets]) expect(schemeTests(fn.toString()), fn.name).toEqual([]);
    });

    it('positive control: the scan finds a scheme test of each form', () => {
        expect(schemeTests("const a = /^(?:https?|wss?):/i.test(u); if (name === 'blob') x(); if (u.startsWith('zq:')) y(); switch (p) { case 'data:': }")).toHaveLength(4);
    });
});
