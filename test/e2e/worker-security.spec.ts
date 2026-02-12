import { test, expect } from '@playwright/test';

test.describe('Lofi Sandbox Worker Security', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:4444/');
        await page.waitForSelector('lofi-sandbox');
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.setConfig({ mode: 'worker', scriptUnsafe: true });
        });
    });

    test('Block External Fetch', async ({ page }) => {
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                fetch('http://example.com')
                    .then(() => self.postMessage({type:'LOG', args:['Fetch Success']}))
                    .catch(e => self.postMessage({type:'LOG', args:['Fetch Blocked: ' + e.message]}));
            `);
        });

        // Should catch Fetch Blocked
        const msg = await page.waitForEvent('console', m => m.text().includes('Fetch Blocked'));
        expect(msg).toBeTruthy();
    });

    test('Block importScripts', async ({ page }) => {
        await page.evaluate(() => {
            const s = document.querySelector('lofi-sandbox');
            s.execute(`
                try {
                    importScripts('http://example.com/script.js');
                    self.postMessage({type:'LOG', args:['Import Success']});
                } catch (e) {
                    self.postMessage({type:'LOG', args:['Import Blocked: ' + e.message]});
                }
            `);
        });

        const msg = await page.waitForEvent('console', m => m.text().includes('Import Blocked'));
        expect(msg).toBeTruthy();
    });
});
