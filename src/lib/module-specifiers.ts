/*! es-module-lexer 1.7.0 (bundled from its asm.js build 'es-module-lexer/js') | MIT License | Copyright (C) 2018-2022 Guy Bedford | full notice: THIRD_PARTY_NOTICES.md */
import { parse } from 'es-module-lexer/js';

/**
 * The module graph (ADR-004, PR3). Host-only: nothing here is stringified into the guest.
 *
 * A registered module reaches the guest as a blob: URL, and a relative specifier never resolves
 * inside a blob: module: its base URL is the blob URL, whose path is opaque, so `./x.js`, `../x.js`
 * and `/x.js` throw a TypeError in every engine before any import map is consulted
 * (docs/research/blob-delivery-probe.md, section 3). So the host rewrites them first: each relative
 * specifier is resolved against the file's own virtual URL, `https://vfs.invalid/<path>`, and the
 * guest's one import map (inSandboxImportMap, in-sandbox-files.ts) maps every registered JavaScript
 * file's virtual URL to its blob: URL. Resolution is the URL parser's, so `..` above the root stays at
 * the root.
 *
 * The lexer is es-module-lexer's asm.js build: synchronous, no init(), no WebAssembly (so the host page
 * never needs 'wasm-unsafe-eval'), and bundled into dist, so consumers install nothing. It finds
 * import and export-from statements, side-effect imports and import() the way a JavaScript parser
 * does, so import-like text inside strings, comments, regular expressions and templates is not touched.
 *
 * Rewritten: static `import … from`, `import '…'`, `export … from`, `export * from`, source and defer
 * phase imports, and import() whose argument is a string literal (or a template literal without
 * substitutions or escapes). Left as written, and failing closed in the guest:
 *   - bare specifiers and full URLs (the import map and the policy decide);
 *   - computed import(expr), which cannot be resolved statically;
 *   - a relative specifier that would resolve outside https://vfs.invalid/ (`//host/x`, `/\host/x`);
 *   - `new URL('./x', import.meta.url)`: import.meta.url is `blob:null/<uuid>`, not a virtual URL.
 */

/** The virtual origin of the files; a file at `path` has the virtual URL VIRTUAL_ROOT + path. */
export const VIRTUAL_ROOT = 'https://vfs.invalid/';

/** One replacement in a source string: [start, end) in UTF-16 code units, and the text that replaces it. */
export interface SpecifierEdit {
    start: number;
    end: number;
    text: string;
}

/**
 * The URL a relative module specifier names when resolved against `baseUrl`, or null when it must be
 * left as written: not relative (bare, or a full URL), unparsable, or resolving outside VIRTUAL_ROOT.
 * Relative means what the HTML standard calls URL-like and relative: it starts with `/`, `./` or `../`.
 */
export function resolveModuleSpecifier(specifier: string, baseUrl: string): string | null {
    if (!(specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../'))) return null;
    let href: string;
    try {
        href = new URL(specifier, baseUrl).href;
    } catch {
        return null;
    }
    // `//host/x` and `/\host/x` are scheme-relative: they leave the files, so they are not ours to rewrite
    return href.startsWith(VIRTUAL_ROOT) ? href : null;
}

const QUOTES = new Set(['"', "'"]);
// A template literal without substitutions and without escapes: its value is its text.
const PLAIN_TEMPLATE = /^`([^`\\]*)`$/;

/**
 * The edits that rewrite every relative specifier in the module `source`, resolved against `baseUrl`
 * (the module's own virtual URL), sorted by position. Each specifier, quotes included, becomes the
 * JSON string of its resolved URL. Throws when the lexer cannot parse `source` (the caller then
 * delivers the file unchanged). A leading byte order mark is skipped: the lexer would otherwise find
 * nothing in the file at all.
 */
export function moduleSpecifierEdits(source: string, baseUrl: string): SpecifierEdit[] {
    const offset = source.startsWith('﻿') ? 1 : 0;
    const code = offset ? source.slice(offset) : source;
    const [imports] = parse(code);

    const edits: SpecifierEdit[] = [];
    for (const entry of imports) {
        if (entry.d === -2) continue; // import.meta
        let start: number;
        let end: number;
        let specifier: string | undefined;
        if (entry.d === -1) {
            // static: s..e is the specifier without its quotes
            start = entry.s - 1;
            end = entry.e + 1;
            const quote = code[start];
            if (!quote || !QUOTES.has(quote) || code[entry.e] !== quote) continue;
            specifier = entry.n;
        } else {
            // dynamic: s..e is the whole argument expression, quotes included
            start = entry.s;
            end = entry.e;
            const argument = code.slice(start, end);
            const first = argument[0];
            if (entry.n !== undefined && first && QUOTES.has(first) && argument.endsWith(first) && argument.length >= 2) {
                specifier = entry.n;
            } else {
                specifier = PLAIN_TEMPLATE.exec(argument)?.[1]; // undefined: computed, left as written
                if (specifier?.includes('${')) specifier = undefined;
            }
        }
        if (specifier === undefined) continue;
        const resolved = resolveModuleSpecifier(specifier, baseUrl);
        if (resolved === null) continue;
        edits.push({ start: start + offset, end: end + offset, text: JSON.stringify(resolved) });
    }
    return edits.sort((a, b) => a.start - b.start);
}

/** `source` with `edits` applied (sorted, non-overlapping, as moduleSpecifierEdits returns them). */
export function applyEdits(source: string, edits: readonly SpecifierEdit[]): string {
    let output = '';
    let at = 0;
    for (const edit of edits) {
        output += source.slice(at, edit.start) + edit.text;
        at = edit.end;
    }
    return output + source.slice(at);
}

/**
 * Rewrites the relative specifiers of an inline `<script type="module">` in guest markup, resolved
 * against `documentUrl` (markup-references.ts resolves markup as a document at the root of the files).
 * Returns the new text, or null when nothing changed or the script is left as written: the lexer
 * failed (`onFailure` is called), or a specifier to replace contains `<` or `>`. Those two characters
 * decide where the HTML tokenizer ends a script (`<!--`, `-->`, `<script`, `</script`), so replacing
 * text that contains one could move the end of the script when the markup is parsed again; leaving
 * such a script alone keeps the guest's tree exactly as its own parser built it.
 */
export function rewriteInlineModule(text: string, documentUrl: string, onFailure: () => void): string | null {
    let edits: SpecifierEdit[];
    try {
        edits = moduleSpecifierEdits(text, documentUrl);
    } catch {
        onFailure();
        return null;
    }
    if (edits.length === 0) return null;
    if (edits.some(edit => /[<>]/.test(text.slice(edit.start, edit.end)))) return null;
    return applyEdits(text, edits);
}
