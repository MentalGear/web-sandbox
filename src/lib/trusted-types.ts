import { BRIDGE_PREFIX, WRAPPER_PREFIX } from './frame-documents';

/**
 * The element's HTML sinks on a host page that enforces Trusted Types. Under the host page's
 * `require-trusted-types-for 'script'`, Chromium and WebKit throw a TypeError when a string reaches an HTML sink
 * (measured; R1:R3-1), and the element has three: the wrapper's `srcdoc`, the fetch bridge's frame's `srcdoc`, and the inert parse of guest markup it reads before a
 * build (DOMParser: strict mode's script warning, cooperative mode's file references). Without a policy the build fails with "could not
 * be built (TypeError)". Host-side only.
 *
 * A page cannot be asked whether it enforces Trusted Types, and a string that an enforcing page refuses is reported to
 * it (a `securitypolicyviolation` event, a console error, its `report-uri`) even when the refusal is caught. So where the
 * browser has Trusted Types, every sink goes through the library's policy from the first write: the element creates, once
 * per page, the policy TRUSTED_TYPES_POLICY, kept in this module and never handed out. Its createHTML
 * blesses only what these functions ask for, by construction: a wrapper document (it starts with WRAPPER_PREFIX,
 * the wrapper's own policy), the bridge frame's document (it starts with BRIDGE_PREFIX, its own policy), or markup while parseInert() is parsing it into an inert document, which runs nothing. A page that enforces
 * Trusted Types therefore gets no violation from the library's own writes (class B: the library's write agrees with
 * the browser's rule instead of probing it). A host page whose `trusted-types` directive does not name the policy makes
 * createPolicy throw (once; the refusal is kept): the sinks are then written as strings, as on a page that has no
 * Trusted Types, and where the page refuses a string too (no default policy of its own) the element turns the
 * refusal into TrustedTypesRefusal, which ends the build with a reason that names the policy. The strict view and the
 * worker mode's frame do the same for their own sinks (in-sandbox-view.ts, worker-bootstrap.ts).
 */
export const TRUSTED_TYPES_POLICY = 'web-sandbox';

/** The host page's trusted-types directive refused the policy name. */
export class TrustedTypesRefusal extends Error {
    override name = 'TrustedTypesRefusal';
}

type HtmlPolicy = { createHTML(input: string): unknown };
let policy: HtmlPolicy | null = null;
let refused = false; // createPolicy threw: the host page's trusted-types directive does not name the policy
let parsing = false; // true only while parseInert() asks the policy for its one input

/** The library's policy, created on first use; null where the browser has no Trusted Types or the host page refused the policy's name. */
function htmlPolicy(): HtmlPolicy | null {
    if (policy || refused) return policy;
    const factory = (globalThis as { trustedTypes?: { createPolicy(name: string, rules: object): HtmlPolicy } }).trustedTypes;
    if (!factory) return null;
    try {
        policy = factory.createPolicy(TRUSTED_TYPES_POLICY, {
            createHTML: (input: string) => {
                if (typeof input === 'string' && (parsing || input.startsWith(WRAPPER_PREFIX) || input.startsWith(BRIDGE_PREFIX))) return input;
                throw new TypeError(`the ${TRUSTED_TYPES_POLICY} policy creates only the sandbox's own documents`);
            },
        });
    } catch {
        refused = true;
    }
    return policy;
}

// A Trusted Types refusal of a string: a TypeError on a page that has Trusted Types, and the policy was refused too.
const refusal = (error: unknown) => (error instanceof TypeError && 'trustedTypes' in globalThis ? new TrustedTypesRefusal(`createPolicy('${TRUSTED_TYPES_POLICY}') was refused`) : error);

/** Sets `iframe.srcdoc` to a document of the library's (a wrapper, or the bridge's frame), through the library's policy where the browser has Trusted Types. */
export function setLibrarySrcdoc(iframe: HTMLIFrameElement, wrapper: string): void {
    const trusted = htmlPolicy();
    try {
        iframe.srcdoc = trusted ? trusted.createHTML(wrapper) as string : wrapper;
    } catch (error) {
        throw trusted ? error : refusal(error);
    }
}

/** Parses markup into an inert document (no browsing context: nothing in it runs or loads), as DOMParser does. */
export function parseInert(markup: string): Document {
    const trustedPolicy = htmlPolicy();
    if (!trustedPolicy) {
        try {
            return new DOMParser().parseFromString(markup, 'text/html');
        } catch (error) {
            throw refusal(error);
        }
    }
    let trusted: unknown;
    parsing = true;
    try {
        trusted = trustedPolicy.createHTML(markup);
    } finally {
        parsing = false;
    }
    return new DOMParser().parseFromString(trusted as string, 'text/html');
}
