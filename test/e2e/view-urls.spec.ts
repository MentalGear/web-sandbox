import { randomUUID } from 'node:crypto';
import { test, expect } from './fixture';
import { RealisticHost, covering, withPolicySecrets, type Directives } from './realistic-host';
import { inView, waitInView } from './strict-view';

/**
 * The one rule for a URL in the view, on the engines (BD7:ISO-1; class A: INHERITED_CONTEXT.cspReporting and cspFetch;
 * keepsUrl, css-references.ts). The view and its worker inherit the host page's policy list with its report endpoint, so
 * every URL the view's document tries and the page's fetch directives refuse is reported to the page's endpoint, with its
 * scheme whole: a URL the guest kept in the view was a channel it wrote into. A rule that dropped the URLs of a list of
 * server schemes kept every other one in guest CSS, and Chromium and Firefox reported each.
 *
 * On the realistic host with the fetch directives docs/API.md#host-page-policy names (`'self' blob:`), `'report-sample'`
 * and a keyed report endpoint, a sealed guest at its default configuration names every kind of URL (every scheme the
 * host page's policy refuses and reports, every spelling CSS and the URL parser read alike, a relative URL, a fragment, the
 * empty URL) in every carrier that names a URL in the view: markup's URL attributes and SVG references, a style attribute,
 * a `<style>`, `@font-face`, `text()` into a style, `set({ css })` (a cursor, and a custom property read through var(), a
 * URL's and a text's), a registered stylesheet linked with `<link>`, an `@import` in a registered stylesheet, and attr().
 * On every engine: the endpoint receives nothing, the page's own listener hears nothing, a registered file still loads, and
 * the page's own violation still reaches the endpoint (the positive control).
 */

const tag = () => randomUUID().replaceAll('-', '').slice(0, 10);

/** The page's fetch directives as the docs name them: `'self'`, and `blob:` for registered files of each kind. */
const docsFetch = (base: Directives): Directives => ({
    ...base,
    'img-src': ["'self'", 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'font-src': ["'self'", 'blob:'],
    'style-src': [...base['style-src']!, 'blob:'],
});

/** A 3×5 PNG: the registered file that must still load. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAIAAAAPE8H1AAAAEElEQVR4nGP4z8AAQQxEsgCEuw7yxezkBQAAAABJRU5ErkJggg==';

/** Every kind of URL, by what it is; `{R}` is a random part, so a scheme of this run's own is among them. */
const URLS = (run: string): Record<string, string> => ({
    data: 'data:image/png;base64,AAAA', about: 'about:x', aboutBlank: 'about:blank', javascript: 'javascript:void(0)',
    blob: 'blob:null/1c2d3e4f-0000-4000-8000-000000000000', file: 'file:///etc/hosts', filesystem: 'filesystem:http://localhost/temporary/a',
    chromeExtension: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.png', mozExtension: 'moz-extension://3f1a2b/a.png',
    safariExtension: 'safari-web-extension://3f1a2b/a.png', resource: 'resource://gre/a', mailto: 'mailto:a@b.example', tel: 'tel:+1',
    https: 'https://x.example/a.png', http: 'http://x.example/a.png', wss: 'wss://x.example/a', ftp: 'ftp://x.example/a',
    custom: `zq${run}.v1+a-b:x`, long: `${'z'.repeat(200)}${run}:x`, upper: `ZQ${run.toUpperCase()}:X`,
    spaced: ` zqs${run}:x`, tabbed: `z\tqt${run}:x`, control: `\u0001zqc${run}:x`, relative: 'a.png', fragment: '#x', empty: '',
});

/** `value` as a CSS string; with `letters`, each letter as a CSS escape (the same string to CSS). */
const css = (value: string, letters = false) => `"${[...value].map(ch => (ch.charCodeAt(0) < 32 || ch === '"' || ch === '\\' || (letters && /[a-z]/i.test(ch)) ? `\\${ch.charCodeAt(0).toString(16)} ` : ch)).join('')}"`;
/** `value` in an HTML attribute; with `letters`, each letter as a character reference. */
const attr = (value: string, letters = false) => [...value].map(ch => (ch === '&' ? '&amp;' : ch === '"' ? '&quot;' : letters && /[a-z]/i.test(ch) ? `&#x${ch.charCodeAt(0).toString(16)};` : ch)).join('');

/** The guest: every carrier × every URL, each spelling; then the operations; then a marker. */
function guest(values: string[], name: string): { files: Record<string, string>; entry: string } {
    let markup = '<img id="minted" src="pic.png" alt=""><link rel="stylesheet" href="carriers.css"><link rel="stylesheet" href="imports.css"><div class="r-minted" id="r-minted"></div>';
    let sheet = '';
    let sheetRules = '';
    let imports = '';
    const operations: string[] = [];
    values.forEach((value, i) => {
        for (const letters of [false, true]) {
            const n = `${i}${letters ? 'e' : ''}`;
            const s = css(value, letters);
            const a = attr(value, letters);
            // markup: an image, a poster, an SVG paint reference, and attr() (which no engine makes a URL of)
            markup += `<img src="${a}" alt=""><video poster="${a}"></video><svg width="4" height="4"><rect width="4" height="4" fill="${attr(`url(${s})`)}"/></svg>`;
            markup += `<div data-u="${a}" style="width:4px;height:4px;background-image:image-set(attr(data-u) 1x)"></div>`;
            // a style attribute
            markup += `<div style="${attr(`width:4px;height:4px;background-image:url(${s});cursor:image-set(${s} 1x),auto`)}"></div>`;
            // a <style>, with @font-face
            sheet += `.c${n}{width:4px;height:4px;background-image:url(${s})} .k${n}{width:4px;height:4px;background-image:image-set(${s} 1x)} @font-face{font-family:f${n};src:url(${s})} .f${n}{font-family:f${n}}`;
            markup += `<div class="c${n}"></div><div class="k${n}"></div><p class="f${n}">f</p>`;
            // text() into a style
            markup += `<style id="t${n}"></style><div class="t${n}"></div>`;
            operations.push(`sandboxView.text('t${n}', ${JSON.stringify(`.t${n}{width:4px;height:4px;background-image:url(${s})}`)})`);
            // set({ css }): a cursor, a custom property read through var() as an image, and one as a text image-set() reads
            markup += `<div id="s${n}" style="width:4px;height:4px;background-image:var(--i);list-style-image:image-set(var(--t) 1x)"></div>`;
            operations.push(`sandboxView.set('s${n}', { css: { cursor: ${JSON.stringify(`url(${s}), auto`)}, '--i': ${JSON.stringify(`image-set(${s} 1x)`)}, '--t': ${JSON.stringify(s)} } })`);
            // a registered stylesheet, and an @import in one
            sheetRules += `.r${n}{width:4px;height:4px;background-image:url(${s})} `;
            markup += `<div class="r${n}"></div>`;
            imports += `@import ${s};\n`;
        }
    });
    markup += `<style>${sheet}</style><p id="done-slot"></p>`;
    const files = {
        'carriers.css': `${sheetRules} .r-minted{width:3px;height:5px;background-image:url(pic.png)}`,
        'imports.css': imports,
    };
    const entry = `sandboxView.render(${JSON.stringify(markup)});
${operations.join(';\n')};
sandboxView.render('<b id="done">done</b>', 'done-slot');
console.log(${JSON.stringify(name)} + 'sent');`;
    return { files, entry };
}

test.describe('sealed mode: the one URL rule keeps nothing the host page reports (BD7:ISO-1)', () => {
    test.describe.configure({ timeout: 120000 });

    test("every carrier × every kind of URL, on a host whose fetch directives are the docs' ('self' blob:), with report-sample and a keyed endpoint: no report; a registered file still loads", async ({ sandbox, browserName }) => {
        const secrets = { nonce: `HN${tag()}`, key: `RK${tag()}` };
        const host = await RealisticHost.open(sandbox, { mode: 'sealed', directives: base => withPolicySecrets(secrets)(docsFetch(base)) });
        expect(host.csp).toContain("img-src 'self' blob:");
        expect(host.csp).toContain(secrets.key);
        await host.hits(true);

        const run = tag();
        const values = Object.values(URLS(run));
        const name = `VIEWURLS${run} `;
        const { files, entry } = guest(values, name);
        await sandbox.registerFiles({ ...files, 'pic.png': { base64: PNG, type: 'image/png' }, 'main.js': entry });
        expect((await host.configure({ entry: 'main.js' })).at(-1), 'the default sealed build is ready').toEqual({ type: 'ready', reason: null });
        await sandbox.waitForLog(name, 30000);
        await waitInView(host.page, browserName, "!!document.getElementById('done')", 20000);
        await host.page.waitForTimeout(4000); // a report the browser sends after the refusal

        // the registered file loads: as an element and from a registered stylesheet
        await waitInView(host.page, browserName, "document.getElementById('minted').naturalWidth === 3", 10000);
        const background = await inView<string>(host.page, browserName, "getComputedStyle(document.getElementById('r-minted')).backgroundImage");
        expect(background, 'a registered stylesheet names a registered file').toMatch(/^url\("blob:/);

        // nothing reached the endpoint, and the page heard nothing
        const hits = await host.hits();
        const reports = (hits.reports as { 'csp-report'?: Record<string, string> }[]).map(report => `${report['csp-report']?.['violated-directive']} ${report['csp-report']?.['blocked-uri']}`);
        expect(reports, covering('cspReporting', "no URL of the guest's reaches the host page's endpoint")).toEqual([]);
        expect(await host.cspViolations(), covering('cspReporting', "the host page's own listener hears nothing")).toEqual([]);
        // what the view dropped it reported to the element, itself (the library's own channel), among them this run's scheme
        const violations = await sandbox.violations();
        expect(violations.some(v => String(v.blockedURI).startsWith(`zq${run}`)), 'the view reports what it dropped').toBe(true);
        expect(await host.state()).toBe('ready');

        // positive control: the endpoint receives the host page's own violation on this engine
        await host.page.evaluate(() => fetch('https://control.invalid/x').catch(() => {}));
        await expect.poll(async () => (await host.hits()).reports.length, { message: "the host page's own violation is reported (control)", timeout: 15000 }).toBeGreaterThan(0);
        expect(JSON.stringify((await host.hits()).reports)).toContain('control.invalid');
    });
});
