import { test, expect, type MountConfig, type SandboxDriver } from './fixture';

/**
 * The owner's decisions after review round 1 (docs/security/REVIEW-ROUND-1-2026-10-15.md, "Awaiting the owner"), where
 * the browser decides, on Chromium, Firefox and WebKit. Evidence is read from outside the sandbox: the frames'
 * attributes from the host page, the view's DOM through strict-view.ts (DevTools in Chromium), the recorder's listeners.
 *   R2-2  allow-forms is an unsafe capability in cooperative mode (and test/e2e/review-round-1.spec.ts, "R2-2")
 */

// The sandbox flags of the wrapper and of the guest frame inside it, read from the host page.
const flagsOf = (sandbox: SandboxDriver) => sandbox.page.evaluate(() => {
    const wrapper = (document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!;
    const inner = new DOMParser().parseFromString(wrapper.srcdoc, 'text/html').querySelector('iframe')!;
    return [wrapper.getAttribute('sandbox'), inner.getAttribute('sandbox')];
});

test.describe('R2-2: in cooperative mode a form submits only with unsafeCapabilities: [\'allow-forms\']', () => {
    const FORM = `<form id="f"><input name="q" value="v"><button id="b">b</button></form>
        <script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); console.log('R22 submit ' + new FormData(e.target).get('q')); });</script>`;
    const SUBMIT = `document.getElementById('f').requestSubmit(); setTimeout(() => console.log('R22 settled'), 300);`;
    const fires = async (sandbox: SandboxDriver, config: MountConfig) => {
        expect(await sandbox.mount({ mode: 'cooperative', ...config, html: FORM })).toBe('ready');
        await sandbox.clearLogs();
        await sandbox.run(SUBMIT);
        await sandbox.waitForLog('R22 settled');
        return { flags: await flagsOf(sandbox), submitted: (await sandbox.logs()).includes('R22 submit v') };
    };

    test("capabilities: ['allow-forms'] is dropped: no frame has the flag, and no submission starts (WebKit still dispatches the submit event, a platform behaviour: research 15, P4)", async ({ sandbox, browserName }) => {
        expect(await fires(sandbox, { capabilities: ['allow-scripts', 'allow-forms' as any] })).toEqual({ flags: ['allow-scripts', 'allow-scripts'], submitted: browserName === 'webkit' });
    });

    test("unsafeCapabilities: ['allow-forms'] grants it on both frames and the submission starts on every engine (the positive control)", async ({ sandbox }) => {
        expect(await fires(sandbox, { capabilities: ['allow-scripts'], unsafeCapabilities: ['allow-forms'] })).toEqual({ flags: ['allow-scripts allow-forms', 'allow-scripts allow-forms'], submitted: true });
    });
});
