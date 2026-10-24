import { describe, it, expect, afterEach } from 'vitest';
import { cssLoadBound, inSandboxView, INERT_HREF, RENDER_ATTRIBUTES, RENDER_CROSSORIGIN_ELEMENTS, RENDER_ELEMENTS, RENDER_NETWORK_DROPPED, RENDER_RULES, RENDER_URL_ATTRIBUTES, sanitizeRender, VIEW_OPTIONS, viewBudget, type RenderContext, type RenderSwitches, type ViewOptions } from '@src/lib/in-sandbox-view';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { cssReferences, dropNetworkCss, withoutNetworkReferences } from '@src/lib/css-references';
import { FileStore, viewStylesheets, type FileSnapshotEntry } from '@src/lib/files';

/**
 * Strict mode's view makes no load with credentials (S74, BD2:ISO-2; class A, a browser choice taken by construction).
 * The browser chooses the credentials of an element's load and of CSS's own; the renderer takes that choice instead of
 * predicting it: every element that loads is given crossorigin="anonymous" before it is connected
 * (RENDER_CROSSORIGIN_ELEMENTS), and the loads no attribute reaches (a poster in Firefox, everything CSS names) keep no
 * network URL. The engines' side, with a cookie listener, is test/e2e/view-credentials.spec.ts.
 */

const KEEP_ALL: RenderSwitches = { animations: true, autoplay: true, stylesheets: true };
const LISTED = 'https://cdn.example';
const ORIGINS = { images: [LISTED], media: [LISTED], styles: [LISTED], fonts: [LISTED] };

function render(html: string, target = 'body', files: Record<string, { url: string; type: string }> = {}, origins: Record<string, readonly string[]> = ORIGINS, targetAnonymous?: boolean) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const minted = new Set(Object.values(files).map(file => file.url));
    const context: RenderContext = { target, targetAnonymous, animating: [], origins, refused: [], urls: 0, loads: [], css: [] };
    sanitizeRender(template.content, path => files[path] ?? null, url => minted.has(url), dropNetworkCss, RENDER_RULES, KEEP_ALL, undefined, context);
    return { fragment: template.content, refused: context.refused };
}

// ---- The enumeration: what loads, by the HTML Standard, and how each load is made without credentials ----------------

/**
 * Every content attribute of HTML whose value the browser fetches, or navigates to (the HTML Standard's index of
 * attributes, the obsolete ones included): the universe the allowlists are checked against, kept here, apart from the
 * renderer's own lists, so that a load the lists let in by mistake shows.
 */
const FETCHING_ATTRIBUTES = ['src', 'srcset', 'imagesrcset', 'poster', 'href', 'data', 'background', 'ping', 'action', 'formaction', 'manifest', 'longdesc', 'lowsrc', 'dynsrc', 'codebase', 'classid', 'archive', 'profile', 'icon', 'itemtype'];

/**
 * For each URL attribute of the renderer, the element whose crossorigin attribute governs the load (the HTML Standard):
 * the element itself, or for <source> and <track>, which have none, the <img> of their <picture> or their media element.
 */
const LOADER: Record<string, readonly string[]> = {
    'img src': ['img'], 'img srcset': ['img'], 'source srcset': ['img'], 'source src': ['video', 'audio'], 'video src': ['video'],
    'video poster': ['video'], 'audio src': ['audio'], 'track src': ['video', 'audio'], 'link href': ['link'],
};

/** Loads whose loader's crossorigin an engine ignores (research 21: Firefox fetches a poster in no-cors mode, with cookies). */
const ATTRIBUTE_IGNORED = ['video poster'];

/** Loads no crossorigin attribute can reach, on any engine: never on an allowlist (research 21). */
const NO_ATTRIBUTE_REACHES = { html: [['td', 'background'], ['th', 'background'], ['table', 'background'], ['input', 'src']], svg: ['image', 'feImage'] } as const;

const kept = (element: string, attribute: string) =>
    attribute.startsWith('data-') || attribute.startsWith('aria-') || (RENDER_ATTRIBUTES.html as readonly string[]).includes(attribute) || (RENDER_ATTRIBUTES.htmlElements[element] ?? []).includes(attribute);
const isUrlAttribute = (element: string, attribute: string) => RENDER_URL_ATTRIBUTES.some(([e, a]) => e === element && a === attribute);
const isDropped = (element: string, attribute: string) => RENDER_NETWORK_DROPPED.some(([e, a]) => e === element && a === attribute);

describe('the renderer makes every load it lets through without credentials, by construction (S74)', () => {
    it('enumeration: every allowlisted HTML attribute that fetches is a URL attribute of the renderer, or a hyperlink made inert', () => {
        const uncovered: string[] = [];
        for (const element of RENDER_ELEMENTS.html) {
            for (const attribute of FETCHING_ATTRIBUTES) {
                if (!kept(element, attribute)) continue;
                const hyperlink = attribute === 'href' && (element === 'a' || element === 'area'); // becomes INERT_HREF (S24)
                if (!hyperlink && !isUrlAttribute(element, attribute)) uncovered.push(`${element} ${attribute}`);
            }
        }
        expect(uncovered).toEqual([]);
        expect(INERT_HREF).toBe('about:blank#');
    });

    it('enumeration: each URL attribute is governed by an element that always gets crossorigin="anonymous", or keeps no network URL', () => {
        const uncovered: string[] = [];
        for (const [element, attribute] of RENDER_URL_ATTRIBUTES) {
            const key = `${element} ${attribute}`;
            const loaders = LOADER[key];
            if (!loaders) {
                uncovered.push(`${key}: a URL attribute this test does not know the loader of`);
                continue;
            }
            const covered = loaders.every(loader => (RENDER_CROSSORIGIN_ELEMENTS as readonly string[]).includes(loader)) && !ATTRIBUTE_IGNORED.includes(key);
            if (!covered && !isDropped(element, attribute)) uncovered.push(key);
        }
        expect(uncovered).toEqual([]);
        // and each element of the list loads through some URL attribute: the list names no element for nothing
        for (const element of RENDER_CROSSORIGIN_ELEMENTS) expect(Object.values(LOADER).some(loaders => loaders.includes(element)), element).toBe(true);
    });

    it('enumeration: the loads no attribute reaches stay off the allowlists: td, th and table background, input src, SVG image and feImage', () => {
        for (const [element, attribute] of NO_ATTRIBUTE_REACHES.html) expect(kept(element, attribute), `${element} ${attribute}`).toBe(false);
        for (const element of NO_ATTRIBUTE_REACHES.svg) expect(RENDER_ELEMENTS.svg as readonly string[]).not.toContain(element);
        // and the renderer agrees: written, they are gone
        const { fragment } = render(`<table background="${LISTED}/t.png"><tr><td background="${LISTED}/d.png">x</td><th background="${LISTED}/h.png">y</th></tr></table><input type="image" src="${LISTED}/i.png"><svg><image href="${LISTED}/s.png"></image><filter><feImage href="${LISTED}/f.png"></feImage></filter></svg>`);
        expect(fragment.querySelectorAll('[background], input[src], image, feImage').length).toBe(0);
    });

    it('behaviour: every URL attribute with a listed network URL, in every place it loads: the loader holds crossorigin="anonymous"', () => {
        const places = [
            ['body', (inner: string) => inner],
            ['picture', (inner: string) => `<picture>${inner}<img alt=""></picture>`],
            ['video', (inner: string) => `<video>${inner}</video>`],
            ['audio', (inner: string) => `<audio>${inner}</audio>`],
        ] as const;
        let networkUrls = 0;
        for (const [element, attribute] of RENDER_URL_ATTRIBUTES) {
            for (const [, wrap] of places) {
                // the guest's own value, the one that would send cookies, is replaced
                const { fragment } = render(wrap(`<${element} crossorigin="use-credentials" ${attribute}="${LISTED}/x"${element === 'link' ? ' rel="icon"' : ''}>`));
                for (const node of Array.from(fragment.querySelectorAll('*'))) {
                    for (const name of node.getAttributeNames()) {
                        if (!isUrlAttribute(node.localName, name) || !/^https?:/i.test(node.getAttribute(name)!)) continue;
                        networkUrls++;
                        const key = `${node.localName} ${name}`;
                        const loader = LOADER[key]!.includes(node.localName) ? node : node.parentElement?.localName === 'picture' ? node.parentElement.querySelector('img') : node.parentElement;
                        // a <source> or <track> outside its <picture> or media element loads nothing
                        if (!loader || !LOADER[key]!.includes(loader.localName)) continue;
                        expect(loader.getAttribute('crossorigin'), key).toBe('anonymous');
                        expect(isDropped(node.localName, name), key).toBe(false);
                    }
                }
                for (const node of Array.from(fragment.querySelectorAll(RENDER_CROSSORIGIN_ELEMENTS.join(',')))) expect(node.getAttribute('crossorigin')).toBe('anonymous');
            }
        }
        expect(networkUrls, 'positive control: listed URLs are kept').toBeGreaterThan(8);
    });

    it('every kept img, video, audio and link has it, with or without a URL, whatever the guest wrote; nothing else gets it', () => {
        const files = { 'own.css': { url: 'blob:null/own-css', type: 'text/css' } };
        const { fragment } = render('<img alt="a"><img crossorigin="use-credentials" alt="b"><video crossorigin></video><audio crossorigin="ANONYMOUS"></audio><link rel="stylesheet" href="own.css"><p crossorigin="anonymous">p</p><source crossorigin="use-credentials">', 'body', files);
        expect(Array.from(fragment.querySelectorAll('[crossorigin]')).map(node => `${node.localName}=${node.getAttribute('crossorigin')}`)).toEqual([
            'img=anonymous', 'img=anonymous', 'video=anonymous', 'audio=anonymous', 'link=anonymous',
        ]);
        expect(fragment.querySelector('link')!.getAttribute('href')).toBe('blob:null/own-css');
    });

    it('a network poster goes, reported, even from a listed origin; a registered one stays', () => {
        const files = { 'p.png': { url: 'blob:null/p', type: 'image/png' } };
        const { fragment, refused } = render(`<video id="n" poster="${LISTED}/p.png#f"></video><video id="r" poster="p.png"></video><video id="h" poster=" HTTP://user:pw@cdn.example/q.png"></video>`, 'body', files);
        expect(fragment.getElementById('n')!.hasAttribute('poster')).toBe(false);
        expect(fragment.getElementById('h')!.hasAttribute('poster')).toBe(false);
        expect(fragment.getElementById('r')!.getAttribute('poster')).toBe('blob:null/p');
        expect(refused).toEqual([['img-src', `${LISTED}/p.png`], ['img-src', 'http://cdn.example/q.png']]);
    });
});

describe('CSS keeps no network URL in the view: style attributes, <style> (HTML and SVG), text() and renders into a style (S74)', () => {
    it('a style attribute: each network url() and image-set() string becomes "", reported with its directive; the rest stays', () => {
        const style = `color: red; background: url(${LISTED}/a.png), image-set("${LISTED}/b.png" 1x, 'r.png' 2x); --u: "${LISTED}/c.png"; list-style: url( HTTPS://x.example/d.png )`;
        const { fragment, refused } = render(`<p id="p" style="${style.replace(/"/g, '&quot;')}">x</p><p id="q" style="color: blue; background: url(r.png)">y</p>`);
        expect(fragment.getElementById('p')!.getAttribute('style')).toBe(`color: red; background: url(""), image-set("" 1x, 'r.png' 2x); --u: ""; list-style: url("")`);
        expect(fragment.getElementById('q')!.getAttribute('style')).toBe('color: blue; background: url(r.png)'); // no network URL: as written
        expect(refused).toEqual([['img-src', `${LISTED}/a.png`], ['img-src', `${LISTED}/b.png`], ['img-src', `${LISTED}/c.png`], ['img-src', 'https://x.example/d.png']]);
    });

    it('a <style>: @import, url(), image-set(), @font-face src, escaped and unclosed forms; each reported with its directive', () => {
        const css = `@import url("${LISTED}/i.css"); @import '${LISTED}/j.css' screen; @font-face { font-family: F; src: url(${LISTED}/f.woff2) format("woff2"), local(F) } i { background: \\75 rl(${LISTED}/e.png); b: url("h\\74tps://cdn.example/g.png") } @namespace svg url(http://www.w3.org/2000/svg); u { background: url(${LISTED}/open.png`;
        const { fragment, refused } = render(`<style id="s">${css}</style>`);
        const text = fragment.getElementById('s')!.textContent!;
        expect(text).not.toMatch(/cdn\.example/);
        expect(text).toContain('@namespace svg url(http://www.w3.org/2000/svg)'); // a name, never fetched
        expect(refused).toEqual([
            ['style-src', `${LISTED}/i.css`], ['style-src', `${LISTED}/j.css`], ['font-src', `${LISTED}/f.woff2`],
            ['img-src', `${LISTED}/e.png`], ['img-src', `${LISTED}/g.png`], ['img-src', `${LISTED}/open.png`],
        ]);
    });

    it('an SVG <style> keeps its own text only: an element in it goes, with its text', () => {
        const { fragment, refused } = render(`<svg><style id="s">a { fill: red }<text id="t">b { background: url(${LISTED}/x.png) }</text><![CDATA[ c { stroke: blue } ]]></style></svg>`);
        const style = fragment.getElementById('s')!;
        expect(style.children.length).toBe(0);
        expect(style.textContent).toBe('a { fill: red } c { stroke: blue } ');
        expect(refused).toEqual([]);
    });

    it('a render into a <style> puts its text there without network URLs, and no element', () => {
        const { fragment, refused } = render(`<b>x</b>i { background: url(${LISTED}/a.png) }`, 'style');
        // the renderer itself keeps the <b>: the view takes the text of a render into a style (inSandboxView, below)
        expect(fragment.querySelector('b')).not.toBeNull();
        expect(refused).toEqual([]);
    });
});

describe('origins.withoutCors: the origins the embedder lets the view load the classic way, and only those', () => {
    const FREE = 'https://free.example';
    const WITH_FREE = { images: [LISTED, FREE], media: [LISTED, FREE], styles: [LISTED, FREE], fonts: [LISTED, FREE], withoutCors: [FREE] };
    const run = (html: string, target = 'body', targetAnonymous?: boolean) => render(html, target, {}, WITH_FREE, targetAnonymous);
    const co = (fragment: DocumentFragment, id: string) => fragment.getElementById(id)!.getAttribute('crossorigin');

    it('an element whose every load is of such an origin gets no crossorigin; any other, and an <img> in a <picture>, does', () => {
        const { fragment } = run(`<img id="a" src="${FREE}/a.png"><img id="b" src="${FREE}/b.png" srcset="${LISTED}/b.png 2x"><img id="c" alt="c">`
            + `<picture><source srcset="${FREE}/p.png"><img id="d" src="${FREE}/d.png"></picture><audio id="e" src="${FREE}/e.mp3"></audio><video id="f" src="${LISTED}/f.mp4"></video>`);
        expect(['a', 'b', 'c', 'd', 'e', 'f'].map(id => co(fragment, id))).toEqual([null, 'anonymous', 'anonymous', 'anonymous', null, 'anonymous']);
    });

    it('a poster and CSS keep a URL of such an origin; every other network URL still goes, reported', () => {
        const { fragment, refused } = run(`<video id="v" poster="${FREE}/p.png"></video><video id="w" poster="${LISTED}/q.png"></video>`
            + `<p id="s" style="background: url(${FREE}/a.png), url(${LISTED}/b.png)">x</p><style id="t">@import "${FREE}/i.css"; @font-face { src: url(${LISTED}/f.woff2) }</style>`);
        expect(fragment.getElementById('v')!.getAttribute('poster')).toBe(`${FREE}/p.png`);
        expect(fragment.getElementById('w')!.hasAttribute('poster')).toBe(false);
        expect(fragment.getElementById('s')!.getAttribute('style')).toBe(`background: url(${FREE}/a.png), url("")`);
        expect(fragment.getElementById('t')!.textContent).toBe(`@import "${FREE}/i.css"; @font-face { src: url("") }`);
        expect(refused).toEqual([['img-src', `${LISTED}/q.png`], ['img-src', `${LISTED}/b.png`], ['font-src', `${LISTED}/f.woff2`]]);
    });

    it('a <source> or <track> loads through its media element: through one without crossorigin, only a URL of such an origin stays', () => {
        const { fragment, refused } = run(`<video id="v" src="${FREE}/v.mp4"><source id="s" src="${LISTED}/s.mp4"><source id="f" src="${FREE}/f.mp4"><track id="t" src="${LISTED}/t.vtt"></video>`
            + `<video id="w" src="${LISTED}/w.mp4"><source id="x" src="${LISTED}/x.mp4"></video>`);
        expect([co(fragment, 'v'), co(fragment, 'w')]).toEqual([null, 'anonymous']);
        expect(['s', 'f', 't', 'x'].map(id => fragment.getElementById(id)!.getAttribute('src'))).toEqual([null, `${FREE}/f.mp4`, null, `${LISTED}/x.mp4`]);
        expect(refused).toEqual([['media-src', `${LISTED}/s.mp4`], ['media-src', `${LISTED}/t.vtt`]]);
        // a fragment's top-level <source> loads through the target: unknown or without the attribute counts as without
        expect(run(`<source id="s" src="${LISTED}/s.mp4">`, 'video').fragment.getElementById('s')!.hasAttribute('src')).toBe(false);
        expect(run(`<source id="s" src="${LISTED}/s.mp4">`, 'video', true).fragment.getElementById('s')!.getAttribute('src')).toBe(`${LISTED}/s.mp4`);
    });

    it('without the list nothing changes: the attribute everywhere, no network URL in CSS or a poster', () => {
        const { fragment } = render(`<img id="a" src="${LISTED}/a.png"><video id="v" src="${LISTED}/v.mp4" poster="${LISTED}/p.png"><source id="s" src="${LISTED}/s.mp4"></video>`);
        expect([co(fragment, 'a'), co(fragment, 'v'), fragment.getElementById('v')!.getAttribute('poster'), fragment.getElementById('s')!.getAttribute('src')]).toEqual(['anonymous', 'anonymous', null, `${LISTED}/s.mp4`]);
    });

    it('a registered stylesheet keeps the URLs of such an origin too', () => {
        const store = new FileStore();
        store.register({ 'a.css': `i { background: url(${FREE}/a.png), url(${LISTED}/b.png) }` });
        const { dropped } = viewStylesheets(store.snapshot(), [FREE]);
        expect(dropped).toEqual([{ path: 'a.css', urls: [`${LISTED}/b.png`], unreadable: null }]);
    });
});

describe('cssReferences, network scope, and withoutNetworkReferences', () => {
    const network = (css: string) => cssReferences(css, 'network').map(reference => [reference.kind, reference.url]);
    it('finds every http: and https: token outside a non-@import prelude, closed or cut off by the end, strings anywhere', () => {
        expect(network(`a{b:url(https://x/1)} c{d:"https://x/2"} @import "http://x/3"; @namespace url(https://x/4); @media (x) { e { f: url(https://x/5 `)).toEqual([
            ['image', 'https://x/1'], ['image', 'https://x/2'], ['style', 'http://x/3'], ['image', 'https://x/5'],
        ]);
        expect(network('a{b:url(r.png); c:url(blob:null/x); d:url(data:,x); e:"\t https:x"}')).toEqual([['image', '\t https:x']]);
        expect(network('a{b:url(https://x/1')).toEqual([['image', 'https://x/1']]);
        expect(network('a{b:"https://x/1')).toEqual([['image', 'https://x/1']]);
    });

    it('withoutNetworkReferences: each becomes "", the rest is as written, and the list says what went', () => {
        const dropped: [string, string][] = [];
        expect(withoutNetworkReferences('a{b:url( https://x/1 ) c:image-set("https://x/2" 1x, url(r.png) 2x)} @import "https://x/3";', cssReferences, dropped as any)).toBe('a{b:url("") c:image-set("" 1x, url(r.png) 2x)} @import "";');
        expect(dropped).toEqual([['image', 'https://x/1'], ['image', 'https://x/2'], ['style', 'https://x/3']]);
        expect(withoutNetworkReferences('a{b:url(r.png)}', cssReferences, [])).toBe('a{b:url(r.png)}');
    });

    it('the files scope is unchanged: closed tokens only, strings only where they name a file', () => {
        expect(cssReferences('a{b:"x.png"; c:url(y.png)} d{e:url(z.png', 'files').map(reference => reference.url)).toEqual(['y.png']);
    });
});

describe('registered stylesheets reach the view without their network URLs (files.ts, viewStylesheets)', () => {
    const encoder = new TextEncoder();
    const snapshot = (files: Record<string, string | Uint8Array>) => {
        const store = new FileStore();
        store.register(files);
        return store.snapshot();
    };
    // what the view assembles from an entry (inSandboxFiles): the registered bytes, each edit's range replaced, a slot by `slot`
    const textOf = (entry: FileSnapshotEntry, slot: string) => {
        const bytes = Uint8Array.from(atob(entry[2]), c => c.charCodeAt(0));
        const edits = entry[3] ?? [];
        const parts: Uint8Array[] = [];
        let at = 0;
        for (let i = 0; i < edits.length; i += 3) {
            parts.push(bytes.subarray(at, edits[i] as number), encoder.encode(Array.isArray(edits[i + 2]) ? slot : edits[i + 2] as string));
            at = edits[i + 1] as number;
        }
        parts.push(bytes.subarray(at));
        return new TextDecoder().decode(new Uint8Array(parts.flatMap(part => [...part])));
    };

    it('network references become "", references to registered files keep their slot, other files pass through', () => {
        const { entries, dropped } = viewStylesheets(snapshot({
            'a.css': `@import "b.css"; @import url(https://cdn.example/x.css); i { background: url(p.png), url("https://cdn.example/é.png") } @font-face { src: url(https://cdn.example/f.woff2) }`,
            'b.css': 'b { color: red }',
            'p.png': new Uint8Array([1, 2, 3]),
        }));
        expect(entries.map(entry => entry[0])).toEqual(['b.css', 'p.png', 'a.css']);
        expect(dropped).toEqual([{ path: 'a.css', urls: ['https://cdn.example/x.css', 'https://cdn.example/é.png', 'https://cdn.example/f.woff2'], unreadable: null }]);
        const a = entries.find(entry => entry[0] === 'a.css')!;
        const slots = a[3]!.filter(edit => Array.isArray(edit));
        expect(slots).toEqual([['b.css'], ['p.png']]);
        expect(textOf(a, '"slot"')).toBe(
            '@import "slot"; @import url(""); i { background: url("slot"), url("") } @font-face { src: url("") }');
    });

    it('a stylesheet the browser could read otherwise than the tokenizer gets no URL: not UTF-8, or an @charset of another encoding', () => {
        const { entries, dropped } = viewStylesheets(snapshot({
            'latin.css': new Uint8Array([...encoder.encode('i { content: "'), 0xe9, ...encoder.encode('" }')]),
            'sjis.css': '@charset "shift_jis"; i { color: red }',
            'utf.css': '@charset "utf-8"; i { color: red }',
            'plain.css': 'i { color: red }',
        }));
        expect(entries.map(entry => entry[0]).sort()).toEqual(['plain.css', 'utf.css']);
        expect(dropped.map(drop => [drop.path, drop.unreadable])).toEqual([['latin.css', 'it is not UTF-8'], ['sjis.css', 'its @charset names an encoding other than UTF-8']]);
    });
});

describe('the view: what an operation puts into a <style>, and a load that fails (inSandboxView)', () => {
    const saved: Record<string, unknown> = {};
    const GLOBALS = ['Worker'];
    afterEach(() => {
        for (const name of GLOBALS) (globalThis as any)[name] = saved[name];
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
    });

    async function startView() {
        for (const name of GLOBALS) saved[name] = (globalThis as any)[name];
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            constructor() { workers.push(this as any); }
            onerror: unknown = null;
            transfer: MessagePort[] = [];
            postMessage(_message: unknown, transfer: MessagePort[]) { this.transfer = transfer; }
        };
        const options: ViewOptions = { ...VIEW_OPTIONS, rates: { characters: 1e9, time: 1e9, urls: 1e9 } };
        const listeners: Record<string, (event: unknown) => void> = {};
        const add = window.addEventListener;
        window.addEventListener = function (this: Window, type: string, listener: any, options?: any) {
            if (type === 'error') listeners[type] = listener;
            return add.call(this, type, listener, options);
        } as typeof window.addEventListener;
        try {
            new Function(`(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${viewBudget.toString()}, ${cssLoadBound.toString()}, ${cssReferences.toString()}, ${withoutNetworkReferences.toString()}, ${JSON.stringify(options)});`)();
        } finally {
            window.addEventListener = add;
        }
        const logic = new MessageChannel(), view = new MessageChannel();
        const violations: [string, string][] = [];
        view.port2.onmessage = (event) => { if (event.data?.type === 'VIOLATION') violations.push([event.data.directive, event.data.blockedURI]); };
        const html = '<div id="a"></div><style id="s"></style><svg><style id="v"></style></svg>';
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html, allowAnimations: true, origins: ORIGINS }, source: window, ports: [logic.port1, view.port1] }));
        const render = workers[0]!.transfer[1]!;
        let acks = 0;
        render.onmessage = (event) => { if (event.data?.type === 'VIEW_ACK') acks++; };
        render.postMessage({ type: 'VIEW_STARTED' });
        const settle = () => new Promise(resolve => setTimeout(resolve, 20));
        const send = async (message: Record<string, unknown>) => {
            const before = acks;
            render.postMessage(message);
            for (let i = 0; i < 400 && acks === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
            await settle();
        };
        const failed = async (target: EventTarget) => {
            listeners['error']!({ isTrusted: true, target });
            await settle();
        };
        return { send, failed, violations, close: () => { render.close(); view.port2.close(); logic.port2.close(); } };
    }

    it('text() into a <style> (HTML or SVG) and a render into one: the text without network URLs, each reported; no element', async () => {
        const { send, violations, close } = await startView();
        await send({ type: 'VIEW_TEXT', text: `i { background: url(${LISTED}/t.png) } @import "${LISTED}/i.css";`, into: 's' });
        expect(document.getElementById('s')!.textContent).toBe('i { background: url("") } @import "";');
        await send({ type: 'VIEW_TEXT', text: `i { background: url(${LISTED}/v.png) }`, into: 'v' });
        expect(document.getElementById('v')!.textContent).toBe('i { background: url("") }');
        await send({ type: 'VIEW_RENDER', html: `<b id="b">x</b>i { background: url(${LISTED}/r.png) }`, into: 's' });
        const style = document.getElementById('s')!;
        expect([style.children.length, style.textContent]).toEqual([0, 'xi { background: url("") }']);
        expect(violations).toEqual([['img-src', `${LISTED}/t.png`], ['style-src', `${LISTED}/i.css`], ['img-src', `${LISTED}/v.png`], ['img-src', `${LISTED}/r.png`]]);
        close();
    });

    it('a kept load that fails is reported with its directive and URL; a blob: one, an untrusted event and other elements are not', async () => {
        const { send, failed, violations, close } = await startView();
        await send({ type: 'VIEW_RENDER', html: `<img id="i" src="${LISTED}/i.png#f"><video id="v"><source id="so" src="${LISTED}/s.mp4"><track id="t" src="${LISTED}/t.vtt"></video><audio id="u" src="${LISTED}/a.mp3"></audio><img id="b" src="r.png"><p id="p">x</p>`, into: 'a' });
        for (const id of ['i', 'so', 't', 'u', 'b', 'p']) await failed(document.getElementById(id)!);
        expect(violations).toEqual([['img-src', `${LISTED}/i.png`], ['media-src', `${LISTED}/s.mp4`], ['media-src', `${LISTED}/t.vtt`], ['media-src', `${LISTED}/a.mp3`]]);
        close();
    });
});
