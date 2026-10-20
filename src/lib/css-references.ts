/**
 * URL references in CSS (ADR-004, PR4). Host-only: nothing here is stringified into the guest.
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
}

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

type Token =
    | { type: 'whitespace' }
    | { type: 'string'; start: number; end: number; value: string; closed: boolean }
    | { type: 'bad' } // bad-string or bad-url: never a reference
    | { type: 'url'; start: number; end: number; value: string; closed: boolean }
    | { type: 'function'; name: string }
    | { type: 'at-keyword'; name: string }
    | { type: 'open'; closer: ')' | ']' | '}' }
    | { type: 'close'; char: ')' | ']' | '}' }
    | { type: 'semicolon' }
    | { type: 'other' }; // ident, hash, number, dimension, percentage, delim, comma, colon, CDO, CDC

const WHITESPACE: Token = { type: 'whitespace' };
const BAD: Token = { type: 'bad' };
const OTHER: Token = { type: 'other' };
const SEMICOLON: Token = { type: 'semicolon' };

/** A tokenizer over `source`, one token per call; null at the end. Comments are skipped. */
function tokenizer(source: string) {
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
            if (i >= n) return { type: 'url', start, end: i, value, closed: false };
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
        if (at(i) !== 0x28) return OTHER;
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
                    i += source.startsWith('<!--', i) ? 4 : 1;
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
            i++; // a delim, comma or colon
            return OTHER;
        }
    };
}

const IMAGE_SET = new Set(['image-set', '-webkit-image-set']);

/**
 * Every URL reference in `source` (a stylesheet, the text of a `<style>`, or the declarations of a
 * `style` attribute), in source order, whatever it names. See the top of this file for what counts.
 */
export function cssUrlReferences(source: string): CssReference[] {
    const next = tokenizer(source);
    const references: CssReference[] = [];

    // Open blocks and functions, innermost last. `fontFace`: the block of an @font-face rule.
    const stack: { closer: ')' | ']' | '}'; imageSet: boolean; fontFace: boolean }[] = [];
    // An at-rule prelude in progress: 'import' until its first token, then 'skip'; 'skip' for any other
    // at-rule. It ends at ";" or "{" at the depth it started, or when its enclosing block closes.
    let prelude: 'none' | 'import' | 'skip' = 'none';
    let preludeDepth = 0;
    let preludeName = ''; // the at-keyword of the prelude in progress
    // The previous significant token was an accepted `url(` function: its first token is the argument, of this kind.
    let urlArgument: CssReference['kind'] | null = null;

    const push = (start: number, end: number, url: string, kind: CssReference['kind']) => references.push({ start, end, url, kind });
    const inFontFace = () => stack.some(entry => entry.fontFace);

    for (let token = next(); token !== null; token = next()) {
        if (token.type === 'whitespace') continue;
        const argumentKind = urlArgument;
        urlArgument = null;

        const firstOfImport = prelude === 'import' && stack.length === preludeDepth;
        if (firstOfImport) prelude = 'skip'; // only the first token of an @import prelude names a file
        const accepted = prelude === 'none' || firstOfImport;
        // what a reference made by this token loads: a stylesheet for @import, a font inside @font-face, else an image
        const kind: CssReference['kind'] = firstOfImport ? 'style' : inFontFace() ? 'font' : 'image';

        switch (token.type) {
            case 'string':
                if (!token.closed) break;
                if (argumentKind !== null) push(token.start, token.end, token.value, argumentKind);
                else if (accepted && (firstOfImport || stack.at(-1)?.imageSet)) push(token.start, token.end, token.value, kind);
                break;
            case 'url':
                if (token.closed && accepted) push(token.start, token.end, token.value, kind);
                break;
            case 'function':
                stack.push({ closer: ')', imageSet: IMAGE_SET.has(token.name), fontFace: false });
                if (token.name === 'url' && accepted) urlArgument = kind;
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
                stack.push({ closer: token.closer, imageSet: false, fontFace: opensRule && preludeName === 'font-face' });
                break;
            }
            case 'close':
                if (stack.at(-1)?.closer === token.char) {
                    stack.pop();
                } else if (token.char === '}' && stack.some(entry => entry.closer === '}')) {
                    // a block closes whatever is still open inside it
                    while (stack.pop()!.closer !== '}') { /* popped */ }
                }
                if (prelude !== 'none' && stack.length < preludeDepth) prelude = 'none';
                break;
        }
    }
    return references;
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
