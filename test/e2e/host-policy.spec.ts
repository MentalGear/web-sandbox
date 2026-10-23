import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import { inFrames, waitInView } from './strict-view';
import type { Page } from '@playwright/test';

/**
 * The host page's own policy (R1:R2-1 = R1:R3-1; docs/API.md#host-page-policy). The sandbox's frames are srcdoc
 * documents, which inherit the policies of the page that made them: a copy of its CSP list (CSP3), its Trusted Types
 * requirement and its Cross-Origin-Embedder-Policy. Each test serves the e2e harness with one host policy
 * (vite.config.ts, /__host-policy) and asserts, per engine, what the embedder is told:
 *   - strict mode is `ready` only once its view's bootstrap checked in, not on the frame's load (else a host policy
 *     that stops the view would show `ready`, and 5 s later "the sandbox view stopped responding");
 *   - a startup script the host page refuses, a worker it refuses, a Trusted Types policy name it refuses: each ends
 *     the build with a reason that names the host page's policy (not "did not finish loading", "the guest
 *     entry failed to start" or "could not be built (TypeError)");
 *   - with what docs/API.md says to allow, the same page works (positive controls), and with no host policy at all.
 * Evidence: the element's events in order (host-policy-harness.ts), what the view's DOM holds and how big each frame
 * is, read from outside (strict-view.ts), and the host page's console.
 */

const STARTUP_BLOCKED = "the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (see docs/API.md#host-page-policy)";
const WORKER_REFUSED = "the sandbox's worker could not be loaded: the host page's policy refuses blob: workers (worker-src; WebKit also under Cross-Origin-Embedder-Policy; see docs/API.md#host-page-policy)";
const TRUSTED_TYPES = "the host page's Trusted Types policy does not allow the policy name 'web-sandbox' (trusted-types; see docs/API.md#host-page-policy)";
const WRAPPER_STYLE_HASH = "'sha256-jKvfmEYIGlm8DGk4pp05gJ0MwYdTY+NU6tSvyPZyDow='";

const ENTRY = `sandboxView.render('<p id="hello">hi</p>'); console.log('ENTRY RAN');`;
const COOPERATIVE = { mode: 'cooperative', capabilities: ['allow-scripts'], html: '<p>x</p><script>console.log("COOPERATIVE RAN")</script>' };

type HostEvent = { type: 'ready' | 'terminated'; reason: string | null };

/**
 * Opens the harness with the given host policy headers; the element is inserted (a default, strict build). `ttDefault`:
 * the host page makes a Trusted Types default policy of its own first (host-policy-harness.ts).
 */
async function openWithPolicy(page: Page, policy: { csp?: string; coep?: string; ttDefault?: boolean }) {
    const query = new URLSearchParams();
    if (policy.csp) query.set('csp', policy.csp);
    if (policy.coep) query.set('coep', policy.coep);
    if (policy.ttDefault) query.set('tt-default', '');
    await page.goto(`${ORIGIN}/__host-policy?${query}`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
}

/** setConfig() and the events from then on, once it settled. */
async function configure(sandbox: SandboxDriver, config: object): Promise<HostEvent[]> {
    await sandbox.page.evaluate(() => { (window as any).sandboxEvents.length = 0; });
    await sandbox.page.evaluate((c) => whenSettled(s => s.setConfig(c)), config as any);
    await sandbox.page.waitForTimeout(300); // a termination right after 'ready' (the old strict path) would show here
    return sandbox.page.evaluate(() => [...(window as any).sandboxEvents]);
}

async function strictEntry(sandbox: SandboxDriver): Promise<HostEvent[]> {
    await sandbox.registerFiles({ 'main.js': ENTRY });
    return configure(sandbox, { entry: 'main.js' });
}

/**
 * The view's bootstrap hash, the way docs/API.md says to get it: the package's viewScriptHash() (R1:R4-5).
 * It is the hash the element puts in the view's policy, which the wrapper's srcdoc carries (read here from outside).
 */
async function viewHash(sandbox: SandboxDriver): Promise<string> {
    await openWithPolicy(sandbox.page, {});
    expect(await strictEntry(sandbox)).toEqual([{ type: 'ready', reason: null }]);
    const [exported, built] = await sandbox.page.evaluate(() => {
        const srcdoc = (document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!.srcdoc;
        return [(window as any).viewScriptHash(), `'${/script-src '(sha256-[A-Za-z0-9+/=]+)'/.exec(srcdoc)![1]}'`];
    });
    expect(exported).toBe(built);
    return exported;
}

/** Heights of the wrapper and of the frame inside it, read from outside. */
async function frameHeights(page: Page, browserName: string): Promise<number[]> {
    const values = await inFrames<number>(page, browserName, 'innerHeight', (path) => path === 'main/wrapper' || path === 'main/wrapper/view');
    // a frame of a build that was torn down can still be listed, with no context
    return values.filter(v => v.value !== 'no-context').map(v => v.value as number);
}

test.describe('host page policy', () => {
    test('positive control, no host policy: strict renders, cooperative runs its script, the frames fill the element', async ({ sandbox, page, browserName }) => {
        await openWithPolicy(page, {});
        expect(await strictEntry(sandbox)).toEqual([{ type: 'ready', reason: null }]);
        await waitInView(page, browserName, `!!document.getElementById('hello')`);
        expect(await frameHeights(page, browserName)).toEqual([300, 300]);
        expect(await configure(sandbox, COOPERATIVE)).toEqual([{ type: 'ready', reason: null }]);
        await sandbox.waitForLog('COOPERATIVE RAN');
    });

    test("script-src 'self': strict is never ready and ends with the startup reason; so does cooperative mode", async ({ sandbox, page }) => {
        await openWithPolicy(page, { csp: "script-src 'self'" });
        expect(await strictEntry(sandbox)).toEqual([{ type: 'terminated', reason: STARTUP_BLOCKED }]);
        expect(await configure(sandbox, COOPERATIVE)).toEqual([{ type: 'terminated', reason: STARTUP_BLOCKED }]);
    });

    test("script-src 'self' with the view's hash and worker-src blob: (what docs/API.md says to allow): strict renders", async ({ sandbox, page, browserName }) => {
        const hash = await viewHash(sandbox);
        await openWithPolicy(page, { csp: `script-src 'self' ${hash}; worker-src blob:` });
        expect(await strictEntry(sandbox)).toEqual([{ type: 'ready', reason: null }]);
        await waitInView(page, browserName, `!!document.getElementById('hello')`);
        await sandbox.waitForLog('ENTRY RAN');
    });

    test('a worker-src without blob: (here through script-src): strict ends with the worker reason, never "the guest entry failed to start"', async ({ sandbox, page }) => {
        const hash = await viewHash(sandbox);
        await openWithPolicy(page, { csp: `script-src 'self' ${hash}` });
        await strictEntry(sandbox);
        await expect.poll(() => page.evaluate(() => (window as any).sandboxEvents.length)).toBe(2);
        expect(await page.evaluate(() => (window as any).sandboxEvents)).toEqual([{ type: 'ready', reason: null }, { type: 'terminated', reason: WORKER_REFUSED }]);
        expect(await sandbox.logs()).toContain(`[Sandbox] ${WORKER_REFUSED}`);
        expect((await sandbox.logs()).filter(line => line.includes('entry failed'))).toEqual([]);
    });

    test("require-trusted-types-for 'script': strict renders (Chromium and WebKit through the 'web-sandbox' policy; Firefox has no Trusted Types)", async ({ sandbox, page, browserName }) => {
        for (const csp of ["require-trusted-types-for 'script'", "require-trusted-types-for 'script'; trusted-types web-sandbox"]) {
            await openWithPolicy(page, { csp });
            expect(await strictEntry(sandbox), csp).toEqual([{ type: 'ready', reason: null }]);
            await waitInView(page, browserName, `!!document.getElementById('hello')`);
        }
    });

    test("require-trusted-types-for 'script', worker mode: the frame starts its worker through the policy, so the worker answers (before: ready, and nothing behind it)", async ({ sandbox, page }) => {
        await openWithPolicy(page, { csp: "require-trusted-types-for 'script'" });
        expect(await configure(sandbox, { mode: 'worker' })).toEqual([{ type: 'ready', reason: null }]);
        // UNKNOWN_METHOD is the worker's broker answering; TIMEOUT would mean no worker ran
        expect(await sandbox.callWithTimeoutOutcome(4000, 'nothing-exposed')).toMatchObject({ status: 'rejected', code: 'UNKNOWN_METHOD' });
    });

    // Class B (trusted-types.ts, in-sandbox-view.ts, worker-bootstrap.ts): a page cannot be asked whether it enforces Trusted
    // Types, and a string it refuses is reported to it even when the library catches the TypeError. So the library's own
    // writes go through its policy from the first one; the host page's violation list, its console and the element's
    // `violation` event stay empty. Chromium and WebKit: Firefox has no Trusted Types.
    test("require-trusted-types-for 'script': the library's own writes give the host page no violation, console error or 'violation' event, over 25 renders and in every mode", async ({ sandbox, page, browserName }) => {
        test.skip(browserName === 'firefox', 'no Trusted Types in Firefox: nothing is enforced, nothing is reported');
        const RENDERS = 25;
        const errors: string[] = [];
        // (the harness's own first build runs no script, and Chromium says so: not a Trusted Types message)
        page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Blocked script execution')) errors.push(message.text()); });
        await page.addInitScript(() => {
            const seen: string[] = ((window as any).hostViolations = []);
            document.addEventListener('securitypolicyviolation', (event) => { seen.push(`${event.violatedDirective} ${event.blockedURI} ${event.sample}`); });
        });
        const quiet = async (label: string) => {
            await page.waitForTimeout(300);
            expect(await page.evaluate(() => (window as any).hostViolations), `${label}: the host page's securitypolicyviolation events`).toEqual([]);
            expect(await page.evaluate(() => (window as any).sandboxViolations), `${label}: the element's violation events`).toEqual([]);
            expect(errors, `${label}: console errors`).toEqual([]);
        };
        for (const csp of ["require-trusted-types-for 'script'", "require-trusted-types-for 'script'; trusted-types web-sandbox"]) {
            await openWithPolicy(page, { csp });
            await quiet(`${csp}, the harness's own build`);

            expect(await configure(sandbox, { mode: 'worker' }), csp).toEqual([{ type: 'ready', reason: null }]);
            expect(await sandbox.callWithTimeoutOutcome(4000, 'nothing-exposed')).toMatchObject({ status: 'rejected', code: 'UNKNOWN_METHOD' });
            await quiet(`${csp}, worker`);

            expect(await configure(sandbox, { ...COOPERATIVE, html: '<p>x</p><img src="a.png"><script>console.log("COOPERATIVE RAN")</script>' }), csp).toEqual([{ type: 'ready', reason: null }]);
            await sandbox.waitForLog('COOPERATIVE RAN');
            await quiet(`${csp}, cooperative`);

            // strict: renders (the view's template sink) and the bridge's frame (a second srcdoc), with markup the host reads inert.
            // (The bridge's origin would make the build read the page's policy: a deliberate violation with a console line of its
            // own, whose cost is test/e2e/connect-uniform.spec.ts's; `hostContentSecurityPolicy: false` skips it.)
            await sandbox.registerFiles({ 'main.js': `let i = 0; const timer = setInterval(() => { sandboxView.render('<p id="r' + i + '">' + i + '</p>'); if (++i === ${RENDERS}) { clearInterval(timer); console.log('RENDERED'); } }, 20);` });
            expect(await configure(sandbox, { entry: 'main.js', html: '<p>x</p><script>1</script>', fetchBridge: { allow: ['https://api.example'] }, hostContentSecurityPolicy: false }), csp).toEqual([{ type: 'ready', reason: null }]);
            await sandbox.waitForLog('RENDERED');
            await waitInView(page, browserName, `!!document.getElementById('r${RENDERS - 1}')`);
            await quiet(`${csp}, strict`);
        }
    });

    test("a trusted-types directive that does not name 'web-sandbox': the build ends with the reason naming it (Firefox has no Trusted Types: the same, from hostContentSecurityPolicy; without it, ready)", async ({ sandbox, page, browserName }) => {
        const csp = "require-trusted-types-for 'script'; trusted-types other";
        await openWithPolicy(page, { csp });
        const expected = browserName === 'firefox' ? [{ type: 'ready', reason: null }] : [{ type: 'terminated', reason: TRUSTED_TYPES }];
        expect(await strictEntry(sandbox)).toEqual(expected);
        expect(await configure(sandbox, COOPERATIVE)).toEqual(expected);
        // given the page's policy, every engine ends alike (the rest of the table: trusted-types-uniform.spec.ts)
        const ended = [{ type: 'terminated', reason: TRUSTED_TYPES }];
        expect(await configure(sandbox, { entry: 'main.js', hostContentSecurityPolicy: csp })).toEqual(ended);
        expect(await configure(sandbox, { ...COOPERATIVE, hostContentSecurityPolicy: csp })).toEqual(ended);
    });

    test("review round 2, C-5: worker mode under a worker-src without blob: ends with the worker reason and is never ready (before: ready, and call() hung)", async ({ sandbox, page }) => {
        await openWithPolicy(page, { csp: "script-src 'self' 'unsafe-inline'; worker-src 'self'" });
        await configure(sandbox, { mode: 'worker' });
        await expect.poll(() => page.evaluate(() => (window as any).sandboxEvents.length)).toBe(1);
        expect(await page.evaluate(() => (window as any).sandboxEvents)).toEqual([{ type: 'terminated', reason: WORKER_REFUSED }]);
        expect(await sandbox.logs()).toContain(`[Sandbox] ${WORKER_REFUSED}`);
        // positive control: the same page with blob: allowed
        await openWithPolicy(page, { csp: "script-src 'self' 'unsafe-inline'; worker-src 'self' blob:" });
        expect(await configure(sandbox, { mode: 'worker' })).toEqual([{ type: 'ready', reason: null }]);
        expect(await sandbox.callWithTimeoutOutcome(4000, 'nothing-exposed')).toMatchObject({ status: 'rejected', code: 'UNKNOWN_METHOD' });
    });

    test("review round 2, C-6: 'trusted-types default' and a default policy of the host page's own: strict and worker mode end with the Trusted Types reason, never 'the guest entry failed to start' or a ready with no worker", async ({ sandbox, page }) => {
        await openWithPolicy(page, { csp: "require-trusted-types-for 'script'; trusted-types default", ttDefault: true });
        const enforced = await page.evaluate(() => 'trustedTypes' in window);
        const expected = enforced ? [{ type: 'terminated', reason: TRUSTED_TYPES }] : [{ type: 'ready', reason: null }];
        expect(await strictEntry(sandbox)).toEqual(expected);
        expect((await sandbox.logs()).filter(line => line.includes('entry failed'))).toEqual([]);
        expect(await configure(sandbox, { mode: 'worker' })).toEqual(expected);
        if (!enforced) return;
        // positive control: with the policy name allowed, both run
        await openWithPolicy(page, { csp: "require-trusted-types-for 'script'; trusted-types default web-sandbox", ttDefault: true });
        expect(await strictEntry(sandbox)).toEqual([{ type: 'ready', reason: null }]);
        expect(await configure(sandbox, { mode: 'worker' })).toEqual([{ type: 'ready', reason: null }]);
        expect(await sandbox.callWithTimeoutOutcome(4000, 'nothing-exposed')).toMatchObject({ status: 'rejected', code: 'UNKNOWN_METHOD' });
    });

    // LM-2 (class L; S65): a host page's own Trusted Types default policy is embedder code, and a sink that asked it ran it
    // inside the element's build; one that called reset() there re-entered the build (the unit half is
    // test/unit/lifecycle-reentry.test.ts, which plays the default policy by the srcdoc setter). The library's sinks go
    // through its own policy from the first write now (trusted-types.ts), so the default policy is never asked for them:
    // here a default policy that calls reset() is not called at all, and the one build stays ready past LOAD_TIMEOUT_MS.
    test("LM-2: the host page's Trusted Types default policy is not asked for the library's own writes: a reset() from it never runs, and the one build is ready and stays ready past LOAD_TIMEOUT_MS (Firefox: no Trusted Types)", async ({ sandbox, page }) => {
        await openWithPolicy(page, { csp: "require-trusted-types-for 'script'; trusted-types default web-sandbox", ttDefault: true });
        test.skip(!(await page.evaluate(() => 'trustedTypes' in window)), 'no Trusted Types in this engine');
        for (const config of [COOPERATIVE, {}]) {
            const label = JSON.stringify(config);
            await page.evaluate((c) => {
                const w = window as any;
                w.sandboxEvents.length = 0;
                const element = document.querySelector('web-sandbox') as any;
                let resets = 0;
                w.ttDefaultHook = () => { resets++; element.reset(); };
                element.setConfig(c);
                w.lm2Resets = () => resets;
            }, config as any);
            await expect.poll(() => page.evaluate(() => (window as any).sandboxEvents), { message: label }).toEqual([{ type: 'ready', reason: null }]);
            expect(await page.evaluate(() => (window as any).lm2Resets()), label).toBe(0);
            expect(await page.evaluate(() => (document.querySelector('web-sandbox') as any).shadowRoot.querySelectorAll('iframe').length), label).toBe(1);
            await page.waitForTimeout(5000 + 1500); // LOAD_TIMEOUT_MS, and a margin
            expect(await page.evaluate(() => [(document.querySelector('web-sandbox') as any).state, (window as any).sandboxEvents]), label).toEqual(['ready', [{ type: 'ready', reason: null }]]);
        }
    });

    // The wrapper's warning only: the default `allowAnimations: false` has its own (view-switches.spec.ts).
    test(`style-src 'self': the frame is 150 px high and the element warns once, naming the hash; with ${WRAPPER_STYLE_HASH} it fills the element, no warning`, async ({ sandbox, page, browserName }) => {
        const warnings: string[] = [];
        page.on('console', (message) => { if (message.type() === 'warning' && message.text().includes('style-src') && !message.text().includes('stops animations')) warnings.push(message.text()); });
        await openWithPolicy(page, { csp: "style-src 'self'" });
        expect(await strictEntry(sandbox)).toEqual([{ type: 'ready', reason: null }]);
        expect(await frameHeights(page, browserName)).toEqual([300, 150]);
        await expect.poll(() => warnings.length).toBe(1);
        expect(warnings[0]).toContain(WRAPPER_STYLE_HASH);

        warnings.length = 0;
        await openWithPolicy(page, { csp: `style-src 'self' ${WRAPPER_STYLE_HASH}` });
        expect(await strictEntry(sandbox)).toEqual([{ type: 'ready', reason: null }]);
        expect(await frameHeights(page, browserName)).toEqual([300, 300]);
        await page.waitForTimeout(300);
        expect(warnings).toEqual([]);
    });

    test("R4-12: the element is a block by default, also under style-src 'self' (a constructed stylesheet); the embedder's CSS still wins", async ({ page }) => {
        await openWithPolicy(page, { csp: "style-src 'self'" });
        const displays = await page.evaluate(() => {
            const fresh = document.createElement('web-sandbox');
            document.body.appendChild(fresh);
            const byDefault = getComputedStyle(fresh).display;
            fresh.style.display = 'inline-block'; // the embedder's own (CSSOM, which no style-src governs either)
            return [byDefault, getComputedStyle(fresh).display];
        });
        expect(displays).toEqual(['block', 'inline-block']);
    });

    test('Cross-Origin-Embedder-Policy: require-corp: strict renders in Chromium and Firefox; WebKit refuses the blob: worker, and the reason says so', async ({ sandbox, page, browserName }) => {
        await openWithPolicy(page, { coep: 'require-corp' });
        const events = await strictEntry(sandbox);
        if (browserName === 'webkit') {
            await expect.poll(() => page.evaluate(() => (window as any).sandboxEvents.length)).toBe(2);
            expect(await page.evaluate(() => (window as any).sandboxEvents)).toEqual([{ type: 'ready', reason: null }, { type: 'terminated', reason: WORKER_REFUSED }]);
            return;
        }
        expect(events).toEqual([{ type: 'ready', reason: null }]);
        await waitInView(page, browserName, `!!document.getElementById('hello')`);
    });
});
