import { describe, it, expect, afterEach } from 'vitest';
import { cssLoadBound, inSandboxView, INERT_HREF, isStyleProperty, RENDER_ATTRIBUTES, RENDER_CROSSORIGIN_ELEMENTS, RENDER_ELEMENTS, RENDER_NETWORK_DROPPED, RENDER_RULES, RENDER_URL_ATTRIBUTES, sanitizeRender, VIEW_OPTIONS, viewBudget, viewInputOutbox, type RenderContext, type RenderSwitches, type ViewOptions } from '@src/lib/in-sandbox-view';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { cssReferences, dropNetworkCss, withoutNetworkReferences } from '@src/lib/css-references';
import { FileStore, viewStylesheets, type FileSnapshotEntry } from '@src/lib/files';

/**
 * Strict mode's view makes no load with credentials (S74, BD2:ISO-2, docs/research/21_crossorigin_loads/README.md; class A, a browser choice taken by construction).
 * The browser chooses the credentials of an element's load and of CSS's own; the renderer takes that choice instead of
 * predicting it: every element that loads is given crossorigin="anonymous" before it is connected
 * (RENDER_CROSSORIGIN_ELEMENTS), and the loads no attribute reaches (a poster in Firefox, everything CSS names) keep no
 * network URL. The engines' side, with a cookie listener, is test/e2e/view-credentials.spec.ts.
 */

const KEEP_ALL: RenderSwitches = { animations: true, autoplay: true, stylesheets: true };
const LISTED = 'https://cdn.example';
const ORIGINS = { images: [LISTED], media: [LISTED], styles: [LISTED], fonts: [LISTED] };

function render(html: string, target = 'body', files: Record<string, { url: string; type: string }> = {}, origins: Record<string, readonly string[]> = ORIGINS) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const minted = new Set(Object.values(files).map(file => file.url));
    const context: RenderContext = { target, animating: [], origins, refused: [], urls: 0, loads: [], css: [] };
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

describe('no exception to the forced crossorigin: whatever the view is given as origins, every element that loads gets it (S74)', () => {
    // An origin listed in every kind, and a key that is no kind (a host of another version could send one): neither makes
    // an element load without CORS, or keeps a network URL in CSS or a poster.
    const OTHER = 'https://other.example';
    const EVERYTHING = { images: [LISTED, OTHER], media: [LISTED, OTHER], styles: [LISTED, OTHER], fonts: [LISTED, OTHER], withoutCors: [LISTED, OTHER] };
    const MARKUP = `<img src="${OTHER}/a.png"><img crossorigin="use-credentials" src="${OTHER}/b.png" srcset="${OTHER}/b.png 2x"><img alt="c">`
        + `<picture><source srcset="${OTHER}/p.png"><img src="${OTHER}/d.png"></picture><audio src="${OTHER}/e.mp3" crossorigin></audio>`
        + `<video src="${OTHER}/f.mp4" poster="${OTHER}/p.png"><source src="${OTHER}/s.mp4"><track src="${OTHER}/t.vtt"></video>`
        + `<p style="background: url(${OTHER}/a.png)">x</p><style>@import "${OTHER}/i.css"; @font-face { src: url(${OTHER}/f.woff2) }</style>`;
    /** The elements of RENDER_CROSSORIGIN_ELEMENTS the fragment holds without crossorigin="anonymous", and any network URL left in CSS or a poster. */
    const exceptions = (fragment: DocumentFragment) => [
        ...[...fragment.querySelectorAll(RENDER_CROSSORIGIN_ELEMENTS.join(','))].filter(element => element.getAttribute('crossorigin') !== 'anonymous').map(element => `${element.localName} without the attribute`),
        ...[...fragment.querySelectorAll('[poster]')].map(element => `poster ${element.getAttribute('poster')}`),
        ...[...fragment.querySelectorAll('[style], style')].filter(element => /https?:/.test(element.getAttribute('style') ?? element.textContent ?? '')).map(element => `${element.localName} keeps a network URL`),
    ];
    const renderWith = (rules: typeof RENDER_RULES, target = 'body') => {
        const template = document.createElement('template');
        template.innerHTML = MARKUP;
        const context: RenderContext = { target, animating: [], origins: EVERYTHING, refused: [], urls: 0, loads: [], css: [] };
        sanitizeRender(template.content, () => null, () => false, dropNetworkCss, rules, KEEP_ALL, undefined, context);
        return { fragment: template.content, context };
    };

    it('every kept img, video, audio and link has crossorigin="anonymous"; no poster or CSS keeps a network URL; the element loads still go out', () => {
        for (const target of ['body', 'div', 'video', 'picture']) {
            const { fragment, context } = renderWith(RENDER_RULES, target);
            expect(fragment.querySelectorAll(RENDER_CROSSORIGIN_ELEMENTS.join(',')).length, target).toBe(6);
            expect(exceptions(fragment), target).toEqual([]);
            expect(context.loads, target).toContain(`${OTHER}/a.png`);
        }
    });

    it('positive control: the same check finds the exceptions a renderer without the rule would leave', () => {
        const { fragment } = renderWith({ ...RENDER_RULES, crossOrigin: [], networkDropped: [] });
        expect(exceptions(fragment)).toEqual([
            'img without the attribute', 'img without the attribute', 'img without the attribute', 'img without the attribute',
            'audio without the attribute', 'video without the attribute', 'poster https://other.example/p.png',
        ]);
        const template = document.createElement('template');
        template.innerHTML = `<p style="background: url(${OTHER}/a.png)">x</p>`;
        expect(exceptions(template.content)).toEqual(['p keeps a network URL']);
    });

    it('the renderer reads no list but the kinds from its origins: a key that is no kind changes nothing it does', () => {
        const source = sanitizeRender.toString();
        expect(source).not.toMatch(/withoutCors|corsFree/);
        const without = renderWith(RENDER_RULES);
        const template = document.createElement('template');
        template.innerHTML = MARKUP;
        const context: RenderContext = { target: 'body', animating: [], origins: { images: EVERYTHING.images, media: EVERYTHING.media, styles: EVERYTHING.styles, fonts: EVERYTHING.fonts }, refused: [], urls: 0, loads: [], css: [] };
        sanitizeRender(template.content, () => null, () => false, dropNetworkCss, RENDER_RULES, KEEP_ALL, undefined, context);
        const serialise = (fragment: DocumentFragment) => [...fragment.childNodes].map(node => (node as Element).outerHTML ?? node.textContent).join('');
        expect(serialise(without.fragment)).toBe(serialise(template.content));
        expect(without.context.refused).toEqual(context.refused);
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

    // BD4:TST-2: a scheme is read as the URL parser reads it (isNetwork); a tab or newline inside it is removed by that
    // parser, and the engines load the result (Chromium, Firefox and WebKit each requested these in the S74 board's probe).
    it('the scheme is read as the URL parser reads it: a tab, newline or carriage return inside it, written raw or as a CSS escape, is still a network URL', () => {
        expect(network('a{b:"ht\ttps://x/1"}')).toEqual([['image', 'ht\ttps://x/1']]); // a raw tab
        expect(network('a{b:"h\nttps://x/2"}')).toEqual([]); // a raw newline ends the string badly: no string token, and no load
        expect(network('a{b:"ht\\9 tps://x/3"}')).toEqual([['image', 'ht\ttps://x/3']]); // \9, \a and \d are a tab, a newline and a CR
        expect(network('a{b:"ht\\a tps://x/4"}')).toEqual([['image', 'ht\ntps://x/4']]);
        expect(network('a{b:image-set("h\\d ttps://x/5" 1x)}')).toEqual([['image', 'h\rttps://x/5']]);
        expect(network('a{b:url("ht\ttp://x/6")}')).toEqual([['image', 'ht\ttp://x/6']]);
        expect(network('a{b:"\t \u0001HTTPS://x/7"}')).toEqual([['image', '\t \u0001HTTPS://x/7']]); // leading controls and spaces, any case
        // the same text through the drop: nothing of it is left for the engine to load
        const dropped: [string, string][] = [];
        expect(withoutNetworkReferences('a{b:"ht\\9 tps://x/3"}', cssReferences, dropped as any)).toBe('a{b:""}');
        expect(dropped).toEqual([['image', 'ht\ttps://x/3']]);
    });

    it('agrees with the URL parser: a value is a network reference exactly when `new URL(value, "about:blank")` is http: or https:', () => {
        const values = ['https://x/a', 'HtTpS://x/a', 'ht\ttps://x/a', 'h\nt\rtps://x/a', '\t https://x/a', '\u0001\u0002https://x/a', ' https://x/a ', 'http:x', 'https:/x', 'blob:null/a', 'data:,x', 'javascript:x', 'ftp://x/a', 'x.png', '//x/a', '/x/a', 'ht tps://x/a', 'https\u00a0://x/a', 'https\u0000://x/a'];
        for (const value of values) {
            const expected = (() => { try { return /^https?:$/.test(new URL(value, 'about:blank').protocol); } catch { return false; } })();
            // a raw newline ends a CSS string badly, so every control character is written as a hex escape
            const escaped = `a{b:"${[...value].map(ch => (ch.charCodeAt(0) < 32 ? `\\${ch.charCodeAt(0).toString(16)} ` : ch === '"' ? '\\"' : ch === '\\' ? '\\\\' : ch)).join('')}"}`;
            expect(cssReferences(escaped, 'network').length > 0, JSON.stringify(value)).toBe(expected);
        }
    });

    // BD4:TST-6: `@import src("https://…")` (CSS Values 4's other <url>); no engine loads it in an @import today, so this is
    // the scan being ready for the day one does, as it is for the first token that is a string or url().
    it('@import takes its URL from the first token, a string, url() or any function such as src(); a later token names nothing', () => {
        expect(network('@import url("https://x/1.css"); @import "https://x/2.css";')).toEqual([['style', 'https://x/1.css'], ['style', 'https://x/2.css']]);
        expect(network('@import src("https://x/3.css");')).toEqual([['style', 'https://x/3.css']]);
        expect(network('@import src("https://x/4.css") layer(a) supports(display: grid);')).toEqual([['style', 'https://x/4.css']]);
        expect(network('@import src(url("https://x/5.css")) screen;')).toEqual([['style', 'https://x/5.css']]);
        expect(network('@import image-set("https://x/6.css" 1x);')).toEqual([['style', 'https://x/6.css']]);
        expect(network('@import src("https://x/7.css"); a { b: url(https://x/8.png) }')).toEqual([['style', 'https://x/7.css'], ['image', 'https://x/8.png']]); // the rule after it is an image again
        expect(network('@import layer(a) src("https://x/9.css");')).toEqual([]); // not the first token: no engine reads it as the URL
        const dropped: [string, string][] = [];
        expect(withoutNetworkReferences('@import src("https://x/3.css") layer(a);', cssReferences, dropped as any)).toBe('@import src("") layer(a);');
        expect(dropped).toEqual([['style', 'https://x/3.css']]);
        expect(cssReferences('@import src("x.css");', 'files')).toEqual([]); // the files scope is as it was
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

    async function startView(origins: Record<string, readonly string[]> = ORIGINS) {
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
            new Function(`(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${viewBudget.toString()}, ${cssLoadBound.toString()}, ${cssReferences.toString()}, ${withoutNetworkReferences.toString()}, ${JSON.stringify(options)}, ${viewInputOutbox.toString()}, ${isStyleProperty.toString()});`)();
        } finally {
            window.addEventListener = add;
        }
        const logic = new MessageChannel(), view = new MessageChannel();
        const violations: [string, string][] = [];
        view.port2.onmessage = (event) => { if (event.data?.type === 'VIOLATION') violations.push([event.data.directive, event.data.blockedURI]); };
        const html = '<div id="a"></div><style id="s"></style><svg><style id="v"></style></svg>';
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html, allowAnimations: true, origins }, source: window, ports: [logic.port1, view.port1] }));
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

    it('set({ css }): each value without network URLs, as a style attribute the renderer keeps, whatever the view was given as origins', async () => {
        const FREE = 'https://free.example';
        const { send, violations, close } = await startView({ ...ORIGINS, images: [LISTED, FREE], withoutCors: [FREE] });
        const style = () => document.getElementById('a')!.style;
        await send({ type: 'VIEW_SET', id: 'a', css: { cursor: `url(${LISTED}/c.png), auto`, '--bg': `url("${LISTED}/b.png")`, '--e': `\\75 rl(${LISTED}/e.png)`, '--s': `image-set("${LISTED}/s.png" 1x)` } });
        for (const name of ['cursor', '--bg', '--e', '--s']) expect(style().getPropertyValue(name)).not.toContain(LISTED);
        expect(violations).toEqual([['img-src', `${LISTED}/c.png`], ['img-src', `${LISTED}/b.png`], ['img-src', `${LISTED}/e.png`], ['img-src', `${LISTED}/s.png`]]);
        await send({ type: 'VIEW_SET', id: 'a', css: { cursor: `url(${FREE}/c.png), auto` } });
        expect(style().getPropertyValue('cursor')).not.toContain(FREE);
        expect(violations.length).toBe(5);
        expect(violations[4]).toEqual(['img-src', `${FREE}/c.png`]);
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
