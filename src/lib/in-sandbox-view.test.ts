import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertEntryScoped, INERT_HREF, inSandboxView, inStrictWorker, RENDER_ATTRIBUTES, RENDER_ELEMENTS, RENDER_REMOVED_ELEMENTS, RENDER_RULES, RENDER_URL_ATTRIBUTES, type RenderContext, type RenderSwitches, sanitizeRender, VIEW_EVENT_LIMITS, VIEW_MAX_DEPTH, VIEW_MAX_ELEMENTS, VIEW_OPTIONS, VIEW_RENDER_MAX_LENGTH, viewBootstrapSource, viewBootstrapText } from './in-sandbox-view';
import { REFERENCES } from './markup-references';

import { inSandboxFiles } from './in-sandbox-files';
import { VIOLATION_EVENT_LIMIT, VIOLATION_MAX_STRING } from './violation';
import { mimeTypeFor } from './files';

// the renderer with every switch on (RenderSwitches): the tests that do not test a switch keep what the switches govern
const KEEP_ALL: RenderSwitches = { animations: true, autoplay: true, stylesheets: true };

/**
 * Parses `html` into an inert fragment the way the view does, and runs the renderer on it. `files`: path → the URL the
 * view minted, typed by extension. `origins`: what the view's policy admits per kind key (R4:M-2); none
 * by default, as without `origins`.
 */
function sanitize(html: string, files: Record<string, string> = {}, origins: Record<string, string[]> = {}) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const minted = new Set(Object.values(files));
    const context: RenderContext = { target: 'body', animating: RENDER_RULES.still.known, origins, refused: [], urls: 0, loads: [] };
    sanitizeRender(template.content, (path) => (Object.hasOwn(files, path) ? { url: files[path]!, type: mimeTypeFor(path) } : null), (url) => minted.has(url), RENDER_RULES, KEEP_ALL, undefined, context);
    return template.content;
}
const serialise = (fragment: DocumentFragment) => {
    const div = document.createElement('div');
    div.append(fragment.cloneNode(true)); // the test's own copy, after the renderer ran
    return div.innerHTML;
};

describe('the renderer (A1): every listed element type is removed, with its subtree, in every namespace', () => {
    it('removes each type on its own, nested in allowed containers', () => {
        for (const name of RENDER_REMOVED_ELEMENTS) {
            const inner = name === 'frameset' ? '<frameset><frame></frameset>' : `<${name}></${name}>`;
            const fragment = sanitize(`<div><section>${inner}<p>kept</p></section></div>`);
            const found = Array.from(fragment.querySelectorAll('*')).map(e => e.localName);
            expect(found, name).not.toContain(name);
            expect(found, name).toContain('p');
        }
    });

    it('removes SVG and MathML scripts and frames, frames inside foreignObject and annotation-xml, and template contents', () => {
        const fragment = sanitize([
            '<svg><script>a()</script><script href="data:,x"></script><foreignObject><iframe srcdoc="x"></iframe><object></object></foreignObject></svg>',
            '<math><iframe></iframe><annotation-xml encoding="text/html"><iframe></iframe><embed></annotation-xml></math>',
            '<template><script>b()</script></template><template shadowrootmode="open"><p>shadow</p></template>',
            '<noscript><img src="x"></noscript><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">',
            '<portal></portal><fencedframe></fencedframe>',
        ].join(''));
        const left = Array.from(fragment.querySelectorAll('*')).map(e => `${e.localName}`);
        expect(left.filter(name => (RENDER_REMOVED_ELEMENTS as readonly string[]).includes(name))).toEqual([]);
        expect(left).toEqual(['svg', 'math']); // foreignObject and annotation-xml are not on the allowlist: gone with their content
    });

    it('removes every SVG animation element in its own namespace and case (focused review F1): nothing can change a checked attribute after the renderer ran', () => {
        const fragment = sanitize('<svg><a href="https://guest.example/a"><set attributeName="href" to="https://guest.example/b"/><animate attributeName="href" values="x"/><text>t</text></a>'
            + '<image href="x.png"><animateMotion dur="1s"><mpath href="#p"/></animateMotion><animateTransform attributeName="transform"/><animateColor/><discard/><animation/></image></svg>');
        const left = Array.from(fragment.querySelectorAll('*')).map(e => e.localName);
        expect(left).toEqual(['svg', 'a', 'text']); // <image> is not on the allowlist either
        expect(fragment.querySelector('a')!.getAttribute('href')).toBe(INERT_HREF);
    });

    it('keeps a <link> only as a stylesheet or icon whose href is a URL the view minted', () => {
        const files = { 'site.css': 'blob:null/css', 'icon.png': 'blob:null/icon' };
        const fragment = sanitize([
            '<link id="sheet" rel="stylesheet" href="site.css">',
            '<link id="icon" rel="icon" href="./icon.png">',
            '<link id="unminted" rel="stylesheet" href="https://cdn.example/x.css">',
            '<link id="preload" rel="preload" as="style" href="site.css">',
            '<link id="mixed" rel="stylesheet prefetch" href="site.css">',
            '<link id="norel" href="site.css">',
            '<link id="dns" rel="dns-prefetch" href="https://evil.example">',
        ].join(''), files);
        expect(Array.from(fragment.querySelectorAll('link')).map(l => [l.id, l.getAttribute('href')])).toEqual([['sheet', 'blob:null/css'], ['icon', 'blob:null/icon']]);
    });
});

describe('the renderer: file references, blob: URLs (A8), referrer and ping (A1)', () => {
    const files = { 'img/logo.png': 'blob:null/logo', 'clip.mp4': 'blob:null/clip', 'subs.vtt': 'blob:null/subs' };

    it('resolves the reference attributes of markup-references.ts (minus script) like a browser would against vfs.invalid/index.html', () => {
        const fragment = sanitize([
            '<img id="a" src="img/logo.png"><img id="b" src="./img/logo.png"><img id="c" src="/img/logo.png"><img id="d" src="x/../img/logo.png">',
            '<img id="e" src="img/Logo.png"><img id="f" src="img/logo.png?v=2"><img id="g" src="https://cdn.example/img/logo.png">',
            '<video id="v" src="clip.mp4" poster="img/logo.png"><source id="s" src="clip.mp4"><track id="t" src="subs.vtt"></video><audio id="au" src="clip.mp4"></audio>',
        ].join(''), files, { images: ['https://cdn.example'] });
        const src = (id: string, attribute = 'src') => fragment.getElementById(id)!.getAttribute(attribute);
        expect(['a', 'b', 'c', 'd'].map(id => src(id))).toEqual(Array(4).fill('blob:null/logo'));
        expect(['e', 'f', 'g'].map(id => src(id))).toEqual(['img/Logo.png', 'img/logo.png?v=2', 'https://cdn.example/img/logo.png']);
        expect([src('v'), src('v', 'poster'), src('s'), src('t'), src('au')]).toEqual(['blob:null/clip', 'blob:null/logo', 'blob:null/clip', 'blob:null/subs', 'blob:null/clip']);
        // derived from the cooperative-mode table, never a copy
        expect(RENDER_RULES.references).toEqual(REFERENCES.filter(([element]) => element !== 'script'));
    });

    it('removes every attribute holding a blob: URL the view did not mint, however it is written; keeps a minted one on a reference attribute', () => {
        const fragment = sanitize([
            '<img id="minted" src="img/logo.png">',
            '<img id="foreign" src="blob:null/worker-made">',
            '<img id="spaced" src=" b\tl\nob:null/worker-made">',
            '<img id="upper" src="BLOB:null/x">',
            '<a id="anchor" href="blob:null/logo">x</a>',
            '<div id="styled" style="background:url(blob:null/logo)"></div>',
            '<img id="srcset" srcset="blob:null/logo 1x">',
            '<p id="data" data-x="see blob:null/logo">p</p>',
        ].join(''), files);
        const has = (id: string, attribute: string) => fragment.getElementById(id)!.hasAttribute(attribute);
        expect(fragment.getElementById('minted')!.getAttribute('src')).toBe('blob:null/logo');
        expect([has('foreign', 'src'), has('spaced', 'src'), has('upper', 'src'), has('styled', 'style'), has('srcset', 'srcset'), has('data', 'data-x')]).toEqual(Array(6).fill(false));
        expect(fragment.getElementById('anchor')!.getAttribute('href')).toBe(INERT_HREF); // a link's href is the constant (S24)
    });

    it('forces referrerpolicy="no-referrer" on a, area, img and link and wherever it is set; drops ping; keeps only noopener, noreferrer, nofollow in rel', () => {
        const fragment = sanitize([
            '<a id="a" href="https://x.example/" ping="https://evil.example/ping" rel="opener prefetch noopener nofollow" referrerpolicy="unsafe-url">a</a>',
            '<map><area id="area" href="https://x.example/" referrerpolicy="unsafe-url" rel="noreferrer external"></map>',
            '<img id="img" src="https://x.example/i.png" referrerpolicy="unsafe-url"><img id="plain" src="https://x.example/j.png">',
            '<svg><a id="svga" href="https://x.example/" referrerpolicy="unsafe-url"><rect/></a></svg>',
        ].join(''));
        const attribute = (id: string, name: string) => fragment.getElementById(id)!.getAttribute(name);
        expect(['a', 'area', 'img', 'plain', 'svga'].map(id => attribute(id, 'referrerpolicy'))).toEqual(Array(5).fill('no-referrer'));
        expect(attribute('a', 'ping')).toBeNull();
        expect([attribute('a', 'rel'), attribute('area', 'rel')]).toEqual(['noopener nofollow', 'noreferrer']);
    });
});

describe('the renderer: every hyperlink href is one inert constant (backlog S24, option B)', () => {
    const MARK = 'MARKER-s24';
    const XLINK = 'http://www.w3.org/1999/xlink';

    it('HTML a and area, SVG a (href and xlink:href) and MathML links get INERT_HREF; the guest URL is gone from the fragment', () => {
        const fragment = sanitize([
            `<a id="a" href="https://x.example/?m=${MARK}">a</a>`,
            `<a id="rel" href="relative/${MARK}">r</a><a id="frag" href="#${MARK}">f</a><a id="js" href="javascript:alert('${MARK}')">j</a>`,
            `<map><area id="area" href="https://x.example/${MARK}"></map>`,
            `<svg><a id="svga" href="https://x.example/${MARK}"><rect/></a><a id="svgx" xlink:href="https://x.example/${MARK}"><rect/></a></svg>`,
            `<math><mi id="mi" href="https://x.example/${MARK}">x</mi></math>`,
        ].join(''));
        const attribute = (id: string) => fragment.getElementById(id)!.getAttribute('href');
        expect(['a', 'rel', 'frag', 'js', 'area', 'svga', 'mi'].map(attribute)).toEqual(Array(7).fill(INERT_HREF));
        expect(fragment.getElementById('svgx')!.getAttributeNS(XLINK, 'href')).toBe(INERT_HREF);
        expect(serialise(fragment)).not.toContain(MARK);
        expect(INERT_HREF).toBe('about:blank#');
        expect(RENDER_RULES.inertHref).toBe(INERT_HREF);
    });

    it('positive control: links stay links, an <a> without href gets none; no other SVG element keeps an href (use and image are gone, a gradient or pattern loses its template)', () => {
        const fragment = sanitize(`<a id="named" name="x">no href</a><svg><use id="use" href="#icon"/><image id="img" href="https://x.example/i.png"/><linearGradient id="lg" href="#other"/><pattern id="pt" xlink:href="#other"/></svg>`);
        expect(fragment.getElementById('named')!.hasAttribute('href')).toBe(false);
        expect([fragment.getElementById('use'), fragment.getElementById('img')]).toEqual([null, null]);
        expect(['lg', 'pt'].map(id => fragment.getElementById(id)!.getAttributeNames())).toEqual([['id'], ['id']]);
        const link = sanitize('<a id="l" href="https://x.example/">l</a>');
        const holder = document.createElement('div');
        holder.append(link);
        document.body.append(holder);
        const anchor = holder.querySelector('#l') as HTMLAnchorElement;
        expect([anchor.matches(':link'), anchor.matches(':any-link'), anchor.tabIndex, anchor.href]).toEqual([true, true, 0, INERT_HREF]);
        holder.remove();
    });
});

describe('the renderer reads elements through the prototypes, not the instance (DOM clobbering)', () => {
    it('a form whose controls shadow the methods it uses is still cleaned', () => {
        const names = ['getAttributeNames', 'getAttribute', 'localName', 'namespaceURI', 'remove', 'hasAttribute', 'setAttribute', 'removeAttribute', 'hasAttributeNS', 'setAttributeNS'];
        const fragment = sanitize(`<form id="f">${names.map(n => `<input name="${n}">`).join('')}<iframe></iframe><script>x</script><img ping="https://evil.example/" src="https://x.example/i.png"></form>`);
        expect(Array.from(fragment.querySelectorAll('iframe, script'))).toEqual([]);
        expect(fragment.querySelector('img')!.hasAttribute('ping')).toBe(false);
        expect(fragment.querySelector('img')!.getAttribute('referrerpolicy')).toBe('no-referrer');
    });
});

describe('A2: the fragment is moved, never cloned or imported', () => {
    afterEach(() => vi.restoreAllMocks());

    it('the renderer calls no clone, import or adopt', () => {
        const clone = vi.spyOn(Node.prototype, 'cloneNode');
        const importNode = vi.spyOn(Document.prototype, 'importNode');
        const adoptNode = vi.spyOn(Document.prototype, 'adoptNode');
        const template = document.createElement('template');
        template.innerHTML = '<svg><script>x</script></svg><div><img src="a"><p>t</p></div>';
        sanitizeRender(template.content, () => null, () => false, RENDER_RULES, KEEP_ALL);
        expect([clone.mock.calls.length, importNode.mock.calls.length, adoptNode.mock.calls.length]).toEqual([0, 0, 0]);
    });

    it('neither the bootstrap nor the renderer source names cloneNode, importNode or adoptNode; the bootstrap moves template.content', () => {
        for (const source of [inSandboxView.toString(), sanitizeRender.toString()]) expect(source).not.toMatch(/cloneNode|importNode|adoptNode/);
        expect(inSandboxView.toString()).toMatch(/E\.replaceChildren, target, \[template\.content\]/);
    });
});

describe('the view bootstrap', () => {
    const originalWorker = (globalThis as any).Worker;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
    });

    it('its options literal: the renderer rules and the violation cap the host uses', () => {
        expect(VIEW_OPTIONS.violationLimit).toBe(VIOLATION_EVENT_LIMIT);
        expect(VIEW_OPTIONS.violationMaxString).toBe(VIOLATION_MAX_STRING); // the cut of its reports' strings (backlog S61.3)
        expect(VIEW_OPTIONS.render).toBe(RENDER_RULES);
        expect(viewBootstrapText()).toContain(JSON.stringify(RENDER_REMOVED_ELEMENTS));
    });

    it('is inert without INIT_VIEW: no worker, no render, nothing posted; only one from parent.parent with two ports is accepted, once; a second run of the text does nothing', async () => {
        const constructed: { source: string; posted: unknown[] }[] = [];
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            constructor(url: string) { constructed.push({ source: url, posted: [] }); }
            postMessage(message: unknown, transfer: unknown[]) { constructed[constructed.length - 1]!.posted.push([message, transfer.length]); }
        };
        const text = viewBootstrapText();
        new Function(text)();
        new Function(text)(); // a copy that runs again in the same document returns at once
        expect((globalThis as any).__sandboxViewRuns).toBe(2);

        const send = (init: MessageEventInit) => window.dispatchEvent(new MessageEvent('message', init));
        const ports = () => { const a = new MessageChannel(), b = new MessageChannel(); return [a.port1, b.port1]; };
        const init = { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '<p id="initial">x</p>' };
        send({ data: init, ports: ports() }); // no source: not from parent.parent
        send({ data: init, source: document.createElement('iframe').contentWindow ?? null, ports: ports() });
        send({ data: { ...init, type: 'INIT_PORT' }, source: window, ports: ports() });
        send({ data: init, source: window, ports: [] }); // no ports
        send({ data: { ...init, workerSource: 42 }, source: window, ports: ports() });
        expect(constructed).toEqual([]);
        expect(document.getElementById('initial')).toBeNull();

        send({ data: init, source: window, ports: ports() }); // jsdom: parent.parent === window
        send({ data: init, source: window, ports: ports() }); // a second INIT is ignored
        expect(constructed).toHaveLength(1);
        expect(constructed[0]!.posted).toEqual([[{ type: 'INIT_WORKER' }, 2]]);
        expect(document.getElementById('initial')).not.toBeNull();
        document.body.replaceChildren();
    });

    it("revokes the worker's source URL on the first message the worker sends on the render port, and not before (review C1)", async () => {
        const workers: { url: string; transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            constructor(url: string) { workers.push({ url, transfer: [] }); }
            postMessage(_message: unknown, transfer: MessagePort[]) { workers[workers.length - 1]!.transfer = transfer; }
        };
        const revoked: string[] = [];
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => { revoked.push(url); });
        try {
            new Function(viewBootstrapText())();
            const a = new MessageChannel(), b = new MessageChannel();
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '' }, source: window, ports: [a.port1, b.port1] }));
            expect(workers).toHaveLength(1);
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(revoked).toEqual([]); // the worker exists, but has not run its script to the end yet

            const render = workers[0]!.transfer[1]!; // the worker's end of the render port
            render.postMessage({ type: 'VIEW_STARTED' });
            render.postMessage({ type: 'VIEW_LISTEN', types: [] });
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(revoked).toEqual([workers[0]!.url]);
            expect(workers[0]!.url).toMatch(/^blob:/);
            for (const port of [a.port1, a.port2, b.port1, b.port2, ...workers[0]!.transfer]) port.close();
        } finally {
            revoke.mockRestore();
        }
    });
});

describe('the strict worker prelude (unit; the e2e specs cover it in real workers)', () => {
    it('removes URL.createObjectURL and (without scriptUnsafe) WebAssembly (Worker and SharedWorker: worker-globals.ts, first); render() validates; an untrusted INIT is ignored', () => {
        // run as stringified, with globalThis bound to a stand-in global (a real EventTarget), so the test realm is untouched
        const w = new EventTarget() as any;
        const fakeUrl = { createObjectURL: () => 'blob:x' };
        Object.assign(w, { Worker: function () {}, SharedWorker: function () {}, WebAssembly: {}, URL: fakeUrl });
        const attached: unknown[] = [];
        const run = new Function('globalThis', `return (${inStrictWorker.toString()})`)(w);
        run({ attach: (port: unknown) => attached.push(port) }, { scriptUnsafe: false, maxRender: 10, maxTarget: 5, maxElements: 100, maxDepth: 10, entryDoneName: '__testEntryDone', eventTypes: ['click', 'keydown'] });
        expect(['WebAssembly'].filter(name => name in w)).toEqual([]);
        expect('createObjectURL' in fakeUrl).toBe(false);

        const view = w.sandboxView;
        expect(Object.isFrozen(view)).toBe(true);
        expect(() => view.render('x'.repeat(11))).toThrow(RangeError);
        expect(() => view.render(1)).toThrow(TypeError);
        expect(() => view.render('<p>', 'toolong')).toThrow(TypeError);
        expect(() => view.render('<p>', '')).toThrow(TypeError);
        expect(() => view.render('<p>')).not.toThrow(); // buffered until the port exists
        expect(() => view.on('scroll', null, () => {})).toThrow(TypeError);
        expect(() => view.on('click', 7, () => {})).toThrow(TypeError);
        expect(() => view.on('click', 'toolong', () => {})).toThrow(TypeError);
        expect(() => view.on('click', null, 'code')).toThrow(TypeError);
        const off = view.on('keydown', 'a', () => {});
        expect([typeof off, off(), off()]).toEqual(['function', undefined, undefined]);

        // a message event guest code dispatches itself is untrusted: never taken for the ports, and left to the guest
        let guestSaw = 0;
        w.addEventListener('message', () => guestSaw++);
        const channel = new MessageChannel();
        w.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_WORKER' }, ports: [channel.port1, channel.port2] }));
        expect([attached.length, guestSaw]).toEqual([0, 1]);
        // the entry marker cannot be replaced
        expect(Object.getOwnPropertyDescriptor(w, '__testEntryDone')).toMatchObject({ writable: false, configurable: false });
    });
});

describe('review C2 and C3: the strict worker prelude against hostile globals', () => {
    const start = (w: any) => {
        const run = new Function('globalThis', `return (${inStrictWorker.toString()})`)(w);
        run({ attach: () => {} }, { scriptUnsafe: false, maxRender: 100, maxTarget: 5, maxElements: 100, maxDepth: 10, entryDoneName: '__testEntryDone', eventTypes: ['click', 'keydown'] });
    };

    it('assertEntryScoped refuses a global object holding a non-configurable function (what a top-level declaration leaves), whatever happened to the name Object', () => {
        const g: any = {};
        Object.defineProperty(g, 'Object', { value: function Object() {}, writable: true, configurable: true });
        expect(() => assertEntryScoped(g)).not.toThrow();
        Object.defineProperty(g, 'Worker', { value: function Worker() {}, writable: true, enumerable: true, configurable: false });
        expect(() => assertEntryScoped(g)).toThrowError(/the entry declares "Worker" at the top level/);
        const values: any = {};
        Object.defineProperty(values, 'NaN', { value: NaN, configurable: false });
        expect(() => assertEntryScoped(values)).not.toThrow(); // non-configurable, but not a function: the platform's own
    });

    it('a name the prelude must remove but cannot is an error, not a silent pass (C2)', () => {
        const w = new EventTarget() as any;
        Object.defineProperty(w, 'WebAssembly', { value: {}, writable: true, enumerable: true, configurable: false });
        Object.assign(w, { URL: {} });
        expect(() => start(w)).toThrowError(/could not remove WebAssembly/);
    });

    it("writes to the prelude's lists never reach a setter on Array.prototype (C3)", () => {
        const w = new EventTarget() as any;
        Object.assign(w, { URL: {} });
        start(w);
        const seen: unknown[] = [];
        Object.defineProperty(Array.prototype, '0', { configurable: true, set(value) { seen.push(value); Object.defineProperty(this, '0', { value, writable: true, enumerable: true, configurable: true }); } });
        try {
            w.sandboxView.render('<p>a</p>');
            w.sandboxView.on('click', null, () => {});
            w.sandboxView.render('<p>b</p>', 'x');
        } finally {
            delete (Array.prototype as any)['0'];
        }
        expect(seen).toEqual([]);
    });

    it("the prelude's error texts use a join captured before guest code: a patched Array.prototype.join never receives the prelude's own list (C3)", () => {
        const w = new EventTarget() as any;
        Object.assign(w, { URL: {} });
        start(w);
        const receivers: unknown[] = [];
        const join = Array.prototype.join;
        Array.prototype.join = function (this: unknown[], ...args: [string?]) { receivers.push(this); return join.apply(this, args); };
        let message = '';
        try {
            w.sandboxView.on('scroll', null, () => {});
        } catch (error) {
            message = (error as Error).message;
        } finally {
            Array.prototype.join = join;
        }
        expect(message).toBe('sandboxView.on: type must be one of click, keydown');
        expect(receivers).toEqual([]);
    });
});

describe('broad review 2026-10-14: the renderer is an allowlist', () => {
    const HTML = 'http://www.w3.org/1999/xhtml';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const MATHML = 'http://www.w3.org/1998/Math/MathML';
    const allowedElement = (e: Element) => (e.namespaceURI === HTML && ((RENDER_ELEMENTS.html as readonly string[]).includes(e.localName) || /^[a-z][a-z0-9._-]*-[a-z0-9._-]*$/.test(e.localName)))
        || (e.namespaceURI === SVG_NS && (RENDER_ELEMENTS.svg as readonly string[]).includes(e.localName))
        || (e.namespaceURI === MATHML && (RENDER_ELEMENTS.mathml as readonly string[]).includes(e.localName));
    const allowedAttribute = (e: Element, name: string) => name.startsWith('data-') || name.startsWith('aria-')
        || (e.namespaceURI === HTML && ((RENDER_ATTRIBUTES.html as readonly string[]).includes(name) || (RENDER_ATTRIBUTES.htmlElements[e.localName] ?? []).includes(name)))
        || (e.namespaceURI === SVG_NS && ((RENDER_ATTRIBUTES.svg as readonly string[]).includes(name) || (e.localName === 'a' && (RENDER_ATTRIBUTES.svgLink as readonly string[]).includes(name))))
        || (e.namespaceURI === MATHML && (RENDER_ATTRIBUTES.mathml as readonly string[]).includes(name));

    // every element name a guest might write, allowed or not, in each namespace, and attributes likewise
    const ELEMENTS = [...new Set([...RENDER_ELEMENTS.html, ...RENDER_REMOVED_ELEMENTS, 'center', 'font', 'marquee', 'blink', 'canvas', 'slot', 'selectedcontent', 'xmp', 'listing', 'plaintext',
        'keygen', 'menuitem', 'image', 'param', 'x-widget', 'font-face', 'annotation-xml', 'head', 'body', 'html'])];
    const SVG_ELEMENTS = [...RENDER_ELEMENTS.svg, 'use', 'marker', 'image', 'feImage', 'filter', 'feGaussianBlur', 'feMorphology', 'foreignObject', 'script', 'animate', 'set', 'textPath', 'switch', 'view', 'cursor', 'mpath'];
    const MATH_ELEMENTS = [...RENDER_ELEMENTS.mathml, 'annotation-xml', 'maction', 'mglyph', 'malignmark'];
    const ATTRIBUTES = ['id', 'class', 'style', 'onclick', 'onload', 'onerror', 'onfocus', 'onbegin', 'href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'method', 'target',
        'popover', 'popovertarget', 'commandfor', 'command', 'interestfor', 'autofocus', 'contenteditable', 'is', 'slot', 'nonce', 'ping', 'download', 'background', 'cursor', 'fill', 'mask',
        'filter', 'marker-mid', 'name', 'value', 'type', 'data-x', 'aria-label', 'attributionsrc', 'poster', 'data', 'codebase', 'xmlns', 'referrerpolicy', 'rel'];
    const VALUES = ['x', 'https://x.example/a', 'javascript:void 0', 'data:image/svg+xml,<svg/>', 'url(https://x.example/#a)', 'url(#a)', 'blob:null/not-minted', ' java\nscript:x', '#a'];

    // a deterministic generator (mulberry32): markup from every element, nested, with every attribute
    const rng = (seed: number) => () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const markup = (random: () => number, depth: number): string => {
        let out = '';
        const count = 1 + Math.floor(random() * 4);
        for (let i = 0; i < count; i++) {
            const space = random();
            const pool = space < 0.6 ? ELEMENTS : space < 0.85 ? SVG_ELEMENTS : MATH_ELEMENTS;
            const name = pool[Math.floor(random() * pool.length)]!;
            const attributes = Array.from({ length: Math.floor(random() * 5) }, () => `${ATTRIBUTES[Math.floor(random() * ATTRIBUTES.length)]}="${VALUES[Math.floor(random() * VALUES.length)]!.replace(/"/g, '&quot;')}"`).join(' ');
            const inner = depth > 0 ? markup(random, depth - 1) : 'text';
            const wrap = space < 0.6 ? (s: string) => s : space < 0.85 ? (s: string) => `<svg>${s}</svg>` : (s: string) => `<math>${s}</math>`;
            out += wrap(`<${name} ${attributes}>${inner}</${name}>`);
        }
        return out;
    };

    // What the renderer left in one corpus that it should not have: one line per element or attribute, empty when sound.
    const leftovers = (seed: number): string[] => {
        const found: string[] = [];
        const fragment = sanitize(markup(rng(seed), 3));
        for (const element of Array.from(fragment.querySelectorAll('*'))) {
            if (!allowedElement(element)) found.push(`seed ${seed}: <${element.localName}> in ${element.namespaceURI}`);
            for (const name of element.getAttributeNames()) {
                if (!allowedAttribute(element, name) || name.toLowerCase().startsWith('on')) found.push(`seed ${seed}: ${element.localName}[${name}]`);
                const value = element.getAttribute(name)!.replace(/[\t\n\r]/g, '').trim().toLowerCase();
                if (['src', 'srcset', 'href', 'xlink:href', 'poster'].includes(name) && /^(javascript|data|vbscript):/.test(value)) found.push(`seed ${seed}: ${element.localName}[${name}]=${value}`);
            }
        }
        return found;
    };

    // The cost is CPU in jsdom (about two thirds parsing the corpora into templates, a quarter the renderer's walk;
    // 1.5 s on an idle core for the 300 corpora, about 9 000 elements). On a loaded machine it passes vitest's default
    // 5 s timeout (9 s with other processes on all four cores): not a hang, a fixed amount of work run slower. So the
    // checks are collected and asserted once instead of one expect() per attribute (1.8 s → 1.5 s idle), and the test
    // states its own bound, 30 s: twenty times its idle cost, three times the worst seen under load. The 300 seeded corpora stay, since what they
    // cover — every listed and unlisted name, three namespaces, depth 3 — is the property.
    it("property: whatever is rendered, every element left is on its namespace's list and every attribute on its list; no handler, no script-capable URL is left (300 random corpora)", () => {
        const found: string[] = [];
        for (let seed = 1; seed <= 300; seed++) found.push(...leftovers(seed));
        expect(found).toEqual([]);
    }, 30000);

    it('unknown HTML elements are unwrapped (their checked children take their place, moved, not cloned); unknown SVG and MathML elements go with their content; a custom element name is kept, a reserved one unwrapped', () => {
        const clone = vi.spyOn(Node.prototype, 'cloneNode');
        try {
            const fragment = sanitize('<center id="c"><b id="kept">k</b>text<script>x</script><marquee><i id="deep">d</i></marquee></center>'
                + '<svg><switch><rect id="in-switch"/></switch><rect id="r"/></svg><math><maction><mi id="in-maction">x</mi></maction><mi id="mi">y</mi></math>'
                + '<x-card id="card"><font-face id="reserved-child">f</font-face></x-card>');
            expect(clone.mock.calls.length).toBe(0);
            expect(serialise(fragment)).toBe('<b id="kept">k</b>text<i id="deep">d</i><svg><rect id="r"></rect></svg><math><mi id="mi">y</mi></math><x-card id="card">f</x-card>');
        } finally {
            clone.mockRestore();
        }
    });

    it('URL attributes keep only http(s), a URL the view minted, or a relative URL; srcset is checked candidate by candidate', () => {
        const files = { 'a.png': 'blob:null/minted' };
        const fragment = sanitize([
            '<img id="https" src="https://x.example/i.png"><img id="http" src="HTTP://x.example/i.png"><img id="relative" src="nope.png"><img id="file" src="a.png">',
            '<img id="data" src="data:image/png;base64,AA=="><img id="js" src=" \u0001java\tscript:x"><img id="blob" src="blob:null/other"><img id="other" src="ftp://x.example/i.png">',
            '<video id="poster" poster="data:image/svg+xml,x"></video><audio id="audio" src="javascript:x"></audio><video><source id="source" srcset="https://x.example/a.png 1x,https://x.example/b.png 2x" src="data:,x"></video>',
            '<img id="set-ok" srcset="https://x.example/a.png 1x, https://x.example/b,c.png 2x"><img id="set-data" srcset="https://x.example/a.png 1x,data:image/svg+xml,x 2x"><img id="set-js" srcset=" javascript:x 1x">',
        ].join(''), files, { images: ['https://x.example'], media: ['https://x.example'] });
        const src = (id: string, name = 'src') => fragment.getElementById(id)!.getAttribute(name);
        expect(['https', 'http', 'relative', 'file'].map(id => src(id))).toEqual(['https://x.example/i.png', 'HTTP://x.example/i.png', 'nope.png', 'blob:null/minted']);
        expect(['data', 'js', 'blob', 'other', 'audio', 'source'].map(id => src(id))).toEqual(Array(6).fill(null));
        expect([src('poster', 'poster'), src('source', 'srcset'), src('set-ok', 'srcset'), src('set-data', 'srcset'), src('set-js', 'srcset')])
            .toEqual([null, 'https://x.example/a.png 1x,https://x.example/b.png 2x', 'https://x.example/a.png 1x, https://x.example/b,c.png 2x', null, null]);
    });

    it('SVG paint and clip references name only fragments of this document; no form target, invoker or handler survives', () => {
        const fragment = sanitize('<svg><rect id="r" fill="url(#g)" stroke="url(https://x.example/s.svg#a)" mask="url(\\68ttps//x/#m)" clip-path="url(#c)"/></svg>'
            + '<form id="f" action="https://x.example/" method="post" target="_top"><button id="b" formaction="https://x.example/" popovertarget="p" commandfor="d" command="show-modal" onclick="x()">b</button></form>');
        expect(fragment.getElementById('r')!.getAttributeNames()).toEqual(['id', 'fill', 'clip-path']);
        expect(fragment.getElementById('f')!.getAttributeNames()).toEqual(['id']);
        expect(fragment.getElementById('b')!.getAttributeNames()).toEqual(['id']);
    });

    it('the lists themselves: no element that instances, loads or animates content; no handler, and no URL attribute but the governed ones', () => {
        for (const name of ['use', 'marker', 'image', 'feImage', 'filter', 'foreignObject', 'script', 'animate', 'set', 'textPath']) expect(RENDER_ELEMENTS.svg as readonly string[]).not.toContain(name);
        expect(RENDER_ELEMENTS.svg.filter(name => name.startsWith('fe'))).toEqual([]);
        for (const name of ['iframe', 'object', 'embed', 'script', 'template', 'meta', 'base', 'noscript', 'canvas', 'slot', 'selectedcontent']) expect(RENDER_ELEMENTS.html as readonly string[]).not.toContain(name);
        const every = [...RENDER_ATTRIBUTES.html, ...Object.values(RENDER_ATTRIBUTES.htmlElements).flat(), ...RENDER_ATTRIBUTES.svg, ...RENDER_ATTRIBUTES.svgLink, ...RENDER_ATTRIBUTES.mathml];
        expect(every.filter(name => name.startsWith('on'))).toEqual([]);
        for (const name of ['action', 'formaction', 'method', 'target', 'popover', 'popovertarget', 'commandfor', 'command', 'autofocus', 'background', 'cursor', 'filter', 'marker-start', 'marker-mid', 'marker-end']) expect(every).not.toContain(name);
        // the HTML attributes that hold a URL are exactly the governed ones, and a/area href (which become INERT_HREF)
        const urlish = ['src', 'srcset', 'poster', 'href', 'cite', 'data', 'action', 'formaction', 'manifest', 'longdesc', 'codebase', 'background', 'ping', 'itemtype'];
        const holders = Object.entries(RENDER_ATTRIBUTES.htmlElements).flatMap(([element, names]) => names.filter(name => urlish.includes(name)).map(name => `${element} ${name}`)).sort();
        expect(holders).toEqual([...RENDER_URL_ATTRIBUTES.map(([e, a]) => `${e} ${a}`), 'a href', 'area href'].sort());
    });
});

describe('broad review ST2: the renderer counts what it keeps against the room it is given', () => {
    it('throws VIEW_MAX_ELEMENTS past the element room and VIEW_MAX_DEPTH past the depth room, before the caller inserts anything; unwrapped and removed elements are not counted', () => {
        const run = (html: string, room: { elements: number; depth: number }) => {
            const template = document.createElement('template');
            template.innerHTML = html;
            return sanitizeRender(template.content, () => null, () => false, RENDER_RULES, KEEP_ALL, room);
        };
        expect(run('<p></p>'.repeat(10), { elements: 10, depth: 5 })).toBe(10);
        expect(() => run('<p></p>'.repeat(11), { elements: 10, depth: 5 })).toThrowError(new RangeError('VIEW_MAX_ELEMENTS'));
        expect(run('<center><p></p></center>'.repeat(10) + '<svg><use/><use/></svg>', { elements: 11, depth: 5 })).toBe(11);
        expect(run('<div><div><div><div><div></div></div></div></div></div>', { elements: 10, depth: 5 })).toBe(5);
        expect(() => run('<div><div><div><div><div><div></div></div></div></div></div></div>', { elements: 10, depth: 5 })).toThrowError(new RangeError('VIEW_MAX_DEPTH'));
        expect(run('<center><center><div><div><div><div><div></div></div></div></div></div></center></center>', { elements: 10, depth: 5 })).toBe(5);
        expect([RENDER_RULES.maxElements, RENDER_RULES.maxDepth]).toEqual([VIEW_MAX_ELEMENTS, VIEW_MAX_DEPTH]);
        expect([VIEW_MAX_ELEMENTS, VIEW_MAX_DEPTH]).toEqual([50000, 256]);
    });
});

describe('the view bootstrap: budgets (broad review ST2, ST3)', () => {
    const originalWorker = (globalThis as any).Worker;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
    });

    // Starts the bootstrap in this document with a fake Worker; returns the worker's end of the render port. `maxElements`
    // replaces the element budget in the bootstrap's literal: the budget test counts the same way at 500 elements as at
    // VIEW_MAX_ELEMENTS (50 000), which costs 1.6 s of jsdom DOM work idle and can time out under load. The shipped
    // literal holds VIEW_MAX_ELEMENTS (asserted below), and the e2e budget tests (broad-strict.spec.ts, BR:ST2) render
    // the real 50 000 in every engine.
    const startView = (maxElements = VIEW_MAX_ELEMENTS) => {
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            constructor() { workers.push({ transfer: [] }); }
            postMessage(_message: unknown, transfer: MessagePort[]) { workers[workers.length - 1]!.transfer = transfer; }
        };
        const options = { ...VIEW_OPTIONS, render: { ...VIEW_OPTIONS.render, maxElements } };
        new Function(maxElements === VIEW_MAX_ELEMENTS ? viewBootstrapText() : viewBootstrapSource(options))();
        const a = new MessageChannel(), b = new MessageChannel();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '<div id="a"></div><div id="b"></div>' }, source: window, ports: [a.port1, b.port1] }));
        const render = workers[0]!.transfer[1]!;
        const received: any[] = [];
        render.onmessage = (event) => received.push(event.data);
        render.postMessage({ type: 'VIEW_STARTED' });
        return { render, received };
    };
    const until = async (check: () => boolean) => {
        for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
        expect(check()).toBe(true);
    };
    const acks = (received: any[]) => received.filter(m => m.type === 'VIEW_ACK');

    it('a render past the element budget, counted over the resulting document, is dropped and acknowledged with the reason; the next one applies; replacing a target frees its elements', async () => {
        expect(VIEW_OPTIONS.render.maxElements).toBe(VIEW_MAX_ELEMENTS); // the shipped budget; this test runs the same code at 500
        const BUDGET = 500;
        const { render, received } = startView(BUDGET);
        render.postMessage({ type: 'VIEW_RENDER', html: '<p>'.repeat(BUDGET - 4), into: 'a' });
        await until(() => acks(received).length === 1);
        expect(document.body.getElementsByTagName('*').length).toBe(BUDGET - 2);
        render.postMessage({ type: 'VIEW_RENDER', html: '<p></p><p></p><p></p>', into: 'b' }); // one too many
        await until(() => acks(received).length === 2);
        expect(acks(received)[1]).toEqual({ type: 'VIEW_ACK', refused: ['VIEW_MAX_ELEMENTS'] });
        expect(document.getElementById('b')!.children.length).toBe(0);
        render.postMessage({ type: 'VIEW_RENDER', html: '<p></p><p></p>', into: 'b' }); // exactly the budget
        await until(() => acks(received).length === 3);
        expect(acks(received)[2]).toEqual({ type: 'VIEW_ACK' });
        expect(document.body.getElementsByTagName('*').length).toBe(BUDGET);
        render.postMessage({ type: 'VIEW_RENDER', html: '<p></p>', into: 'a' }); // replaces a's elements
        await until(() => acks(received).length === 4);
        render.postMessage({ type: 'VIEW_RENDER', html: '<p></p>'.repeat(100), into: 'b' });
        await until(() => document.getElementById('b')!.children.length === 100);
        render.close();
    });

    it('an event detail shares one character budget across its strings and says when it was cut; a small one is whole', async () => {
        const { render, received } = startView();
        render.postMessage({ type: 'VIEW_LISTEN', types: ['submit'] });
        const value = 'v'.repeat(VIEW_EVENT_LIMITS.maxString + 10);
        document.body.insertAdjacentHTML('beforeend', `<form id="big">${Array.from({ length: 10 }, (_, i) => `<input name="f${i}" value="${value}">`).join('')}</form><form id="small"><input name="q" value="hello"></form>`);
        await new Promise(resolve => setTimeout(resolve, 20));
        (document.getElementById('big') as HTMLFormElement).requestSubmit();
        (document.getElementById('small') as HTMLFormElement).requestSubmit();
        await until(() => received.filter(m => m.type === 'VIEW_EVENT').length === 2);
        const [big, small] = received.filter(m => m.type === 'VIEW_EVENT').map(m => m.detail);
        const chars = (d: any) => [d.target.tag, d.target.id, d.target.name, d.target.value, ...d.ids, ...d.form.flat()].join('').length;
        expect(chars(big)).toBe(VIEW_EVENT_LIMITS.maxTotal);
        expect(big.truncated).toBe(true);
        expect(big.form.every(([, v]: [string, string]) => v.length <= VIEW_EVENT_LIMITS.maxString)).toBe(true);
        expect(small).toEqual({ type: 'submit', ids: ['small'], target: { tag: 'form', id: 'small', name: '', value: '', checked: false }, form: [['q', 'hello']] });
        expect(VIEW_EVENT_LIMITS.maxTotal).toBe(VIEW_RENDER_MAX_LENGTH);
        render.close();
    });
});

describe('review round 1: R1-2, the renderer is linear and keeps no element whose layout is super-linear', () => {
    it('wbr, ruby, rt and rp are unwrapped: their text stays, joined into one text node per run', () => {
        const fragment = sanitize('<p id="p">' + 'x<wbr>'.repeat(5) + '<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby></p>');
        const p = fragment.querySelector('#p')!;
        expect(p.childNodes).toHaveLength(1);
        expect(p.textContent).toBe('xxxxx漢(kan)');
        for (const name of ['wbr', 'ruby', 'rt', 'rp']) expect((RENDER_ELEMENTS.html as readonly string[]).includes(name), name).toBe(false);
    });

    it('text around unwrapped and removed elements is one node; comments are dropped; kept elements stay in order', () => {
        const fragment = sanitize('a<!-- c --><center>b<font>c</font></center><script>x</script>d<span>e</span>f<!--g-->');
        expect(serialise(fragment)).toBe('abcd<span>e</span>f');
        expect(Array.from(fragment.childNodes).map(n => n.nodeType)).toEqual([3, 1, 3]);
    });

    // Scaling, not wall-clock time (R2:C-12: a fixed bound can fail under a loaded full suite): the walk
    // over 8 times as many siblings takes at most ~8 times as long, the best of 3 runs of each size against noise. A walk
    // quadratic in the siblings (R1:R1-2) takes ~64 times as long. jsdom; the browsers' own measure: view-budget.spec.ts.
    it('many siblings to drop or unwrap: the walk takes time linear in their number (1 000 against 8 000 of each)', { timeout: 60000 }, () => {
        const markup = (n: number) => '<p>' + 'x<wbr>'.repeat(n) + '<font>y</font>'.repeat(n) + '<script></script>'.repeat(n) + '</p>';
        const best = (n: number) => {
            const text = markup(n);
            let fastest = Infinity;
            for (let run = 0; run < 3; run++) {
                const template = document.createElement('template');
                template.innerHTML = text;
                const started = performance.now();
                sanitizeRender(template.content, () => null, () => false, RENDER_RULES, KEEP_ALL);
                fastest = Math.min(fastest, performance.now() - started);
                expect(template.content.querySelector('p')!.childNodes).toHaveLength(1);
            }
            return fastest;
        };
        const small = best(1000);
        const large = best(8000);
        expect(large / small, `best of 3: ${small.toFixed(1)} ms for 1 000, ${large.toFixed(1)} ms for 8 000`).toBeLessThan(24); // linear: ~8; quadratic: ~64
    });
});
