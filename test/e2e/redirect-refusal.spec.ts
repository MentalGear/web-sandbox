import { test, expect } from './fixture';
import { useRecorder } from './recorder';

/**
 * A redirect from a listed origin to an unlisted one (BD3:ISO-3, class E-net). The request gate checks the first URL of a
 * request (in-sandbox-script.ts) and leaves a redirect to the browser, whose policy applies to every hop: an open redirector
 * on a listed origin is common (`/redirect?to=`), and the property that it reaches nothing past the list rests on each engine
 * doing that for the worker's requests and for the view's loads. This is the redirect row of the gate's table: every maker
 * a guest has and every kind of load of the view.
 *
 * Evidence: the recorder's listeners outside the browser. The listed listener sees every first hop, the unlisted one sees
 * nothing, and a redirect to the listed origin itself is followed (the positive control: redirects do work here).
 */

const recorder = useRecorder();
const MODES = ['cooperative', 'worker', 'strict'] as const;

/** What a guest sees of each way to make a request that redirects to `blocked`. */
const REDIRECTED = (allowed: string, blocked: string) => `
    const to = (path) => '${allowed}/redirect?to=' + encodeURIComponent('${blocked}/' + path);
    const failed = (e) => 'threw ' + e.name;
    const xhr = (path) => new Promise((resolve) => {
        const x = new XMLHttpRequest();
        const seen = [];
        for (const type of ['load', 'error', 'abort']) x.addEventListener(type, () => seen.push(type + ':' + x.status));
        x.open('GET', to(path));
        x.send();
        setTimeout(() => resolve(seen), 400);
    });
    const sync = (path) => { const x = new XMLHttpRequest(); x.open('GET', to(path), false); try { x.send(); return 'returned ' + x.status; } catch (e) { return failed(e); } };
    return {
        fetch: await fetch(to('r-fetch')).then((r) => 'resolved ' + r.status, failed),
        noCors: await fetch(to('r-no-cors'), { mode: 'no-cors' }).then((r) => 'resolved ' + r.type, failed),
        manual: await fetch(to('r-manual'), { redirect: 'manual' }).then((r) => 'resolved ' + r.type, failed),
        xhr: await xhr('r-xhr'),
        xhrSync: sync('r-xhr-sync'),
    };
`;

test.describe('the worker\'s and the cooperative guest\'s requests', () => {
    for (const mode of MODES) {
        test(`${mode} mode: fetch (cors, no-cors, manual) and XMLHttpRequest (asynchronous, synchronous) redirected to an unlisted origin reach nothing there`, async ({ sandbox, browserName }) => {
            expect(await sandbox.mount({ mode, origins: { connect: [recorder.allowed] } })).toBe('ready');

            // positive control: a redirect to the listed origin is followed, so the silence on the other one is the policy's
            const control = await sandbox.inGuest(`return await fetch('${recorder.allowed}/redirect?to=' + encodeURIComponent('${recorder.allowed}/r-followed')).then((r) => r.status + ' ' + new URL(r.url).pathname, (e) => e.name)`);
            expect(control).toBe('200 /r-followed');
            await recorder.waitFor('allowed', '/r-followed');

            const seen = await sandbox.inGuest(REDIRECTED(recorder.allowed, recorder.blocked));
            // ledger: redirect-refusal-outcome
            const syncOutcome = browserName === 'firefox' && mode !== 'cooperative' ? 'returned 0' : 'threw NetworkError';
            expect(seen).toEqual({
                fetch: 'threw TypeError',
                noCors: 'threw TypeError',
                manual: 'resolved opaqueredirect',
                xhr: ['error:0'],
                xhrSync: syncOutcome,
            });
            // every first hop reached the listed origin (the gate admitted it), and nothing reached the other
            const hops = recorder.hits.filter(hit => hit.server === 'allowed' && hit.path.startsWith('/redirect?')).map(hit => decodeURIComponent(hit.path.slice('/redirect?to='.length)));
            for (const path of ['r-fetch', 'r-no-cors', 'r-manual', 'r-xhr', 'r-xhr-sync']) expect(hops, path).toContain(`${recorder.blocked}/${path}`);
            await sandbox.page.waitForTimeout(500);
            expect(recorder.paths('blocked')).toEqual([]);
        });
    }
});

test.describe('the strict view\'s loads', () => {
    test('an image, a CSS background and an image set named through a listed origin that redirects to an unlisted one reach nothing there; one that redirects to the listed origin loads', async ({ sandbox }) => {
        const redirect = (to: string) => `${recorder.allowed}/redirect?to=${encodeURIComponent(to)}`;
        await sandbox.registerFiles({
            'main.js': `sandboxView.render(${JSON.stringify(
                `<img src="${redirect(`${recorder.allowed}/v-followed.svg`)}">`
                + `<img src="${redirect(`${recorder.blocked}/v-img.svg`)}">`
                + `<img srcset="${redirect(`${recorder.blocked}/v-srcset.svg`)} 1x">`
                + `<p style="background: url(${redirect(`${recorder.blocked}/v-css.svg`)})">x</p>`
                + `<video poster="${redirect(`${recorder.blocked}/v-poster.svg`)}"></video>`,
            )});`,
        });
        expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', origins: { images: [recorder.allowed], media: [recorder.allowed] } })).toBe('ready');
        // the first hops are admitted and arrive; the positive control's second hop arrives too
        await recorder.waitFor('allowed', '/v-followed.svg');
        for (const name of ['v-img', 'v-srcset', 'v-css']) {
            await expect.poll(() => recorder.paths('allowed').some(path => decodeURIComponent(path).includes(`${recorder.blocked}/${name}.svg`)), { message: `${name}: the first hop reached the listed origin` }).toBe(true);
        }
        await sandbox.page.waitForTimeout(800);
        expect(recorder.paths('blocked')).toEqual([]);
    });
});
