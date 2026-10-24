// Research 21: the cases (probe.spec.ts) and the page that runs them (RUNNER). A case is one element or one CSS load,
// inserted into a document that is set up like the strict view's (opaque origin, sandbox without allow-same-origin, a
// policy that lists the three origins for images, media, fonts and styles). Every case has a unique id: it is the
// element's id, the `k` parameter of its URL (so the listener can say which request it was), and the prefix of the `k`
// of its sub-requests (`<id>.sub-bg`, a redirect's `<id>.hop`).
import { PNG, type Acao, type Target } from './server';

export type Case = {
    id: string; group: string; T: Target; A: Acao; name: string; co: string;
    wait: string; html?: string; js?: string; family?: string;
};
export type Origins = (t: Target) => string;

const esc = (s: string) => s.replaceAll('&', '&amp;');

function builder(origin: Origins, T: Target, A: Acao, group: string) {
    const U = (file: string, id: string, extra = '', acao: Acao = A) => `${origin(T)}/${acao}/${file}?k=${id}${extra}`;
    const out: Case[] = [];
    const add = (name: string, co: string, wait: string, make: (id: string) => { html?: string; js?: string; family?: string }) => {
        const id = [group, T, A, name, co].join('.');
        out.push({ id, group, T, A, name, co, wait, ...make(id) });
    };
    return { U, add, out };
}

/** Q1: every element the renderer lets load, without (`none`) and with (`anon`) crossorigin="anonymous", for one target and answer. */
export function elementCases(origin: Origins, T: Target, A: Acao): Case[] {
    const { U, add, out } = builder(origin, T, A, 'E');
    for (const co of ['none', 'anon']) {
        const at = co === 'anon' ? ' crossorigin="anonymous"' : '';
        add('img-src', co, 'load', id => ({ html: `<img id="${id}" src="${U('a.png', id)}"${at}>` }));
        add('img-srcset', co, 'load', id => ({ html: `<img id="${id}" srcset="${U('a.png', id)} 1x"${at}>` }));
        add('picture-srcset', co, 'load', id => ({ html: `<picture><source srcset="${U('a.png', id)}"><img id="${id}"${at}></picture>` }));
        add('video-src', co, 'media', id => ({ html: `<video id="${id}" preload="auto" src="${U('e.wav', id)}"${at}></video>` }));
        add('video-poster', co, 'poster', id => ({ html: `<video id="${id}" preload="none" poster="${U('a.png', id)}"${at}></video>` }));
        add('audio-src', co, 'media', id => ({ html: `<audio id="${id}" preload="auto" src="${U('e.wav', id)}"${at}></audio>` }));
        add('source-in-video', co, 'media', id => ({ html: `<video id="${id}" preload="auto"${at}><source src="${U('e.wav', id)}" type="audio/wav"></video>` }));
        add('source-in-audio', co, 'media', id => ({ html: `<audio id="${id}" preload="auto"${at}><source src="${U('e.wav', id)}" type="audio/wav"></audio>` }));
        // the media itself always answers CORS (`cors`), so only the track's own answer varies
        add('track-src', co, 'track', id => ({ html: `<video id="${id}" preload="auto"${at} src="${U('e.wav', id + '.media', '', 'cors')}"><track default kind="subtitles" src="${U('g.vtt', id)}"></video>` }));
        // the track added by script, its mode set to showing: for an engine that does not fetch a `default` track by itself
        add('track-live', co, 'js', id => ({ js: `const v = document.createElement('video'); v.id = c.id; v.preload = 'auto'; ${co === 'anon' ? "v.crossOrigin = 'anonymous';" : ''} v.src = ${JSON.stringify(U('e.wav', id + '.media', '', 'cors'))}; const t = document.createElement('track'); t.kind = 'subtitles'; t.src = ${JSON.stringify(U('g.vtt', id))}; v.append(t); const p = W.track(v); document.body.append(v); t.track.mode = 'showing'; return p;` }));
        add('link-stylesheet', co, 'sheet', id => ({ html: `<link id="${id}" rel="stylesheet" href="${U('s.css', id)}"${at}><div data-c="${id}">x</div>` }));
        add('link-icon', co, 'sleep', id => ({ html: `<link id="${id}" rel="icon" href="${U('a.png', id)}"${at}>` }));
    }
    return out;
}

/** Q3: loads started by CSS, which carry no crossorigin attribute (and the CSS `crossorigin()` request modifier). */
export function cssCases(origin: Origins, T: Target, A: Acao): Case[] {
    const { U, add, out } = builder(origin, T, A, 'C');
    const box = (id: string, style: string) => `<div id="${id}" data-c="${id}" style="width:5px;height:5px;${style}"></div>`;
    add('style-attr', '-', 'sleep', id => ({ html: box(id, `background:url(${U('a.png', id)})`) }));
    add('style-tag', '-', 'sleep', id => ({ html: `<style>[data-c="${id}"]{width:5px;height:5px;background:url(${U('a.png', id)})}</style><div id="${id}" data-c="${id}"></div>` }));
    add('import', '-', 'sleep', id => ({ html: `<style>@import url(${U('s.css', id)});</style><div id="${id}" data-c="${id}">x</div>` }));
    add('font-face', '-', 'font', id => ({ family: `Q-${id}`, html: `<style>@font-face{font-family:"Q-${id}";src:url(${U('f.ttf', id)})}</style><p id="${id}" style="font-family:'Q-${id}'">x</p>` }));
    add('image-set-url', '-', 'sleep', id => ({ html: box(id, `background:image-set(url(${U('a.png', id)}) 1x)`) }));
    add('image-set-string', '-', 'sleep', id => ({ html: box(id, `background:image-set('${U('a.png', id)}' 1x)`) }));
    add('list-style-image', '-', 'sleep', id => ({ html: `<ul><li id="${id}" style="list-style-image:url(${U('a.png', id)})">x</li></ul>` }));
    add('content-url', '-', 'sleep', id => ({ html: box(id, `content:url(${U('a.png', id)})`) }));
    add('mask-image', '-', 'sleep', id => ({ html: box(id, `background:red;-webkit-mask-image:url(${U('a.png', id)});mask-image:url(${U('a.png', id)})`) }));
    add('border-image', '-', 'sleep', id => ({ html: box(id, `border:2px solid;border-image-source:url(${U('a.png', id)})`) }));
    add('svg-fill-url', '-', 'sleep', id => ({ html: `<svg width="5" height="5"><rect id="${id}" width="5" height="5" style="fill:url('${U('a.png', id)}')"/></svg>` }));
    // the CSS request modifier crossorigin(): url("…" crossorigin(anonymous))
    add('mod-bg-anon', '-', 'sleep', id => ({ html: box(id, `background:url("${U('a.png', id)}" crossorigin(anonymous))`) }));
    add('mod-bg-usecred', '-', 'sleep', id => ({ html: box(id, `background:url("${U('a.png', id)}" crossorigin(use-credentials))`) }));
    add('mod-import-anon', '-', 'sleep', id => ({ html: `<style>@import url("${U('s.css', id)}" crossorigin(anonymous));</style><div id="${id}" data-c="${id}">x</div>` }));
    add('mod-font-anon', '-', 'font', id => ({ family: `Q-${id}`, html: `<style>@font-face{font-family:"Q-${id}";src:url("${U('f.ttf', id)}" crossorigin(anonymous))}</style><p id="${id}" style="font-family:'Q-${id}'">x</p>` }));
    add('mod-imageset-anon', '-', 'sleep', id => ({ html: box(id, `background:image-set(url("${U('a.png', id)}" crossorigin(anonymous)) 1x)`) }));
    out.push({ id: `C.${T}.${A}.supports`, group: 'C', T, A, name: 'supports', co: '-', wait: 'js', js: `return { outcome: 'supports=' + CSS.supports('background-image', 'url("a.png" crossorigin(anonymous))') + ' bg=' + CSS.supports('background', 'image-set(url("a.png" crossorigin(anonymous)) 1x)') };` });
    return out;
}

/** Q4: can guest markup defeat the attribute: late attribute, the attribute on the wrong element, other values, loads that have none. */
export function defeatCases(origin: Origins, T: Target, A: Acao): Case[] {
    const { U, add, out } = builder(origin, T, A, 'D');
    const other = origin(T === 'X' ? 'S' : 'X');
    // live-document order: what the renderer would do if it set the attribute last, after the URL, in a document
    const live = (name: string, tag: 'img' | 'audio', gap: string) => add(name, '-', 'js', id => ({
        js: tag === 'img'
            ? `const i = new Image(); i.id = c.id; const p = W.load(i); i.src = ${JSON.stringify(U('a.png', id))}; ${gap} i.crossOrigin = 'anonymous'; document.body.append(i); return p;`
            : `const a = document.createElement('audio'); a.id = c.id; a.preload = 'auto'; const p = W.media(a); a.src = ${JSON.stringify(U('e.wav', id))}; ${gap} a.crossOrigin = 'anonymous'; document.body.append(a); return p;`,
    }));
    for (const tag of ['img', 'audio'] as const) {
        live(`live-${tag}-src-then-co-sync`, tag, '');
        live(`live-${tag}-src-then-co-microtask`, tag, 'await Promise.resolve();');
        live(`live-${tag}-src-then-co-task`, tag, 'await sleep(0);');
        live(`live-${tag}-src-then-co-100ms`, tag, 'await sleep(100);');
        add(`live-${tag}-co-then-src`, '-', 'js', id => ({
            js: tag === 'img'
                ? `const i = new Image(); i.id = c.id; i.crossOrigin = 'anonymous'; i.src = ${JSON.stringify(U('a.png', id))}; document.body.append(i); return W.load(i);`
                : `const a = document.createElement('audio'); a.id = c.id; a.preload = 'auto'; a.crossOrigin = 'anonymous'; a.src = ${JSON.stringify(U('e.wav', id))}; document.body.append(a); return W.media(a);`,
        }));
    }
    add('live-poster-src-then-co-sync', '-', 'js', id => ({ js: `const v = document.createElement('video'); v.id = c.id; v.preload = 'none'; v.poster = ${JSON.stringify(U('a.png', id))}; v.crossOrigin = 'anonymous'; document.body.append(v); return W.poster(v);` }));
    add('live-link-href-then-co', '-', 'js', id => ({ js: `const l = document.createElement('link'); l.id = c.id; l.rel = 'stylesheet'; document.body.append(l); l.href = ${JSON.stringify(U('s.css', id))}; l.crossOrigin = 'anonymous'; return W.sheet(l, c);` }));
    // the attribute on the element that does not load
    add('co-on-source-in-video', '-', 'media', id => ({ html: `<video id="${id}" preload="auto"><source src="${U('e.wav', id)}" type="audio/wav" crossorigin="anonymous"></video>` }));
    add('co-on-source-in-picture', '-', 'load', id => ({ html: `<picture><source srcset="${U('a.png', id)}" crossorigin="anonymous"><img id="${id}"></picture>` }));
    add('co-on-picture-only', '-', 'load', id => ({ html: `<picture crossorigin="anonymous"><source srcset="${U('a.png', id)}"><img id="${id}"></picture>` }));
    // other values of the attribute
    for (const [name, value] of [['usecred', 'use-credentials'], ['invalid', 'foo'], ['empty', ''], ['upper', 'ANONYMOUS'], ['anon', 'anonymous']] as const) {
        add(`img-co-${name}`, '-', 'load', id => ({ html: `<img id="${id}" src="${U('a.png', id)}" crossorigin="${value}">` }));
        add(`audio-co-${name}`, '-', 'media', id => ({ html: `<audio id="${id}" preload="auto" src="${U('e.wav', id)}" crossorigin="${value}"></audio>` }));
    }
    // a redirect from the CORS URL to another origin
    for (const co of ['none', 'anon']) {
        const at = co === 'anon' ? ' crossorigin="anonymous"' : '';
        add('img-redirect', co, 'load', id => ({ html: `<img id="${id}" src="${esc(U('r.png', id, `&to=${encodeURIComponent(`${other}/${A}/a.png?k=${id}.hop`)}`))}"${at}>` }));
    }
    // loads the platform has that no crossorigin attribute reaches (the renderer's attribute and element allowlists keep them out)
    add('table-background', '-', 'sleep', id => ({ html: `<table><tr><td id="${id}" background="${U('a.png', id)}">x</td></tr></table>` }));
    add('body-background', '-', 'js', id => ({ js: `document.body.setAttribute('background', ${JSON.stringify(U('a.png', id))}); await sleep(1500); return { outcome: 'n/a' };` }));
    add('input-image', '-', 'load', id => ({ html: `<input type="image" id="${id}" src="${U('a.png', id)}">` }));
    add('svg-image', '-', 'sleep', id => ({ html: `<svg width="5" height="5"><image id="${id}" href="${U('a.png', id)}" width="5" height="5"/></svg>` }));
    add('svg-image-co', '-', 'sleep', id => ({ html: `<svg width="5" height="5"><image id="${id}" href="${U('a.png', id)}" width="5" height="5" crossorigin="anonymous"/></svg>` }));
    add('svg-feimage', '-', 'sleep', id => ({ html: `<svg width="5" height="5"><filter id="${id}f"><feImage href="${U('a.png', id)}"/></filter><rect id="${id}" width="5" height="5" filter="url(#${id}f)"/></svg>` }));
    add('video-poster-plus-src', '-', 'poster', id => ({ html: `<video id="${id}" preload="none" crossorigin="anonymous" poster="${U('a.png', id)}"></video>` }));
    return out;
}

/**
 * The view's own files: blob: URLs minted in the view's document (in-sandbox-view.ts mints them there), loaded with the
 * attribute. A blob: URL is fetched in CORS mode here, which the Fetch spec allows for the same origin only.
 */
export function blobCases(): Case[] {
    const png = JSON.stringify(PNG.toString('base64'));
    const mk = (name: string, wait: string, js: string): Case => ({ id: `B.-.-.${name}`, group: 'B', T: 'X', A: 'cors', name, co: '-', wait, js });
    const bytes = `Uint8Array.from(atob(${png}), ch => ch.charCodeAt(0))`;
    const wavBytes = `(() => { const n = 800, b = new DataView(new ArrayBuffer(44 + n * 2)); const w = (o, t) => { for (let i = 0; i < t.length; i++) b.setUint8(o + i, t.charCodeAt(i)); }; w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true); return new Uint8Array(b.buffer); })()`;
    return [
        mk('blob-img-none', 'js', `const i = new Image(); i.id = c.id; const p = W.load(i); i.src = URL.createObjectURL(new Blob([${bytes}], { type: 'image/png' })); document.body.append(i); return p;`),
        mk('blob-img-anon', 'js', `const i = new Image(); i.id = c.id; i.crossOrigin = 'anonymous'; const p = W.load(i); i.src = URL.createObjectURL(new Blob([${bytes}], { type: 'image/png' })); document.body.append(i); return p;`),
        mk('blob-srcset-anon', 'js', `const i = new Image(); i.id = c.id; i.crossOrigin = 'anonymous'; const p = W.load(i); i.srcset = URL.createObjectURL(new Blob([${bytes}], { type: 'image/png' })) + ' 1x'; document.body.append(i); return p;`),
        mk('blob-audio-none', 'js', `const a = document.createElement('audio'); a.id = c.id; a.preload = 'auto'; const p = W.media(a); a.src = URL.createObjectURL(new Blob([${wavBytes}], { type: 'audio/wav' })); document.body.append(a); return p;`),
        mk('blob-audio-anon', 'js', `const a = document.createElement('audio'); a.id = c.id; a.preload = 'auto'; a.crossOrigin = 'anonymous'; const p = W.media(a); a.src = URL.createObjectURL(new Blob([${wavBytes}], { type: 'audio/wav' })); document.body.append(a); return p;`),
        mk('blob-poster-anon', 'js', `const v = document.createElement('video'); v.id = c.id; v.preload = 'none'; v.crossOrigin = 'anonymous'; v.poster = URL.createObjectURL(new Blob([${bytes}], { type: 'image/png' })); document.body.append(v); return W.poster(v);`),
        mk('blob-link-anon', 'js', `const l = document.createElement('link'); l.id = c.id; l.rel = 'stylesheet'; l.crossOrigin = 'anonymous'; const d = document.createElement('div'); d.setAttribute('data-c', c.id); d.textContent = 'x'; document.body.append(d); const p = W.sheet(l, c); l.href = URL.createObjectURL(new Blob(['[data-c="' + c.id + '"]{width:7px;height:7px}'], { type: 'text/css' })); document.body.append(l); return p;`),
        mk('blob-link-none', 'js', `const l = document.createElement('link'); l.id = c.id; l.rel = 'stylesheet'; const d = document.createElement('div'); d.setAttribute('data-c', c.id); d.textContent = 'x'; document.body.append(d); const p = W.sheet(l, c); l.href = URL.createObjectURL(new Blob(['[data-c="' + c.id + '"]{width:7px;height:7px}'], { type: 'text/css' })); document.body.append(l); return p;`),
    ];
}

/** Q2: media under crossorigin: does a seek stream (a Range request) with ACAO *? `norange`: a server that ignores Range. */
export function mediaCases(origin: Origins, T: Target, A: Acao): Case[] {
    const { U, add, out } = builder(origin, T, A, 'M');
    for (const co of ['none', 'anon']) {
        const at = co === 'anon' ? ' crossorigin="anonymous"' : '';
        add('webm-seek', co, 'seek', id => ({ html: `<video id="${id}" preload="metadata" muted src="${esc(U('v.webm', id))}"${at}></video>` }));
        add('webm-play', co, 'play', id => ({ html: `<video id="${id}" preload="metadata" muted src="${esc(U('v.webm', id))}"${at}></video>` }));
        add('wav-seek', co, 'seek', id => ({ html: `<audio id="${id}" preload="metadata" src="${esc(U('e.wav', id))}"${at}></audio>` }));
        if (A === 'cors') add('webm-seek-norange', co, 'seek', id => ({ html: `<video id="${id}" preload="metadata" muted src="${esc(U('v.webm', id, '&norange=1'))}"${at}></video>` }));
    }
    return out;
}

/** The page that runs the cases inside the view-like frame. CASES is spliced in. */
export const RUNNER = String.raw`
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ev = (el, names, ms, accept) => new Promise(res => {
    let done = false; const fin = v => { if (!done) { done = true; res(v); } };
    for (const n of names) el.addEventListener(n, e => { if (!accept || accept(e)) fin(n); }, true);
    setTimeout(() => fin('timeout'), ms);
  });
  const round = n => Math.round(n * 100) / 100;
  const W = {
    load: async el => { const r = await ev(el, ['load', 'error'], 2500); return { outcome: r, nw: el.naturalWidth || 0 }; },
    media: async el => {
      const r = await ev(el, ['loadedmetadata', 'error'], 3000, e => e.target === el || e.target.localName === 'source');
      return { outcome: r, rs: el.readyState, err: el.error ? el.error.code : 0, dur: round(el.duration) };
    },
    poster: async el => { await sleep(2000); const w = el.getBoundingClientRect().width; return { outcome: w === 3 ? 'load' : 'none', w }; },
    track: async el => {
      const t = el.querySelector('track');
      const r = await ev(t, ['load', 'error'], 3000);
      return { outcome: r, rs: t.readyState, cues: t.track.cues ? t.track.cues.length : -1 };
    },
    sheet: async (el, c) => {
      const r = await ev(el, ['load', 'error'], 2500); await sleep(400);
      const t = document.querySelector('[data-c="' + c.id + '"]');
      return { outcome: r, applied: !!t && getComputedStyle(t).width === '7px' };
    },
    font: async (el, c) => {
      const status = () => [...document.fonts].filter(f => f.family.replaceAll('"', '') === c.family).map(f => f.status).join(',') || 'noface';
      const loaded = await Promise.race([document.fonts.load('16px "' + c.family + '"').then(l => l.length, () => -1), sleep(2500).then(() => -2)]);
      return { outcome: loaded > 0 ? 'load' : 'fail', faces: loaded, status: status() };
    },
    sleep: async () => { await sleep(2000); return { outcome: 'n/a' }; },
    seek: async el => {
      const r = await ev(el, ['loadedmetadata', 'error'], 3500);
      if (r !== 'loadedmetadata') return { outcome: r, err: el.error ? el.error.code : 0 };
      const dur = el.duration, target = dur * 0.75;
      el.currentTime = target;
      const s = await ev(el, ['seeked', 'error'], 4000);
      const at = el.currentTime; let advanced = 'n/a';
      try {
        el.muted = true; await Promise.race([el.play(), sleep(1500).then(() => { throw { name: 'play-timeout' }; })]);
        for (let i = 0; i < 30 && !(el.currentTime > at); i++) await sleep(100); // up to 3 s to start moving
        advanced = el.currentTime > at;
      } catch (e) { advanced = 'play:' + e.name; }
      return { outcome: r, seeked: s, dur: round(dur), target: round(target), at: round(at), advanced, rs: el.readyState, paused: el.paused, now: round(el.currentTime) };
    },
    // plays from the start, no seek: does the clip move within 3 s?
    play: async el => {
      const r = await ev(el, ['loadedmetadata', 'error'], 3500);
      if (r !== 'loadedmetadata') return { outcome: r, err: el.error ? el.error.code : 0 };
      let advanced = 'n/a';
      try {
        el.muted = true; await Promise.race([el.play(), sleep(1500).then(() => { throw { name: 'play-timeout' }; })]);
        for (let i = 0; i < 30 && !(el.currentTime > 0.5); i++) await sleep(100);
        advanced = el.currentTime > 0.5;
      } catch (e) { advanced = 'play:' + e.name; }
      return { outcome: r, advanced, rs: el.readyState, paused: el.paused, now: round(el.currentTime) };
    },
  };
  const results = {};
  const jobs = CASES.map(async c => {
    try {
      if (c.js) results[c.id] = await new Function('document', 'sleep', 'c', 'W', 'return (async () => {' + c.js + '})()')(document, sleep, c, W);
      else {
        document.body.insertAdjacentHTML('beforeend', c.html);
        results[c.id] = await W[c.wait](document.getElementById(c.id), c);
      }
    } catch (e) { results[c.id] = { outcome: 'exception', error: String(e) }; }
  });
  await Promise.all(jobs);
  await sleep(800);
  top.postMessage({ results }, '*');
})();`;
