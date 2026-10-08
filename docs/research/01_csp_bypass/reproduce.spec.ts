import { test, expect } from '../../../test/e2e/fixture';
import { PRESETS } from '@src/lib/presets';

test('CSP Bypass via Nested Iframe - Mitigated', async ({ sandbox, context }) => {
    // serve example.com locally so a request that is NOT blocked by CSP would succeed
    const reached: string[] = [];
    await context.route('https://example.com/**', route => { reached.push(route.request().url()); return route.fulfill({ body: 'ok' }); });
    await sandbox.mount();

    const logs = await sandbox.runUntilDone(PRESETS['csp-bypass'].code);

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
    expect(reached).toEqual([]);
});
