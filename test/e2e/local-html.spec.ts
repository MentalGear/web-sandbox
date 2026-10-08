import { test, expect, ORIGIN } from './fixture';

const IMAGE = `${ORIGIN}/playground/test-assets/local-image.svg`;
const CHECK_IMAGE = `
    const img = new Image();
    img.onload = () => console.log('IMAGE loaded');
    img.onerror = () => console.log('IMAGE blocked');
    img.src = '${IMAGE}';
`;

test('loads an image from an allowlisted origin', async ({ sandbox, browserName }) => {
    // The sandbox always sets upgrade-insecure-requests, and WebKit applies it to http://localhost as well,
    // so the plain-http test server cannot be allowlisted there. (Routing an https origin instead races
    // with Chromium's out-of-process sandbox frame.)
    test.skip(browserName === 'webkit', 'WebKit upgrades http://localhost under upgrade-insecure-requests');
    await sandbox.mount({ connectionsAllowed: { 'upgrade-insecure-requests': true, 'img-src': [ORIGIN] } as any });

    await sandbox.run(CHECK_IMAGE);

    expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE loaded');
});

test('blocks the same image when the origin is not allowlisted', async ({ sandbox }) => {
    await sandbox.mount();

    await sandbox.run(CHECK_IMAGE);

    expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE blocked');
});
