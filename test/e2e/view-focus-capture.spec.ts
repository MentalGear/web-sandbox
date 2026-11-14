import { test, expect } from './fixture';
import { inView } from './strict-view';
import { drain, mountInput, sleep } from './view-input';
import { VIEW_MODES } from './view-modes';
import { VIEW_EVENT_TYPES } from '@src/lib/in-sandbox-view';

/**
 * No gesture of the user's, no focus from the host page (INHERITED_CONTEXT.uiSurfaces; viewFocusRule): a guest of strict
 * or sealed mode cannot move keyboard focus from a focused input of the host page into the view, and so receives none of
 * what the user types there. The guest's means are every one the renderer offers: `autofocus`, a rendered `<input>`, a
 * `contenteditable` element and a `tabindex` one (markup), and `sandboxView.set(id, { focus: true })`, tried at once and
 * again every 100 ms. The control is the user who keeps typing into the host's own input: its value is what was typed.
 * Where the view took the focus, the worker would hold keydown, input and change events of the typing.
 */

const MARKUP = '<input id="a" autofocus style="position:absolute;left:10px;top:10px;width:100px">'
    + '<input id="c" tabindex="0" style="position:absolute;left:120px;top:10px;width:100px">'
    + '<div id="d" contenteditable="true" tabindex="0" style="position:absolute;left:10px;top:50px;width:100px;height:30px">d</div>'
    + '<button id="e" autofocus style="position:absolute;left:120px;top:50px">e</button>'
    + '<p id="ready" style="position:absolute;left:0;bottom:0;margin:0">ready</p>';

const ENTRY = `
    ${JSON.stringify(VIEW_EVENT_TYPES)}.forEach((type) => sandboxView.on(type, null, keep(type)));
    const attempt = () => { for (const id of ['a', 'c', 'd', 'e']) { try { sandboxView.set(id, { focus: true }); } catch (error) {} } };
    attempt();
    setInterval(attempt, 100);
`;

for (const mode of VIEW_MODES) test.describe(`${mode} mode`, () => {
    test('a guest with no gesture in the view takes no focus from the host page: its typing reaches the host input and no event of the worker', async ({ sandbox, page, browserName }) => {
        await page.evaluate(() => { const input = document.createElement('input'); input.id = 'host-input'; document.body.prepend(input); input.focus(); });
        await mountInput(mode, sandbox, browserName, ENTRY, MARKUP);
        await sleep(600); // the guest's attempts, repeated
        await page.keyboard.type('abc');
        await sleep(400);
        const host = await page.evaluate(() => ({ active: document.activeElement?.localName, value: (document.getElementById('host-input') as HTMLInputElement).value }));
        const view = await inView<{ active: string | undefined; focused: boolean }>(page, browserName, `({ active: document.activeElement && document.activeElement.id, focused: document.hasFocus() })`);
        const reached = (await drain(sandbox)).map(kept => `${kept.label}${kept.detail?.target?.value !== undefined ? ` value=${JSON.stringify(kept.detail.target.value)}` : ''}`);
        console.log(`MEASURED ${browserName} ${mode} focus capture: host ${JSON.stringify(host)}, view ${JSON.stringify(view)}, the worker received ${JSON.stringify(reached)}`);
        expect(host, 'the host page keeps focus, and the user keeps typing into its input').toEqual({ active: 'input', value: 'abc' });
        expect(reached, 'nothing of the typing reaches the worker').toEqual([]);
    });
});
