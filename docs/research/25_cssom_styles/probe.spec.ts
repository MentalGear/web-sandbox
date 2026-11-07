import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Research 25: which ways of styling a document escape a `style-src` the document inherits from its host page, on every
 * engine. Platform behaviour only: no library code runs. Run it on its own, one engine at a time:
 *   bunx playwright test docs/research/25_cssom_styles/probe.spec.ts --project=chromium   # then firefox, webkit
 * It prints `MEASURED {json}` lines, attaches them as annotations and writes them to results/<engine>-<variant>.json;
 * README.md holds the table made from them.
 *
 * The page is built as the strict view is: a host page (served by this file, so its policy is a real response header)
 * holds a `srcdoc` wrapper frame, and in it a `sandbox="allow-scripts"` `srcdoc` view (an opaque origin) whose own <meta>
 * policy is the view's (`style-src 'unsafe-inline'`). Both inherit the host page's policy, which has what a production
 * page keeps: a style hash (so a browser ignores `'unsafe-inline'` next to it), `'report-sample'`, and a `report-uri` with
 * a key in its URL; in the second variant `style-src-elem` and `style-src-attr` besides. The view runs each way of
 * styling once, as a step of its own with a marker of its own at the start of its CSS (so a report's sample, its first
 * 40 characters, names the step), and records per step the violations its document heard and whether the style applied
 * (a computed colour). The server records every report the browser POSTs.
 *
 * The ways:
 *   the library's old path (the controls): a `style` attribute parsed into an inert template, then inserted; a
 *   `setAttribute('style')`; a `<style>` (HTML and SVG) parsed, then inserted; a `<style>`'s text replaced; an empty `<style>`
 *   inserted;
 *   the CSSOM: an element's declaration (`cssText`, `setProperty`, on a connected element and on one still in the template);
 *   a constructed stylesheet (`new CSSStyleSheet()`, `replaceSync`, adopted; with `media`; replaced again; `insertRule`);
 *   and an attribute other than `style` (`data-…`) carried through the template, for the renderer's own bookkeeping;
 *   the library's construction: markup as style-markup.ts encodes it (a renamed style attribute, a `<style>` parsed as a
 *   `noframes` with its markers), parsed and inserted, and the `noframes` text replaced;
 *   recorded only: the other parsers (DOMParser, `document.implementation`, `Document.parseHTMLUnsafe`), and a `<style>`
 *   whose `type` is not CSS.
 * The assertions are the facts the same on every engine; what differs per engine is only recorded (README.md: when a parsed
 * style attribute is checked, and which reports reach the endpoint).
 */
test.describe.configure({ mode: 'serial' });

const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const record = (label: string, value: unknown) => {
    const line = JSON.stringify({ [label]: value });
    console.log(`MEASURED ${line}`);
    test.info().annotations.push({ type: 'measured', description: line });
};

/** A style hash of the host page's own (a production page's: it makes the browser ignore `'unsafe-inline'`). */
const HOST_STYLE = 'body{margin:0}';

/** The host page's policies: `style-src` alone, and with `style-src-elem` and `style-src-attr`. */
const VARIANTS = {
    'style-src': (report: string) => `default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' ${sha(HOST_STYLE)} 'report-sample'; img-src 'self'; report-uri ${report}`,
    'style-src-elem-attr': (report: string) => `default-src 'self'; script-src 'unsafe-inline'; style-src 'self' ${sha(HOST_STYLE)} 'report-sample'; style-src-elem 'self' ${sha(HOST_STYLE)} 'report-sample'; style-src-attr 'report-sample'; img-src 'self'; report-uri ${report}`,
} as const;
type Variant = keyof typeof VARIANTS;

/** The view's own policy (the strict view's `style-src`). */
const VIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

/** The steps the view runs, in order: [id, the old path or the CSSOM, code]. `css(id)` is CSS whose sample names the step. */
const STEPS: [id: string, path: 'old' | 'cssom' | 'construction' | 'parse' | 'explore', code: string][] = [
    // the old path
    ['attr-parse', 'parse', "const t = tpl('<p id=\"attr-parse\" style=\"' + decl('attr-parse') + '\">x</p>'); keep.attrParse = t;"],
    ['attr-insert', 'old', "document.body.append(keep.attrParse.content); return colour('attr-parse');"],
    ['attr-set', 'old', "const p = el('attr-set'); p.setAttribute('style', decl('attr-set')); return colour('attr-set');"],
    ['elem-parse', 'parse', "keep.elemParse = tpl('<style>' + rule('elem-parse') + '</style><p class=\"elem-parse\">x</p>');"],
    ['elem-insert', 'old', "document.body.append(keep.elemParse.content); return colour('elem-parse', true);"],
    ['elem-text', 'old', "const s = document.body.querySelector('style'); s.textContent = rule('elem-text'); el('elem-text', true); return colour('elem-text', true);"],
    ['svg-insert', 'old', "document.body.append(tpl('<svg width=\"9\" height=\"9\"><style>' + rule('svg-insert') + '</style></svg><p class=\"svg-insert\">x</p>').content); return colour('svg-insert', true);"],
    ['empty-style', 'old', "document.body.append(document.createElement('style'));"],
    // the CSSOM
    ['csstext', 'cssom', "const p = el('csstext'); cssText.call(styleOf.call(p), decl('csstext')); return colour('csstext');"],
    ['csstext-restore', 'cssom', "const p = el('csstext-restore'); cssText.call(styleOf.call(p), decl('csstext-restore')); cssText.call(styleOf.call(p), ''); cssText.call(styleOf.call(p), decl('csstext-restore')); return colour('csstext-restore');"],
    ['setproperty', 'cssom', "const p = el('setproperty'); styleOf.call(p).setProperty('--k', 'setproperty'); styleOf.call(p).setProperty('color', 'rgb(1, 2, 3)'); return colour('setproperty');"],
    ['csstext-svg', 'cssom', "document.body.append(tpl('<svg width=\"9\" height=\"9\"><rect id=\"csstext-svg\" width=\"9\" height=\"9\"></rect></svg>').content); const r = document.getElementById('csstext-svg'); cssText.call(svgStyleOf.call(r), decl('csstext-svg')); return getComputedStyle(r).color === 'rgb(1, 2, 3)';"],
    ['csstext-in-template', 'cssom', "const t = tpl('<p id=\"csstext-in-template\">x</p>'); const p = t.content.firstChild; cssText.call(styleOf.call(p), decl('csstext-in-template')); document.body.append(t.content); return colour('csstext-in-template');"],
    ['data-attr-parse-insert', 'cssom', "const t = tpl('<p id=\"data-attr\" data-x=\"' + decl('data-attr') + '\">x</p>'); document.body.append(t.content); const p = document.getElementById('data-attr'); cssText.call(styleOf.call(p), p.getAttribute('data-x')); p.removeAttribute('data-x'); return colour('data-attr');"],
    ['sheet', 'cssom', "const s = new CSSStyleSheet(); s.replaceSync(rule('sheet')); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; keep.sheet = s; el('sheet', true); return colour('sheet', true);"],
    ['sheet-media', 'cssom', "const s = new CSSStyleSheet({ media: 'all and (min-width: 1px)' }); s.replaceSync(rule('sheet-media')); const no = new CSSStyleSheet({ media: 'print' }); no.replaceSync(rule('sheet-media-print').replace('rgb(1, 2, 3)', 'rgb(9, 9, 9)')); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s, no]; el('sheet-media', true); el('sheet-media-print', true); return colour('sheet-media', true) && getComputedStyle(document.querySelector('.sheet-media-print')).color !== 'rgb(9, 9, 9)';"],
    ['sheet-replace', 'cssom', "keep.sheet.replaceSync(rule('sheet-replace')); el('sheet-replace', true); return colour('sheet-replace', true);"],
    ['sheet-insert-rule', 'cssom', "keep.sheet.insertRule(rule('sheet-insert-rule'), keep.sheet.cssRules.length); el('sheet-insert-rule', true); return colour('sheet-insert-rule', true);"],
    ['sheet-media-text', 'cssom', "const s = new CSSStyleSheet(); s.media.mediaText = 'screen'; s.replaceSync(rule('sheet-media-text')); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; el('sheet-media-text', true); return colour('sheet-media-text', true);"],
    // the library's construction (style-markup.ts, sanitizeRender): renamed markup parsed and inserted, and a `noframes` that
    // holds a stylesheet's text, its text replaced: no inline style at all
    ['renamed', 'construction', "document.body.append(tpl('<p id=\"renamed\" wprobe0001astyle=\"' + decl('renamed') + '\">x</p><noframes/wprobe0001tstyle=v media=\"print\">' + rule('renamed') + '</noframes/wprobe0001estyle=v>').content); return colour('renamed');"],
    ['noframes-text', 'construction', "const n = document.body.querySelector('noframes'); n.textContent = rule('noframes-text');"],
    // the other parsers, and a <style> that is not CSS: recorded only
    ['parse-domparser', 'explore', "new DOMParser().parseFromString('<p style=\"' + decl('parse-domparser') + '\">x</p>', 'text/html');"],
    ['parse-implementation', 'explore', "const d = document.implementation.createHTMLDocument(''); d.body.innerHTML = '<p style=\"' + decl('parse-implementation') + '\">x</p>';"],
    ['parse-unsafe', 'explore', "if (typeof Document.parseHTMLUnsafe !== 'function') return 'absent'; Document.parseHTMLUnsafe('<p style=\"' + decl('parse-unsafe') + '\">x</p>');"],
    ['parse-renamed', 'explore', "const t = tpl('<p id=\"parse-renamed\" x-style=\"' + decl('parse-renamed') + '\">x</p>'); document.body.append(t.content); return colour('parse-renamed');"],
    ['style-type', 'explore', "const s = document.createElement('style'); s.setAttribute('type', 'text/x-probe'); s.textContent = rule('style-type'); document.body.append(s); el('style-type', true); return colour('style-type', true);"],
    ['style-type-parsed', 'explore', "document.body.append(tpl('<style type=\"text/x-probe\">' + rule('style-type-parsed') + '</style>').content);"],
    ['style-type-svg', 'explore', "document.body.append(tpl('<svg width=\"9\" height=\"9\"><style type=\"text/x-probe\">' + rule('style-type-svg') + '</style></svg>').content);"],
];

/** The view's script: runs STEPS, one per 250 ms, and posts what each did to the top (as functions: neither policy admits eval). */
const viewScript = () => `
const STEPS = [${STEPS.map(([id, , code]) => `[${JSON.stringify(id)}, () => { ${code} }]`).join(',\n')}];
const heard = [];
document.addEventListener('securitypolicyviolation', (e) => heard.push(e.effectiveDirective + ' ' + e.blockedURI + ' ' + e.sample));
const styleOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style').get;
const svgStyleOf = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'style').get;
const cssText = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText').set;
const decl = (id) => '--k:' + id + ';color:rgb(1, 2, 3)';
const rule = (id) => '/*' + id + '*/.' + id + '{color:rgb(1, 2, 3)}';
const tpl = (html) => { const t = document.createElement('template'); t.innerHTML = html; return t; };
const el = (id, byClass) => { const p = document.createElement('p'); if (byClass) p.className = id; else p.id = id; p.textContent = id; document.body.append(p); return p; };
const colour = (id, byClass) => { const p = byClass ? document.querySelector('.' + id) : document.getElementById(id); return !!p && getComputedStyle(p).color === 'rgb(1, 2, 3)'; };
const keep = {};
const out = {};
const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
(async () => {
  for (const [id, run] of STEPS) {
    const before = heard.length;
    let applied;
    try { applied = run(); } catch (e) { out[id] = { threw: String(e && e.name) + ': ' + String(e && e.message) }; continue; }
    await pause();
    out[id] = { applied: applied === undefined ? null : applied, heard: heard.slice(before) };
  }
  top.postMessage({ probe: out }, '*');
})();`;

/** The view document: its own policy, then the script (the view's policy here admits inline script; the host's does too). */
const viewDocument = () => `<!doctype html><meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}"><body><script>${viewScript().replaceAll('</script', '<\\/script')}<\/script></body>`;

let server: Server;
let base = '';
const reports = new Map<string, unknown[]>();

test.beforeAll(async () => {
    server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const [, route, key = '', variant = ''] = url.pathname.split('/');
        if (route === 'report' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                try { (reports.get(key) ?? reports.set(key, []).get(key)!).push(JSON.parse(body)); } catch { (reports.get(key) ?? reports.set(key, []).get(key)!).push(body); }
                res.writeHead(204).end();
            });
            return;
        }
        if (route === 'host') {
            const policy = VARIANTS[variant as Variant](`/report/${key}?sentry_key=${key}`);
            const wrapper = `<!doctype html><body><iframe sandbox="allow-scripts" width="400" height="300" srcdoc="${viewDocument().replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></body>`;
            const page = `<!doctype html><html><head><style>${HOST_STYLE}</style></head><body><script>
window.hostViolations = [];
document.addEventListener('securitypolicyviolation', (e) => hostViolations.push(e.effectiveDirective + ' ' + e.sample));
addEventListener('message', (e) => { if (e.data && e.data.probe) window.probe = e.data.probe; });
const f = document.createElement('iframe');
f.srcdoc = ${JSON.stringify(wrapper).replaceAll("<", "\\u003c")};
f.width = 420; f.height = 320;
document.body.append(f);
</script></body></html>`;
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': policy, 'cache-control': 'no-store' }).end(page);
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

/** The steps a report names, by the marker at the start of its sample (Chromium, Firefox and WebKit put it in `script-sample`). */
const reportedSteps = (list: unknown[]) => list.map((report) => {
    const body = (report as { 'csp-report'?: Record<string, unknown> })['csp-report'] ?? {};
    const sample = String(body['script-sample'] ?? '');
    const step = STEPS.find(([id]) => sample.includes(`--k:${id};`) || sample.includes(`/*${id}*/`));
    return { step: step ? step[0] : `(${sample || 'no sample'}; ${String(body['violated-directive'] ?? body['effective-directive'] ?? '')})`, directive: String(body['effective-directive'] ?? body['violated-directive'] ?? '') };
});

for (const variant of Object.keys(VARIANTS) as Variant[]) {
    test(`styles under a host ${variant} with a hash, 'report-sample' and a report-uri`, async ({ page, browserName }) => {
        test.setTimeout(60000);
        const key = randomUUID();
        await page.goto(`${base}/host/${key}/${variant}`);
        await page.waitForFunction(() => (window as any).probe !== undefined, null, { timeout: 30000 });
        const seen = await page.evaluate(() => (window as any).probe as Record<string, { applied: boolean | null; heard: string[]; threw?: string }>);
        await page.waitForTimeout(3000); // the reports the browser sends after the steps
        const got = reportedSteps(reports.get(key) ?? []);
        const host = await page.evaluate(() => (window as any).hostViolations as string[]);
        record(`${variant}:steps`, seen);
        record(`${variant}:reports`, got);
        record(`${variant}:host-violations`, host);
        const results = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
        mkdirSync(results, { recursive: true });
        writeFileSync(path.join(results, `${browserName}-${variant}.json`), `${JSON.stringify({ steps: seen, reports: got, hostViolations: host }, null, 2)}\n`);

        // nothing threw: every mechanism exists on this engine
        for (const [id] of STEPS) expect(seen[id]?.threw, id).toBeUndefined();
        // the CSSOM: no violation in the view, no report, and the style applies; the library's construction: no violation, no report
        for (const [id, path] of STEPS) {
            if (path !== 'cssom' && path !== 'construction') continue;
            expect(seen[id]!.heard, `${id}: no violation`).toEqual([]);
            expect(got.filter(report => report.step === id), `${id}: no report`).toEqual([]);
            if (path === 'cssom') expect(seen[id]!.applied, `${id}: applies`).toBe(true);
        }
        expect(seen['renamed']!.applied, 'a renamed attribute is no style').toBe(false);
        // the old path (the control), what every engine refuses: a style attribute set on an element, a <style> inserted
        // (HTML or SVG, empty, or its text replaced). When a parsed style attribute is checked differs per engine (recorded)
        for (const id of ['attr-set', 'elem-insert', 'elem-text', 'svg-insert']) {
            expect(seen[id]!.heard.length, `${id} is refused (control)`).toBeGreaterThan(0);
            expect(seen[id]!.applied, `${id} does not apply (control)`).toBe(false);
        }
        expect(seen['empty-style']!.heard.length, 'an empty <style> is checked too (control)').toBeGreaterThan(0);
        // the host page's own listener hears nothing: every violation is the view's
        expect(host).toEqual([]);
        // the endpoint works on this engine: the host page's own inline style is refused and reported (control)
        await page.evaluate(() => document.body.setAttribute('style', 'outline: 0'));
        await expect.poll(() => (reports.get(key) ?? []).length, { timeout: 15000 }).toBeGreaterThan(got.length);
    });
}
