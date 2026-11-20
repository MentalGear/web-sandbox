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
// The start-up gates' spec (test/e2e/startup-gates.spec.ts), research 31's mutant "F framed without sandbox": the page's
// own code keeps a `sandbox` attribute off every frame, the element's included, before the library exists.
if (params.get('unsandboxed')) {
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
        if (this instanceof HTMLIFrameElement && name === 'sandbox') return;
        Reflect.apply(setAttribute, this, [name, value]);
    };
}
const { defineWebSandbox } = await loadLibrary();
if (params.get('wrap') === 'after') wrap();
defineWebSandbox({ documentUrl: params.get('doc')! });
// The mutant "a network name the allowlist left" (startup-gates.ts, `networkNames`): the page's own code (a host page's
// script reaches the element's members, design 01) gives the worker `fetch` back between the allowlist and its gate.
if (params.get('mutant') === 'networkName') {
    const prototype = customElements.get('web-sandbox')!.prototype as any;
    const source = prototype._getStrictWorkerSource;
    prototype._getStrictWorkerSource = function (this: unknown, ...args: unknown[]) {
        return String(Reflect.apply(source, this, args)).replace('gates();', 'g.fetch = function () {};gates();');
    };
}

/**
 * Starts a sealed app whose entry logs and exposes a method, and calls it at once, while the build is loading; resolves
 * with the build's first lifecycle event, the call's outcome, and every guest line (`sandbox-log` with source `guest`).
 */
w.startWithCall = () => new Promise(resolve => {
    const el = document.createElement('web-sandbox') as HTMLElement & { start(app: object): void; call(method: string): Promise<unknown> };
    el.style.cssText = 'display:block;width:400px;height:300px';
    const lines: string[] = [];
    el.addEventListener('sandbox-log', (event: any) => { if (event.detail.source === 'guest') lines.push(event.detail.args.map(String).join(' ')); });
    el.start({ html: '<p>app</p>', entry: 'entry.js', files: { 'entry.js': "console.log('the entry ran'); bridge.expose('ping', () => 'pong');" } });
    document.body.append(el);
    const call = el.call('ping').then(value => `answered ${String(value)}`, (error: any) => `rejected ${error?.code}`);
    const settle = (outcome: string, reason: string | null) => call.then(settled => setTimeout(() => resolve({ outcome, reason, call: settled, lines }), 200));
    el.addEventListener('ready', () => settle('ready', null), { once: true });
    el.addEventListener('terminated', (event: any) => settle('terminated', event.detail.reason), { once: true });
});

/**
 * Starts `app` (a sealed app, by default one that renders a paragraph) on a new element, in a parent of its own; resolves with its first
 * lifecycle event and the time from insertion to it. A later termination of the same element is kept in `lastEnd`.
 */
w.startSandbox = (app: object = { html: '<p id="hello">hello</p>' }, container = '') => new Promise(resolve => {
    const el = document.createElement('web-sandbox') as HTMLElement & { start(app: object): void };
    el.style.cssText = 'display:block;width:400px;height:300px';
    let inserted = 0;
    const settle = (outcome: string, reason: string | null) => resolve({ outcome, reason, ms: performance.now() - inserted, framed: el.shadowRoot!.querySelectorAll('iframe').length });
    w.lastEnd = null;
    el.addEventListener('ready', () => settle('ready', null), { once: true });
    el.addEventListener('terminated', (event: any) => { w.lastEnd = event.detail.reason; settle('terminated', event.detail.reason); }, { once: true });
    // `container`: the style of the element's parent, for a sandbox in a part of the page that is not shown
    const box = document.createElement('div');
    box.style.cssText = container;
    el.start(app);
    inserted = performance.now();
    box.append(el);
    document.body.append(box);
});
// The start-up order's spec (test/e2e/startup-order.spec.ts). This page's own listener hears every announcement of a
// window that is not the view (the element's listener ignores those; the view's own it takes and stops, though on
// Chromium a listener of the page's added before it hears that one too), and every
// `__spy` report of a window of the file's or of this page's (served-file-server.ts, `spy`) says what that window was
// posted. `from` names the window a message came from, as this page can tell it.
const elementFrame = () => document.querySelector('web-sandbox')?.shadowRoot?.querySelector('iframe')?.contentWindow ?? null;
const whoIs = (source: MessageEventSource | null): string => {
    if (source === null) return 'none';
    if (source === elementFrame()) return 'file';
    // a cross-origin window throws for an index it has no frame at (the file not loaded yet)
    try {
        if (elementFrame() !== null && source === (elementFrame() as Window)[0]) return 'view';
    } catch {
        // no view yet
    }
    if (source === w.sibling?.contentWindow) return 'sibling';
    if (source === window.parent && window.parent !== window) return 'framing page';
    return 'other';
};
w.heard = [] as { type: unknown; from: string; where?: unknown; got?: unknown; ports?: unknown }[];
addEventListener('message', (event) => {
    const data = event.data;
    if (!data || (data.type !== 'VIEW_ANNOUNCE' && data.type !== '__spy')) return;
    w.heard.push({ type: data.type, from: whoIs(event.source), where: data.where, got: data.got, ports: data.ports });
});
/** A frame of this page that announces itself as the view would, with `announcement`, and reports what it is posted. */
w.siblingAnnounce = (announcement: object) => {
    const frame = document.createElement('iframe');
    const script = `addEventListener('message', function (e) { parent.postMessage({ type: '__spy', where: 'sibling', got: e.data && e.data.type, ports: e.ports.length }, '*'); }); parent.postMessage(${JSON.stringify(announcement)}, '*');`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = `<script>${script}</script>`;
    w.sibling = frame;
    document.body.append(frame);
};
w.harnessReady = true;
