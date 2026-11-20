// The host page of the check-of-the-file spec (served by test/e2e/served-file-server.ts; test/e2e/served-file-check.spec.ts).
// Its query: `doc`, the documentUrl it registers; `sw`, a Service Worker of its own registered first (it answers the
// file's requests that ask it to); `wrap`, a `fetch` wrapper of the app's, which adds the user's Authorization header to
// every request, installed `before` the library is loaded or `after`. It records the page's own policy violations, and
// starts sealed apps on request (`startSandbox`), timing each from insertion to its first lifecycle event.
import { loadLibrary } from './library';

const w = window as any;
const params = new URLSearchParams(location.search);
const session = new URL(import.meta.url).searchParams.get('session') ?? 'none';

w.pageViolations = [] as string[];
document.addEventListener('securitypolicyviolation', (event) => { w.pageViolations.push(`${event.violatedDirective} ${event.blockedURI}`); });

// An app's fetch wrapper: the user's token on every request the page makes through `fetch`.
const wrap = () => {
    const nativeFetch = window.fetch.bind(window);
    w.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set('authorization', 'Bearer APP-USER-TOKEN');
        return nativeFetch(input, { ...init, headers });
    };
};

if (params.get('sw')) {
    // the page is controlled before the library exists, as an app's Service Worker controls it
    const controlled = new Promise<void>(resolve => {
        if (navigator.serviceWorker.controller) resolve();
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve());
    });
    await navigator.serviceWorker.register(`/__served-file/${session}/sw.js`, { scope: `/__served-file/${session}/` });
    await controlled;
    w.controlled = !!navigator.serviceWorker.controller;
}
if (params.get('wrap') === 'before') wrap();
const { defineWebSandbox } = await loadLibrary();
if (params.get('wrap') === 'after') wrap();
defineWebSandbox({ documentUrl: params.get('doc')! });

/** Starts a sealed app on a new element; resolves with its first lifecycle event and the time from insertion to it. */
w.startSandbox = () => new Promise(resolve => {
    const el = document.createElement('web-sandbox') as HTMLElement & { start(app: object): void };
    el.style.cssText = 'display:block;width:400px;height:300px';
    let inserted = 0;
    const settle = (outcome: string, reason: string | null) => resolve({ outcome, reason, ms: performance.now() - inserted, framed: el.shadowRoot!.querySelectorAll('iframe').length });
    el.addEventListener('ready', () => settle('ready', null), { once: true });
    el.addEventListener('terminated', (event: any) => settle('terminated', event.detail.reason), { once: true });
    el.start({ html: '<p id="hello">hello</p>' });
    inserted = performance.now();
    document.body.append(el);
});
w.harnessReady = true;
