export interface SandboxConfig {
    allow?: string[]; // Allowed domains for CSP
    scriptUnsafe?: boolean; // 'unsafe-eval'
    vfsUrl?: string; // URL to the VFS hub (e.g. http://vfs.localhost:3333)
}

export class LofiSandbox extends HTMLElement {
    private _iframe: HTMLIFrameElement;
    private _config: SandboxConfig = {};
    private _sessionId: string;

    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this._iframe = document.createElement("iframe");
        this._iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals");
        this._iframe.style.cssText = "width:100%;height:100%;border:none";
        this.shadowRoot!.appendChild(this._iframe);
        this._sessionId = crypto.randomUUID();
    }

    connectedCallback() {
        this.render();
    }

    setConfig(config: SandboxConfig) {
        this._config = config;
        this.render();
    }

    execute(code: string) {
        // Send code to iframe via postMessage
        this._iframe.contentWindow?.postMessage({ type: 'EXECUTE', code }, '*');
    }

    private render() {
        const vfsBase = this._config.vfsUrl
            ? `${this._config.vfsUrl}/${this._sessionId}/`
            : '';

        const allow = this._config.allow || [];
        const connectSrc = allow.length > 0 ? allow.join(" ") : "'none'";
        const scriptDirectives = this._config.scriptUnsafe
            ? "'self' 'unsafe-inline' 'unsafe-eval'"
            : "'self' 'unsafe-inline'"; // inline needed for the bootstrapper

        const csp = [
            "default-src 'none'",
            `script-src ${scriptDirectives} ${vfsBase ? vfsBase : ''}`,
            `connect-src ${connectSrc} ${vfsBase ? vfsBase : ''}`,
            "style-src 'unsafe-inline'",
            "base-uri 'none'", // Strict base-uri
            "frame-src 'none'" // No nested frames by default
        ].join("; ");

        const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    ${vfsBase ? `<base href="${vfsBase}">` : ''}
    <script>
        // Minimal Bootstrapper
        window.addEventListener('message', (event) => {
            if (event.data?.type === 'EXECUTE') {
                try {
                    const func = new Function(event.data.code);
                    func();
                } catch (e) {
                    console.error("[Sandbox] Exec Error:", e);
                }
            }
        });

        // Proxy Console
        ['log', 'error', 'warn'].forEach(level => {
            const original = console[level];
            console[level] = (...args) => {
                window.parent.postMessage({ type: 'LOG', level, args }, '*');
                original.apply(console, args);
            };
        });
    </script>
</head>
<body>
    <div id="root"></div>
</body>
</html>
        `;

        this._iframe.srcdoc = html;
    }
}

customElements.define("lofi-sandbox", LofiSandbox);
