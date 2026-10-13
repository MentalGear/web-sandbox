import { test, expect } from './fixture';

/**
 * Backlog S16: an empty directive means deny. `connectionsAllowed: { 'default-src': [] }` used to emit
 * no default-src at all, so every fetch directive the config did not set was unrestricted. It now emits
 * default-src 'none' (src/lib/csp/csp-generator.ts); the unit tests cover every directive, this proves
 * the result in the browser.
 *
 * The evidence cannot silently miss a request (backlog T5): each refused load must come with its CSP
 * violation, so a request that left and merely failed (attacker.test does not resolve) would show up as
 * a refusal without one and fail the test. The route is secondary evidence.
 */

const ATTACKER = 'https://attacker.test';

test("with connectionsAllowed { 'default-src': [] }, a guest image and fetch to a non-allowlisted origin are refused, each reported as a violation", async ({ sandbox, context }) => {
    const routed: string[] = [];
    await context.route(/attacker\.test/, (route) => { routed.push(route.request().url()); return route.fulfill({ body: '' }); });

    expect(await sandbox.mount({ connectionsAllowed: { 'default-src': [] } })).toBe('ready');
    const r = await sandbox.inGuest(`
        const violations = [];
        addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective + ' ' + e.blockedURI));
        const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
        const img = await new Promise(res => { const i = new Image(); i.onload = () => res('reached'); i.onerror = () => res('refused'); i.src = '${ATTACKER}/img'; });
        const fetched = await fetch('${ATTACKER}/fetch', { mode: 'no-cors' }).then(() => 'reached', () => 'refused');
        await new Promise(res => setTimeout(res, 300)); // violation events are queued as tasks
        return { policy, img, fetched, violations: [...new Set(violations)].sort() };
    `);

    expect(r.policy).toMatch(/^default-src 'none';/);
    expect({ img: r.img, fetched: r.fetched }).toEqual({ img: 'refused', fetched: 'refused' });
    expect(r.violations).toEqual([`connect-src ${ATTACKER}/fetch`, `img-src ${ATTACKER}/img`]);
    expect(routed).toEqual([]);
});
