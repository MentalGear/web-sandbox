// The fixture of research 33: a listed link in a frame shaped like the view, as plain HTML (no library code).
//
//   host page H (https://app.test:PORT/H.html): a custom element with a closed shadow root holds
//     <iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="F.html?…">         F
//   F: the served file's shape (research 31's fixture, docs/design/03-served-document.md "The policies in force"):
//      its <meta> policy first in <head>, the guard, then
//     <iframe sandbox="allow-scripts allow-forms allow-orientation-lock" srcdoc="…">                    C, the view
//   C: the still sheet (by hash), the case's markup (the link below the fold), and the bootstrap (by hash), which
//      cancels every click on a link and posts { ws: 'open', i: 0 } to parent.parent, as the design's view sends the
//      link's index; H then calls window.open(links[0], '_blank', 'noopener,noreferrer').
//
// Layouts: `view` (the above), `nometa` (F without its <meta>: what the sandbox alone does), `open` (C's markup and
// bootstrap as a top-level page of app.test with no policy and no frame: what the engine does at all, the sensitivity
// control). Every listed URL is on `t<trial>.listed.example`, so a connection names its trial by its host alone.
import { createHash } from 'node:crypto';

export const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
export const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

export const GUARD = `if (!(self.origin === 'null' && top !== self)) window.stop();`;
const F_SHEET = 'body { margin: 0 } iframe { display: block; width: 100%; height: 460px; border: 0 }';
const C_SHEET = 'body { margin: 0; font: 28px sans-serif } #spacer { height: 900px } #l { display: inline-block; padding: 16px; margin: 16px } #after { height: 400px }';
// The view cancels every click on a link and asks for index 0; Enter on a marked link without href is the inert
// alternative's own activation (a link without href is not activated by Enter).
export const BOOT = `addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a'); if (!a) return; e.preventDefault(); if (!e.isTrusted) return; parent.parent.postMessage({ ws: 'open', i: 0 }, '*'); }, true);
addEventListener('keydown', (e) => { const a = e.target; if (e.key !== 'Enter' || !a.matches || !a.matches('a[data-ws-link]:not([href])')) return; e.preventDefault(); parent.parent.postMessage({ ws: 'open', i: 0 }, '*'); }, true);`;

// The listed site: `t<trial>.<domain>`, on the recorder's port when the browser reaches it directly (probe.mjs sets it).
export const LISTED = { domain: "listed.example", port: null };
// What a view could add against a drag of a link: it cancels `dragstart` on a link (cases `*-nodrag`).
export const NODRAG = `addEventListener('dragstart', (e) => { const a = e.target.closest ? e.target.closest('a') : e.target.parentElement && e.target.parentElement.closest('a'); if (a) e.preventDefault(); }, true);`;

// What a view could add against a press: it cancels `pointerdown` and `mousedown` on a link (cases `*-nopress`).
export const NOPRESS = `for (const t of ['pointerdown', 'mousedown']) addEventListener(t, (e) => { if (e.target.closest && e.target.closest('a')) e.preventDefault(); }, true);`;

export const listedHost = (trial) => `t${trial}.${LISTED.domain}`;
export const listedOrigin = (trial) => `https://${listedHost(trial)}${LISTED.port ? `:${LISTED.port}` : ""}`;
export const linkUrl = (trial) => `${listedOrigin(trial)}/guide`;

/** Speculation rules a guest (or the file's host) could write: list rules (immediate) and document rules on hover and press. */
export function rules(trial) {
    const h = listedOrigin(trial);
    return JSON.stringify({
        prefetch: [
            { source: 'list', urls: [`${h}/sr-prefetch-list`], eagerness: 'immediate' },
            { source: 'document', where: { href_matches: `${h}/*` }, eagerness: 'moderate' },
        ],
        prerender: [
            { source: 'list', urls: [`${h}/sr-prerender-list`], eagerness: 'immediate' },
            { source: 'document', where: { href_matches: `${h}/*` }, eagerness: 'conservative' },
        ],
    });
}

/** The cases: what C holds (head, link) and the headers of the file (F, or the open page). */
export const CASES = {
    plain: { group: 'link', link: (u) => `<a id="l" href="${u}">Read the guide</a>` },
    blank: { group: 'link', link: (u) => `<a id="l" href="${u}" target="_blank" rel="noopener noreferrer">Read the guide</a>` },
    inert: { group: 'inert', link: () => `<a id="l" href="about:blank#" data-ws-link="0">Read the guide</a>` },
    nohref: { group: 'inert', link: () => `<a id="l" data-ws-link="0" tabindex="0" role="link">Read the guide</a>` },
    'plain-nodrag': { group: 'link', nodrag: true, link: (u) => `<a id="l" href="${u}">Read the guide</a>` },
    'blank-nodrag': { group: 'link', nodrag: true, link: (u) => `<a id="l" href="${u}" target="_blank" rel="noopener noreferrer">Read the guide</a>` },
    'plain-undraggable': { group: 'link', link: (u) => `<a id="l" href="${u}" draggable="false">Read the guide</a>` },
    'blank-undraggable': { group: 'link', link: (u) => `<a id="l" href="${u}" target="_blank" rel="noopener noreferrer" draggable="false">Read the guide</a>` },
    'plain-nopress': { group: 'link', nopress: true, link: (u) => `<a id="l" href="${u}">Read the guide</a>` },
    'blank-nopress': { group: 'link', nopress: true, link: (u) => `<a id="l" href="${u}" target="_blank" rel="noopener noreferrer">Read the guide</a>` },
    'plain-nohandler': { group: 'link', boot: false, link: (u) => `<a id="l" href="${u}">Read the guide</a>` },
    'blank-nohandler': { group: 'link', boot: false, link: (u) => `<a id="l" href="${u}" target="_blank" rel="noopener noreferrer">Read the guide</a>` },
    preconnect: { group: 'guest', head: (t) => `<link rel="preconnect" href="${listedOrigin(t)}">` },
    dnsprefetch: { group: 'guest', head: (t) => `<link rel="dns-prefetch" href="${listedOrigin(t)}">` },
    prefetch: { group: 'guest', head: (t) => `<link rel="prefetch" href="${listedOrigin(t)}/link-prefetch">` },
    prerender: { group: 'guest', head: (t) => `<link rel="prerender" href="${listedOrigin(t)}/link-prerender">` },
    specrules: { group: 'guest', head: (t) => `<script type="speculationrules">${rules(t)}</script>` },
    // outside the design: the <meta> admits the rules block by its hash
    'specrules-admitted': { group: 'guest', admitRules: true, head: (t) => `<script type="speculationrules">${rules(t)}</script>` },
    ping: { group: 'guest', link: (u, t) => `<a id="l" href="${u}" ping="${listedOrigin(t)}/ping">Read the guide</a>` },
    'ping-nohandler': { group: 'guest', boot: false, link: (u, t) => `<a id="l" href="${u}" ping="${listedOrigin(t)}/ping">Read the guide</a>` },
    'hdr-preconnect': { group: 'header', headers: (t) => ({ link: `<${listedOrigin(t)}>; rel=preconnect` }) },
    'hdr-dnsprefetch': { group: 'header', headers: (t) => ({ link: `<${listedOrigin(t)}>; rel=dns-prefetch` }) },
    'hdr-prefetch': { group: 'header', headers: (t) => ({ link: `<${listedOrigin(t)}/hdr-prefetch>; rel=prefetch` }) },
    'hdr-specrules': { group: 'header', headers: (t) => ({ 'speculation-rules': `"/rules.json?trial=${t}"` }) },
};

const defaultLink = (u) => `<a id="l" href="${u}">Read the guide</a>`;

function cParts(name, trial) {
    const c = CASES[name];
    const u = linkUrl(trial);
    const head = c.head ? c.head(trial) : '';
    const link = (c.link ?? defaultLink)(u, trial);
    const boot = `${c.boot === false ? '' : `<script>${BOOT}</script>`}${c.nodrag ? `<script>${NODRAG}</script>` : ''}${c.nopress ? `<script>${NOPRESS}</script>` : ''}`;
    return { head, body: `<div id="spacer"></div><p>${link}</p><div id="after"></div>${boot}`, c };
}

/** The view's own document (C), as F's srcdoc. */
export function cDocument(name, trial) {
    const { head, body } = cParts(name, trial);
    return `<!doctype html><html><head><meta charset="utf-8"><style>${C_SHEET}</style>${head}</head><body>${body}</body></html>`;
}

/** F's <meta>: the design's constant text (research 31's fixture), with this fixture's hashes. */
export function metaPolicy(name, trial) {
    const c = CASES[name];
    const scripts = [sha(GUARD), sha(BOOT)];
    if (c.nodrag) scripts.push(sha(NODRAG));
    if (c.nopress) scripts.push(sha(NOPRESS));
    if (c.admitRules) scripts.push(sha(rules(trial)));
    const d = {
        'default-src': "'none'", 'script-src': scripts.join(' '), 'script-src-attr': "'none'", 'style-src': `${sha(F_SHEET)} ${sha(C_SHEET)} blob:`,
        'img-src': 'blob:', 'font-src': 'blob:', 'media-src': 'blob:', 'connect-src': "'none'", 'worker-src': 'blob:',
        'frame-src': "'none'", 'object-src': "'none'", 'base-uri': "'none'", 'form-action': "'none'", 'manifest-src': "'none'",
    };
    return Object.entries(d).map(([k, v]) => `${k} ${v}`).join('; ');
}

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

/** F, the served file. */
export function fileResponse(name, trial, meta = true) {
    const c = CASES[name];
    const policy = meta ? `<meta http-equiv="Content-Security-Policy" content="${esc(metaPolicy(name, trial))}">` : '';
    const html = `<!doctype html><html><head>${policy}<meta charset="utf-8"><style>${F_SHEET}</style><script>${GUARD}</script></head><body><iframe sandbox="allow-scripts allow-forms allow-orientation-lock" srcdoc="${esc(cDocument(name, trial))}"></iframe></body></html>`;
    return { headers: { ...HTML, ...(c.headers ? c.headers(trial) : {}) }, body: html };
}

/** H: the host page. In `open`, C's markup itself; otherwise the element that frames F. */
export function hostResponse(layout, name, trial) {
    const u = linkUrl(trial);
    const opener = `const links = [${JSON.stringify(u)}]; window.opened = []; addEventListener('message', (e) => { if (!e.data || e.data.ws !== 'open') return; window.opened.push(Date.now()); window.open(links[e.data.i], '_blank', 'noopener,noreferrer'); });`;
    if (layout === 'open') {
        const { head, body } = cParts(name, trial);
        const c = CASES[name];
        return { headers: { ...HTML, ...(c.headers ? c.headers(trial) : {}) }, body: `<!doctype html><html><head><meta charset="utf-8"><style>${C_SHEET}</style><script>${opener}</script>${head}</head><body>${body}</body></html>` };
    }
    const src = `F.html?case=${encodeURIComponent(name)}&trial=${trial}&meta=${layout === 'view' ? 1 : 0}`;
    const el = `customElements.define('web-sandbox', class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: 'closed' }); const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-forms'); f.setAttribute('referrerpolicy', 'no-referrer'); f.style.cssText = 'width: 900px; height: 460px; border: 0; display: block'; f.src = ${JSON.stringify(src)}; r.append(f); } });`;
    return { headers: HTML, body: `<!doctype html><html><head><meta charset="utf-8"><style>body { margin: 0 } h1 { font: 16px sans-serif; margin: 8px }</style><script>${opener}${el}</script></head><body><h1>host page</h1><web-sandbox></web-sandbox></body></html>` };
}

/** Installs the fixture's routes on the recorder. */
export function installRoutes(rec) {
    rec.route('/H.html', (url) => hostResponse(url.searchParams.get('layout'), url.searchParams.get('case'), Number(url.searchParams.get('trial'))));
    rec.route('/F.html', (url) => fileResponse(url.searchParams.get('case'), Number(url.searchParams.get('trial')), url.searchParams.get('meta') === '1'));
    rec.route('/rules.json', (url) => ({ headers: { 'content-type': 'application/speculationrules+json', 'cache-control': 'no-store' }, body: rules(Number(url.searchParams.get('trial'))) }));
}
