/**
 * The dynamic `import()` of a strict or sealed entry (S74, class A: INHERITED_CONTEXT.cspPolicyText and cspReporting;
 * BD6:ISO-2). Host-only.
 *
 * The guest's worker inherits the host page's policy list through the view, and `import()` is syntax: nothing at run time
 * can take it from the language. Every `import()` the worker runs is checked against that list, and refused (the view's
 * `script-src` is the bootstrap's hash alone, so it can load nothing, registered files included), and a policy of the host
 * page's that refuses it reports the URL the guest chose, path and query, to the page's report endpoint. So the build
 * refuses an entry that could call it (the reason `entryImport`, reasons.ts): no `import()` reaches the worker, and
 * nothing is lost, since none could load.
 *
 * The scan reads the entry's text, not a parse of it: an `import` that is not part of a longer name, followed by `(` after
 * any whitespace and comments. A lexer's reading can differ from the engine's (a classic script reads `<!--` as a comment,
 * which a module's lexer reads as operators, and the text the engine runs could then lie inside what the lexer took for a
 * template), and a keyword cannot be spelt with escapes, so the text is the one reading every engine agrees with. It may
 * find an `import(` the engine would not run (in a string or a comment), never miss one it would:
 * test/unit/entry-imports.test.ts holds that against the engine, on generated texts.
 */

// The characters that continue a name of the ASCII range: `import` right after one is the end of a longer name.
const NAME_PART = /[A-Za-z0-9_$]/;
// A line terminator of the language: a single-line comment ends at one.
const LINE_END = /[\n\r\u2028\u2029]/;
// White space and line terminators of the language (ECMAScript's WhiteSpace and LineTerminator are what `\s` matches).
const SPACE = /\s/;

/** The index past the whitespace and comments that start at `from` in `text`: block, line and HTML-like (`<!--`, `-->`) comments. */
function pastTrivia(text: string, from: number): number {
    let at = from;
    while (at < text.length) {
        if (SPACE.test(text[at]!)) {
            at++;
            continue;
        }
        if (text.startsWith('/*', at)) {
            const end = text.indexOf('*/', at + 2);
            if (end < 0) return text.length;
            at = end + 2;
            continue;
        }
        if (!(text.startsWith('//', at) || text.startsWith('<!--', at) || text.startsWith('-->', at))) return at;
        while (at < text.length && !LINE_END.test(text[at]!)) at++;
    }
    return at;
}

/** The index of the first `import` in `source` that could be a dynamic `import()`, or -1 when there is none. */
export function dynamicImportAt(source: string): number {
    for (let at = source.indexOf('import'); at >= 0; at = source.indexOf('import', at + 1)) {
        if (at > 0 && NAME_PART.test(source[at - 1]!)) continue;
        const after = at + 'import'.length;
        if (after < source.length && NAME_PART.test(source[after]!)) continue;
        if (source[pastTrivia(source, after)] === '(') return at;
    }
    return -1;
}
