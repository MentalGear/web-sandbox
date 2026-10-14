import { test, expect } from '../../../test/e2e/fixture';
import { useRecorder } from '../../../test/e2e/recorder';
import { fromPreset } from '../../../test/e2e/presets';

// The server-side session store this finding targeted no longer exists (srcdoc architecture).
// What remains to verify: the sandbox cannot reach a server at all.
// Evidence (backlog T5): the guest's own outcome, the violation for the absolute form, and a listener
// outside the browser. The positive control runs the absolute form against an allowlisted origin.
const recorder = useRecorder();
const preset = fromPreset('session-exhaustion');
const absolute = (origin: string) => preset.aimedAt(`${origin}/api/session`);

test('Session ID Exhaustion / DoS - Not Reachable', async ({ sandbox }) => {
    await sandbox.mount(preset.rules);

    // As written, the URL is relative: it cannot even be resolved against the guest's about:blank base
    // (S15), so the first fetch throws before any request exists, and there is nothing to report.
    const relative = await sandbox.runUntilDone(preset.code);
    expect(relative.find(l => l.startsWith('ERROR'))).toBeDefined();
    expect(relative.some(l => l.startsWith('PWN_INFO'))).toBe(false);

    // Absolute: refused by the policy, and reported.
    await sandbox.clearLogs();
    const logs = await sandbox.runUntilDone(absolute(recorder.blocked));
    expect(logs.find(l => l.startsWith('ERROR'))).toBeDefined();
    expect(await sandbox.waitForViolation('connect-src', `${recorder.blocked}/api/session`)).toBeTruthy();
    expect(recorder.paths('blocked')).toEqual([]);
});

test('positive control: the absolute form reaches an allowlisted origin, and the listener sees it', async ({ sandbox }) => {
    await sandbox.mount({ ...preset.rules, origins: { connect: [recorder.allowed] } });
    // the preset posts in a loop for 5 s; the first request arriving is enough
    await sandbox.run(absolute(recorder.allowed));
    await recorder.waitFor('allowed', '/api/session');
    // a JSON POST from an opaque origin is preceded by a CORS preflight: either one arriving is the request leaving
    expect(['OPTIONS', 'POST']).toContain(recorder.hits.find(h => h.server === 'allowed')?.method);
});
