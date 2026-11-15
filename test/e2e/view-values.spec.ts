import type { Page } from '@playwright/test';
import { test, expect, buildOfMode, type SandboxDriver } from './fixture';
import { clickInSandbox, inView, waitInView } from './strict-view';
import { boxOf, drain, mountInput, sleep, type Kept } from './view-input';
import { VIEW_MODES, type ViewMode } from './view-modes';

// The build with the network modes (ADR-009): this file's tests mount them. A sealed test names the default build.
test.use({ build: 'network' });

/**
 * What a browser's autofill gives the guest (INHERITED_CONTEXT.autofill; docs/research/29_autofill), without a browser
 * profile: the view's value model holds on every engine. The guest receives from a control only what the user entered
 * into it. A value put into a control of the view without the user (by script in the view, here the harness reaching
 * into the view frame: with and without events of its own, into the focused field and into others, a checkbox by a
 * script's click(), a field the script focused) is undone and never reaches the worker; what the user types, deletes,
 * pastes, cuts, undoes, composes and drops, and the controls they click and press, reach it unchanged. The controls carry
 * the view's names and `autocomplete="off"`, and the guest sees its own names.
 * The residual (INHERITED_CONTEXT.autofill.residuals.userField): text inserted where the user is typing, with a trusted
 * input event, is taken as theirs.
 *
 * Each test runs in strict and in sealed mode (VIEW_MODES): the view and its renderer are the same code.
 */

const at = (left: number, top: number, w: number, h: number) => `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;margin:0;box-sizing:border-box`;
const FORM = [
    `<p id="src" style="${at(0, 0, 120, 26)};font:18px monospace">dragword</p>`,
    '<form id="f">',
    `<input id="a" name="a" value="A0" style="${at(130, 0, 120, 26)}">`,
    `<input id="b" name="b" style="${at(260, 0, 120, 26)}">`,
    `<input id="c" name="c" style="${at(0, 40, 120, 26)}">`,
    `<textarea id="t" name="t" style="${at(130, 40, 120, 30)}"></textarea>`,
    `<input type="checkbox" id="ck" name="ck" value="yes" style="${at(262, 44, 20, 20)}">`,
    `<input type="radio" id="r1" name="r" value="1" checked style="${at(0, 90, 20, 20)}"><input type="radio" id="r2" name="r" value="2" style="${at(30, 90, 20, 20)}">`,
    `<select id="s" name="s" style="${at(60, 86, 80, 26)}"><option>x</option><option>y</option><option>z</option></select>`,
    `<input type="range" id="rg" name="rg" min="0" max="100" value="50" style="${at(150, 88, 200, 20)}">`,
    '<input type="hidden" id="h" name="h" value="H0">',
    `<button id="go" name="go" value="1" style="${at(0, 130, 80, 30)}">go</button>`,
    `<input id="n" style="${at(100, 130, 80, 26)}">`,
    `<label id="lck2" for="ck2" style="${at(200, 130, 60, 26)}">label</label><input type="checkbox" id="ck2" name="ck2" style="${at(270, 133, 20, 20)}">`,
    '</form>',
    `<p id="ready" style="${at(0, 260, 100, 20)}">ready</p>`,
].join('');
const GUEST_NAMES = ['a', 'b', 'c', 't', 'ck', 'r', 's', 'rg', 'h', 'go', 'ck2'];

/** Mounts `mode` with FORM; the worker keeps every input, change, click and submit detail, and can set a value. */
async function mountForm(mode: ViewMode, sandbox: SandboxDriver, browserName: string) {
    await mountInput(mode, sandbox, browserName, `
        for (const type of ['input', 'change', 'click', 'submit']) sandboxView.on(type, null, keep(type));
        bridge.expose('setValue', (id, value) => { sandboxView.set(id, { value }); return true; });
    `, FORM);
}
/** Each control's value as the view's document holds it (a checkbox or radio: its checkedness). */
const shownValues = (page: Page, browserName: string) => inView<Record<string, string | boolean>>(page, browserName, `(() => {
    const out = {};
    for (const el of document.querySelectorAll('input, textarea, select')) out[el.id] = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
    return out;
})()`);
/** The user's click on a control of FORM, at its centre. */
async function clickOn(page: Page, browserName: string, id: string) {
    const box = await inView<{ x: number; y: number }>(page, browserName, `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (box === 'no-context') throw new Error('no view');
    await clickInSandbox(page, box.x, box.y);
}
/** The user submits FORM and the worker's submit detail comes back. */
async function submitted(page: Page, sandbox: SandboxDriver, browserName: string): Promise<{ kept: Kept[]; form: [string, string][] }> {
    await clickOn(page, browserName, 'go');
    let kept: Kept[] = [];
    await expect.poll(async () => {
        kept = kept.concat(await drain(sandbox));
        return kept.some(k => k.label === 'submit');
    }).toBe(true);
    return { kept, form: kept.find(k => k.label === 'submit')!.detail.form };
}

for (const mode of VIEW_MODES) test.describe(`${mode} mode`, () => {
    test.use({ build: buildOfMode(mode) });

    test("every control carries the view's name and autocomplete off; the guest sees its own names, and a nameless control is in no submission", async ({ sandbox, page, browserName }) => {
        await mountForm(mode, sandbox, browserName);
        const rendered = await inView<{ id: string; name: string; autocomplete: string | null }[]>(page, browserName, `[...document.querySelectorAll('form, input, textarea, select, button')].map(el => ({ id: el.id, name: el.getAttribute('name'), autocomplete: el.getAttribute('autocomplete') }))`);
        if (rendered === 'no-context') throw new Error('no view');
        for (const element of rendered) {
            if (element.id === 'f') expect(element.autocomplete, element.id).toBe('off');
            else expect(element.name, element.id).toMatch(/^\d{18}[-_]\d+$/);
            if (element.id !== 'go') expect(element.autocomplete, element.id).toBe('off');
        }
        const { kept, form } = await submitted(page, sandbox, browserName);
        expect(kept.find(k => k.label === 'click')!.detail.target.name).toBe('go');
        expect(form.map(([name]) => name).filter((name, i, all) => all.indexOf(name) === i)).toEqual(GUEST_NAMES.filter(name => name !== 'ck' && name !== 'ck2'));
    });

    test('values put into the view without the user, with and without events, into the focused field and into others, are undone and never reach the worker', async ({ sandbox, page, browserName }) => {
        await mountForm(mode, sandbox, browserName);
        expect(await sandbox.call('setValue', 'b', 'from the guest')).toBe(true); // the guest's own set() is accepted
        await waitInView(page, browserName, `document.getElementById('b').value === 'from the guest'`);
        const before = await shownValues(page, browserName);
        if (before === 'no-context') throw new Error('no view');
        await clickOn(page, browserName, 'a'); // the user is in #a
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'a'`);
        await drain(sandbox);
        expect(await inView(page, browserName, `(() => {
            const $ = (id) => document.getElementById(id);
            const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
            $('b').value = 'FOREIGN-1';                                       // no event, not focused
            $('c').value = 'FOREIGN-2'; fire($('c'), 'input'); fire($('c'), 'change'); // synthetic events
            $('a').value = 'FOREIGN-3';                                       // the focused field, no event
            $('t').value = 'FOREIGN-4';
            $('h').value = 'FOREIGN-5';
            $('ck').click();                                                  // an untrusted click: trusted input and change
            $('r2').checked = true;
            $('s').selectedIndex = ($('s').selectedIndex + 1) % 3; fire($('s'), 'change');
            $('rg').value = '7'; fire($('rg'), 'input');
            $('n').value = 'FOREIGN-6';
            $('c').focus(); document.execCommand('insertText', false, 'FOREIGN-7'); // a field the script focused: trusted input
            $('a').focus();
            return true;
        })()`)).toBe(true);
        const { kept, form } = await submitted(page, sandbox, browserName);
        expect(JSON.stringify(kept)).not.toContain('FOREIGN');
        expect(await shownValues(page, browserName)).toEqual(before);
        expect(form).toEqual([['a', 'A0'], ['b', 'from the guest'], ['c', ''], ['t', ''], ['r', '1'], ['s', before.s], ['rg', '50'], ['h', 'H0'], ['go', '1']]);
    });

    test('what the user does to a field reaches the worker unchanged: typing, deleting, pasting, cutting, undoing, composing, dropping, and the controls they click and press', async ({ sandbox, page, browserName }) => {
        await mountForm(mode, sandbox, browserName);
        const mod = 'Control';
        await clickOn(page, browserName, 'a');
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'a'`);
        await page.keyboard.press('End');
        await page.keyboard.type('bc');
        await page.keyboard.press('Backspace'); // A0b
        await page.keyboard.press(`${mod}+A`);
        await page.keyboard.press(`${mod}+C`);
        await clickOn(page, browserName, 'b');
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'b'`);
        await page.keyboard.press(`${mod}+V`); // A0b
        await page.keyboard.press(`${mod}+A`);
        await page.keyboard.press(`${mod}+X`); // ''
        await page.keyboard.press(`${mod}+Z`); // A0b
        await waitInView(page, browserName, `document.getElementById('b').value === 'A0b'`);
        await clickOn(page, browserName, 't');
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 't'`);
        await page.keyboard.insertText('日本'); // an input method's commit (a composition on Firefox)
        await waitInView(page, browserName, `document.getElementById('t').value === '日本'`);
        // a word of #src dragged into #c, which is not focused
        const box = await boxOf(page);
        await page.mouse.dblclick(box.x + 20, box.y + 13);
        await page.mouse.move(box.x + 20, box.y + 13);
        await page.mouse.down();
        await page.mouse.move(box.x + 40, box.y + 16, { steps: 4 });
        await page.mouse.move(box.x + 60, box.y + 53, { steps: 10 });
        await page.mouse.up();
        await waitInView(page, browserName, `document.getElementById('c').value === 'dragword'`);
        await clickOn(page, browserName, 'ck');
        await clickOn(page, browserName, 'r2');
        await clickOn(page, browserName, 'lck2'); // a checkbox by its label (WebKit and Safari focus neither)
        await clickOn(page, browserName, 'rg'); // the middle of the track: 50
        await page.mouse.click(box.x + 150 + 200 * 0.8, box.y + 98); // further right
        await inView(page, browserName, `document.getElementById('s').focus()`);
        await page.keyboard.press('ArrowDown');
        await sleep(300);
        const shown = await shownValues(page, browserName);
        if (shown === 'no-context') throw new Error('no view');
        expect(shown).toMatchObject({ a: 'A0b', b: 'A0b', c: 'dragword', t: '日本', ck: true, r2: true, ck2: true });
        expect(shown.rg).not.toBe('50');
        const { kept, form } = await submitted(page, sandbox, browserName);
        expect(form).toEqual([['a', 'A0b'], ['b', 'A0b'], ['c', 'dragword'], ['t', shown.t], ['ck', 'yes'], ['r', '2'], ['s', shown.s], ['rg', shown.rg], ['h', 'H0'], ['go', '1'], ['ck2', 'on']]);
        expect(await shownValues(page, browserName)).toEqual(shown); // nothing the user did was undone
        // each input detail carried what the field held then: its last one, what it holds now
        const lastInput = (id: string) => kept.filter(k => k.label === 'input' && k.detail.target.id === id).pop();
        for (const id of ['c', 't']) expect(lastInput(id)!.detail.target.value, id).toBe(shown[id]);
    });

    test("text inserted where the user is typing, with a trusted input event, is taken as theirs (the residual: one value, in the field they are in)", async ({ sandbox, page, browserName }) => {
        await mountForm(mode, sandbox, browserName);
        await clickOn(page, browserName, 'b');
        await waitInView(page, browserName, `document.activeElement && document.activeElement.id === 'b'`);
        await page.keyboard.type('u');
        expect(await inView(page, browserName, `document.execCommand('insertText', false, 'INSERTED')`)).toBe(true);
        const { form } = await submitted(page, sandbox, browserName);
        expect(form[1]).toEqual(['b', 'uINSERTED']);
    });
});
