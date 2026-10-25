import { test, expect, type SandboxDriver } from './fixture';
import { useRecorder } from './recorder';
import { clickInSandbox, inView, waitInView } from './strict-view';
import { VIEW_MODES, type ViewMode } from './view-modes';

/**
 * Strict mode's events (ADR-005): the worker subscribes with sandboxView.on(type, id | null, handler) and the
 * view forwards matching events on the render port. Guarantees, per engine:
 *   1. the schema: { type, ids, target: { tag, id, name, value, checked }, key?, form? } — the target's and its
 *      ancestors' ids innermost first (at most 32), the key for keydown, the form's string fields for submit;
 *      every string at most 64 Ki characters; never a URL (no href, src or action is read);
 *   2. only trusted events: one dispatched by script (DevTools here; no guest script runs in the view) is not
 *      forwarded, a real one is (positive control). (A UA-fired event such as requestSubmit()'s submit is
 *      trusted, but nothing in the view can call it: the view runs no guest script.)
 *   3. filtering: an id handler runs for events on that element or inside it; null for all; off() stops it;
 *   4. A5's cancellations hold whatever is subscribed: a clicked link and a submitted form are delivered to
 *      the worker and navigate nowhere — the listener outside the browser stays silent (control: the host page's
 *      own link reaches it, in strict.spec.ts) and the view stays the same document.
 * Evidence: what the handlers received, reported to the host through the bridge; trusted input from
 * Playwright's mouse and keyboard; the view's state read from outside (strict-view.ts).
 *
 * Each test runs in strict and in sealed mode (VIEW_MODES, view-modes.ts): sealed mode is strict mode's view and worker
 * with no network.
 */

const recorder = useRecorder();

const at = (left: number, top: number, w = 80, h = 30) => `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;margin:0;box-sizing:border-box`;

const MARKUP = (blocked: string) => [
    `<div id="box" style="${at(0, 0, 100, 40)}"><button id="btn" name="b" value="v" style="${at(5, 5)}">B</button></div>`,
    `<input id="text" name="t" style="${at(120, 0, 150)}">`,
    `<input id="check" name="c" type="checkbox" style="${at(290, 5, 20, 20)}">`,
    `<form id="form" action="${blocked}/form" method="post" style="${at(0, 60, 300, 40)}"><input name="q" value="hello" style="${at(0, 0)}"><input name="n" value="1" type="hidden"><button id="send" name="go" value="yes" style="${at(100, 0)}">send</button></form>`,
    `<a id="link" href="${blocked}/link" style="${at(0, 120)};display:block">link</a>`,
    '<p id="ready">ready</p>',
].join('');

/** Mounts `mode` (strict or sealed) with an entry that renders MARKUP and reports every event it subscribes to through the bridge. */
async function mountWithEvents(mode: ViewMode, sandbox: SandboxDriver, browserName: string, subscriptions: string) {
    await sandbox.page.evaluate(() => { (window as any).viewEvents = []; });
    await sandbox.exposeHost('report', '(detail) => { window.viewEvents.push(detail); return true; }');
    await sandbox.registerFiles({ 'main.js': `
        const report = (label) => (detail) => bridge.call('report', { label, detail });
        sandboxView.render(${JSON.stringify(MARKUP(recorder.blocked))});
        ${subscriptions}
    ` });
    expect(await sandbox.mount({ mode, entry: 'main.js' })).toBe('ready');
    await waitInView(sandbox.page, browserName, `!!document.getElementById('ready')`);
}
const events = (sandbox: SandboxDriver) => sandbox.page.evaluate(() => (window as any).viewEvents as { label: string; detail: any }[]);

for (const mode of VIEW_MODES) test.describe(`${mode} mode`, () => {
    test('the schema: a click on a button inside a box, an input and its keys, a checkbox, a submit with its fields', async ({ sandbox, page, browserName }) => {
        await mountWithEvents(mode, sandbox, browserName, `for (const type of ['click', 'input', 'change', 'submit', 'keydown']) sandboxView.on(type, null, report(type));`);
        await clickInSandbox(page, 30, 15); // #btn inside #box
        await expect.poll(() => events(sandbox).then(e => e.length)).toBe(1);
        expect((await events(sandbox))[0]).toEqual({ label: 'click', detail: { type: 'click', ids: ['btn', 'box'], target: { tag: 'button', id: 'btn', name: 'b', value: 'v', checked: false } } });

        await page.evaluate(() => { (window as any).viewEvents = []; });
        await clickInSandbox(page, 190, 15); // #text
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'text'`); // keys go to the focused frame
        await page.keyboard.type('ab');
        await page.keyboard.press('Tab'); // blur: change
        await expect.poll(async () => (await events(sandbox)).map(e => e.label).filter(l => l !== 'click').join(' ')).toBe('keydown input keydown input keydown change');
        const typed = (await events(sandbox)).filter(e => e.label !== 'click');
        expect(typed.filter(e => e.label === 'keydown').map(e => e.detail.key)).toEqual(['a', 'b', 'Tab']);
        expect(typed.filter(e => e.label === 'input').map(e => e.detail.target.value)).toEqual(['a', 'ab']);
        expect(typed.find(e => e.label === 'change')!.detail).toEqual({ type: 'change', ids: ['text'], target: { tag: 'input', id: 'text', name: 't', value: 'ab', checked: false } });

        await page.evaluate(() => { (window as any).viewEvents = []; });
        await clickInSandbox(page, 300, 15); // #check
        await expect.poll(async () => (await events(sandbox)).some(e => e.label === 'change')).toBe(true);
        expect((await events(sandbox)).find(e => e.label === 'change')!.detail.target).toEqual({ tag: 'input', id: 'check', name: 'c', value: 'on', checked: true });

        await page.evaluate(() => { (window as any).viewEvents = []; });
        await clickInSandbox(page, 140, 75); // #send
        await expect.poll(async () => (await events(sandbox)).some(e => e.label === 'submit')).toBe(true);
        expect((await events(sandbox)).find(e => e.label === 'submit')!.detail).toEqual({
            type: 'submit', ids: ['form'], target: { tag: 'form', id: 'form', name: '', value: '', checked: false },
            form: [['q', 'hello'], ['n', '1'], ['go', 'yes']],
        });
        await page.waitForTimeout(1000);
        expect(recorder.paths('blocked')).toEqual([]); // the submission went nowhere
        expect(await inView(page, browserName, 'location.href + " " + globalThis.__sandboxViewRuns')).toBe('about:srcdoc 1');
    });

    test('A5: a clicked link is delivered to the worker without any URL and navigates nowhere; the view stays and keeps rendering', async ({ sandbox, page, browserName }) => {
        await mountWithEvents(mode, sandbox, browserName, `sandboxView.on('click', 'link', (detail) => { bridge.call('report', { label: 'link', detail }); sandboxView.render('<p id="routed">routed</p>'); });`);
        await clickInSandbox(page, 20, 130);
        await waitInView(page, browserName, `!!document.getElementById('routed')`);
        const [delivered] = await events(sandbox);
        expect(delivered).toEqual({ label: 'link', detail: { type: 'click', ids: ['link'], target: { tag: 'a', id: 'link', name: '', value: '', checked: false } } });
        expect(JSON.stringify(delivered)).not.toContain(recorder.blocked);
        await page.waitForTimeout(1000);
        expect(recorder.paths('blocked')).toEqual([]);
        expect(await inView(page, browserName, 'location.href')).toBe('about:srcdoc');
    });

    test('only trusted events are forwarded: synthetic click, input, keydown and submit dispatched in the view are not; a real click is (positive control)', async ({ sandbox, page, browserName }) => {
        await mountWithEvents(mode, sandbox, browserName, `for (const type of ['click', 'input', 'keydown', 'submit']) sandboxView.on(type, null, report(type));`);
        await inView(page, browserName, `(() => {
            document.getElementById('btn').click();
            document.getElementById('text').dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('text').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
            document.getElementById('form').dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
            return true;
        })()`);
        await page.waitForTimeout(500);
        expect(await events(sandbox)).toEqual([]);
        await clickInSandbox(page, 30, 15);
        await expect.poll(() => events(sandbox).then(e => e.map(x => x.label))).toEqual(['click']);
    });

    test('filtering: an id handler runs for its element and anything inside it, null for all; off() stops a handler', async ({ sandbox, page, browserName }) => {
        await mountWithEvents(mode, sandbox, browserName, `
            const offBox = sandboxView.on('click', 'box', report('box'));
            sandboxView.on('click', 'text', report('text'));
            sandboxView.on('click', null, report('any'));
            bridge.expose('offBox', () => { offBox(); offBox(); return true; });`);
        await clickInSandbox(page, 30, 15); // #btn, inside #box
        await expect.poll(() => events(sandbox).then(e => e.map(x => x.label).sort())).toEqual(['any', 'box']);
        expect(await sandbox.call('offBox')).toBe(true);
        await page.evaluate(() => { (window as any).viewEvents = []; });
        await clickInSandbox(page, 30, 15);
        await clickInSandbox(page, 190, 15); // #text
        await expect.poll(() => events(sandbox).then(e => e.map(x => x.label).sort())).toEqual(['any', 'any', 'text']);
    });

    test('limits: at most 32 ids, innermost first; strings at most 64 Ki characters', async ({ sandbox, page, browserName }) => {
        await mountWithEvents(mode, sandbox, browserName, `sandboxView.on('click', null, report('click')); sandboxView.on('input', 'deep', report('input'));`);
        const nested = Array.from({ length: 40 }, (_, i) => `<div id="d${i}">`).join('') + `<input id="deep" style="position:absolute;left:0;top:200px;width:100px;height:30px">` + '</div>'.repeat(40);
        await sandbox.run(`sandboxView.render(${JSON.stringify(nested)})`);
        await waitInView(page, browserName, `!!document.getElementById('deep')`);
        await clickInSandbox(page, 50, 215);
        // Type only once the click has moved focus into the view: keyboard input goes to the focused frame, and
        // with an out-of-process view Chromium can deliver it before focus crosses the process boundary.
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'deep'`);
        await page.keyboard.insertText('y'.repeat(70000));
        await expect.poll(() => events(sandbox).then(e => e.map(x => x.label))).toEqual(['click', 'input']);
        const [click, input] = await events(sandbox);
        expect(click!.detail.ids).toEqual(['deep', ...Array.from({ length: 31 }, (_, i) => `d${39 - i}`)]);
        expect(input!.detail.target.value.length).toBe(65536);
    });

    test('sandboxView.on validates its arguments; handlers registered before the ports exist work (the entry above); a throwing handler is logged and the others still run', async ({ sandbox, page, browserName }) => {
        await mountWithEvents(mode, sandbox, browserName, `
            sandboxView.on('click', null, () => { throw new Error('handler broke'); });
            sandboxView.on('click', null, report('after'));`);
        const r = await sandbox.inGuest(`
            const attempt = (f) => { try { f(); return 'ok'; } catch (e) { return e.name; } };
            return {
                type: attempt(() => sandboxView.on('keyup', null, () => {})),
                id: attempt(() => sandboxView.on('click', 5, () => {})),
                empty: attempt(() => sandboxView.on('click', '', () => {})),
                handler: attempt(() => sandboxView.on('click', null, 'code')),
                off: typeof sandboxView.on('click', null, () => {}),
            };
        `);
        expect(r).toEqual({ type: 'TypeError', id: 'TypeError', empty: 'TypeError', handler: 'TypeError', off: 'function' });
        await clickInSandbox(page, 30, 15);
        await expect.poll(() => events(sandbox).then(e => e.map(x => x.label))).toEqual(['after']);
        expect(await sandbox.waitForLog('handler broke')).toBeTruthy();
        expect(await sandbox.state()).toBe('ready');
    });
});
