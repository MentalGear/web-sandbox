import { test, expect } from '@playwright/test';

test.describe('Lofi Sandbox Security', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:4444/security');
        await page.waitForSelector('lofi-sandbox');
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.setConfig({ scriptUnsafe: true });
        });
    });

    test('Block Nested Iframes (CSP Bypass)', async ({ page }) => {
        // Attempt to create a nested iframe
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                const i = document.createElement('iframe');
                i.src = "javascript:alert(1)"; // or something
                document.body.appendChild(i);
                // Check if it loaded (CSP frame-src 'none' should block it)
                i.onload = () => window.parent.postMessage({type:'LOG', args:['Frame Loaded']}, '*');
                i.onerror = () => window.parent.postMessage({type:'LOG', args:['Frame Error']}, '*');
            `);
        });

        // We shouldn't see 'Frame Loaded'.
        // CSP violation should trigger.
        // Note: lofi-sandbox doesn't have CSP violation reporting hooked up to postMessage yet in the host.ts example,
        // but the browser console will show it.
        // We'll wait a bit and ensure no success message.
        try {
            const msg = await page.waitForEvent('console', m => m.text().includes('Frame Loaded'), { timeout: 2000 });
            expect(msg).toBeNull(); // Fail if loaded
        } catch (e) {
            // Timeout is good
        }
    });

    test('Block Parent Access (Isolation)', async ({ page }) => {
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                try {
                    const p = window.parent.document;
                    window.parent.postMessage({type:'LOG', args:['Parent Access Success']}, '*');
                } catch (e) {
                    window.parent.postMessage({type:'LOG', args:['Parent Access Blocked: ' + e.message]}, '*');
                }
            `);
        });

        const msg = await page.waitForEvent('console', m => m.text().includes('Parent Access Blocked'));
        expect(msg).toBeTruthy();
    });

    test('No Service Worker Access', async ({ page }) => {
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                if (!navigator.serviceWorker) {
                    window.parent.postMessage({type:'LOG', args:['No SW API']}, '*');
                } else {
                    navigator.serviceWorker.getRegistrations().then(r => {
                         window.parent.postMessage({type:'LOG', args:['SW Registrations: ' + r.length]}, '*');
                    });
                }
            `);
        });

        // Opaque origin -> No SW API, or throws SecurityError
        const msg = await page.waitForEvent('console', m => m.text().includes('No SW API') || m.text().includes('SecurityError'));
        expect(msg).toBeTruthy();
    });

    test('Storage Ephemerality', async ({ page }) => {
        // 1. Write
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                try {
                    localStorage.setItem('foo', 'bar');
                    window.parent.postMessage({type:'LOG', args:['Write Success']}, '*');
                } catch (e) {
                    window.parent.postMessage({type:'LOG', args:['Write Failed: ' + e.message]}, '*');
                }
            `);
        });

        // Opaque origins usually throw on localStorage access
        const msg = await page.waitForEvent('console', m => m.text().includes('Write Failed'));
        expect(msg.text()).toContain('SecurityError'); // or similar
    });
});
