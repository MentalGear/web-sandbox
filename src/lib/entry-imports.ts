/**
 * The import expressions of a strict or sealed entry (S74, class A: INHERITED_CONTEXT.cspPolicyText and cspReporting;
 * BD6:ISO-2, BD7:CHL-1). Host-only.
 *
 * The guest's worker inherits the host page's policy list through the view, and an import expression is syntax: nothing at
 * run time can take it from the language. Every `import()` the worker runs is checked against that list, and refused (the
 * view's `script-src` is the bootstrap's hash alone, so it can load nothing, registered files included), and a policy of
 * the host page's that refuses it reports the URL the guest chose, path and query, to the page's report endpoint; so would
 * every phase of an import (`import.source(…)`, `import.defer(…)`) an engine runs. So the build refuses an entry that could
 * hold one (the reason `entryImport`, reasons.ts): no import expression reaches the worker, and nothing is lost, since none
 * could load.
 *
 * The scan reads the entry's text, not a parse of it: an `import` that is not part of a longer name, followed by `(` or
 * `.` after any whitespace and comments. A lexer's reading can differ from the engine's (a classic script reads `<!--` as
 * a comment, which a module's lexer reads as operators, and the text the engine runs could then lie inside what the lexer
 * took for a template), and a keyword cannot be spelt with escapes, so the text is the one reading every engine agrees
 * with. It may find an import the engine would not run (in a string or a comment), never miss one it would:
 * test/unit/entry-imports.test.ts holds that against the engine, on generated texts, and against the grammar's forms.
 *
 * Its cost is linear in the entry (HOST_PASSES.entryScan, host-passes.ts; BD7:LIM-2): the trivia after every index is
 * read in one pass from the right, so no part of the text is read once per `import`.
 */

// The characters that continue a name of the ASCII range: `import` right after one is the end of a longer name.
const NAME_PART = /[A-Za-z0-9_$]/;
// White space and line terminators of the language (ECMAScript's WhiteSpace and LineTerminator are what `\s` matches).
const SPACE = /\s/;
// What follows an `import` token, past trivia, in every form of it that is an expression: ImportCall's `(`, and `.`
// (ImportMeta, a SyntaxError in a classic script, and every phase of an import: `import.source(…)`, `import.defer(…)`).
const IMPORT_FORMS: readonly string[] = ['(', '.'];

// A line terminator of the language (LF, CR, LS, PS): a single-line comment ends at one.
const isLineEnd = (code: number) => code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
// `\s`, as SPACE reads it: the ASCII white space by code, anything else above ASCII by the expression itself.
const isSpace = (code: number, text: string, at: number) => (code < 0x80 ? code === 0x20 || (code >= 0x09 && code <= 0x0d) : SPACE.test(text[at]!));

/**
 * For every index of `text` from `from` on (and its length), the index past the whitespace and comments that start
 * there: block, line and HTML-like (`<!--`, `-->`) comments. One pass from the right: what follows a run of trivia is
 * found once, so a text of many `import`s that share one long run, or an unclosed block comment, costs one pass, not one
 * per `import`. The rule at each index is the reading every engine agrees with: white space is skipped; `/*` skips past
 * the nearest `*\/` after it (to the end when there is none); `//`, `<!--` and `-->` skip to the next line terminator,
 * which is white space in turn; anything else ends the trivia there.
 */
export function pastTrivia(text: string, from = 0): Uint32Array {
    const length = text.length;
    const past = new Uint32Array(length + 1);
    past[length] = length;
    let lineEnd = length; // the nearest line terminator at or after `at`, or the end
    let close = length; // the nearest `*/` that starts at or after `at + 2`, or the end
    for (let at = length - 1; at >= from; at--) {
        const code = text.charCodeAt(at);
        if (isLineEnd(code)) lineEnd = at;
        if (text.charCodeAt(at + 2) === 0x2a && text.charCodeAt(at + 3) === 0x2f) close = at + 2;
        if (isSpace(code, text, at)) {
            past[at] = past[at + 1]!;
            continue;
        }
        if (text.startsWith('/*', at)) {
            past[at] = close >= length ? length : past[close + 2]!;
            continue;
        }
        const lineComment = text.startsWith('//', at) || text.startsWith('<!--', at) || text.startsWith('-->', at);
        past[at] = lineComment ? past[lineEnd]! : at;
    }
    return past;
}

/**
 * The index of the first `import` in `source` that could start an import expression, or -1 when there is none: an
 * `import` that is not part of a longer name, followed by `(` or `.` after any whitespace and comments. In a classic
 * script (the worker's entry is one) a static import and `import.meta` are SyntaxErrors, so every `import` token an
 * engine runs is one of these forms: ImportCall, or a phase of it.
 */
export function dynamicImportAt(source: string): number {
    let past: Uint32Array | null = null; // read at the first `import` that stands alone, once
    for (let at = source.indexOf('import'); at >= 0; at = source.indexOf('import', at + 1)) {
        if (at > 0 && NAME_PART.test(source[at - 1]!)) continue;
        const after = at + 'import'.length;
        if (after < source.length && NAME_PART.test(source[after]!)) continue;
        past ??= pastTrivia(source, after);
        if (IMPORT_FORMS.includes(source[past[after]!] ?? '')) return at;
    }
    return -1;
}
