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
 *   5. another app on the same element (which the recipe no longer does), after `unexpose()` and `unregisterFiles()`, reaches none of the first app's methods
 *      and files, and cannot tell a removed method from one that never existed;
 *   6. a second, hostile bundle mounted through the same host.js after stop() is handed none of the first app's state or
 *      files, and its save leaves the first app's key alone (the state is keyed by the embedder's app id);
 *   7. the app stops adding at the host's limit, and a save the host refuses is shown, not lost silently;
 *   8. an element is one app's for its life (BD6:LIM-2, BD6:CHL-3): every mount makes an element of its own, and stop()
 *      removes it. The first app's commit of its guest writes after stop(), a late call of one of its host methods, a
 *      second mount that overlaps a slow first one, and a mount whose load failed each hand the next app none of its
 *      data, and nothing of the first app runs after stop() or after the failure.
 * Evidence is read outside the guest: the view's DOM (strict-view.ts), the host's store, `listGuestWrites()`.
 */

const EXAMPLE = path.resolve(import.meta.dirname, '../../examples/sealed-app');
// The bundle is served as the files are, by Playwright: the dev server would turn app.css into a script. host.js is the module the page imports.
const BUNDLE = '/saved-app';
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

/**
 * Mounts the bundle through host.js into the container `#apps` over a store that starts as `saved`; the store is kept on
 * the page as `window.store`, and the mounted app (`{ sandbox, stop }`) as `window.app`. An app that is still running is
 * stopped first, as an embedder switching apps does: each mount makes its own element. The harness's own element is
 * removed, so the page holds the apps' elements only.
 */
async function mountApp(page: Page, saved: object[] | null) {
    await routeBundle(page);
    await page.evaluate(async ({ bundle, saved }) => {
        const { mountTodoApp } = await import(/* @vite-ignore */ `${location.origin}/examples/sealed-app/host.js`);
        const data = new Map<string, string>(saved === null ? [] : [['todos:todo-app', JSON.stringify(saved)]]);
        (window as any).store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
        (window as any).app?.stop();
        const container = document.getElementById('apps') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'apps' }));
        for (const element of document.querySelectorAll('web-sandbox')) if (!container.contains(element)) element.remove();
        (window as any).app = await mountTodoApp(container, { bundle, appId: 'todo-app', store: (window as any).store });
    }, { bundle: BUNDLE, saved });
}
/** Serves the bundle as the files are (the dev server would turn app.css into a script). */
async function routeBundle(page: Page) {
    await page.route(`${ORIGIN}${BUNDLE}/*`, (route) => {
        const name = path.basename(new URL(route.request().url()).pathname);
        return route.fulfill({ body: readFileSync(path.join(EXAMPLE, name)), contentType: TYPES[path.extname(name)] });
    });
}
/** Serves a bundle at `/<name>` that is the example's with its `app.js` replaced by `appJs`. */
async function routeBundleWith(page: Page, name: string, appJs: string) {
    await page.route(`${ORIGIN}/${name}/*`, (route) => {
        const file = path.basename(new URL(route.request().url()).pathname);
        return route.fulfill(file === 'app.js' ? { body: appJs, contentType: 'text/javascript' } : { body: readFileSync(path.join(EXAMPLE, file)), contentType: TYPES[path.extname(file)] });
    });
}
const saved = (page: Page) => page.evaluate(() => JSON.parse((window as any).store.data.get('todos:todo-app') ?? 'null'));
const writes = (page: Page) => page.evaluate(() => (window as any).app.sandbox.listGuestWrites().map((w: any) => ({ path: w.path, type: w.type, bytes: Array.from(w.content as Uint8Array).join(',') })));

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
        expect(await page.evaluate(() => ((window as any).app.sandbox).state)).toBe('ready');
        expect(await page.evaluate(() => (window as any).sandboxViolations)).toEqual([]);
        expect(await page.evaluate(() => (window as any).sandboxTerminations)).toEqual([]);
    });

    test('host -> app: a stream of push(batch) calls, each awaited, arrives in order and is all shown', async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await mountApp(page, null);
        await waitInView(page, browserName, `document.getElementById('count')?.textContent === '0 open'`);
        const calls = await page.evaluate(async () => {
            const { pushAll } = await import(/* @vite-ignore */ `${location.origin}/examples/sealed-app/host.js`);
            const sandbox = (window as any).app.sandbox as any;
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
            const same = (window as any).app.sandbox as any;
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

    // The state is the embedder's, kept per app (BD5:CHL-1): the key carries the app's id, and stop() clears the element.
    test("a second, hostile bundle mounted through the same host.js after stop() gets none of the first app's state or files, and its save leaves the first app's key alone", async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await mountApp(page, [{ text: 'call bank, PIN 4711', done: false }]);
        await waitInView(page, browserName, `document.getElementById('text-0')?.textContent === 'call bank, PIN 4711'`);
        // B reports what it was handed through its own `save`, the only way out the recipe gives it
        const hostile = `(async () => {
            bridge.expose('load', async (saved) => {
                const out = { state: saved, files: sandboxFiles.list() };
                try { out.stateJson = await sandboxFiles.text('state.json'); } catch (e) { out.stateJson = e.code; }
                await bridge.call('save', [{ text: JSON.stringify(out), done: true }]);
            });
        })();`;
        await routeBundleWith(page, 'bundle-b', hostile);
        const first = await page.evaluate(async ({ bundle }) => {
            const { mountTodoApp } = await import(/* @vite-ignore */ `${location.origin}/examples/sealed-app/host.js`);
            const app = (window as any).app;
            app.sandbox.registerFiles({ 'state.json': '{"secret":"first app"}' }); // what the first app committed
            app.stop();
            (window as any).app = await mountTodoApp(document.getElementById('apps'), { bundle, appId: 'bundle-b', store: (window as any).store });
            return { distinct: (window as any).app.sandbox !== app.sandbox, firstConnected: app.sandbox.isConnected };
        }, { bundle: '/bundle-b' });
        expect(first).toEqual({ distinct: true, firstConnected: false });
        await expect.poll(() => page.evaluate(() => (window as any).store.data.has('todos:bundle-b'))).toBe(true);
        const keys = await page.evaluate(() => Object.fromEntries((window as any).store.data));
        expect(JSON.parse(JSON.parse(keys['todos:bundle-b'])[0].text)).toEqual({ state: [], files: ['app.css', 'app.js', 'logo.png'], stateJson: 'NOT_FOUND' }); // none of the first app's state or files
        expect(keys['todos:todo-app']).toBe(JSON.stringify([{ text: 'call bank, PIN 4711', done: false }])); // the first app's key, untouched
        expect(Object.keys(keys).sort()).toEqual(['todos:bundle-b', 'todos:todo-app']);
    });

    // An element is one app's for its life (BD6:LIM-2, BD6:CHL-3): its files, its methods, its pending guest writes and every
    // handle a host method holds outlive an app that was stopped, so the recipe gives each mount an element of its own. Each
    // row below is a way the first app (A) could reach the next one (B) on a shared element; B is a recorder that reports
    // what it was handed through its own `save`, and A's data carries the marker A-PRIVATE.
    const RECORDER = `const seen = { loads: [], pushes: [] };
        const report = () => bridge.call('save', [{ text: JSON.stringify({ ...seen, files: sandboxFiles.list() }), done: true }]);
        bridge.expose('load', (saved) => { seen.loads.push(saved); return report(); });
        bridge.expose('push', (batch) => { seen.pushes.push(batch); return report(); });`;
    /** What B's recorder reported last, from the embedder's store. */
    const recorded = (page: Page) => page.evaluate(() => {
        const stored = (window as any).store.data.get('todos:bundle-b');
        return stored === undefined ? null : JSON.parse(JSON.parse(stored)[0].text);
    });
    const NOTHING_OF_B = { loads: [[]], pushes: [] as unknown[], files: ['app.css', 'app.js', 'logo.png'] }; // B's own, and no progress.png of A's

    test("a commit of the first app's guest writes after stop() lands on the first app's element only: the next app has none of its files", async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await mountApp(page, [{ text: 'A-PRIVATE', done: false }]);
        await waitInView(page, browserName, `document.getElementById('badge').querySelector('img')?.naturalWidth === 60`); // A's progress.png is pending
        await routeBundleWith(page, 'bundle-b', RECORDER);
        const probe = await page.evaluate(async ({ bundle }) => {
            const { mountTodoApp } = await import(/* @vite-ignore */ `${location.origin}/examples/sealed-app/host.js`);
            const a = (window as any).app;
            const pending = a.sandbox.listGuestWrites().map((w: any) => w.path);
            a.stop();
            a.sandbox.commitGuestWrites(pending); // the embedder's commit, after stop()
            const b = await mountTodoApp(document.getElementById('apps'), { bundle, appId: 'bundle-b', store: (window as any).store });
            (window as any).app = b;
            return { pending, aConnected: a.sandbox.isConnected, aState: a.sandbox.state, distinct: a.sandbox !== b.sandbox };
        }, { bundle: '/bundle-b' });
        await expect.poll(() => recorded(page)).toEqual(NOTHING_OF_B);
        expect(probe).toEqual({ pending: ['progress.png'], aConnected: false, aState: expect.stringMatching(/^(idle|terminated)$/), distinct: true });
    });

    test("a host method of the first app that calls the sandbox after stop() reaches nothing: the next app is sent none of its data", async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await routeBundleWith(page, 'bundle-a', `bridge.expose('load', () => {}); bridge.expose('start', () => { bridge.call('late'); });`);
        await routeBundleWith(page, 'bundle-b', RECORDER);
        const outcome = await page.evaluate(async () => {
            const { mountTodoApp } = await import(/* @vite-ignore */ `${location.origin}/examples/sealed-app/host.js`);
            const container = document.getElementById('apps') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'apps' }));
            const store = { data: new Map<string, string>(), getItem(key: string) { return this.data.get(key) ?? null; }, setItem(key: string, value: string) { this.data.set(key, value); } };
            (window as any).store = store;
            const a = await mountTodoApp(container, { bundle: '/bundle-a', appId: 'a', store });
            // a method the embedder added to the app: it waits, then calls the app with the app's private data
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const lateOutcome = new Promise<string>((resolve) => a.sandbox.expose('late', async () => {
                await gate;
                resolve(await a.sandbox.call('push', [{ text: 'A-PRIVATE', done: false }]).then(() => 'delivered', (e: any) => `refused: ${e?.code}`));
            }));
            await a.sandbox.call('start'); // the app calls `late`, which is now running and waiting
            a.stop();
            const b = await mountTodoApp(container, { bundle: '/bundle-b', appId: 'bundle-b', store });
            (window as any).app = b;
            release();
            const late = await lateOutcome;
            await b.sandbox.call('push', [{ text: 'B-OWN', done: false }]); // after the late call: B's report holds whatever reached it
            return { late, aConnected: a.sandbox.isConnected, distinct: a.sandbox !== b.sandbox };
        });
        await expect.poll(() => recorded(page)).toEqual({ ...NOTHING_OF_B, pushes: [[{ text: 'B-OWN', done: false }]] });
        expect(outcome).toEqual({ late: expect.stringMatching(/^refused: /), aConnected: false, distinct: true });
    });

    test("two mounts that overlap, the first waiting for a slow store, each have an element of their own: the second is sent none of the first's data", async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await routeBundleWith(page, 'bundle-b', RECORDER);
        await routeBundle(page);
        const result = await page.evaluate(async ({ bundle }) => {
            const { mountTodoApp } = await import(/* @vite-ignore */ `${location.origin}/examples/sealed-app/host.js`);
            const container = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'apps' }));
            for (const element of document.querySelectorAll('web-sandbox')) if (!container.contains(element)) element.remove();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const data = new Map<string, string>([['todos:a', JSON.stringify([{ text: 'A-PRIVATE', done: false }])]]);
            const store = {
                data,
                getItem: async (key: string) => { if (key === 'todos:a') await gate; return data.get(key) ?? null; }, // A's read is slow
                setItem: (key: string, value: string) => void data.set(key, value),
            };
            (window as any).store = store;
            const first = mountTodoApp(container, { bundle: '/saved-app', appId: 'a', store });
            const b = await mountTodoApp(container, { bundle, appId: 'bundle-b', store }); // while the first is still waiting
            (window as any).app = b;
            release();
            const a = await first;
            (window as any).first = a;
            return { elements: container.querySelectorAll('web-sandbox').length, distinct: a.sandbox !== b.sandbox, aState: a.sandbox.state };
        }, { bundle: '/bundle-b' });
        // the first app's data reached its own element: its load ran there, and the app drew its image
        await expect.poll(() => recorded(page)).toEqual(NOTHING_OF_B);
        await expect.poll(() => page.evaluate(() => (window as any).first.sandbox.listGuestWrites().map((w: any) => w.path))).toEqual(['progress.png']);
        expect(result).toEqual({ elements: 2, distinct: true, aState: 'ready' });
    });

    test("a mount whose load fails leaves nothing running: no element, the app's methods unreachable, and the next app is not written to", async ({ sandbox, page, browserName }) => {
        void sandbox; // the fixture opens the harness page
        await routeBundleWith(page, 'bundle-a', `bridge.expose('load', () => { throw new Error('load failed'); });
            bridge.expose('go', () => bridge.call('save', [{ text: 'written by A', done: false }]));`);
        await routeBundleWith(page, 'bundle-b', RECORDER);
        const result = await page.evaluate(async () => {
            const { mountTodoApp } = await import(/* @vite-ignore */ `${location.origin}/examples/sealed-app/host.js`);
            const container = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'apps' }));
            for (const element of document.querySelectorAll('web-sandbox')) if (!container.contains(element)) element.remove();
            const store = { data: new Map<string, string>(), getItem(key: string) { return this.data.get(key) ?? null; }, setItem(key: string, value: string) { this.data.set(key, value); } };
            (window as any).store = store;
            const added: any[] = [];
            new MutationObserver((records) => { for (const record of records) added.push(...record.addedNodes); }).observe(container, { childList: true });
            let failure = '';
            try { await mountTodoApp(container, { bundle: '/bundle-a', appId: 'a', store }); } catch (error: any) { failure = String(error?.message); }
            const elementsAfterFailure = container.querySelectorAll('web-sandbox').length;
            // the element the failed mount made: what its app could still do
            const go = await added[0].call('go').then(() => 'delivered', (e: any) => `refused: ${e?.code}`);
            const storedAfterGo = [...store.data.keys()];
            (window as any).app = await mountTodoApp(container, { bundle: '/bundle-b', appId: 'bundle-b', store });
            const goAfterB = await added[0].call('go').then(() => 'delivered', (e: any) => `refused: ${e?.code}`);
            return { failure, elementsAfterFailure, go, storedAfterGo, goAfterB, keys: [...store.data.keys()] };
        });
        expect(result.failure).toContain('load failed');
        await expect.poll(() => recorded(page)).toEqual(NOTHING_OF_B);
        expect(result).toEqual({ failure: result.failure, elementsAfterFailure: 0, go: expect.stringMatching(/^refused: /), storedAfterGo: [], goAfterB: expect.stringMatching(/^refused: /), keys: ['todos:bundle-b'] });
    });

    test('the app stops adding at the host\'s limit, and a save the host refuses is shown in the view', async ({ sandbox, page, browserName }) => {
        test.setTimeout(240000);
        void sandbox; // the fixture opens the harness page
        await mountApp(page, Array.from({ length: 1000 }, (_, n) => ({ text: `t${n}`, done: false })));
        await waitInView(page, browserName, `document.getElementById('count')?.textContent === '1000 open'`, 90000);
        const input = await waitInView<{ x: number; y: number }>(page, browserName, `(() => { const r = document.getElementById('new').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await clickInSandbox(page, input.x, input.y);
        await waitInView(page, browserName, `document.hasFocus() && document.activeElement.id === 'new'`);
        await page.keyboard.insertText('one too many');
        await page.keyboard.press('Enter');
        await waitInView(page, browserName, `document.getElementById('count').textContent === 'the list is full (1000 todos)'`, 30000);
        expect(await saved(page)).toHaveLength(1000); // nothing was added, nothing lost
        // a push past the limit puts 1001 in the app; the next save is refused by the host, and the app says so
        await page.evaluate(() => ((window as any).app.sandbox as any).call('push', [{ text: 'over', done: false }]));
        await waitInView(page, browserName, `document.getElementById('count').textContent === '1001 open' && !!document.getElementById('done-0')`, 90000);
        const box = await waitInView<{ x: number; y: number }>(page, browserName, `(() => { const r = document.getElementById('done-0').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await clickInSandbox(page, box.x, box.y);
        await waitInView(page, browserName, `document.getElementById('count').textContent.startsWith('not saved: save: expected at most 1000 todos')`, 90000);
        expect(await saved(page)).toHaveLength(1000);
        expect(await page.evaluate(() => (window as any).sandboxTerminations)).toEqual([]);
    });
});
