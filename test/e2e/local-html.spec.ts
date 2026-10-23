import { test, expect, OFFSITE_ORIGIN, ORIGIN } from './fixture';

const IMAGE_PATH = '/playground/test-assets/local-image.svg';
const checkImage = (origin: string) => `
    const img = new Image();
    img.onload = () => console.log('IMAGE loaded');
    img.onerror = () => console.log('IMAGE blocked');
    img.src = '${origin}${IMAGE_PATH}';
`;

test('loads an image from an allowlisted origin', async ({ sandbox }) => {
    // plain http is an origin only for loopback, as here (ADR-007); no policy upgrades it, so every engine loads it as listed.
    // (The test server by its address: the harness page's own site, `localhost`, is admitted in no mode.)
    await sandbox.mount({ origins: { images: [OFFSITE_ORIGIN] } });

    await sandbox.run(checkImage(OFFSITE_ORIGIN));

    expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE loaded');
});

test('blocks the same image when the origin is not allowlisted', async ({ sandbox }) => {
    await sandbox.mount();

    await sandbox.run(checkImage(ORIGIN));

    expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE blocked');
});
