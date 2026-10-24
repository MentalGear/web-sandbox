import { deflateSync } from 'node:zlib';
import { test, expect, type MountConfig, type SandboxDriver } from './fixture';
import { useRecorder } from './recorder';
import { clickInSandbox, inView, waitInView } from './strict-view';

/**
 * The owner's decisions on the open findings R1:R2-2, R1:R4-4 and R1:R4-5, where
 * the browser decides, on Chromium, Firefox and WebKit. Evidence is read from outside the sandbox: the frames'
 * attributes from the host page, the view's DOM through strict-view.ts (DevTools in Chromium), the recorder's listeners.
 *   R1:R2-2  allow-forms is an unsafe capability in cooperative mode (and test/e2e/relay-and-rpc-budgets.spec.ts, R1:R2-2)
 *   R1:R4-4  the strict view shows raster-image guest writes, decoded only
 *   R1:R4-5  sandboxView.text() and sandboxView.set() (viewScriptHash(): host-policy.spec.ts and package.spec.ts)
 */

const recorder = useRecorder();

// A PNG of width × height, so a rendered <img> tells "this file decoded" by its natural size.
function png(width: number, height: number): number[] {
    const table = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (bytes: Buffer) => {
        let c = 0xffffffff;
        for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([length, body, sum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
    const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])));
    return Array.from(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}

// The sandbox flags of the wrapper and of the guest frame inside it, read from the host page.
const flagsOf = (sandbox: SandboxDriver) => sandbox.page.evaluate(() => {
    const wrapper = (document.querySelector('web-sandbox') as HTMLElement).shadowRoot!.querySelector('iframe')!;
    const inner = new DOMParser().parseFromString(wrapper.srcdoc, 'text/html').querySelector('iframe')!;
    return [wrapper.getAttribute('sandbox'), inner.getAttribute('sandbox')];
});

test.describe('R2-2: in cooperative mode a form submits only with unsafeCapabilities: [\'allow-forms\']', () => {
    const FORM = `<form id="f"><input name="q" value="v"><button id="b">b</button></form>
        <script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); console.log('R22 submit ' + new FormData(e.target).get('q')); });</script>`;
    const SUBMIT = `document.getElementById('f').requestSubmit(); setTimeout(() => console.log('R22 settled'), 300);`;
    const fires = async (sandbox: SandboxDriver, config: MountConfig) => {
        expect(await sandbox.mount({ mode: 'cooperative', ...config, html: FORM })).toBe('ready');
        await sandbox.clearLogs();
        await sandbox.run(SUBMIT);
        await sandbox.waitForLog('R22 settled');
        return { flags: await flagsOf(sandbox), submitted: (await sandbox.logs()).includes('R22 submit v') };
    };

    test("capabilities: ['allow-forms'] is dropped: no frame has the flag, and no submission starts (WebKit still dispatches the submit event, a platform behaviour: research 15, P4)", async ({ sandbox, browserName }) => {
        // ledger: form-submit-event
        expect(await fires(sandbox, { capabilities: ['allow-scripts', 'allow-forms' as any] })).toEqual({ flags: ['allow-scripts', 'allow-scripts'], submitted: browserName === 'webkit' });
    });

    test("unsafeCapabilities: ['allow-forms'] grants it on both frames and the submission starts on every engine (the positive control)", async ({ sandbox }) => {
        expect(await fires(sandbox, { capabilities: ['allow-scripts'], unsafeCapabilities: ['allow-forms'] })).toEqual({ flags: ['allow-scripts allow-forms', 'allow-scripts allow-forms'], submitted: true });
    });
});

test.describe('R4-4: the strict view shows the raster images the guest writes, from URLs it mints itself', () => {
    const WRITES: MountConfig = { mode: 'strict', guestWrites: true, scriptUnsafe: true };
    // An <img> by id, read in the view from outside: its natural size once it loaded (a src that names no file loads
    // nothing: Firefox never marks such an image complete), and what its src attribute holds.
    const image = (id: string) => `(() => { const i = document.getElementById('${id}'); return i && (i.complete || !/^blob:/.test(i.getAttribute('src'))) ? { size: i.naturalWidth + 'x' + i.naturalHeight, src: i.getAttribute('src') } : null; })()`;

    test('a chart the guest draws on an OffscreenCanvas and writes as PNG shows in an <img> named by its path, without a rebuild; the worker gets no URL for it', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(WRITES)).toBe('ready');
        const url = await sandbox.inGuest(`
            const canvas = new OffscreenCanvas(7, 4);
            const context = canvas.getContext('2d');
            context.fillStyle = '#c00';
            context.fillRect(0, 0, 7, 4);
            await sandboxFiles.write('gen/chart.png', await canvas.convertToBlob({ type: 'image/png' }));
            sandboxView.render('<figure><img id="chart" src="gen/chart.png" alt="chart"></figure>');
            try { return sandboxFiles.url('gen/chart.png'); } catch (error) { return error.code; }`);
        expect(url).toBe('NOT_FOUND');
        const shown = await waitInView<{ size: string; src: string }>(page, browserName, image('chart'), 8000);
        expect(shown.size).toBe('7x4');
        expect(shown.src).toMatch(/^blob:/);
        expect(await sandbox.page.evaluate(() => (document.querySelector('web-sandbox') as any).listGuestWrites().map((w: any) => [w.path, w.type]))).toEqual([['gen/chart.png', 'image/png']]);
    });

    test('a later write to the path shows the new image from a new URL and revokes the old one; a removal revokes it and the path names nothing', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(WRITES)).toBe('ready');
        let renders = 0;
        const show = async (bytes: number[] | null) => {
            const token = `render${++renders}`;
            await sandbox.inGuest(`
                ${bytes ? `await sandboxFiles.write('gen/chart.png', new Uint8Array(${JSON.stringify(bytes)}));` : `await sandboxFiles.remove('gen/chart.png');`}
                sandboxView.render('<img id="chart" src="gen/chart.png"><p id="${token}">${token}</p>');
                return true;`);
            return waitInView<{ size: string; src: string }>(page, browserName, `document.getElementById('${token}') && ${image('chart')}`, 8000);
        };
        const first = await show(png(3, 5));
        expect(first.size).toBe('3x5');
        const second = await show(png(7, 4));
        expect(second.size).toBe('7x4');
        expect(second.src).toMatch(/^blob:/);
        expect(second.src).not.toBe(first.src);
        // A revoked URL is not the view's: markup that names it keeps no src (AR:A8); the live one stays (the control).
        // (Whether a revoked URL still loads is the engine's image cache: Firefox serves what it already decoded.)
        const named = async (urls: string[]) => {
            await sandbox.run(`sandboxView.render(${JSON.stringify(urls.map((url, i) => `<img id="u${i}" src="${url}">`).join('') + '<p id="named">n</p>')}, null)`);
            await waitInView(page, browserName, `!!document.getElementById('named')`, 8000);
            return inView<(string | null)[]>(page, browserName, `${JSON.stringify(urls.map((_, i) => `u${i}`))}.map((id) => document.getElementById(id).getAttribute('src'))`);
        };
        expect(await named([first.src, second.src])).toEqual([null, second.src]);
        const removed = await show(null);
        expect(removed).toEqual({ size: '0x0', src: 'gen/chart.png' });
        expect(await named([second.src])).toEqual([null]);
    });

    test('an SVG, HTML or JavaScript write named in an <img> (or as an icon, a video, a stylesheet) does not resolve and reaches no listener; a PNG write in the same render does (positive control)', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ ...WRITES, origins: { images: [recorder.allowed], connect: [recorder.allowed], styles: [recorder.allowed], media: [recorder.allowed] } })).toBe('ready');
        await sandbox.inGuest(`
            await sandboxFiles.write('w/a.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><image href="${recorder.allowed}/from-svg.svg" width="9" height="9"/><script>fetch("${recorder.allowed}/svg-script")</script></svg>');
            await sandboxFiles.write('w/b.html', '<img src="${recorder.allowed}/from-html.svg"><script>fetch("${recorder.allowed}/html-script")</script>');
            await sandboxFiles.write('w/c.js', 'fetch("${recorder.allowed}/from-js")');
            await sandboxFiles.write('w/d.png', { content: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><image href="${recorder.allowed}/from-override.svg"/></svg>'), type: 'image/svg+xml' });
            await sandboxFiles.write('w/ok.png', new Uint8Array(${JSON.stringify(png(3, 5))}));
            sandboxView.render('<img id="a" src="w/a.svg"><img id="b" src="w/b.html"><img id="c" src="w/c.js"><img id="d" src="w/d.png">'
                + '<link rel="icon" href="w/a.svg"><link rel="stylesheet" href="w/b.html"><video id="v" src="w/a.svg"></video><img id="ok" src="w/ok.png"><img id="control" src="${recorder.allowed}/control.svg">');
            return true;`);
        expect((await waitInView<{ size: string }>(page, browserName, image('ok'), 8000)).size).toBe('3x5');
        await recorder.waitFor('allowed', '/control.svg'); // the listener hears an image load from the view
        await page.waitForTimeout(500);
        const view = await inView<any>(page, browserName, `({
            imgs: ['a', 'b', 'c', 'd'].map((id) => document.getElementById(id).getAttribute('src') + ' ' + document.getElementById(id).naturalWidth),
            links: document.querySelectorAll('link').length,
            video: document.getElementById('v').getAttribute('src'),
        })`);
        expect(view).toEqual({ imgs: ['w/a.svg 0', 'w/b.html 0', 'w/c.js 0', 'w/d.png 0'], links: 0, video: 'w/a.svg' });
        expect(recorder.paths('allowed')).toEqual(['/control.svg']);
        expect(recorder.paths('blocked')).toEqual([]);
    });
});

test.describe('R4-5: sandboxView.text() and sandboxView.set()', () => {
    const STRICT: MountConfig = { mode: 'strict', scriptUnsafe: true };
    const render = async (sandbox: SandboxDriver, html: string, done: string) => {
        await sandbox.run(`sandboxView.render(${JSON.stringify(html + `<p id="${done}">${done}</p>`)})`);
        await waitInView(sandbox.page, test.info().project.name, `!!document.getElementById('${done}')`, 8000);
    };

    test('text(): the string is the element\'s text, markup and all: nothing of it is parsed, nothing loads; an unknown id is dropped and the next operation applies', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ ...STRICT, origins: { images: [recorder.allowed] } })).toBe('ready');
        await render(sandbox, `<p id="out"><b>old</b></p><img id="control" src="${recorder.allowed}/control-text.svg">`, 'r1');
        await recorder.waitFor('allowed', '/control-text.svg'); // an image the view parses does load
        const hostile = `<img src="${recorder.allowed}/from-text.svg"><b>bold</b> & <script>x()</script>`;
        await sandbox.run(`sandboxView.text('nope', 'dropped'); sandboxView.text('out', ${JSON.stringify(hostile)}); sandboxView.text('r1', 'after');`);
        await waitInView(page, browserName, `document.getElementById('r1').textContent === 'after'`, 8000);
        const view = await inView<any>(page, browserName, `({ text: document.getElementById('out').textContent, elements: document.getElementById('out').children.length, images: document.images.length, scripts: document.body.getElementsByTagName('script').length })`);
        expect(view).toEqual({ text: hostile, elements: 0, images: 1, scripts: 0 }); // the one image is the control
        await page.waitForTimeout(300);
        expect(recorder.paths('allowed')).toEqual(['/control-text.svg']);
        expect((await sandbox.logs()).filter(line => line.includes('sandboxView.text'))).toEqual([]);
    });

    test('set(): the values of an input, a textarea and a select, the checked state of a checkbox, read from outside; the guest\'s TypeError for an unknown key', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(STRICT)).toBe('ready');
        await render(sandbox, '<input id="name"><textarea id="notes"></textarea><select id="size"><option value="s">s</option><option value="l">l</option></select><input id="ok" type="checkbox">', 'r1');
        const thrown = await sandbox.inGuest(`
            sandboxView.set('name', { value: 'Ada' });
            sandboxView.set('notes', { value: 'two\\nlines' });
            sandboxView.set('size', { value: 'l' });
            sandboxView.set('ok', { checked: true });
            sandboxView.text('r1', 'set');
            try { sandboxView.set('name', { colour: 'red' }); return 'no throw'; } catch (error) { return error.name + ': ' + error.message; }`);
        expect(thrown).toBe('TypeError: sandboxView.set: unknown key "colour"; the keys are value, checked, focus, scroll and css');
        await waitInView(page, browserName, `document.getElementById('r1').textContent === 'set'`, 8000);
        expect(await inView(page, browserName, `[document.getElementById('name').value, document.getElementById('notes').value, document.getElementById('size').value, document.getElementById('ok').checked]`)).toEqual(['Ada', 'two\nlines', 'l', true]);
    });

    test('set({ focus }): refused while the host page has the user\'s focus (the host keeps it and its keystrokes, on every engine); after the user clicks into the sandbox, focus moves within it (the positive control)', async ({ sandbox, page, browserName }) => {
        await page.evaluate(() => { const input = document.createElement('input'); input.id = 'host-input'; document.body.prepend(input); });
        expect(await sandbox.mount(STRICT)).toBe('ready');
        await render(sandbox, '<button id="b" style="position:absolute;left:0;top:0;width:120px;height:40px">b</button><input id="name" style="position:absolute;left:0;top:60px">', 'r1');
        await sandbox.run(`sandboxView.on('click', 'b', () => sandboxView.set('name', { focus: true }));`);
        await page.focus('#host-input');
        await sandbox.run(`sandboxView.set('name', { focus: true }); sandboxView.text('r1', 'asked');`);
        await waitInView(page, browserName, `document.getElementById('r1').textContent === 'asked'`, 8000);
        await page.waitForTimeout(300);
        await page.keyboard.type('abc');
        expect(await page.evaluate(() => [document.activeElement?.id, (document.getElementById('host-input') as HTMLInputElement).value])).toEqual(['host-input', 'abc']);
        expect(await inView(page, browserName, `[document.activeElement.localName, document.getElementById('name').value]`)).toEqual(['body', '']);
        await sandbox.waitForLog("sandboxView.set: the view refused focus: the user's focus is not in the sandbox");

        await clickInSandbox(page, 60, 20); // the user clicks the guest's button: its handler asks for focus
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'name'`, 8000);
        await page.keyboard.type('xyz');
        expect(await inView(page, browserName, `document.getElementById('name').value`)).toBe('xyz');
        expect(await page.evaluate(() => [document.activeElement?.localName, (document.getElementById('host-input') as HTMLInputElement).value])).toEqual(['web-sandbox', 'abc']);
    });
});
