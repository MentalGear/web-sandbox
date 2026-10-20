import { WRAPPER_PREFIX } from './frame-documents';

/**
 * The element's HTML sinks on a host page that enforces Trusted Types. Under the host page's
 * `require-trusted-types-for 'script'`, Chromium and WebKit throw a TypeError when a string reaches an HTML sink
 * (measured; R1:R3-1), and the element has two: the wrapper's `srcdoc`, and the inert parse of guest markup it reads before a
 * build (DOMParser: strict mode's script warning, cooperative mode's file references). Without a policy the build fails with "could not
 * be built (TypeError)". Host-side only.
 *
 * Each sink is tried with the string first, so a page that does not enforce Trusted Types never sees a policy of ours.
 * Only when that throws a TypeError and the page has Trusted Types does the element create, once per page, the policy
 * TRUSTED_TYPES_POLICY, kept in this module and never handed out, and repeat the operation through it. Its createHTML
 * blesses only what these two functions ask for, by construction: a wrapper document (it starts with WRAPPER_PREFIX,
 * the wrapper's own policy), or markup while parseInert() is parsing it into an inert document, which runs nothing. A
 * host page whose `trusted-types` directive does not name the policy makes createPolicy throw: TrustedTypesRefusal,
 * which the element turns into a termination whose reason names the policy. The strict view does the same for its own
 * two sinks (in-sandbox-view.ts).
 */
export const TRUSTED_TYPES_POLICY = 'web-sandbox';

/** The host page's trusted-types directive refused the policy name. */
export class TrustedTypesRefusal extends Error {
    override name = 'TrustedTypesRefusal';
}

type HtmlPolicy = { createHTML(input: string): unknown };
let policy: HtmlPolicy | null = null;
let parsing = false; // true only while parseInert() asks the policy for its one input

function htmlPolicy(): HtmlPolicy {
    if (policy) return policy;
    const factory = (globalThis as { trustedTypes?: { createPolicy(name: string, rules: object): HtmlPolicy } }).trustedTypes;
    if (!factory) throw new TrustedTypesRefusal('Trusted Types are not available');
    try {
        policy = factory.createPolicy(TRUSTED_TYPES_POLICY, {
            createHTML: (input: string) => {
                if (typeof input === 'string' && (parsing || input.startsWith(WRAPPER_PREFIX))) return input;
                throw new TypeError(`the ${TRUSTED_TYPES_POLICY} policy creates only the sandbox's own documents`);
            },
        });
    } catch {
        throw new TrustedTypesRefusal(`createPolicy('${TRUSTED_TYPES_POLICY}') was refused`);
    }
    return policy;
}

// A Trusted Types refusal of a string: a TypeError on a page that has Trusted Types.
const refusedByTrustedTypes = (error: unknown) => error instanceof TypeError && 'trustedTypes' in globalThis;

/** Sets `iframe.srcdoc` to a wrapper document, through the policy only where the page requires one. */
export function setWrapperSrcdoc(iframe: HTMLIFrameElement, wrapper: string): void {
    try {
        iframe.srcdoc = wrapper;
        return;
    } catch (error) {
        if (!refusedByTrustedTypes(error)) throw error;
    }
    iframe.srcdoc = htmlPolicy().createHTML(wrapper) as string;
}

/** Parses markup into an inert document (no browsing context: nothing in it runs or loads), as DOMParser does. */
export function parseInert(markup: string): Document {
    try {
        return new DOMParser().parseFromString(markup, 'text/html');
    } catch (error) {
        if (!refusedByTrustedTypes(error)) throw error;
    }
    const trustedPolicy = htmlPolicy();
    let trusted: unknown;
    parsing = true;
    try {
        trusted = trustedPolicy.createHTML(markup);
    } finally {
        parsing = false;
    }
    return new DOMParser().parseFromString(trusted as string, 'text/html');
}
