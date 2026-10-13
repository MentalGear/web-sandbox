import { test, expect } from './fixture';
import { useRecorder } from './recorder';
import { fromPreset } from './presets';

// The nested-frame test targets a listener outside the browser (recorder.ts), backed by the reported
// violation; its positive control is the last test. The other tests here are not egress: each asserts the
// refused outcome itself (an exception, a null origin), never the absence of a success. Their payloads are
// the presets' (backlog T4), run here under the default config.
const recorder = useRecorder();

test.describe('Isolation', () => {
    test.beforeEach(async ({ sandbox }) => {
        await sandbox.mount();
    });

    test('blocks nested iframes (frame-src): the refusal is reported as a violation, and nothing reaches the listener', async ({ sandbox }) => {
        await sandbox.run(`
            const i = document.createElement('iframe');
            i.onload = () => console.log('FRAME_LOADED ' + (() => { try { return i.contentWindow.location.href } catch (e) { return 'cross-origin' } })());
            i.src = '${recorder.blocked}/frame.html';
            document.body.appendChild(i);
        `);

        // the browser may reduce the reported URL to its origin
        expect(await sandbox.waitForViolation('frame-src', recorder.blocked)).toBeTruthy();
        // a blocked frame may still fire load for its error page; it must never be the listener's page
        const logs = await sandbox.logs();
        expect(logs.filter(l => l.startsWith('FRAME_LOADED') && l.includes('127.0.0.1'))).toEqual([]);
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('cannot reach the parent or host document', async ({ sandbox }) => {
        const logs = await sandbox.runUntilDone(fromPreset('outer-frame-tampering').code);

        expect(logs).toContain('PWN_FAILURE parent SecurityError');
        expect(logs).toContain('PWN_FAILURE top SecurityError');
        expect(logs.filter(l => l.startsWith('PWN_SUCCESS'))).toEqual([]);
    });

    test('has no service worker access', async ({ sandbox }) => {
        // Chromium throws on merely reading navigator.serviceWorker in a sandboxed frame; Firefox rejects the call
        const logs = await sandbox.runUntilDone(fromPreset('sw-tamper').code);

        expect(logs.find(l => l.startsWith('PWN_'))).toMatch(/^PWN_FAILURE: /);
    });

    test('has no persistent storage (opaque origin)', async ({ sandbox }) => {
        const logs = await sandbox.runUntilDone(fromPreset('storage-sharing').code);

        expect(logs).toContain('Read Failed: SecurityError');
        expect(logs).toContain('Write Failed: SecurityError');
    });

    test('runs with an opaque origin', async ({ sandbox }) => {
        // the allow-same-origin preset's check, here under the default config (its own rules: capability-presets.spec.ts)
        const logs = await sandbox.runUntilDone(fromPreset('allow-same-origin').code);
        expect(logs).toContain('PASS: Origin is opaque. Filter working.');
    });
});

// No configuration lets the guest load a nested frame: the guest inherits the wrapper's frame-src 'none'
// (frame-documents.ts), whatever its own frame-src says. So the positive control runs the same frame load
// outside the sandbox, from the host page, to the same listener the attack targets.
test('positive control: the same frame load from the host page reaches the listener', async ({ sandbox }) => {
    const loaded = await sandbox.page.evaluate((src) => new Promise<string>(res => {
        const i = document.createElement('iframe');
        i.setAttribute('sandbox', 'allow-scripts');
        i.onload = () => res('loaded');
        i.src = src;
        document.body.appendChild(i);
    }), `${recorder.blocked}/control-frame.html`);
    expect(loaded).toBe('loaded');
    await recorder.waitFor('blocked', '/control-frame.html');
});
