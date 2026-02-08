/**
 * Simple DevTools for LofiSandbox
 * Logs events to the Host Console safely.
 */
export class SandboxDevTools {
    private _sandbox: HTMLElement;
    private _handler: (e: Event) => void;

    constructor(sandboxElement: HTMLElement) {
        this._sandbox = sandboxElement;
        this._handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            this.log(detail);
        };
    }

    enable() {
        console.info("%c[DevTools] Enabled for Sandbox", "color: #4caf50; font-weight: bold");
        window.addEventListener('sandbox-log', this._handler);
    }

    disable() {
        console.info("%c[DevTools] Disabled", "color: #999");
        window.removeEventListener('sandbox-log', this._handler);
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
