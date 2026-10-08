import { test, expect, ORIGIN } from './fixture';

const IMAGE = `${ORIGIN}/playground/test-assets/local-image.svg`;
const CHECK_IMAGE = `
    const img = new Image();
    img.onload = () => console.log('IMAGE loaded');
    img.onerror = () => console.log('IMAGE blocked');
    img.src = '${IMAGE}';
`;

test('loads an image from an allowlisted origin', async ({ sandbox }) => {
    await sandbox.mount({ connectionsAllowed: { 'upgrade-insecure-requests': true, 'img-src': [ORIGIN] } as any });

    await sandbox.run(CHECK_IMAGE);

    expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE loaded');
});

test('blocks the same image when the origin is not allowlisted', async ({ sandbox }) => {
    await sandbox.mount();

    await sandbox.run(CHECK_IMAGE);

    expect(await sandbox.waitForLog('IMAGE')).toBe('IMAGE blocked');
});
