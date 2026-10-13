import { test, expect } from '../../../test/e2e/fixture';
import { useRecorder } from '../../../test/e2e/recorder';
import { fromPreset } from '../../../test/e2e/presets';

// Evidence (backlog T5): the nested frame's own outcome (PWN_FAILURE) and its own violation, which it relays
// (a frame the guest creates reports to itself, not to the host), plus a listener outside the browser that
// the fetch targets. The positive control runs the same payload against an allowlisted origin.
const recorder = useRecorder();
const preset = fromPreset('csp-bypass');
const payload = (target: string) => preset.aimedAt(`${target}/csp-bypass`);

test('CSP Bypass via Nested Iframe - Mitigated', async ({ sandbox }) => {
    await sandbox.mount(preset.rules);

    const logs = await sandbox.runUntilDone(payload(recorder.blocked));

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
    expect(logs).toContain(`NESTED_VIOLATION connect-src ${recorder.blocked}/csp-bypass`);
    expect(recorder.paths('blocked')).toEqual([]);
});

test('positive control: the same nested frame reaches an allowlisted origin, and the listener sees it', async ({ sandbox }) => {
    await sandbox.mount({ ...preset.rules, connectionsAllowed: { 'connect-src': [recorder.allowed] } });

    const logs = await sandbox.runUntilDone(payload(recorder.allowed));

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(true);
    expect(logs.filter(l => l.startsWith('NESTED_VIOLATION'))).toEqual([]);
    await recorder.waitFor('allowed', '/csp-bypass');
});
