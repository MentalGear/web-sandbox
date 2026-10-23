/**
 * The host page's Content-Security-Policy, read once per page load when the embedder did not give it
 * (`hostContentSecurityPolicy`; INHERITED_CONTEXT.cspFetch). A page cannot be asked for its policy: no API returns it, and
 * a `<meta>` is only part of it. A browser tells it only with a violation report: `securitypolicyviolation.originalPolicy`
 * is the whole text of the policy that blocked.
 *
 * So the library causes one deliberate violation, on a request that cannot leave the browser: a `fetch()` of a decoy host
 * under `.invalid` (a name that can never exist, RFC 6761) on port 6000, which every engine refuses after the policy's
 * check and before any DNS lookup or connection. It runs in a hidden, empty `about:blank` frame that the element adds to
 * its shadow root and removes at once, and which inherits the page's policy list:
 *  - the frame holds no script, so the page's `script-src` does not matter (a script of ours in the frame would be
 *    refused by every strict page) and nothing runs in it; the host's own code calls the frame window's `fetch` and
 *    listens on the frame's document, so the page's own `securitypolicyviolation` listeners (an error tracker's) see
 *    nothing;
 *  - the decoy is plain http: a policy that refuses https hosts refuses it too, and so does one that admits only https
 *    (`connect-src https:`), which an https decoy would not see. The check of the policy comes before the mixed-content
 *    check in every engine, so an https page sees the same (measured, test/e2e/connect-uniform.spec.ts);
 *  - a policy that admits it gives no event, and a Report-Only policy reports with `disposition: report` and is ignored.
 * What a page sees of it: one console line for the refused port in Chromium and WebKit, whatever the policy (CONNECT_ENGINE_FACTS),
 * and when a policy refuses the decoy one line for the refusal and one CSP report to that policy's `report-uri`. Nothing
 * reaches the network or the DNS.
 *
 * The read is made lazily, by the first build that lists a connect origin (host.ts): the page's policy is cached for the
 * page, and the build waits for it. Where the read cannot run (a document with no frame that can fetch: a unit test's
 * jsdom), it is "unknown" at once and nothing is narrowed.
 *
 * Host-side only, never stringified into a guest.
 */

/** Port 6000 is on every engine's list of ports a request is refused for (the X11 ports), after the CSP check. */
export const DECOY_PORT = 6000;
export const DECOY_HOST = 'web-sandbox-policy-read.invalid';
/** The one decoy request: plain http, see the module comment for why. */
export const DECOY_URL = `http://${DECOY_HOST}:${DECOY_PORT}/`;
/** How long after the decoys settled the frame waits for their events (they are queued tasks; measured under 10 ms). */
export const SETTLE_MS = 50;
/** How long the read may take in all before it gives up and the page's policy is unknown. */
export const READ_TIMEOUT_MS = 2000;

/** What is known of the page's policy: the texts of the enforced policies that refused a decoy (empty: none did), or null (unknown). */
export type HostPolicies = readonly string[] | null;

let known: HostPolicies | undefined; // undefined: not read yet
let failed = false; // the read gave up (a frame that never loaded): unknown, and the element says so
let inflight: Promise<void> | null = null;

/** The page's policies as read, or undefined while they are not known yet (and null where they cannot be read). */
export const knownHostPolicies = (): HostPolicies | undefined => known;

/** Whether the read gave up, as opposed to a document that cannot make it. */
export const hostPolicyReadFailed = (): boolean => failed;

/** Forgets what was read, for a test that stands in for a new page. */
export function forgetHostPolicies(): void {
    known = undefined;
    failed = false;
    inflight = null;
}

/**
 * Starts the read if it was not, and returns the promise that settles when it is known, or null when it already is (or
 * cannot be made: unknown at once). The promise never rejects. `parent` is where the hidden frame goes (the element's
 * shadow root).
 */
export function whenHostPoliciesKnown(parent: ParentNode): Promise<void> | null {
    if (known !== undefined) return null;
    if (inflight) return inflight;
    const frame = document.createElement('iframe');
    frame.hidden = true; // the user agent's own style: no style-src governs it
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    const loaded = new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }));
    try {
        parent.appendChild(frame);
    } catch {
        return null;
    }
    // a parent that is not in a document has no frame to read from: not an answer, and not cached
    if (!frame.isConnected) {
        frame.remove();
        return null;
    }
    if (!canFetch(frame)) {
        frame.remove();
        known = null;
        return null;
    }
    const finish = (policies: HostPolicies | undefined, gaveUp: boolean) => {
        frame.remove();
        inflight = null;
        // undefined: the frame was taken out of the document under the read (the element was removed): read again at the next build
        if (policies !== undefined) known = policies;
        if (gaveUp) failed = true;
    };
    inflight = new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const giveUp = new Promise<'timeout'>(over => { timer = setTimeout(() => over('timeout'), READ_TIMEOUT_MS); });
        void Promise.race([read(frame, loaded), giveUp]).then(result => {
            clearTimeout(timer);
            if (result === 'timeout') finish(null, true);
            else finish(result, false);
        }, () => finish(null, true)).then(() => resolve());
    });
    return inflight;
}

// Whether the frame's window has a fetch (a jsdom window has none, and a read there is unknown at once).
function canFetch(frame: HTMLIFrameElement): boolean {
    return typeof frame.contentWindow?.fetch === 'function';
}

// The deliberate violation: the decoy from the frame's window, the events on the frame's document.
async function read(frame: HTMLIFrameElement, loaded: Promise<void>): Promise<HostPolicies | undefined> {
    await loaded;
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!frame.isConnected || !win || !doc || !canFetch(frame)) return undefined;
    const seen: string[] = [];
    const onViolation = (event: Event) => {
        const { disposition, originalPolicy } = event as SecurityPolicyViolationEvent;
        if (disposition === 'enforce' && typeof originalPolicy === 'string' && !seen.includes(originalPolicy)) seen.push(originalPolicy);
    };
    doc.addEventListener('securitypolicyviolation', onViolation);
    try {
        await win.fetch(DECOY_URL, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(() => undefined, () => undefined);
        await new Promise<void>(resolve => setTimeout(resolve, SETTLE_MS));
    } finally {
        doc.removeEventListener('securitypolicyviolation', onViolation);
    }
    // a frame that left the document under the read saw nothing: not an answer
    return frame.isConnected && frame.contentDocument === doc ? Object.freeze(seen) : undefined;
}
