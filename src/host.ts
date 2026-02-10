export type SandboxCapability = 
    | 'allow-downloads'
    | 'allow-forms'
    | 'allow-modals'
    | 'allow-orientation-lock'
    | 'allow-pointer-lock'
    | 'allow-popups'
    | 'allow-presentation'
    | 'allow-scripts';

/**
 * Capabilities that are explicitly forbidden to ensure the research 
 * focuses on non-trivial sandbox escapes.
 */
export const FORBIDDEN_CAPABILITIES = [
    'allow-same-origin',
    'allow-top-navigation',
    'allow-popups-to-escape-sandbox'
];

export interface SandboxConfig {
    allow?: string[]; // Allowed domains for CSP
    scriptUnsafe?: boolean; // 'unsafe-eval'
    virtualFilesUrl?: string; // URL to the Virtual Files Hub
    mode?: 'iframe' | 'worker'; // Execution mode
    executionTimeout?: number; // Max execution time in ms (Worker mode only)
    capabilities?: SandboxCapability[]; // Custom sandbox attributes for iframe mode
}

export class LofiSandbox extends HTMLElement {
    private _iframe: HTMLIFrameElement | null = null;
    private _worker: Worker | null = null;
    private _config: SandboxConfig = { mode: 'iframe', capabilities: [] };
    private _sessionId: string;
    private _port: MessagePort | null = null;
    private _hubFrame: HTMLIFrameElement | null = null;
    private _timeoutId: any = null;
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
                cap => !FORBIDDEN_CAPABILITIES.includes(cap as any)
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
        } else {
            console.warn("Virtual Files Hub not ready or configured");
        }
    }

    execute(code: string) {
        if (this._port) {
            this._startTimeout();
            this._port.postMessage({ type: 'EXECUTE', code });
        } else {
            this._queuedMessages.push({ code });
        }
    }

    private _startTimeout() {
        if (this._timeoutId) clearTimeout(this._timeoutId);

        if (this._config.mode === 'worker' && this._config.executionTimeout && this._config.executionTimeout > 0) {
            this._timeoutId = setTimeout(() => {
                console.warn("[Sandbox] Execution Timeout - Terminating Worker");
                window.dispatchEvent(new CustomEvent('sandbox-log', { detail: { type: 'LOG', level: 'error', args: ['Execution Timeout'] } }));

                if (this._worker) {
                    this._worker.terminate();
                    this._worker = null;
                    if (this._port) { this._port.close(); this._port = null; }
                    this.spawnWorker();
                }
            }, this._config.executionTimeout);
        }
    }

    private setupChannel(target: Window | Worker) {
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

    private initialize() {
        this._queuedMessages = []; // Clear queue for the old environment
        if (this._iframe) { this._iframe.remove(); this._iframe = null; }
        if (this._worker) { this._worker.terminate(); this._worker = null; }
        if (this._port) { this._port.close(); this._port = null; }
        if (this._timeoutId) clearTimeout(this._timeoutId);

        if (this._config.mode === 'worker') {
            this.spawnWorker();
        } else {
            this.createIframe();
        }
    }

    private spawnWorker() {
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
        this._worker = new Worker(URL.createObjectURL(blob));
        this.setupChannel(this._worker);
        setTimeout(() => this.dispatchEvent(new CustomEvent('ready')), 0);
    }

    private createIframe() {
        this._iframe = document.createElement("iframe");
        const caps = this._config.capabilities || [];
        this._iframe.setAttribute("sandbox", caps.join(" "));
        this._iframe.style.cssText = "width:100%;height:100%;border:none";
        this.shadowRoot!.appendChild(this._iframe);

        const vfsBase = this._config.virtualFilesUrl ? `${this._config.virtualFilesUrl}/${this._sessionId}/` : '';
        const allow = this._config.allow || [];

        const scriptSrc = [
            this._config.scriptUnsafe 
            ? "'self' 'unsafe-inline' 'unsafe-eval'"
            : "'self' 'unsafe-inline'",
            vfsBase
        ].filter(Boolean).join(" ");

        const connectSrc = [...allow, vfsBase].filter(Boolean).join(" ") || "'none'";
        const baseUri = vfsBase || "'none'";

        const csp = [
            "default-src 'none'",
            `script-src ${scriptSrc}`,
            `connect-src ${connectSrc}`,
            "style-src 'unsafe-inline'",
            `base-uri ${baseUri}`,
            "frame-src 'none'",
            "object-src 'none'",
            "form-action 'none'"
        ].join("; ");

        const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    ${vfsBase ? `<base href="${vfsBase}">` : ''}
    <script>
        // Defense-in-depth: Block nested iframes
        const originalCreateElement = document.createElement;
        document.createElement = function(tagName, options) {
            if (tagName.toLowerCase() === 'iframe') {
                throw new Error("Nested iframes are blocked.");
            }
            return originalCreateElement.call(document, tagName, options);
        };

        // Defense-in-depth: Hide Service Workers
        try {
            Object.defineProperty(window.Navigator.prototype, 'serviceWorker', {
                get: function() { return undefined; },
                configurable: true
            });
        } catch (e) {}

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
    </script>
</head>
<body><div id="root"></div></body>
</html>
        `;

        this._iframe.onload = () => {
            if (this._iframe?.contentWindow) {
                this.setupChannel(this._iframe.contentWindow);
                this.dispatchEvent(new CustomEvent('ready'));
            }
        };
        this._iframe.srcdoc = html;
    }
}
