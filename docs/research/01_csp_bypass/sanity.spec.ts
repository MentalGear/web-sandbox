import { test, expect } from '../../../test/e2e/fixture';
import { startSiblingApi } from '../../../test/e2e/realistic-host-sibling';

test.use({ ignoreHTTPSErrors: true }); // the test listener's certificate is self-signed

test('Basic Sandbox Interaction & Logging', async ({ sandbox }) => {
    // allowlist a listener of this test's own, on another site than the host page's (which is admitted in no mode), for fetch
    const listener = await startSiblingApi();
    try {
        await sandbox.mount({ origins: { connect: [listener.crossSite] } });

        await sandbox.run('console.log("Hello from Sandbox")');
        await sandbox.waitForLog('Hello from Sandbox');

        // opaque origin: the request is cross-origin, so read it as no-cors
        await sandbox.run(`
            fetch('${listener.crossSite}/api/sanity', { mode: 'no-cors' })
                .then(r => console.log('Fetch Done: ' + r.type))
                .catch(e => console.log('Fetch Failed: ' + e.message));
        `);
        expect(await sandbox.waitForLog('Fetch')).toBe('Fetch Done: opaque');
        expect(listener.named('sanity'), 'the request reached the allowlisted origin').toHaveLength(1);
    } finally {
        await listener.stop();
    }
});
