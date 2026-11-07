/**
 * Guest markup the view's parser reads with no `style` attribute and no `<style>` element in it (S74, class A:
 * INHERITED_CONTEXT.cspReporting; BD6:ISO-2; docs/research/25_cssom_styles/README.md).
 *
 * Why. The view's document inherits the host page's policy list, and a `style` attribute or a `<style>` element is an
 * inline style: the page's `style-src` (and `style-src-attr`, `style-src-elem`) checks it, a page whose `style-src` has a
 * hash or a nonce refuses it, and the browser reports each refusal to the page's endpoint, with the style's first 40
 * characters where the policy has `'report-sample'`. Chromium checks a `style` attribute as it parses it, also into an
 * inert template, a DOMParser document or a document of `document.implementation`; an empty `<style>`, and one whose
 * `type` is not CSS, are checked once connected (research 25). What no `style-src` governs on any engine is the CSSOM: an
 * element's declaration (`cssText`, `setProperty`) and a constructed stylesheet (`replaceSync`, adopted). So the view
 * applies the guest's styles through those (inSandboxView), and its parser is never given a `style` attribute or a
 * `<style>` element to make: `encode` renames them before the parse, and the renderer reads them by their new names
 * (sanitizeRender).
 *
 * How, by the HTML tokenizer (HTML, "Tokenization"), which decides these names before anything else does:
 *   - an attribute is named `style` only when its name starts right after a tab, a line feed, a form feed, a carriage
 *     return (read as a line feed), a space, `/`, `"` or `'`, and ends right before one of those white space characters,
 *     `/`, `>` or `=`, with the five letters (in any case) between. `encode` puts `<nonce>a` in front of every such run of
 *     the five letters, wherever it is (in a tag, in text, in a value, in a comment): the attribute is then named
 *     `<nonce>astyle`;
 *   - an element is named `style` only from a start tag `<style` followed by white space, `/` or `>`. `encode` makes it
 *     `<noframes/<nonce>tstyle=v`, or `<noframes/<nonce>tstyle` before a `/`: a `noframes` element with a marker attribute.
 *     The `/` ends the tag name and sets no self-closing flag before a letter, and the marker ends as the tag name did: an
 *     unquoted value ends at white space and at `>` as a tag name does, and a name at `/` (so `<style =x>` still has an
 *     attribute `=x`, and no quote starts a value the tag name did not have). The parser treats `noframes` as it treats
 *     `style` (raw text in HTML content, ended by its own end tag; an ordinary element in SVG and MathML), but in a table,
 *     where it is moved out before the table (the table's own `<style>` would stay in it);
 *   - every end tag `</style` followed by white space, `/` or `>` becomes `</noframes/<nonce>estyle=v` (or `…estyle` before
 *     a `/`), the end tag of that raw text, its marker an attribute of the end tag, which the parser ignores: a style's text
 *     ends where it ended. Inside a tag, where `</style` would start an attribute named `style` (`<p </style>`: `<` is a
 *     name, `/` ends it), it starts one named `noframes`;
 *   - the guest's own `<noframes` and `</noframes` (followed by white space, `/` or `>`) become `<<nonce>nnoframes`: an
 *     unknown element, removed by the renderer as a `noframes` is (RENDER_REMOVED_ELEMENTS), whose content is parsed as
 *     markup and not as raw text; and no guest end tag can end a renamed style early.
 * At the end of the input nothing is changed: a tag or an attribute name the input ends in is never made. So the parse
 * of the encoded markup has no attribute and no element named `style` in any namespace, whatever the context. Every
 * insertion is letters and digits, `noframes/` and `=v`: no white space or quote, so an attribute value that holds one
 * keeps all of it, and nothing that ends a comment, a raw text or a character reference.
 *
 * The nonce is drawn per parse by the view, lowercase letters and digits that start with a letter, and must not appear
 * in the markup in any case (`encode` throws if it does): every inserted text holds it, so `decode` removes exactly what
 * `encode` inserted from a text or an attribute value of the parse where an insertion landed outside a tag.
 *
 * Self-contained: it closes over nothing of this module, because the strict view runs it, stringified into its
 * bootstrap (realms.ts, STRINGIFIED). One linear pass each way.
 */

/** The encoding of one parse (styleMarkup): what it inserts, and the names the parse gives what it renamed. */
export interface StyleMarkup {
    /** The nonce every insertion holds. */
    readonly nonce: string;
    /** `html` with every insertion made; throws if `html` holds the nonce. */
    encode(html: string): string;
    /** A text or an attribute value of the parse without the insertions. */
    decode(text: string): string;
    /** The name the parse gives the guest's `style` attribute. */
    readonly attribute: string;
    /** The marker attribute of a `noframes` element that is the guest's `<style>`. */
    readonly sheet: string;
    /** The name the parse gives the guest's own `noframes` element. */
    readonly noframes: string;
}

/** The encoding for `nonce` (lowercase letters and digits, at least 8, starting with a letter). See the top of this file. */
export function styleMarkup(nonce: string): StyleMarkup {
    if (!/^[a-z][a-z0-9]{7,}$/.test(nonce)) throw new TypeError('styleMarkup: the nonce must be lowercase letters and digits, at least 8, starting with a letter');
    const WHITE_SPACE = '\t\n\f\r ';
    const TAG_NAME_END = WHITE_SPACE + '/>';
    const ATTRIBUTE_NAME_END = TAG_NAME_END + '=';
    const ATTRIBUTE_NAME_START = WHITE_SPACE + '/"\'';
    const RENAMED = /style|noframes/gi;
    const VALUE = '=v'; // the marker's value, where the tag name ended at white space or `>`
    const inserted = new RegExp('noframes/' + nonce + '[te]([sS][tT][yY][lL][eE])(?:' + VALUE + ')?|' + nonce + '[an]', 'g');
    const holdsNonce = new RegExp(nonce, 'i');
    const isIn = (set: string, character: string | undefined) => character !== undefined && character !== '' && set.indexOf(character) >= 0;

    const NONE: readonly [string, string] = ['', ''];
    // What goes in front of the match at `at` and after it (see the top of this file).
    const insertion = (html: string, at: number, length: number): readonly [before: string, after: string] => {
        const next = html[at + length];
        if (next === undefined) return NONE; // the input ends: no name ends there
        const previous = html[at - 1];
        const opensTag = previous === '<';
        const closesTag = previous === '/' && html[at - 2] === '<';
        const endsTagName = isIn(TAG_NAME_END, next);
        const value = next === '/' ? '' : VALUE;
        if (length === 8) return (opensTag || closesTag) && endsTagName ? [nonce + 'n', ''] : NONE;
        if (opensTag && endsTagName) return ['noframes/' + nonce + 't', value];
        if (closesTag && endsTagName) return ['noframes/' + nonce + 'e', value];
        return isIn(ATTRIBUTE_NAME_START, previous) && isIn(ATTRIBUTE_NAME_END, next) ? [nonce + 'a', ''] : NONE;
    };
    const encode = (html: string): string => {
        if (holdsNonce.test(html)) throw new RangeError('styleMarkup: the markup holds the nonce');
        const parts: string[] = [];
        let from = 0;
        RENAMED.lastIndex = 0;
        for (let match = RENAMED.exec(html); match !== null; match = RENAMED.exec(html)) {
            const [before, after] = insertion(html, match.index, match[0].length);
            if (before === '') continue;
            const end = match.index + match[0].length;
            parts.push(html.slice(from, match.index), before, html.slice(match.index, end), after);
            from = end;
        }
        parts.push(html.slice(from));
        return parts.join('');
    };
    const decode = (text: string): string => (text.indexOf(nonce) < 0 ? text : text.replace(inserted, '$1'));
    return { nonce, encode, decode, attribute: nonce + 'astyle', sheet: nonce + 'tstyle', noframes: nonce + 'nnoframes' };
}
