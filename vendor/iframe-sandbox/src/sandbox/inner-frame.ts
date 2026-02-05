/**
 * Inner Frame Logic
 * Executes user code and relays logs to Host.
 */

import { extractMetadata, createLogMessage } from "./utils"

// 0. Network Logging Proxy (Monkey-patching)
// Restores network visibility lost by removing Service Worker.
const originalFetch = window.fetch;
window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || 'GET';

    // Log the attempt
    window.parent.postMessage(createLogMessage("log", `Fetch: ${method} ${url}`, { url, method }), "*");

    try {
        const response = await originalFetch(input, init);
        window.parent.postMessage(createLogMessage("log", `Fetch Success: ${method} ${url} -> ${response.status}`, { url, method, status: response.status }), "*");
        return response;
    } catch (e) {
        window.parent.postMessage(createLogMessage("error", `Fetch Error: ${method} ${url} - ${e.message}`, { url, method, error: e.message }), "*");
        throw e;
    }
};

const originalXHR = window.XMLHttpRequest;
// @ts-ignore
window.XMLHttpRequest = class extends originalXHR {
    open(method: string, url: string | URL, ...args: any[]) {
        // @ts-ignore
        this._logData = { method, url };
        window.parent.postMessage(createLogMessage("log", `XHR Open: ${method} ${url}`, { method, url }), "*");
        // @ts-ignore
        super.open(method, url, ...args);
    }

    send(body?: any) {
        // @ts-ignore
        const { method, url } = this._logData || {};
        this.addEventListener('load', () => {
             window.parent.postMessage(createLogMessage("log", `XHR Load: ${method} ${url} -> ${this.status}`, { method, url, status: this.status }), "*");
        });
        this.addEventListener('error', () => {
             window.parent.postMessage(createLogMessage("error", `XHR Error: ${method} ${url}`, { method, url }), "*");
        });
        super.send(body);
    }
};


// 1. CSP Violation Reporting
document.addEventListener("securitypolicyviolation", (event: any) => {
    const blockedUri = event.blockedURI
    const violatedDirective = event.violatedDirective
    window.parent.postMessage(
        createLogMessage(
            "error",
            `Security Violation: ${violatedDirective} blocked ${blockedUri}`,
            {
                blockedUri,
                violatedDirective,
                sourceFile: event.sourceFile,
                lineNumber: event.lineNumber,
            },
        ),
        "*",
    )
})

// 2. Proxy console methods
const consoleMethods = ["log", "error", "warn"] as const
consoleMethods.forEach((level) => {
    const original = (console as any)[level]
    ;(console as any)[level] = function (...args: any[]) {
        try {
            const safeArgs = args.map((arg) => extractMetadata(arg))
            const message = safeArgs
                .map((a: any) =>
                    typeof a === "string" ? a : JSON.stringify(a),
                )
                .join(" ")

            window.parent.postMessage(
                createLogMessage(level, message, { args: safeArgs }),
                "*",
            )
        } catch (e) {
            original.apply(console, ["[Inner] Relay Error", e])
        }
        original.apply(console, args)
    }
})

// 3. Unhandled promise rejections
window.addEventListener("unhandledrejection", (event) => {
    const error = extractMetadata(event.reason)
    window.parent.postMessage(
        createLogMessage(
            "error",
            `Unhandled Rejection: ${JSON.stringify(error)}`,
            error,
        ),
        "*",
    )
})

// 4. Global error handler
window.addEventListener("error", (event) => {
    window.parent.postMessage(
        createLogMessage(
            "error",
            `${event.message} at ${event.filename}:${event.lineno}`,
            {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
            },
        ),
        "*",
    )
})

// 5. Execute code from outer frame (now Host)
window.addEventListener("message", (event) => {
    if (event.data?.type === "EXECUTE") {
        try {
            // eslint-disable-next-line no-new-func
            const func = new Function(event.data.code)
            func()
        } catch (e) {
            console.error("Execution Error:", e)
        }
    }
})

// 6. Signal ready
if (window.parent) {
    window.parent.postMessage("READY", "*")
}

console.log("Inner frame loaded.")
