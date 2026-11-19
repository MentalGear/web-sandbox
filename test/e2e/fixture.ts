import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type { SandboxConfig, SandboxConfigOptions } from '@src/host';
import type { SandboxOrigins } from '@src/lib/csp/origins';
import type { UnsafeCapability } from '@src/csp-directives';
import type { SandboxViolation } from '@src/lib/violation';
import type { FetchBridgeConfig, FetchRecord } from '@src/lib/fetch-bridge';
import { NETWORK_MODES_FLAG, type Build } from '@src/lib/build-flag';
import { APP_OPTIONS } from '@src/lib/config-schema';
import { E2E_ORIGIN, E2E_PORT } from './server';

// The e2e server's origin: the one serving this checkout (server.ts; 4444 in CI, a port of the checkout's own locally).
export const ORIGIN = E2E_ORIGIN;
export const HARNESS = `${ORIGIN}/test/e2e/harness.html`;
// The same server by its address: another site from the harness page's (an IP address is its own site), on a loopback host
// like the page, so a config may list it in every mode. `ORIGIN` itself is the host page's own site, which no mode admits.
export const OFFSITE_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

// What the specs need to run anything at all: scripts in the frame and execute(), in cooperative mode (the mode most
// specs were written for; a spec for another mode names it), and what the harness page's policy is: it sends none
// (`hostContentSecurityPolicy: false`, without which `origins.connect` and `fetchBridge.allow` are dropped). A spec on a
// page that sends a policy passes that policy's text, as docs/API.md#your-connect-src tells an embedder to.
export const BASELINE_CONFIG: SandboxConfig = {
    mode: 'cooperative',
    capabilities: ['allow-scripts'],
    scriptUnsafe: true,
    hostContentSecurityPolicy: false,
};

/**
 * A config for mount(): applied over BASELINE_CONFIG, so one that names no mode is a cooperative config (the baseline's
 * mode), as the specs were written; a sealed, strict or worker config names its mode. Its keys of the app's (`html`,
 * `entry`) go to start()'s first argument and the others to its second (startFresh()). To start an element as an
 * embedder would, with the library's defaults (sealed mode), a spec calls the page's startFresh() itself
 * (default-mode.spec.ts). Deliberately looser than
 * SandboxConfig, which narrows each mode's options (R1:R3-6): specs also mount what a mode drops at run
 * time, to assert that it is dropped.
 */
export type MountConfig = SandboxConfigOptions & { mode?: 'strict' | 'sealed' | 'cooperative' | 'worker'; origins?: SandboxOrigins; fetchBridge?: FetchBridgeConfig; unsafeCapabilities?: UnsafeCapability[] };

/** Why a test that drives its guest with execute() does not run in sealed mode. */
export const SEALED_HAS_NO_EXECUTE = 'execute() runs nothing in sealed mode, which refuses scriptUnsafe: this test runs in strict mode, whose view and worker are sealed mode\'s';

/**
 * The config mount() applies: BASELINE_CONFIG merged with `config`, without `scriptUnsafe` where the mode is sealed, which
 * refuses it (BD6:ISO-1), whether the baseline or the spec gave it: a spec mounts a sealed sandbox to run its guest, and
 * its execute() then skips the test (run()). A spec that asserts the refusal starts its element itself (startFresh()).
 */
export function mounted(config: MountConfig): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...BASELINE_CONFIG, ...config };
    if (merged.mode === 'sealed') delete merged.scriptUnsafe;
    return merged;
}

export type MountResult = 'ready' | 'terminated';

/** How a start() of a spec's own settled: its build's event, or start()'s refusal, which builds nothing. */
export type StartOutcome = MountResult | { refused: string };

/**
 * Starts `config` exactly as given (no baseline), with what the page collected, on the page's element, or a fresh one in its
 * place (startFresh()), as an embedder starts its element: settles to 'ready' or 'terminated', or to `{ refused }` with
 * the message start() threw, in which case the page's element is left as it was.
 */
export const startAs = (page: Page, config: unknown, options: StartOptions = {}): Promise<StartOutcome> => page.evaluate<StartOutcome, { config: any; options: any }>(({ config, options }) => {
    try {
        return startFresh(config, options);
    } catch (error) {
        return { refused: String((error as Error)?.message ?? error) };
    }
}, { config: config as any, options: options as any });

/** One 'violation' event as the harness records it: the element's detail plus which sandbox sent it. */
export type ViolationRecord = SandboxViolation & { sandbox: string };

/** One 'fetch' event (backlog B5) as the harness records it: the element's detail plus which sandbox sent it. */
export type FetchEventRecord = FetchRecord & { sandbox: string };

/**
 * One 'terminated' event, as the fixture records it on every page it drives: the element's reason, which sandbox sent it
 * (its id, 'main' for the harness's own), the element's state when it was dispatched, and when (the page's
 * performance.now(), ms since the page's navigation started).
 */
export type TerminationRecord = { sandbox: string; reason: string; state: string; at: number };

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
 *
 * One app per element (docs/design/01-one-element-one-app.md): the files a spec registers and the host methods it
 * exposes are collected in the page (`sandboxNext`), and each mount() hands them, with its config, to one `start(app,
 * grants)`: the first on the page's own element, which has no app yet, and each after it on a fresh element that takes
 * the place of the last one (startFresh()). A second mount is a second element, never a re-configuration. What is collected stays for the mounts after, as it stayed on the one element before; what
 * is collected once the element is started reaches only the next mount, and until then the driver refuses to talk to
 * the running element (live()), so that no spec reads a running app as if it had what it was never given.
 */
export class SandboxDriver {
    constructor(readonly page: Page) {}

    // The config of the last mount(), which load() starts its markup with.
    private lastMount: MountConfig | null = null;

    /** Opens the harness; `suffix` (a query and/or fragment) lets a spec give the host page a distinctive URL. */
    async open(suffix = '') {
        await this.page.goto(HARNESS + suffix);
        await this.page.waitForFunction(() => (window as any).harnessReady === true);
    }

    /**
     * Starts BASELINE_CONFIG merged with `config` (mounted()) and what the spec registered and exposed on the page's
     * element, or on a fresh one in its place once it has an app (startFresh()), and waits for it to settle. Rejects with start()'s own error when it
     * throws (a refusal of the config, the files or the methods); the page's element is then left as it was.
     */
    async mount(config: MountConfig = {}): Promise<MountResult> {
        this.lastMount = config;
        return this.page.evaluate((merged) => startFresh(merged), mounted(config) as any);
    }

    /**
     * Starts guest markup: a fresh element with the last mount()'s config, `html` as its app's markup, and what the spec
     * registered and exposed, as mount() does.
     */
    async load(html: string): Promise<MountResult> {
        if (this.lastMount === null) throw new Error("[e2e] load() starts the last mount()'s config with new markup: mount() first");
        return this.mount({ ...this.lastMount, html });
    }

    /** Recreates the environment (reset()) and waits for it to settle. */
    async reset(): Promise<MountResult> {
        await this.live();
        return this.page.evaluate(() => whenSettled(s => s.reset()));
    }

    /**
     * The element's lifecycle state (backlog B2). A read of 'terminated' also keeps the terminations recorded so far, so a
     * test that then fails shows why the sandbox ended (the fixture attaches them), even if the page navigates after.
     */
    async state(): Promise<string> {
        const { state, terminations } = await this.page.evaluate(() => ({
            state: (document.querySelector('web-sandbox') as any).state as string,
            terminations: [...((window as any).sandboxTerminations ?? [])] as TerminationRecord[],
        }));
        if (state === 'terminated') this.seenTerminated.push({ readAt: Date.now(), terminations });
        return state;
    }

    /**
     * Every 'terminated' event the sandboxes on this page dispatched so far, in order, with its reason and time
     * (recorded by the fixture's init script, from before the page's own scripts run; a navigation starts a new list).
     */
    async terminations(): Promise<TerminationRecord[]> {
        return this.page.evaluate(() => [...((window as any).sandboxTerminations ?? [])]);
    }

    /** What state() returned 'terminated' with: the terminations recorded at each such read. */
    readonly seenTerminated: { readAt: number; terminations: TerminationRecord[] }[] = [];

    /**
     * Starts a second <web-sandbox id="second"> after the harness's, with BASELINE_CONFIG merged with `config` and
     * `files` as its app's files, and waits for it to settle; a second call takes the place of the first one's. It has
     * no host method. Its log lines land in sandboxLogs too (the harness hears them on window, in the capture phase).
     */
    async mountSecond(config: MountConfig = {}, files: Record<string, FileSpec> = {}): Promise<MountResult> {
        return this.page.evaluate(({ merged, files }) => startFresh(merged, { id: 'second', files: sandboxFileEntries(files), methods: {} }), { merged: mounted(config) as any, files });
    }

    /**
     * Registers files for the next mount (collected in the page, `sandboxNext`). A value is a string, or
     * `{ base64, type? }` for bytes (decoded in the page into a Uint8Array). The batch is validated with what is
     * already collected, as one app's files are: by start() on a detached element of its own, which builds nothing.
     * Settles to 'ok' or the refusal's code, so specs assert refusals by code (backlog B7); a refused batch collects
     * nothing.
     */
    async registerFiles(files: Record<string, FileSpec>): Promise<string> {
        return this.page.evaluate((files) => sandboxCollectFiles(sandboxFileEntries(files)), files);
    }

    /**
     * Collects the running element's pending guest writes for the next mount, each with the type and bytes
     * `listGuestWrites()` gives it: how files one app wrote reach another app, which is an element of its own (as an
     * embedder registers its own copy of bytes it validated). Resolves with the paths collected.
     */
    async collectWrites(): Promise<string[]> {
        return this.page.evaluate(() => {
            const files: Record<string, unknown> = {};
            for (const write of (document.querySelector('web-sandbox') as any).listGuestWrites()) {
                if (write.change === 'write') files[write.path] = { content: write.content, type: write.type };
            }
            const outcome = sandboxCollectFiles(files);
            if (outcome !== 'ok') throw new Error(`[e2e] the guest's writes could not be collected: ${outcome}`);
            return Object.keys(files).sort();
        });
    }

    /** Forgets the files collected so far: the next mount's app has only those registered after this. */
    async forgetFiles() {
        await this.page.evaluate(() => { (window as any).sandboxNext.files = {}; });
    }

    async run(code: string) {
        // Sealed mode refuses scriptUnsafe (BD6:ISO-1), so execute() runs nothing there: a test that drives its guest with
        // execute() is skipped in sealed mode, with this reason, and runs in strict mode, whose view and worker are sealed
        // mode's (view-modes.ts). A test of sealed mode's own gives its guest the entry (inEntry()). The default build
        // has sealed mode alone, so execute() is called only on the build with the network modes.
        await this.live();
        const mode = await this.page.evaluate(() => (document.querySelector('web-sandbox') as any)._config?.mode);
        test.info().skip(buildOfPage(this.page) === 'default' || mode === 'sealed', SEALED_HAS_NO_EXECUTE);
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

    /**
     * Mounts `config` (a strict or sealed one) with an entry that runs `body` (an async function body) and returns what it
     * returns, through JSON, as inGuest() does: the way to run guest code in sealed mode, which has no execute(). `files`
     * are registered beside the entry. A throw comes back as `{ thrown }`.
     */
    async inEntry<T = any>(config: MountConfig, body: string, files: Record<string, FileSpec> = {}, timeout = 15000): Promise<T> {
        const tag = `GUEST_RESULT_${++this.guestRunCount} `;
        const entry = `(async () => { ${body} })().then(
            v => console.log(${JSON.stringify(tag)} + JSON.stringify(v)),
            e => console.log(${JSON.stringify(tag)} + JSON.stringify({ thrown: String(e && e.stack || e) })));`;
        expect(await this.registerFiles({ ...files, 'main.js': entry })).toBe('ok');
        expect(await this.mount({ ...config, entry: 'main.js' })).toBe('ready');
        const line = await this.waitForLog(tag, timeout);
        return JSON.parse(line.slice(tag.length));
    }

    private guestRunCount = 0;

    // ---- β broker helpers (backlog B1) -------------------------------------------------------

    /**
     * Host -> guest: invokes a guest-exposed method and returns its resolved value, the guest's data, `unknown` as the
     * element's call() returns it: a spec narrows it (test/e2e/guest-value.ts) before it reads it.
     */
    async call(method: string, ...args: unknown[]): Promise<unknown> {
        await this.live();
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
        await this.live();
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

    /**
     * Collects a host method for the next mount, from a function-source string (built in the host page, which is not
     * sandboxed): start() takes it in the grants' `methods`, which refuses a name `sandbox:` reserves.
     */
    async exposeHost(name: string, fnSource: string) {
        await this.page.evaluate(({ name, fnSource }) => sandboxCollectMethod(name, new Function('return (' + fnSource + ')')()), { name, fnSource });
    }

    /**
     * Refuses to talk to the running element while files or methods collected after its start() wait for the next
     * mount: the running app was never given them, and a spec that reached it as if it had would read the refusal of a
     * method or a file as its subject's.
     */
    private async live() {
        const pending = await this.page.evaluate(() => (window as any).sandboxNext?.pending === true);
        if (pending) throw new Error('[e2e] files or host methods were collected after the element started: they reach the next mount() only (one app per element). Register and expose them before mount().');
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

/**
 * The pairing of a test with its build (ADR-009), for every page of `target`, before any script of a page runs:
 *
 * - the page is told its build (`window.sandboxBuild`), which every harness page loads the library by (library.ts);
 * - `start()` of every element the page defines refuses, by throwing, grants that are the other build's to test: on
 *   the default build those of a network mode (strict, cooperative, worker), on the network build those of sealed mode
 *   (no mode, or `'sealed'`; no grants at all). So a spec cannot pass against the wrong build: its first start() stops
 *   it, with the fix.
 *   `otherBuildConfigs` lifts that for a test whose subject is exactly such a config (the default build's refusal of a
 *   network mode; the network build's own sealed mode).
 *
 * The fixture calls it for the test's context, so for every page of it. A spec that makes a browser context of its own
 * calls it for that context.
 */
export async function pairWithBuild(target: BrowserContext | Page, build: Build, otherBuildConfigs = false): Promise<void> {
    PAIRED.set(target, build);
    await target.addInitScript(({ build, strict, networkModes }) => {
        // Only in a page a server sent: an init script runs in every frame, and the sandbox's own frames are the guest's realm.
        if (!location.protocol.startsWith('http')) return;
        Object.defineProperty(window, 'sandboxBuild', { value: build, configurable: true });
        if (!strict) return;
        const refusal = (config: unknown): string | null => {
            if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
            const mode = (config as { mode?: unknown }).mode;
            const sealed = mode === undefined || mode === 'sealed';
            const network = (networkModes as readonly unknown[]).includes(mode);
            if (build === 'default' && network) return `an app of ${String(mode)} mode was started on the default build, which has sealed mode alone: declare test.use({ build: 'network' }) for this test`;
            if (build === 'network' && sealed) return "a sealed app was started on the build with the network modes: a sealed test runs on the default build (test.use({ build: 'default' }), the fixture's default; buildOfMode(mode) in a loop over modes)";
            return null;
        };
        const define = CustomElementRegistry.prototype.define;
        CustomElementRegistry.prototype.define = function (this: CustomElementRegistry, name: string, constructor: CustomElementConstructor, options?: ElementDefinitionOptions) {
            const prototype = constructor.prototype as { start?: (app: unknown, grants?: unknown) => unknown };
            const start = prototype.start;
            if (typeof start === 'function' && !Object.hasOwn(start, 'pairedWithBuild')) {
                // the mode is a grant: no grants are sealed mode's, as start() reads them
                const paired = function (this: unknown, app: unknown, grants?: unknown) {
                    const refused = refusal(grants === undefined ? {} : grants);
                    if (refused !== null) throw new Error(`[e2e] ${refused}. A test whose subject is such an app declares test.use({ otherBuildConfigs: true }).`);
                    return Reflect.apply(start, this, [app, grants]);
                };
                Object.defineProperty(paired, 'pairedWithBuild', { value: true });
                prototype.start = paired;
            }
            return Reflect.apply(define, this, [name, constructor, options]);
        };
    }, { build, strict: !otherBuildConfigs, networkModes: [...NETWORK_MODES_FLAG.modes] });
}

// The build each paired context or page was told, for what the test's own side needs of it (the hash of its bootstrap).
const PAIRED = new WeakMap<object, Build>();

/** The build the pages of `page` run: the one its context, or the page itself, was paired with; the default build otherwise. */
export const buildOfPage = (page: Page): Build => PAIRED.get(page) ?? PAIRED.get(page.context()) ?? 'default';

/** What a test declares about its build with `test.use()`. */
export interface BuildOptions {
    /**
     * The build of the library the test's pages run: `'default'`, the package as published (sealed mode alone), or
     * `'network'`, the build with the network modes. A test of sealed mode runs on the default build, a test of strict,
     * cooperative or worker mode on the network build; `buildOfMode(mode)` gives the build of a mode in a loop over modes.
     */
    build: Build;
    /**
     * Whether the test gives its build a config that is the other build's to test, on purpose (pairWithBuild): the
     * default build's refusal of a network mode, or the network build's own sealed mode.
     */
    otherBuildConfigs: boolean;
}

// Injected into the page: resolves once the sandbox reports 'ready' or 'terminated'.
// settleOutcome turns a call's promise into a CallOutcome, for page-side code that awaits several at once.
// startFresh and the collectors are installStarter's (below).
declare global {
    function whenSettled(action: (sandbox: any) => void): Promise<MountResult>;
    function settleOutcome(promise: Promise<unknown>): Promise<CallOutcome>;
    function startFresh(config: unknown, options?: StartOptions): Promise<MountResult>;
    function sandboxFileEntries(files: Record<string, FileSpec>): Record<string, unknown>;
    function sandboxCollectFiles(entries: Record<string, unknown>): string;
    function sandboxCollectMethod(name: string, method: unknown): void;
    function sandboxSplit(config: unknown): [app: Record<string, unknown>, grants: Record<string, unknown>];
}

/** Where startFresh() puts its element, and what its app gets besides its config. */
export interface StartOptions {
    /** The tag of the element: `'web-sandbox'` unless the page defined another. */
    readonly tag?: string;
    /** The element's id: it is the element with this id, or takes its place, or is appended. None: the page's first element of `tag`. */
    readonly id?: string;
    /** The app's files: what the page collected (`sandboxNext.files`) unless given. */
    readonly files?: Record<string, unknown>;
    /** The host methods: what the page collected (`sandboxNext.methods`) unless given. */
    readonly methods?: Record<string, unknown>;
}

/**
 * The page's side of one app per element, installed in every page the driver opens:
 *
 * - `sandboxNext`: the files and host methods collected for the next start (`pending` once something was collected
 *   while the page's element is started: the running app never gets it);
 * - `startFresh(config, options)`: one `start(app, grants)` on a fresh element, the config's keys of the app's
 *   (`appKeys`, CONFIG_SCHEMA's `owner: 'app'`) in the first argument with the files, the others in the second with the
 *   methods. The page's element takes the app itself while it has none (the one the page inserted, as an embedder's
 *   element in markup); once it has one, a fresh element takes its place, which ends the last one's environment as a
 *   removal does (no `terminated`). The promise settles at the element's `ready` or `terminated`; start()'s own throw
 *   is thrown, before anything of the page changes. The page's hook `sandboxAdopt(element)`, where it has one, sizes a
 *   fresh element and adds its listeners first;
 * - `sandboxSplit(config)`: a config in one object, as mount() takes it, as start()'s two arguments, `[app, grants]`, as startFresh() splits
 *   it, for a spec that starts an element itself;
 * - `sandboxCollectFiles(entries)`: the batch validated with what is collected by start() on a detached element, which
 *   builds nothing, then collected; 'ok' or the refusal's code.
 */
function installStarter({ appKeys }: { appKeys: readonly string[] }) {
    // Only in a page a server sent: an init script runs in every frame, and the sandbox's own frames are the guest's realm.
    if (!location.protocol.startsWith('http')) return;
    const w = window as any;
    const next = { files: {} as Record<string, unknown>, methods: {} as Record<string, unknown>, pending: false };
    w.sandboxNext = next;
    const collected = () => {
        if ((document.querySelector('web-sandbox') as any)?.started === true) next.pending = true;
    };
    w.sandboxFileEntries = (files: Record<string, FileSpec>) => {
        const entries: Record<string, unknown> = {};
        for (const [path, spec] of Object.entries(files)) {
            if (typeof spec === 'string') { entries[path] = spec; continue; }
            const bytes = Uint8Array.from(atob(spec.base64), c => c.charCodeAt(0));
            entries[path] = spec.type ? { content: bytes, type: spec.type } : bytes;
        }
        return entries;
    };
    w.sandboxCollectFiles = (entries: Record<string, unknown>) => {
        const merged = { ...next.files, ...entries };
        const probe = document.createElement('web-sandbox') as any;
        try {
            probe.start({ files: merged }, w.sandboxBuild === 'network' ? { mode: 'cooperative' } : undefined);
        } catch (e: any) {
            return String(e?.code);
        }
        next.files = merged;
        collected();
        return 'ok';
    };
    w.sandboxCollectMethod = (name: string, method: unknown) => {
        next.methods = { ...next.methods, [name]: method };
        collected();
    };
    w.sandboxSplit = (config: unknown) => {
        const app: Record<string, unknown> = {};
        const grants: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(config as object)) {
            if (appKeys.includes(key)) app[key] = value;
            else grants[key] = value;
        }
        return [app, grants];
    };
    w.startFresh = (config: unknown, options: StartOptions = {}) => {
        const tag = options.tag ?? 'web-sandbox';
        const files = options.files ?? next.files;
        const methods = options.methods ?? next.methods;
        const [app, grants] = w.sandboxSplit(config);
        if (Object.keys(files).length > 0) app.files = files;
        if (Object.keys(methods).length > 0) grants.methods = methods;
        const old = (options.id === undefined ? document.querySelector(tag) : document.getElementById(options.id)) as any;
        // the page's element while it has no app (the harness's own, as the page inserted it) takes this one, in place
        const reused = old !== null && old.started === false;
        const fresh = reused ? old : document.createElement(tag) as any;
        if (!reused && options.id !== undefined) fresh.id = options.id;
        if (!reused) w.sandboxAdopt?.(fresh);
        fresh.start(app, grants);
        if (options.id === undefined) next.pending = false;
        const settled = new Promise(resolve => {
            const settle = (event: Event) => {
                fresh.removeEventListener('ready', settle);
                fresh.removeEventListener('terminated', settle);
                resolve(event.type);
            };
            fresh.addEventListener('ready', settle);
            fresh.addEventListener('terminated', settle);
        });
        if (old === null) document.body.appendChild(fresh);
        else if (!reused) old.replaceWith(fresh);
        return settled;
    };
}

export const test = base.extend<{ sandbox: SandboxDriver; paired: void } & BuildOptions>({
    build: ['default', { option: true }],
    otherBuildConfigs: [false, { option: true }],
    // Every page of the test's context is paired with its build, whether or not the test drives the harness's own element.
    paired: [async ({ context, build, otherBuildConfigs }, use) => {
        await pairWithBuild(context, build, otherBuildConfigs);
        await use();
    }, { auto: true }],
    sandbox: async ({ page }, use, testInfo) => {
        await page.addInitScript(() => {
            // Every termination is self-explaining (the e2e fixture's rule): each 'terminated' event any sandbox on the
            // page dispatches is recorded with its reason, before a listener of the page's could stop it (capture, at
            // the window: the first listener of every dispatch, whether or not the event bubbles).
            // Only in the host page: an init script runs in every frame, and the guest's realm is the guest's.
            if (window === window.top) {
                const terminations: unknown[] = [];
                Object.defineProperty(window, 'sandboxTerminations', { value: terminations });
                window.addEventListener('terminated', (event: Event) => {
                    const target = event.target as any;
                    terminations.push({
                        sandbox: target?.id || 'main',
                        reason: String((event as CustomEvent).detail?.reason),
                        state: String(target?.state),
                        at: Math.round(performance.now()),
                    });
                }, { capture: true });
            }
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
        await page.addInitScript(installStarter, { appKeys: [...APP_OPTIONS] });
        const driver = new SandboxDriver(page);
        await driver.open();
        await use(driver);
        // A test that failed shows every termination: those its state() reads saw, and those on the page now.
        if (testInfo.status !== testInfo.expectedStatus) {
            let now: TerminationRecord[] | string;
            try { now = await driver.terminations(); } catch (error) { now = `(not readable: ${String(error)})`; }
            const lines = [
                ...driver.seenTerminated.map(({ readAt, terminations }) =>
                    `state() read 'terminated' at ${new Date(readAt).toISOString()}; terminations then:\n${formatTerminations(terminations)}`),
                `terminations on the page at the end of the test:\n${typeof now === 'string' ? now : formatTerminations(now)}`,
            ];
            await testInfo.attach('sandbox terminations', { body: lines.join('\n'), contentType: 'text/plain' });
        }
    },
});

function formatTerminations(terminations: TerminationRecord[]): string {
    if (terminations.length === 0) return '  (none)';
    return terminations.map(t => `  [${t.sandbox}] at ${t.at} ms (state ${t.state}): ${t.reason}`).join('\n');
}

export { expect };
export { buildOfMode, type Build } from '@src/lib/build-flag';
