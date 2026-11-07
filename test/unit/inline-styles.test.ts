import { describe, it, expect, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { cssLoadBound, inSandboxView, isStyleProperty, RENDER_RULES, sanitizeRender, VIEW_OPTIONS, viewBudget, viewInputOutbox, type RenderContext, type RenderSwitches, type ViewOptions } from '@src/lib/in-sandbox-view';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { cssReferences, dropNetworkCss, withoutNetworkReferences } from '@src/lib/css-references';
import { styleMarkup, type StyleMarkup } from '@src/lib/style-markup';
import { declared, parseAsIs, parseAsView } from './view-parse';

/**
 * The view applies every guest style through the CSSOM, never as an inline style (S74, class A: INHERITED_CONTEXT.cspReporting;
 * BD6:ISO-2; docs/research/25_cssom_styles/README.md). A style attribute or a <style> element is an inline style that the
 * host page's style-src checks, refuses where the page lists hashes, and reports to its endpoint with the style's first
 * characters; Chromium checks a style attribute as it parses it, in the view's inert template too. So:
 *   - the parser is never given one to make: styleMarkup renames them before the parse, and the parse of the encoded markup
 *     holds no attribute and no element named style, whatever the markup (a property over the tokenizer's contexts), while
 *     it is the parse of the markup in every other respect (a property, where no table or noframes is involved);
 *   - the renderer reads them by their new names and writes no style attribute and keeps no <style> element: a style
 *     attribute's text becomes the element's declaration, a <style> a `noframes` whose text the view applies as a
 *     constructed stylesheet;
 *   - the view parses nothing else, and its code writes no guest text as an inline style (a source scan).
 * What the browsers do with it, on a host page whose style-src lists hashes alone, is test/e2e/sealed-host-policy.spec.ts.
 */

const SVG = 'http://www.w3.org/2000/svg';
const KEEP_ALL: RenderSwitches = { animations: true, autoplay: true, stylesheets: true };

/** Every element of a parse (template contents included), with its attributes. */
function* elementsOf(root: ParentNode): Generator<Element> {
    for (const element of root.querySelectorAll('*')) {
        yield element;
        if (element instanceof HTMLTemplateElement) yield* elementsOf(element.content);
    }
}

/** What of a parse is named style: an element, or an attribute of one, in any namespace. */
function stylesIn(fragment: DocumentFragment): string[] {
    const found: string[] = [];
    for (const element of elementsOf(fragment)) {
        if (element.localName === 'style') found.push(`element ${element.namespaceURI}`);
        for (const attribute of element.attributes) if (attribute.localName === 'style') found.push(`attribute on ${element.localName}`);
    }
    return found;
}

const parse = (html: string) => {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
};

/** A parse as data: elements (namespace, name, attributes in order, children), texts and comments. */
type Tree = (string | Tree)[];
const treeOf = (node: Node, name: (element: Element) => string = element => element.localName, attributes: (element: Element) => [string, string][] = element => [...element.attributes].map(a => [a.name, a.value]), text: (data: string) => string = data => data): Tree => {
    if (node.nodeType !== 1) return [String(node.nodeType), text((node as CharacterData).data ?? '')];
    const element = node as Element;
    const children = element instanceof HTMLTemplateElement ? element.content.childNodes : element.childNodes;
    return [String(element.namespaceURI), name(element), ...attributes(element).map(pair => pair.join('=')), [...children].map(child => treeOf(child, name, attributes, text))];
};

/**
 * The attributes a renderer could keep: a name of letters, digits and `-`, `_`, `.`, `:` (every name of RENDER_ATTRIBUTES,
 * data-* and aria-*). The tokenizer makes others out of stray bytes (`<p <style>` has an attribute `<style`), which the
 * renderer never keeps; on those the encoding's renames show, so neither parse of a property compares them.
 */
const keepable = (attributes: [string, string][]) => attributes.filter(([name]) => /^[a-z][a-z0-9:_.-]*$/i.test(name));

/**
 * The parse of encoded markup read back as the parse of the markup: a renamed <style> (a name that ends in `noframes`, with
 * the start marker first) is a style, the style attribute's own name is style, the markers go, and every name, value and
 * text loses its insertions.
 */
function readBack(fragment: DocumentFragment, markup: StyleMarkup): Tree[] {
    const markers = [markup.sheet, `${markup.nonce}estyle`];
    const name = (element: Element) => {
        const first = element.attributes[0];
        if (element.localName.endsWith('noframes') && first?.name === markup.sheet) return `${markup.decode(element.localName.slice(0, -'noframes'.length))}style`;
        return markup.decode(element.localName);
    };
    const attributes = (element: Element) => {
        const out: [string, string][] = [];
        for (const attribute of element.attributes) {
            if (markers.includes(attribute.name)) continue;
            const pair: [string, string] = [attribute.name === markup.attribute ? 'style' : markup.decode(attribute.name), markup.decode(attribute.value)];
            if (!out.some(([n]) => n === pair[0])) out.push(pair); // a duplicate is dropped, the first kept, as the tokenizer does
        }
        return keepable(out);
    };
    return [...fragment.childNodes].map(node => treeOf(node, name, attributes, markup.decode));
}

/** The parse of the markup as written, to compare with readBack: the attributes a renderer could keep. */
function writtenTree(html: string): Tree[] {
    const attributes = (element: Element) => keepable([...element.attributes].map(a => [a.name, a.value]));
    return [...parse(html).childNodes].map(node => treeOf(node, undefined, attributes));
}

/**
 * Whether a `<` ended a tag or attribute name of the parse (`<p </style>`: an attribute `<`): the one context where an end
 * tag `</style` reads as an attribute named style, which the encoding turns into an attribute named `noframes`. No
 * renderer keeps either.
 */
const strayLessThan = (fragment: DocumentFragment) => [...elementsOf(fragment)].some(element => element.localName.endsWith('<') || [...element.attributes].some(attribute => attribute.name.endsWith('<')));

/**
 * A `<style` or `</style` followed by white space and `=`: after a stray `<` in a tag, the marker's value ends the name, so
 * the `=` starts an attribute instead of giving a value, and a quote after it can move the tag's end (style-markup.ts). An
 * end tag's attributes are dropped by the parse, so there the stray `<` leaves no trace strayLessThan could see: the
 * markup is excluded by its text, the tag contexts it holds too, which the cases below take one by one.
 */
const styleTagThenEquals = (html: string) => /<\/?style[\t\n\f\r ]+=/i.test(html);

/** Markup made of the pieces the tokenizer's contexts turn on, around `style` and `noframes` in every case. */
const PIECES = [
    '<', '</', '>', '/', '=', '"', "'", ' ', '\t', '\n', '\r', '\f', '\0', 'a', 'x y', '&lt;', '&amp;', '<!--', '-->', '<!', '<?', '<![CDATA[', ']]>',
    'style', 'STYLE', 'StYlE', 'style=', ' style ', '<style>', '</style>', '<style ', '</style ', '<style/', '</style/', 'style="', "style='",
    '<p', '<p ', '<p>', '</p>', '<b>', '<i ', '<svg>', '</svg>', '<math>', '<mi>', '<desc>', '<foreignObject>', '<textarea>', '</textarea>', '<title>',
    '<script>', '</script>', '<xmp>', '<iframe>', '<noembed>', '<template>', '</template>', '<select>', '<option>', '<plaintext>', 'title=', 'id=s ',
];
const TABLES = ['<table>', '</table>', '<tr>', '<td>', '<caption>', '<colgroup>', '<tbody>'];
const NOFRAMES = ['noframes', '<noframes>', '</noframes>', 'NoFrames ', '<noframes '];
const markupOf = (pieces: readonly string[]) => fc.array(fc.constantFrom(...pieces), { maxLength: 48 }).map(parts => parts.join(''));

let nonces = 0;
const markupFor = () => styleMarkup(`wfuzz${(nonces++).toString(36).padStart(4, '0')}`);

describe('styleMarkup: the parse of the encoded markup has no style attribute and no <style> element', () => {
    it('in every context the tokenizer reads a name in: a tag, after a quoted value, after a slash, a stray end tag inside a tag', () => {
        const cases = [
            '<p style="color:red">', '<p\tSTYLE=x>', '<p/style=x>', '<p a="b"style=x>', "<p a='b'style>", '<p a=b style>', '<p style>', '<p\r\nstyle=x>',
            '<p </style>', '<p</style>', '<p a</style>', '<p </style =x>', '<p </style=x>', '<style>a{}</style>', '<STYLE media=print>b</STYLE>',
            '<style/>c</style>', '<svg><style>d</style><rect style="fill:red"/></svg>', '<math><mi style="x">m</mi><style>e</style></math>',
            '<table><style>f</style><tr style="x"><td style="y">g</td></tr></table>', '<template><p style="h"></p><style>i</style></template>',
            '<noframes>a</noframes><p style=x>', '<style>a</style><p style=x>', '<textarea></style></textarea><p style=x>',
        ];
        for (const html of cases) {
            expect(stylesIn(parse(html)).length, `the markup itself has one: ${html}`).toBeGreaterThan(0);
            const markup = markupFor();
            expect(stylesIn(parse(markup.encode(html))), html).toEqual([]);
        }
    });

    // Every member of every set the tokenizer's states read, in each context it ends or starts a name in, as a table: a
    // character that dropped out of a set would leave a real style attribute or element for the view's parser (BD7:TST-1).
    it('for every character of every tokenizer set, in the tag-name, attribute-name and end-tag contexts: no style attribute, no <style> element', () => {
        const contexts = (ch: string) => [
            `<p${ch}style="color:red">`, `<p a="b"${ch}style=x>`, `<p${ch}${ch}STYLE>`, `<p ${ch}style>`, `<p a=b${ch}style>`, `<p style${ch}x>`, `<p style${ch}=x>`,
            `<style${ch}>a{}</style>`, `<style${ch}media=print>a{}</style>`, `<STYLE${ch}>a{}</STYLE>`, `<noframes${ch}>x</noframes>`,
            `<svg><style${ch}>a{}</style></svg>`, `<p </style${ch}>`, `<p </style${ch}=x>`, `<p a</style${ch}>`, `</style${ch}><p style=x>`, `<p </noframes${ch}>`,
        ];
        // the HTML tokenizer's own sets (whatwg.org/multipage/parsing.html), written out here and not read from the code
        const WHITE_SPACE = '\t\n\f\r ';
        const spec = { WHITE_SPACE, TAG_NAME_END: WHITE_SPACE + '/>', ATTRIBUTE_NAME_END: WHITE_SPACE + '/>=', ATTRIBUTE_NAME_START: WHITE_SPACE + '/"\'' };
        const sorted = (set: string) => [...set].sort().join('');
        let cases = 0;
        for (const [name, set] of Object.entries(spec)) {
            expect(sorted(markupFor().sets[name as keyof typeof spec]), name).toBe(sorted(set));
            for (const ch of set) {
                for (const html of contexts(ch)) {
                    cases++;
                    expect(stylesIn(parse(markupFor().encode(html))), `${name} ${JSON.stringify(ch)}: ${JSON.stringify(html)}`).toEqual([]);
                }
            }
        }
        expect(cases).toBeGreaterThan(300);
    });

    it('whatever the markup: a property over the pieces every context turns on (tables, noframes and stray bytes included)', () => {
        fc.assert(fc.property(markupOf([...PIECES, ...TABLES, ...NOFRAMES]), (html) => {
            expect(stylesIn(parse(markupFor().encode(html))), html).toEqual([]);
        }), { numRuns: 3000, seed: 74074 });
    });

    it('and is the parse of the markup in every other respect, read back: names, values, texts and the tree (no table, no noframes)', () => {
        fc.assert(fc.property(markupOf(PIECES), (html) => {
            fc.pre(!strayLessThan(parse(html)) && !styleTagThenEquals(html));
            const markup = markupFor();
            expect(readBack(parse(markup.encode(html)), markup), html).toEqual(writtenTree(html));
        }), { numRuns: 3000 });
    });

    it('where the tree differs: a style in a table is moved out before it, the guest\'s own noframes is an element of another name, an end tag inside a tag an attribute of another name, and a value after a stray `<style` a name', () => {
        const markup = markupFor();
        expect(readBack(parse(markup.encode('<table><style>a</style></table>')), markup).map(node => node[1])).toEqual(['style', 'table']);
        expect([...parse(markup.encode('<noframes>x</noframes>')).children].map(element => element.localName)).toEqual([markup.noframes]);
        expect(parse(markup.encode('<p </style>')).firstElementChild!.getAttributeNames()).toEqual(['<', 'noframes', `${markup.nonce}estyle`]);
        const stray = "<p <style ='a>b' c>x";
        expect(writtenTree(stray)).toEqual([['http://www.w3.org/1999/xhtml', 'p', 'c=', [['3', 'x']]]]);
        expect(readBack(parse(markup.encode(stray)), markup)).toEqual([['http://www.w3.org/1999/xhtml', 'p', [['3', "b' c>x"]]]]); // the tag ends at the quoted `>`
        for (const html of ["<style ='a>b' c>x</style>y", "<p>x</style ='a>b' c>y", "<style\t=x>a</style>b"]) {
            expect(readBack(parse(markup.encode(html)), markup), `a tag of its own reads as written: ${html}`).toEqual(writtenTree(html));
        }
    });

    it('nothing is changed where no name can be made: the end of the input, other words, other letters around', () => {
        const markup = markupFor();
        for (const html of ['<p style', '<style', '</style', 'styles', 'a style', '<p data-style=x>', '<p xstyle=x>', '<p stylex=x>', '<styles>', '<p>style</p>', '&style;']) {
            expect(markup.encode(html), html).toBe(html);
        }
    });

    it('refuses a nonce that is not lowercase letters and digits starting with a letter, and markup that holds the nonce', () => {
        for (const nonce of ['', 'short', '1abcdefgh', 'Wabcdefgh', 'wabc-defgh']) expect(() => styleMarkup(nonce), nonce).toThrow(TypeError);
        const markup = styleMarkup('wholdsnonce');
        expect(() => markup.encode('<p title="WHOLDSNONCE">')).toThrow(RangeError);
    });
});

describe('the renderer: a style attribute becomes a declaration, a <style> a noframes the view applies; neither is written as an inline style', () => {
    afterEach(() => vi.restoreAllMocks());

    /**
     * Renders `html` as the view does (or, with `encoded` false, parsed as it is, as a caller that only cleans markup would),
     * recording every attribute the renderer writes by name.
     */
    function render(html: string, switches: RenderSwitches = KEEP_ALL, encoded = true) {
        const { template, markup } = encoded ? parseAsView(html) : parseAsIs(html);
        const written: string[] = [];
        const record = (name: unknown) => { written.push(String(name).toLowerCase()); };
        const setAttribute = Element.prototype.setAttribute, setAttributeNS = Element.prototype.setAttributeNS;
        vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name, value) { record(name); return setAttribute.call(this, name, value); });
        vi.spyOn(Element.prototype, 'setAttributeNS').mockImplementation(function (this: Element, namespace, name, value) { record(String(name).split(':').pop()); return setAttributeNS.call(this, namespace, name, value); });
        const context: RenderContext = { target: 'body', animating: RENDER_RULES.still.known, origins: {}, refused: [], urls: 0, loads: [], css: [], sheets: [], markup };
        sanitizeRender(template.content, () => null, () => false, dropNetworkCss, RENDER_RULES, switches, undefined, context);
        vi.restoreAllMocks();
        return { fragment: template.content, context, written };
    }

    it('a style attribute of every namespace: its text is the declaration\'s, and no attribute named style is written', () => {
        const { fragment, context, written } = render('<p id="h" style="color: red">x</p><svg><rect id="s" style="fill: blue"/></svg><math><mi id="m" style="color: green">m</mi></math>');
        expect(written).not.toContain('style');
        expect(context.css).toEqual(['color: red', 'fill: blue', 'color: green']);
        expect(fragment.getElementById('h')!.getAttribute('style')).toBe(declared('color: red'));
        expect(stylesIn(fragment).filter(found => found.startsWith('element'))).toEqual([]);
    });

    it('a <style> of HTML and SVG: a noframes holding its text as written, its media and an SVG type, listed in document order; no <style> element', () => {
        const { fragment, context, written } = render('<style media="print" title="t">a { b: c }</style><p>x</p><svg><style type="text/css">d { fill: red }<g/>e</style></svg><math><style>f</style></math>');
        expect(written).not.toContain('style');
        expect(context.sheets!.map(sheet => [sheet.namespaceURI, sheet.localName, sheet.getAttributeNames().sort().join(' '), sheet.textContent])).toEqual([
            ['http://www.w3.org/1999/xhtml', 'noframes', 'media title', 'a { b: c }'],
            [SVG, 'noframes', 'type', 'd { fill: red }e'],
        ]);
        expect(stylesIn(fragment)).toEqual([]);
        expect(fragment.querySelectorAll('noframes').length).toBe(2); // the MathML one goes, as a <style> there always did
    });

    it('every text and value the guest wrote is read and kept as written: the insertions never show, nor change what a rule decides', () => {
        const html = '<p title="a style b" data-x=\'</style>\' id=s>my style is </style> &lt;style></p><textarea>x</style> y</textarea><img alt="style" src=" style.png">';
        const { fragment } = render(html);
        expect(fragment.querySelector('p')!.getAttribute('title')).toBe('a style b');
        expect(fragment.querySelector('p')!.getAttribute('data-x')).toBe('</style>');
        expect(fragment.querySelector('p')!.textContent).toBe('my style is  <style>'); // a stray end tag is no text
        expect(fragment.querySelector('textarea')!.textContent).toBe('x</style> y');
        expect(fragment.querySelector('img')!.getAttribute('alt')).toBe('style');
        expect(fragment.textContent).not.toMatch(/wunittest/);
    });

    it('the guest\'s own noframes goes with its content, and a <style> element in markup the view did not encode goes too', () => {
        expect(render('<noframes><p id="in">x</p></noframes><p id="out">y</p>').fragment.querySelector('#in')).toBeNull();
        const template = parse('<style>a{}</style><p style="color: red">z</p>');
        const context: RenderContext = { target: 'body', animating: [], origins: {}, refused: [], urls: 0, loads: [], css: [], sheets: [] };
        sanitizeRender(template, () => null, () => false, dropNetworkCss, RENDER_RULES, KEEP_ALL, undefined, context);
        expect([context.sheets, context.css]).toEqual([[], ['color: red']]);
        expect(stylesIn(template).filter(found => found.startsWith('element'))).toEqual([]);
    });

    it('whatever the markup, encoded or parsed as it is, the renderer writes no attribute named style and keeps no <style> element', () => {
        const pieces = [...PIECES, ...TABLES, ...NOFRAMES, 'animation: x 1s', 'url(https://x.example/y.png)', ' style="color: red; animation: x 1s" '];
        fc.assert(fc.property(markupOf(pieces), fc.boolean(), (html, encoded) => {
            const { fragment, written } = render(html, { animations: false, autoplay: false, stylesheets: true }, encoded);
            expect(written, html).not.toContain('style');
            expect(stylesIn(fragment).filter(found => found.startsWith('element')), html).toEqual([]);
        }), { numRuns: 1500 });
    });
});

describe('the view: its parser is given encoded markup only', () => {
    const saved: Record<string, unknown> = {};
    afterEach(() => {
        (globalThis as any).Worker = saved.Worker;
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
        vi.restoreAllMocks();
    });

    it('every string the view parses holds no style attribute and no <style> element, for every render (a template\'s innerHTML is its only parse)', async () => {
        saved.Worker = (globalThis as any).Worker;
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            transfer: MessagePort[] = [];
            constructor() { workers.push(this as any); }
            postMessage(_message: unknown, transfer: MessagePort[]) { this.transfer = transfer; }
        };
        const parsed: string[] = [];
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
        vi.spyOn(Element.prototype, 'innerHTML', 'set').mockImplementation(function (this: Element, value: string) {
            parsed.push(String(value));
            descriptor.set!.call(this, value);
        });
        const options: ViewOptions = { ...VIEW_OPTIONS, rates: { characters: 1e9, time: 1e9, urls: 1e9 } };
        new Function(`(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${viewBudget.toString()}, ${cssLoadBound.toString()}, ${cssReferences.toString()}, ${withoutNetworkReferences.toString()}, ${JSON.stringify(options)}, ${viewInputOutbox.toString()}, ${isStyleProperty.toString()}, ${styleMarkup.toString()});`)();
        const logic = new MessageChannel(), view = new MessageChannel();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '<p id="a" style="color: red">a</p><style id="s">p { color: blue }</style>', allowAnimations: true }, source: window, ports: [logic.port1, view.port1] }));
        const render = workers[0]!.transfer[1]!;
        let acks = 0;
        render.onmessage = (event) => { if (event.data?.type === 'VIEW_ACK') acks++; };
        render.postMessage({ type: 'VIEW_STARTED' });
        const send = async (message: Record<string, unknown>) => {
            const before = acks;
            render.postMessage(message);
            for (let i = 0; i < 400 && acks === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
        };
        await send({ type: 'VIEW_RENDER', html: '<svg><style>rect { fill: red }</style><rect style="fill: blue"/></svg><p </style>', into: 'a' });
        await send({ type: 'VIEW_RENDER', html: 'p { color: green } <b style="x">', into: 's' });
        await send({ type: 'VIEW_RENDER', html: '<p title="no style here">x</p>', into: null });
        const renders = parsed.filter(text => text !== '');
        expect(renders.length).toBeGreaterThanOrEqual(4); // the first render, and the three after it
        for (const text of renders) expect(stylesIn(parse(text)), text).toEqual([]);
        expect(document.querySelectorAll('style').length).toBe(0);
        expect(document.body.querySelector('p')!.getAttribute('title')).toBe('no style here');
        render.close(); view.port2.close(); logic.port2.close();
    });
});

describe('the source scan: the view\'s code names `style` only to read, compare, count or remove, and makes one <style>, the still stylesheet', () => {
    /**
     * The forms the view's own code may name `style` in: a comparison or a decided name, the declaration's getter, a read, a
     * removal, the bookkeeping of a change (settle, valueAttributeLength) and the still stylesheet's own element. Any other use,
     * a write of an attribute named style or a <style> made from guest text, fails here.
     */
    const ALLOWED: [form: string, before: RegExp][] = [
        ['a comparison', /[!=]==\s*$/],
        ['a decided name', /\?\s*$/],
        ['the declaration\'s getter', /(getOwnPropertyDescriptor|getter)\(\s*[\w.]+,\s*$/],
        ['a read', /\(\s*E\.getAttribute,\s*\w+,\s*\[\s*$/],
        ['a removal', /(\(\s*E\.removeAttribute,\s*\w+,\s*\[|\bdrop\(\s*\w+,)\s*$/],
        ['the bookkeeping of a change', /\b(settle\(\s*\w+,|valueAttributeLength\([^;]*,)\s*$/],
        ['the still stylesheet', /const sheet = call\(\s*D\.createElement,\s*document,\s*\[\s*$/],
    ];
    const occurrences = (source: string) => [...source.matchAll(/(["'`])style\1/g)].map(match => source.slice(Math.max(0, match.index! - 120), match.index!));

    it('every literal `style` in the renderer and the view is one of the allowed forms; the still stylesheet is the one <style> made', () => {
        for (const fn of [sanitizeRender, inSandboxView]) {
            const found = occurrences(fn.toString());
            expect(found.length, fn.name).toBeGreaterThan(3); // the scan sees them (positive control)
            for (const before of found) expect(ALLOWED.some(([, form]) => form.test(before)), `${fn.name}: …${before.slice(-80)}'style'`).toBe(true);
        }
        expect(occurrences(inSandboxView.toString()).filter(before => ALLOWED[6]![1].test(before)).length).toBe(1);
        expect(occurrences(sanitizeRender.toString()).filter(before => ALLOWED[6]![1].test(before)).length).toBe(0);
    });

    it('positive control: each form a write would take is refused', () => {
        for (const write of ["call(E.setAttribute, element, ['style'", "set(element, 'style'", "call(E.setAttributeNS, element, [null, 'style'", "call(D.createElement, document, ['style'", "createElementNS(SVG, 'style'"]) {
            const before = write.slice(0, write.lastIndexOf("'style'"));
            expect(ALLOWED.some(([, form]) => form.test(before)), write).toBe(false);
        }
    });

    it('the renderer writes a style through the declaration\'s cssText setter only, and the view parses through the template, given the encoded input', () => {
        expect(sanitizeRender.toString()).toMatch(/call\(\s*setCssText,\s*style,\s*\[\s*css\s*\]\s*\)/);
        const view = inSandboxView.toString();
        expect(view.match(/\.innerHTML\s*=/g)?.length).toBe(2); // the render's template and the Trusted Types probe's empty string
        expect(view).toMatch(/template\.innerHTML\s*=\s*value[\s\S]{0,80}input\.text/);
        expect(view).toMatch(/probe\.innerHTML\s*=\s*["']{2}/);
    });
});
