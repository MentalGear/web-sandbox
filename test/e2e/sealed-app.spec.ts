import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, ORIGIN } from './fixture';
import type { Page } from '@playwright/test';
import { clickInSandbox, inView, waitInView } from './strict-view';

/**
 * The app of docs/API.md#building-an-app-in-sealed-mode, run as the docs quote it: examples/sealed-app/ holds the bundle
 * (app.html, app.css, app.js and logo.png) and host.js, the embedder's side, and the docs' code blocks are generated
 * from those files (the `example:` regions; `bun run docs:check`). This spec mounts the bundle in the default mode
 * (no `mode`: sealed), through host.js as an embedder would, and holds what the section promises, on every engine:
 *   1. the bundle shows: the HTML, the registered stylesheet and the registered image, and the app's own image (drawn in
 *      the worker, written with guestWrites, shown by its path), all decoded in the view, and the host learns of nothing
 *      it did not ask for (no violation, no termination);
 *   2. host -> app: `call('load')` and a stream of `push(batch)` calls, each awaited, arrive in order and are all shown;
 *   3. user -> app -> host: typing and Enter, and a checkbox, reach the host's `save` as validated data, and the app's
 *      image follows its state (a new write the host can list);
 *   4. the stored state loads into the next mount (the host is the app's only storage);
 *   5. another app on the same element, after `unexpose()` and `unregisterFiles()`, reaches none of the first app's methods
 *      and files, and cannot tell a removed method from one that never existed.
 * Evidence is read outside the guest: the view's DOM (strict-view.ts), the host's store, `listGuestWrites()`.
 */

const EXAMPLE = path.resolve(import.meta.dirname, '../../examples/sealed-app');
// The bundle is served as the files are, by Playwright: the dev server would turn app.css into a script. host.js is the module the page imports.
const BUNDLE = '/saved-app';
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

/** Mounts the bundle through host.js over a store that starts as `saved`; the store is kept on the page as `window.store`. */
async function mountApp(page: Page, saved: object[] | null) {
    await page.route(`${ORIGIN}${BUNDLE}/*`, (route) => {
        const name = path.basename(new URL(route.request().url()).pathname);
        return route.fulfill({ body: readFileSync(path.join(EXAMPLE, name)), contentType: TYPES[path.extname(name)] });
    });
    await page.evaluate(async ({ bundle, saved }) => {
        const { mountTodoApp } = await import(/* @vite-ignore */ `${location.origin}/examples/sealed-app/host.js`);
        const data = new Map<string, string>(saved === null ? [] : [['todos', JSON.stringify(saved)]]);
        (window as any).store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
        await mountTodoApp(document.querySelector('web-sandbox'), { bundle, store: (window as any).store });
    }, { bundle: BUNDLE, saved });
}
const saved = (page: Page) => page.evaluate(() => JSON.parse((window as any).store.data.get('todos') ?? 'null'));
const writes = (page: Page) => page.evaluate(() => (document.querySelector('web-sandbox') as any).listGuestWrites().map((w: any) => ({ path: w.path, type: w.type, bytes: Array.from(w.content as Uint8Array).join(',') })));

/** The view's list as text, and the facts about its images. */
const LIST = `Array.from(document.querySelectorAll('#list li')).map(li => (li.querySelector('input').checked ? '[x] ' : '[ ] ') + li.querySelector('span').textContent)`;
const IMAGES = `Array.from(document.images).map(img => ({ src: img.getAttribute('src'), width: img.naturalWidth, height: img.naturalHeight }))`;

test.describe('the sealed app of the docs', () => {
    test('the bundle shows: HTML, the registered stylesheet and image, and the image the app drew and wrote', async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await mountApp(page, [{ text: 'milk', done: true }, { text: '<img src=x onerror=alert(1)>', done: false }]);
        await waitInView(page, browserName, `document.getElementById('badge').querySelector('img')?.naturalWidth === 60`);
        await waitInView(page, browserName, `document.getElementById('count').textContent === '1 open' && ${LIST}.join() === '[x] milk,[ ] <img src=x onerror=alert(1)>'`);
        expect(await inView(page, browserName, LIST)).toEqual(['[x] milk', '[ ] <img src=x onerror=alert(1)>']); // the text, not markup
        expect(await inView(page, browserName, `document.querySelectorAll('#list img').length`)).toBe(0);
        expect(await inView(page, browserName, `document.getElementById('count').textContent`)).toBe('1 open');
        await waitInView(page, browserName, `getComputedStyle(document.querySelector('h1')).color === 'rgb(34, 170, 119)'`); // app.css, registered
        const images = await inView<{ src: string; width: number; height: number }[]>(page, browserName, IMAGES);
        expect(images).toEqual([
            { src: expect.stringMatching(/^blob:/), width: 24, height: 24 }, // logo.png, a registered file
            { src: expect.stringMatching(/^blob:/), width: 60, height: 8 },  // progress.png, written by the app
        ]);
        expect(await writes(page)).toEqual([{ path: 'progress.png', type: 'image/png', bytes: expect.stringMatching(/^137,80,78,71,/) }]);
        expect(await page.evaluate(() => (document.querySelector('web-sandbox') as any).state)).toBe('ready');
        expect(await page.evaluate(() => (window as any).sandboxViolations)).toEqual([]);
        expect(await page.evaluate(() => (window as any).sandboxTerminations)).toEqual([]);
    });

    test('host -> app: a stream of push(batch) calls, each awaited, arrives in order and is all shown', async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await mountApp(page, null);
        await waitInView(page, browserName, `document.getElementById('count')?.textContent === '0 open'`);
        const calls = await page.evaluate(async () => {
            const { pushAll } = await import(/* @vite-ignore */ `${location.origin}/examples/sealed-app/host.js`);
            const sandbox = document.querySelector('web-sandbox') as any;
            const sent: number[] = [];
            const call = sandbox.call.bind(sandbox);
            sandbox.call = (method: string, batch: unknown[]) => (sent.push(batch.length), call(method, batch));
            await pushAll(sandbox, Array.from({ length: 120 }, (_, n) => ({ text: `item ${n}`, done: n % 4 === 0 })));
            delete sandbox.call;
            return sent;
        });
        expect(calls).toEqual([50, 50, 20]);
        await waitInView(page, browserName, `document.getElementById('count').textContent === '90 open' && document.querySelectorAll('#text-119').length === 1 && document.getElementById('text-119').textContent === 'item 119'`);
        const list = await inView<string[]>(page, browserName, LIST);
        expect(list).toHaveLength(120);
        expect(list[0]).toBe('[x] item 0');
        expect(list[119]).toBe('[ ] item 119');
        expect(await inView(page, browserName, `document.getElementById('count').textContent`)).toBe('90 open');
    });

    test('user -> app -> host: typing and a checkbox reach save() as validated data; the next mount loads it', async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await mountApp(page, [{ text: 'milk', done: false }]);
        await waitInView(page, browserName, `document.getElementById('badge').querySelector('img')?.naturalWidth === 60`);
        const before = (await writes(page))[0]!.bytes;

        const input = await waitInView<{ x: number; y: number }>(page, browserName, `(() => { const r = document.getElementById('new').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await clickInSandbox(page, input.x, input.y);
        await waitInView(page, browserName, `document.hasFocus() && document.activeElement.id === 'new'`);
        await page.keyboard.insertText('  eggs  ');
        await page.keyboard.press('Enter');
        await expect.poll(() => saved(page)).toEqual([{ text: 'milk', done: false }, { text: 'eggs', done: false }]);
        await waitInView(page, browserName, `document.getElementById('new').value === '' && document.getElementById('text-1')?.textContent === 'eggs'`); // trimmed, and the input cleared

        const box = await waitInView<{ x: number; y: number }>(page, browserName, `(() => { const r = document.getElementById('done-0').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await clickInSandbox(page, box.x, box.y);
        await expect.poll(() => saved(page)).toEqual([{ text: 'milk', done: true }, { text: 'eggs', done: false }]);
        await expect.poll(async () => (await writes(page))[0]!.bytes).not.toBe(before); // the image follows the state

        await mountApp(page, await saved(page)); // the next mount: the stored state
        // The new view's final state, polled: the old view already showed the same texts, and the app renders the list
        // before it fills each item's text, so a condition the old view met, read once, can catch the new one half-drawn.
        await expect.poll(() => inView(page, browserName, `[...${LIST}, document.getElementById('count').textContent]`)).toEqual(['[x] milk', '[ ] eggs', '1 open']);
    });

    // Methods and files belong to the element, not to the app (BD5:DOC-3): after unexpose() and unregisterFiles(), another
    // app on the same element reaches neither the first app's `save` nor its files, and what it is told about `save` is
    // exactly what an app on a new element, where `save` never existed, is told.
    test("another app on the same element, after unexpose() and unregisterFiles(): the first app's method and files are gone, as on a new element", async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await mountApp(page, [{ text: 'milk', done: false }]);
        await waitInView(page, browserName, `document.getElementById('text-0')?.textContent === 'milk'`);
        const probe = await page.evaluate(async () => {
            // app B: calls the first app's `save` and a name no one exposed, and reads the first app's stylesheet
            const appB = `(async () => {
                const out = {};
                for (const name of ['save', 'never-exposed']) {
                    try { out[name] = { resolved: await bridge.call(name, [{ text: 'by B', done: true }]) }; }
                    catch (e) { out[name] = { code: e.code, message: e.message }; }
                }
                try { out.file = await sandboxFiles.text('app.css'); } catch (e) { out.file = e.code; }
                await bridge.call('report', out);
            })();`;
            const run = (element: any) => new Promise(resolve => {
                element.expose('report', resolve);
                element.registerFiles({ 'b.js': appB });
                element.setConfig({ entry: 'b.js' });
            });
            const same = document.querySelector('web-sandbox') as any;
            same.unexpose();
            same.unregisterFiles();
            const onSame = await run(same);
            const fresh = document.createElement('web-sandbox') as any;
            fresh.id = 'fresh';
            document.body.appendChild(fresh);
            const onFresh = await run(fresh);
            return { onSame, onFresh, files: same.listFiles().map((file: { path: string }) => file.path) };
        });
        expect(probe.onSame).toEqual({
            save: { code: 'UNKNOWN_METHOD', message: 'unknown method: save' },
            'never-exposed': { code: 'UNKNOWN_METHOD', message: 'unknown method: never-exposed' },
            file: 'NOT_FOUND',
        });
        expect(probe.onSame).toEqual(probe.onFresh); // a removed method reads as one that never existed
        expect(probe.files).toEqual(['b.js']);
        expect(await saved(page)).toEqual([{ text: 'milk', done: false }]); // the first app's state, untouched
    });
});
