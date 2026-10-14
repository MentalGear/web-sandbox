import type { CSPDirectives } from "../../csp-directives";
import { admits, LOAD_KIND_NAMES, LOAD_KINDS } from "../load-kinds";
import { directiveOf, effectiveDirective, fallbackList, inheritedDefaultSources, type LoadKind } from "./effective-directive";
import { defineData } from "../utils";

/**
 * Which directives admit the guest's own files (ADR-004). A registered file reaches the guest as a
 * blob: URL created in the guest's own realm, and each kind of load is checked against its own
 * directive, so `blob:` is added only where a registered file's type needs it. The kinds, named by
 * their CSP Level 3 effective directive (effective-directive.ts):
 *
 *   JavaScript   script-src-elem  (<script src>, import(), importScripts)
 *   text/css     style-src-elem   (<link rel=stylesheet>, @import)
 *   image/*      img-src
 *   font/*       font-src
 *   audio/*, video/*, text/vtt   media-src
 *   any file     connect-src  (sandboxFiles.read()/text() and fetch() of a file's URL)
 *
 * `blob:` goes to the directive that GOVERNS each kind in this policy, read from the one fallback table
 * (effective-directive.ts): script-src-elem when the embedder set it, else script-src, else default-src.
 * Before that table it went to script-src and style-src only, so a policy with script-src-elem or
 * style-src-elem refused every registered script or stylesheet (follow-up audit 2026-10-14).
 *
 * `blob:` grants no reach beyond those files: the blob store resolves only URLs minted by the guest's
 * own opaque origin, so neither the host's nor another sandbox's blob: URLs load
 * (docs/research/blob-delivery-probe.md, section 4).
 */
const BLOB = 'blob:';
const NONE = "'none'";

/** The kinds of load a registered file can be the target of. */
export type FileKind = Extract<LoadKind, 'script-src-elem' | 'style-src-elem' | 'img-src' | 'font-src' | 'media-src' | 'connect-src'>;

/**
 * The kinds of load files of these types need `blob:` for. Empty when there are no files. Kinds in `exclude`
 * never get it: strict mode passes `script-src-elem`, since its view admits no script but its own bootstrap
 * and its worker is classic, with no module graph and no importScripts (ADR-005).
 */
export function kindsForTypes(types: Iterable<string>, exclude: readonly FileKind[] = []): Set<FileKind> {
    const needed = new Set<FileKind>();
    // the table reference resolution reads too (load-kinds.ts): a type gets blob: in the directive of exactly the
    // loads that may name it, so what the policy admits and what a reference resolves to cannot drift apart
    for (const type of types) {
        for (const kind of LOAD_KIND_NAMES) if (admits(kind, type)) needed.add(LOAD_KINDS[kind].directive);
    }
    for (const kind of exclude) needed.delete(kind);
    return needed;
}

// The directive a kind gets of its own when only default-src governs it: the one just before default-src in
// its fallback list (script-src for script-src-elem, style-src for style-src-elem, img-src for img-src, …).
// Adding blob: there rather than to default-src grants it to this kind without widening every other kind
// default-src governs. (script-src rather than script-src-elem, as before the table: a policy without -elem
// directives comes out byte-identical.)
const ownDirective = (kind: FileKind): string => {
    const list = fallbackList(kind);
    return list[list.length - 2]!;
};

const tokensOf = (values: readonly unknown[]): string[] => {
    const tokens: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') continue; // generateCSP rejects it later
        for (const token of value.trim().split(/\s+/)) {
            if (token) tokens.push(token);
        }
    }
    return tokens;
};

const isKeyword = (token: string, keyword: string) => token.toLowerCase() === keyword; // CSP keywords are case-insensitive

/**
 * Returns a copy of `directives` with `blob:` added where files of `types` need it, warning once per
 * directive per instance (`warned`) when the embedder's explicit 'none' keeps files of a type out.
 *
 * For each kind of load the files need, the directive that governs it (effectiveDirective):
 * - one with sources gets `blob:` appended (script-src-elem when it is set, else script-src, …);
 * - default-src, or none at all: the kind's own directive is created (ownDirective). Adding only `blob:`
 *   would narrow it to `blob:`, so default-src's sources are copied in first (minus 'none' and 'self'), and
 *   a broad embedder default-src still applies to that directive. An empty or 'none' default-src copies in
 *   nothing: the directive becomes `blob:` alone;
 * - one set to 'none', or to an empty array (which generateCSP emits as 'none', backlog S16), is kept: the
 *   embedder said no, and the files of that kind will not load. The warning says so. Treating `[]` as a
 *   fallback here would let registering a file widen a denied directive to default-src's sources.
 *
 * With no types, the directives come back unchanged (as a shallow copy). `options.exclude` names kinds that
 * never get `blob:` (kindsForTypes).
 */
export function addFileSources(directives: CSPDirectives, types: Iterable<string>, warned: Set<string>, options: { exclude?: readonly FileKind[] } = {}): CSPDirectives {
    const output: Record<string, unknown> = { ...directives };
    const inherited = inheritedDefaultSources(directives);

    for (const kind of kindsForTypes(types, options.exclude)) {
        const governing = effectiveDirective(directives, kind);
        if (governing === null || governing === 'default-src') {
            defineData(output, ownDirective(kind), [...inherited, BLOB]);
            continue;
        }
        const values = directiveOf(directives, governing);
        if (!Array.isArray(values)) continue; // a bad value generateCSP rejects

        // every() of no tokens is true: [] and [''] are 'none' here exactly as in generateCSP
        if (tokensOf(values).every(token => isKeyword(token, NONE))) {
            if (!warned.has(governing)) {
                warned.add(governing);
                console.warn(`[Sandbox] "connectionsAllowed.${governing}" is 'none' (an empty array means 'none'), so registered files that load through it will not load in the guest.`);
            }
            continue;
        }
        defineData(output, governing, [...(values as string[]), BLOB]);
    }

    return output as CSPDirectives;
}
