import { test, expect } from './fixture';
import { useRecorder } from './recorder';

// Evidence (backlog T5): the load outcome inside the worker, a listener outside the browser that every
// attempt targets (recorder.ts), and the violation where the engine raises one in a worker. Positive
// control: the last test, the same loads to an allowlisted origin.
const recorder = useRecorder();

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

    // The violation is asserted where the engine raises one in a worker (measured,
    // test/e2e/violations.spec.ts section 4): Chromium for both, Firefox for fetch only, WebKit for neither.
    test('blocks fetch to a host that is not allowlisted', async ({ sandbox, browserName }) => {
        await sandbox.run(`
            fetch('${recorder.blocked}/fetch')
                .then(() => console.log('FETCH_SUCCESS'))
                .catch(e => console.log('FETCH_BLOCKED ' + e.message));
        `);

        expect(await sandbox.waitForLog(/FETCH_(SUCCESS|BLOCKED)/)).toContain('FETCH_BLOCKED');
        if (browserName !== 'webkit') expect(await sandbox.waitForViolation('connect-src', `${recorder.blocked}/fetch`)).toBeTruthy();
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('blocks importScripts from an external URL', async ({ sandbox, browserName }) => {
        await sandbox.run(`
            try {
                importScripts('${recorder.blocked}/script.js');
                console.log('IMPORT_SUCCESS');
            } catch (e) {
                console.log('IMPORT_BLOCKED ' + e.name);
            }
        `);

        expect(await sandbox.waitForLog(/IMPORT_(SUCCESS|BLOCKED)/)).toContain('IMPORT_BLOCKED');
        if (browserName === 'chromium') expect(await sandbox.waitForViolation('script-src-elem', `${recorder.blocked}/script.js`)).toBeTruthy();
        expect(recorder.paths('blocked')).toEqual([]);
    });
});

test('positive control: worker fetch and importScripts from an allowlisted origin succeed and reach the listener', async ({ sandbox }) => {
    expect(await sandbox.mount({ mode: 'worker', origins: { connect: [recorder.allowed], scripts: [recorder.allowed] } })).toBe('ready');
    const outcome = await sandbox.inGuest(`
        const fetched = await fetch('${recorder.allowed}/fetch').then(r => r.text(), e => 'refused ' + e.message);
        let imported;
        try { importScripts('${recorder.allowed}/script.js'); imported = globalThis.__recorderRan; } catch (e) { imported = 'refused ' + e.name; }
        return { fetched, imported };
    `);
    expect(outcome).toEqual({ fetched: 'ok', imported: 1 });
    await recorder.waitFor('allowed', '/fetch');
    await recorder.waitFor('allowed', '/script.js');
    expect(await sandbox.violations()).toEqual([]);
});
