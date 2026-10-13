import { test, expect, ORIGIN } from './fixture';

// Worker mode used to spawn the worker from the host document, so it ran under the host's
// origin and CSP with full network access (backlog S1). It now runs inside the sandbox frame.
test.describe('Worker mode isolation', () => {
    test.beforeEach(async ({ sandbox }) => {
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
    });

    test('runs code in a worker with an opaque origin', async ({ sandbox }) => {
        await sandbox.run(`console.log('WORKER_CONTEXT ' + (typeof document) + ' ' + self.origin)`);
        expect(await sandbox.waitForLog('WORKER_CONTEXT')).toBe('WORKER_CONTEXT undefined null');
    });

    // The load outcome is the evidence in every engine. The violation is asserted where the engine raises
    // one in a worker (measured, test/e2e/violations.spec.ts section 4): Chromium for both, Firefox for
    // fetch only, WebKit for neither.
    test('blocks fetch to a host that is not allowlisted', async ({ sandbox, browserName }) => {
        // same origin as the host page: the old worker could fetch it freely
        await sandbox.run(`
            fetch('${ORIGIN}/playground/test-assets/local-image.svg')
                .then(() => console.log('FETCH_SUCCESS'))
                .catch(e => console.log('FETCH_BLOCKED ' + e.message));
        `);

        expect(await sandbox.waitForLog(/FETCH_(SUCCESS|BLOCKED)/)).toContain('FETCH_BLOCKED');
        if (browserName !== 'webkit') expect(await sandbox.waitForViolation('connect-src', `${ORIGIN}/playground/test-assets/local-image.svg`)).toBeTruthy();
    });

    test('blocks importScripts from an external URL', async ({ sandbox, browserName }) => {
        await sandbox.run(`
            try {
                importScripts('${ORIGIN}/playground/test-assets/script.js');
                console.log('IMPORT_SUCCESS');
            } catch (e) {
                console.log('IMPORT_BLOCKED ' + e.name);
            }
        `);

        expect(await sandbox.waitForLog(/IMPORT_(SUCCESS|BLOCKED)/)).toContain('IMPORT_BLOCKED');
        if (browserName === 'chromium') expect(await sandbox.waitForViolation('script-src-elem', `${ORIGIN}/playground/test-assets/script.js`)).toBeTruthy();
    });
});
