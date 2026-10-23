import { test, expect } from '../../../test/e2e/fixture';
import { useRecorder, wss } from '../../../test/e2e/recorder';
import { fromPreset } from '../../../test/e2e/presets';

// Evidence (backlog T5): the socket's own outcome, the violation reported on the host (S5) and a listener
// outside the browser that answers WebSocket handshakes. The positive control opens the same socket to an
// allowlisted origin.
const recorder = useRecorder();
const preset = fromPreset('websocket-bypass');
const payload = (target: string) => preset.aimedAt(`${wss(target)}/ws`);

test('WebSocket Bypass - Mitigated', async ({ sandbox }) => {
    await sandbox.mount(preset.rules);

    const logs = await sandbox.runUntilDone(payload(recorder.blocked));

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
    expect(await sandbox.waitForViolation('connect-src', `${wss(recorder.blocked)}/ws`)).toBeTruthy();
    expect(recorder.hits.filter(h => h.server === 'blocked')).toEqual([]);
});

test('positive control: a WebSocket to an allowlisted origin opens and the listener sees the handshake', async ({ sandbox }) => {
    // (a wss:// entry is kept only beside its https:// twin: docs/API.md#origins)
    await sandbox.mount({ ...preset.rules, origins: { connect: [recorder.allowed, wss(recorder.allowed)] } });

    const logs = await sandbox.runUntilDone(payload(recorder.allowed));

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(true);
    expect(recorder.hits.filter(h => h.server === 'allowed' && h.websocket).map(h => h.path)).toEqual(['/ws']);
    expect(await sandbox.violations()).toEqual([]);
});
