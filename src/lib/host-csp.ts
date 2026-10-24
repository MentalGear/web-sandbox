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
 * The read is made lazily, by the first build that lists a connect origin (host.ts), and the page's policy is cached for
 * the page. Its frame is a resource of the page that one element holds in its shadow root while other elements' builds
 * wait on it (S74, class L), so no element's removal answers for another element's build:
 *  - every build that asks is a waiter, and only a read whose frame stayed in the document from its insertion to its
 *    answer answers it;
 *  - a frame that leaves the document gives no answer and caches nothing. Its element's disconnection says so at once
 *    (hostPolicyReaderLeft); a frame removed or reloaded otherwise is noticed after its load, or at READ_TIMEOUT_MS. The
 *    read then starts again in a new frame, in the shadow root of a waiter still in the document, up to READ_FRAMES
 *    frames for one set of waiters;
 *  - when no waiter is left in the document, or the frames ran out, the waiters go on without an answer, and a build
 *    that asked narrows its connect lists to nothing, with a warning (host-connect.ts, hostReach): it fails closed;
 *  - "cannot be read" (null) is cached for the page only from a frame that stayed in the document: a document with no
 *    frame that can fetch (a unit test's jsdom, unknown at once), and a frame that never loaded within READ_TIMEOUT_MS
 *    (said with a warning). Neither is narrowed by the library; the browser still applies the page's policy.
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
/** How long one frame's read may take before it gives up: the page's policy is then unknown, if the frame stayed in the document. */
export const READ_TIMEOUT_MS = 2000;
/** How many frames one read may lose (their element removed or moved under it) before its waiting builds go on without an answer. */
export const READ_FRAMES = 4;

/** What is known of the page's policy: the texts of the enforced policies that refused a decoy (empty: none did), or null (unknown). */
export type HostPolicies = readonly string[] | null;

let known: HostPolicies | undefined; // undefined: not read yet
let failed = false; // the read gave up (a frame that stayed in the document and never loaded): unknown, and the element says so

// A build that waits for the answer: the shadow root its element reads from, and its wait's end.
interface Waiter {
    readonly parent: ParentNode;
    readonly settle: () => void;
}
let waiters: Waiter[] = [];
// The read in progress: the parent of its frame, and how to stop it (the frame removed, its timer cleared, its answer ignored).
let reading: { readonly parent: ParentNode; readonly stop: () => void } | null = null;
let framesLost = 0; // frames the current waiters' read lost
let restartQueued = false;

/** The page's policies as read, or undefined while they are not known yet (and null where they cannot be read). */
export const knownHostPolicies = (): HostPolicies | undefined => known;

/** Whether the read gave up, as opposed to a document that cannot make it. */
export const hostPolicyReadFailed = (): boolean => failed;

/** Forgets what was read, and ends every wait without an answer, for a test that stands in for a new page. */
export function forgetHostPolicies(): void {
    stopReading();
    settleWaiters();
    known = undefined;
    failed = false;
    restartQueued = false;
}

const isConnected = (parent: ParentNode): boolean => (parent as Node).isConnected === true;

/**
 * Asks for the page's policy on behalf of one build: starts the read if none runs, and returns the promise that settles
 * when the build may go on, or null when the policy is known already (or cannot be read: unknown at once). The promise
 * never rejects. It settles when the policy is known, when the build's element left the document (hostPolicyReaderLeft),
 * or when the read has no frame left to try (no waiter in the document, READ_FRAMES lost): then nothing is known, and the
 * build narrows to nothing (host-connect.ts, hostReach). `parent` is the element's shadow root: where the hidden frame
 * goes if this build's element is the one to read.
 */
export function whenHostPoliciesKnown(parent: ParentNode): Promise<void> | null {
    if (known !== undefined) return null;
    // a parent that is not in a document has no frame to read from: not an answer, and not cached
    if (!isConnected(parent)) return null;
    let settle!: () => void;
    const answered = new Promise<void>(resolve => { settle = resolve; });
    waiters.push({ parent, settle });
    if (!reading && !restartQueued) startRead();
    return known !== undefined ? null : answered;
}

/**
 * The element whose shadow root is `parent` left the document (removed, moved or adopted; host.ts calls it from the
 * element's disconnection): its builds' waits end now (their builds were torn down), and a read whose frame it held gave
 * no answer: it starts again, at once, from a waiter still in the document.
 */
export function hostPolicyReaderLeft(parent: ParentNode): void {
    const leaving = waiters.filter(waiter => waiter.parent === parent);
    if (leaving.length > 0) {
        waiters = waiters.filter(waiter => waiter.parent !== parent);
        for (const waiter of leaving) waiter.settle();
    }
    if (reading?.parent === parent) lose();
}

function stopReading(): void {
    const current = reading;
    reading = null;
    current?.stop();
}

// The read's frame left the document, or was reloaded under it: no answer, nothing cached. The read starts again once the
// current task's DOM changes are done (one element moved with others, or a list reordered, loses one frame, not one each).
function lose(): void {
    stopReading();
    framesLost++;
    if (restartQueued) return;
    restartQueued = true;
    queueMicrotask(() => {
        restartQueued = false;
        if (!reading && known === undefined) startRead();
    });
}

function settleWaiters(): void {
    const all = waiters;
    waiters = [];
    framesLost = 0;
    for (const waiter of all) waiter.settle();
}

function conclude(policies: HostPolicies, gaveUp: boolean): void {
    known = policies;
    if (gaveUp) failed = true;
    settleWaiters();
}

// One frame's read, in the shadow root of the first waiter still in the document.
function startRead(): void {
    const gone = waiters.filter(waiter => !isConnected(waiter.parent));
    if (gone.length > 0) {
        waiters = waiters.filter(waiter => isConnected(waiter.parent));
        for (const waiter of gone) waiter.settle();
    }
    const parent = waiters[0]?.parent;
    if (parent === undefined || framesLost >= READ_FRAMES) {
        settleWaiters(); // no answer: a build that asked narrows to nothing
        return;
    }
    const frame = document.createElement('iframe');
    frame.hidden = true; // the user agent's own style: no style-src governs it
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    let loads = 0;
    const loaded = new Promise<void>(resolve => frame.addEventListener('load', () => { loads++; resolve(); }));
    try {
        parent.appendChild(frame);
    } catch {
        settleWaiters();
        return;
    }
    if (!frame.isConnected) {
        frame.remove();
        settleWaiters();
        return;
    }
    if (!canFetch(frame)) {
        frame.remove();
        conclude(null, false);
        return;
    }
    let over = false;
    // A frame still in the document and loaded at most once is the one the read started with.
    const intact = () => frame.isConnected && loads <= 1;
    const timer = setTimeout(() => {
        if (over) return;
        if (intact()) {
            stopReading();
            conclude(null, true);
        } else {
            lose();
        }
    }, READ_TIMEOUT_MS);
    reading = {
        parent,
        stop: () => {
            over = true;
            clearTimeout(timer);
            frame.remove();
        },
    };
    void read(frame, loaded).then(result => {
        if (over) return;
        if (result === undefined) {
            lose();
            return;
        }
        stopReading();
        conclude(result, false);
    }, () => {
        if (over) return;
        if (!intact()) {
            lose();
            return;
        }
        stopReading();
        conclude(null, true);
    });
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
