/**
 * `documentUrl` (design 03, "The public surface"): where the embedder serves `sealed-document.html`, sealed mode's view.
 * It is given once, to defineWebSandbox(), and is not part of an app or of the grants, so data that describes an app can
 * never choose the document that renders it.
 *
 * - **Resolved against the document's own URL** (`document.URL`), never its base URL: a `<base>` element, which markup
 *   injection can add without any script, would otherwise point every element of the page at another host (review 2,
 *   finding 1). The URL is resolved and checked before anything is stored, and what is stored is its serialisation.
 * - **One rule** (`documentUrlRefusal`, design 05's row 3.10, the owner's decision 3): `http:` or `https:` on any host
 *   page; any other URL only where its scheme, host and port are the host page's own origin and that origin is neither
 *   opaque nor a browser extension's; no user name or password, no fragment; a query and any path are the embedder's.
 * - **One registration.** The element class is registered under one name, so there is one value per page: the
 *   registered URL, or none (the build with the network modes registers without one, and refuses sealed mode then).
 */
import { mintUncodedError } from './minted-errors';
import { fixedDetail, reasonText } from './reasons';

/** The schemes a `documentUrl` may have on any host page (design 03, "Schemes"): the served file is fetched over the network. */
export const DOCUMENT_URL_SCHEMES = ['http:', 'https:'] as const;

/**
 * The schemes of browsers' extension pages. Such a page's origin is not opaque, but the served file runs there only as a
 * sandbox page of the manifest with a narrowed policy, where the guest's realms read every file of the extension under
 * the file's `<meta>` (research 34): an extension's page names an `http(s)` copy of the file (decision 3).
 */
export const EXTENSION_SCHEMES = ['chrome-extension:', 'moz-extension:', 'safari-web-extension:'] as const;

/**
 * How an opaque origin serialises (HTML, "serialization of an origin"). A browser's `file:` page reads so, with its
 * frame sandboxed or not, so the file's guard (I14) cannot tell its two framings apart there (research 34).
 */
export const OPAQUE_ORIGIN = 'null';

/** What the element reads of the host page for its `documentUrl`, once, by `hostPage()`. */
export interface HostPage {
    /** The document's own URL (`document.URL`), which a relative `documentUrl` is resolved against. */
    readonly address: string;
    /** The document's origin as the page itself reads it (`self.origin`): `"null"` where it is opaque. */
    readonly origin: string;
}

const SCHEMES = DOCUMENT_URL_SCHEMES.join(' or ');
const COPY = `name an ${SCHEMES} copy of the file`;

/** Each rule a `documentUrl` can break, in the words its refusal gives (`documentUrlRefused`). */
export const DOCUMENT_URL_RULES = {
    type: 'it is not a string or a URL',
    parse: "it does not parse as a URL against the document's own URL",
    opaqueHost: `it is not on ${SCHEMES}, and the host page's origin is opaque (a browser's file: page, a sandboxed frame, a data: page), where the file's guard cannot hold: ${COPY}`,
    extensionHost: `it is not on ${SCHEMES}, and the host page is a browser extension's: ${COPY}`,
    scheme: `it is not on ${SCHEMES}, and its scheme, host and port are not the host page's own origin`,
    credentials: 'it carries a user name or a password',
    fragment: 'it carries a fragment',
} as const;

export type DocumentUrlRule = keyof typeof DOCUMENT_URL_RULES;

/**
 * Which rule a resolved URL breaks on a host page of origin `hostOrigin` (`self.origin`), or null: the one rule of a
 * `documentUrl`.
 */
export function documentUrlRefusal(url: URL, hostOrigin: string): DocumentUrlRule | null {
    const origin = originRefusal(url, hostOrigin);
    if (origin !== null) return origin;
    if (url.username !== '' || url.password !== '') return 'credentials';
    // a '#' in a serialised URL starts its fragment, an empty one included (`…/file.html#`)
    if (url.href.includes('#')) return 'fragment';
    return null;
}

// `http(s)` on any host page; any other scheme only on the host page's own origin, where that origin is a tuple and not
// an extension's. The page's own reading of its origin decides, never the URL parser's `origin` of `url`: the parser
// reads a `file:` URL's origin as "null" in some engines and as "file://" in others, and a `blob:` URL's as its
// creator's, so the parser's string would equal an opaque page's "null" or an http page's origin. The URL's side is
// built from its own scheme and host, which never serialise as "null", and never as another scheme's origin.
function originRefusal(url: URL, hostOrigin: string): DocumentUrlRule | null {
    if ((DOCUMENT_URL_SCHEMES as readonly string[]).includes(url.protocol)) return null;
    if (hostOrigin === OPAQUE_ORIGIN) return 'opaqueHost';
    if ((EXTENSION_SCHEMES as readonly string[]).includes(schemeOfOrigin(hostOrigin))) return 'extensionHost';
    if (tupleOf(url) !== hostOrigin) return 'scheme';
    return null;
}

// The scheme of a serialised tuple origin (`scheme://host[:port]`), with its colon.
const schemeOfOrigin = (origin: string) => origin.split('//', 1)[0]!;

// A URL's scheme, host and port as an origin serialises them.
const tupleOf = (url: URL) => `${url.protocol}//${url.host}`;

const refused = (rule: DocumentUrlRule) => mintUncodedError(TypeError, `[Sandbox] defineWebSandbox(): ${reasonText('documentUrlRefused', fixedDetail(DOCUMENT_URL_RULES[rule]))}.`);

/**
 * The `documentUrl` given to defineWebSandbox(), resolved against the host page's own URL and serialised, or a TypeError
 * that names the rule it breaks on that page. Reads the value once: a string as it is, a URL by its `href`.
 */
export function readDocumentUrl(value: unknown, page: HostPage): string {
    const text = textOf(value);
    if (text === null) throw refused('type');
    let url: URL;
    try {
        url = new URL(text, page.address);
    } catch {
        throw refused('parse');
    }
    const rule = documentUrlRefusal(url, page.origin);
    if (rule !== null) throw refused(rule);
    return url.href;
}

/**
 * The host page as its `documentUrl` is read against: the document's own URL, `document.URL`, never `document.baseURI`,
 * which a `<base>` moves; and its origin as the page reads it, `self.origin`, which is `"null"` where the page is opaque
 * (a value that is not a string, which a page's own script can assign, counts as opaque). The element's one read of the
 * page's address and origin outside host-site.ts (test/unit/host-site.test.ts).
 */
export function hostPage(): HostPage {
    const origin: unknown = self.origin;
    return { address: document.URL, origin: typeof origin === 'string' ? origin : OPAQUE_ORIGIN };
}

// A string, or a URL's serialisation, read once; null for anything else.
function textOf(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value instanceof URL) return value.href;
    return null;
}

// The page's one registration: the serialised URL, null when it was registered without one, undefined before.
let registered: string | null | undefined;

/** The registered `documentUrl`: a serialised URL that holds the rule, or null when there is none (or no registration yet). */
export function registeredDocumentUrl(): string | null {
    return registered ?? null;
}

/** Stores the page's registration. Called once, after the element is defined, with a URL readDocumentUrl() returned. */
export function storeRegistration(url: string | null): void {
    registered = url;
}
