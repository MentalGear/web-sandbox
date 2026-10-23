import { test, expect } from './fixture';

/**
 * Class L (S74; LM-2): embedder code that runs inside a release of the element's own teardown, with a real focus event.
 * The wrapper's removal fires the host window's `focus` on Firefox when the guest frame holds focus, and a focused
 * cooperative guest's `pagehide` handler (which runs inside the removal on every engine) can call `parent.parent.blur()`
 * and `focus()` itself. A listener that builds again from there (reset()) must leave one environment, and the next
 * terminate() must end it: the old guest stops, no frame is left, and nothing is thrown at the embedder. Before the fix,
 * the rest of the outer teardown cleared the nested build's fields (Firefox: the old guest ran on, visible, with no
 * frame on record; Chromium and WebKit: NotFoundError out of the embedder's own terminate()).
 * The unit half, which re-enters at every release point of the teardown: test/unit/teardown-reentry.test.ts.
 */

type Trigger = 'host terminate()' | 'guest-forged second announcement';

for (const trigger of ['host terminate()', 'guest-forged second announcement'] as Trigger[]) {
    test(`a reset() from a focus or blur listener inside the teardown: one environment, and the next terminate() ends it (${trigger})`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(60000);
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await sandbox.open();
        const forge = trigger === 'guest-forged second announcement';
        // The guest pings the host window every 100 ms; on pagehide it takes the host window's focus; for the forged
        // trigger it focuses itself (no click needed on Firefox) and announces a second time, which ends its environment.
        const guest = `<input id="i"><script>
  setInterval(() => parent.parent.postMessage({ alive: true }, '*'), 100);
  const go = () => { try { parent.parent.blur(); parent.parent.focus(); } catch (e) {} };
  addEventListener('pagehide', go); addEventListener('unload', go);
  ${forge ? `setTimeout(() => { window.focus(); document.getElementById('i').focus(); }, 300);
  setTimeout(() => bridge.call('shouldForge').then(yes => { if (yes) parent.parent.postMessage({ type: 'SANDBOX_PORT' }, '*', [new MessageChannel().port1]); }), 900);` : ''}
</script>`;
        await page.evaluate(() => {
            const el = document.querySelector('web-sandbox') as any;
            const w = window as any;
            w.reentered = 0;
            w.thrown = [] as string[];
            let forged = false;
            el.expose('shouldForge', () => (forged ? false : (forged = true)));
            const listener = () => {
                if (w.reentered === 0 && el.state === 'terminated') {
                    w.reentered++;
                    try { el.reset(); } catch (error) { w.thrown.push(String(error)); }
                }
            };
            window.addEventListener('focus', listener);
            window.addEventListener('blur', listener);
        });
        expect(await sandbox.mount({ mode: 'cooperative', html: guest })).toBe('ready');
        const box = await page.locator('web-sandbox').boundingBox();
        await page.mouse.click(box!.x + 20, box!.y + 10); // the guest frame holds focus
        if (forge) await page.waitForFunction(() => (window as any).reentered > 0, null, { timeout: 15000 });

        const report = await page.evaluate(async (forge) => {
            const el = document.querySelector('web-sandbox') as any;
            const w = window as any;
            const settle = () => new Promise<void>((resolve) => {
                if (el.state === 'ready' || el.state === 'terminated') return resolve();
                el.addEventListener('ready', () => resolve(), { once: true });
                el.addEventListener('terminated', () => resolve(), { once: true });
                setTimeout(resolve, 10000);
            });
            const out: Record<string, unknown> = {};
            if (!forge) {
                try { el.terminate('the host ends it'); } catch (error) { w.thrown.push(`terminate() threw ${error}`); }
            }
            await settle();
            out.settled = el.state;
            out.reentered = w.reentered;
            out.framesWhileSettled = el.shadowRoot.querySelectorAll('iframe').length;
            let alive = 0;
            const onMessage = (event: MessageEvent) => { if (event.data && event.data.alive) alive++; };
            window.addEventListener('message', onMessage);
            await new Promise((r) => setTimeout(r, 400));
            try { el.terminate('the host ends the rest'); } catch (error) { w.thrown.push(`2nd terminate() threw ${error}`); }
            out.framesAfterTerminate = el.shadowRoot.querySelectorAll('iframe').length;
            out.stateAfterTerminate = el.state;
            await new Promise((r) => setTimeout(r, 300));
            alive = 0;
            await new Promise((r) => setTimeout(r, 1500));
            window.removeEventListener('message', onMessage);
            out.pingsAfterTerminate = alive;
            out.thrown = w.thrown;
            return out;
        }, forge);

        expect(report.thrown).toEqual([]);
        expect(pageErrors).toEqual([]);
        expect(report.framesAfterTerminate).toBe(0);
        expect(report.stateAfterTerminate).toBe('terminated');
        expect(report.pingsAfterTerminate).toBe(0); // the old guest is gone as well as the new one
        // ledger: focus-during-removal
        if (browserName === 'firefox') expect(report.reentered, 'Firefox fires the host window focus inside the removal').toBeGreaterThan(0);
        if (report.reentered) expect(report.settled).toBe('ready'); // the nested build stood
    });
}
