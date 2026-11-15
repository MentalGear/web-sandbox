import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cssLoadBound, inSandboxView, isStyleProperty, RENDER_ATTRIBUTES, RENDER_ELEMENTS, RENDER_FORCED_ATTRIBUTES, RENDER_NAMED_CONTROLS, RENDER_RULES, sanitizeRender, VIEW_NAME_PREFIX_DIGITS, VIEW_OPTIONS, VIEW_VALUE_KINDS, viewBudget, viewControlNames, viewInputOutbox, type RenderContext, type RenderSwitches } from '@src/lib/in-sandbox-view';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { styleMarkup } from '@src/lib/style-markup';
import { cssReferences, keepsUrl, keptCss, withKeptReferences } from '@src/lib/css-references';
import { scalingRatio } from './scaling';

/**
 * What a browser's autofill gives a sealed guest (INHERITED_CONTEXT.autofill; docs/research/29_autofill): the renderer's half
 * and the view's, in jsdom. The view owns every form control's `name` (RENDER_NAMED_CONTROLS, viewControlNames) and maps it
 * back in what it forwards; `autocomplete` is the view's (RENDER_FORCED_ATTRIBUTES); and the view's value model forwards a
 * control's value only as the user entered it. The engines' side, with the browsers' own events, is
 * test/e2e/view-values.spec.ts.
 */

const KEEP_ALL: RenderSwitches = { animations: true, autoplay: true, stylesheets: true };
const PREFIX = '123456789012345678';

/** The renderer over `html`, naming controls as a view whose prefix is PREFIX does. */
function render(html: string) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const names = viewControlNames(PREFIX);
    const context: RenderContext = { target: 'body', animating: RENDER_RULES.still.known, origins: {}, refused: [], urls: 0, loads: [], controlName: names.name };
    sanitizeRender(template.content, () => null, () => false, (text, dropped, property) => keptCss(text, dropped, property, () => false), RENDER_RULES, KEEP_ALL, undefined, context);
    return { fragment: template.content, names };
}

/** The HTML elements a form submits or a browser fills by name: the "listed" form-associated elements (HTML, 4.10.2). */
const LISTED_ELEMENTS = ['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea'];

describe('the view owns name (RENDER_NAMED_CONTROLS, viewControlNames)', () => {
    it('names every listed form control the renderer keeps, and nothing else', () => {
        const kept = LISTED_ELEMENTS.filter(element => (RENDER_ELEMENTS.html as readonly string[]).includes(element));
        expect([...RENDER_NAMED_CONTROLS].sort()).toEqual(kept.sort());
    });

    it.each(RENDER_NAMED_CONTROLS.map(control => [control] as const))("%s: the guest's name becomes the view's, which maps back to it; one view name per guest name; a nameless one gets its own", (control) => {
        const markup = (attributes: string) => (control === 'input' ? `<input ${attributes}>` : `<${control} ${attributes}></${control}>`);
        const { fragment, names } = render(markup('id="a" name="email"') + markup('id="b" name="email"') + markup('id="c"') + markup('id="d" name=""') + markup('id="e" name="r29note"'));
        const nameOf = (id: string) => fragment.getElementById(id)!.getAttribute('name')!;
        expect(nameOf('a').startsWith(PREFIX)).toBe(true);
        expect(nameOf('a')).not.toContain('email');
        expect(nameOf('b')).toBe(nameOf('a'));
        expect(names.guestOf(nameOf('a'))).toBe('email');
        expect(names.guestOf(nameOf('e'))).toBe('r29note');
        // a nameless control's name is its own, and stands for no guest name
        expect(nameOf('c').startsWith(PREFIX)).toBe(true);
        expect(nameOf('d').startsWith(PREFIX)).toBe(true);
        expect(new Set([nameOf('a'), nameOf('c'), nameOf('d'), nameOf('e')]).size).toBe(4);
        expect([names.guestOf(nameOf('c')), names.guestOf(nameOf('d'))]).toEqual([null, null]);
    });

    it('a form, a map and a details element keep the name the guest wrote; a nameless radio is in no group with another', () => {
        const { fragment } = render('<form id="f" name="login"></form><map id="m" name="m1"></map><details id="d" name="acc"></details><input type="radio" id="r1"><input type="radio" id="r2">');
        expect(['f', 'm', 'd'].map(id => fragment.getElementById(id)!.getAttribute('name'))).toEqual(['login', 'm1', 'acc']);
        expect(fragment.getElementById('r1')!.getAttribute('name')).not.toBe(fragment.getElementById('r2')!.getAttribute('name'));
    });

    it('without a view to map names back, every control still gets a name no page uses', () => {
        const template = document.createElement('template');
        template.innerHTML = '<input id="a" name="email"><input id="b">';
        sanitizeRender(template.content, () => null, () => false, keptCss, RENDER_RULES, KEEP_ALL);
        const a = template.content.getElementById('a')!.getAttribute('name')!;
        const b = template.content.getElementById('b')!.getAttribute('name')!;
        expect(a).not.toBe('email');
        expect(a).toMatch(/^_\d+_\d+$/);
        expect(b).toMatch(/^_\d+_\d+$/);
        expect(a).not.toBe(b);
    });

    it('viewControlNames: any guest name maps back to itself, distinct names stay distinct, and the name holds digits only after the prefix', () => {
        fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 40 }), fc.string({ unit: 'binary', maxLength: 40 }), (one, two) => {
            const names = viewControlNames(PREFIX);
            const name = names.name(one);
            expect(name).toMatch(new RegExp(`^${PREFIX}-(\\d{5})*$`));
            expect(names.guestOf(name)).toBe(one);
            expect(names.name(two) === name).toBe(one === two);
        }));
    });

    it("viewControlNames: what a submission appends (an image button's .x and .y) maps back with its name; a name the view did not give stays as it is", () => {
        const names = viewControlNames(PREFIX);
        expect(names.guestOf(names.name('go') + '.x')).toBe('go.x');
        expect(names.guestOf(names.name(null) + '.y')).toBe('y');
        expect(names.guestOf(names.name(null))).toBeNull();
        expect(names.guestOf('comment.dir')).toBe('comment.dir'); // a dirname's field
        expect(names.guestOf('')).toBe('');
    });

    it(`the view draws its prefix: ${VIEW_NAME_PREFIX_DIGITS} decimal digits, at least 59 bits`, () => {
        expect(VIEW_OPTIONS.namePrefixDigits).toBe(VIEW_NAME_PREFIX_DIGITS);
        expect(VIEW_NAME_PREFIX_DIGITS * Math.log2(10)).toBeGreaterThan(59);
    });
});

describe('autocomplete is the view\'s (RENDER_FORCED_ATTRIBUTES)', () => {
    const AUTOCOMPLETE_ELEMENTS = ['form', 'input', 'select', 'textarea'];

    it('no element of the renderer keeps the guest\'s autocomplete', () => {
        expect(RENDER_ATTRIBUTES.html).not.toContain('autocomplete');
        for (const [element, attributes] of Object.entries(RENDER_ATTRIBUTES.htmlElements)) expect(attributes, element).not.toContain('autocomplete');
    });

    it('every form, input, select and textarea is given autocomplete="off", and only they', () => {
        const forced = RENDER_FORCED_ATTRIBUTES.filter(([, attribute]) => attribute === 'autocomplete');
        expect(forced.map(([element, , value]) => [element, value])).toEqual(AUTOCOMPLETE_ELEMENTS.map(element => [element, 'off']));
    });

    it.each(RENDER_ELEMENTS.html.map(element => [element] as const))('%s: whatever autocomplete the guest wrote, the rendered element has the view\'s or none', (element) => {
        for (const token of ['on', 'one-time-code', 'cc-number', 'email', 'new-password']) {
            const markup = element === 'input' ? `<input id="x" autocomplete="${token}">` : `<${element} id="x" autocomplete="${token}"></${element}>`;
            const kept = render(markup).fragment.getElementById('x');
            if (!kept) continue; // an element the parser does not put here on its own (a table part, an option outside a select)
            expect(kept.getAttribute('autocomplete'), `${element} ${token}`).toBe(AUTOCOMPLETE_ELEMENTS.includes(element) ? 'off' : null);
        }
    });
});

/** Every type of HTML's `input` element (HTML, 4.10.5): the domain VIEW_VALUE_KINDS classifies. */
const INPUT_TYPES = ['hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button'];

describe("the value model's kinds (VIEW_VALUE_KINDS)", () => {
    it('every input type is of exactly one kind, and every kind lists input types only', () => {
        const listed = Object.values(VIEW_VALUE_KINDS).flat() as string[];
        expect([...listed].sort()).toEqual([...INPUT_TYPES].sort());
        expect(new Set(listed).size).toBe(listed.length);
    });

    it('the view is given them', () => {
        expect(VIEW_OPTIONS.values).toBe(VIEW_VALUE_KINDS);
    });
});

// The view's bootstrap in this document (as test/unit/view-input.test.ts runs it), its listeners captured by type and called
// with events made to look trusted; the worker's end of the render port records what the view posts.
describe("the view: names map back, and the value model forwards only what the user entered (inSandboxView, run as stringified)", () => {
    const originalWorker = (globalThis as any).Worker;
    const originalAdd = window.addEventListener;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        window.addEventListener = originalAdd;
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
    });

    const FORM = '<form id="f"><input id="email" name="email" value="guest@x"><input id="other" name="other"><input id="bare"><input type="checkbox" id="c" name="c" value="yes">'
        + '<input type="radio" id="r1" name="r" value="1" checked><input type="radio" id="r2" name="r" value="2"><select id="s" name="s"><option>a</option><option>b</option></select>'
        + '<input type="hidden" id="h" name="h" value="kept"><button id="go" name="go" value="1">go</button></form>';

    async function startView(html = FORM) {
        const listeners: Record<string, ((event: unknown) => void)[]> = {};
        window.addEventListener = function (this: Window, type: string, listener: any, how?: any) {
            (listeners[type] ??= []).push(listener);
            return originalAdd.call(this, type, listener, how);
        } as typeof window.addEventListener;
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            constructor() { workers.push({ transfer: [] }); }
            postMessage(_message: unknown, transfer: MessagePort[]) { workers[workers.length - 1]!.transfer = transfer; }
        };
        new Function(`(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${viewBudget.toString()}, ${cssLoadBound.toString()}, ${cssReferences.toString()}, ${withKeptReferences.toString()}, ${keepsUrl.toString()}, ${JSON.stringify(VIEW_OPTIONS)}, ${viewInputOutbox.toString()}, ${isStyleProperty.toString()}, ${styleMarkup.toString()}, ${viewControlNames.toString()});`)();
        const a = new MessageChannel(), b = new MessageChannel();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html }, source: window, ports: [a.port1, b.port1] }));
        const render = workers[0]!.transfer[1]!;
        const received: any[] = [];
        render.onmessage = (event) => received.push(event.data);
        render.postMessage({ type: 'VIEW_STARTED' });
        render.postMessage({ type: 'VIEW_LISTEN', types: ['input', 'change', 'submit', 'click'] });
        await new Promise(resolve => setTimeout(resolve, 150));
        // `event` is what a browser would dispatch: listeners run in their order, as a capture listener on the window
        const fire = (type: string, target: Element | null, init: Record<string, unknown> = {}) => {
            const event = { isTrusted: true, type, target, timeStamp: 1, preventDefault() {}, ...init };
            for (const listener of listeners[type] ?? []) listener(event);
        };
        const details = () => received.filter(m => m.type === 'VIEW_EVENT').flatMap(m => m.details);
        const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
        const submit = () => fire('submit', $('f'), { submitter: $('go') });
        // the option the select shows as rendered, and the other one
        const shown = $('s')?.value;
        const other = shown === 'a' ? 'b' : 'a';
        return { fire, details, $, submit, shown, other };
    }
    const until = async (check: () => boolean) => {
        for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
        expect(check()).toBe(true);
    };

    it("the guest sees its own names in a target's name and a submit's fields; a nameless control is in none", async () => {
        const { fire, details, $, submit, shown } = await startView();
        expect($('email').name).not.toBe('email');
        expect($('bare').name).not.toBe('');
        fire('click', $('email'));
        submit();
        await until(() => details().length === 2);
        expect(details()[0].target.name).toBe('email');
        expect(details()[1].form).toEqual([['email', 'guest@x'], ['other', ''], ['r', '1'], ['s', shown], ['h', 'kept'], ['go', '1']]);
    });

    it('values set without the user (script, with or without its own events; a trusted input on a field the user is not in) are undone and never forwarded', async () => {
        const { fire, details, $, submit, shown, other } = await startView();
        $('other').value = 'filled by script';
        $('bare').value = 'no event';
        $('email').value = 'autofilled';
        fire('input', $('email')); // trusted, but the user is not in it: neither focused nor pressed
        $('h').value = 'hidden changed';
        $('c').checked = true;
        $('r2').checked = true;
        $('s').value = other;
        fire('change', $('s'));
        submit();
        await until(() => details().some(d => d.type === 'submit'));
        expect(details().map(d => [d.type, d.target.value])).toEqual([['input', 'guest@x'], ['change', shown], ['submit', '']]);
        expect(details()[2].form).toEqual([['email', 'guest@x'], ['other', ''], ['r', '1'], ['s', shown], ['h', 'kept'], ['go', '1']]);
        expect([$('other').value, $('bare').value, $('email').value, $('h').value, $('c').checked, $('r1').checked, $('s').value]).toEqual(['', '', 'guest@x', 'kept', false, true, shown]);
    });

    it("the user's own edits pass: typing into the field they pressed and focused, a checkbox and a radio they clicked, a select they pressed", async () => {
        const { fire, details, $, submit, other } = await startView();
        fire('pointerdown', $('other'));
        $('other').focus();
        $('other').value = 'typed';
        fire('input', $('other'), { inputType: 'insertText' });
        // a checkbox or radio is checked before its click is dispatched (the click is where the view accepts it)
        $('c').checked = true;
        fire('click', $('c'));
        fire('input', $('c'));
        fire('change', $('c'));
        $('r2').checked = true;
        fire('click', $('r2'));
        fire('change', $('r2'));
        fire('pointerdown', $('s'));
        $('s').value = other;
        fire('change', $('s'));
        submit();
        await until(() => details().some(d => d.type === 'submit'));
        expect(details().find(d => d.type === 'submit').form).toEqual([['email', 'guest@x'], ['other', 'typed'], ['c', 'yes'], ['r', '2'], ['s', other], ['h', 'kept'], ['go', '1']]);
    });

    it("a checkbox changed by an untrusted click is undone: the trusted input and change a script's click() raises are not the user's", async () => {
        const { fire, details, $, submit } = await startView();
        $('c').checked = true;
        fire('click', $('c'), { isTrusted: false });
        fire('input', $('c'));
        fire('change', $('c'));
        submit();
        await until(() => details().some(d => d.type === 'submit'));
        expect($('c').checked).toBe(false);
        expect(details().find(d => d.type === 'submit').form.map((pair: string[]) => pair[0])).not.toContain('c');
    });

    it('a field the user pressed but that is not focused, or focused by script with no press or key of the user, takes no value', async () => {
        const { fire, details, $, submit } = await startView();
        fire('pointerdown', $('other')); // pressed, not focused
        $('other').value = 'x';
        fire('input', $('other'), { inputType: 'insertText' });
        $('bare').focus(); // focused by script: the user did nothing to it
        $('bare').value = 'y';
        fire('input', $('bare'), { inputType: 'insertText' });
        submit();
        await until(() => details().some(d => d.type === 'submit'));
        expect([$('other').value, $('bare').value]).toEqual(['', '']);
    });

    it('what a submit reconciles is linear in the form\'s controls, a radio group of thousands included', async () => {
        const form = (id: string, n: number) => `<form id="${id}">${'<input type="radio" name="r">'.repeat(n)}${'<input name="t">'.repeat(n)}</form>`;
        const { fire, details } = await startView(form('small', 250) + form('large', 2000));
        const size = (id: string, n: number) => () => {
            // something to undo in every sample: the last radio checked and the last field written by script
            const radios = document.querySelectorAll<HTMLInputElement>(`#${id} input[type="radio"]`);
            radios[radios.length - 1]!.checked = true;
            const fields = document.querySelectorAll<HTMLInputElement>(`#${id} input:not([type])`);
            fields[fields.length - 1]!.value = 'written by script';
            return {
                run: () => fire('submit', document.getElementById(id)),
                verify: () => {
                    expect(radios[radios.length - 1]!.checked).toBe(false);
                    expect(fields.length).toBe(n);
                },
            };
        };
        const result = scalingRatio(size('small', 250), size('large', 2000), { bound: 24 });
        expect(result.ratio, result.message).toBeLessThan(24);
        await until(() => details().some(d => d.type === 'submit')); // each submit was forwarded
    });

    it("a reset gives the controls the guest's defaults, and they are forwarded as such", async () => {
        const { fire, details, $, submit } = await startView();
        fire('pointerdown', $('email'));
        $('email').focus();
        $('email').value = 'user typed';
        fire('input', $('email'));
        fire('reset', $('f'));
        submit();
        await until(() => details().some(d => d.type === 'submit'));
        expect(details().find(d => d.type === 'submit').form[0]).toEqual(['email', 'guest@x']);
    });
});
