/**
 * This function is stringified and injected into the sandbox (Iframe or Worker).
 * It handles the initial handshake and sets up the communication bridge.
 */
export function inSandboxScript(scriptUnsafe: boolean, mode: 'iframe' | 'worker', sandboxConsole: Console) {
    globalThis.addEventListener('message', (event: any) => {
        if (event.data?.type === 'INIT_PORT') {
            const port = event.ports[0];

            port.onmessage = (ev: any) => {
                if (ev.data.type === 'EXECUTE') {
                    try {
                        // try ensures the code execution itself doesn't crash the port logic
                        if (!scriptUnsafe) throw new Error("Execution blocked: scriptUnsafe is false");
                        const func = new Function(ev.data.code);
                        func();
                    } catch (e: any) {
                        port.postMessage({ type: 'LOG', level: 'error', args: [e.message] });
                    }
                }
            };

            (['log', 'error', 'warn'] as const).forEach(level => {
                const original = sandboxConsole[level];
                sandboxConsole[level] = (...args: any[]) => {
                    port.postMessage({ type: 'LOG', level, args });
                    // Log to the actual browser console for easier debugging
                    if (original) {
                        original.apply(sandboxConsole, args);
                    }
                };
            });

            port.postMessage({ type: 'LOG', level: 'info', args: [`${mode} Ready`] });
        }
    }, { once: true });
}