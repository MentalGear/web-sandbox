export interface SandboxConfig {
    allow?: string[]; // Allowed domains for CSP
    scriptUnsafe?: boolean; // 'unsafe-eval'
    virtualFilesUrl?: string; // URL to the Virtual Files Hub
    mode?: 'iframe' | 'worker'; // Execution mode
}

export class LofiSandbox extends HTMLElement {
    private _iframe: HTMLIFrameElement | null = null;
    private _worker: Worker | null = null;
    private _config: SandboxConfig = { mode: 'iframe' };
    private _sessionId: string;
    private _port: MessagePort | null = null;
    private _hubFrame: HTMLIFrameElement | null = null;

    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this._sessionId = crypto.randomUUID();
    }

    connectedCallback() {
        this.render();
    }

    setConfig(config: SandboxConfig) {
        this._config = { ...this._config, ...config };

        // Initialize Hub if URL provided
        if (this._config.virtualFilesUrl && !this._hubFrame) {
            this._hubFrame = document.createElement('iframe');
            this._hubFrame.style.display = 'none';
            this._hubFrame.src = `${this._config.virtualFilesUrl}/hub.html`;
            document.body.appendChild(this._hubFrame);
        }

        this.render();
    }

    registerFiles(files: Record<string, string>) {
        if (this._hubFrame && this._hubFrame.contentWindow) {
            this._hubFrame.contentWindow.postMessage({
                type: 'PUT_FILES',
                sessionId: this._sessionId,
                files
            }, this._config.virtualFilesUrl || '*');
        } else {
            console.warn("Virtual Files Hub not ready or configured");
        }
    }

    execute(code: string) {
        if (this._port) {
            this._port.postMessage({ type: 'EXECUTE', code });
        } else {
            console.warn("Sandbox not ready (no port)");
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
    }

    private render() {
        if (this._iframe) { this._iframe.remove(); this._iframe = null; }
        if (this._worker) { this._worker.terminate(); this._worker = null; }
        if (this._port) { this._port.close(); this._port = null; }

        if (this._config.mode === 'worker') {
            this.renderWorker();
        } else {
            this.renderIframe();
        }
    }

    private renderWorker() {
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
    }

    private renderIframe() {
        this._iframe = document.createElement("iframe");
        this._iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals");
        this._iframe.style.cssText = "width:100%;height:100%;border:none";
        this.shadowRoot!.appendChild(this._iframe);

        const vfsBase = this._config.virtualFilesUrl ? `${this._config.virtualFilesUrl}/${this._sessionId}/` : '';
        const allow = this._config.allow || [];
        const connectSrc = allow.length > 0 ? allow.join(" ") : "'none'";
        const scriptDirectives = this._config.scriptUnsafe
            ? "'self' 'unsafe-inline' 'unsafe-eval'"
            : "'self' 'unsafe-inline'";

        const csp = [
            "default-src 'none'",
            `script-src ${scriptDirectives} ${vfsBase ? vfsBase : ''}`,
            `connect-src ${connectSrc} ${vfsBase ? vfsBase : ''}`,
            "style-src 'unsafe-inline'",
            "base-uri 'none'",
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
        window.addEventListener('message', (event) => {
            if (event.data?.type === 'INIT_PORT') {
                const port = event.ports[0];
                port.onmessage = (ev) => {
                    if (ev.data.type === 'EXECUTE') {
                        try {
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
            }
        };
        this._iframe.srcdoc = html;
    }
}

customElements.define("lofi-sandbox", LofiSandbox);
