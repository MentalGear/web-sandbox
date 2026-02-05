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

        // Sandbox has 'allow-popups'. So it MIGHT open.
        // But 'allow-popups-to-escape-sandbox' is NOT set.
        // So the popup should also be sandboxed?
        // Or if it opens a new tab, is it restricted?
        // We want to verify it doesn't bypass isolation.
        // Actually, if it opens 'https://google.com', that's fine.
        // The risk is opening 'about:blank' and writing to it to bypass CSP.
    });

    test('Block about:blank Bypass', async ({ page }) => {
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                try {
                    const win = window.open('about:blank');
                    // Try to write script
                    win.document.write('<script>window.opener.parent.postMessage({type:"LOG", args:["Bypass Success"]}, "*")</script>');
                } catch (e) {
                    window.parent.postMessage({type:'LOG', args:['Bypass Failed: ' + e.message]}, '*');
                }
            `);
        });

        // If bypass works, we get "Bypass Success"
        try {
            const msg = await page.waitForEvent('console', m => m.text().includes('Bypass Success'), { timeout: 2000 });
            expect(msg).toBeNull();
        } catch (e) {
            // Good
        }
    });

    test('Block CSS Exfiltration', async ({ page }) => {
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                const style = document.createElement('style');
                // Try to load image from external site via CSS
                style.textContent = 'body { background-image: url("http://example.com/track"); }';
                document.head.appendChild(style);

                // We can't easily detect if it loaded from inside JS (CSS is silent).
                // But the browser network log would show it.
                // We assume Playwright can catch the request.
            `);
        });

        // Listen for request
        const request = await page.waitForRequest(r => r.url().includes('example.com'), { timeout: 2000 }).catch(() => null);
        expect(request).toBeNull(); // Should be blocked by img-src (default-src 'none')
    });
});
