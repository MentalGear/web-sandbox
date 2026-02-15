import type { CSPDirectives, SandboxCapability } from "./csp-directives";
import { ALLOWED_CAPABILITIES } from "./csp-directives";
import { generateCSP } from "./lib/csp/csp-generator";
import { deepMerge } from "./lib/utils";
import { inSandboxScript } from "./lib/in-sandbox-script";

export interface SandboxConfig {
    connectionsAllowed: CSPDirectives; // Providing a key here will merge with/override the default for that directive.
    // TODO: maybe add a warning/error when scriptUnsafe is active, that it should only be used for testing, never in production (as long as webcontent works in it witout it)
    scriptUnsafe?: boolean; // 'unsafe-eval', needed to use .execute method (run arbitrary code in the sandbox)
    capabilities?: SandboxCapability[]; // Custom sandbox attributes for iframe mode
    html?: string; // Initial HTML content for iframe mode
    virtualFilesUrl?: string; // URL to the Virtual Files Hub
    mode?: 'iframe' | 'worker'; // Execution mode
    workerExecutionTimeout?: number; // Max execution time in ms (Worker mode only)
}

const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
    connectionsAllowed: {
        "upgrade-insecure-requests": true,
        "default-src": ["'none'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "connect-src": [],
        "base-uri": [],
        "img-src": [],
        "style-src": ["'unsafe-inline'"],
        "font-src": [],
        "media-src": [],
        "manifest-src": [],
        "prefetch-src": [],
        "form-action": [],
        "object-src": [],
        "frame-src": [],
        "frame-ancestors": [],
        "worker-src": ["blob:", "data:"]
    },
    scriptUnsafe: false,
    capabilities: [],
    html: '',
    virtualFilesUrl: '',
    mode: 'iframe',
    workerExecutionTimeout: 0,
};

export class LofiSandbox extends HTMLElement {
    private _iframe: HTMLIFrameElement | null = null;
    private _worker: Worker | null = null;
    private _workerUrl: string | null = null;
    private _config: SandboxConfig = structuredClone(DEFAULT_SANDBOX_CONFIG);
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

        // ---- Parse and Sanitize Input

        // Filter out any forbidden capabilities that might have been passed
        if (config.capabilities) {
            config.capabilities = config.capabilities.filter(
                cap => ALLOWED_CAPABILITIES.includes(cap as SandboxCapability)
            );
        }

        // apply new config
        this._config = deepMerge(DEFAULT_SANDBOX_CONFIG, config);

        // add virtual files hub if not already existing
        // TODO: make own function
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
        if (!this._config.scriptUnsafe) {
            console.warn("[Sandbox] execute() blocked: scriptUnsafe is false. Enable it in config to run arbitrary code.");
            return;
        }

        if (this._port) {
            this._startTimeout();
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
        if (this._worker) (this._cleanupWorker())
        if (this._port) { this._port.close(); this._port = null; }
        if (this._timeoutId) clearTimeout(this._timeoutId);

        if (this._config.mode === 'iframe') {
            // iframe mode
            this.createIframe();
        } else if (this._config.mode === 'worker') {
            // TODO: this is wrong! we need to place the worker inside the iframe, oterwise the worker has full network access (has host CSP policy)
            this.spawnWorker();
        }
    }

    private _getSandboxCommsScript(mode: 'iframe' | 'worker') {
        // communication and logs template that any content running in the sandbox uses
        return `(${inSandboxScript.toString()})(${this._config.scriptUnsafe}, '${mode}', console);`;
    }

    private spawnWorker() {
        const script = this._getSandboxCommsScript('worker');
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

        // Clone the config directives to avoid mutating the original config
        // passing the refs of the original object
        const directives = structuredClone(
            this._config.connectionsAllowed
        );

        directives["upgrade-insecure-requests"] = true

        if (virtualFilesBase) {
            directives["script-src"]?.push(virtualFilesBase);
            directives["connect-src"]?.push(virtualFilesBase);
            directives["base-uri"]?.push(virtualFilesBase);
            directives["img-src"]?.push(virtualFilesBase);
        }

        if (this._config.scriptUnsafe) {
            directives["script-src"]?.push("'unsafe-eval'");
        }

        const cspConnections = generateCSP(directives);

        // communication and logs template that any content running in the sandbox uses
        const commsScript = this._getSandboxCommsScript('iframe');


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
