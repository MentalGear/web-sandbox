import { test, expect } from '../../../test/e2e/fixture';
import { PRESETS } from '@src/lib/presets';

// The server-side session store this finding targeted no longer exists (srcdoc architecture).
// What remains to verify: the sandbox cannot reach the host's server at all.
test('Session ID Exhaustion / DoS - Not Reachable', async ({ sandbox, page }) => {
    const reached: string[] = [];
    page.on('request', r => { if (r.url().includes('/api/session')) reached.push(r.url()); });
    await sandbox.mount();

    const logs = await sandbox.runUntilDone(PRESETS['session-exhaustion'].code);

    expect(logs.some(l => l.startsWith('ERROR'))).toBe(true);
    expect(reached).toEqual([]);
});
