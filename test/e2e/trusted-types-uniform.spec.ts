import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import type { Page } from '@playwright/test';
import { TRUSTED_TYPES_RULES } from '@src/lib/csp/host-trusted-types';
import { DECOY_URL } from '@src/lib/host-csp';

/**
 * Trusted Types answer the same on every engine (INHERITED_CONTEXT.trustedTypesRequirement; src/lib/csp/host-trusted-types.ts).
 * Chromium and WebKit have them, and the browser refuses: a `trusted-types` list that does not name the library's policy
 * ends the build with the Trusted Types reason, and `execute()`'s string is not evaluated. Firefox, at the version measured,
 * has none, so the library reads the same two directives from the host page's policy and refuses as the browsers do.
 *
 * Each rule of TRUSTED_TYPES_RULES runs here in all three modes on a real host page (vite.config.ts, /__host-policy, with
 * a Trusted Types default policy of its own where the engine has any), with the policy given as `hostContentSecurityPolicy`
 * so that all engines have it. The browsers that have Trusted Types are the oracle: the table is what they do, and Firefox
 * has to equal it. Then without the option: a browser without Trusted Types applies none (its read of the page's policy
 * cannot see the directives it does not implement), and the browsers that have them go on applying theirs.
 */

const TRUSTED_TYPES = "the host page's Trusted Types policy does not allow the policy name 'web-sandbox' (trusted-types; see docs/API.md#host-page-policy)";
const ENTRY = `console.log('ENTRY RAN');`;
type HostEvent = { type: 'ready' | 'terminated'; reason: string | null };
const READY: HostEvent[] = [{ type: 'ready', reason: null }];
const ENDED: HostEvent[] = [{ type: 'terminated', reason: TRUSTED_TYPES }];

async function openWithPolicy(page: Page, csp: string) {
    await page.goto(`${ORIGIN}/__host-policy?${new URLSearchParams({ csp, 'tt-default': '' })}`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
}

/** setConfig() and the events from then on, once it settled. */
async function configure(sandbox: SandboxDriver, config: object): Promise<HostEvent[]> {
    await sandbox.page.evaluate(() => { (window as any).sandboxEvents.length = 0; });
    await sandbox.page.evaluate((c) => whenSettled(s => s.setConfig(c)), config as any);
    await sandbox.page.waitForTimeout(300);
    return sandbox.page.evaluate(() => [...(window as any).sandboxEvents]);
}

/** `execute()` of a line that logs, and whether the log came. */
async function executeRuns(sandbox: SandboxDriver, marker: string): Promise<boolean> {
    await sandbox.clearLogs();
    await sandbox.page.evaluate((code) => (document.querySelector('web-sandbox') as any).execute(code), `console.log(${JSON.stringify(marker)});`);
    await sandbox.page.waitForTimeout(600);
    return (await sandbox.logs()).some(line => line.includes(marker));
}

const verdict = (outcome: 'ends' | 'ready') => (outcome === 'ends' ? ENDED : READY);

for (const rule of TRUSTED_TYPES_RULES) {
    for (const [policy, strictAndWorker, cooperative, execute] of rule.examples) {
        test(`${policy}: strict and worker mode ${strictAndWorker}, cooperative mode ${cooperative}, execute() ${execute === 'refused' ? 'is refused' : 'runs'}`, async ({ sandbox, page }) => {
            await openWithPolicy(page, policy);
            const given = { hostContentSecurityPolicy: policy };
            await sandbox.registerFiles({ 'main.js': ENTRY });
            expect(await configure(sandbox, { entry: 'main.js', ...given }), 'strict').toEqual(verdict(strictAndWorker));
            expect(await configure(sandbox, { mode: 'worker', scriptUnsafe: true, ...given }), 'worker').toEqual(verdict(strictAndWorker));
            expect(await configure(sandbox, { mode: 'cooperative', scriptUnsafe: true, capabilities: ['allow-scripts'], html: '<p>x</p>', ...given }), 'cooperative').toEqual(verdict(cooperative));
            if (cooperative === 'ready') expect(await executeRuns(sandbox, `COOPERATIVE-EXEC-${execute}`), `execute() in cooperative mode ${execute}`).toBe(execute === 'runs');
            if (strictAndWorker === 'ready') {
                expect(await configure(sandbox, { mode: 'worker', scriptUnsafe: true, ...given }), 'worker again').toEqual(READY);
                expect(await executeRuns(sandbox, `WORKER-EXEC-${execute}`), `execute() in worker mode ${execute}`).toBe(execute === 'runs');
            }
        });
    }
}

// ---- the read ---------------------------------------------------------------------------------------------------------

/** The three modes' outcomes for a config: with no `hostContentSecurityPolicy` the browser decides, where it has Trusted Types. */
async function outcomes(sandbox: SandboxDriver, extra: object = {}) {
    await sandbox.registerFiles({ 'main.js': ENTRY });
    return {
        strict: await configure(sandbox, { entry: 'main.js', ...extra }),
        worker: await configure(sandbox, { mode: 'worker', scriptUnsafe: true, ...extra }),
        cooperative: await configure(sandbox, { mode: 'cooperative', scriptUnsafe: true, capabilities: ['allow-scripts'], html: '<p>x</p>', ...extra }),
    };
}

const ALL_ENDED = { strict: ENDED, worker: ENDED, cooperative: ENDED };
const ALL_READY = { strict: READY, worker: READY, cooperative: READY };

test.describe('without hostContentSecurityPolicy', () => {
    // (a policy that refuses the read's decoy too, so that the read sees it: `connect-src 'self'`; a browser without Trusted
    // Types still reports it without the Trusted Types directives, which it does not implement)
    const POLICY = "require-trusted-types-for 'script'; trusted-types other; connect-src 'self'";

    test('the browser decides where it has Trusted Types; where it has none nothing is applied, though the page asks for it', async ({ sandbox, page, browserName }) => {
        await openWithPolicy(page, POLICY);
        // ledger: trusted-types
        expect(await outcomes(sandbox), browserName === 'firefox' ? 'Firefox has no Trusted Types, and the read cannot see its directives' : 'the browser applies it').toEqual(browserName === 'firefox' ? ALL_READY : ALL_ENDED);
    });

    test('given as hostContentSecurityPolicy, the same policy applies on every engine, and false reads nothing', async ({ sandbox, page, browserName }) => {
        await openWithPolicy(page, POLICY);
        expect(await outcomes(sandbox, { hostContentSecurityPolicy: POLICY }), 'given').toEqual(ALL_ENDED);
        expect(await outcomes(sandbox, { hostContentSecurityPolicy: false }), 'false').toEqual(browserName === 'firefox' ? ALL_READY : ALL_ENDED);
    });

    test('the page really does not report its Trusted Types directives in a browser without them (the fact the option stands on)', async ({ page, browserName }) => {
        // ledger: trusted-types
        test.skip(browserName !== 'firefox', 'only a browser without Trusted Types leaves the directives out');
        await openWithPolicy(page, POLICY);
        const reported = await page.evaluate(async (decoy) => {
            const frame = document.createElement('iframe');
            frame.hidden = true;
            const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
            document.body.append(frame);
            await loaded;
            const seen: string[] = [];
            frame.contentDocument!.addEventListener('securitypolicyviolation', (event) => { seen.push((event as SecurityPolicyViolationEvent).originalPolicy); });
            await (frame.contentWindow as Window & typeof globalThis).fetch(decoy, { cache: 'no-store' }).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 100));
            frame.remove();
            return seen;
        }, DECOY_URL);
        expect(reported).toEqual(["connect-src 'self'"]);
    });
});
