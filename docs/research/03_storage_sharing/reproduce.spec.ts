import { test, expect } from '../../../test/e2e/fixture';

test('Storage Sharing Between Instances - Mitigated', async ({ sandbox }) => {
    // 1. Write
    await sandbox.mount();
    await sandbox.runUntilDone(`
        try { localStorage.setItem('SECRET', '123'); console.log('Write Done'); }
        catch (e) { console.log('Write Failed'); }
        console.log('TEST_DONE');
    `);

    // 2. Reload the host page and start a fresh sandbox
    await sandbox.open();
    await sandbox.mount();

    // 3. Read
    const logs = await sandbox.runUntilDone(`
        try { console.log('Read: ' + localStorage.getItem('SECRET')); }
        catch (e) { console.log('Read Failed'); }
        console.log('TEST_DONE');
    `);

    // Either storage is unavailable (opaque origin) or it is fresh — never the secret from step 1.
    const readLog = logs.find(l => l.startsWith('Read'));
    expect(readLog).toBeDefined();
    expect(readLog).not.toContain('123');
});
