import type { Page } from '@playwright/test';
import { test, expect, type SandboxDriver } from './fixture';
import { inView, inViewWithGesture, waitInView } from './strict-view';
import { VIEW_FEATURES } from '@src/lib/sealed-reach';

/**
 * What the view's document is allowed by the permissions policy, and what a sealed guest reaches of it (BD7:ISO-3; class A:
 * INHERITED_CONTEXT.permissionsPolicy, SEALED_REACH's `permissionsPolicy` column). The frames delegate no feature (no
 * `allow` attribute), but a feature whose default allowlist is `*` is allowed in every frame unless the host page's own
 * policy forbids it: picture-in-picture is one, and a user could open a guest's `<video controls>` in an always-on-top window
 * outside the element's box. The renderer gives every video `disablepictureinpicture` and every video and audio
 * `disableremoteplayback` (RENDER_FORCED_ATTRIBUTES).
 *
 * Chromium only: Firefox and WebKit expose no list of allowed features, and neither offers picture-in-picture to a frame's
 * script without a user's gesture that a test cannot make (the forced attributes themselves are checked on every engine).
 */

/** A 1 s, 16×16 VP8 WebM: a video with a video track, which picture-in-picture needs. */
const CLIP = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAI9EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggIn7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECPQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYjXDwDz//loWZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAvrwgDgibCBELqBEJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYjXDwDz//loWWfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAB9DtnVAgueBAKOhgQAAgBACAJ0BKhAAEAAARwiFhYiFhIgCAgAMDmAA/mgAo5WBAMgAsQEAARAQABgAGFgv9AAIAACjlYEBkACxAQABEBAAGAAYWC/0AAgAAKOVgQJYALEBAAEQEAAYABhYL/QACAAAo5WBAyAAsQEAARAQABgAGFgv9AAIAAAcU7trkbuPs4EAt4r3gQHxggGf8IED';

const MARKUP = '<video id="v" controls src="clip.webm" preload="auto" disablepictureinpicture="" disableremoteplayback=""></video><video id="w" controls></video><audio id="a" controls></audio><p id="done">d</p>';

async function mountMedia(sandbox: SandboxDriver, page: Page, browserName: string) {
    // the guest writes no disablepictureinpicture of its own here (it could not keep one: the attribute is the renderer's)
    await sandbox.registerFiles({ 'clip.webm': { base64: CLIP, type: 'video/webm' }, 'main.js': `sandboxView.render(${JSON.stringify(MARKUP.replace(' disablepictureinpicture="" disableremoteplayback=""', ''))});` });
    expect(await sandbox.mount({ mode: 'sealed', entry: 'main.js' })).toBe('ready');
    await waitInView(page, browserName, "!!document.getElementById('done')", 10000);
}

test.describe("the view's permissions (BD7:ISO-3)", () => {
    test('every video and audio the renderer keeps has no picture-in-picture and no remote playback, whatever the guest wrote', async ({ sandbox, page, browserName }) => {
        await mountMedia(sandbox, page, browserName);
        const seen = await inView(page, browserName, `(() => {
            const of = (id) => { const e = document.getElementById(id); return [e.hasAttribute('disablepictureinpicture'), e.hasAttribute('disableremoteplayback'), e.getAttribute('crossorigin')]; };
            return { v: of('v'), w: of('w'), a: of('a') };
        })()`);
        expect(seen).toEqual({ v: [true, true, 'anonymous'], w: [true, true, 'anonymous'], a: [false, true, 'anonymous'] });
    });

    test("Chromium: every feature the view's document allows is classified in SEALED_REACH, and a guest's <video controls> cannot enter picture-in-picture", async ({ sandbox, page, browserName }) => {
        // ledger: view-allowed-features
        test.skip(browserName !== 'chromium', "only Chromium lists the allowed features (document.featurePolicy) and lets a test give picture-in-picture a user's gesture");
        await mountMedia(sandbox, page, browserName);
        const allowed = await inView<string[]>(page, browserName, 'document.featurePolicy.allowedFeatures()');
        expect(allowed, 'the view answered').not.toBe('no-context');
        expect([...(allowed as string[])].sort(), "a feature the view allows that SEALED_REACH's permissionsPolicy column does not classify").toEqual(Object.keys(VIEW_FEATURES).sort());
        expect(allowed).toContain('picture-in-picture');

        await waitInView(page, browserName, "document.getElementById('v').readyState >= 1", 10000);
        const request = "document.getElementById('v').requestPictureInPicture().then(() => 'entered', (e) => e.name)";
        expect(await inViewWithGesture(page, request), 'with the gesture of a user').toBe('InvalidStateError');
        expect(await inView(page, browserName, '!!document.pictureInPictureElement')).toBe(false);
        // positive control: the same video, gesture and frame without the attribute enter it
        await inView(page, browserName, "(document.getElementById('v').removeAttribute('disablepictureinpicture'), true)");
        expect(await inViewWithGesture(page, request), 'the control: without disablepictureinpicture').toBe('entered');
        expect(await inViewWithGesture(page, 'document.exitPictureInPicture().then(() => true)')).toBe(true);
    });
});
