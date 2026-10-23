import { test, expect, type ViolationRecord } from './fixture';
import { useRecorder } from './recorder';
import { GATE_SOURCE_FILE } from '@src/lib/violation';

/**
 * Backlog S16: an empty list means deny. An empty kind of `origins` emits its directive as 'none', and default-src is
 * always 'none' (src/lib/csp/csp-generator.ts, ADR-007): no browser consults a fallback. The unit tests cover every
 * kind and input; this proves the result in the browser.
 *
 * Evidence (backlog T5): each refused load must come with its CSP violation, so a request that left and
 * merely failed would show up as a refusal without one; and both target a listener outside the browser
 * (recorder.ts), which must stay silent. The image's violation is the browser's, raised in the guest; the fetch never
 * reaches the browser, because the request gate refuses it first and reports it to the host as a `connect-src`
 * violation whose sourceFile is the gate's (in-sandbox-script.ts, S74). Positive control: the same loads with the
 * listener allowlisted succeed, reach it, and raise no violation.
 */

const recorder = useRecorder();

// The host's `violation` reports of the request gate (the guest's fetch), as `directive blockedURI`.
const gateReports = async (sandbox: { page: { waitForTimeout(ms: number): Promise<void> }; violations(): Promise<ViolationRecord[]> }) => {
    await sandbox.page.waitForTimeout(300); // a report crosses the port as a task
    return (await sandbox.violations()).filter(v => v.sourceFile === GATE_SOURCE_FILE).map(v => `${v.directive} ${v.blockedURI}`);
};

const attempts = (target: string) => `
    const violations = [];
    addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective + ' ' + e.blockedURI));
    const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
    const img = await new Promise(res => { const i = new Image(); i.onload = () => res('reached'); i.onerror = () => res('refused'); i.src = '${target}/img.svg'; });
    const fetched = await fetch('${target}/fetch', { mode: 'no-cors' }).then(() => 'reached', () => 'refused');
    await new Promise(res => setTimeout(res, 300)); // violation events are queued as tasks
    return { policy, img, fetched, violations: [...new Set(violations)].sort() };
`;

test("with origins { images: [], connect: [] }, a guest image and fetch to a non-allowlisted origin are refused, each reported as a violation", async ({ sandbox }) => {
    expect(await sandbox.mount({ origins: { images: [], connect: [] } })).toBe('ready');
    const r = await sandbox.inGuest(attempts(recorder.blocked));

    expect(r.policy).toMatch(/^default-src 'none';/);
    expect(r.policy).toContain("img-src 'none';");
    expect(r.policy).toContain("connect-src 'none';");
    expect({ img: r.img, fetched: r.fetched }).toEqual({ img: 'refused', fetched: 'refused' });
    expect(r.violations).toEqual([`img-src ${recorder.blocked}/img.svg`]);
    expect(await gateReports(sandbox)).toEqual([`connect-src ${recorder.blocked}/fetch`]);
    expect(recorder.paths('blocked')).toEqual([]);
});

test('connectionsAllowed was removed (ADR-007): one that allows the listener is ignored with one warning, and the same image and fetch are refused, each reported', async ({ sandbox, page }) => {
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
    const removed = { connectionsAllowed: { 'default-src': [recorder.blocked], 'img-src': [recorder.blocked], 'connect-src': [recorder.blocked] } } as never;
    expect(await sandbox.mount(removed)).toBe('ready');
    expect(await sandbox.reset()).toBe('ready');
    const r = await sandbox.inGuest(attempts(recorder.blocked));

    expect({ img: r.img, fetched: r.fetched }).toEqual({ img: 'refused', fetched: 'refused' });
    expect(r.violations).toEqual([`img-src ${recorder.blocked}/img.svg`]);
    expect(await gateReports(sandbox)).toEqual([`connect-src ${recorder.blocked}/fetch`]);
    expect(warnings.filter(w => w.includes('connectionsAllowed was removed; use origins'))).toHaveLength(1);
    expect(recorder.paths('blocked')).toEqual([]);
});

test('positive control: with the listener allowlisted, the same image and fetch succeed and reach it, with no violation', async ({ sandbox }) => {
    expect(await sandbox.mount({ origins: { images: [recorder.allowed], connect: [recorder.allowed] } })).toBe('ready');
    const r = await sandbox.inGuest(attempts(recorder.allowed));

    expect({ img: r.img, fetched: r.fetched, violations: r.violations }).toEqual({ img: 'reached', fetched: 'reached', violations: [] });
    await recorder.waitFor('allowed', '/img.svg');
    await recorder.waitFor('allowed', '/fetch');
});
