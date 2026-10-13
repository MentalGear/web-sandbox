import type { CSPDirectives } from "../../csp-directives";

/**
 * Which directives admit the guest's own files (ADR-004). A registered file reaches the guest as a
 * blob: URL created in the guest's own realm, and each kind of load is governed by its own
 * directive, so `blob:` is added only where a registered file's type needs it:
 *
 *   JavaScript   script-src   (<script src>, import(), importScripts)
 *   text/css     style-src
 *   image/*      img-src
 *   font/*       font-src
 *   audio/*, video/*, text/vtt   media-src
 *   any file     connect-src  (sandboxFiles.read()/text() and fetch() of a file's URL)
 *
 * `blob:` grants no reach beyond those files: the blob store resolves only URLs minted by the guest's
 * own opaque origin, so neither the host's nor another sandbox's blob: URLs load
 * (docs/research/blob-delivery-probe.md, section 4).
 */
const BLOB = 'blob:';
const NONE = "'none'";
const SELF = "'self'";

// The JavaScript MIME types a file can be given; only text/javascript comes from the extension table.
const JAVASCRIPT_TYPES = new Set(['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);

type FileDirective = 'script-src' | 'style-src' | 'img-src' | 'font-src' | 'media-src' | 'connect-src';

/** The directives that need `blob:` for files of these types. Empty when there are no files. */
export function directivesForTypes(types: Iterable<string>): Set<FileDirective> {
    const needed = new Set<FileDirective>();
    for (const type of types) {
        needed.add('connect-src');
        if (JAVASCRIPT_TYPES.has(type)) needed.add('script-src');
        if (type === 'text/css') needed.add('style-src');
        if (type.startsWith('image/')) needed.add('img-src');
        if (type.startsWith('font/')) needed.add('font-src');
        if (type.startsWith('audio/') || type.startsWith('video/') || type === 'text/vtt') needed.add('media-src');
    }
    return needed;
}

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
 * - A directive with sources gets `blob:` appended.
 * - An empty or omitted directive falls back to default-src, so adding only `blob:` would narrow it to
 *   `blob:`. The default-src sources are copied in first (minus 'none' and 'self'), so a broad
 *   embedder default-src still applies to that directive.
 * - A directive the embedder set to exactly 'none' is kept: the embedder said no, and the files of
 *   that type will not load. The warning says so.
 *
 * With no types, the directives come back unchanged (as a shallow copy).
 */
export function addFileSources(directives: CSPDirectives, types: Iterable<string>, warned: Set<string>): CSPDirectives {
    const output: Record<string, unknown> = { ...directives };
    const defaultSrc = Array.isArray(directives['default-src']) ? tokensOf(directives['default-src']) : [];
    const inherited = defaultSrc.filter(token => !isKeyword(token, NONE) && !isKeyword(token, SELF));

    for (const name of directivesForTypes(types)) {
        const values = directives[name];
        if (values !== undefined && !Array.isArray(values)) continue; // a bad value generateCSP rejects

        const tokens = values ? tokensOf(values) : [];
        if (tokens.length === 0) {
            output[name] = [...inherited, BLOB];
            continue;
        }
        if (tokens.every(token => isKeyword(token, NONE))) {
            if (!warned.has(name)) {
                warned.add(name);
                console.warn(`[Sandbox] "connectionsAllowed.${name}" is 'none', so registered files that load through it will not load in the guest.`);
            }
            continue;
        }
        output[name] = [...(values as string[]), BLOB];
    }

    return output as CSPDirectives;
}
