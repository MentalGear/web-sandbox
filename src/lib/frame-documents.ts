/**
 * Builds the two documents the sandbox is made of:
 *
 *   host page
 *   └─ wrapper frame  (library-owned, CSP: frame-src 'none')
 *      └─ guest frame (security block first, then untrusted content)
 *
 * The wrapper exists because no CSP directive limits where a document may navigate *itself*.
 * The embedder's frame-src does: it is checked on every navigation of a child frame, including
 * ones the child starts, and before the request is sent. So the guest cannot carry data out
 * by navigating itself (location.href, links, forms, meta refresh) — research 14.
 */

// Only frame-src: the guest srcdoc inherits this policy, so anything stricter would also bind the guest.
export const WRAPPER_CSP = "frame-src 'none'";

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
    baseHref?: string;
    content?: string; // untrusted markup
}

/**
 * Builds the guest document.
 * The security block is *prepended* rather than spliced into the user's markup: the parser then
 * always sees the CSP <meta> first, inside <head>, and the user's own doctype, <html> and <head>
 * tags that follow are ignored (or merged) by the parser. No user content can come before the policy
 * or swallow it (research 11.3).
 */
export function buildGuestDocument(parts: GuestDocumentParts): string {
    const base = parts.baseHref ? `<base href="${escapeAttribute(parts.baseHref)}">` : '';

    const securityBlock = [
        `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(parts.csp)}">`,
        base,
        `<script>${parts.bootstrapScript}</script>`,
    ].join('');

    return `<!DOCTYPE html><html><head>${securityBlock}</head>${parts.content ?? ''}`;
}

/**
 * Builds the wrapper document that embeds the guest document.
 * The wrapper carries the same sandbox flags as the guest: nested sandbox flags only ever add up,
 * so a stricter wrapper would silently restrict the guest as well.
 */
export function buildWrapperDocument(guestDocument: string, sandboxFlags: string): string {
    const style = `<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style>`;
    const guestFrame = `<iframe sandbox="${escapeAttribute(sandboxFlags)}" srcdoc="${escapeAttribute(guestDocument)}"></iframe>`;

    return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">${style}</head><body>${guestFrame}</body></html>`;
}
