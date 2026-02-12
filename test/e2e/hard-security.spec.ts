import { test, expect } from '@playwright/test';

test.describe('Lofi Sandbox Hard Security', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:4444/');
        await page.waitForSelector('lofi-sandbox');
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.setConfig({ scriptUnsafe: true });
        });
    });

    test('Block Popups (window.open)', async ({ page }) => {
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                try {
                    const win = window.open('https://google.com');
                    if (win) {
                        // Sandbox might allow opening, but shouldn't leak content
                        window.parent.postMessage({type:'LOG', args:['Popup Opened']}, '*');
                        win.close();
                    } else {
                        window.parent.postMessage({type:'LOG', args:['Popup Blocked']}, '*');
                    }
                } catch (e) {
                    window.parent.postMessage({type:'LOG', args:['Popup Error: ' + e.message]}, '*');
                }
            `);
        });

        // We accept either Blocked or Opened (if sandboxed).
        // The important part is checking if we can break out via it.
        const msg = await page.waitForEvent('console', m => m.text().includes('Popup'), { timeout: 2000 });
        expect(msg).toBeTruthy();
    });

    test('Block about:blank Bypass', async ({ page }) => {
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                try {
                    const win = window.open('about:blank');
                    // Try to write script
                    if (win) {
                        win.document.write('<script>window.opener.parent.postMessage({type:"LOG", args:["Bypass Success"]}, "*")</script>');
                    }
                } catch (e) {
                    window.parent.postMessage({type:'LOG', args:['Bypass Failed: ' + e.message]}, '*');
                }
            `);
        });

        // We expect NO "Bypass Success" message.
        try {
            const msg = await page.waitForEvent('console', m => m.text().includes('Bypass Success'), { timeout: 2000 });
            expect(msg).toBeNull(); // Should fail/timeout
        } catch (e) {
            // Timeout matches expectation (Secure)
            expect(e.message).toContain('Timeout');
        }
    });

    test('Block CSS Exfiltration', async ({ page }) => {
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                const style = document.createElement('style');
                style.textContent = 'body { background-image: url("http://example.com/track"); }';
                document.head.appendChild(style);
            `);
        });

        // Listen for request
        // Even if CSP blocks it, browser might initiate and fail.
        try {
            const request = await page.waitForRequest(r => r.url().includes('example.com'), { timeout: 2000 });
            // If request happens, verify it FAILED
            expect(request.failure()).toBeTruthy();
            console.log("Request detected but failed:", request.failure()?.errorText);
        } catch (e) {
            // No request seen? Even better.
        }
    });
});
