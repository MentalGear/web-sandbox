import { test, expect, ORIGIN } from './fixture';
import { BRIDGE_FRAME_REFUSED } from '@src/lib/bridge-frame';
import { TERMINATION_REASONS } from '@src/lib/reasons';
import { inFrames, waitInView } from './strict-view';
import { RealisticHost, covering, guestBattery, hitsNamed, type Directives, type HostOptions } from './realistic-host';
import { DIRECTIVE_CASES, HEADER_CASES, outcomeOn, type MatrixCase, type MatrixWarning, type Outcome } from './directive-matrix';
import type { Page } from '@playwright/test';

/**
 * The directive matrix (S74, class A; directive-matrix.ts is its table): for each Content-Security-Policy directive a host
 * page might set, a strict-mode sandbox with the fetch bridge on the realistic host (realistic-host.ts) whose policy has that
 * directive at a restrictive value. Each ends in exactly one of two states, never a silent partial one:
 *   - `works`: ready and it stays ready; the guest's entry ran and the view rendered; the guest's own request to the host's API is not
 *     sent (egress is governed); the bridge's request is answered or refused as the table says; a degraded sandbox
 *     (a refused wrapper style) says so with the named warning; `terminate()` leaves no frame;
 *   - `terminates`: the last lifecycle event is `terminated` with the named reason, nothing of the guest ran, no frame is left.
 * The positive control of every case is the base policy itself (realistic-host.spec.ts, and the `works` cases here): the
 * same page with the directive at the base's value works.
 */

const WARNINGS: Record<MatrixWarning, string> = {
    wrapperStyle: "the host page's style-src refuses the wrapper's style",
};

/** The base policy for the matrix: the realistic one, and its connect-src names the host's own origin (the bridge's target). */
const matrixBase = (base: Directives): Directives => ({ ...base, 'connect-src': ["'self'", ORIGIN] });

const replacing = (directive: string, value: string) => (base: Directives): Directives => ({ ...matrixBase(base), [directive]: value.split(' ').filter(Boolean) });

/** Height of the view, the frame inside the wrapper: the element's, or 150 px where the wrapper's style is refused. */
async function frameHeights(page: Page, browserName: string): Promise<number[]> {
    const values = await inFrames<number>(page, browserName, 'innerHeight', (path) => path === 'main/wrapper/view');
    return values.filter(v => v.value !== 'no-context').map(v => v.value as number);
}

async function runCase(
    { sandbox, page, browserName }: { sandbox: Parameters<typeof RealisticHost.open>[0]; page: Page; browserName: 'chromium' | 'firefox' | 'webkit' },
    matrixCase: MatrixCase,
    label: string,
    hostOptions: Pick<HostOptions, 'directives' | 'headers'>,
) {
    const outcome: Outcome = outcomeOn(matrixCase, browserName);
    const row = matrixCase.row;
    const host = await RealisticHost.open(sandbox, { mode: 'strict', ...hostOptions });
    // (the page's own first build, before the sandbox below, can already have ended on a policy that refuses the library's)
    const terminatedBefore = (await host.sandbox.terminations()).length;
    // the server records what reaches it: this request, from the test process, is the control for every absence below
    await fetch(host.api('matrix-control'));
    expect(hitsNamed((await host.hits(true)).api, 'matrix-control'), 'the test server records a request').toHaveLength(1);

    const guest = guestBattery({ direct: { 'matrix-direct': host.api('matrix-direct') }, bridge: { 'matrix-bridge': host.api('matrix-bridge') } });
    const events = await host.embed('strict', { fetchBridge: { allow: [ORIGIN] }, guest });
    const eventsNow = () => page.evaluate(() => (window as any).sandboxEvents as { type: string; reason: string | null }[]);

    if (outcome.kind === 'terminates') {
        const reason = TERMINATION_REASONS[outcome.reason].text;
        await expect.poll(async () => (await eventsNow()).at(-1), { timeout: 15000, message: covering(row, `${label}: the sandbox ends with the named reason (${outcome.reason}), not a silent state`) }).toEqual({ type: 'terminated', reason });
        expect(await host.state(), covering(row, `${label}: terminated`)).toBe('terminated');
        expect((await host.sandbox.terminations()).slice(terminatedBefore).map(entry => entry.reason), covering(row, `${label}: exactly one termination, with that reason`)).toEqual([reason]);
        const all = await eventsNow();
        expect(all.slice(0, -1).every(event => event.type === 'ready'), covering(row, `${label}: only a ready may precede it`)).toBe(true);
        expect(await host.frames(), covering(row, `${label}: no frame is left`)).toBe(0);
        expect(await host.sandbox.logs(), covering(row, `${label}: nothing of the guest ran`)).not.toContainEqual(expect.stringContaining('HOSTGUEST'));
        return;
    }

    expect(events, covering(row, `${label}: ready, as the table says`)).toEqual([{ type: 'ready', reason: null }]);
    const result = await host.guestResult(10000).catch(() => 'the entry never reported: a ready sandbox with no guest');
    expect(typeof result, covering(row, `${label}: the guest's entry ran (a ready sandbox must have its guest)`)).toBe('object');
    await waitInView(page, browserName, `!!document.getElementById('hello')`);
    await page.waitForTimeout(600); // a late termination would show here
    expect(await eventsNow(), covering(row, `${label}: one ready and no termination after it`)).toEqual([{ type: 'ready', reason: null }]);
    expect(await host.state(), covering(row, `${label}: still ready`)).toBe('ready');

    const hits = (await host.hits()).api;
    expect(hitsNamed(hits, 'matrix-direct'), covering(row, `${label}: the guest's own request to the host API is not sent (egress is governed)`)).toEqual([]);
    const bridged = hitsNamed(hits, 'matrix-bridge');
    const bridgeResult = (result as Record<string, unknown>)['matrix-bridge:bridge'];
    if (outcome.bridge === 'ok') {
        expect(bridgeResult, covering(row, `${label}: the bridge's request is answered`)).toEqual({ name: 'matrix-bridge', n: 1 });
        expect(bridged, covering(row, `${label}: and reached the server`)).toHaveLength(1);
    } else {
        expect(String(bridgeResult), covering(row, `${label}: the bridge's request is refused with an error code, never a hang`)).toMatch(/^ERR /);
        expect(bridged, covering(row, `${label}: and never reached the server`)).toEqual([]);
    }

    const warnings = host.consoleWarnings.filter(line => line.startsWith('[Sandbox]'));
    // (read through the engine's frame tree, which can be mid-update right after a build: polled)
    const viewHeights = () => frameHeights(page, browserName).catch(() => [] as number[]);
    if (outcome.warns) {
        expect(warnings.filter(line => line.includes(WARNINGS[outcome.warns!])).length, covering(row, `${label}: the degraded sandbox says so, once (${outcome.warns})`)).toBe(1);
        await expect.poll(viewHeights, { message: covering(row, `${label}: and the view is the 150 px it warned of`) }).toEqual([150]);
    } else {
        expect(warnings.filter(line => Object.values(WARNINGS).some(text => line.includes(text))), covering(row, `${label}: nothing was degraded, so nothing warned`)).toEqual([]);
        await expect.poll(viewHeights, { message: covering(row, `${label}: the view fills the element`) }).toEqual([300]);
        expect(warnings.filter(line => line.includes(BRIDGE_FRAME_REFUSED)), covering(row, `${label}: the bridge's frame started`)).toEqual([]);
    }

    await page.evaluate(() => (document.querySelector('web-sandbox') as any).terminate());
    expect(await host.state(), covering(row, `${label}: terminate() ends it`)).toBe('terminated');
    expect(await host.frames(), covering(row, `${label}: and leaves no frame`)).toBe(0);
}

test.describe('directive matrix: CSP directives', () => {
    for (const [directive, cases] of Object.entries(DIRECTIVE_CASES)) {
        for (const matrixCase of cases as readonly MatrixCase[]) {
            test(`${directive} ${matrixCase.value}`, async ({ sandbox, page, browserName }) => {
                await runCase({ sandbox, page, browserName }, matrixCase, `${directive} ${matrixCase.value} (${browserName})`, { directives: replacing(directive, matrixCase.value) });
            });
        }
    }
});

test.describe('directive matrix: headers of the host page', () => {
    for (const headerCase of HEADER_CASES) {
        test(`${headerCase.header}: ${headerCase.value}`, async ({ sandbox, page, browserName }) => {
            await runCase({ sandbox, page, browserName }, headerCase, `${headerCase.header}: ${headerCase.value} (${browserName})`, { directives: matrixBase, headers: { [headerCase.header]: headerCase.value } });
        });
    }
});
