import { assertHashableScript, assertParserSafeScript } from './csp/script-hash';

/**
 * Builds the documents the sandbox is made of:
 *
 *   host page
 *   ├─ wrapper frame  (library-owned, CSP: frame-src 'none')
 *   │  └─ guest frame (security block first, then untrusted content)
 *   └─ bridge frame   (with fetchBridge: library-owned, its own policy, the hashed bootstrap; buildBridgeDocument)
 *
 * The wrapper exists because no CSP directive limits where a document may navigate *itself*.
 * The embedder's frame-src does: it is checked on every navigation of a child frame, including
 * ones the child starts, and before the request is sent. So the guest cannot carry data out
 * by navigating itself (location.href, links, forms, meta refresh) — research 14.
 */

// Only frame-src: the guest srcdoc inherits this policy, so anything stricter would also bind the guest.
// It has no base-uri on purpose: the wrapper's own <base> (WRAPPER_BASE) must apply. Nothing untrusted
// can add a <base> to the wrapper (it has no script, and the guest is cross-origin to it), and the
// guest's own policy keeps base-uri 'none'.
export const WRAPPER_CSP = "frame-src 'none'";

/**
 * The base URL the guest inherits (backlog S15). A srcdoc document takes its base URL from the document
 * that embeds it, so without this the guest's document.baseURI — and every relative URL it resolves,
 * import.meta.url of an inline module, a link's href — is the host page's full URL: path, query and
 * fragment. The wrapper sets this inert base and the guest inherits it instead; the guest cannot replace
 * it, since its policy has base-uri 'none'.
 *
 * about:blank rather than an https://….invalid URL: a relative URL cannot be resolved against it at
 * all, so relative URLs in guest markup fail closed — no request, not even one that CSP then blocks —
 * where an .invalid base would turn them into real requests that only the policy stops. Absolute URLs
 * (blob: files, workers, allowlisted origins) are unaffected. In Chromium, Firefox
 * and WebKit baseURI and import.meta.url read about:blank; `<img src="x.png">` sends nothing.
 * Relative references to REGISTERED files are resolved by the host before the guest exists
 * (markup-references.ts); every other relative URL still fails closed here.
 */
export const WRAPPER_BASE = 'about:blank';

/**
 * The referrer policy of both frames (backlog S15). Set as the iframe attribute, it decides what the
 * guest's document.referrer is: WebKit otherwise reports the host page's origin there, or its full URL
 * when the host page's own policy allows that. Set as the wrapper's <meta name="referrer">, it is the
 * policy the guest inherits, so the guest's requests carry no Referer by default (Firefox and WebKit
 * otherwise send the host origin on image requests). The guest can choose another policy for its own
 * requests — no document can prevent that. To a cross-site target the Referer it can produce carries at
 * most the host origin (S15 platform limits in docs/BACKLOG.md); to a same-site target WebKit sends the full
 * host URL (S18). And WebKit gives a frame the GUEST creates the host page URL as its document.referrer,
 * because it takes it from the first non-srcdoc document up the tree (S17). Strict mode closes both (ADR-005).
 */
export const FRAME_REFERRER_POLICY = 'no-referrer';

/**
 * The attribute that makes the wrapper iframe credentialless (S74, class A, `INHERITED_CONTEXT.cookies`). Chromium loads
 * a credentialless frame, and every frame and worker nested in it, with an empty, ephemeral cookie jar and storage: no
 * request of the sandbox carries a cookie of the host site's or of the site it is made to, whatever its SameSite value,
 * its kind (fetch, `no-cors`, an image, a stylesheet, a WebSocket) or its destination. Firefox and WebKit have no such
 * attribute and ignore it (cookie-facts.ts says what they send). The frame's popups open `noopener`: the guest's
 * `window.open()` returns null, and the page it opens cannot reach back to the guest.
 */
export const FRAME_CREDENTIALLESS = 'credentialless';

/**
 * The attributes both wrapper iframes (strict, and cooperative or worker mode) carry besides `sandbox` and the
 * permissions: the referrer policy (FRAME_REFERRER_POLICY) and FRAME_CREDENTIALLESS.
 */
export function setWrapperFrameIsolation(iframe: HTMLIFrameElement): void {
    iframe.setAttribute('referrerpolicy', FRAME_REFERRER_POLICY);
    iframe.setAttribute(FRAME_CREDENTIALLESS, '');
}

/**
 * Escapes a value for use inside a double-quoted HTML attribute.
 */
export function escapeAttribute(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/**
 * Serializes a value as a JS literal that is safe to place inside an inline <script>.
 */
export function toInlineScriptLiteral(value: unknown): string {
    // escaping "<" means the literal can never contain "</script>" or "<!--"
    return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export interface GuestDocumentParts {
    csp: string;
    bootstrapScript: string; // trusted script that runs before any guest content
    content?: string; // untrusted markup
    // The bootstrap writes the guest markup itself, with document.write() as its last statement (markup
    // references, markup-references.ts). Then the document ends with the bootstrap script, so what it
    // writes is the rest of the document: not even our </head> follows (a guest <plaintext> would turn
    // it into text). `content` must be empty then.
    bootstrapWritesContent?: boolean;
}

/**
 * Builds the guest document.
 * The security block is *prepended* rather than spliced into the user's markup: the parser then
 * always sees the CSP <meta> first, inside <head>, and the user's own doctype, <html> and <head>
 * tags that follow are ignored (or merged) by the parser. No user content can come before the policy
 * or swallow it (research 11.3).
 */
export function buildGuestDocument(parts: GuestDocumentParts): string {
    // The bootstrap is library text plus literals that escape "<" (toInlineScriptLiteral); asserted anyway,
    // since a build (a consumer's bundler, a minifier) could put "</script" into a library function's source.
    assertParserSafeScript(parts.bootstrapScript);
    const securityBlock = [
        `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(parts.csp)}">`,
        // No CSP directive governs <link rel=dns-prefetch> or rel=preconnect: they resolve a host name, or open a
        // connection, to any origin (BR:PD3). This turns DNS prefetching off for the guest
        // document where an engine honours it (Firefox); what remains is a residual (README), closed by strict mode.
        `<meta http-equiv="x-dns-prefetch-control" content="off">`,
        `<script>${parts.bootstrapScript}</script>`,
    ].join('');

    if (parts.bootstrapWritesContent) {
        if (parts.content) throw new Error('[Sandbox] guest markup is either written by the bootstrap or embedded, not both');
        return `<!DOCTYPE html><html><head>${securityBlock}`;
    }
    return `<!DOCTYPE html><html><head>${securityBlock}</head>${parts.content ?? ''}`;
}

// Legacy attributes for browsers that predate the `allow` attribute for a feature.
// When `allow` covers the feature, the legacy attribute is ignored.
const LEGACY_PERMISSION_ATTRIBUTES: Record<string, string> = {
    fullscreen: 'allowfullscreen',
};

/**
 * The iframe attributes that delegate `permissions` (Permissions Policy features) to a frame.
 * Each feature is granted to `*`: the default allowlist ('src') resolves to a fresh opaque origin
 * for a sandboxed srcdoc frame, which never matches the frame's document, so Firefox and WebKit
 * would deny the feature. The frame can only ever hold our document (it cannot navigate), so `*`
 * grants nothing more.
 */
export function permissionAttributes(permissions: readonly string[]): Record<string, string> {
    if (permissions.length === 0) return {};

    const attributes: Record<string, string> = {
        allow: permissions.map(permission => `${permission} *`).join('; '),
    };
    for (const permission of permissions) {
        const legacy = LEGACY_PERMISSION_ATTRIBUTES[permission];
        if (legacy) attributes[legacy] = '';
    }
    return attributes;
}

/**
 * The start of every wrapper document (buildWrapperDocument): its policy, before anything else. The Trusted Types
 * policy the element assigns a srcdoc through (trusted-types.ts) blesses only HTML that starts with it.
 */
export const WRAPPER_PREFIX = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`;

/**
 * The wrapper's one stylesheet: the guest frame fills the wrapper. A srcdoc document inherits the host page's policy
 * (R1:R3-1), so a host page whose style-src has neither 'unsafe-inline' nor this text's hash
 * (the hash of WRAPPER_STYLE: a constant of the library that docs/API.md#host-page-policy lists, kept equal by test/unit/host-page-policy.test.ts) refuses it.
 * Without it the frame still fills the width and has no border or margin (attributes, which no style-src governs),
 * but is 150 px high: nothing but CSS sizes a frame's height to a parent of auto height, and a srcdoc document is
 * never in quirks mode, where a percentage height would do. The wrapper has no script (it loads exactly once, by
 * design), so a constructed stylesheet is not an option either. Strict mode's view reports its size, and the element
 * warns when the frame came out short (host.ts).
 */
export const WRAPPER_STYLE = 'html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}';

/**
 * Builds the wrapper document that embeds the guest document.
 * The wrapper carries the same sandbox flags as the guest: nested sandbox flags only ever add up,
 * so a stricter wrapper would silently restrict the guest as well.
 * The same goes for `allow` (Permissions Policy): a feature reaches the guest only if every frame
 * on the way delegates it.
 * Sized by WRAPPER_STYLE, and by presentational attributes where a host page's style-src refuses it (see there).
 */
export function buildWrapperDocument(guestDocument: string, sandboxFlags: string, permissions: readonly string[] = []): string {

    let permissionMarkup = '';
    for (const [name, value] of Object.entries(permissionAttributes(permissions))) {
        permissionMarkup += value ? ` ${name}="${escapeAttribute(value)}"` : ` ${name}`;
    }

    const guestFrame = `<iframe sandbox="${escapeAttribute(sandboxFlags)}"${permissionMarkup} referrerpolicy="${FRAME_REFERRER_POLICY}" width="100%" height="100%" frameborder="0" srcdoc="${escapeAttribute(guestDocument)}"></iframe>`;

    // The base and the referrer policy sit in <head>, so both are in force before the parser reaches the
    // guest frame: the guest takes its base URL and referrer policy from the wrapper when it is created.
    const head = `<base href="${WRAPPER_BASE}">`
        + `<meta name="referrer" content="${FRAME_REFERRER_POLICY}">`
        + `<style>${WRAPPER_STYLE}</style>`;

    return `${WRAPPER_PREFIX}${head}</head><body marginwidth="0" marginheight="0">${guestFrame}</body></html>`;
}

/**
 * The start of the fetch bridge's frame document (buildBridgeDocument): its policy, whose first directives are always
 * these (csp-generator.ts, bridgeFramePolicy). The Trusted Types policy the element assigns a srcdoc through
 * (trusted-types.ts) blesses only HTML that starts with it or with WRAPPER_PREFIX.
 */
export const BRIDGE_POLICY_START = "default-src 'none'; script-src ";
export const BRIDGE_PREFIX = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${BRIDGE_POLICY_START}`;

/** The sandbox flags of the fetch bridge's frame: scripts, and an opaque origin of its own (never allow-same-origin). */
export const BRIDGE_FRAME_SANDBOX = 'allow-scripts';

/**
 * Builds the fetch bridge's frame document (BD1:ISO-1; bridge-frame.ts): its policy (bridgeFramePolicy), no referrer,
 * and the library's hashed bootstrap in a script element with the bridge's role (`role`, in-sandbox-view.ts,
 * BRIDGE_ROLE), which runs the bridge's frame there. Nothing else: no guest byte, no markup, no style. Its base is the
 * wrapper's (WRAPPER_BASE): a srcdoc takes the host page's URL as its base otherwise, and the bootstrap's environment
 * check (environment-check.ts, S74) reads about:blank there as in every document of the library's.
 */
export function buildBridgeDocument(csp: string, bootstrap: string, role: string): string {
    if (!csp.startsWith(BRIDGE_POLICY_START)) throw new Error('[Sandbox] the bridge frame document needs the bridge frame policy');
    assertHashableScript(bootstrap);
    return `${BRIDGE_PREFIX}${escapeAttribute(csp.slice(BRIDGE_POLICY_START.length))}"><meta name="referrer" content="${FRAME_REFERRER_POLICY}"><base href="${WRAPPER_BASE}"><script data-role="${escapeAttribute(role)}">${bootstrap}</script></head><body></body></html>`;
}
