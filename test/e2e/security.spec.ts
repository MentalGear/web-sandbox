import { test, expect } from './fixture';

test.describe('Isolation', () => {
    test.beforeEach(async ({ sandbox }) => {
        await sandbox.mount();
    });

    test('blocks nested iframes (frame-src)', async ({ sandbox }) => {
        await sandbox.run(`
            const i = document.createElement('iframe');
            i.onload = () => console.log('FRAME_LOADED ' + (() => { try { return i.contentWindow.location.href } catch (e) { return 'cross-origin' } })());
            i.src = 'https://example.com/';
            document.body.appendChild(i);
            setTimeout(() => console.log('TEST_DONE'), 1000);
        `);
        await sandbox.waitForLog('TEST_DONE');

        // a blocked frame may still fire load for its error page; it must never be example.com
        const logs = await sandbox.logs();
        expect(logs.filter(l => l.startsWith('FRAME_LOADED') && l.includes('example.com'))).toEqual([]);
    });

    test('cannot reach the parent or host document', async ({ sandbox }) => {
        await sandbox.run(`
            for (const [name, get] of [['parent', () => window.parent.document], ['top', () => window.top.document]]) {
                try { get(); console.log('ACCESS_SUCCESS ' + name); }
                catch (e) { console.log('ACCESS_BLOCKED ' + name + ' ' + e.name); }
            }
        `);

        expect(await sandbox.waitForLog('ACCESS_BLOCKED parent')).toContain('SecurityError');
        expect(await sandbox.waitForLog('ACCESS_BLOCKED top')).toContain('SecurityError');
        expect((await sandbox.logs()).filter(l => l.startsWith('ACCESS_SUCCESS'))).toEqual([]);
    });

    test('has no service worker access', async ({ sandbox }) => {
        // Chromium throws on merely reading navigator.serviceWorker in a sandboxed frame
        await sandbox.run(`
            try {
                if (!navigator.serviceWorker) console.log('SW_UNAVAILABLE no api');
                else navigator.serviceWorker.getRegistrations()
                    .then(r => console.log('SW_AVAILABLE ' + r.length))
                    .catch(e => console.log('SW_UNAVAILABLE ' + e.name));
            } catch (e) {
                console.log('SW_UNAVAILABLE ' + e.name);
            }
        `);

        expect(await sandbox.waitForLog(/SW_(UN)?AVAILABLE/)).toContain('SW_UNAVAILABLE');
    });

    test('has no persistent storage (opaque origin)', async ({ sandbox }) => {
        await sandbox.run(`
            try { localStorage.setItem('foo', 'bar'); console.log('STORAGE_WRITE ok'); }
            catch (e) { console.log('STORAGE_WRITE failed ' + e.name); }
        `);

        expect(await sandbox.waitForLog('STORAGE_WRITE')).toBe('STORAGE_WRITE failed SecurityError');
    });

    test('runs with an opaque origin', async ({ sandbox }) => {
        await sandbox.run(`console.log('ORIGIN ' + window.origin)`);
        expect(await sandbox.waitForLog('ORIGIN')).toBe('ORIGIN null');
    });
});
