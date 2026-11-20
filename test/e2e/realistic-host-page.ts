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
import { buildSettled, insertInert, loadLibrary, pageDocumentUrl } from './library';

// the build the test asked for (library.ts): the default build, or the one with the network modes
const { defineWebSandbox, viewScriptHash } = await loadLibrary();

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
    // This module's top-level awaits hold the page's load event, which page.goto() waits for: the whole Service Worker
    // setup is bounded, so a worker that never becomes ready (WebKit, once, on an isolated page in CI) ends the wait
    // with an error a spec reads (serviceWorker()), not with the page never loading.
    const setup = (async () => {
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
    })().catch((error) => { w.hostServiceWorker.error = String(error); });
    const bound = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 5000));
    if (await Promise.race([setup, bound]) === 'timeout') w.hostServiceWorker.error = 'the Service Worker was not ready within 5 s';
}

// ---- the element and the events the specs read ------------------------------------------------------------------------
// sealed mode's view: the build's own sealed-document.html, on the page's origin, which its policy admits in frame-src
// (`?doc=api`: a name of the app's API, which its Service Worker, its fetch wrapper and its backend all see; `?docUrl=`: a
// copy of the file with headers on its response, on another origin, which the page's policy admits too)
const documentUrl = params.get('docUrl') ?? (params.get('doc') === 'api' ? `${API}sealed-document.html` : pageDocumentUrl());
defineWebSandbox({ documentUrl });
w.sandboxLogs = [];
w.sandboxEvents = [];
// the events that carry guest data do not bubble (design 01, I5): heard in the capture phase
window.addEventListener('sandbox-log', (event: any) => { w.sandboxLogs.push((event.detail?.args || []).map(String).join(' ')); }, true);
w.sandboxViolations = [];
window.addEventListener('violation', (event: any) => { w.sandboxViolations.push({ sandbox: event.target.id || 'main', ...event.detail }); }, true);
w.sandboxFetches = [];
window.addEventListener('fetch', (event: any) => { w.sandboxFetches.push({ sandbox: event.target.id || 'main', ...event.detail }); }, true);
w.sandboxWrites = [];
// Each element the page shows is sized and heard the same way: this one, and each fresh one a spec starts in its place
// (the fixture's startFresh() calls the hook before it inserts it).
w.sandboxAdopt = (element: HTMLElement) => {
    element.style.display = 'block';
    element.style.width = '400px';
    element.style.height = '300px';
    for (const type of ['ready', 'terminated']) {
        element.addEventListener(type, (event: any) => w.sandboxEvents.push({ type, reason: event.detail?.reason ?? null }));
    }
};
// Inserted so that the build on insertion has nothing a host policy could refuse, and a spec's own start() is the
// first build that matters (library.ts, insertInert: each build's way).
const element = document.createElement('web-sandbox') as HTMLElement & { start(app: object, grants?: object): void };
insertInert(element);
w.sandboxAdopt(element);
w.viewScriptHash = viewScriptHash;
await buildSettled(element); // a spec's own build is the next one
w.harnessReady = true;
