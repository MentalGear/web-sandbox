// The e2e harness (harness.html) as one external module, for a host page served with a policy of its own
// (vite.config.ts, /__host-policy): no inline script and no inline style, so a host policy without 'unsafe-inline'
// runs it and sizes the element. The element's size is set through the CSSOM, which no style-src governs.
import { defineWebSandbox } from '@src/host';
import { viewScriptHash } from '@src/index';

// `?tt-default`: the host page has a Trusted Types default policy of its own (review round 2, C-6), which every string
// the page assigns to a sink passes through; created first, before the element assigns anything.
// `window.ttDefaultHook`, when a spec sets it, runs once, inside the next sink the policy is asked about: embedder code
// running in the middle of the element's own build (S65, LM-2: a reset() there re-entered the build).
if (new URLSearchParams(location.search).has('tt-default')) {
    const pass = (input: string) => {
        const hook = (window as any).ttDefaultHook;
        (window as any).ttDefaultHook = null;
        if (typeof hook === 'function') hook();
        return input;
    };
    (window as any).trustedTypes?.createPolicy('default', { createHTML: pass, createScript: pass, createScriptURL: pass });
}

defineWebSandbox();

const w = window as any;
w.sandboxLogs = [];
w.sandboxEvents = [];
window.addEventListener('sandbox-log', (event: any) => {
    w.sandboxLogs.push((event.detail?.args || []).map(String).join(' '));
});
w.sandboxViolations = [];
window.addEventListener('violation', (event: any) => {
    w.sandboxViolations.push({ sandbox: event.target.id || 'main', ...event.detail });
});
w.sandboxFetches = [];
w.sandboxWrites = [];
// Inserted with a cooperative config without allow-scripts, which runs no script of the library's, so the build on
// insertion has nothing a host policy could refuse, and a spec's own setConfig() is the first build that matters.
const element = document.createElement('web-sandbox') as HTMLElement & { setConfig(config: object): void };
element.setConfig({ mode: 'cooperative' });
document.body.appendChild(element);
element.style.display = 'block';
element.style.width = '400px';
element.style.height = '300px';
// every lifecycle event in order, with the state it announced: a spec asserts 'ready' never came before a termination
for (const type of ['ready', 'terminated']) {
    element.addEventListener(type, (event: any) => w.sandboxEvents.push({ type, reason: event.detail?.reason ?? null }));
}
w.viewScriptHash = viewScriptHash; // what an embedder reads for its own policy (docs/API.md, host page policy)
w.harnessReady = true;
