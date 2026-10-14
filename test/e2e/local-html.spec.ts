import { test, expect, ORIGIN } from './fixture';

const IMAGE_PATH = '/playground/test-assets/local-image.svg';
const checkImage = (origin: string) => `
    const img = new Image();
    img.onload = () => console.log('IMAGE loaded');
    img.onerror = () => console.log('IMAGE blocked');
    img.src = '${origin}${IMAGE_PATH}';
`;

// An https origin that only the WebKit run uses; Playwright answers it with the test server's file.
const HTTPS_ORIGIN = 'https://assets.web-sandbox.test';

test('loads an image from an allowlisted origin', async ({ sandbox, page, browserName }) => {
    // The sandbox always sets upgrade-insecure-requests, and WebKit applies it to http://localhost as well,
    // so on WebKit the image is allowlisted and served from an https origin instead. Chromium and Firefox
    // keep the plain-http test server: routing an https origin races with Chromium's out-of-process
    // sandbox frame.
    const origin = browserName === 'webkit' ? HTTPS_ORIGIN : ORIGIN;
    let served = 0;
    if (origin === HTTPS_ORIGIN) {
        await page.route(`${HTTPS_ORIGIN}/**`, async route => {
            served++;
            const response = await route.fetch({ url: `${ORIGIN}${new URL(route.request().url()).pathname}` });
            await route.fulfill({ response });
        });
    }
    await sandbox.mount({ origins: { images: [origin] } }); // plain http is an origin only for loopback, as here (ADR-007)

    await sandbox.run(checkImage(origin));

    expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE loaded');
    if (origin === HTTPS_ORIGIN) expect(served).toBe(1); // the image really came from the allowlisted https origin
});

test('blocks the same image when the origin is not allowlisted', async ({ sandbox }) => {
    await sandbox.mount();

    await sandbox.run(checkImage(ORIGIN));

    expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE blocked');
});
