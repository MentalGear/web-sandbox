import { test, expect } from '../../../test/e2e/fixture';
import { useRecorder } from '../../../test/e2e/recorder';
import { fromPreset } from '../../../test/e2e/presets';

// Evidence (backlog T5): the base-uri violation reported on the host, the fetch's own outcome (its relative
// URL cannot be resolved against the inherited about:blank base, S15), and a listener outside the browser
// that the injected base points at. Positive control: a policy that allows the base and the fetch.
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

test('positive control: with base-uri and connect-src allowing it, the injected base is used and the listener sees the fetch', async ({ sandbox }) => {
    await sandbox.mount({ ...preset.rules, connectionsAllowed: { 'base-uri': [recorder.allowed], 'connect-src': [recorder.allowed] } });

    const logs = await sandbox.runUntilDone(payload(recorder.allowed));

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(true);
    await recorder.waitFor('allowed', '/base/foo');
    expect(await sandbox.violations()).toEqual([]);
});
