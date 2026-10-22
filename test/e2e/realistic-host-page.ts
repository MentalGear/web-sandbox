// The realistic host page's one script (served by test/e2e/realistic-host-server.ts; docs: test/e2e/realistic-host.ts).
// What a production application's page has around the element, none of it written for the sandbox:
//   - a Trusted Types policy of its own ('app') and, with ?tt-default=1, a default policy that counts the strings it is asked about;
//   - a `fetch` wrapper that adds the user's Authorization header to the app's own API requests;
//   - a Service Worker with a cache-first strategy for that API;
//   - cookies on the host site (the page's response sets them) and a token in localStorage;
//   - an error reporter (window `error` and `unhandledrejection`) and listeners for focus and the page's lifecycle;
//   - the element, which the specs configure.
// A script of the page, not the harness's: it has no inline script and no inline style, so the strict policy of the
// fixture runs it. The element's size is set through the CSSOM, which no style-src governs.
import { defineWebSandbox } from '@src/host';
import { viewScriptHash } from '@src/index';

const w = window as any;
const params = new URLSearchParams(location.search);
const session = params.get('session') ?? 'none';
const HOST = `${location.origin}/__realistic-host`;
const API = `${HOST}/api/${session}/`;
const TOKEN = 'Bearer HOST-SESSION-TOKEN';

// ---- Trusted Types: the page's own policies, created before the element exists ------------------------------------
w.hostTtDefaultCalls = [] as string[];
const trustedTypes = w.trustedTypes;
// (an engine without Trusted Types takes the plain string)
let appPolicy: { createScriptURL(url: string): unknown } | null = trustedTypes ? null : { createScriptURL: (url: string) => url };
try {
    if (trustedTypes) appPolicy = trustedTypes.createPolicy('app', {
        createScriptURL: (url: string) => {
            if (new URL(url, location.href).pathname !== '/__realistic-host/sw.js') throw new TypeError('the app policy blesses its worker only');
            return url;
        },
    }) ?? null;
} catch { /* the page's trusted-types directive does not list 'app' (a matrix row): no worker registration below */ }
if (params.has('tt-default')) {
    const record = (sink: string) => (input: string) => { w.hostTtDefaultCalls.push(`${sink} ${String(input).slice(0, 60)}`); return input; };
    try { trustedTypes?.createPolicy('default', { createHTML: record('html'), createScript: record('script'), createScriptURL: record('script-url') }); } catch { /* not listed */ }
}

// ---- the app's own fetch environment ---------------------------------------------------------------------------------
const nativeFetch = window.fetch.bind(window);
w.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(API)) return nativeFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('authorization', TOKEN);
    return nativeFetch(input, { ...init, headers });
};
/** The application's own request to its API: through the wrapper (the Authorization header), with its cookies, and through the Service Worker. */
w.hostFetch = async (name: string) => {
    const response = await fetch(API + name);
    return { status: response.status, body: await response.text() };
};
try { localStorage.setItem('host_token', 'HOST-LOCAL-SECRET'); } catch { /* storage blocked */ }

// ---- what the page's own reporters see -------------------------------------------------------------------------------
w.hostErrors = [] as string[];
window.addEventListener('error', (event) => { w.hostErrors.push(`error: ${event.message}`); });
window.addEventListener('unhandledrejection', (event) => { w.hostErrors.push(`rejection: ${String((event.reason as Error)?.message ?? event.reason)}`); });
w.hostLifecycle = [] as string[];
for (const type of ['focusin', 'focusout', 'blur', 'focus']) window.addEventListener(type, () => { w.hostLifecycle.push(type); }, true);
for (const type of ['pagehide', 'visibilitychange']) window.addEventListener(type, () => { w.hostLifecycle.push(type); });

// ---- the app's Service Worker (cache-first for its API) -------------------------------------------------------------
w.hostServiceWorker = { registered: false, controlled: false };
if (params.get('sw') !== '0' && 'serviceWorker' in navigator && appPolicy) {
    try {
        const controlled = new Promise<void>(resolve => {
            if (navigator.serviceWorker.controller) resolve();
            navigator.serviceWorker.addEventListener('controllerchange', () => resolve());
            setTimeout(resolve, 3000);
        });
        await navigator.serviceWorker.register(appPolicy.createScriptURL(`${HOST}/sw.js`) as unknown as string, { scope: `${HOST}/` });
        w.hostServiceWorker.registered = true;
        await navigator.serviceWorker.ready;
        await controlled;
        w.hostServiceWorker.controlled = !!navigator.serviceWorker.controller;
    } catch (error) {
        w.hostServiceWorker.error = String(error);
    }
}

// ---- the element and the events the specs read ------------------------------------------------------------------------
defineWebSandbox();
w.sandboxLogs = [];
w.sandboxEvents = [];
window.addEventListener('sandbox-log', (event: any) => { w.sandboxLogs.push((event.detail?.args || []).map(String).join(' ')); });
w.sandboxViolations = [];
window.addEventListener('violation', (event: any) => { w.sandboxViolations.push({ sandbox: event.target.id || 'main', ...event.detail }); });
w.sandboxFetches = [];
window.addEventListener('fetch', (event: any) => { w.sandboxFetches.push({ sandbox: event.target.id || 'main', ...event.detail }); });
w.sandboxWrites = [];
// Inserted with a cooperative config without allow-scripts, which runs no script of the library's: the build on insertion
// has nothing a host policy could refuse, and a spec's own setConfig() is the first build that matters.
const element = document.createElement('web-sandbox') as HTMLElement & { setConfig(config: object): void };
element.setConfig({ mode: 'cooperative' });
document.body.appendChild(element);
element.style.display = 'block';
element.style.width = '400px';
element.style.height = '300px';
for (const type of ['ready', 'terminated']) {
    element.addEventListener(type, (event: any) => w.sandboxEvents.push({ type, reason: event.detail?.reason ?? null }));
}
w.viewScriptHash = viewScriptHash;
w.harnessReady = true;
