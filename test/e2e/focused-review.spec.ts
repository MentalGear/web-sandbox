import { test, expect, type SandboxDriver } from './fixture';
import { useRecorder } from './recorder';
import { chromiumViewLinkUrls, inView, waitInView } from './strict-view';
import { INERT_HREF } from '@src/lib/in-sandbox-view';
import type { SandboxConfig } from '@src/host';

/**
 * Focused review 2026-10-14 (docs/security/FOCUSED-REVIEW-2026-10-14.md), where browser behaviour decides:
 *   W1  a guest-written file committed with an inert type (no { code: true }) is never loaded as a script by the
 *       next build's markup: resolution admits a file only for the kind of load its type is for, in every engine,
 *       whatever the engine does with a mistyped classic blob: script;
 *   F1  strict view: no attribute the renderer checked can change after it ran: SMIL animation elements are removed,
 *       so a link's animVal (and Chromium's accessibility URL) stays the inert constant and an animated <image href>
 *       loads nothing;
 *   F2  workerExecutionTimeout cannot be evaded by scheduling the loop or by replacing Function.
 * Evidence (T5): read from outside the sandbox — a host method the guest's scripts call, recorded on the host page,
 * the recorder's listener — with a positive control beside each negative.
 */

const recorder = useRecorder();

// Records calls of the host method 'mark' on the host page, outside the sandbox.
async function exposeMark(sandbox: SandboxDriver) {
    await sandbox.page.evaluate(() => { (window as any).marks = []; });
    await sandbox.exposeHost('mark', '(name) => { window.marks.push(String(name)); return true; }');
}
const marks = (sandbox: SandboxDriver) => sandbox.page.evaluate(() => [...(window as any).marks] as string[]);

const commit = (sandbox: SandboxDriver, paths: string[], options?: unknown) => sandbox.page.evaluate(({ paths, options }) => {
    try {
        (document.querySelector('web-sandbox') as any).commitGuestWrites(paths, options);
        return 'ok';
    } catch (e: any) {
        return String(e?.code);
    }
}, { paths, options });

// What a script does when it runs: a host mark and an image load to the recorder, both read outside the sandbox.
const SCRIPT = (name: string, allowed: string) => `bridge.call('mark', ${JSON.stringify(name)}); new Image().src = ${JSON.stringify(`${allowed}/w1-${name}.svg`)};`;

test.describe('W1: a committed inert file is never a script of the next build', () => {
    for (const writer of ['iframe', 'worker', 'strict'] as const) {
        test(`written in ${writer} mode: app.js committed as text/plain gets no script slot and never runs in the next build's <script src>; ok.js committed as JavaScript with { code: true } runs (positive control)`, async ({ sandbox }) => {
            await exposeMark(sandbox);
            expect(await sandbox.mount({ mode: writer, guestWrites: true })).toBe('ready');
            expect(await sandbox.inGuest(`
                await sandboxFiles.write('app.js', { content: ${JSON.stringify(SCRIPT('app', recorder.allowed))}, type: 'text/plain' });
                await sandboxFiles.write('ok.js', { content: ${JSON.stringify(SCRIPT('ok', recorder.allowed))}, type: 'text/javascript' });
                return sandboxFiles.list();`)).toEqual(['app.js', 'ok.js']);
            expect(await commit(sandbox, ['app.js'])).toBe('ok'); // inert: no { code: true } needed
            expect(await commit(sandbox, ['ok.js'])).toBe('FILES_NOT_ALLOWED'); // code needs the second opt-in
            expect(await commit(sandbox, ['ok.js'], { code: true })).toBe('ok');

            // The next build, in iframe mode with host markup naming both. Classic scripts run in order, so once the
            // inline script after them has reported, app.js would have run before ok.js if it ran at all.
            const config: Partial<SandboxConfig> = {
                mode: 'iframe',
                html: '<script src="app.js"></script><script src="ok.js"></script><script>bridge.call("mark", "after")</script>',
                connectionsAllowed: { 'img-src': [recorder.allowed] },
            };
            expect(await sandbox.mount(config)).toBe('ready');
            await expect.poll(() => marks(sandbox), { timeout: 8000 }).toContain('after');
            await recorder.waitFor('allowed', '/w1-ok.svg');
            await sandbox.page.waitForTimeout(300);
            expect(await marks(sandbox)).toEqual(['ok', 'after']);
            expect(recorder.paths('allowed').filter(p => p.startsWith('/w1-'))).toEqual(['/w1-ok.svg']);
            // the reason is visible: the element said why the reference was left as written
            expect(await sandbox.inGuest(`return [...document.scripts].map(s => s.getAttribute('src')).filter(Boolean).map(src => src.startsWith('blob:') ? 'blob:' : src)`)).toEqual(['app.js', 'blob:']);
        });
    }

    test('strict mode: an entry committed as text/plain is not a JavaScript file and does not start; the same content committed as JavaScript starts (positive control)', async ({ sandbox }) => {
        await exposeMark(sandbox);
        expect(await sandbox.mount({ mode: 'strict', guestWrites: true })).toBe('ready');
        await sandbox.inGuest(`
            await sandboxFiles.write('app.js', { content: "bridge.call('mark', 'app')", type: 'text/plain' });
            await sandboxFiles.write('ok.js', { content: "bridge.call('mark', 'ok')", type: 'text/javascript' });
            return true;`);
        expect(await commit(sandbox, ['app.js'])).toBe('ok');
        expect(await commit(sandbox, ['ok.js'], { code: true })).toBe('ok');
        const reason = await sandbox.page.evaluate(() => new Promise(resolve => {
            const s = document.querySelector('web-sandbox') as any;
            s.addEventListener('terminated', (e: CustomEvent) => resolve(e.detail.reason), { once: true });
            s.setConfig({ mode: 'strict', entry: 'app.js' });
        }));
        expect(reason).toBe('the guest entry "app.js" is not a registered JavaScript file');
        expect(await sandbox.mount({ mode: 'strict', entry: 'ok.js' })).toBe('ready');
        await expect.poll(() => marks(sandbox), { timeout: 8000 }).toEqual(['ok']);
    });

    test('host-registered files obey the same table: x.js registered as text/plain is no script, a stylesheet link never applies a text file; JavaScript and CSS do (positive controls)', async ({ sandbox }) => {
        await exposeMark(sandbox);
        await sandbox.registerFiles({
            'x.js': { base64: Buffer.from("bridge.call('mark', 'x')").toString('base64'), type: 'text/plain' },
            'y.js': "bridge.call('mark', 'y')",
            'look.txt': { base64: Buffer.from('#probe { width: 77px }').toString('base64'), type: 'text/plain' },
            'look.css': '#probe2 { width: 55px }',
        });
        expect(await sandbox.mount({
            html: '<link rel="stylesheet" href="look.txt"><link rel="stylesheet" href="look.css"><i id="probe" style="display:block"></i><i id="probe2" style="display:block"></i><script src="x.js"></script><script src="y.js"></script><script>bridge.call("mark", "after")</script>',
        })).toBe('ready');
        await expect.poll(() => marks(sandbox), { timeout: 8000 }).toContain('after');
        expect(await marks(sandbox)).toEqual(['y', 'after']);
        expect(await sandbox.inGuest(`return [getComputedStyle(document.getElementById('probe')).width, getComputedStyle(document.getElementById('probe2')).width]`)).not.toContain('77px');
        expect(await sandbox.inGuest(`return getComputedStyle(document.getElementById('probe2')).width`)).toBe('55px');
    });

    // The limit this table does not cover, measured: code that asks for a file's URL itself and loads it as a
    // script. That is the running code's choice (the host's code in the next environment), not a reference the
    // library resolves; documented in API.md and ADR-004. Asserted per engine, so a change in an engine shows.
    test('limit (measured): a classic script element or importScripts() of sandboxFiles.url() for a text/plain file', async ({ sandbox, browserName }) => {
        await sandbox.registerFiles({
            'p.js': { base64: Buffer.from('globalThis.__p = (globalThis.__p || 0) + 1').toString('base64'), type: 'text/plain' },
            'real.js': 'void 0', // one JavaScript file: blob: is in script-src
        });
        expect(await sandbox.mount({ mode: 'worker' })).toBe('ready');
        const worker = await sandbox.inGuest(`try { importScripts(sandboxFiles.url('p.js')); } catch (e) { return e.name; } return globalThis.__p === 1 ? 'ran' : 'did not run';`);
        expect(await sandbox.mount()).toBe('ready');
        const element = await sandbox.inGuest(`await new Promise(r => { const s = document.createElement('script'); s.src = sandboxFiles.url('p.js'); s.onload = s.onerror = r; document.head.appendChild(s); }); return globalThis.__p === 1 ? 'ran' : 'did not run';`);
        expect({ worker, element }).toEqual({ worker: browserName === 'chromium' ? 'ran' : 'NetworkError', element: 'ran' });
    });
});

test.describe('F1: rendered markup cannot re-animate an attribute the renderer checked (SVG SMIL)', () => {
    const strictView = { mode: 'strict' as const };
    const XLINK = 'http://www.w3.org/1999/xlink';

    test("a link's href animated by <set>, <animate> and on xlink:href: getAttribute, baseVal and animVal all stay the inert constant, no animation element is left, and Chromium's accessibility tree exposes no guest URL", async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(strictView)).toBe('ready');
        const html = `<svg xmlns:xlink="${XLINK}" width="300" height="80">`
            + '<a id="l1" href="https://guest.example/static"><set attributeName="href" to="https://guest.example/set" begin="0s" fill="freeze"/><text y="15">set</text></a>'
            + '<a id="l2" href="https://guest.example/static"><animate attributeName="href" values="https://guest.example/animate" begin="0s" dur="60s" fill="freeze"/><text y="35">animate</text></a>'
            + '<a id="l3" xlink:href="https://guest.example/static"><set attributeName="xlink:href" to="https://guest.example/xlink" begin="0s" fill="freeze"/><text y="55">xlink</text></a>'
            + '<a id="l4" href="https://guest.example/static"><animateMotion dur="1s"/><animateTransform attributeName="transform" type="scale" to="2" dur="1s"/><discard begin="0s"/><text y="75">control</text></a>'
            + '</svg><p id="done">done</p>';
        await sandbox.run(`sandboxView.render(${JSON.stringify(html)})`);
        await waitInView(page, browserName, `!!document.getElementById('done')`, 8000);
        await page.waitForTimeout(300); // SMIL applies on the next animation frames
        const read = await inView<any>(page, browserName, `(() => {
            const links = ['l1', 'l2', 'l3', 'l4'].map((id) => {
                const a = document.getElementById(id);
                return [a.getAttribute('href'), a.getAttributeNS(${JSON.stringify(XLINK)}, 'href'), a.href.baseVal, a.href.animVal];
            });
            return { links, animations: document.querySelectorAll('animate, set, animateMotion, animateTransform, animateColor, discard, mpath').length };
        })()`);
        expect(read).toEqual({
            links: [
                [INERT_HREF, null, INERT_HREF, INERT_HREF],
                [INERT_HREF, null, INERT_HREF, INERT_HREF],
                [null, INERT_HREF, INERT_HREF, INERT_HREF],
                [INERT_HREF, null, INERT_HREF, INERT_HREF],
            ],
            animations: 0,
        });
        if (browserName === 'chromium') {
            const urls = await chromiumViewLinkUrls(page);
            expect(urls).not.toBeNull();
            expect(urls!.length).toBeGreaterThanOrEqual(1); // positive control: the tree has the links
            for (const url of urls!) expect(url).not.toContain('guest.example');
        }
    });

    test('an animated <image href> loads nothing: the static image of the same policy reaches the listener (positive control), the animated target never does, and an animated blob: URL the view did not mint is gone too', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ ...strictView, connectionsAllowed: { 'img-src': [recorder.allowed] } })).toBe('ready');
        const workerCopy: string = await sandbox.inGuest(`return location.href`); // a blob: URL the view never minted
        const html = '<svg width="30" height="30">'
            + `<image id="static" width="3" height="5" href="${recorder.allowed}/f1-static.svg"/>`
            + `<image id="animated" width="3" height="5" href="${recorder.allowed}/f1-static.svg"><set attributeName="href" to="${recorder.allowed}/f1-animated.svg" begin="0s" fill="freeze"/></image>`
            + `<image id="blobbed" width="3" height="5"><set attributeName="href" to="${workerCopy}" begin="0s" fill="freeze"/></image>`
            + `<use id="used" href="#static"><set attributeName="href" to="${recorder.allowed}/f1-use.svg#x" begin="0s" fill="freeze"/></use>`
            + '</svg><p id="done">done</p>';
        await sandbox.run(`sandboxView.render(${JSON.stringify(html)})`);
        await waitInView(page, browserName, `!!document.getElementById('done')`, 8000);
        await recorder.waitFor('allowed', '/f1-static.svg');
        await page.waitForTimeout(800);
        expect(recorder.paths('allowed').filter(p => p.startsWith('/f1-'))).toEqual(['/f1-static.svg']);
        const read = await inView<any>(page, browserName, `['animated', 'blobbed', 'used'].map((id) => document.getElementById(id).href.animVal)`);
        expect(read).toEqual([`${recorder.allowed}/f1-static.svg`, '', '#static']);
    });
});
