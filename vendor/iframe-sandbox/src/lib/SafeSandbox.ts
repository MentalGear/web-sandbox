/**
 * SafeSandbox Custom Element
 * A secure, isolated JavaScript sandbox using iFrame subdomains.
 */

import { type NetworkRules, type LogMessage } from "./types"

class SafeSandbox extends HTMLElement {
    private _iframe: HTMLIFrameElement
    private _networkRules: NetworkRules
    private _sandboxBaseOrigin: string
    private _currentSessionOrigin: string
    private _sessionId: string | null

    static get observedAttributes(): string[] {
        return ["sandbox-origin", "script-unsafe"]
    }

    constructor() {
        super()
        this.attachShadow({ mode: "open" })

        this._iframe = document.createElement("iframe")
        this._iframe.style.width = "100%"
        this._iframe.style.height = "100%"
        this._iframe.style.border = "none"
        this.shadowRoot!.appendChild(this._iframe)

        this._onMessage = this._onMessage.bind(this)
        this._networkRules = {}
        this._sandboxBaseOrigin = ""
        this._currentSessionOrigin = ""
        this._sessionId = null
    }

    connectedCallback(): void {
        window.addEventListener("message", this._onMessage)
        this._updateSandboxBaseOrigin()
        this._initializeSession()
    }

    disconnectedCallback(): void {
        window.removeEventListener("message", this._onMessage)
    }

    attributeChangedCallback(
        name: string,
        oldValue: string | null,
        newValue: string | null,
    ): void {
        if (oldValue === newValue) return

        if (name === "sandbox-origin") {
            this._updateSandboxBaseOrigin()
            this._initializeSession()
        } else if (name === "script-unsafe") {
            this._initializeSession()
        }
    }

    private _updateSandboxBaseOrigin(): void {
        const attr = this.getAttribute("sandbox-origin")
        if (attr) {
            this._sandboxBaseOrigin = attr
        } else {
            const currentHost = window.location.hostname
            const port = window.location.port
            this._sandboxBaseOrigin = `http://sandbox.${currentHost}${port ? ":" + port : ""}`
        }
    }

    private async _initializeSession(): Promise<void> {
        if (!this._sandboxBaseOrigin) return

        const allowedDomains = this._networkRules.allow || []
        const unsafe = this.hasAttribute("script-unsafe")

        try {
            const response = await fetch("/api/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    allow: allowedDomains.join(","),
                    unsafe: unsafe
                })
            });

            if (!response.ok) {
                console.error("Failed to create sandbox session");
                return;
            }

            const data = await response.json();
            this._sessionId = data.sessionId;

            const url = new URL(this._sandboxBaseOrigin);
            url.hostname = `${this._sessionId}.${url.hostname}`;
            this._currentSessionOrigin = url.origin;

            this._updateIframeSource();

        } catch (e) {
            console.error("Error initializing sandbox:", e);
        }
    }

    execute(code: string): void {
        if (!this._iframe.contentWindow || !this._currentSessionOrigin) return
        this._iframe.contentWindow.postMessage(
            { type: "EXECUTE", code },
            this._currentSessionOrigin,
        )
    }

    setNetworkRules(rules: NetworkRules): void {
        this._networkRules = rules
        if (rules.scriptUnsafe) {
            this.setAttribute("script-unsafe", "true")
        } else {
            this.removeAttribute("script-unsafe")
        }
        this._initializeSession();
    }

    private _calculateIframeSrc(): string {
        if (!this._currentSessionOrigin) return ""
        // Load inner-frame directly
        return `${this._currentSessionOrigin}/inner-frame.html`
    }

    private _updateIframeSource(): void {
        if (this._currentSessionOrigin) {
            this._iframe.setAttribute(
                "sandbox",
                "allow-scripts allow-forms allow-popups allow-modals allow-same-origin",
            )
            this._iframe.src = this._calculateIframeSrc()
        }
    }

    private _onMessage(event: MessageEvent): void {
        if (!this._currentSessionOrigin) return
        if (event.origin !== this._currentSessionOrigin) return

        const data = event.data
        if (!data) return

        if (data === "READY") {
            this.dispatchEvent(new CustomEvent("ready"))
        } else if (data.type === "LOG") {
            this.dispatchEvent(
                new CustomEvent<LogMessage>("log", { detail: data }),
            )
        } else {
            this.dispatchEvent(new CustomEvent("message", { detail: data }))
        }
    }
}

customElements.define("safe-sandbox", SafeSandbox)

export { SafeSandbox, NetworkRules, LogMessage }
