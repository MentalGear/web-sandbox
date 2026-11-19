import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import type { Page } from '@playwright/test';
import { TRUSTED_TYPES_RULES } from '@src/lib/csp/host-trusted-types';

// The build with the network modes (ADR-009), and every mode in one test, sealed mode among them, on the build that has them all.
test.use({ build: 'network', otherBuildConfigs: true });

/**
 * Trusted Types answer the same on every engine (INHERITED_CONTEXT.trustedTypesRequirement; src/lib/csp/host-trusted-types.ts).
 * All three engines have them (Firefox since 159; 146 had none), and the browser refuses: a `trusted-types` list that does not
 * name the library's policy ends the build with the Trusted Types reason, and `execute()`'s string is not evaluated. A
 * browser without them is given the page's policy as `hostContentSecurityPolicy`, from which the library reads the same
 * two directives and refuses as the browsers do.
 *
 * Each rule of TRUSTED_TYPES_RULES runs here in every mode (sealed mode answers as strict mode) on a real host page
 * (vite.config.ts, /__host-policy, with a Trusted Types default policy of its own where the engine has any), with the
 * policy given as `hostContentSecurityPolicy`
 * so that all engines have it. The browsers that have Trusted Types are the oracle: the table is what they do. Then
 * without the option: the browsers go on applying theirs (a browser without Trusted Types would apply none: the library
 * never asks the page for its policy).
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

/** start() on a fresh element (startFresh()) and the events from then on, once it settled. */
async function configure(sandbox: SandboxDriver, config: object): Promise<HostEvent[]> {
    await sandbox.page.evaluate(() => { (window as any).sandboxEvents.length = 0; });
    await sandbox.page.evaluate((c) => startFresh(c), config as any);
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
            expect(await configure(sandbox, { mode: 'strict', entry: 'main.js', ...given }), 'strict').toEqual(verdict(strictAndWorker));
            expect(await configure(sandbox, { mode: 'sealed', entry: 'main.js', ...given }), 'sealed: strict mode\'s view and worker').toEqual(verdict(strictAndWorker));
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

// ---- without the option -----------------------------------------------------------------------------------------------

/** The four modes' outcomes for a config: with no `hostContentSecurityPolicy` the browser decides, where it has Trusted Types. */
async function outcomes(sandbox: SandboxDriver, extra: object = {}) {
    await sandbox.registerFiles({ 'main.js': ENTRY });
    return {
        strict: await configure(sandbox, { mode: 'strict', entry: 'main.js', ...extra }),
        sealed: await configure(sandbox, { mode: 'sealed', entry: 'main.js', ...extra }),
        worker: await configure(sandbox, { mode: 'worker', scriptUnsafe: true, ...extra }),
        cooperative: await configure(sandbox, { mode: 'cooperative', scriptUnsafe: true, capabilities: ['allow-scripts'], html: '<p>x</p>', ...extra }),
    };
}

const ALL_ENDED = { strict: ENDED, sealed: ENDED, worker: ENDED, cooperative: ENDED };

test.describe('without hostContentSecurityPolicy', () => {
    const POLICY = "require-trusted-types-for 'script'; trusted-types other; connect-src 'self'";

    test('the browser decides where it has Trusted Types, and every engine has them', async ({ sandbox, page }) => {
        await openWithPolicy(page, POLICY);
        // ledger: trusted-types
        expect(await outcomes(sandbox), 'the browser applies it').toEqual(ALL_ENDED);
    });

    test('given as hostContentSecurityPolicy, the same policy applies on every engine, and false changes nothing where the browser has Trusted Types', async ({ sandbox, page }) => {
        await openWithPolicy(page, POLICY);
        expect(await outcomes(sandbox, { hostContentSecurityPolicy: POLICY }), 'given').toEqual(ALL_ENDED);
        expect(await outcomes(sandbox, { hostContentSecurityPolicy: false }), 'false').toEqual(ALL_ENDED);
    });
});
