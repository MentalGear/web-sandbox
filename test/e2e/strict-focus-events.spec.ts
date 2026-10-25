import { test, expect } from './fixture';
import { clickInSandbox, inView, waitInView } from './strict-view';
import { drain, mountInput, sleep, take } from './view-input';
import { VIEW_MODES } from './view-modes';

/**
 * Strict mode's focusin and focusout (research 23), on every engine: which of the view's elements gains or loses focus,
 * as the user moves it (a click, Tab) or as set({ focus }) does, and never where it went or came from (no relatedTarget):
 * focus leaving for the host page is a focusout with no focusin after it. Only trusted events: focus events dispatched
 * by script in the view are not forwarded.
 *
 * Each test runs in strict and in sealed mode (VIEW_MODES, view-modes.ts): sealed mode is strict mode's view and worker
 * with no network.
 */

const FIELDS = '<input id="a" name="first" style="position:absolute;left:10px;top:10px;width:120px;height:30px">'
    + '<input id="b" name="second" style="position:absolute;left:150px;top:10px;width:120px;height:30px">'
    + '<p id="ready" style="position:absolute;left:0;bottom:0;margin:0">ready</p>';

for (const mode of VIEW_MODES) test.describe(`${mode} mode`, () => {
    test('focusin and focusout as the user moves focus: into the view, between its fields, and out to the host page', async ({ sandbox, page, browserName }) => {
        await mountInput(mode, sandbox, browserName, `sandboxView.on('focusin', null, keep('in')); sandboxView.on('focusout', null, keep('out'));`, FIELDS);
        await clickInSandbox(page, 50, 25);
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'a'`);
        await page.keyboard.press('Tab');
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'b'`);
        await page.mouse.click(5, 5); // the host page, outside the sandbox
        await sleep(500);
        const kept = await drain(sandbox);
        expect(kept.map(k => `${k.label} ${k.detail.target.id}`)).toEqual(['in a', 'out a', 'in b', 'out b']);
        expect(kept[0]!.detail).toEqual({ type: 'focusin', ids: ['a'], target: { tag: 'input', id: 'a', name: 'first', value: '', checked: false } });
        for (const k of kept) expect(Object.keys(k.detail).sort()).toEqual(['ids', 'target', 'type']); // no relatedTarget, nothing else
    });

    test('set({ focus }) moves focus within the sandbox and raises focusin; focus events dispatched by script in the view are not forwarded', async ({ sandbox, page, browserName }) => {
        await mountInput(mode, sandbox, browserName, `
            sandboxView.on('focusin', null, keep('in'));
            sandboxView.on('focusout', null, keep('out'));
            bridge.expose('focusB', () => { sandboxView.set('b', { focus: true }); return true; });`, FIELDS);
        await inView(page, browserName, `(() => {
            for (const type of ['focusin', 'focusout']) document.getElementById('a').dispatchEvent(new FocusEvent(type, { bubbles: true }));
            return true;
        })()`);
        await sleep(400);
        expect(await take(sandbox)).toEqual([]);
        await clickInSandbox(page, 50, 25); // the user's focus is in the sandbox: set({ focus }) is admitted
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'a'`);
        expect(await sandbox.call('focusB')).toBe(true);
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'b'`);
        await sleep(300);
        expect((await drain(sandbox)).map(k => `${k.label} ${k.detail.target.id}`)).toEqual(['in a', 'out a', 'in b']);
    });
});
