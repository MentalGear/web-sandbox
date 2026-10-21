/**
 * Worker mode's frame bootstrap: stringified and injected into the sandbox frame.
 * It spawns the guest worker from *inside* the frame, so the worker inherits the frame's
 * opaque origin and CSP instead of the host's, and connects it to the host.
 *
 * The announcement (BR:CB1), as in cooperative mode (in-sandbox-script.ts): the frame makes the
 * channel, hands port1 to the worker as its one INIT_PORT, and posts port2 to the host page (the frame's parent is the
 * wrapper, whose parent is the host) as the one SANDBOX_PORT message the host accepts from this frame's window. No port
 * is ever received here, so there is nothing for another frame on the host page to race (AR:B1), and no guest code
 * runs in this frame (worker mode has no guest markup).
 *
 * The port is announced only once the worker runs (R2:C-5): the worker tells this frame WORKER_STARTED once
 * it has attached port1 (in-sandbox-script.ts). The announcement is the host's `ready`, so it cannot come before the
 * Worker runs: under a host page's worker-src without blob: the worker never runs, and a `ready` sandbox would have
 * nothing behind its port (calls hung until their timeout). A worker that cannot start is the one
 * announcement instead, a refusal with no port, and the host ends the build with the reason strict mode gives for it:
 *   'worker'         the policy refused the worker (a SecurityError from the constructor, or an error event with no
 *                    message before it started: the script was never loaded; all three engines);
 *   'trusted-types'  the policy name is refused (below);
 *   'failed'         the worker's script threw before it started (an error event with a message): a library bug.
 *
 * Under a host page's Trusted Types requirement (R1:R3-1), which this srcdoc frame inherits, the Worker
 * constructor refuses a string (Chromium, WebKit) and the host page is told of every string it refuses. The URL goes
 * through a policy of this frame's own, named like the element's (trusted-types.ts), whose rule passes the worker's URL,
 * from the first write. A host page whose trusted-types directive does not name it makes createPolicy throw here, also
 * when the host page itself never needed the policy (its own default policy took the element's strings, R2:C-6): the URL
 * is then written as a string, and where that is refused too the refusal says so.
 */
export function workerBootstrap(workerSource: string, trustedTypesPolicy?: string) {
    const refuse = (refused: 'worker' | 'trusted-types' | 'failed') => parent.parent.postMessage({ type: 'SANDBOX_PORT', refused }, '*');
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    let worker: Worker;
    // The URL goes through the frame's own policy from the first write (no string for a host page that enforces Trusted
    // Types to report), when there is one; if the host page refused the policy's name, as a string, which a page that
    // requires Trusted Types refuses too.
    const factory = (globalThis as any).trustedTypes;
    let policy: { createScriptURL(url: string): unknown } | null = null;
    if (factory && trustedTypesPolicy) {
        try {
            policy = factory.createPolicy(trustedTypesPolicy, { createScriptURL: (url: string) => url });
        } catch {
            policy = null;
        }
    }
    try {
        worker = new Worker(policy ? policy.createScriptURL(workerUrl) as string : workerUrl);
    } catch (error) {
        refuse(!policy && error instanceof TypeError && factory && trustedTypesPolicy ? 'trusted-types' : 'worker');
        return;
    }
    const channel = new MessageChannel();
    let started = false;
    // The worker's one message to this frame, WORKER_STARTED; once it arrived the frame stops listening (R4:M-1): the port it announces is the only channel from then on. The worker has no postMessage left for guest code
    // anyway (worker-globals.ts), so nothing else is ever posted here.
    worker.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (started || !data || data.type !== 'WORKER_STARTED') return;
        started = true;
        worker.onmessage = null;
        parent.parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [channel.port2]);
    };
    worker.onerror = (event: ErrorEvent) => {
        if (started) return; // a later error is the guest's: the worker logs it, and the frame's console shows it
        started = true;
        refuse(event.message ? 'failed' : 'worker');
    };
    worker.postMessage({ type: 'INIT_PORT' }, [channel.port1]);
}
