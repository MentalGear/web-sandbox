/**
 * Simple DevTools for WebSandbox
 * Logs events to the Host Console safely.
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

    private log(data: any) {
        if (data.type === 'LOG') {
            const { level, args } = data;
            const style = level === 'error' ? 'color: #ff5555' :
                          level === 'warn' ? 'color: #ffb74d' : 'color: #8be9fd';

            console.groupCollapsed(`%c[Sandbox] ${level.toUpperCase()}`, style);
            console.log(...args); // Safe: Browser console handles objects/strings safely
            console.groupEnd();
        } else {
            console.log("%c[Sandbox Event]", "color: #bd93f9", data);
        }
    }
}
