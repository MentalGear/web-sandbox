/**
 * `documentUrl` (design 03, "The public surface"): where the embedder serves `sealed-document.html`, sealed mode's view.
 * It is given once, to defineWebSandbox(), and is not part of an app or of the grants, so data that describes an app can
 * never choose the document that renders it.
 *
 * - **Resolved against the document's own URL** (`document.URL`), never its base URL: a `<base>` element, which markup
 *   injection can add without any script, would otherwise point every element of the page at another host (review 2,
 *   finding 1). The URL is resolved and checked before anything is stored, and what is stored is its serialisation.
 * - **One rule** (`documentUrlRefusal`): the schemes of DOCUMENT_URL_SCHEMES, no user name or password, no fragment; a
 *   query and any path are the embedder's. It is the one place the rule could be widened (the owner's open decision 3,
 *   design README, "Waits for the owner").
 * - **One registration.** The element class is registered under one name, so there is one value per page: the
 *   registered URL, or none (the build with the network modes registers without one, and refuses sealed mode then).
 */
import { mintUncodedError } from './minted-errors';
import { fixedDetail, reasonText } from './reasons';

/** The schemes a `documentUrl` may have (design 03, "Schemes"): the served file is fetched over the network. */
export const DOCUMENT_URL_SCHEMES = ['http:', 'https:'] as const;

/** Each rule a `documentUrl` can break, in the words its refusal gives (`documentUrlRefused`). */
export const DOCUMENT_URL_RULES = {
    type: 'it is not a string or a URL',
    parse: "it does not parse as a URL against the document's own URL",
    scheme: `its scheme is not ${DOCUMENT_URL_SCHEMES.join(' or ')}`,
    credentials: 'it carries a user name or a password',
    fragment: 'it carries a fragment',
} as const;

export type DocumentUrlRule = keyof typeof DOCUMENT_URL_RULES;

/** Which rule a resolved URL breaks, or null: the one rule of a `documentUrl` (design README, decision 3, widens it here). */
export function documentUrlRefusal(url: URL): DocumentUrlRule | null {
    if (!(DOCUMENT_URL_SCHEMES as readonly string[]).includes(url.protocol)) return 'scheme';
    if (url.username !== '' || url.password !== '') return 'credentials';
    // a '#' in a serialised URL starts its fragment, an empty one included (`…/file.html#`)
    if (url.href.includes('#')) return 'fragment';
    return null;
}

const refused = (rule: DocumentUrlRule) => mintUncodedError(TypeError, `[Sandbox] defineWebSandbox(): ${reasonText('documentUrlRefused', fixedDetail(DOCUMENT_URL_RULES[rule]))}.`);

/**
 * The `documentUrl` given to defineWebSandbox(), resolved against `documentAddress` (the document's own URL) and
 * serialised, or a TypeError that names the rule it breaks. Reads the value once: a string as it is, a URL by its
 * `href`.
 */
export function readDocumentUrl(value: unknown, documentAddress: string): string {
    const text = textOf(value);
    if (text === null) throw refused('type');
    let url: URL;
    try {
        url = new URL(text, documentAddress);
    } catch {
        throw refused('parse');
    }
    const rule = documentUrlRefusal(url);
    if (rule !== null) throw refused(rule);
    return url.href;
}

/**
 * The document's own URL, which a relative `documentUrl` is resolved against: `document.URL`, never `document.baseURI`,
 * which a `<base>` moves. The element's one read of the page's address outside host-site.ts
 * (test/unit/host-site.test.ts).
 */
export function documentAddress(): string {
    return document.URL;
}

// A string, or a URL's serialisation, read once; null for anything else.
function textOf(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value instanceof URL) return value.href;
    return null;
}

// The page's one registration: the serialised URL, null when it was registered without one, undefined before.
let registered: string | null | undefined;

/** The registered `documentUrl`: a serialised http(s) URL, or null when there is none (or no registration yet). */
export function registeredDocumentUrl(): string | null {
    return registered ?? null;
}

/** Stores the page's registration. Called once, after the element is defined, with a URL readDocumentUrl() returned. */
export function storeRegistration(url: string | null): void {
    registered = url;
}
