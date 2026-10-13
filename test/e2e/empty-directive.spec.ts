import { test, expect } from './fixture';
import { useRecorder } from './recorder';

/**
 * Backlog S16: an empty directive means deny. `connectionsAllowed: { 'default-src': [] }` used to emit
 * no default-src at all, so every fetch directive the config did not set was unrestricted. It now emits
 * default-src 'none' (src/lib/csp/csp-generator.ts); the unit tests cover every directive, this proves
 * the result in the browser.
 *
 * Evidence (backlog T5): each refused load must come with its CSP violation, so a request that left and
 * merely failed would show up as a refusal without one; and both target a listener outside the browser
 * (recorder.ts), which must stay silent. Positive control: the same loads with the listener allowlisted
 * succeed, reach it, and raise no violation.
 */

const recorder = useRecorder();

const attempts = (target: string) => `
    const violations = [];
    addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective + ' ' + e.blockedURI));
    const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
    const img = await new Promise(res => { const i = new Image(); i.onload = () => res('reached'); i.onerror = () => res('refused'); i.src = '${target}/img.svg'; });
    const fetched = await fetch('${target}/fetch', { mode: 'no-cors' }).then(() => 'reached', () => 'refused');
    await new Promise(res => setTimeout(res, 300)); // violation events are queued as tasks
    return { policy, img, fetched, violations: [...new Set(violations)].sort() };
`;

test("with connectionsAllowed { 'default-src': [] }, a guest image and fetch to a non-allowlisted origin are refused, each reported as a violation", async ({ sandbox }) => {
    expect(await sandbox.mount({ connectionsAllowed: { 'default-src': [] } })).toBe('ready');
    const r = await sandbox.inGuest(attempts(recorder.blocked));

    expect(r.policy).toMatch(/^default-src 'none';/);
    expect({ img: r.img, fetched: r.fetched }).toEqual({ img: 'refused', fetched: 'refused' });
    expect(r.violations).toEqual([`connect-src ${recorder.blocked}/fetch`, `img-src ${recorder.blocked}/img.svg`]);
    expect(recorder.paths('blocked')).toEqual([]);
});

test('positive control: with the listener allowlisted, the same image and fetch succeed and reach it, with no violation', async ({ sandbox }) => {
    expect(await sandbox.mount({ connectionsAllowed: { 'default-src': [recorder.allowed] } })).toBe('ready');
    const r = await sandbox.inGuest(attempts(recorder.allowed));

    expect({ img: r.img, fetched: r.fetched, violations: r.violations }).toEqual({ img: 'reached', fetched: 'reached', violations: [] });
    await recorder.waitFor('allowed', '/img.svg');
    await recorder.waitFor('allowed', '/fetch');
});
