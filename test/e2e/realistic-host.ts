import { randomUUID } from 'node:crypto';
import type { SandboxConfigOptions } from '@src/host';
import { scriptHashSource } from '@src/lib/csp/script-hash';
import { WRAPPER_STYLE } from '@src/lib/frame-documents';
import { VIEW_STILL_STYLE } from '@src/lib/in-sandbox-view';
import type { InheritedContextId } from '@src/lib/inherited-context';
import { expect, ORIGIN, type SandboxDriver } from './fixture';
import { HOST_COOKIES, REALISTIC_HOST_PATH, type ApiHit, type PageHeader, type SessionRecord } from './realistic-host-server';
import { isDevServerNoise } from './dev-server-noise';

/**
 * A host page that looks like a production application, for every test that wants one (S74, class A; CONTRIBUTING.md,
 * "End-to-end tests"). The sandbox's frames inherit what the host page has around them, so a spec on a bare harness
 * cannot see a feature of the page that interacts with them; on this page the features are all there, none of them
 * written for the sandbox:
 *
 *   - a strict Content-Security-Policy that admits the library the way docs/API.md#host-page-policy says (the view
 *     bootstrap's `viewScriptHash()`, the wrapper style's hash, `worker-src blob:`, `base-uri 'self' about:`), a
 *     `report-uri` and `require-trusted-types-for 'script'` with a `trusted-types` list;
 *   - a Trusted Types policy of the application's own and a default policy, which counts the strings it is asked about;
 *   - a cache-first Service Worker for the application's API, and a `fetch` wrapper that adds the user's Authorization header
 *     to the application's own requests;
 *   - cookies on the host site with SameSite None, Lax and Strict, a token in localStorage, a Permissions-Policy and a
 *     Referrer-Policy;
 *   - an error reporter, and listeners for focus and the page's lifecycle;
 *   - optionally cross-origin isolation (COOP `same-origin` with COEP `require-corp`).
 *
 * The test server plays the application's backend (realistic-host-server.ts) and records, per session, every request that
 * reaches the API with all its headers, every request the Service Worker handled, and every CSP report: `hits()`.
 * `embed()` puts the element in each mode, with the origins and the fetch bridge a test names, and a guest that makes the
 * requests `guestBattery()` writes.
 *
 * Which script-src profile a mode needs is the docs' (`policyProfile`): strict mode takes the hash beside the page's
 * own; cooperative and worker mode take `'unsafe-inline'`, and worker mode runs guest code only through `execute()`, which
 * needs `'unsafe-eval'` and so no Trusted Types: `guestCode: 'execute'` is that page.
 */

export const HOST_BASE = `${ORIGIN}${REALISTIC_HOST_PATH}`;
export const HOST_TOKEN = 'Bearer HOST-SESSION-TOKEN';

/** Names the INHERITED_CONTEXT row (src/lib/inherited-context.ts) an assertion covers, in its message: `expect(x, covering('cookies', 'none on a guest request'))`. */
export const covering = (row: InheritedContextId, what: string) => `[${row}] ${what}`;

// ---- the host page's policy ------------------------------------------------------------------------------------------

/** A Content-Security-Policy as data: a directive and its sources, in order. */
export type Directives = Record<string, string[]>;

export const serializeCsp = (directives: Directives) => Object.entries(directives).map(([directive, sources]) => [directive, ...sources].join(' ')).join('; ');

export type HostMode = 'strict' | 'sealed' | 'cooperative' | 'worker';

export interface HostOptions {
    /** The mode the page embeds: the script-src and style-src profile the docs name for it. */
    mode: HostMode;
    /** `'execute'`: the page admits `execute()` (`'unsafe-eval'`, no Trusted Types): worker mode's only way to run guest code. */
    guestCode?: 'none' | 'execute';
    /** COOP `same-origin` and COEP `require-corp`. */
    isolation?: boolean;
    /** Other headers of the page, set or replaced (see PAGE_HEADERS in realistic-host-server.ts). */
    headers?: Partial<Record<PageHeader, string>>;
    /** The page's Trusted Types default policy (default: on, where Trusted Types is enforced). */
    ttDefault?: boolean;
    /** The page's Service Worker (default: on). */
    serviceWorker?: boolean;
    /** The host site's cookies (default: on). */
    cookies?: boolean;
    /** Edits the policy the page would send (the directive matrix sets one directive; a test adds the origins it lists to connect-src). */
    directives?: (base: Directives) => Directives;
}

/**
 * The hash sources docs/API.md#host-page-policy lists, computed from the library's text. The view bootstrap's hash is the
 * browser's: the page serves it as `viewScriptHash()` (an embedder reads it from the package it ships, in a build step; the
 * dev server's transform of the bootstrap is not Node's, so a Node import of the source gives another hash than the page).
 */
export const POLICY_HASHES = {
    wrapperStyle: scriptHashSource(WRAPPER_STYLE),
    animationStyle: scriptHashSource(VIEW_STILL_STYLE),
} as const;

/** What the page's `script-src` and `style-src` carry for a mode (docs/API.md#host-page-policy). */
export function policyProfile(mode: HostMode, viewHash: string): { script: string[]; style: string[] } {
    // sealed mode is strict mode's view and worker: the same profile
    if (mode === 'strict' || mode === 'sealed') return { script: [viewHash], style: [POLICY_HASHES.wrapperStyle, POLICY_HASHES.animationStyle] };
    return { script: ["'unsafe-inline'"], style: ["'unsafe-inline'"] };
}

/** The policy of a production application that embeds the library the way the docs say. */
export function hostDirectives(options: HostOptions & { session: string; viewHash: string }): Directives {
    const profile = policyProfile(options.mode, options.viewHash);
    const execute = options.guestCode === 'execute';
    const enforcesTrustedTypes = !execute;
    const directives: Directives = {
        'default-src': ["'self'"],
        'script-src': ["'self'", ...profile.script, ...(execute ? ["'unsafe-eval'"] : [])],
        'worker-src': ["'self'", 'blob:'],
        'style-src': ["'self'", ...profile.style],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'", 'about:'],
        'form-action': ["'self'"],
        'frame-ancestors': ["'self'"],
        'report-uri': [`${REALISTIC_HOST_PATH}/report/${options.session}`],
    };
    if (enforcesTrustedTypes) {
        directives['require-trusted-types-for'] = ["'script'"];
        directives['trusted-types'] = ['app', 'web-sandbox', ...(options.ttDefault === false ? [] : ['default'])];
    }
    return options.directives ? options.directives(directives) : directives;
}

// ---- what a test reads ---------------------------------------------------------------------------------------------------

export type HostEvent = { type: 'ready' | 'terminated'; reason: string | null };

/** What reached the host's backend in this session. */
export type HostHits = SessionRecord;
export type { ApiHit };

/** The names of the host's cookies by the SameSite value they carry. */
export const HOST_COOKIE_BY_SAME_SITE = { None: 'hs_none', Lax: 'hs_lax', Strict: 'hs_strict' } as const;

/** The names of cookies in a `Cookie` header. */
export const cookieNames = (header: string | string[] | undefined) =>
    String(header ?? '').split(';').map(part => part.trim().split('=')[0]!).filter(Boolean).sort();

/** The hits of one API name. */
export const hitsNamed = (hits: ApiHit[], name: string) => hits.filter(hit => hit.name === name);

export class RealisticHost {
    readonly session = randomUUID();
    readonly consoleErrors: string[] = [];
    readonly consoleWarnings: string[] = [];
    readonly pageErrors: string[] = [];
    private options!: HostOptions;
    private guestCount = 0;

    constructor(readonly sandbox: SandboxDriver) {
        const { page } = sandbox;
        // (the Chromium line about a first build that runs no script is not a policy violation of the library's)
        page.on('console', (message) => {
            // (the dev server's HMR client, which the e2e server runs without a socket, says so on Firefox)
            if (message.type() === 'error' && !message.text().startsWith('Blocked script execution') && !isDevServerNoise(message.text())) this.consoleErrors.push(message.text());
            if (message.type() === 'warning') this.consoleWarnings.push(message.text());
        });
        page.on('pageerror', (error) => { this.pageErrors.push(String(error)); });
    }

    get page() { return this.sandbox.page; }

    /** The policy the page was sent with. */
    csp!: string;

    /** The URL of one of the host's API names on its own origin. */
    api(name: string) { return `${HOST_BASE}/api/${this.session}/${name}`; }

    /** Opens the host page; the element is on it, with no script to run yet. */
    static async open(sandbox: SandboxDriver, options: HostOptions): Promise<RealisticHost> {
        const host = new RealisticHost(sandbox);
        await host.open(options);
        return host;
    }

    async open(options: HostOptions) {
        this.options = options;
        const { page } = this;
        // the host page's securitypolicyviolation events, from before its own scripts run (a violation the library causes
        // is reported to the page, even when the library catches the refusal)
        await page.addInitScript(() => {
            if (window !== window.top || 'hostViolations' in window) return;
            const seen: string[] = [];
            Object.defineProperty(window, 'hostViolations', { value: seen });
            document.addEventListener('securitypolicyviolation', (event) => { seen.push(`${event.violatedDirective} ${event.blockedURI} ${event.sample}`); });
        });
        this.csp = serializeCsp(hostDirectives({ ...options, session: this.session, viewHash: await this.viewHash() }));
        const query = new URLSearchParams({ session: this.session, csp: this.csp });
        if (options.isolation) { query.set('h-cross-origin-opener-policy', 'same-origin'); query.set('h-cross-origin-embedder-policy', 'require-corp'); }
        for (const [header, value] of Object.entries(options.headers ?? {})) query.set(`h-${header}`, value);
        if (options.cookies === false) query.set('cookies', '0');
        if (options.serviceWorker === false) query.set('sw', '0');
        if (options.guestCode !== 'execute' && options.ttDefault !== false) query.set('tt-default', '1');
        // (a page with a Cross-Origin-Opener-Policy is a new browsing context group; going there straight from the harness page
        // makes Playwright's Firefox throw on a frame it lost, so the old page is left first)
        await page.goto('about:blank');
        await page.goto(`${HOST_BASE}/page?${query}`);
        await page.waitForFunction(() => (window as any).harnessReady === true);
        // the element's first build (no script to run) has finished: its 'ready' is not a later build's (a host policy can end it
        // already: a Trusted Types list that does not name the library's policy)
        await page.waitForFunction(() => ['ready', 'terminated'].includes((document.querySelector('web-sandbox') as any).state));
        // The host site's cookies. An engine that refuses a `Secure` cookie on an http page (WebKit) is given it by the
        // context instead: the page is a test server's, a production page is https.
        if (options.cookies !== false) {
            const context = page.context();
            const have = new Set((await context.cookies()).map(cookie => cookie.name));
            const missing = HOST_COOKIES.filter(cookie => !have.has(cookie.name));
            await context.addCookies(missing.map(cookie => ({
                name: cookie.name, value: cookie.value, domain: 'localhost', path: '/', secure: cookie.attributes.includes('Secure'),
                sameSite: cookie.attributes.includes('None') ? 'None' as const : cookie.attributes.includes('Lax') ? 'Lax' as const : 'Strict' as const,
            })));
            expect((await context.cookies()).map(cookie => cookie.name).sort(), "the host site's cookies are in the jar").toEqual(HOST_COOKIES.map(cookie => cookie.name).sort());
        }
    }

    /** The view bootstrap's hash as the page serves it (read once per worker, from a page with no policy). */
    private async viewHash(): Promise<string> {
        if (viewHashOfThisRun === undefined) {
            await this.page.goto(`${HOST_BASE}/page?session=hash&sw=0&cookies=0`);
            await this.page.waitForFunction(() => (window as any).harnessReady === true);
            viewHashOfThisRun = await this.page.evaluate(() => (window as any).viewScriptHash() as string);
        }
        return viewHashOfThisRun;
    }

    /** What the backend recorded; `clear` empties it. */
    async hits(clear = false): Promise<HostHits> {
        const response = await fetch(`${HOST_BASE}/hits/${this.session}${clear ? '?clear=1' : ''}`);
        return await response.json() as HostHits;
    }

    /** The host application's own request to its API: through its fetch wrapper, with its cookies, through its Service Worker. */
    async hostFetch(name: string): Promise<{ status: number; body: string }> {
        return this.page.evaluate((n) => (window as any).hostFetch(n), name);
    }

    /** Puts a response in the cache the host's Service Worker answers from (what a runtime-caching worker has cached for a credentialed API response). */
    async seedCache(name: string, body: string) {
        await this.page.evaluate(async ({ url, body }) => {
            const cache = await caches.open('host-api');
            await cache.put(url, new Response(body, { headers: { 'content-type': 'text/plain' } }));
        }, { url: this.api(name), body });
    }

    /** Whether the host's Service Worker controls the page (Playwright's Firefox never lets one control the harness). */
    async serviceWorker(): Promise<{ registered: boolean; controlled: boolean; error?: string }> {
        return this.page.evaluate(() => (window as any).hostServiceWorker);
    }

    /** The host page's securitypolicyviolation events so far (library writes must add none). */
    async cspViolations(): Promise<string[]> {
        return this.page.evaluate(() => [...((window as any).hostViolations ?? [])]);
    }

    /** The strings the host's Trusted Types default policy was asked about so far. */
    async ttDefaultCalls(): Promise<string[]> {
        return this.page.evaluate(() => [...((window as any).hostTtDefaultCalls ?? [])]);
    }

    /** What the host's error reporter saw (`error` and `unhandledrejection`). */
    async reportedErrors(): Promise<string[]> {
        return this.page.evaluate(() => [...((window as any).hostErrors ?? [])]);
    }

    /** setConfig() on the element, and the lifecycle events from then on, once it settled. */
    async configure(config: object): Promise<HostEvent[]> {
        const { page } = this;
        await page.evaluate(() => { (window as any).sandboxEvents.length = 0; });
        await page.evaluate((c) => whenSettled(s => s.setConfig(c)), config as any);
        await page.waitForTimeout(300); // a termination right after 'ready' would show here
        return page.evaluate(() => [...(window as any).sandboxEvents]);
    }

    /**
     * The element in a mode, as an embedder would configure it (the library's defaults, the mode named, and the page's
     * policy as `hostContentSecurityPolicy`), running `guest` (an async function body that returns what it saw; see `guestBattery()`):
     * strict and sealed mode as the entry file, cooperative mode as the guest document's script, worker mode through `execute()`
     * (a page with `guestCode: 'execute'`).
     */
    async embed(mode: HostMode, embed: { origins?: object; fetchBridge?: object; guest?: string; config?: SandboxConfigOptions & Record<string, unknown> } = {}): Promise<HostEvent[]> {
        const { sandbox } = this;
        await sandbox.clearLogs();
        const source = embed.guest === undefined ? undefined : guestProgram(embed.guest, ++this.guestCount);
        // the page's policy as an embedder passes it (docs/API.md#your-connect-src): without it the connect lists are dropped
        const shared = { hostContentSecurityPolicy: this.csp, ...(embed.origins ? { origins: embed.origins } : {}), ...(embed.fetchBridge ? { fetchBridge: embed.fetchBridge } : {}), ...embed.config };
        if (mode === 'strict' || mode === 'sealed') {
            if (source !== undefined) await sandbox.registerFiles({ 'main.js': `sandboxView.render('<p id="hello">hello</p>'); ${source}` });
            else await sandbox.registerFiles({ 'main.js': `sandboxView.render('<p id="hello">hello</p>');` });
            return this.configure({ mode, entry: 'main.js', ...shared });
        }
        if (mode === 'cooperative') {
            const html = `<p>guest document</p>${source === undefined ? '' : `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`}`;
            return this.configure({ mode, capabilities: ['allow-scripts'], html, ...shared });
        }
        const events = await this.configure({ mode, ...(this.options.guestCode === 'execute' ? { scriptUnsafe: true } : {}), ...shared });
        if (source !== undefined) await sandbox.run(source);
        return events;
    }

    /** What the guest of the last embed() returned, once it has finished. */
    async guestResult<T = Record<string, any>>(timeout = 15000): Promise<T> {
        const tag = `${GUEST_TAG}${this.guestCount} `;
        const line = await this.sandbox.waitForLog(tag, timeout);
        return JSON.parse(line.slice(line.indexOf(tag) + tag.length));
    }

    /** The lifecycle state of the element. */
    state() { return this.sandbox.state(); }

    /** The number of frames the element holds in its shadow root. */
    frames(): Promise<number> {
        return this.page.evaluate(() => (document.querySelector('web-sandbox') as HTMLElement).shadowRoot?.querySelectorAll('iframe').length ?? 0);
    }
}

const GUEST_TAG = 'HOSTGUEST';
let viewHashOfThisRun: string | undefined;

/** Wraps a guest body: it runs once and logs what it returned (or its throw) under a tag the host reads. */
function guestProgram(body: string, count: number): string {
    return `(async () => { try { const r = await (async () => { ${body} })(); console.log('${GUEST_TAG}${count} ' + JSON.stringify(r)); } catch (e) { console.log('${GUEST_TAG}${count} ' + JSON.stringify({ thrown: String(e && e.message) })); } })();`;
}

/**
 * A guest that makes the requests a sandbox can make, to the URLs a test names, and returns how each settled:
 *   - `direct`: its own `fetch` with credentials `include`, and a `no-cors` POST with credentials; keys `<key>:include` and `<key>:nocors`
 *   - `images`: an `<img>` load, in cooperative mode only (`<key>:img`)
 *   - `bridge`: `sandboxFetch()` through the fetch bridge (`<key>:bridge`)
 *   - `extra`: statements that add to `out` before it is returned
 * The server-side evidence is what reached the backend; what the guest saw is only its own view.
 */
export function guestBattery(targets: { direct?: Record<string, string>; images?: Record<string, string>; bridge?: Record<string, string> }, extra = ''): string {
    const lines = ['const out = {};', "const attempt = async (key, run) => { try { out[key] = await run(); } catch (e) { out[key] = 'ERR ' + (e && (e.code || e.name)); } };"];
    for (const [key, url] of Object.entries(targets.direct ?? {})) {
        lines.push(`await attempt(${JSON.stringify(`${key}:include`)}, async () => (await fetch(${JSON.stringify(url)}, { credentials: 'include' })).status);`);
        lines.push(`await attempt(${JSON.stringify(`${key}:nocors`)}, async () => (await fetch(${JSON.stringify(url)}, { mode: 'no-cors', credentials: 'include', method: 'POST', body: 'x' })).type);`);
    }
    for (const [key, url] of Object.entries(targets.images ?? {})) {
        lines.push(`await attempt(${JSON.stringify(`${key}:img`)}, () => new Promise(done => { const image = new Image(); image.onload = () => done('loaded'); image.onerror = () => done('error'); image.src = ${JSON.stringify(url)}; }));`);
    }
    for (const [key, url] of Object.entries(targets.bridge ?? {})) {
        lines.push(`await attempt(${JSON.stringify(`${key}:bridge`)}, async () => (await (await sandboxFetch(${JSON.stringify(url)})).json()));`);
    }
    if (extra) lines.push(extra);
    lines.push('return out;');
    return lines.join('\n');
}


export { startSiblingApi, type SiblingHit } from './realistic-host-sibling';
export { HOST_COOKIES };
