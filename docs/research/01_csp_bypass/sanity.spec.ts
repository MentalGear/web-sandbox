import { test, expect, OFFSITE_ORIGIN as ORIGIN } from '../../../test/e2e/fixture';

test('Basic Sandbox Interaction & Logging', async ({ sandbox }) => {
    // allowlist the test server, by its address (the host page's own site is admitted in no mode), for fetch
    await sandbox.mount({ origins: { connect: [ORIGIN] } }); // plain http: an origin only for loopback, as here (ADR-007)

    await sandbox.run('console.log("Hello from Sandbox")');
    await sandbox.waitForLog('Hello from Sandbox');

    // opaque origin: the request is cross-origin, so read it as no-cors
    await sandbox.run(`
        fetch('${ORIGIN}/test/e2e/harness.html', { mode: 'no-cors' })
            .then(r => console.log('Fetch Done: ' + r.type))
            .catch(e => console.log('Fetch Failed: ' + e.message));
    `);
    expect(await sandbox.waitForLog('Fetch')).toBe('Fetch Done: opaque');
});
