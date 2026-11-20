/**
 * The check of the served file (design 03, "The check of the file"; design 05, row 3.3): before sealed mode's first
 * frame of a registration, the element requests `documentUrl` itself, reads the answer where it can, and names what is
 * wrong with it: no file, or a type that is not HTML; other bytes than the library's file (modified, or another
 * version's); and each header that sets a policy on the file, by its name. A finding ends the build with its reason
 * before anything is framed; where the answer cannot be read, there is no check, and the build goes on.
 *
 * - **A check, for honest deployments.** It reads what the server answers this request; the frame's navigation is
 *   another request (it differs in `Sec-Fetch-Dest`, and on Firefox and WebKit in its cookies), which a server can answer
 *   otherwise. It adds no trust and removes none: the file's host is trusted with the app either way (design 03, "Who is
 *   trusted with the app").
 * - **The request carries nothing of the page's or the app's** (INHERITED_CONTEXT, `hostRealmGlobals`): no credentials
 *   (`credentials: 'omit'`, as the frame, which is credentialless on Chromium, gets no cookie either), no referrer (the
 *   frame has none), no header but the `Accept` of a navigation (which needs no preflight), and it is made with the
 *   platform's `fetch` as this module found it when it was evaluated, so a wrapper the page installs later never sees it.
 * - **What the page around it does** (the rows `cspFetch` and `serviceWorker`): a `connect-src` that refuses the URL
 *   refuses the request, with a violation on the page, and there is no check; a Service Worker that controls the page
 *   and whose scope holds `documentUrl` can answer it, and the check reads that answer (the frame's own navigation, an
 *   opaque document's, is never answered by it).
 * - **Kept for the registration** (`keptDocumentCheck`): an answer, a pass or a finding, is the registration's for the
 *   page's life, so a registration makes one request however many elements build. A finding stays until the page loads
 *   again: the comparison is with the library this page loaded, and a deploy that fixes the file is one a page loads. A
 *   request that was not answered (a network failure, a refusal by the page's own policy, another origin that does not
 *   allow the read) is no answer: the next build asks again.
 */
import { documentDigest, sealedDocumentDigest } from './document-digest';
import { fixedDetail, reasonText, type ReasonId } from './reasons';

/** A function with the platform's fetch's signature. */
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The platform's fetch of `realm`, or undefined where it has none: the one function of the host page's realm that names
 * it (class E-net: test/unit/structural.test.ts lists it beside the request gate and the bridge's frame). Called once, as
 * this module is evaluated, so a wrapper the page installs afterwards is not on the check's path.
 */
function platformFetchOf(realm: typeof globalThis): Fetcher | undefined {
    const found: unknown = realm.fetch;
    return typeof found === 'function' ? (found as Fetcher) : undefined;
}

const platformFetch = platformFetchOf(globalThis);
const apply = Reflect.apply;

/**
 * The request (design 03): no credentials, no referrer, the redirects the frame would follow, the HTTP cache as the
 * frame's navigation uses it, and the `Accept` of a navigation, so a server that answers by what is accepted answers as
 * it answers the frame. `Accept` with this value is a CORS-safelisted header: a cross-origin request needs no preflight.
 */
export const DOCUMENT_CHECK_REQUEST = {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    cache: 'default',
    headers: { accept: 'text/html' },
} as const satisfies RequestInit;

/**
 * The response headers the check refuses, each by its name, with its reason and why (design 03, "The policies in
 * force"). Every other header passes: among them `Cross-Origin-Resource-Policy` and `Cross-Origin-Embedder-Policy`, one
 * of which Firefox and WebKit need on the file under a host page's `Cross-Origin-Embedder-Policy: require-corp`
 * (docs/API.md#host-page-policy), and `Permissions-Policy`, which can only narrow what the view uses. A
 * `frame-ancestors` directive is looked for inside the two policy headers, and named before them.
 */
export const REFUSED_DOCUMENT_HEADERS = {
    'x-frame-options': { reason: 'documentFrameOptions', why: "a policy on framing the file, whose answer depends on the host page's ancestors, which the host page cannot read on every engine; refused whatever its value, as the file is served with no header that sets a policy on it" },
    'content-security-policy': { reason: 'documentCsp', why: 'the view and its worker inherit it beside the `<meta>`, so it can refuse the view\'s bootstrap (the view never answers) or report what it refuses' },
    'content-security-policy-report-only': { reason: 'documentCspReportOnly', why: "it refuses nothing and reports what it would have refused, to an endpoint of its own: under one, a guest's load would be reported (design 03, I18)" },
} as const satisfies Record<string, { readonly reason: ReasonId; readonly why: string }>;

export type RefusedDocumentHeader = keyof typeof REFUSED_DOCUMENT_HEADERS;

/** The two headers a `frame-ancestors` directive is looked for in. */
const POLICY_HEADERS = ['content-security-policy', 'content-security-policy-report-only'] as const satisfies readonly RefusedDocumentHeader[];

/** What the check reads of an answer: its status, its headers (by lower-case name, as `Headers.get` answers) and its bytes. */
export interface DocumentAnswer {
    readonly status: number;
    readonly header: (name: string) => string | null;
    /** The body, read only where the status and the type leave the bytes to be compared. */
    readonly bytes: () => Promise<Uint8Array>;
}

/** Whether a `Content-Type` is HTML: its essence, before any parameter, is `text/html`. None is not HTML. */
export function isHtmlType(type: string | null): boolean {
    if (type === null) return false;
    const essence = type.split(';')[0]!.trim().toLowerCase();
    return essence === 'text/html';
}

/** Whether a policy header's text (several policies, comma-separated) has a `frame-ancestors` directive. */
export function hasFrameAncestors(text: string): boolean {
    for (const policy of text.split(',')) {
        for (const directive of policy.split(';')) {
            const name = directive.trim().split(/[\t\n\f\r ]/)[0]!.toLowerCase();
            if (name === 'frame-ancestors') return true;
        }
    }
    return false;
}

/** The reason a header of the answer gives, or null: `frame-ancestors` first, then each of REFUSED_DOCUMENT_HEADERS in order. */
export function headerFinding(header: (name: string) => string | null): string | null {
    for (const name of POLICY_HEADERS) {
        const text = header(name);
        if (text !== null && hasFrameAncestors(text)) return reasonText('documentFrameAncestors');
    }
    for (const [name, row] of Object.entries(REFUSED_DOCUMENT_HEADERS)) {
        if (header(name) !== null) return reasonText(row.reason);
    }
    return null;
}

/** What `documentMissing` says after its colon: which of the two ways the file is missing. */
export const MISSING_DETAILS = {
    status: fixedDetail('the server answered with a status that is not 2xx'),
    type: fixedDetail('its Content-Type is not text/html'),
} as const;

/**
 * The finding of an answer, or null when it is the library's file with no refused header. In order: the status and the
 * type (the file is missing), the bytes against `digest` (another file), then the headers: a fallback page that carries
 * the site's policy is named as another page, the cause to fix first.
 */
export async function documentFinding(answer: DocumentAnswer, digest: string): Promise<string | null> {
    if (answer.status < 200 || answer.status > 299) return reasonText('documentMissing', MISSING_DETAILS.status);
    if (!isHtmlType(answer.header('content-type'))) return reasonText('documentMissing', MISSING_DETAILS.type);
    if (documentDigest(await answer.bytes()) !== digest) return reasonText('documentChanged');
    return headerFinding(answer.header);
}

/** What one request told: an answer (with its finding, or null for a pass), or none. */
export type DocumentCheck = { readonly answered: true; readonly finding: string | null } | { readonly answered: false };

const UNANSWERED: DocumentCheck = Object.freeze({ answered: false });

/** Whether this realm can make the check's request at all: it had a `fetch` when the module was evaluated. */
export function canCheckDocument(): boolean {
    return platformFetch !== undefined;
}

// The registration's answer, and the request in flight: one page has one registration, so one of each.
let kept: { readonly url: string; readonly finding: string | null } | null = null;
let inFlight: { readonly url: string; readonly check: Promise<DocumentCheck> } | null = null;

/** The answer kept for `url`: `{ finding }` (null for a pass), or undefined while there is none. */
export function keptDocumentCheck(url: string): { readonly finding: string | null } | undefined {
    if (kept === null || kept.url !== url) return undefined;
    return { finding: kept.finding };
}

/**
 * The check of `url`: the request in flight for it if there is one (builds that wait at once share it), else a new one.
 * An answer is kept for the registration before the promise settles. Rejects only where the library has no digest to
 * compare with (sealedDocumentDigest).
 */
export function checkDocument(url: string): Promise<DocumentCheck> {
    if (inFlight !== null && inFlight.url === url) return inFlight.check;
    const check = requestDocument(url).then(result => {
        if (result.answered) kept = { url, finding: result.finding };
        return result;
    });
    const settled = () => {
        if (inFlight?.check === check) inFlight = null;
    };
    check.then(settled, settled);
    inFlight = { url, check };
    return check;
}

// One request, read: an answer and its finding, or no answer. The digest is asked first, so a library without one ends
// the build before any request.
async function requestDocument(url: string): Promise<DocumentCheck> {
    const digest = sealedDocumentDigest();
    if (platformFetch === undefined) return UNANSWERED;
    let response: Response;
    try {
        response = await apply(platformFetch, globalThis, [url, DOCUMENT_CHECK_REQUEST]);
    } catch {
        return UNANSWERED; // a network failure, a refusal by the page's policy, another origin that does not allow the read
    }
    try {
        const answer: DocumentAnswer = {
            status: response.status,
            header: name => response.headers.get(name),
            bytes: async () => new Uint8Array(await response.arrayBuffer()),
        };
        return { answered: true, finding: await documentFinding(answer, digest) };
    } catch {
        return UNANSWERED; // the body could not be read to its end
    }
}
