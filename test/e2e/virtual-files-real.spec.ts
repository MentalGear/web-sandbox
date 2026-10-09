import { test, expect } from './fixture';

// Depends on the hub's service worker, which the dev server serves as untranspiled TypeScript
// (src/virtual-files/hub.html registers ./sw.ts). Tracked in docs/BACKLOG.md section C.
test.fixme('serves registered virtual files to the sandbox', async ({ sandbox, page }) => {
    await sandbox.mount({ virtualFilesUrl: 'http://virtual-files.localhost:4444' });

    await page.evaluate(() => {
        (document.querySelector('web-sandbox') as any).registerFiles({ 'hello.js': 'console.log("VFS Success")' });
    });
    await sandbox.run(`
        const script = document.createElement('script');
        script.src = 'hello.js';
        document.body.appendChild(script);
    `);

    expect(await sandbox.waitForLog('VFS Success')).toBeTruthy();
});
