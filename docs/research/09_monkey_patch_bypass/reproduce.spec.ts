import { test, expect } from '../../../test/e2e/fixture';
import { useRecorder } from '../../../test/e2e/recorder';
import { PRESETS } from '@src/lib/presets';

// Evidence (backlog T5): the guest's outcome, the violation reported on the host, and a listener outside
// the browser. Positive control: an allowlisted origin.
const recorder = useRecorder();
const payload = (origin: string) => PRESETS['monkey-patch-bypass'].code.replace("'http://example.com'", `'${origin}/patched'`);

test('Monkey Patch Bypass - Mitigated', async ({ sandbox }) => {
    await sandbox.mount();

    const logs = await sandbox.runUntilDone(payload(recorder.blocked));

    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
    expect(await sandbox.waitForViolation('connect-src', `${recorder.blocked}/patched`)).toBeTruthy();
    expect(recorder.paths('blocked')).toEqual([]);
});

test('positive control: the same fetch to an allowlisted origin succeeds and the listener sees it', async ({ sandbox }) => {
    await sandbox.mount({ connectionsAllowed: { 'connect-src': [recorder.allowed] } });

    const logs = await sandbox.runUntilDone(payload(recorder.allowed));

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(true);
    await recorder.waitFor('allowed', '/patched');
});
