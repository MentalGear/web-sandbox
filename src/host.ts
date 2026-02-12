export const ALLOWED_CAPABILITIES = [
    "allow-downloads",
    "allow-forms",
    "allow-modals",
    "allow-orientation-lock",
    "allow-pointer-lock",
    "allow-popups",
    "allow-presentation",
    "allow-scripts",
] as const;

export type SandboxCapability = typeof ALLOWED_CAPABILITIES[number];

export interface SandboxConfig {
    allow?: string[]; // Allowed domains for CSP
    // TODO: maybe add a warning/error when scriptUnsafe is active, that it should only be used for testing, never in production (depends on whether webcontent works in it witout it)
    scriptUnsafe?: boolean; // 'unsafe-eval', needed to use .execute method (run arbitrary code in the sandbox)
    capabilities?: SandboxCapability[]; // Custom sandbox attributes for iframe mode
    html?: string; // Initial HTML content for iframe mode
    virtualFilesUrl?: string; // URL to the Virtual Files Hub
    mode?: 'iframe' | 'worker'; // Execution mode
    workerExecutionTimeout?: number; // Max execution time in ms (Worker mode only)
}

export class LofiSandbox extends HTMLElement {
    private _iframe: HTMLIFrameElement | null = null;
    private _worker: Worker | null = null;
    private _workerUrl: string | null = null;
    private _config: SandboxConfig = {
        allow: [],
        scriptUnsafe: false,
        capabilities: [],
        html: '',
        virtualFilesUrl: '',
        mode: 'iframe',
        workerExecutionTimeout: 0, // 0 = unlimited
    };
    private _sessionId: string;
    private _port: MessagePort | null = null;
    private _hubFrame: HTMLIFrameElement | null = null;
    private _timeoutId: ReturnType<typeof setTimeout> | null = null;
    private _queuedMessages: { code: string }[] = [];

    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this._sessionId = crypto.randomUUID();
    }

    connectedCallback() {
        this.initialize();
    }

    setConfig(config: SandboxConfig) {
        this._config = { ...this._config, ...config };

        // Filter out any forbidden capabilities that might have been passed
        if (this._config.capabilities) {
            this._config.capabilities = this._config.capabilities.filter(
                cap => ALLOWED_CAPABILITIES.includes(cap as SandboxCapability)
            );
        }

        if (this._config.virtualFilesUrl && !this._hubFrame) {
            this._hubFrame = document.createElement('iframe');
            this._hubFrame.style.display = 'none';
            this._hubFrame.src = `${this._config.virtualFilesUrl}/hub.html`;
            document.body.appendChild(this._hubFrame);
        }

        this.initialize();
    }

    registerFiles(files: Record<string, string | Uint8Array>) {

        if (this._hubFrame && this._hubFrame.contentWindow) {
            let targetOrigin = this._config.virtualFilesUrl || '*';
            if (targetOrigin.startsWith('/')) {
                targetOrigin = new URL(targetOrigin, window.location.origin).origin;
            }

            this._hubFrame.contentWindow.postMessage({
                type: 'PUT_FILES',
                sessionId: this._sessionId,
                files
            }, targetOrigin);

            // Notify listeners that the virtual file system has been updated
            this.dispatchEvent(new CustomEvent('fileschanged', { detail: files }));
            
        } else {
            console.warn("Virtual Files Hub not ready or configured");
        }
    }

    load(html: string) {
        this._config.html = html;
        this.initialize();
    }

    execute(code: string) {
        if (this._port) {
            // this._startTimeout();
            this._port.postMessage({ type: 'EXECUTE', code });
        } else {
            this._queuedMessages.push({ code });
        }
    }

    private _startTimeout() {
        if (this._timeoutId) clearTimeout(this._timeoutId);

        if (this._config.mode === 'worker' && this._config.workerExecutionTimeout && this._config.workerExecutionTimeout > 0) {
            this._timeoutId = setTimeout(() => {
                console.warn("[Sandbox] Execution Timeout - Terminating Worker");
                window.dispatchEvent(new CustomEvent('sandbox-log', { detail: { type: 'LOG', level: 'error', args: ['Execution Timeout'] } }));

                if (this._worker) {
                    this._cleanupWorker();
                    if (this._port) { this._port.close(); this._port = null; }
                    this.spawnWorker();
                }
            }, this._config.workerExecutionTimeout);
        }
    }

    private setupChannel(target: Window | Worker) {
        if (this._port) { this._port.close(); this._port = null; }
        const channel = new MessageChannel();
        this._port = channel.port1;
        this._port.onmessage = (e) => {
            if (e.data.type === 'LOG') {
                window.dispatchEvent(new CustomEvent('sandbox-log', { detail: e.data }));
            }
        };

        if (target instanceof Worker) {
            target.postMessage({ type: 'INIT_PORT' }, [channel.port2]);
        } else {
            (target as Window).postMessage({ type: 'INIT_PORT' }, '*', [channel.port2]);
        }

        // Flush any messages queued during initialization
        if (this._queuedMessages.length > 0) {
            const pending = [...this._queuedMessages];
            this._queuedMessages = [];
            pending.forEach(msg => this.execute(msg.code));
        }
    }

    private _cleanupWorker() {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        if (this._workerUrl) {
            URL.revokeObjectURL(this._workerUrl);
            this._workerUrl = null;
        }
    }

    private initialize() {
        this._queuedMessages = []; // Clear queue for the old environment
        if (this._iframe) { this._iframe.remove(); this._iframe = null; }
        this._cleanupWorker();
        if (this._port) { this._port.close(); this._port = null; }
        if (this._timeoutId) clearTimeout(this._timeoutId);

        if (this._config.mode === 'worker') {
            // TODO: Assess How secure is this, if the worker is not in the iframe ?
            // The actual idea was to put the worker in the iframe
            this.spawnWorker();
        } else {
            this.createIframe();
        }
    }

    private spawnWorker() {
        // TODO: describe: Spawn where ? host or sandbox ? and what ? sw ? webworkeR?
        const script = `
            self.onmessage = (e) => {
                if (e.data.type === 'INIT_PORT') {
                    const port = e.ports[0];
                    port.onmessage = (ev) => {
                        if (ev.data.type === 'EXECUTE') {
                            try {
                                const func = new Function(ev.data.code);
                                func();
                            } catch (err) {
                                port.postMessage({ type: 'LOG', level: 'error', args: [err.message] });
                            }
                        }
                    };
                    ['log', 'error', 'warn'].forEach(level => {
                        const original = console[level];
                        console[level] = (...args) => {
                            port.postMessage({ type: 'LOG', level, args });
                        };
                    });
                    port.postMessage({ type: 'LOG', level: 'info', args: ['Worker Ready'] });
                }
            };
        `;
        const blob = new Blob([script], { type: 'application/javascript' });
        this._workerUrl = URL.createObjectURL(blob);
        this._worker = new Worker(this._workerUrl);
        this._worker.onerror = (err) => {
            window.dispatchEvent(new CustomEvent('sandbox-log', { 
                detail: { type: 'LOG', level: 'error', args: [`Worker Error: ${err.message}`] } 
            }));
        };
        this.setupChannel(this._worker);
        setTimeout(() => this.dispatchEvent(new CustomEvent('ready')), 0);
    }

    private createIframe() {
        this._iframe = document.createElement("iframe");
        const caps = this._config.capabilities || [];
        this._iframe.setAttribute("sandbox", caps.join(" "));
        this._iframe.style.cssText = "width:100%;height:100%;border:none";
        this.shadowRoot!.appendChild(this._iframe);

        // TODO: can we use a sandbox or iframe identifier that is not accessible to the sandbox itself ? like event.source in the host receiver
        const virtualFilesBase = this._config.virtualFilesUrl ? `${this._config.virtualFilesUrl}/${this._sessionId}/` : '';
        const allow = this._config.allow || [];

        const scriptSrcParts = [
            "'self'",
            "'unsafe-inline'",
            virtualFilesBase,
            // "blob:" // might be required for front-end framework workers and dynamic imports
        ];
        if (this._config.scriptUnsafe === true) scriptSrcParts.push("'unsafe-eval'");
        const scriptSrc = scriptSrcParts.filter(Boolean).join(" ");

        const connectSrc = [...allow, virtualFilesBase].filter(Boolean).join(" ") || "'none'";
        const baseUri = virtualFilesBase || "'none'";
        const imgSrc = virtualFilesBase || "'none'";

        const cspConnections = [
            // upgrade http to https, ws to wss
            "upgrade-insecure-requests",
            // connection srcs
            "default-src 'none'",
            `script-src ${scriptSrc}`,
            `connect-src ${connectSrc}`, // dynamic / js induced connections (fetch,  XMLHttpRequest, EventSource, etc). Does not cover 'passive' request like html elements, e.g. <img src=url />
            `base-uri ${baseUri}`,
            `img-src ${imgSrc}`,
            "style-src 'unsafe-inline'",
            "font-src 'none'",
            "media-src 'none'",
            "manifest-src 'none'",
            "prefetch-src 'none'",
            "form-action 'none'",
            "object-src 'none'", // <embed, <object, ...
            "frame-src 'none'", // specifies sources where iframes in a page may be loaded from
            "frame-ancestors 'none'", // specifies parents that may embed a page using <frame>, <iframe>, <object>, or <embed>
            "worker-src blob:" // Allow frameworks to spawn workers from blobs
        ].join("; ");

        // communication and logs template that any content running in the sandbox uses
        const commsScript = `
        window.addEventListener('message', (event) => {
            if (event.data?.type === 'INIT_PORT') {
                const port = event.ports[0];
                port.onmessage = (ev) => {
                    if (ev.data.type === 'EXECUTE') {
                        try {
                            // Ensure the code execution itself doesn't crash the port logic
                            const func = new Function(ev.data.code);
                            func();
                        } catch (e) {
                            port.postMessage({ type: 'LOG', level: 'error', args: [e.message] });
                        }
                    }
                };

                ['log', 'error', 'warn'].forEach(level => {
                    const original = console[level];
                    console[level] = (...args) => {
                        port.postMessage({ type: 'LOG', level, args });
                        original.apply(console, args);
                    };
                });
                port.postMessage({ type: 'LOG', level: 'info', args: ['Iframe Ready'] });
            }
        }, { once: true });
        `;

        // TODO: Ideally, we have a CSP tag/directive generator in its own function and file we can call for this and above, and here just add <!DOCTYPE html> ...
        const securityInjection = `
            <meta http-equiv="Content-Security-Policy" content="${cspConnections}">
            ${virtualFilesBase ? `<base href="${virtualFilesBase}">` : ''}
            <script> ${commsScript} </script>
        `;

        // TODO: run through DOMPurify ?
        const unsafeContent = this._config.html || '<div id="root"></div>';
        let finalHtml: string;

        // TODO: is this secure enough for user provided content? Could user-content contain some trick to avoid having this inserted?
        // probably best to only add code to the body for our sandbox ?
        if (unsafeContent.toLowerCase().includes('<html')) {
            if (unsafeContent.toLowerCase().includes('<head>')) {
                finalHtml = unsafeContent.replace(/<head>/i, `<head>${securityInjection}`);
            } else {
                finalHtml = unsafeContent.replace(/<html[^>]*>/i, `$&<head>${securityInjection}</head>`);
            }
        } else {
            // if no user html content is provided, use this template to allow .execute calls. could be clearer
            finalHtml = `<!DOCTYPE html> <html> <head> ${securityInjection} <meta charset="UTF-8"> </head> <body> ${unsafeContent} </body> </html>`;
        }

        this._iframe.onload = () => {
            if (this._iframe?.contentWindow) {
                this.setupChannel(this._iframe.contentWindow);
                this.dispatchEvent(new CustomEvent('ready'));
            }
        };
        this._iframe.srcdoc = finalHtml;
    }
}
