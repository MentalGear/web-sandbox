import type { CSPDirectives, SafeCapability, UnsafeCapability } from "./csp-directives";
import { SAFE_CAPABILITIES, UNSAFE_CAPABILITIES, UNSAFE_PERMISSIONS } from "./csp-directives";
import { generateCSP } from "./lib/csp/csp-generator";
import { deepMerge } from "./lib/utils";
import { inSandboxScript } from "./lib/in-sandbox-script";
import { workerBootstrap } from "./lib/worker-bootstrap";
import { filterCapabilities } from "./lib/capabilities";
import { buildGuestDocument, buildWrapperDocument, permissionAttributes, toInlineScriptLiteral } from "./lib/frame-documents";

export interface SandboxConfig {
    connectionsAllowed: CSPDirectives; // Providing a key here will merge with/override the default for that directive.
    // TODO: maybe add a warning/error when scriptUnsafe is active, that it should only be used for testing, never in production (as long as webcontent works in it witout it)
    scriptUnsafe?: boolean; // 'unsafe-eval', needed to use .execute method (run arbitrary code in the sandbox)
    capabilities?: SafeCapability[]; // Sandbox attributes that keep the guest inside the frame
    unsafeCapabilities?: UnsafeCapability[]; // Capabilities that reach outside the frame (popups, modals, downloads, presentation, fullscreen). Opt-in only, logs a warning.
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
        "base-uri": [], // no default-src fallback: emitted as 'none'
        "img-src": [],
        "style-src": ["'unsafe-inline'"],
        "font-src": [],
        "media-src": [],
        "manifest-src": [],
        "prefetch-src": [],
        "form-action": [], // no default-src fallback: emitted as 'none'
        "object-src": [],
        "frame-src": [],
        "frame-ancestors": [],
        "worker-src": ["blob:", "data:"]
    },
    scriptUnsafe: false,
    capabilities: [],
    unsafeCapabilities: [],
    html: '',
    virtualFilesUrl: '',
    mode: 'iframe',
    workerExecutionTimeout: 0,
};

export class WebSandbox extends HTMLElement {
    private _iframe: HTMLIFrameElement | null = null;
    private _frameLoaded = false;
    private _terminated = false;
    private _config: SandboxConfig = structuredClone(DEFAULT_SANDBOX_CONFIG);
    private _sessionId: string;
    private _port: MessagePort | null = null;
    private _hubFrame: HTMLIFrameElement | null = null;
    private _timeoutId: ReturnType<typeof setTimeout> | null = null;
    private _queuedMessages: { code: string }[] = [];
    private _warnedUnsafeCapabilities = new Set<string>();

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
        const sanitizedConfig: SandboxConfig = {
            ...config,
            capabilities: filterCapabilities(config.capabilities, SAFE_CAPABILITIES, 'capabilities'),
            unsafeCapabilities: filterCapabilities(config.unsafeCapabilities, UNSAFE_CAPABILITIES, 'unsafeCapabilities'),
        };

        // apply new config
        this._config = deepMerge(DEFAULT_SANDBOX_CONFIG, sanitizedConfig);
        this._warnAboutUnsafeCapabilities();

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

        if (this._terminated) {
            console.warn("[Sandbox] execute() ignored: the sandbox was terminated. Call setConfig() or load() to start a new one.");
            return;
        }

        if (this._port) {
            this._startTimeout();
            this._port.postMessage({ type: 'EXECUTE', code });
        } else {
            this._queuedMessages.push({ code });
        }
    }

    private _warnAboutUnsafeCapabilities() {
        for (const capability of this._config.unsafeCapabilities || []) {
            if (this._warnedUnsafeCapabilities.has(capability)) continue;
            this._warnedUnsafeCapabilities.add(capability);
            console.warn(`[Sandbox] unsafe capability "${capability}" is enabled: it lets guest content act outside the sandbox.`);
        }
    }

    private _startTimeout() {
        if (this._timeoutId) clearTimeout(this._timeoutId);

        if (this._config.mode === 'worker' && this._config.workerExecutionTimeout && this._config.workerExecutionTimeout > 0) {
            this._timeoutId = setTimeout(() => {
                console.warn("[Sandbox] Execution Timeout - Terminating Worker");
                window.dispatchEvent(new CustomEvent('sandbox-log', { detail: { type: 'LOG', level: 'error', args: ['Execution Timeout'] } }));

                // the worker lives inside the frame: recreating the frame terminates it
                this.initialize();
            }, this._config.workerExecutionTimeout);
        }
    }

    private setupChannel(target: Window) {
        if (this._port) { this._port.close(); this._port = null; }
        const channel = new MessageChannel();
        this._port = channel.port1;
        this._port.onmessage = (e) => {
            if (e.data.type === 'LOG') {
                window.dispatchEvent(new CustomEvent('sandbox-log', { detail: e.data }));
            }
        };

        // An opaque origin cannot be named as targetOrigin, hence '*'.
        // What keeps the port from reaching a foreign document is that this runs exactly once per frame (see _onFrameLoad).
        target.postMessage({ type: 'INIT_PORT' }, '*', [channel.port2]);

        // Flush any messages queued during initialization
        if (this._queuedMessages.length > 0) {
            const pending = [...this._queuedMessages];
            this._queuedMessages = [];
            pending.forEach(msg => this.execute(msg.code));
        }
    }

    private _teardown() {
        this._queuedMessages = []; // Clear queue for the old environment
        if (this._iframe) { this._iframe.onload = null; this._iframe.remove(); this._iframe = null; }
        if (this._port) { this._port.close(); this._port = null; }
        if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
    }

    private _terminate(reason: string) {
        console.warn(`[Sandbox] terminated: ${reason}`);
        this._teardown();
        this._terminated = true;
        this.dispatchEvent(new CustomEvent('terminated', { detail: { reason } }));
    }

    private initialize() {
        this._teardown();
        this._terminated = false;
        this.createIframe();
    }

    private _getSandboxCommsScript(mode: 'iframe' | 'worker') {
        // communication and logs template that any content running in the sandbox uses
        return `(${inSandboxScript.toString()})(${this._config.scriptUnsafe}, '${mode}', console);`;
    }

    private _getWorkerBootstrapScript() {
        // the worker runs the comms script; the frame only spawns it and forwards the port
        const workerSource = this._getSandboxCommsScript('worker');
        return `(${workerBootstrap.toString()})(${toInlineScriptLiteral(workerSource)});`;
    }

    private _isPermission(capability: string): boolean {
        return (UNSAFE_PERMISSIONS as readonly string[]).includes(capability);
    }

    private _getSandboxFlags(): string {
        const flags = new Set<string>(this._config.capabilities || []);
        for (const capability of this._config.unsafeCapabilities || []) {
            if (this._isPermission(capability)) continue; // goes into the allow attribute instead
            flags.add(capability);
        }

        // worker mode needs scripts in the frame to spawn the worker
        if (this._config.mode === 'worker') flags.add('allow-scripts');

        return [...flags].join(' ');
    }

    // Permissions Policy features for the iframe `allow` attribute (e.g. fullscreen)
    private _getPermissions(): string[] {
        const permissions: string[] = [];
        for (const capability of this._config.unsafeCapabilities || []) {
            if (this._isPermission(capability)) permissions.push(capability);
        }
        return permissions;
    }

    private _getCSP(virtualFilesBase: string): string {
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

        return generateCSP(directives);
    }

    private createIframe() {
        const isWorkerMode = this._config.mode === 'worker';

        // TODO: can we use a sandbox or iframe identifier that is not accessible to the sandbox itself ? like event.source in the host receiver
        const virtualFilesBase = this._config.virtualFilesUrl ? `${this._config.virtualFilesUrl}/${this._sessionId}/` : '';

        // TODO: run through DOMPurify ?
        const guestDocument = buildGuestDocument({
            csp: this._getCSP(virtualFilesBase),
            baseHref: virtualFilesBase,
            bootstrapScript: isWorkerMode ? this._getWorkerBootstrapScript() : this._getSandboxCommsScript('iframe'),
            // worker mode is headless: no guest markup
            content: isWorkerMode ? '' : (this._config.html || '<div id="root"></div>'),
        });

        const sandboxFlags = this._getSandboxFlags();
        const permissions = this._getPermissions();

        this._iframe = document.createElement("iframe");
        this._iframe.setAttribute("sandbox", sandboxFlags);
        for (const [name, value] of Object.entries(permissionAttributes(permissions))) {
            this._iframe.setAttribute(name, value);
        }
        this._iframe.style.cssText = isWorkerMode ? "display:none" : "width:100%;height:100%;border:none";
        this._frameLoaded = false;
        this._iframe.onload = () => this._onFrameLoad();

        // srcdoc goes in before the frame is inserted: an iframe inserted without one first
        // loads about:blank, which would count as the frame's one load (see _onFrameLoad)
        this._iframe.srcdoc = buildWrapperDocument(guestDocument, sandboxFlags, permissions);
        this.shadowRoot!.appendChild(this._iframe);
    }

    private _onFrameLoad() {
        // The wrapper is written once and has no script, so it loads exactly once.
        // A second load means something navigated or reloaded it: never hand a port
        // (or queued code) to a document we did not write.
        if (this._frameLoaded) {
            this._terminate('the sandbox frame loaded a second time');
            return;
        }
        this._frameLoaded = true;

        const guestWindow = this._iframe?.contentWindow?.frames[0];
        if (!guestWindow) {
            this._terminate('the guest frame is missing');
            return;
        }

        this.setupChannel(guestWindow);
        this.dispatchEvent(new CustomEvent('ready'));
    }
}

/**
 * Registers the element under `tagName` (default `<web-sandbox>`). Safe to call more than once.
 * Importing the library does not register anything, so you can pick your own tag name.
 */
export function defineWebSandbox(tagName = 'web-sandbox'): typeof WebSandbox {
    const existing = customElements.get(tagName);
    if (existing && existing !== WebSandbox) throw new Error(`<${tagName}> is already defined by another element`);
    if (!existing) customElements.define(tagName, WebSandbox);
    return WebSandbox;
}
