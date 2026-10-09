import { test, expect } from './fixture';

test.describe('Escape attempts', () => {
    test.beforeEach(async ({ sandbox }) => {
        await sandbox.mount();
    });

    test('cannot open popups by default', async ({ sandbox, context }) => {
        let popups = 0;
        context.on('page', () => popups++);

        // Chromium and WebKit return null, Firefox throws
        await sandbox.run(`
            try { console.log('POPUP ' + (window.open('about:blank') ? 'opened' : 'blocked')); }
            catch (e) { console.log('POPUP blocked'); }
        `);

        expect(await sandbox.waitForLog('POPUP')).toBe('POPUP blocked');
        expect(popups).toBe(0);
    });

    test('cannot exfiltrate via CSS background images', async ({ sandbox, context, page }) => {
        const reached: string[] = [];
        await context.route('https://example.com/**', route => { reached.push(route.request().url()); return route.abort(); });

        await sandbox.run(`
            const style = document.createElement('style');
            style.textContent = 'body { background-image: url("https://example.com/track"); }';
            document.head.appendChild(style);
        `);
        await page.waitForTimeout(1000);

        expect(reached).toEqual([]);
    });

    test('cannot exfiltrate via image, beacon or link ping', async ({ sandbox, context, page }) => {
        const reached: string[] = [];
        await context.route('https://example.com/**', route => { reached.push(route.request().url()); return route.abort(); });

        await sandbox.run(`
            new Image().src = 'https://example.com/img';
            try { navigator.sendBeacon('https://example.com/beacon', 'x'); } catch (e) {}
            const a = document.createElement('a');
            a.href = '#'; a.ping = 'https://example.com/ping';
            document.body.appendChild(a); a.click();
        `);
        await page.waitForTimeout(1000);

        expect(reached).toEqual([]);
    });
});
