import { afterEach, describe, expect, it } from 'vitest';
import { cssLoadBound, INERT_HREF, inSandboxView, isStyleProperty, RENDER_ELEMENTS, RENDER_RULES, sanitizeRender, VIEW_LINK_CLICK_STOPS, VIEW_OPTIONS, viewBudget, viewControlNames, viewInputOutbox, type RenderContext, type RenderSwitches } from '@src/lib/in-sandbox-view';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { styleMarkup } from '@src/lib/style-markup';
import { cssReferences, keepsUrl, keptCss, withKeptReferences } from '@src/lib/css-references';

/**
 * `links` (design 02, I6), the view's half, in jsdom: the renderer marks an HTML `a` whose href is a listed URL character
 * for character, and nothing else; and the view, run as stringified, sends the host page one VIEW_LINK, the link's index,
 * for a trusted click on a marked link or inside one (not on a form control, a label or a summary inside it), and nothing
 * for anything else: an untrusted click (a script's `click()`, a dispatched event), an `auxclick`, a click on an unmarked
 * link or off every link. The host's half is test/unit/links.test.ts; the browsers' test/e2e/links.spec.ts.
 */

const A = 'https://docs.example.com/guide';
const B = 'https://help.example.org/a?b=c';
const KEEP_ALL: RenderSwitches = { animations: true, autoplay: true, stylesheets: true };

/** The renderer over `html` with `links`: the fragment, and what it marked, by id. */
function render(html: string, links: readonly (string | null)[] = [A, B]) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const context: RenderContext = { target: 'body', animating: RENDER_RULES.still.known, origins: {}, refused: [], urls: 0, loads: [], links, marked: [] };
    sanitizeRender(template.content, () => null, () => false, (text, dropped, property) => keptCss(text, dropped, property, () => false), RENDER_RULES, KEEP_ALL, undefined, context);
    const marked = context.marked!.map(([element, index]) => [element.id, index]);
    return { fragment: template.content, marked };
}

describe('the marking rule (the renderer, sanitizeRender)', () => {
    it('an HTML a whose href is a listed URL, as written, is marked with its index; its href becomes the inert one all the same', () => {
        const { fragment, marked } = render(`<a id="a" href="${A}">a</a><a id="b" href="${B}">b</a><a id="c" href="${A}">again</a>`);
        expect(marked).toEqual([['a', 0], ['b', 1], ['c', 0]]);
        for (const id of ['a', 'b', 'c']) expect(fragment.getElementById(id)!.getAttribute('href')).toBe(INERT_HREF);
    });

    it('the comparison is of strings: no parsing, no normalising of what the guest wrote', () => {
        const near = [
            `${A}/`, A.toUpperCase(), 'HTTPS://docs.example.com/guide', 'https://docs.example.com:443/guide', 'https://docs.example.com/./guide',
            ` ${A}`, `${A} `, `${A}#`, `${A}?`, 'https://docs.example.com/%67uide', '//docs.example.com/guide', '/guide', 'guide', '',
            'https://docs.example.com\\guide', 'https://user@docs.example.com/guide',
        ];
        const html = near.map((href, i) => `<a id="n${i}" href="${href.replace(/"/g, '&quot;')}">x</a>`).join('');
        expect(render(html).marked).toEqual([]);
        // the lookup has no prototype: a name an object inherits is no listed URL
        expect(render(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'].map((href, i) => `<a id="p${i}" href="${href}">x</a>`).join('')).marked).toEqual([]);
        // the parser's reading of the attribute is what the guest wrote: a character reference is that character
        expect(render(`<a id="e" href="https://docs.example.com/&#103;uide">x</a>`).marked).toEqual([['e', 0]]);
    });

    it('an area, an SVG a (href and xlink:href) and a MathML element with a listed href are never marked, and stay inert', () => {
        const { fragment, marked } = render(
            `<map name="m"><area id="area" href="${A}" shape="rect" coords="0,0,1,1"></map>`
            + `<svg><a id="svga" href="${A}"><text>t</text></a><a id="svgx" xlink:href="${A}"><text>u</text></a></svg>`
            + `<math><mi id="mi" href="${A}">x</mi></math>`
            + `<span id="span" href="${A}">s</span><div id="div" data-href="${A}">d</div>`);
        expect(marked).toEqual([]);
        for (const id of ['area', 'svga', 'mi']) expect(fragment.getElementById(id)!.getAttribute('href')).toBe(INERT_HREF);
    });

    it('no list, an empty list, or an entry that is no string (which start() never stores) marks nothing', () => {
        expect(render(`<a id="a" href="${A}">a</a>`, []).marked).toEqual([]);
        expect(render(`<a id="a" href="">a</a>`, [null, A]).marked).toEqual([]);
        const template = document.createElement('template');
        template.innerHTML = `<a id="a" href="${A}">a</a>`;
        expect(() => sanitizeRender(template.content, () => null, () => false, keptCss, RENDER_RULES, KEEP_ALL)).not.toThrow();
        expect(template.content.getElementById('a')!.getAttribute('href')).toBe(INERT_HREF);
    });
});

// The view's bootstrap in this document, given `links` and `html` in its INIT_VIEW; what it posts on its view port is
// recorded. Events are handed to its listeners as the platform would (a trusted one made to look so: jsdom makes none),
// and jsdom's own untrusted ones go through the real dispatch.
describe("the click is the request (inSandboxView, run as stringified)", () => {
    const originalWorker = (globalThis as any).Worker;
    const originalAdd = window.addEventListener;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        window.addEventListener = originalAdd;
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
    });

    async function startView(html: string, links: readonly string[] = [A, B]) {
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
        const logic = new MessageChannel(), view = new MessageChannel();
        const posted: any[] = [];
        view.port2.onmessage = (event) => posted.push(event.data);
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html, links }, source: window, ports: [logic.port1, view.port1] }));
        const render = workers[0]!.transfer[1]!;
        const acks: any[] = [];
        render.onmessage = (event) => acks.push(event.data);
        render.postMessage({ type: 'VIEW_STARTED' });
        const fire = (type: string, target: Element | null, trusted = true) => {
            expect(target, 'the target exists').not.toBeNull();
            const event = { isTrusted: trusted, type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, timeStamp: 1, button: 0, buttons: 0, clientX: 1, clientY: 1, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
            for (const listener of listeners[type] ?? []) listener(event);
            return event;
        };
        const links_ = () => posted.filter(frame => frame.type === 'VIEW_LINK');
        const renderInto = async (into: string | null, markup: string) => {
            const before = acks.length;
            render.postMessage({ type: 'VIEW_RENDER', html: markup, into });
            await until(() => acks.filter(frame => frame.type === 'VIEW_ACK').length > acks.slice(0, before).filter(frame => frame.type === 'VIEW_ACK').length);
        };
        await until(() => posted.some(frame => frame.type === 'VIEW_READY'));
        await settle();
        return { fire, links: links_, posted, renderInto, byId: (id: string) => document.getElementById(id) };
    }
    const until = async (check: () => boolean) => {
        for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
        expect(check()).toBe(true);
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 150)); // past a frame and the flush's fallback timer

    it('a trusted click on a marked link sends one VIEW_LINK with its index, and nothing else; its default is cancelled', async () => {
        const view = await startView(`<p><a id="a" href="${A}">a</a> <a id="b" href="${B}">b</a></p>`);
        const event = view.fire('click', view.byId('b'));
        await settle();
        expect(view.links()).toEqual([{ type: 'VIEW_LINK', index: 1 }]);
        expect(event.defaultPrevented).toBe(true);
        view.fire('click', view.byId('a'));
        await settle();
        expect(view.links()).toEqual([{ type: 'VIEW_LINK', index: 1 }, { type: 'VIEW_LINK', index: 0 }]);
        expect(view.byId('a')!.getAttribute('href')).toBe(INERT_HREF);
    });

    it('a click inside a marked link is a click on it; one off every link, on an unmarked link or on an area sends nothing', async () => {
        const view = await startView(`<a id="a" href="${A}"><span id="in"><b id="deep">x</b></span></a><a id="u" href="https://other.example/">u</a><a id="none">no href</a><p id="off">off</p>`
            + `<map name="m"><area id="area" href="${A}" shape="rect" coords="0,0,1,1"></map>`);
        view.fire('click', view.byId('deep'));
        await settle();
        expect(view.links()).toEqual([{ type: 'VIEW_LINK', index: 0 }]);
        for (const id of ['u', 'none', 'off', 'area']) view.fire('click', view.byId(id));
        await settle();
        expect(view.links()).toHaveLength(1);
    });

    it('an untrusted click (a script\'s click(), a dispatched MouseEvent), a trusted one marked untrusted, and an auxclick send nothing', async () => {
        const view = await startView(`<a id="a" href="${A}"><span id="in">a</span></a>`);
        view.byId('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        (view.byId('in') as HTMLElement).click();
        (view.byId('a') as HTMLElement).click();
        view.fire('click', view.byId('a'), false);
        view.fire('auxclick', view.byId('a'));
        await settle();
        expect(view.links()).toEqual([]);
        // positive control: the trusted click on the same link
        view.fire('click', view.byId('a'));
        await settle();
        expect(view.links()).toEqual([{ type: 'VIEW_LINK', index: 0 }]);
    });

    it('a link inside a marked link is the link clicked: its own mark, or none', async () => {
        const view = await startView(`<a id="outer" href="${A}"><span id="slot">x</span></a>`);
        await view.renderInto('slot', `<a id="inner" href="${B}"><i id="deep">b</i></a><a id="plain" href="https://other.example/">p</a>`);
        expect(view.byId('outer')!.contains(view.byId('inner'))).toBe(true);
        view.fire('click', view.byId('deep'));
        view.fire('click', view.byId('plain'));
        await settle();
        expect(view.links()).toEqual([{ type: 'VIEW_LINK', index: 1 }]);
    });

    it('a guest that rewrites the link between the press and the click: the click is on the element there, with the mark it was rendered with', async () => {
        const view = await startView(`<div id="box"><a id="l" href="${A}">go</a></div>`);
        const pressed = view.byId('l');
        view.fire('pointerdown', pressed);
        await view.renderInto('box', `<a id="l" href="${B}">go</a>`);
        expect(view.byId('l')).not.toBe(pressed);
        view.fire('click', view.byId('l'));
        await settle();
        expect(view.links()).toEqual([{ type: 'VIEW_LINK', index: 1 }]);
        // and rewritten to an unlisted href, the link there is unmarked
        await view.renderInto('box', `<a id="l" href="https://other.example/">go</a>`);
        view.fire('click', view.byId('l'));
        await settle();
        expect(view.links()).toHaveLength(1);
    });

    it('text() into a marked link keeps it marked; a render that replaces it with a listed href marks the new one, as rendered', async () => {
        const view = await startView(`<div id="box"><a id="l" href="${A}"><span id="t">old</span></a></div>`);
        await view.renderInto('l', '<em id="em">new</em>');
        view.fire('click', view.byId('em'));
        await settle();
        expect(view.links()).toEqual([{ type: 'VIEW_LINK', index: 0 }]);
    });

    const exercised: string[] = [];
    // The domain: every HTML element the renderer keeps, put inside a marked link. A click on it is the link's, except on
    // the elements with an activation of their own (VIEW_LINK_CLICK_STOPS) and on a link (a nested link is the one clicked).
    it.each(RENDER_ELEMENTS.html.map(name => [name] as const))('a click on <%s> inside a marked link: the request unless it is a form control, a label, a summary or a link of its own', async (name) => {
        const view = await startView(`<a id="l" href="${A}"><span id="slot"></span></a>`);
        const inner = name === 'option' || name === 'optgroup' ? `<select><${name} id="x"></${name}></select>`
            : name === 'input' || name === 'img' || name === 'br' || name === 'hr' || name === 'col' || name === 'source' || name === 'track' || name === 'area' ? `<${name} id="x">`
                : `<${name} id="x">x</${name}>`;
        await view.renderInto('slot', inner);
        const x = view.byId('x');
        if (!x || !view.byId('l')!.contains(x)) return; // an element the renderer drops (a <link> naming no file) or the parser puts elsewhere
        exercised.push(name);
        view.fire('click', x);
        await settle();
        const stops = (VIEW_LINK_CLICK_STOPS as readonly string[]).includes(name) || name === 'a' || name === 'area';
        expect(view.links(), name).toEqual(stops ? [] : [{ type: 'VIEW_LINK', index: 0 }]);
    });

    it('the domain was exercised: every element but a <style> (a sheet the view applies, no element) and a <link> (kept only for a file the view minted)', () => {
        const missed = RENDER_ELEMENTS.html.filter(name => !exercised.includes(name));
        expect(missed.sort()).toEqual(['link', 'style']);
    });

    it('every element of VIEW_LINK_CLICK_STOPS is one the renderer keeps, and a click inside one (a label\'s text) sends nothing', async () => {
        for (const name of VIEW_LINK_CLICK_STOPS) expect(RENDER_ELEMENTS.html as readonly string[], name).toContain(name);
        const view = await startView(`<a id="l" href="${A}"><label id="label"><span id="text">t</span></label><button id="button"><b id="bold">b</b></button></a>`);
        view.fire('click', view.byId('text'));
        view.fire('click', view.byId('bold'));
        await settle();
        expect(view.links()).toEqual([]);
    });

    it('with no links, no click sends anything', async () => {
        const view = await startView(`<a id="a" href="${A}">a</a>`, []);
        view.fire('click', view.byId('a'));
        await settle();
        expect(view.links()).toEqual([]);
    });
});
