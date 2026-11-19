// The e2e harness (harness.html) as one external module, for a host page served with a policy of its own
// (vite.config.ts, /__host-policy): no inline script and no inline style, so a host policy without 'unsafe-inline'
// runs it and sizes the element. The element's size is set through the CSSOM, which no style-src governs.
import { buildSettled, insertInert, loadLibrary } from './library';

// the build the test asked for (library.ts): the default build, or the one with the network modes
const { defineWebSandbox, viewScriptHash } = await loadLibrary();

// `?tt-default`: the host page has a Trusted Types default policy of its own (R2:C-6), which every string
// the page assigns to a sink passes through; created first, before the element assigns anything.
// `window.ttDefaultHook`, when a spec sets it, runs once, inside the next sink the policy is asked about: embedder code
// running in the middle of the element's own build (LM-2: a reset() there must not re-enter the build).
if (new URLSearchParams(location.search).has('tt-default')) {
    const pass = (input: string) => {
        const hook = (window as any).ttDefaultHook;
        (window as any).ttDefaultHook = null;
        if (typeof hook === 'function') hook();
        return input;
    };
    // (a page whose `trusted-types` list does not name `default` makes none: createPolicy throws, and the page goes on without one)
    try {
        (window as any).trustedTypes?.createPolicy('default', { createHTML: pass, createScript: pass, createScriptURL: pass });
    } catch { /* refused by the page's own list */ }
}

defineWebSandbox();

const w = window as any;
w.sandboxLogs = [];
w.sandboxEvents = [];
// the events that carry guest data do not bubble (design 01, I5): heard in the capture phase
window.addEventListener('sandbox-log', (event: any) => {
    w.sandboxLogs.push((event.detail?.args || []).map(String).join(' '));
}, true);
w.sandboxViolations = [];
window.addEventListener('violation', (event: any) => {
    w.sandboxViolations.push({ sandbox: event.target.id || 'main', ...event.detail });
}, true);
w.sandboxFetches = [];
w.sandboxWrites = [];
// Each element the page shows is sized and heard the same way: this one, and each fresh one a spec starts in its place
// (the fixture's startFresh() calls the hook before it inserts it).
w.sandboxAdopt = (element: HTMLElement) => {
    element.style.display = 'block';
    element.style.width = '400px';
    element.style.height = '300px';
    // every lifecycle event in order, with the state it announced: a spec asserts 'ready' never came before a termination
    for (const type of ['ready', 'terminated']) {
        element.addEventListener(type, (event: any) => w.sandboxEvents.push({ type, reason: event.detail?.reason ?? null }));
    }
};
// Inserted so that the build on insertion has nothing a host policy could refuse, and a spec's own start() is the
// first build that matters (library.ts, insertInert: each build's way).
const element = document.createElement('web-sandbox') as HTMLElement & { start(app: object, grants?: object): void };
insertInert(element);
w.sandboxAdopt(element);
w.viewScriptHash = viewScriptHash; // what an embedder reads for its own policy (docs/API.md, host page policy)
await buildSettled(element); // a spec's own build is the next one
w.harnessReady = true;
