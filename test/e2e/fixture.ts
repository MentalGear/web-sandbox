import { test as base, expect, type Page } from '@playwright/test';
import type { SandboxConfig } from '@src/host';

export const ORIGIN = 'http://localhost:4444';
export const HARNESS = `${ORIGIN}/test/e2e/harness.html`;

// What the specs need to run anything at all: scripts in the frame and execute().
export const BASELINE_CONFIG: Partial<SandboxConfig> = {
    capabilities: ['allow-scripts'],
    scriptUnsafe: true,
};

export type MountResult = 'ready' | 'terminated';

/**
 * How a broker call settled. A refusal carries the error's `code` (backlog B7), so specs assert the
 * exact code rather than message text; `keys` lists the error's own enumerable properties, which
 * should be just ['code'].
 */
export type CallOutcome =
    | { status: 'resolved'; value: unknown }
    | { status: 'rejected'; isError: boolean; message: unknown; code: unknown; keys: unknown };

/**
 * Drives the <web-sandbox> element on the harness page.
 * Specs talk to this instead of the page, so moving the playground or renaming internals
 * breaks one file instead of every spec.
 */
export class SandboxDriver {
    constructor(readonly page: Page) {}

    async open() {
        await this.page.goto(HARNESS);
        await this.page.waitForFunction(() => (window as any).harnessReady === true);
    }

    /** Applies BASELINE_CONFIG merged with `config`, and waits for the sandbox to become ready. */
    async mount(config: Partial<SandboxConfig> = {}): Promise<MountResult> {
        return this.page.evaluate((merged) => whenSettled(s => s.setConfig(merged)), { ...BASELINE_CONFIG, ...config } as any);
    }

    /** Loads guest markup into the current sandbox and waits for it to become ready. */
    async load(html: string): Promise<MountResult> {
        return this.page.evaluate((markup) => whenSettled(s => s.load(markup)), html);
    }

    /** Recreates the environment (reset()) and waits for it to settle. */
    async reset(): Promise<MountResult> {
        return this.page.evaluate(() => whenSettled(s => s.reset()));
    }

    /** The element's lifecycle state (backlog B2). */
    async state(): Promise<string> {
        return this.page.evaluate(() => (document.querySelector('web-sandbox') as any).state);
    }

    /**
     * Mounts a second <web-sandbox id="second"> next to the harness's, with BASELINE_CONFIG merged with
     * `config`, and waits for it to become ready. Its log lines land in sandboxLogs too (they bubble to window).
     */
    async mountSecond(config: Partial<SandboxConfig> = {}): Promise<MountResult> {
        return this.page.evaluate((merged) => new Promise<MountResult>(resolve => {
            const second = document.createElement('web-sandbox') as any;
            second.id = 'second';
            second.addEventListener('ready', () => resolve('ready'), { once: true });
            second.addEventListener('terminated', () => resolve('terminated'), { once: true });
            second.setConfig(merged); // detached: only stores the config, the frame is built on insertion
            document.body.appendChild(second);
        }), { ...BASELINE_CONFIG, ...config } as any);
    }

    async run(code: string) {
        await this.page.evaluate((source) => (document.querySelector('web-sandbox') as any).execute(source), code);
    }

    // ---- β broker helpers (backlog B1) -------------------------------------------------------

    /** Host -> guest: invokes a guest-exposed method and returns its resolved value. */
    async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.page.evaluate(
            ({ method, args }) => (document.querySelector('web-sandbox') as any).call(method, ...args),
            { method, args },
        );
    }

    /** Like call(), but settles to a CallOutcome instead of throwing, for asserting refusals by their code. */
    async callOutcome(method: unknown, ...args: unknown[]): Promise<CallOutcome> {
        return this.hostOutcome(null, method, args);
    }

    /** Like callWithTimeout(), but settles to a CallOutcome instead of throwing. */
    async callWithTimeoutOutcome(timeoutMs: number, method: unknown, ...args: unknown[]): Promise<CallOutcome> {
        return this.hostOutcome(timeoutMs, method, args);
    }

    private async hostOutcome(timeoutMs: number | null, method: unknown, args: unknown[]): Promise<CallOutcome> {
        return this.page.evaluate(async ({ timeoutMs, method, args }) => {
            const el = document.querySelector('web-sandbox') as any;
            try {
                const value = await (timeoutMs === null ? el.call(method, ...args) : el.callWithTimeout(timeoutMs, method, ...args));
                return { status: 'resolved' as const, value };
            } catch (e: any) {
                return { status: 'rejected' as const, isError: e instanceof Error, message: e?.message, code: e?.code, keys: e && typeof e === 'object' ? Object.keys(e) : null };
            }
        }, { timeoutMs, method, args });
    }

    /**
     * Guest side: evaluates `expression` (a bridge call) INSIDE the sandbox and reports how it settled, as
     * seen by the guest — so a guest-to-host refusal is asserted from the refused side. Needs scriptUnsafe.
     */
    async guestOutcome(expression: string, timeout = 8000): Promise<CallOutcome> {
        const tag = `GUEST_OUTCOME_${++this.outcomeCount} `;
        await this.run(`Promise.resolve().then(() => ${expression}).then(
            value => console.log(${JSON.stringify(tag)} + JSON.stringify({ status: 'resolved', value })),
            e => console.log(${JSON.stringify(tag)} + JSON.stringify({ status: 'rejected', isError: e instanceof Error, message: e && e.message, code: e && e.code, keys: e && typeof e === 'object' ? Object.keys(e) : null })))`);
        const line = await this.waitForLog(tag, timeout);
        return JSON.parse(line.slice(tag.length));
    }

    private outcomeCount = 0;

    /** Registers a host method from a function-source string (built in the host page, which is not sandboxed). */
    async exposeHost(name: string, fnSource: string) {
        await this.page.evaluate(({ name, fnSource }) => {
            const fn = new Function('return (' + fnSource + ')')();
            (document.querySelector('web-sandbox') as any).expose(name, fn);
        }, { name, fnSource });
    }

    /** Registers a guest method by running bridge.expose(...) inside the sandbox (via execute, needs scriptUnsafe). */
    async exposeGuest(name: string, fnSource: string) {
        await this.run(`bridge.expose(${JSON.stringify(name)}, ${fnSource})`);
    }

    async logs(): Promise<string[]> {
        return this.page.evaluate(() => [...(window as any).sandboxLogs]);
    }

    async clearLogs() {
        await this.page.evaluate(() => { (window as any).sandboxLogs.length = 0; });
    }

    /** Runs `code` and returns every log line once it logs TEST_DONE (the presets' completion signal). */
    async runUntilDone(code: string, timeout = 10000): Promise<string[]> {
        await this.run(code);
        await this.waitForLog('TEST_DONE', timeout);
        return this.logs();
    }

    /** Resolves with the first log line matching `pattern`; throws on timeout. */
    async waitForLog(pattern: string | RegExp, timeout = 5000): Promise<string> {
        const source = typeof pattern === 'string' ? pattern : pattern.source;
        const isRegExp = typeof pattern !== 'string';
        const handle = await this.page.waitForFunction(({ source, isRegExp }) => {
            const logs: string[] = (window as any).sandboxLogs;
            return logs.find(line => isRegExp ? new RegExp(source).test(line) : line.includes(source));
        }, { source, isRegExp }, { timeout });
        return handle.jsonValue() as Promise<string>;
    }
}

// Injected into the page: resolves once the sandbox reports 'ready' or 'terminated'.
// settleOutcome turns a call's promise into a CallOutcome, for page-side code that awaits several at once.
declare global {
    function whenSettled(action: (sandbox: any) => void): Promise<MountResult>;
    function settleOutcome(promise: Promise<unknown>): Promise<CallOutcome>;
}

export const test = base.extend<{ sandbox: SandboxDriver }>({
    sandbox: async ({ page }, use) => {
        await page.addInitScript(() => {
            (window as any).whenSettled = (action: (sandbox: any) => void) => new Promise(resolve => {
                const sandbox = document.querySelector('web-sandbox') as any;
                const settle = (event: Event) => {
                    sandbox.removeEventListener('ready', settle);
                    sandbox.removeEventListener('terminated', settle);
                    resolve(event.type);
                };
                sandbox.addEventListener('ready', settle);
                sandbox.addEventListener('terminated', settle);
                action(sandbox);
            });
            (window as any).settleOutcome = (promise: Promise<unknown>) => promise.then(
                (value) => ({ status: 'resolved', value }),
                (e: any) => ({ status: 'rejected', isError: e instanceof Error, message: e?.message, code: e?.code, keys: e && typeof e === 'object' ? Object.keys(e) : null }));
        });
        const driver = new SandboxDriver(page);
        await driver.open();
        await use(driver);
    },
});

export { expect };
