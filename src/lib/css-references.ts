/**
 * URL references in CSS (ADR-004). Nothing here is stringified into a realm guest code runs in: cssReferences runs on
 * the host and in the strict view, which runs no guest code.
 *
 * A registered stylesheet reaches the guest as a blob: URL, and a relative URL never resolves inside a
 * blob: stylesheet: its base URL is the blob URL, whose path is opaque, so `url(img.png)` and
 * `@import "b.css"` name nothing. The same holds for an inline `<style>` or `style=""` in guest markup,
 * whose base is the wrapper's about:blank (S15). So the host finds every URL reference in the CSS and
 * the guest replaces the ones that name a registered file with that file's blob: URL
 * (files.ts for stylesheets, markup-references.ts for inline styles).
 *
 * Finding them is a tokenizer's job, not a regular expression's: `url(` inside a comment or a string is
 * not a reference, `\75 rl(x)` is one, `10url(x)` is a dimension and `url(a b)` a bad URL. This file
 * follows the tokenizer of CSS Syntax Level 3 (https://drafts.csswg.org/css-syntax/#tokenization):
 * comments, strings with escapes and line continuations, ident sequences with escapes, numbers and
 * dimensions, hash and at-keyword tokens, CDO/CDC, url tokens and bad-url remnants. It never throws and
 * runs in one linear pass.
 *
 * A reference is:
 *   - a url token, `url(x.png)` (unquoted), anywhere except in an at-rule prelude other than @import's;
 *   - the string argument of a `url(` function, `url("x.png")`, under the same rule;
 *   - the string that is the first token of an @import prelude, `@import "x.css"`;
 *   - a string directly inside `image-set(` or `-webkit-image-set(`, `image-set("a.png" 1x)`.
 * So `@font-face { src: url(f.woff2) format("woff2"), local("F") }` yields only `f.woff2`, and
 * `@namespace svg url(http://www.w3.org/2000/svg)` (a name, never fetched), `@supports (…url(x)…)`
 * and `@media` preludes yield nothing. Other strings (`content: "x.png"`, `format()`, `local()`,
 * `type()` inside image-set, attribute selectors) are not URLs and are never references.
 *
 * Only closed tokens count: a string or url token cut off by the end of the input, a bad string (a raw
 * newline) and a bad url are left alone, so a rewrite can only ever replace a complete token with
 * another complete token. Malformed nesting (a stray closing bracket) is recovered from the way a
 * browser recovers at the end of a rule; where engines differ, the difference can only decide whether
 * a string in a broken `image-set()` names one of the guest's own files.
 *
 * Each reference carries the range to replace (UTF-16 offsets) and its decoded value. The replacement is
 * always a CSS string, `"<url>"`: for a url token the range is everything between `url(` and `)`, so
 * `url( a.png )` becomes `url("blob:…")`; for a string it is the string token, quotes included.
 *
 * And the kind of load it makes (load-kinds.ts; FR:W1), which decides the types of file it
 * may name: 'style' for the first token of an @import prelude, 'font' for a url() inside an @font-face block (at
 * any depth: @font-face may sit in @media or @supports), 'image' for every other url() and image-set() string
 * (backgrounds, list and border images, cursors, masks, content).
 */

export interface CssReference {
    start: number; // [start, end): the range a CSS string replaces
    end: number;
    url: string; // the value, escapes decoded
    kind: 'style' | 'font' | 'image';
    // the property of the declaration it is in, ASCII lower case; '' where it is in none the tokenizer can name (an
    // @import, a selector, the start of a block, anything after a closing bracket that matched nothing): what decides
    // whether a fragment-only URL loads (keepsUrl)
    property: string;
    // `loads` scope: a string in no position where CSS reads a string as a URL (a `content`, a font family name, an area
    // of a grid template, a custom property's value), which the browser reads as text unless var() carries it into one
    text: boolean;
}

// The tokens: a type only, so nothing of it is left in the function below, which must close over nothing of this module.
type Token =
    | { type: 'whitespace' }
    | { type: 'string'; start: number; end: number; value: string; closed: boolean }
    | { type: 'bad' } // bad-string or bad-url: never a reference
    | { type: 'url'; start: number; end: number; value: string; closed: boolean }
    | { type: 'function'; name: string }
    | { type: 'ident'; name: string } // as written, escapes decoded
    | { type: 'colon' }
    | { type: 'at-keyword'; name: string }
    | { type: 'open'; closer: ')' | ']' | '}' }
    | { type: 'close'; char: ')' | ']' | '}' }
    | { type: 'semicolon' }
    | { type: 'other' }; // hash, number, dimension, percentage, delim, comma, CDO, CDC

/**
 * Every URL reference in `source` (a stylesheet, the text of a `<style>`, or the declarations of a `style` attribute), in
 * source order, whatever it names. See the top of this file for what counts in `files` scope; `loads` scope counts more:
 *   - files  the references that can name a registered file, to be rewritten: only closed tokens (cssUrlReferences);
 *   - loads  every token that can make the browser load a URL, whatever it names, for the view to keep only what
 *            keepsUrl allows (withKeptReferences; BD7:ISO-1): a url token or a string anywhere outside the prelude of an
 *            at-rule other than @import's (a string in a custom property can reach `image-set()` through var(), and
 *            `src()` and `image()` take strings), and a token cut off by the end of the input too (the tokenizer returns
 *            it, and the browser loads it). It errs only toward finding more: a string such as `content: "x"` is one.
 * A string is a URL where CSS reads one as a URL: the argument of `url(`, the first token of an @import prelude, and a
 * string directly inside `image-set()`, `-webkit-image-set()`, `src()` or `image()`; every other string is `text`, which
 * the browser reads as a URL only where var() carries it into one of those (keepsUrl keeps such a string unless it
 * resolves to a URL). So whatever the engine makes of malformed nesting, a string that one reads in a URL position is a
 * reference here, of one kind or the other.
 * `property` is the property `source` is the value of (a `set({ css })` value, an SVG presentation attribute), or `''`
 * for a stylesheet or a declaration list. Each reference carries the property of the declaration it is in, read as the
 * browser reads a declaration: its first token, where a block starts or after a `;` of that block, is an identifier, and
 * the next one a `:`. A `{` always starts a block of its own declarations, so a nested rule's selector (`a:hover { … }`)
 * is never taken for the property of what is inside its block. After a closing bracket that matches nothing open (where
 * engines may disagree on what is nested in what), no reference has a property.
 *
 * Self-contained: it closes over nothing of this module, and uses no syntax the build compiles into module-scope
 * helpers, because the strict view runs it too, stringified into its bootstrap (realms.ts, STRINGIFIED). Never throws,
 * one linear pass.
 */
export function cssReferences(source: string, scope: 'files' | 'loads', property = ''): CssReference[] {
    // Character classes by UTF-16 code unit. At the end of the input a code is NaN, which is in no class.
    const isNewline = (c: number) => c === 0x0a || c === 0x0d || c === 0x0c;
    const isWhitespace = (c: number) => c === 0x20 || c === 0x09 || isNewline(c);
    const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
    const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
    // NUL counts as U+FFFD, which the input preprocessing turns it into: a non-ASCII ident code point.
    const isIdentStart = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c === 0 || c >= 0x80;
    const isIdentChar = (c: number) => isIdentStart(c) || isDigit(c) || c === 0x2d;
    const isNonPrintable = (c: number) => (c >= 0x01 && c <= 0x08) || c === 0x0b || (c >= 0x0e && c <= 0x1f) || c === 0x7f;
    const isQuote = (c: number) => c === 0x22 || c === 0x27;
    const asciiLower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());

    const REPLACEMENT = '\uFFFD';
    const BACKSLASH = 0x5c;

    const WHITESPACE: Token = { type: 'whitespace' };
    const BAD: Token = { type: 'bad' };
    const OTHER: Token = { type: 'other' };
    const SEMICOLON: Token = { type: 'semicolon' };
    const COLON: Token = { type: 'colon' };

    // A tokenizer over `source`, one token per call; null at the end. Comments are skipped.
    const tokenizer = () => {
        const n = source.length;
        const at = (index: number) => source.charCodeAt(index); // NaN past the end
        // A leading byte order mark is not part of the stylesheet (the decoder strips it).
        let i = at(0) === 0xfeff ? 1 : 0;

        const validEscape = (index: number) => at(index) === BACKSLASH && !isNewline(at(index + 1));
        const startsIdent = (index: number) => {
            const c = at(index);
            if (c === 0x2d) return isIdentStart(at(index + 1)) || at(index + 1) === 0x2d || validEscape(index + 1);
            if (c === BACKSLASH) return validEscape(index);
            return isIdentStart(c);
        };
        const startsNumber = (index: number) => {
            const c = at(index);
            if (c === 0x2b || c === 0x2d) return isDigit(at(index + 1)) || (at(index + 1) === 0x2e && isDigit(at(index + 2)));
            if (c === 0x2e) return isDigit(at(index + 1));
            return isDigit(c);
        };

        // After a backslash that is a valid escape (`i` is past the backslash): the escaped code point.
        const consumeEscape = (): string => {
            if (i >= n) return REPLACEMENT;
            if (isHex(at(i))) {
                const from = i;
                while (i - from < 6 && isHex(at(i))) i++;
                const code = parseInt(source.slice(from, i), 16);
                if (at(i) === 0x0d && at(i + 1) === 0x0a) i += 2;
                else if (isWhitespace(at(i))) i++;
                return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? REPLACEMENT : String.fromCodePoint(code);
            }
            const char = String.fromCodePoint(source.codePointAt(i)!);
            i += char.length;
            return char === '\u0000' ? REPLACEMENT : char;
        };

        // Runs of plain characters are sliced, not built one character at a time.
        const consumeIdentSequence = (): string => {
            let value = '';
            let run = i;
            for (;;) {
                const c = at(i);
                if (isIdentChar(c)) {
                    if (c === 0) { value += source.slice(run, i) + REPLACEMENT; run = i + 1; }
                    i++;
                } else if (validEscape(i)) {
                    value += source.slice(run, i);
                    i++;
                    value += consumeEscape();
                    run = i;
                } else {
                    return value + source.slice(run, i);
                }
            }
        };

        const consumeString = (quote: number): Token => {
            const start = i;
            i++; // the opening quote
            let value = '';
            let run = i;
            for (;;) {
                if (i >= n) return { type: 'string', start, end: i, value: value + source.slice(run, i), closed: false };
                const c = at(i);
                if (c === quote) {
                    value += source.slice(run, i);
                    i++;
                    return { type: 'string', start, end: i, value, closed: true };
                }
                if (isNewline(c)) return BAD; // a bad string; the newline is the next token
                if (c === BACKSLASH) {
                    value += source.slice(run, i);
                    if (i + 1 >= n) i++; // a backslash at the end: nothing
                    else if (isNewline(at(i + 1))) i += at(i + 1) === 0x0d && at(i + 2) === 0x0a ? 3 : 2; // a line continuation
                    else { i++; value += consumeEscape(); }
                    run = i;
                    continue;
                }
                if (c === 0) { value += source.slice(run, i) + REPLACEMENT; run = i + 1; }
                i++;
            }
        };

        // The rest of a bad url: up to and including ")", or the end; escapes are skipped whole.
        const consumeBadUrlRemnants = (): Token => {
            while (i < n) {
                if (at(i) === 0x29) { i++; break; }
                if (validEscape(i)) { i++; consumeEscape(); } else i++;
            }
            return BAD;
        };

        // An unquoted url token; `start` is just past "url(". Its range is everything from there up to ")".
        const consumeUrl = (start: number): Token => {
            while (isWhitespace(at(i))) i++;
            let value = '';
            let run = i;
            for (;;) {
                if (i >= n) return { type: 'url', start, end: i, value: value + source.slice(run, i), closed: false };
                const c = at(i);
                if (c === 0x29) {
                    value += source.slice(run, i);
                    i++;
                    return { type: 'url', start, end: i - 1, value, closed: true };
                }
                if (isWhitespace(c)) {
                    value += source.slice(run, i);
                    while (isWhitespace(at(i))) i++;
                    if (i >= n) return { type: 'url', start, end: i, value, closed: false };
                    if (at(i) === 0x29) {
                        i++;
                        return { type: 'url', start, end: i - 1, value, closed: true };
                    }
                    return consumeBadUrlRemnants();
                }
                if (isQuote(c) || c === 0x28 || isNonPrintable(c)) return consumeBadUrlRemnants();
                if (c === BACKSLASH) {
                    if (!validEscape(i)) return consumeBadUrlRemnants();
                    value += source.slice(run, i);
                    i++;
                    value += consumeEscape();
                    run = i;
                    continue;
                }
                if (c === 0) { value += source.slice(run, i) + REPLACEMENT; run = i + 1; }
                i++;
            }
        };

        const consumeIdentLike = (): Token => {
            const name = consumeIdentSequence();
            if (at(i) !== 0x28) return { type: 'ident', name };
            i++;
            if (name.length === 3 && asciiLower(name) === 'url') {
                const start = i;
                while (isWhitespace(at(i)) && isWhitespace(at(i + 1))) i++;
                const c = at(i);
                const quoted = isQuote(c) || (isWhitespace(c) && isQuote(at(i + 1)));
                return quoted ? { type: 'function', name: 'url' } : consumeUrl(start);
            }
            return { type: 'function', name: asciiLower(name) };
        };

        const consumeNumeric = (): Token => {
            if (at(i) === 0x2b || at(i) === 0x2d) i++;
            while (isDigit(at(i))) i++;
            if (at(i) === 0x2e && isDigit(at(i + 1))) {
                i++;
                while (isDigit(at(i))) i++;
            }
            if ((at(i) === 0x65 || at(i) === 0x45)
                && (isDigit(at(i + 1)) || ((at(i + 1) === 0x2b || at(i + 1) === 0x2d) && isDigit(at(i + 2))))) {
                i += 2;
                while (isDigit(at(i))) i++;
            }
            if (startsIdent(i)) consumeIdentSequence(); // a dimension: `10url(` is not a url
            else if (at(i) === 0x25) i++;
            return OTHER;
        };

        return (): Token | null => {
            for (;;) {
                if (i >= n) return null;
                const c = at(i);
                if (c === 0x2f && at(i + 1) === 0x2a) { // "/*"
                    const close = source.indexOf('*/', i + 2);
                    i = close === -1 ? n : close + 2; // an unclosed comment runs to the end
                    continue;
                }
                if (isWhitespace(c)) {
                    while (isWhitespace(at(i))) i++;
                    return WHITESPACE;
                }
                switch (c) {
                    case 0x22: case 0x27: return consumeString(c);
                    case 0x23: // "#": a hash, or a delim
                        i++;
                        if (isIdentChar(at(i)) || validEscape(i)) consumeIdentSequence();
                        return OTHER;
                    case 0x28: i++; return { type: 'open', closer: ')' };
                    case 0x5b: i++; return { type: 'open', closer: ']' };
                    case 0x7b: i++; return { type: 'open', closer: '}' };
                    case 0x29: i++; return { type: 'close', char: ')' };
                    case 0x5d: i++; return { type: 'close', char: ']' };
                    case 0x7d: i++; return { type: 'close', char: '}' };
                    case 0x3b: i++; return SEMICOLON;
                    case 0x3a: i++; return COLON;
                    case 0x2b: case 0x2e: // "+", "."
                        if (startsNumber(i)) return consumeNumeric();
                        i++;
                        return OTHER;
                    case 0x2d: // "-"
                        if (startsNumber(i)) return consumeNumeric();
                        if (at(i + 1) === 0x2d && at(i + 2) === 0x3e) { i += 3; return OTHER; } // CDC
                        if (startsIdent(i)) return consumeIdentLike();
                        i++;
                        return OTHER;
                    case 0x3c: // "<": CDO, or a delim
                        i += at(i + 1) === 0x21 && at(i + 2) === 0x2d && at(i + 3) === 0x2d ? 4 : 1; // CDO, read by code: the view bootstrap, which runs this, may hold no such text (assertHashableScript)
                        return OTHER;
                    case 0x40: // "@"
                        i++;
                        if (startsIdent(i)) return { type: 'at-keyword', name: asciiLower(consumeIdentSequence()) };
                        return OTHER;
                    case BACKSLASH:
                        if (validEscape(i)) return consumeIdentLike();
                        i++;
                        return OTHER;
                }
                if (isDigit(c)) return consumeNumeric();
                if (isIdentStart(c)) return consumeIdentLike();
                i++; // a delim or a comma
                return OTHER;
            }
        };
    };

    const IMAGE_SET = ['image-set', '-webkit-image-set'];
    const URL_STRINGS = ['image-set', '-webkit-image-set', 'src', 'image']; // the functions whose strings are URLs

    const next = tokenizer();
    const references: CssReference[] = [];
    const loads = scope === 'loads';

    // Open blocks and functions, innermost last. `fontFace`: the block of an @font-face rule.
    const stack: { closer: ')' | ']' | '}'; imageSet: boolean; urlStrings: boolean; fontFace: boolean }[] = [];
    // An at-rule prelude in progress: 'import' until its first token, then 'skip'; 'skip' for any other
    // at-rule. It ends at ";" or "{" at the depth it started, or when its enclosing block closes.
    let prelude: 'none' | 'import' | 'skip' = 'none';
    let preludeDepth = 0;
    let preludeName = ''; // the at-keyword of the prelude in progress
    // The previous significant token was an accepted `url(` function: its first token is the argument, of this kind.
    let urlArgument: CssReference['kind'] | null = null;
    // The stack depth inside the first token of an @import prelude when that token is a function other than `url(`
    // (`src("…")`, CSS Values 4's other <url>; no engine loads it in an @import today, BD4:TST-6), 0 otherwise. Loads
    // scope reads every string and url token inside it as the stylesheet it names, over-approximating as the scan does.
    let importArgument = 0;

    // The declaration in progress, at depth `declarationDepth` (the stack's length inside the block it is in): at its
    // 'start', its 'name' read (`candidate`), its 'value' after the colon (the value of `declared`), or 'other': no
    // declaration the tokenizer can name (a selector, an at-rule, a stray token). A `source` given as a value is in one.
    let declaration: 'start' | 'name' | 'value' | 'other' = property === '' ? 'start' : 'value';
    let declarationDepth = 0;
    let candidate = '';
    let declared = asciiLower(property);
    // A closing bracket matched nothing open: from there on no reference has a property (CssReference.property).
    let mismatched = false;
    // A `{` or a `}` starts the declarations of the block the stack is then in.
    const startDeclarations = () => {
        declaration = 'start';
        declarationDepth = stack.length;
        declared = '';
    };
    // The declaration's state after `token`, a token at its depth.
    const read = (token: Token) => {
        if (token.type === 'semicolon') return startDeclarations();
        if (declaration === 'start') {
            declaration = token.type === 'ident' ? 'name' : 'other';
            if (token.type === 'ident') candidate = token.name;
            return;
        }
        if (declaration !== 'name') return;
        declaration = token.type === 'colon' ? 'value' : 'other';
        if (token.type === 'colon') declared = asciiLower(candidate);
    };
    const push = (start: number, end: number, url: string, kind: CssReference['kind'], text: boolean) => {
        references.push({ start, end, url, kind, property: declaration === 'value' && !mismatched ? declared : '', text });
    };
    const inFontFace = () => stack.some(entry => entry.fontFace);

    for (let token = next(); token !== null; token = next()) {
        if (token.type === 'whitespace') continue;
        const argumentKind = urlArgument;
        urlArgument = null;
        if (stack.length === declarationDepth && token.type !== 'close') read(token);

        const firstOfImport = prelude === 'import' && stack.length === preludeDepth;
        if (firstOfImport) prelude = 'skip'; // only the first token of an @import prelude names a file
        if (importArgument > 0 && stack.length < importArgument) importArgument = 0;
        const inImportArgument = loads && importArgument > 0;
        const accepted = prelude === 'none' || firstOfImport || inImportArgument;
        // what a reference made by this token loads: a stylesheet for @import, a font inside @font-face, else an image
        const kind: CssReference['kind'] = firstOfImport || inImportArgument ? 'style' : inFontFace() ? 'font' : 'image';

        switch (token.type) {
            case 'string': {
                if (!token.closed && !loads) break;
                const url = firstOfImport || (loads ? stack.at(-1)?.urlStrings : stack.at(-1)?.imageSet) === true;
                if (argumentKind !== null) push(token.start, token.end, token.value, argumentKind, false);
                else if (accepted && (url || loads)) push(token.start, token.end, token.value, kind, !url && !inImportArgument);
                break;
            }
            case 'url':
                if ((token.closed || loads) && accepted) push(token.start, token.end, token.value, kind, false);
                break;
            case 'function':
                stack.push({ closer: ')', imageSet: IMAGE_SET.indexOf(token.name) >= 0, urlStrings: URL_STRINGS.indexOf(token.name) >= 0, fontFace: false });
                if (token.name === 'url' && accepted) urlArgument = kind;
                else if (firstOfImport) importArgument = stack.length;
                break;
            case 'at-keyword':
                // at block level only: top level, or directly inside a block (nested at-rules)
                if (prelude === 'none' && (stack.length === 0 || stack.at(-1)!.closer === '}')) {
                    prelude = token.name === 'import' && stack.length === 0 ? 'import' : 'skip';
                    preludeDepth = stack.length;
                    preludeName = token.name;
                }
                break;
            case 'semicolon':
                if (prelude !== 'none' && stack.length === preludeDepth) prelude = 'none';
                break;
            case 'open': {
                // the block an at-rule's prelude ends with; it is an @font-face block when that rule was one
                const opensRule = token.closer === '}' && prelude !== 'none' && stack.length === preludeDepth;
                if (opensRule) prelude = 'none';
                stack.push({ closer: token.closer, imageSet: false, urlStrings: false, fontFace: opensRule && preludeName === 'font-face' });
                if (token.closer === '}') startDeclarations();
                break;
            }
            case 'close': {
                const closesBlock = token.char === '}' && stack.some(entry => entry.closer === '}');
                if (stack.at(-1)?.closer === token.char) {
                    stack.pop();
                } else {
                    mismatched = true;
                    // a block closes whatever is still open inside it
                    if (closesBlock) while (stack.pop()!.closer !== '}') { /* popped */ }
                }
                if (prelude !== 'none' && stack.length < preludeDepth) prelude = 'none';
                if (closesBlock) startDeclarations(); // a stray `}` is part of the declaration it is in
                break;
            }
        }
    }
    return references;
}

/**
 * The one rule for a URL the guest wrote where the view would load it (BD7:ISO-1; class A, closed by an allowlist): the
 * renderer's URL attributes, every reference of guest CSS in the view, and every reference of a registered stylesheet the
 * view gets (files.ts, viewStylesheets). A URL is kept only as one of the allowed cases, never because its scheme is
 * missing from a list of bad ones:
 *   - exactly a URL the view minted (`isMinted`): a registered file's `blob:` URL, after the registered-path rewrite;
 *   - the empty URL, which names nothing and loads nothing (`url("")`, `src=""`): what a dropped reference becomes;
 *   - a fragment-only URL (`#` first) in a property whose `url()` names an element of the view's own document and loads
 *     nothing (`property`; Chromium, Firefox and WebKit raise no violation for any of them, measured, whether an element of
 *     that id exists or not): the SVG paint, clip, mask, filter and marker references. Anywhere else a fragment-only URL
 *     resolves against the view's `about:blank` base and is loaded as `about:blank#…` (an image, a font, an import, every
 *     URL attribute of markup), which the host page's inherited policy refuses and Chromium reports to its endpoint;
 *   - a `text` string (CssReference) that names no URL at all: the URL parser resolves it against no base the view has
 *     (`about:blank`, and a `blob:` stylesheet's, both with an opaque path), so wherever var() carries it, nothing loads.
 *     A font family's name, a `content` text and an area of a grid template stay; a text that reads as a URL (`"#"`,
 *     `"Note: x"`) goes, as any URL would.
 * Everything else goes, whatever its scheme or spelling: a URL of another scheme is a load the view's policy and the host
 * page's inherited fetch directives refuse, and the host page's refusal is reported to its endpoint with the scheme whole
 * (`blocked-uri`), a channel the guest would write into; a relative URL names nothing. `property` is the property of the
 * declaration (CssReference, ASCII lower case), `''` for every position of markup. An http(s) URL of an origin strict
 * mode's `origins` lists for an element's load is not this rule's: the renderer keeps it beside it, where an attribute
 * takes the load's credentials away (sanitizeRender); CSS takes no attribute, so CSS keeps none.
 *
 * Self-contained: the view runs it, stringified (in-sandbox-view.ts, inSandboxView).
 */
export function keepsUrl(url: string, isMinted: (url: string) => boolean, property = '', text = false): boolean {
    if (url === '' || isMinted(url)) return true;
    const LOCAL_REFERENCES = ['fill', 'stroke', 'clip-path', 'mask', 'mask-image', 'filter', 'marker', 'marker-start', 'marker-mid', 'marker-end'];
    if (url.charCodeAt(0) === 0x23 && LOCAL_REFERENCES.indexOf(property) >= 0) return true;
    if (!text) return false;
    try {
        new URL(url, 'about:blank');
        return false;
    } catch {
        return true;
    }
}

/**
 * `source` with only the references `keeps` allows (cssReferences, `loads` scope; keepsUrl over the view's minted URLs):
 * every other one becomes the empty CSS string `""`, which loads nothing (`url("")` names no resource), whatever the
 * engine. Each one dropped is added to `dropped`: its kind of load and its URL as written. `property` is the property
 * `source` is the value of, `''` for a stylesheet or a declaration list (cssReferences). `scan` is cssReferences: given,
 * so that this function too closes over nothing and the strict view can run it, stringified (in-sandbox-view.ts,
 * inSandboxView), as the host does for registered stylesheets with the same rule (files.ts, viewStylesheets).
 */
export function withKeptReferences(source: string, scan: typeof cssReferences, keeps: (url: string, property: string, text: boolean) => boolean, dropped: [kind: CssReference['kind'], url: string][], property: string): string {
    const references = scan(source, 'loads', property);
    let output = '';
    let at = 0;
    for (let i = 0; i < references.length; i++) {
        const reference = references[i]!;
        if (keeps(reference.url, reference.property, reference.text)) continue;
        output += source.slice(at, reference.start) + '""';
        at = reference.end;
        dropped[dropped.length] = [reference.kind, reference.url];
    }
    return at === 0 ? source : output + source.slice(at);
}

/** withKeptReferences over cssReferences and keepsUrl, as the view composes them (host-side callers and the tests). */
export function keptCss(source: string, dropped: [kind: string, url: string][], property = '', isMinted: (url: string) => boolean = () => false): string {
    const keeps = (url: string, of: string, text: boolean) => keepsUrl(url, isMinted, of, text);
    return withKeptReferences(source, cssReferences, keeps, dropped as [kind: CssReference['kind'], url: string][], property);
}

/** The references that can name a registered file (`files` scope of cssReferences). */
export function cssUrlReferences(source: string): CssReference[] {
    return cssReferences(source, 'files');
}

/** `source` with each range replaced: `edits` sorted by start and non-overlapping. */
export function replaceRanges(source: string, edits: readonly { start: number; end: number; text: string }[]): string {
    let output = '';
    let at = 0;
    for (const edit of edits) {
        output += source.slice(at, edit.start) + edit.text;
        at = edit.end;
    }
    return output + source.slice(at);
}
