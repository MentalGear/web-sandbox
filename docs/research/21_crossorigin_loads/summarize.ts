// Research 21: the README's tables, from results/*.json (written by probe.spec.ts and view.spec.ts).
//   bun docs/research/21_crossorigin_loads/summarize.ts <q1|q1shape|q1fail|q1same|q2|q3|q4|view|all>
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
type H = { k: string; host: string; method: string; cookies: string[]; origin: string; mode: string; dest: string; site: string; range: string; status: number };
type Row = { id: string; group: string; T: string; A: string; name: string; co: string; result: Record<string, any>; hits: H[] };

const cache = new Map<string, Row[]>();
function rows(engine: string, struct: string): Row[] {
    const file = path.join(here, 'results', `${engine}-${struct}.json`);
    if (!cache.has(file)) cache.set(file, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).rows : []);
    return cache.get(file)!;
}
const find = (engine: string, struct: string, group: string, T: string, A: string, name: string, co = '-') =>
    rows(engine, struct).find(r => r.group === group && r.T === T && r.A === A && r.name === name && r.co === co);

const names = (r: Row | undefined, sub?: string) => {
    if (!r) return undefined;
    const hits = r.hits.filter(h => (sub === undefined ? !h.k.includes('.sub-') && !h.k.endsWith('.media') && !h.k.endsWith('.hop') : h.k.endsWith(sub)));
    return hits.length === 0 ? null : [...new Set(hits.flatMap(h => h.cookies))].sort();
};
/** A cookie cell: `-` no cookie, `n` the number of distinct cookies, `no req` when the request never reached the listener. */
const cell = (n: string[] | null | undefined) => n === undefined ? 'n/a' : n === null ? 'no request' : n.length === 0 ? 'none' : `${n.length}`;
const first = (r: Row | undefined, sub?: string) => r?.hits.find(h => (sub === undefined ? !h.k.includes('.sub-') && !h.k.endsWith('.media') && !h.k.endsWith('.hop') : h.k.endsWith(sub)));
const table = (head: string[], body: string[][]) => [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (i === 0 ? ':---' : ':---')).join(' | ')} |`, ...body.map(r => `| ${r.join(' | ')} |`)].join('\n');
const label = (n: string) => n.replaceAll('-', ' ');

const ELEMENTS: [string, string][] = [
    ['img-src', '`<img src>`'], ['img-srcset', '`<img srcset>`'], ['picture-srcset', '`<picture><source srcset>`'], ['video-src', '`<video src>`'],
    ['video-poster', '`<video poster>`'], ['audio-src', '`<audio src>`'], ['source-in-video', '`<video><source src>`'], ['source-in-audio', '`<audio><source src>`'],
    ['track-src', '`<track default src>`'], ['track-live', '`<track>` added by script, mode showing'], ['link-stylesheet', '`<link rel=stylesheet>`'], ['link-icon', '`<link rel=icon>`'],
];

function q1(T: string, struct: string, title: string) {
    const head = ['Element', ...ENGINES.map(e => `${e}: no attribute → crossorigin=anonymous`)];
    const body = ELEMENTS.map(([name, text]) => [text, ...ENGINES.map(e => {
        const a = find(e, struct, 'E', T, 'cors', name, 'none'), b = find(e, struct, 'E', T, 'cors', name, 'anon');
        return `${cell(names(a))} → ${cell(names(b))}`;
    })]);
    return `${title}\n\n${table(head, body)}`;
}

function shape() {
    const head = ['Element', ...ENGINES.map(e => `${e}: mode / Origin header (anonymous)`)];
    const body = ELEMENTS.map(([name, text]) => [text, ...ENGINES.map(e => {
        const h = first(find(e, 'plain', 'E', 'X', 'cors', name, 'anon'));
        const c = first(find(e, 'plain', 'E', 'X', 'cors', name, 'none'));
        return h ? `${h.mode} / ${h.origin}` : c ? 'no request' : 'no request (as without)';
    })]);
    return table(head, body);
}

const outcome = (r: Row | undefined) => {
    if (!r) return 'n/a';
    const o = r.result;
    if (r.name === 'video-poster') return o.outcome === 'load' ? 'shown' : 'nothing';
    if (r.name === 'link-stylesheet') return o.outcome === 'load' && o.applied ? 'applied' : o.outcome === 'error' ? 'error event' : `${o.outcome}`;
    if (o.outcome === 'load') return r.name.startsWith('track') ? 'load event' : 'shown';
    if (o.outcome === 'loadedmetadata') return 'plays';
    if (o.outcome === 'error') return 'error event';
    if (o.outcome === 'timeout') return 'no event';
    return o.outcome;
};

function fail() {
    const head = ['Element', ...ENGINES.map(e => `${e}: ACAO * / no ACAO (crossorigin=anonymous)`)];
    const body = ELEMENTS.filter(([n]) => n !== 'link-icon').map(([name, text]) => [text, ...ENGINES.map(e => `${outcome(find(e, 'plain', 'E', 'X', 'cors', name, 'anon'))} / ${outcome(find(e, 'plain', 'E', 'X', 'nocors', name, 'anon'))}`)]);
    const control = ELEMENTS.filter(([n]) => n !== 'link-icon').map(([name, text]) => [text, ...ENGINES.map(e => `${outcome(find(e, 'plain', 'E', 'X', 'cors', name, 'none'))} / ${outcome(find(e, 'plain', 'E', 'X', 'nocors', name, 'none'))}`)]);
    return `With the attribute:\n\n${table(head, body)}\n\nWithout it (the control; the answer's ACAO does not matter to a no-cors load):\n\n${table(head.map(h => h.replace('(crossorigin=anonymous)', '(no attribute)')), control)}`;
}

function same() {
    const head = ['Target', 'Frame', ...ENGINES.map(e => `${e}: no attribute → anonymous`)];
    const body: string[][] = [];
    for (const [T, text] of [['X', 'X, another site (a listed origin)'], ['S', 'S, sibling subdomain (the host page\'s site)'], ['H', 'H, the host page\'s own origin']] as const) {
        for (const struct of ['plain', 'strict']) {
            body.push([text, struct, ...ENGINES.map(e => {
                const set = (co: string) => {
                    const u = new Set<string>();
                    for (const r of rows(e, struct)) if (r.group === 'E' && r.T === T && r.A === 'cors' && r.co === co && !r.name.startsWith('link-') && r.name !== 'video-poster') for (const h of r.hits) h.cookies.forEach(c => u.add(c));
                    return u.size === 0 ? 'none' : `${u.size} (${[...u].sort().join(', ')})`;
                };
                return `${set('none')} → ${set('anon')}`;
            })]);
        }
    }
    return table(head, body);
}

function q2() {
    const out: string[] = [];
    // poster
    const p = ['Poster', ...ENGINES.map(() => '')];
    out.push('**Poster.** `<video poster crossorigin=anonymous>`, the answer with and without ACAO:\n');
    out.push(table(['', ...ENGINES], [
        ['request mode / Origin (ACAO *)', ...ENGINES.map(e => { const h = first(find(e, 'plain', 'E', 'X', 'cors', 'video-poster', 'anon')); return h ? `${h.mode} / ${h.origin}` : 'no request'; })],
        ['cookies on it', ...ENGINES.map(e => cell(names(find(e, 'plain', 'E', 'X', 'cors', 'video-poster', 'anon'))))],
        ['no ACAO: poster shown?', ...ENGINES.map(e => outcome(find(e, 'plain', 'E', 'X', 'nocors', 'video-poster', 'anon')))],
        ['honours the video\'s crossorigin?', ...ENGINES.map(e => { const h = first(find(e, 'plain', 'E', 'X', 'cors', 'video-poster', 'anon')); return h && h.mode === 'cors' ? 'yes' : '**no**'; })],
    ]));
    // track
    out.push('\n**Track.** A `<track>` is fetched in CORS mode whatever the element says; does the video need `crossorigin`?\n');
    const trk = (e: string, name: string, A: string, co: string) => {
        const r = find(e, 'plain', 'E', 'X', A, name, co);
        const h = first(r);
        return `${outcome(r)}${h ? ` (${h.mode}, cookies ${cell(names(r))})` : ' (no request)'}`;
    };
    out.push(table(['Case', ...ENGINES], [
        ['`default` track, no attribute, ACAO *', ...ENGINES.map(e => trk(e, 'track-src', 'cors', 'none'))],
        ['`default` track, anonymous, ACAO *', ...ENGINES.map(e => trk(e, 'track-src', 'cors', 'anon'))],
        ['`default` track, anonymous, no ACAO', ...ENGINES.map(e => trk(e, 'track-src', 'nocors', 'anon'))],
        ['script-added track (showing), no attribute, ACAO *', ...ENGINES.map(e => trk(e, 'track-live', 'cors', 'none'))],
        ['script-added track (showing), anonymous, ACAO *', ...ENGINES.map(e => trk(e, 'track-live', 'cors', 'anon'))],
        ['script-added track (showing), anonymous, no ACAO', ...ENGINES.map(e => trk(e, 'track-live', 'nocors', 'anon'))],
    ]));
    // range
    out.push('\n**Range and seeking.** A 12 s, ~7 MB WebM (`preload=metadata`), seek to 75 % of the duration, then play; the server answers `206` to `Range` unless it says `norange`. ACAO `*`, target X:\n');
    const m = (e: string, name: string, A: string, co: string) => {
        const r = find(e, 'plain', 'M', 'X', A, name, co);
        if (!r) return 'n/a';
        const ranges = r.hits.filter(h => h.range !== '-').length, six = r.hits.filter(h => h.status === 206).length;
        const o = r.result;
        const state = o.outcome === 'loadedmetadata' ? `seeked=${o.seeked === 'seeked'}, played=${o.advanced === true}` : `${o.outcome}${o.err ? ` code ${o.err}` : ''}`;
        const cookies = new Set(r.hits.flatMap(h => h.cookies)).size;
        const ctype = [...new Set(r.hits.map(h => h.mode))].join('/');
        return `${state}; ${r.hits.length} requests (${ranges} ranged, ${six}×206); ${ctype}; cookies ${cookies}`;
    };
    out.push(table(['Case', ...ENGINES], [
        ['no attribute (control)', ...ENGINES.map(e => m(e, 'webm-seek', 'cors', 'none'))],
        ['anonymous', ...ENGINES.map(e => m(e, 'webm-seek', 'cors', 'anon'))],
        ['no attribute, play from the start (no seek)', ...ENGINES.map(e => { const r = find(e, 'plain', 'M', 'X', 'cors', 'webm-play', 'none'); return r ? `moved=${r.result.advanced === true} (readyState ${r.result.rs}, paused ${r.result.paused}, at ${r.result.now} s)` : 'n/a'; })],
        ['anonymous, play from the start (no seek)', ...ENGINES.map(e => { const r = find(e, 'plain', 'M', 'X', 'cors', 'webm-play', 'anon'); return r ? `moved=${r.result.advanced === true} (readyState ${r.result.rs}, paused ${r.result.paused}, at ${r.result.now} s)` : 'n/a'; })],
        ['anonymous, server ignores `Range`', ...ENGINES.map(e => m(e, 'webm-seek-norange', 'cors', 'anon'))],
        ['no attribute, server ignores `Range`', ...ENGINES.map(e => m(e, 'webm-seek-norange', 'cors', 'none'))],
        ['anonymous, no ACAO', ...ENGINES.map(e => m(e, 'webm-seek', 'nocors', 'anon'))],
        ['anonymous, same-site target S, ACAO `*`', ...ENGINES.map(e => { const r = find(e, 'plain', 'M', 'S', 'cors', 'webm-seek', 'anon'); if (!r) return 'n/a'; return `seeked=${r.result.seeked === 'seeked'}; ${r.hits.length} requests; cookies ${new Set(r.hits.flatMap(h => h.cookies)).size}`; })],
    ]));
    const preflights = ENGINES.map(e => `${e} ${['plain', 'strict'].flatMap(st => rows(e, st)).flatMap(r => r.hits).filter(h => h.method !== 'GET').length}`).join(', ');
    out.push(`\nRequests that were not GET (a CORS preflight, for example), over every case of the run: ${preflights}.`);
    return out.join('\n');
}

const CSS: [string, string][] = [
    ['style-attr', '`style="background:url()"`'], ['style-tag', '`<style>` `background:url()`'], ['import', '`<style>@import url()`'], ['font-face', '`@font-face src:url()`'],
    ['image-set-url', '`image-set(url() 1x)`'], ['image-set-string', '`image-set("…" 1x)`'], ['list-style-image', '`list-style-image`'], ['content-url', '`content:url()`'],
    ['mask-image', '`mask-image:url()`'], ['border-image', '`border-image-source`'], ['svg-fill-url', 'SVG `fill:url()`'],
    ['mod-bg-anon', '`url("…" crossorigin(anonymous))`'], ['mod-import-anon', '`@import url("…" crossorigin(anonymous))`'], ['mod-font-anon', '`@font-face` `url("…" crossorigin(anonymous))`'], ['mod-imageset-anon', '`image-set(url("…" crossorigin(anonymous)))`'],
];

function q3() {
    const out: string[] = [];
    const cellOf = (e: string, name: string, T: string) => {
        const r = find(e, 'plain', 'C', T, 'cors', name);
        const h = first(r);
        if (!r) return 'n/a';
        if (!h) return 'no request';
        const o = r.result;
        const extra = name.includes('font') ? (o.outcome === 'load' ? ', font loaded' : ', font not loaded') : '';
        return `${h.mode}, cookies ${cell(names(r))}${extra}`;
    };
    out.push(table(['CSS load (target X, ACAO `*`)', ...ENGINES], CSS.map(([n, t]) => [t, ...ENGINES.map(e => cellOf(e, n, 'X'))])));
    out.push('\n`CSS.supports()` for the request modifier, per engine: ' + ENGINES.map(e => `${e} \`${find(e, 'plain', 'C', 'X', 'cors', 'supports')?.result.outcome}\``).join(', ') + '.');
    out.push('\nThe stylesheet\'s own subresources (a `<link rel=stylesheet>` with and without the attribute, and an `@import`ed sheet), target X, ACAO `*`; the stylesheet itself, then what its text loads:\n');
    const sub = (e: string, name: string, co: string, suffix?: string) => {
        const r = find(e, 'plain', name.startsWith('link') ? 'E' : 'C', 'X', 'cors', name, co);
        if (!r) return 'n/a';
        const hs = r.hits.filter(h => suffix === undefined ? !h.k.includes('.sub-') : h.k.endsWith(suffix));
        if (hs.length === 0) return 'no request';
        return `${hs[0]!.mode}, cookies ${cell([...new Set(hs.flatMap(h => h.cookies))])}`;
    };
    const rowsOf: [string, string, string][] = [['link', 'link-stylesheet', 'none'], ['link', 'link-stylesheet', 'anon'], ['import', 'import', '-']];
    const parts: [string, string | undefined][] = [['the sheet', undefined], ['`@import` in it', '.sub-import'], ['`@font-face` in it', '.sub-font'], ['`background:url()` in it', '.sub-bg'], ['`image-set()` in it', '.sub-set']];
    out.push(table(['Sheet', 'Part', ...ENGINES], rowsOf.flatMap(([, n, co]) => parts.map(([p, suffix], i) => [i === 0 ? (n === 'import' ? '`<style>@import` (no attribute possible)' : `\`<link rel=stylesheet${co === 'anon' ? ' crossorigin=anonymous' : ''}>\``) : '', p, ...ENGINES.map(e => sub(e, n, co, suffix))]))));
    const paint = (e: string) => { const f = path.join(here, 'results', `${e}-paint.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; };
    out.push('\nDoes an image behind `url("…" crossorigin(…))` paint (element screenshot against a blank box), ACAO `*`: ' + ENGINES.map(e => { const p = paint(e); return `${e}: plain url() ${String(p['cors.plain']).split(';')[0]}, anonymous ${String(p['cors.anon']).split(';')[0]}, use-credentials ${String(p['cors.uc']).split(';')[0]}`; }).join('; ') + '.');
    return out.join('\n');
}

function q4() {
    const out: string[] = [];
    const D = (e: string, name: string, A = 'cors', T = 'X', co = '-') => find(e, 'plain', 'D', T, A, name, co);
    const c = (e: string, name: string, A = 'cors', co = '-') => {
        const r = D(e, name, A, 'X', co);
        if (!r) return 'n/a';
        const hs = r.hits.filter(h => !h.k.endsWith('.hop'));
        if (hs.length === 0) return 'no request';
        return hs.map(h => (h.cookies.length > 0 ? `**${h.mode}, ${h.cookies.length} cookies**` : `${h.mode}, none`)).join(' then ');
    };
    out.push('**Order and place of the attribute** (target X, ACAO `*`; each cell lists the requests of the element in order):\n');
    const rowsA: [string, string, string][] = [
        ['`img`: `src` then `crossOrigin`, same task', 'live-img-src-then-co-sync', 'cors'], ['`img`: `src`, microtask, `crossOrigin`', 'live-img-src-then-co-microtask', 'cors'],
        ['`img`: `src`, task, `crossOrigin`', 'live-img-src-then-co-task', 'cors'], ['`img`: `src`, 100 ms, `crossOrigin`', 'live-img-src-then-co-100ms', 'cors'],
        ['`img`: `crossOrigin` then `src`', 'live-img-co-then-src', 'cors'],
        ['`audio`: `src` then `crossOrigin`, same task', 'live-audio-src-then-co-sync', 'cors'], ['`audio`: `src`, microtask, `crossOrigin`', 'live-audio-src-then-co-microtask', 'cors'],
        ['`audio`: `src`, task, `crossOrigin`', 'live-audio-src-then-co-task', 'cors'], ['`audio`: `src`, 100 ms, `crossOrigin`', 'live-audio-src-then-co-100ms', 'cors'],
        ['`audio`: `crossOrigin` then `src`', 'live-audio-co-then-src', 'cors'],
        ['`video`: `poster` then `crossOrigin`, same task', 'live-poster-src-then-co-sync', 'cors'], ['`link`: in the document, `href` then `crossOrigin`', 'live-link-href-then-co', 'cors'],
    ];
    out.push(table(['Order', ...ENGINES], rowsA.map(([t, n, A]) => [t, ...ENGINES.map(e => c(e, n, A))])));
    out.push('\n**The attribute on the wrong element, and other values** (`<img>`/`<audio>` rows use the attribute on the loading element):\n');
    const rowsB: [string, string, string][] = [
        ['`crossorigin` on `<source>` in `<video>` only', 'co-on-source-in-video', 'cors'], ['`crossorigin` on `<source>` in `<picture>` only', 'co-on-source-in-picture', 'cors'],
        ['`crossorigin` on `<picture>` only', 'co-on-picture-only', 'cors'],
        ['`<img crossorigin="use-credentials">` (ACAO null + credentials)', 'img-co-usecred', 'creds'], ['`<audio crossorigin="use-credentials">`', 'audio-co-usecred', 'creds'],
        ['`<img crossorigin="foo">`', 'img-co-invalid', 'cors'], ['`<img crossorigin>` (empty)', 'img-co-empty', 'cors'], ['`<img crossorigin="ANONYMOUS">`', 'img-co-upper', 'cors'],
        ['`<audio crossorigin="foo">`', 'audio-co-invalid', 'cors'], ['`<audio crossorigin>` (empty)', 'audio-co-empty', 'cors'],
    ];
    out.push(table(['Case', ...ENGINES], rowsB.map(([t, n, A]) => [t, ...ENGINES.map(e => c(e, n, A))])));
    out.push('\n**A redirect** from the listed origin X to another origin (S), both answering ACAO `*`; the first request, then the hop:\n');
    const hop = (e: string, co: string) => { const r = D(e, 'img-redirect', 'cors', 'X', co); if (!r) return 'n/a'; return r.hits.map(h => `${h.k.endsWith('.hop') ? 'hop' : 'first'} ${h.status === 0 ? '?' : h.status} ${h.mode === '-' ? 'cors*' : h.mode}, ${h.cookies.length > 0 ? `**${h.cookies.length} cookies**` : 'none'}`).join('; '); };
    out.push(table(['Case', ...ENGINES], [['`<img src>` redirected, no attribute', ...ENGINES.map(e => hop(e, 'none'))], ['`<img crossorigin=anonymous src>` redirected', ...ENGINES.map(e => hop(e, 'anon'))]]));
    out.push('\n(`cors*`: WebKit sends no `Sec-Fetch-Mode` on a redirect hop; the hop carried no cookie and an `Origin`.)\n');
    out.push('\n**Loads no `crossorigin` attribute can reach** (target X; all of them are outside the renderer\'s element and attribute allowlists):\n');
    const rowsC: [string, string][] = [
        ['`<td background=…>` (legacy presentational attribute)', 'table-background'], ['`<body background>` set by script', 'body-background'], ['`<input type=image src>`', 'input-image'],
        ['`<svg><image href>`', 'svg-image'], ['`<svg><image href crossorigin=anonymous>`', 'svg-image-co'], ['`<svg><feImage href>`', 'svg-feimage'],
    ];
    out.push(table(['Element', ...ENGINES], rowsC.map(([t, n]) => [t, ...ENGINES.map(e => c(e, n))])));
    return out.join('\n');
}

function blob() {
    const names: [string, string][] = [['blob-img-none', '`<img src=blob:>`, no attribute'], ['blob-img-anon', '`<img crossorigin=anonymous src=blob:>`'], ['blob-srcset-anon', '`<img crossorigin=anonymous srcset=blob:>`'],
        ['blob-audio-none', '`<audio src=blob:>`, no attribute'], ['blob-audio-anon', '`<audio crossorigin=anonymous src=blob:>`'], ['blob-poster-anon', '`<video crossorigin=anonymous poster=blob:>`'],
        ['blob-link-none', '`<link rel=stylesheet href=blob:>`, no attribute'], ['blob-link-anon', '`<link rel=stylesheet crossorigin=anonymous href=blob:>`']];
    const res = (e: string, struct: string, n: string) => { const r = rows(e, struct).find(x => x.group === 'B' && x.name === n); if (!r) return 'n/a'; const o = r.result; return `${o.outcome}${o.nw !== undefined ? ` nw=${o.nw}` : ''}${o.applied !== undefined ? ` applied=${o.applied}` : ''}${o.err ? ` err=${o.err}` : ''}`; };
    return table(['Load of a blob: URL minted in the view\'s own document', ...ENGINES], names.map(([n, t]) => [t, ...ENGINES.map(e => `${res(e, 'blob-plain', n)}${res(e, 'blob-strict', n) === res(e, 'blob-plain', n) ? '' : ` (strict: ${res(e, 'blob-strict', n)})`}`)]));
}

function view() {
    const out: string[] = [];
    const get = (e: string, v: string) => { const f = path.join(here, 'results', `${e}-view-${v}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
    const kinds = ['img', 'srcset', 'picsource', 'guest-usecred', 'video', 'poster', 'track', 'sourcevideo', 'track2', 'audio', 'sourceaudio', 'styleattr', 'import', 'import.sub-import', 'stylebg', 'font'];
    const head = ['Load', ...ENGINES.flatMap(e => [`${e} baseline`, `${e} forced`])];
    const body = kinds.map(k => [`\`${k}\``, ...ENGINES.flatMap(e => ['baseline', 'forced'].map(v => {
        const d = get(e, v);
        if (!d) return 'n/a';
        const h = (d.cors.hits as any[]).find(x => x.k === k);
        if (!h) return '-';
        return `${h.mode}${h.cookies.length > 0 ? `, **${h.cookies.length}**` : ', 0'}`;
    }))]);
    out.push(table(head, body));
    out.push('\nCell: `Sec-Fetch-Mode`, cookies on the request (ACAO `*`; `-`: the request was never made). Without ACAO, the same cookies, and: ' + ENGINES.map(e => { const d = get(e, 'forced'); if (!d) return ''; return `${e} forced: violations ${d.nocors.violations.length}, image widths ${d.nocors.imageWidths} (cors run: ${d.cors.imageWidths})`; }).join('; ') + '.');
    out.push('\nThe view\'s own files (registered `pic.png`, `tone.wav`, `own.css`, minted as `blob:` URLs), ACAO `*` run: ' + ['baseline', 'forced'].map(v => `${v}: ` + ENGINES.map(e => { const d = get(e, v); if (!d) return ''; const o = JSON.parse(d.cors.ownFiles); return `${e} image ${o.img}px, audio readyState ${o.audio}${o.audioError ? ` error ${o.audioError}` : ''}, css ${o.css}`; }).join('; ')).join(' | ') + '.');
    out.push('\nThe renderer\'s crossorigin attributes after the rewrite (cors run): ' + ENGINES.map(e => { const d = get(e, 'forced'); return d ? `${e} ${JSON.parse(d.cors.crossoriginAttributes).filter((x: string) => !x.endsWith(':null')).join(' ')}` : ''; }).join('; ') + '.');
    return out.join('\n');
}

const which = process.argv[2] ?? 'all';
const SECTIONS: Record<string, () => string> = {
    q1: () => q1('X', 'plain', 'Target X, ACAO `*`, plain frame (cookies on the request: number of distinct cookies; the control without the attribute → with it)'),
    q1strict: () => q1('X', 'strict', 'Target X, ACAO `*`, strict structure (credentialless wrapper frame)'),
    q1shape: shape, q1fail: fail, q1same: same, q2, q3, q4, blob, view,
};
for (const [name, make] of Object.entries(SECTIONS)) if (which === 'all' || which === name) console.log(`<!-- ${name} -->\n${make()}\n`);
