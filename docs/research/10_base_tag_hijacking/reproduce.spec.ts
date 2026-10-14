import { test, expect } from '../../../test/e2e/fixture';
import { useRecorder } from '../../../test/e2e/recorder';
import { fromPreset } from '../../../test/e2e/presets';

// Evidence (backlog T5): the base-uri violation reported on the host, the fetch's own outcome (its relative
// URL cannot be resolved against the inherited about:blank base, S15), and a listener outside the browser
// that the injected base points at. Positive control: the same payload without the sandbox's policy.
const recorder = useRecorder();
const preset = fromPreset('base-tag');
const payload = (origin: string) => preset.aimedAt(`${origin}/base/`);

test('Base Tag Hijacking - Mitigated', async ({ sandbox }) => {
    await sandbox.mount(preset.rules);

    const logs = await sandbox.runUntilDone(payload(recorder.blocked));

    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
    expect(await sandbox.waitForViolation('base-uri', `${recorder.blocked}/base/`)).toBeTruthy();
    expect(recorder.paths('blocked')).toEqual([]);
});

// No configuration can allow a base: base-uri is always 'none' (ADR-007). So the positive control runs the same payload
// outside the sandbox, in a sandboxed frame on the host page with no policy: there the injected base is used, and the
// listener sees the fetch it resolves.
test('positive control: the same payload in a frame on the host page, with no policy, uses the injected base and the listener sees the fetch', async ({ sandbox }) => {
    const script = payload(recorder.allowed).replace(/<\/script/gi, '<\\/script');
    await sandbox.page.evaluate((code) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.srcdoc = `<!DOCTYPE html><head></head><script>${code}</script>`;
        document.body.appendChild(frame);
    }, script);
    await recorder.waitFor('allowed', '/base/foo');
});
