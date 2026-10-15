/**
 * This function is stringified and injected into the sandbox frame in worker mode.
 * It spawns the guest worker from *inside* the frame, so the worker inherits the frame's
 * opaque origin and CSP instead of the host's, and connects it to the host.
 *
 * The announcement (broad review 2026-10-14, CB1), as in cooperative mode (in-sandbox-script.ts): the frame's first
 * statement makes the channel, posts port2 to the host page (the frame's parent is the wrapper, whose parent is the
 * host) as the one SANDBOX_PORT message the host accepts from this frame's window, and hands port1 to the worker as
 * its one INIT_PORT. No port is ever received here, so there is nothing for another frame on the host page to
 * race (review B1), and no guest code runs in this frame (worker mode has no guest markup).
 *
 * Under a host page's Trusted Types requirement (review round 1, R3-1), which this srcdoc frame inherits, the Worker
 * constructor refuses a string (Chromium, WebKit): the worker never started, and the sandbox stayed `ready` with nothing
 * behind it. The URL is tried as a string first, then through a policy of this frame's own named like the element's
 * (trusted-types.ts; the host page's trusted-types directive admits it already), whose rule passes the worker's URL.
 */
export function workerBootstrap(workerSource: string, trustedTypesPolicy?: string) {
    const channel = new MessageChannel();
    parent.parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [channel.port2]);
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    let worker: Worker;
    try {
        worker = new Worker(workerUrl);
    } catch (error) {
        const factory = (globalThis as any).trustedTypes;
        if (!(error instanceof TypeError) || !factory || !trustedTypesPolicy) throw error;
        const policy = factory.createPolicy(trustedTypesPolicy, { createScriptURL: (url: string) => url });
        worker = new Worker(policy.createScriptURL(workerUrl));
    }
    worker.postMessage({ type: 'INIT_PORT' }, [channel.port1]);
}
