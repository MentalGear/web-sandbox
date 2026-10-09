import { test, expect, ORIGIN } from '../../../test/e2e/fixture';

test('Basic Sandbox Interaction & Logging', async ({ sandbox, browserName }) => {
    // The sandbox always sets upgrade-insecure-requests, and WebKit applies it to http://localhost as well,
    // so the plain-http test server cannot be allowlisted there. (Routing an https origin instead races
    // with Chromium's out-of-process sandbox frame.)
    test.skip(browserName === 'webkit', 'WebKit upgrades http://localhost under upgrade-insecure-requests');
    // allowlist the test server for fetch
    await sandbox.mount({ connectionsAllowed: { 'upgrade-insecure-requests': true, 'connect-src': [ORIGIN] } as any });

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
