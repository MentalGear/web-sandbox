import { test, expect } from './fixture';

test('executes code and relays console output to the host', async ({ sandbox }) => {
    expect(await sandbox.mount()).toBe('ready');

    await sandbox.run('console.log("Hello Lofi");');

    expect(await sandbox.waitForLog('Hello Lofi')).toContain('Hello Lofi');
});

test('renders loaded guest markup and runs its inline scripts', async ({ sandbox }) => {
    await sandbox.mount();

    expect(await sandbox.load('<p id="x">hi</p><script>document.getElementById("x").dataset.ran = "yes"</script>')).toBe('ready');

    // console is only relayed once the port arrives, so read the result through execute()
    await sandbox.run('console.log("guest says " + document.getElementById("x").textContent + " " + document.getElementById("x").dataset.ran)');
    await sandbox.waitForLog('guest says hi yes');
});

test('queues execute() calls made before the sandbox is ready', async ({ sandbox, page }) => {
    await page.evaluate(() => {
        const s = document.querySelector('lofi-sandbox') as any;
        s.setConfig({ capabilities: ['allow-scripts'], scriptUnsafe: true });
        s.execute('console.log("queued ran")');
    });

    await sandbox.waitForLog('queued ran');
});
