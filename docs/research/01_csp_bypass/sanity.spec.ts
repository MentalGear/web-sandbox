import { test, expect, ORIGIN } from '../../../test/e2e/fixture';

test('Basic Sandbox Interaction & Logging', async ({ sandbox }) => {
    // allowlist the test server for fetch
    await sandbox.mount({ connectionsAllowed: { 'upgrade-insecure-requests': true, 'connect-src': [ORIGIN] } as any });

    await sandbox.run('console.log("Hello from Sandbox")');
    await sandbox.waitForLog('Hello from Sandbox');

    // opaque origin: the request is cross-origin, so read it as no-cors
    await sandbox.run(`fetch('${ORIGIN}/test/e2e/harness.html', { mode: 'no-cors' }).then(r => console.log('Fetch Done: ' + r.type))`);
    expect(await sandbox.waitForLog('Fetch Done')).toBe('Fetch Done: opaque');
});
