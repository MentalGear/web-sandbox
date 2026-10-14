import { test, expect, type SandboxDriver } from './fixture';
import { useRecorder } from './recorder';
import { clickInSandbox, inView, waitInView } from './strict-view';
import { VIEW_EVENT_LIMITS, VIEW_MAX_DEPTH, VIEW_MAX_ELEMENTS } from '@src/lib/in-sandbox-view';
import type { SandboxConfig } from '@src/host';

/**
 * Broad review 2026-10-14, strict mode (docs/security/BROAD-REVIEW-2026-10-14.md, reviewer C), where browser
 * behaviour decides:
 *   allowlist  the renderer keeps only allowlisted elements and attributes: what it does not know is gone before
 *              insertion, in every namespace;
 *   ST1        no URL the view mints, and no URL rendered markup keeps, opens as a document that runs script when the
 *              user opens it in a new tab (emulated: a browser-initiated navigation of a new page to it);
 *   ST2        rendered markup cannot fan out: no reference instancing (SVG use, markers), and the view holds at most
 *              VIEW_MAX_ELEMENTS elements, nested at most VIEW_MAX_DEPTH deep; a refused render is dropped and
 *              acknowledged, so the next one still applies;
 *   ST3        one event detail carries at most VIEW_RENDER_MAX_LENGTH characters in all, and says when it was cut;
 *   ST4        an entry that closes its scope cannot take over the marker that ends the entry phase.
 * Evidence (T5): the view's DOM read from outside (strict-view.ts), host lag measured on the host page, new pages
 * read from outside, the recorder's listener, the host's own record of bridge calls; a positive control beside each
 * negative.
 */

const recorder = useRecorder();

const MAX_ELEMENTS = VIEW_MAX_ELEMENTS; // 50 000
const MAX_DEPTH = VIEW_MAX_DEPTH; // 256
const MAX_DETAIL = VIEW_EVENT_LIMITS.maxTotal; // 262 144

const strict = (config: Partial<SandboxConfig> = {}): Partial<SandboxConfig> => ({ mode: 'strict', ...config });

async function render(sandbox: SandboxDriver, browserName: string, html: string, doneId = 'done', into: string | null = null, timeout = 8000) {
    await sandbox.run(`sandboxView.render(${JSON.stringify(html + `<p id="${doneId}">done</p>`)}, ${JSON.stringify(into)})`);
    await waitInView(sandbox.page, browserName, `!!Document.prototype.getElementById.call(document, ${JSON.stringify(doneId)})`, timeout);
}

// Records calls of the host method 'mark' on the host page, outside the sandbox.
async function exposeMark(sandbox: SandboxDriver) {
    await sandbox.page.evaluate(() => { (window as any).marks = []; });
    await sandbox.exposeHost('mark', '(name) => { window.marks.push(String(name)); return true; }');
}
const marks = (sandbox: SandboxDriver) => sandbox.page.evaluate(() => [...(window as any).marks] as string[]);

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

// ---- the allowlist ---------------------------------------------------------------------------------------------

test.describe('the renderer is an allowlist', () => {
    test('elements and attributes outside the allowlist are gone before insertion, in every namespace: unknown HTML elements are unwrapped, unknown SVG and MathML elements removed with their content', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(strict())).toBe('ready');
        const corpus = [
            '<svg id="s" width="10" height="10"><use id="use" href="#r"/><rect id="r" width="5" height="5" fill="url(https://x.example/p.svg#p)" stroke="url(#g)" cursor="url(https://x.example/c.png), auto"/>'
                + '<marker id="mk"><rect/></marker><filter id="flt"><feGaussianBlur stdDeviation="1"/></filter><feImage href="#r"/>'
                + '<image id="svgimage" href="https://x.example/i.png"/><foreignObject><p id="fo-p">x</p></foreignObject><textPath href="#r">t</textPath>'
                + '<linearGradient id="g" href="#g2" x1="0"><stop offset="0" stop-color="red"/></linearGradient><pattern id="pt" href="#pt2" width="2" height="2"/></svg>',
            '<math id="m"><mi id="mi">x</mi><annotation-xml encoding="text/html"><p id="ax-p">x</p></annotation-xml><maction><mi id="maction-mi">y</mi></maction></math>',
            '<center id="center"><b id="in-center">c</b></center><marquee id="mq"><i id="in-mq">m</i></marquee><selectedcontent id="sc"><u id="in-sc">s</u></selectedcontent><x-widget id="custom" data-x="1">custom</x-widget>',
            '<button id="btn" popovertarget="pop" commandfor="dlg" command="show-modal" onclick="void 0" formaction="https://x.example/" type="button">b</button><div id="pop" popover>p</div><dialog id="dlg">d</dialog>',
            '<form id="frm" action="https://x.example/" method="post" target="_top" name="f"><input id="inp" type="image" src="https://x.example/i.png" formaction="https://x.example/" autofocus name="i"></form>',
            '<img id="img" src="https://x.example/i.png" attributionsrc crossorigin="use-credentials" onerror="void 0" style="color:red" class="c" alt="a" width="1">',
            '<img id="dataimg" src="data:image/svg+xml,%3Csvg/%3E" alt="d"><img id="srcsetimg" srcset="https://x.example/a.png 1x, data:image/svg+xml,x 2x" alt="s"><img id="jsimg" src=" java\nscript:void 0" alt="j">',
            '<a id="a" href="https://x.example/" target="_blank" download ping="https://x.example/p" hreflang="en">a</a>',
            '<div id="glob" title="t" aria-label="l" data-k="v" hidden tabindex="0" role="note" lang="en" dir="ltr" contenteditable is="x-y" slot="s" part="p" nonce="n" accesskey="k">g</div>',
        ].join('');
        await render(sandbox, browserName, corpus);
        const read = await inView<any>(page, browserName, `(() => {
            const all = Array.from(document.body.querySelectorAll('*'));
            const attrs = (id) => { const e = document.getElementById(id); return e ? e.getAttributeNames().sort().map((n) => n + '=' + e.getAttribute(n)) : null; };
            return {
                svg: Array.from(document.getElementById('s').querySelectorAll('*')).map((e) => e.localName),
                math: Array.from(document.getElementById('m').querySelectorAll('*')).map((e) => e.localName),
                unwrapped: ['center', 'mq', 'sc'].map((id) => !!document.getElementById(id)),
                kept: ['in-center', 'in-mq', 'in-sc', 'custom', 'fo-p', 'ax-p', 'maction-mi'].map((id) => !!document.getElementById(id)),
                handlers: all.filter((e) => e.getAttributeNames().some((n) => n.toLowerCase().startsWith('on'))).length,
                r: attrs('r'), g: attrs('g'), btn: attrs('btn'), pop: attrs('pop'), frm: attrs('frm'), inp: attrs('inp'), img: attrs('img'),
                dataimg: attrs('dataimg'), srcsetimg: attrs('srcsetimg'), jsimg: attrs('jsimg'), a: attrs('a'), div: attrs('glob'), custom: attrs('custom'),
            };
        })()`);
        expect(read).toEqual({
            svg: ['rect', 'linearGradient', 'stop', 'pattern'],
            math: ['mi'],
            unwrapped: [false, false, false],
            kept: [true, true, true, true, false, false, false],
            handlers: 0,
            r: ['height=5', 'id=r', 'stroke=url(#g)', 'width=5'],
            g: ['id=g', 'x1=0'],
            btn: ['id=btn', 'type=button'],
            pop: ['id=pop'],
            frm: ['id=frm', 'name=f'],
            inp: ['id=inp', 'name=i', 'type=image'],
            img: ['alt=a', 'class=c', 'id=img', 'referrerpolicy=no-referrer', 'src=https://x.example/i.png', 'style=color:red', 'width=1'],
            dataimg: ['alt=d', 'id=dataimg', 'referrerpolicy=no-referrer'],
            srcsetimg: ['alt=s', 'id=srcsetimg', 'referrerpolicy=no-referrer'],
            jsimg: ['alt=j', 'id=jsimg', 'referrerpolicy=no-referrer'],
            a: ['href=about:blank#', 'hreflang=en', 'id=a', 'referrerpolicy=no-referrer'],
            div: ['aria-label=l', 'data-k=v', 'dir=ltr', 'hidden=', 'id=glob', 'lang=en', 'role=note', 'tabindex=0', 'title=t'],
            custom: ['data-x=1', 'id=custom'],
        });
    });

    test('positive control: an everyday UI keeps its elements and attributes: forms and controls, tables, lists, details, media, an inline SVG icon with a gradient, a MathML formula, a custom element', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'logo.png': { base64: PNG_1X1 } });
        expect(await sandbox.mount(strict())).toBe('ready');
        const ui = '<header class="top"><h1 id="t">Title</h1><nav aria-label="main"><ul><li><a id="l" href="#x" rel="noopener">x</a></li></ul></nav></header>'
            + '<main><form id="f" name="f" autocomplete="off"><fieldset><legend>L</legend><label for="n">Name</label><input id="n" name="n" type="text" placeholder="p" required maxlength="20">'
            + '<select id="s" name="s"><optgroup label="g"><option value="1" selected>1</option></optgroup></select><textarea id="ta" name="ta" rows="2"></textarea>'
            + '<input id="c" type="checkbox" name="c" checked><button id="b" type="submit" name="go" value="1">Go</button><output id="o" for="n">0</output></fieldset></form>'
            + '<table><caption>c</caption><thead><tr><th scope="col" colspan="2">h</th></tr></thead><tbody><tr><td rowspan="1">1</td><td>2</td></tr></tbody></table>'
            + '<details id="d" open><summary>s</summary><p>p</p></details><dialog id="dl" open>dlg</dialog><progress id="pr" value="1" max="2"></progress><meter id="me" value="1" min="0" max="2"></meter>'
            + '<figure><picture><img id="logo" src="logo.png" alt="logo" width="1" height="1"></picture><figcaption>f</figcaption></figure><video id="v" controls muted width="10"></video>'
            + '<svg id="icon" viewBox="0 0 10 10" width="10" height="10" role="img" aria-label="i"><defs><linearGradient id="lg"><stop offset="0" stop-color="#000"/></linearGradient></defs><g transform="scale(1)"><path d="M0 0L10 10" stroke="url(#lg)" stroke-width="2"/><circle cx="5" cy="5" r="2" fill="currentColor"/><text x="1" y="9">t</text></g></svg>'
            + '<math display="block"><mfrac><mi>a</mi><mn>2</mn></mfrac></math><my-card id="card" class="k" data-id="7">card</my-card><style>.top { color: blue }</style></main>';
        await render(sandbox, browserName, ui);
        const read = await inView<any>(page, browserName, `(() => {
            const names = Array.from(document.body.querySelectorAll('*')).map((e) => e.localName);
            const attrs = (id) => { const e = document.getElementById(id); return e.getAttributeNames().sort().join(' '); };
            return {
                names,
                n: attrs('n'), s: attrs('s'), c: attrs('c'), b: attrs('b'), f: attrs('f'), d: attrs('d'), dl: attrs('dl'), pr: attrs('pr'), card: attrs('card'), v: attrs('v'), icon: attrs('icon'),
                logo: document.getElementById('logo').getAttribute('src').startsWith('blob:'),
                decoded: document.getElementById('logo').complete && document.getElementById('logo').naturalWidth,
                styled: getComputedStyle(document.querySelector('.top')).color,
            };
        })()`);
        expect(read.names).toEqual(['header', 'h1', 'nav', 'ul', 'li', 'a', 'main', 'form', 'fieldset', 'legend', 'label', 'input', 'select', 'optgroup', 'option', 'textarea', 'input', 'button', 'output',
            'table', 'caption', 'thead', 'tr', 'th', 'tbody', 'tr', 'td', 'td', 'details', 'summary', 'p', 'dialog', 'progress', 'meter', 'figure', 'picture', 'img', 'figcaption', 'video',
            'svg', 'defs', 'linearGradient', 'stop', 'g', 'path', 'circle', 'text', 'math', 'mfrac', 'mi', 'mn', 'my-card', 'style', 'p']);
        expect(read).toMatchObject({
            n: 'id maxlength name placeholder required type', s: 'id name', c: 'checked id name type', b: 'id name type value', f: 'autocomplete id name',
            d: 'id open', dl: 'id open', pr: 'id max value', card: 'class data-id id', v: 'controls id muted width', icon: 'aria-label height id role viewBox width',
            logo: true, styled: 'rgb(0, 0, 255)',
        });
        await expect.poll(() => inView(page, browserName, `document.getElementById('logo').naturalWidth`)).toBe(1);
    });
});

// ---- ST1: nothing the view shows opens as a script-running document ---------------------------------------------

// A document that, if it ever runs as one, marks itself (read from outside) and reaches the blocked listener.
const DOCUMENT = (blocked: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>document.documentElement.setAttribute('data-ran', 'yes'); fetch('${blocked}/st1-ran').catch(() => {});</script></svg>`;

/** Opens `url` in a new page of the same context, as a user's "open in new tab" would (browser-initiated), and reports whether a script ran there. */
async function openInNewTab(page: import('@playwright/test').Page, url: string): Promise<string> {
    const tab = await page.context().newPage();
    try {
        const navigated = await tab.goto(url, { timeout: 5000 }).then(() => 'loaded', (e: Error) => `refused: ${e.message.split('\n')[0]}`);
        await tab.waitForTimeout(500);
        const ran = await tab.evaluate(() => document.documentElement?.getAttribute('data-ran') ?? null).catch(() => null);
        return ran === 'yes' ? 'ran' : navigated.startsWith('refused') ? 'refused' : 'no script';
    } finally {
        await tab.close();
    }
}

test.describe('ST1: nothing the strict view shows opens in a new tab as a document that runs script', () => {
    test('every URL the view mints is of a type that is not a document: registered SVG and XML-typed files get none, and opening every minted URL runs nothing; a PNG renders (positive control)', async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        const doc = b64(DOCUMENT(recorder.blocked));
        const files: Record<string, { base64: string; type?: string }> = {
            'ok.png': { base64: PNG_1X1 },
            'evil.svg': { base64: doc },
            'x.css': { base64: b64('#styled { width: 7px }') },
            'fonts.css': { base64: b64('@font-face { font-family: f; src: url(x.woff2) } #fonted { font-family: f }') },
            'x.woff2': { base64: doc },
            'x.jpg': { base64: doc }, 'x.gif': { base64: doc }, 'x.webp': { base64: doc }, 'x.ico': { base64: doc },
            'x.mp3': { base64: doc }, 'x.mp4': { base64: doc }, 'x.vtt': { base64: doc },
            // the prefix rules of the default-mode table admit these types, and an engine renders a +xml type as XML
            'xml.mp4': { base64: doc, type: 'video/x-st1+xml' },
            'xml.png': { base64: doc, type: 'image/x-st1+xml' },
            'html.mp3': { base64: doc, type: 'audio/x-st1+html' },
        };
        await sandbox.registerFiles(files);
        expect(await sandbox.mount(strict())).toBe('ready');
        const markup = '<img id="ok" src="ok.png"><img id="svg" src="evil.svg"><img src="x.jpg"><img src="x.gif"><img src="x.webp"><img src="x.ico"><img src="xml.png">'
            + '<link rel="stylesheet" href="x.css"><link rel="stylesheet" href="fonts.css"><link rel="icon" href="evil.svg"><i id="styled" style="display:block"></i><i id="fonted">f</i>'
            + '<audio src="x.mp3"></audio><audio src="html.mp3"></audio><video src="x.mp4" poster="evil.svg"><track src="x.vtt"></video><video src="xml.mp4"></video>';
        await render(sandbox, browserName, markup);
        await waitInView(page, browserName, `getComputedStyle(document.getElementById('styled')).width === '7px'`, 8000);
        // every blob: URL the view holds, in attributes and in its stylesheets' text, read from outside
        const minted = await inView<string[]>(page, browserName, `(() => {
            const urls = new Set();
            for (const e of document.querySelectorAll('*')) for (const n of e.getAttributeNames()) { const v = e.getAttribute(n); if (v.startsWith('blob:')) urls.add(v); }
            for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) for (const m of rule.cssText.matchAll(/blob:[^"')\\s]+/g)) urls.add(m[0]); } catch {} }
            return [...urls];
        })()`);
        expect(minted.length).toBeGreaterThanOrEqual(4); // positive control: ok.png, x.css, fonts.css and its font at least
        const opened: Record<string, string> = {};
        for (const url of minted) opened[url] = await openInNewTab(page, url);
        await page.waitForTimeout(500);
        expect(Object.values(opened).filter(outcome => outcome === 'ran')).toEqual([]);
        expect(recorder.paths('blocked')).toEqual([]);
        // the SVG and the +xml/+html types got no URL: their references stay as written
        expect(await inView(page, browserName, `[document.getElementById('svg').getAttribute('src'), document.querySelector('video[poster]').getAttribute('poster')]`)).toEqual(['evil.svg', 'evil.svg']);
        await expect.poll(() => inView(page, browserName, `document.getElementById('ok').naturalWidth`)).toBe(1);
    });

    test('a data: URL never reaches an image load: rendered data: sources are removed, the view policy drops data: from img-src (one warning), and opening what the image holds runs nothing; an allowed remote image loads (positive control)', async ({ sandbox, page, browserName }) => {
        const warnings: string[] = [];
        page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
        expect(await sandbox.mount(strict({ connectionsAllowed: { 'img-src': ['data:', recorder.allowed] } }))).toBe('ready');
        const svg = `data:image/svg+xml,${encodeURIComponent(DOCUMENT(recorder.blocked))}`;
        const png = `data:image/png;base64,${PNG_1X1}`;
        await render(sandbox, browserName, `<img id="d" src="${svg}"><img id="p" src="${png}"><div id="bg" style="width:4px;height:4px;background-image:url('${png}')"></div><img id="ok" src="${recorder.allowed}/st1-ok.svg">`);
        await recorder.waitFor('allowed', '/st1-ok.svg');
        const read = await inView<any>(page, browserName, `({
            policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
            d: document.getElementById('d').getAttribute('src'),
            p: document.getElementById('p').getAttribute('src'),
        })`);
        const imgSrc = /img-src ([^;]*);/.exec(read.policy)?.[1] ?? '';
        expect(imgSrc.split(' ')).not.toContain('data:');
        expect(imgSrc.split(' ')).toContain(recorder.allowed);
        expect(warnings.filter(w => w.includes('data:') && w.includes('img-src'))).toHaveLength(1);
        for (const held of [read.d, read.p]) if (held) expect(await openInNewTab(page, held)).not.toBe('ran');
        expect([read.d, read.p]).toEqual([null, null]);
        // the CSS background, which the renderer does not read, is refused by the policy
        await sandbox.waitForViolation('img-src', 'data', 8000);
        expect(recorder.paths('blocked')).toEqual([]);
        await expect.poll(() => inView(page, browserName, `document.getElementById('ok').naturalWidth`)).toBeGreaterThan(0);
    });
});

// ---- ST2: no fan-out, and a bounded document ---------------------------------------------------------------------

const START_LAG = () => {
    const w = window as any;
    clearInterval(w.lagTimer);
    w.lag = { max: 0, last: performance.now() };
    w.lagTimer = setInterval(() => { const now = performance.now(); w.lag.max = Math.max(w.lag.max, now - w.lag.last - 10); w.lag.last = now; }, 10);
};
const LAG = () => Math.round((window as any).lag.max);

const repeat = (s: string, n: number) => s.repeat(n);
// 10 × 10 × 10 × 10 × 10 instances from about 1 KB (measured before the fix: 5.8–6.5 s of host stall on all three engines)
const USE_FANOUT = (() => {
    let s = '<svg id="fan" width="100" height="100"><defs><g id="a0"><rect width="1" height="1"/></g>';
    for (let i = 1; i <= 5; i++) s += `<g id="a${i}">${repeat(`<use href="#a${i - 1}"/>`, 10)}</g>`;
    return s + '</defs><use href="#a5"/></svg>';
})();
// markers on every vertex of a path inside markers: 12 vertices, five levels (about 1.5 KB)
const MARKER_FANOUT = (() => {
    const path = (m: string) => `<path d="M0 0${repeat(' l1 0', 11)}" fill="none" stroke="black" marker-start="url(#${m})" marker-mid="url(#${m})" marker-end="url(#${m})"/>`;
    let s = '<svg id="fan" width="100" height="100"><defs><marker id="m0" markerWidth="2" markerHeight="2"><rect width="1" height="1"/></marker>';
    for (let i = 1; i <= 5; i++) s += `<marker id="m${i}" markerWidth="20" markerHeight="20">${path(`m${i - 1}`)}</marker>`;
    return s + `</defs>${path('m5')}</svg>`;
})();

test.describe('ST2: one render cannot stall the host by fan-out, and the view holds a bounded document', () => {
    for (const [name, markup] of [['SVG <use>', USE_FANOUT], ['SVG markers', MARKER_FANOUT]] as const) {
        test(`a ${markup.length}-character render that instances its content 10^5 times (${name}) does nothing: nothing instancing is left, and the host's longest stall stays under 500 ms`, async ({ sandbox, page, browserName }) => {
            test.setTimeout(120000);
            expect(await sandbox.mount(strict())).toBe('ready');
            await page.evaluate(START_LAG);
            await render(sandbox, browserName, markup, 'done', null, 90000);
            await page.waitForTimeout(1000);
            const lag = await page.evaluate(LAG);
            console.log(`MEASURED ${browserName} ST2 ${name} lag ${lag} ms`);
            expect(await inView(page, browserName, `document.querySelectorAll('#fan use, #fan marker, #fan symbol').length`)).toBe(0);
            // a 1.5 KB render costs a few milliseconds once nothing instances; 500 ms is far above that on every engine,
            // and far below the measured stall before the fix (5.8–6.5 s for <use>, 1.1–2.9 s for markers)
            expect(lag).toBeLessThan(500);
        });
    }

    test(`the view refuses a render that would hold more than ${MAX_ELEMENTS} elements in all, counted over the resulting document, and still acknowledges it; a large render under the budget applies (positive control); replacing a target counts what it removes`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        expect(await sandbox.mount(strict({ html: '<div id="a"></div><div id="b"></div><div id="c"></div>' }))).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('c')`);
        await page.evaluate(START_LAG);
        await render(sandbox, browserName, repeat('<p>', 45000), 'a-done', 'a', 30000); // 45 001 elements: applies
        const lag = await page.evaluate(LAG);
        console.log(`MEASURED ${browserName} ST2 45000-element render lag ${lag} ms`);
        expect(await inView(page, browserName, `document.body.getElementsByTagName('*').length`)).toBe(45004);
        await sandbox.clearLogs();
        // 10 001 more into b: the document would hold 55 005: refused, b unchanged, and the next render still applies
        await sandbox.run(`sandboxView.render(${JSON.stringify(repeat('<p>', 10000) + '<p id="b-done">x</p>')}, 'b'); sandboxView.render('<p id="c-done">c</p>', 'c');`);
        await waitInView(page, browserName, `!!document.getElementById('c-done')`, 15000);
        expect(await inView(page, browserName, `[document.getElementById('b').children.length, document.body.getElementsByTagName('*').length]`)).toEqual([0, 45005]);
        await sandbox.waitForLog(/refused a render/, 5000);
        // replacing a's 45 001 elements with 30 000 frees room: now b's 10 001 fit
        await render(sandbox, browserName, repeat('<p>', 29999), 'a-done-2', 'a', 30000);
        await render(sandbox, browserName, repeat('<p>', 10000), 'b-done', 'b', 30000);
        expect(await inView(page, browserName, `document.body.getElementsByTagName('*').length`)).toBe(3 + 30000 + 10001 + 1);
    });

    test(`the view refuses a render that would nest elements deeper than ${MAX_DEPTH} below the body, counting the target's own depth; one exactly at the limit applies (positive control)`, async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount(strict({ html: '<div id="x"></div><div id="y"></div>' }))).toBe('ready');
        await waitInView(page, browserName, `!!document.getElementById('y')`);
        const nested = (n: number, id: string) => repeat('<div>', n - 1) + `<div id="${id}">` + repeat('</div>', n);
        const depthOf = (id: string) => `(() => { let d = 0; for (let n = document.getElementById(${JSON.stringify(id)}); n && n !== document.body; n = n.parentNode) d++; return d; })()`;
        await render(sandbox, browserName, nested(199, 'deep'), 'done-1', 'x'); // #x is at depth 1: #deep at 200
        expect(await inView(page, browserName, depthOf('deep'))).toBe(200);
        // 57 more below #deep: 257, refused; the acknowledgement releases the next render (another target)
        await sandbox.run(`sandboxView.render(${JSON.stringify(nested(57, 'deeper'))}, 'deep'); sandboxView.render('<p id="after-1">a</p>', 'y');`);
        await waitInView(page, browserName, `!!document.getElementById('after-1')`);
        expect(await inView(page, browserName, `[!!document.getElementById('deeper'), document.getElementById('deep').children.length]`)).toEqual([false, 0]);
        // 56 more: exactly 256, applies
        await sandbox.run(`sandboxView.render(${JSON.stringify(nested(56, 'deepest'))}, 'deep'); sandboxView.render('<p id="after-2">a</p>', 'y');`);
        await waitInView(page, browserName, `!!document.getElementById('after-2') && !!document.getElementById('deepest')`);
        expect(await inView(page, browserName, depthOf('deepest'))).toBe(MAX_DEPTH);
        // a fresh 300-deep render into #x: refused as a whole, #x keeps what it had
        await sandbox.run(`sandboxView.render(${JSON.stringify(nested(300, 'too-deep'))}, 'x'); sandboxView.render('<p id="after-3">a</p>', 'y');`);
        await waitInView(page, browserName, `!!document.getElementById('after-3')`);
        expect(await inView(page, browserName, `[!!document.getElementById('too-deep'), !!document.getElementById('deepest')]`)).toEqual([false, true]);
    });
});

// ---- ST3: one budget per event detail ----------------------------------------------------------------------------

test(`ST3: a submitted form's detail carries at most ${MAX_DETAIL} characters in all and says it was cut; a small form's detail is whole (positive control)`, async ({ sandbox, page, browserName }) => {
    test.setTimeout(60000);
    await sandbox.page.evaluate(() => { (window as any).details = []; });
    await sandbox.exposeHost('report', `(d) => { const strings = [d.target.tag, d.target.id, d.target.name, d.target.value, ...d.ids, ...(d.form || []).flat()]; window.details.push({ chars: strings.join('').length, fields: (d.form || []).length, truncated: d.truncated === true, keys: Object.keys(d).sort().join(' ') }); return true; }`);
    const slots = Array.from({ length: 30 }, (_, i) => `<span id="slot-${i}"></span>`).join('');
    await sandbox.registerFiles({ 'main.js': `
        sandboxView.render('<form id="big">${slots}<button id="send" style="position:absolute;left:0;top:0;width:80px;height:30px">send</button></form><form id="small" style="position:absolute;left:0;top:60px"><button id="send2" style="width:80px;height:30px">send</button><input name="q" value="hello"></form><span id="tail"></span>');
        for (let i = 0; i < 30; i++) sandboxView.render('<input name="f' + i + '" value="' + 'v'.repeat(60000) + '">', 'slot-' + i);
        sandboxView.render('<i id="filled"></i>', 'tail');
        sandboxView.on('submit', null, (d) => bridge.call('report', d));
    ` });
    expect(await sandbox.mount(strict({ entry: 'main.js' }))).toBe('ready');
    await waitInView(page, browserName, `!!document.getElementById('filled') && document.querySelectorAll('#big input').length === 30`, 20000);
    await clickInSandbox(page, 40, 15);
    await expect.poll(() => page.evaluate(() => (window as any).details.length), { timeout: 10000 }).toBe(1);
    await clickInSandbox(page, 40, 75);
    await expect.poll(() => page.evaluate(() => (window as any).details.length), { timeout: 10000 }).toBe(2);
    const [big, small] = await page.evaluate(() => (window as any).details);
    expect(big.chars).toBeLessThanOrEqual(MAX_DETAIL);
    expect(big.truncated).toBe(true);
    expect(small).toEqual({ chars: 'formsmall'.length + 'q'.length + 'hello'.length + 'small'.length, fields: 1, truncated: false, keys: 'form ids target type' });
});

// ---- ST4: the entry-phase marker cannot be shadowed ---------------------------------------------------------------

test('ST4: an entry that closes its own scope and declares a lexical binding named like the marker does not take the marker over: the real marker runs, a later error is logged and does not end the sandbox; a plain entry the same (positive control)', async ({ sandbox, page }) => {
    await exposeMark(sandbox);
    const entry = `bridge.call('mark', 'entry');
}).call(this);
let __sandboxEntryRan = () => { bridge.call('mark', 'hijacked'); };
(function () {
setTimeout(() => { throw new Error('later'); }, 50);`;
    await sandbox.registerFiles({ 'main.js': entry });
    expect(await sandbox.mount(strict({ entry: 'main.js' }))).toBe('ready');
    await sandbox.waitForLog('later', 8000);
    await page.waitForTimeout(500);
    expect(await marks(sandbox)).toEqual(['entry']);
    expect(await sandbox.state()).toBe('ready');
});
