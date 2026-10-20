/**
 * Simple DevTools for WebSandbox: logs the element's events to the host console safely.
 */
export class SandboxDevTools {
    private _sandbox: HTMLElement;
    private _handler: (e: Event) => void;
    private _active: boolean = false;

    constructor(sandboxElement: HTMLElement) {
        this._sandbox = sandboxElement;
        // 'sandbox-log' is dispatched on the sandbox element itself (and bubbles), so listening on the
        // element hears exactly this sandbox. The target check stays as a guard: an event bubbling up from
        // anything nested inside the element is not this sandbox's log.
        this._handler = (e: Event) => {
            if (e.target !== this._sandbox) return;
            const detail = (e as CustomEvent).detail;
            this.log(detail);
        };
    }

    toggle() {
        if (this._active) {
            this.deactivate();
        } else {
            this.activate();
        }
    }

    activate() {
        console.info("%c[DevTools] Enabled for Sandbox", "color: #4caf50; font-weight: bold");
        this._sandbox.addEventListener('sandbox-log', this._handler);
        this._active = true;
    }

    deactivate() {
        console.info("%c[DevTools] Disabled", "color: #999");
        this._sandbox.removeEventListener('sandbox-log', this._handler);
        this._active = false;
    }

    // Robust against any detail (AR:B3): the element normalises every line (src/lib/sandbox-log.ts), but this
    // class may be pointed at anything that dispatches 'sandbox-log', so it checks again and never throws. The
    // logged values go after a fixed first argument, so a guest string is never read as a console format string
    // (no %c styling of host console lines).
    private log(data: any) {
        try {
            if (!data || data.type !== 'LOG') {
                console.log("%c[Sandbox Event]", "color: #bd93f9", data);
                return;
            }
            const level = typeof data.level === 'string' ? data.level : 'log';
            const args = Array.isArray(data.args) ? data.args : [];
            const source = data.source === 'host' ? 'host' : 'guest';
            const style = level === 'error' ? 'color: #ff5555' :
                          level === 'warn' ? 'color: #ffb74d' : 'color: #8be9fd';

            console.groupCollapsed(`%c[Sandbox] ${level.slice(0, 16).toUpperCase()} (${source})`, style);
            console.log('', ...args); // Safe: Browser console handles objects/strings safely
            console.groupEnd();
        } catch {
            // a detail that cannot even be read is not worth breaking the page for
        }
    }
}
