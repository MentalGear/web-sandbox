import { describe, it, expect, vi, afterEach } from 'vitest';
import { inSandboxView, inStrictWorker, RENDER_REMOVED_ELEMENTS, RENDER_RULES, sanitizeRender, VIEW_OPTIONS, viewBootstrapText } from './in-sandbox-view';
import { REFERENCES } from './markup-references';
import { VIOLATION_EVENT_LIMIT } from './violation';

/** Parses `html` into an inert fragment the way the view does, and runs the renderer on it. */
function sanitize(html: string, files: Record<string, string> = {}) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const minted = new Set(Object.values(files));
    sanitizeRender(template.content, (path) => files[path] ?? null, (url) => minted.has(url), RENDER_RULES);
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
        expect(left).toEqual(['svg', 'foreignObject', 'math', 'annotation-xml']);
    });

    it('keeps a <link> only as a stylesheet or icon whose href is a URL the view minted', () => {
        const files = { 'site.css': 'blob:null/css', 'icon.svg': 'blob:null/icon' };
        const fragment = sanitize([
            '<link id="sheet" rel="stylesheet" href="site.css">',
            '<link id="icon" rel="icon" href="./icon.svg">',
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
    const files = { 'img/logo.svg': 'blob:null/logo', 'clip.mp4': 'blob:null/clip', 'subs.vtt': 'blob:null/subs' };

    it('resolves the reference attributes of markup-references.ts (minus script) like a browser would against vfs.invalid/index.html', () => {
        const fragment = sanitize([
            '<img id="a" src="img/logo.svg"><img id="b" src="./img/logo.svg"><img id="c" src="/img/logo.svg"><img id="d" src="x/../img/logo.svg">',
            '<img id="e" src="img/Logo.svg"><img id="f" src="img/logo.svg?v=2"><img id="g" src="https://cdn.example/img/logo.svg">',
            '<video id="v" src="clip.mp4" poster="img/logo.svg"><source id="s" src="clip.mp4"><track id="t" src="subs.vtt"></video><audio id="au" src="clip.mp4"></audio>',
        ].join(''), files);
        const src = (id: string, attribute = 'src') => fragment.getElementById(id)!.getAttribute(attribute);
        expect(['a', 'b', 'c', 'd'].map(id => src(id))).toEqual(Array(4).fill('blob:null/logo'));
        expect(['e', 'f', 'g'].map(id => src(id))).toEqual(['img/Logo.svg', 'img/logo.svg?v=2', 'https://cdn.example/img/logo.svg']);
        expect([src('v'), src('v', 'poster'), src('s'), src('t'), src('au')]).toEqual(['blob:null/clip', 'blob:null/logo', 'blob:null/clip', 'blob:null/subs', 'blob:null/clip']);
        // derived from the default-mode table, never a copy
        expect(RENDER_RULES.references).toEqual(REFERENCES.filter(([element]) => element !== 'script'));
    });

    it('removes every attribute holding a blob: URL the view did not mint, however it is written; keeps a minted one on a reference attribute', () => {
        const fragment = sanitize([
            '<img id="minted" src="img/logo.svg">',
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
        expect([has('foreign', 'src'), has('spaced', 'src'), has('upper', 'src'), has('anchor', 'href'), has('styled', 'style'), has('srcset', 'srcset'), has('data', 'data-x')]).toEqual(Array(7).fill(false));
    });

    it('forces referrerpolicy="no-referrer" on a, area, img and link and wherever it is set; drops ping; keeps only noopener, noreferrer, nofollow in rel', () => {
        const fragment = sanitize([
            '<a id="a" href="https://x.example/" ping="https://evil.example/ping" rel="opener prefetch noopener nofollow" referrerpolicy="unsafe-url">a</a>',
            '<map><area id="area" href="https://x.example/" referrerpolicy="unsafe-url" rel="noreferrer external"></map>',
            '<img id="img" src="https://x.example/i.png" referrerpolicy="unsafe-url"><img id="plain" src="https://x.example/j.png">',
            '<svg><a id="svga" href="https://x.example/" referrerpolicy="unsafe-url"><rect/></a><image id="svgimage" href="https://x.example/k.png" referrerpolicy="unsafe-url"/></svg>',
        ].join(''));
        const attribute = (id: string, name: string) => fragment.getElementById(id)!.getAttribute(name);
        expect(['a', 'area', 'img', 'plain', 'svga', 'svgimage'].map(id => attribute(id, 'referrerpolicy'))).toEqual(Array(6).fill('no-referrer'));
        expect(attribute('a', 'ping')).toBeNull();
        expect([attribute('a', 'rel'), attribute('area', 'rel')]).toEqual(['noopener nofollow', 'noreferrer']);
    });
});

describe('the renderer reads elements through the prototypes, not the instance (DOM clobbering)', () => {
    it('a form whose controls shadow the methods it uses is still cleaned', () => {
        const names = ['getAttributeNames', 'getAttribute', 'localName', 'namespaceURI', 'remove', 'hasAttribute', 'setAttribute', 'removeAttribute'];
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
        sanitizeRender(template.content, () => null, () => false, RENDER_RULES);
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
});

describe('the strict worker prelude (unit; the e2e specs cover it in real workers)', () => {
    it('removes Worker, SharedWorker, URL.createObjectURL and (without scriptUnsafe) WebAssembly; render() validates; an untrusted INIT is ignored', () => {
        // run as stringified, with globalThis bound to a stand-in global (a real EventTarget), so the test realm is untouched
        const w = new EventTarget() as any;
        const fakeUrl = { createObjectURL: () => 'blob:x' };
        Object.assign(w, { Worker: function () {}, SharedWorker: function () {}, WebAssembly: {}, URL: fakeUrl });
        const attached: unknown[] = [];
        const run = new Function('globalThis', `return (${inStrictWorker.toString()})`)(w);
        run({ attach: (port: unknown) => attached.push(port) }, { scriptUnsafe: false, maxRender: 10, maxTarget: 5, entryDoneName: '__testEntryDone', eventTypes: ['click', 'keydown'] });
        expect(['Worker', 'SharedWorker', 'WebAssembly'].filter(name => name in w)).toEqual([]);
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
