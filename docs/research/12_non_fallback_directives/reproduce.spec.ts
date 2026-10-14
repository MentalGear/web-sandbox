import { test, expect } from '../../../test/e2e/fixture';
import { useRecorder } from '../../../test/e2e/recorder';
import { cooperativePolicy, strictViewPolicy } from '@src/lib/csp/csp-generator';
import { parseOrigins } from '@src/lib/csp/origins';
import { fromPreset } from '../../../test/e2e/presets';

/**
 * Research 12: directives dropped by the empty-array rule do not all fall back to default-src.
 * Runs on the shared e2e harness (test/e2e/fixture.ts).
 */

// Evidence for 12.2 (backlog T5): the form-action violation reported on the host where the engine raises
// it before the submission is abandoned, and a listener outside the browser that the form targets. A
// permitted form-action cannot be the positive control: a submission is a navigation, which the wrapper's
// frame-src 'none' refuses anyway (S10). So the control submits the same form from a frame on the host page.
const recorder = useRecorder();
const preset = fromPreset('form-action-exfil');

test('12.1 every policy restricts base-uri and form-action, which have no fallback, whatever the config', () => {
    // base-uri and form-action do not fall back to default-src, so their absence would mean "unrestricted".
    // Fixed (backlog S9), and since ADR-007 by construction: both templates always emit them as 'none', and no
    // `origins` kind can reach them.
    const origins = parseOrigins({ connect: ['https://a.example'], 'base-uri': ['https://a.example'], 'form-action': ['*'] }, 'iframe', () => {});
    const input = { origins, fileKinds: new Set<never>(), scriptUnsafe: true };
    for (const policy of [cooperativePolicy(input), strictViewPolicy({ ...input, bootstrapHash: `'sha256-${'A'.repeat(43)}='` })]) {
        expect(policy, 'base-uri has no default-src fallback').toContain("base-uri 'none'");
        expect(policy, 'form-action has no default-src fallback').toContain("form-action 'none'");
    }
});

test('12.2 form-action: a GET form cannot exfiltrate to a non-allowlisted target', async ({ sandbox, page, browserName }) => {
    // allow-forms (in the preset's rules) is a sanctioned value in SAFE_CAPABILITIES
    await sandbox.mount(preset.rules);
    await sandbox.load(preset.aimedAt(`${recorder.blocked}/exfil`));

    if (browserName === 'chromium') {
        // Measured 2026-10-13: in Chromium no report reaches the host. The guest document is replaced by the
        // refused submission's error page first, so the listener outside the browser is the evidence there.
        await page.waitForTimeout(2000);
    } else {
        expect(await sandbox.waitForViolation('form-action', `${recorder.blocked}/exfil`)).toBeTruthy();
    }
    expect(recorder.paths('blocked'), 'form submission escaped the network policy').toEqual([]);
});

test('12.2 positive control: the same form submitted from a frame on the host page reaches the listener', async ({ sandbox }) => {
    await sandbox.page.evaluate((markup) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-forms');
        frame.srcdoc = markup;
        document.body.appendChild(frame);
    }, preset.aimedAt(`${recorder.blocked}/exfil`));
    await recorder.waitFor('blocked', '/exfil?stolen=session-secret');
});
