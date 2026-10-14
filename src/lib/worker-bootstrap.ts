/**
 * This function is stringified and injected into the sandbox frame in worker mode.
 * It spawns the guest worker from *inside* the frame, so the worker inherits the frame's
 * opaque origin and CSP instead of the host's, and hands it the host's MessagePort.
 *
 * It forwards exactly one INIT_PORT (review B1): a trusted message from the host page (the frame's parent is
 * the wrapper, whose parent is the host) carrying exactly one port. Anything else — a message from another
 * frame on the host page, one without a port — is ignored, and the listener stays until the host's arrives.
 * No guest code runs in this frame (worker mode has no guest markup), so the event is read directly.
 */
export function workerBootstrap(workerSource: string) {
    const host = parent.parent;
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const worker = new Worker(workerUrl);

    const onMessage = (event: MessageEvent) => {
        if (!event.isTrusted || event.source !== host) return;
        if (event.data?.type !== 'INIT_PORT' || event.ports.length !== 1) return;
        globalThis.removeEventListener('message', onMessage);
        worker.postMessage({ type: 'INIT_PORT' }, [event.ports[0] as MessagePort]);
    };
    globalThis.addEventListener('message', onMessage);
}
