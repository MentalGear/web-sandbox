import { test as base, expect, type Page } from '@playwright/test';
import type { SandboxConfig } from '@src/host';
import type { SandboxViolation } from '@src/lib/violation';
import type { FetchRecord } from '@src/lib/fetch-bridge';

// The e2e server's origin; a local config that runs a second server on another port sets WEB_SANDBOX_E2E_ORIGIN.
export const ORIGIN = process.env.WEB_SANDBOX_E2E_ORIGIN || 'http://localhost:4444';
export const HARNESS = `${ORIGIN}/test/e2e/harness.html`;

// What the specs need to run anything at all: scripts in the frame and execute().
export const BASELINE_CONFIG: SandboxConfig = {
    capabilities: ['allow-scripts'],
    scriptUnsafe: true,
};

export type MountResult = 'ready' | 'terminated';

/** One 'violation' event as the harness records it: the element's detail plus which sandbox sent it. */
export type ViolationRecord = SandboxViolation & { sandbox: string };

/** One 'fetch' event (backlog B5) as the harness records it: the element's detail plus which sandbox sent it. */
export type FetchEventRecord = FetchRecord & { sandbox: string };

/** A file for SandboxDriver.registerFiles(): text, or bytes as base64 with an optional type override. */
export type FileSpec = string | { base64: string; type?: string };

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

    /** Opens the harness; `suffix` (a query and/or fragment) lets a spec give the host page a distinctive URL. */
    async open(suffix = '') {
        await this.page.goto(HARNESS + suffix);
        await this.page.waitForFunction(() => (window as any).harnessReady === true);
    }

    /** Applies BASELINE_CONFIG merged with `config`, and waits for the sandbox to become ready. */
    async mount(config: SandboxConfig = {}): Promise<MountResult> {
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
    async mountSecond(config: SandboxConfig = {}): Promise<MountResult> {
        return this.page.evaluate((merged) => new Promise<MountResult>(resolve => {
            const second = document.createElement('web-sandbox') as any;
            second.id = 'second';
            second.addEventListener('ready', () => resolve('ready'), { once: true });
            second.addEventListener('terminated', () => resolve('terminated'), { once: true });
            second.setConfig(merged); // detached: only stores the config, the frame is built on insertion
            document.body.appendChild(second);
        }), { ...BASELINE_CONFIG, ...config } as any);
    }

    /**
     * Registers files on a sandbox in the page (default: the harness's). A value is a string, or
     * `{ base64, type? }` for bytes (decoded in the page into a Uint8Array). Settles to 'ok' or the
     * refusal's code, so specs assert refusals by code (backlog B7).
     */
    async registerFiles(files: Record<string, FileSpec>, selector = 'web-sandbox'): Promise<string> {
        return this.page.evaluate(({ files, selector }) => {
            const entries: Record<string, unknown> = {};
            for (const [path, spec] of Object.entries(files)) {
                if (typeof spec === 'string') { entries[path] = spec; continue; }
                const bytes = Uint8Array.from(atob(spec.base64), c => c.charCodeAt(0));
                entries[path] = spec.type ? { content: bytes, type: spec.type } : bytes;
            }
            try {
                (document.querySelector(selector) as any).registerFiles(entries);
                return 'ok';
            } catch (e: any) {
                return String(e?.code);
            }
        }, { files, selector });
    }

    async run(code: string) {
        await this.page.evaluate((source) => (document.querySelector('web-sandbox') as any).execute(source), code);
    }

    /**
     * Runs `body` (an async function body) inside the guest via execute() and returns what it returns,
     * through JSON. A throw comes back as `{ thrown }`. Needs scriptUnsafe (the baseline config has it).
     */
    async inGuest<T = any>(body: string, timeout = 15000): Promise<T> {
        const tag = `GUEST_RESULT_${++this.guestRunCount} `;
        await this.run(`(async () => { ${body} })().then(
            v => console.log(${JSON.stringify(tag)} + JSON.stringify(v)),
            e => console.log(${JSON.stringify(tag)} + JSON.stringify({ thrown: String(e && e.stack || e) })))`);
        const line = await this.waitForLog(tag, timeout);
        return JSON.parse(line.slice(tag.length));
    }

    private guestRunCount = 0;

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

    // ---- CSP violation reports (backlog S5) ---------------------------------------------------

    /**
     * The 'violation' events every sandbox on the page dispatched so far, in order. `sandbox` is the
     * element's id ('main' for the harness's own). Guest-supplied: evidence that the guest attempted a
     * refused load, never proof that nothing else happened.
     */
    async violations(): Promise<ViolationRecord[]> {
        return this.page.evaluate(() => [...(window as any).sandboxViolations]);
    }

    async clearViolations() {
        await this.page.evaluate(() => { (window as any).sandboxViolations.length = 0; });
    }

    /**
     * Resolves with the first reported violation of `directive` whose blockedURI starts with `blocked`
     * (browsers may reduce a URL to its origin, e.g. for frame-src); throws on timeout.
     */
    async waitForViolation(directive: string, blocked: string, timeout = 5000): Promise<ViolationRecord> {
        const handle = await this.page.waitForFunction(({ directive, blocked }) => {
            const all: ViolationRecord[] = (window as any).sandboxViolations;
            return all.find(v => v.directive === directive && v.blockedURI.startsWith(blocked));
        }, { directive, blocked }, { timeout });
        return handle.jsonValue() as Promise<ViolationRecord>;
    }

    // ---- the fetch bridge's 'fetch' events (backlog B5) ------------------------------------------

    /** Every 'fetch' event the sandboxes on the page dispatched so far, in order. */
    async fetches(): Promise<FetchEventRecord[]> {
        return this.page.evaluate(() => [...(window as any).sandboxFetches]);
    }

    /** Resolves with the first 'fetch' event whose url starts with `url`; throws on timeout. */
    async waitForFetch(url: string, timeout = 5000): Promise<FetchEventRecord> {
        const handle = await this.page.waitForFunction((url) => {
            const all: FetchEventRecord[] = (window as any).sandboxFetches;
            return all.find(record => record.url.startsWith(url));
        }, url, { timeout });
        return handle.jsonValue() as Promise<FetchEventRecord>;
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
