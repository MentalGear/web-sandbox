import { test, expect, ORIGIN } from './fixture';
import { startSiblingApi } from './realistic-host-sibling';

test.use({ ignoreHTTPSErrors: true }); // the test listener's certificate is self-signed

// The listener's .svg answer (realistic-host-sibling.ts).
const IMAGE_PATH = '/api/local-image.svg';
const checkImage = (origin: string) => `
    const img = new Image();
    img.onload = () => console.log('IMAGE loaded');
    img.onerror = () => console.log('IMAGE blocked');
    img.src = '${origin}${IMAGE_PATH}';
`;

test('loads an image from an allowlisted origin', async ({ sandbox }) => {
    // Another site than the harness page (an IP address is its own site; the page's own site, `localhost`, is admitted in no
    // mode), on a listener of this test's own: 127.0.0.1 is served by nothing else, whichever address `localhost` resolves to.
    // https, as the library's policy upgrades no request and every engine loads it as listed.
    const listener = await startSiblingApi();
    try {
        await sandbox.mount({ origins: { images: [listener.crossSite] } });

        await sandbox.run(checkImage(listener.crossSite));

        expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE loaded');
        expect(listener.named('local-image.svg'), 'the image came from the allowlisted origin').toHaveLength(1);
    } finally {
        await listener.stop();
    }
});

test('blocks the same image when the origin is not allowlisted', async ({ sandbox }) => {
    await sandbox.mount();

    await sandbox.run(checkImage(ORIGIN));

    expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE blocked');
});
