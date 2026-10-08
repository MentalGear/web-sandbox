/**
 * This function is stringified and injected into the sandbox frame in worker mode.
 * It spawns the guest worker from *inside* the frame, so the worker inherits the frame's
 * opaque origin and CSP instead of the host's, and hands it the host's MessagePort.
 */
export function workerBootstrap(workerSource: string) {
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const worker = new Worker(workerUrl);

    const onMessage = (event: MessageEvent) => {
        if (event.data?.type !== 'INIT_PORT') return;
        globalThis.removeEventListener('message', onMessage);
        worker.postMessage({ type: 'INIT_PORT' }, [event.ports[0] as MessagePort]);
    };
    globalThis.addEventListener('message', onMessage);
}
