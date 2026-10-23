import { test, expect } from './fixture';
import { useRecorder } from './recorder';
import { GATE_SOURCE_FILE } from '@src/lib/violation';

// Evidence (backlog T5): the load outcome inside the worker, a listener outside the browser that every
// attempt targets (recorder.ts), and the violation where the engine raises one in a worker. Positive
// control: the last test, the same loads to an allowlisted origin.
const recorder = useRecorder();

// Worker mode spawns the worker inside the sandbox frame, not from the host document, where it would run under the
// host's origin and CSP with full network access (S1).
test.describe('Worker mode isolation', () => {
    test.beforeEach(async ({ sandbox }) => {
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
    });

    test('runs code in a worker with an opaque origin', async ({ sandbox }) => {
        await sandbox.run(`console.log('WORKER_CONTEXT ' + (typeof document) + ' ' + self.origin)`);
        expect(await sandbox.waitForLog('WORKER_CONTEXT')).toBe('WORKER_CONTEXT undefined null');
    });

    // A refused fetch is reported by the library's request gate on every engine; importScripts() is reported where the
    // engine raises one in a worker (measured, test/e2e/violations.spec.ts section 4): Chromium only.
    test('blocks fetch to a host that is not allowlisted', async ({ sandbox }) => {
        await sandbox.run(`
            fetch('${recorder.blocked}/fetch')
                .then(() => console.log('FETCH_SUCCESS'))
                .catch(e => console.log('FETCH_BLOCKED ' + e.message));
        `);

        expect(await sandbox.waitForLog(/FETCH_(SUCCESS|BLOCKED)/)).toContain('FETCH_BLOCKED');
        expect((await sandbox.waitForViolation('connect-src', `${recorder.blocked}/fetch`)).sourceFile).toBe(GATE_SOURCE_FILE);
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
