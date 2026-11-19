// Q7. The view speaks first (03, "Who receives the first port"): the host page posts nothing at load; C, when its gates
// and its check are done, posts { version, verdicts } to parent.parent with target origin '*'; the host page, whose
// message listener exists before the frame is inserted, accepts it only if event.source === frame.contentWindow[0], and
// only then posts the port to event.source (fixture.mjs: cScriptFirst, hostPage with `first`).
//
//   bun docs/research/31_served_startup/q7-view-first.mjs <engine> [starts]     # default 24 cost starts per order, 50 race starts
//
// Cases: the correct file (positive control); the readability of frame.contentWindow[0] in every state of the frame;
// forgeries: (a) another frame of the host page, (b) an SPA fallback whose widget frame speaks (and one whose widget does
// not), (c) F itself, (d) a page that frames the host page, (e) a second frame inside F, (f) C posts and is then reloaded,
// or replaced by F, before the host page answers (the port to event.source, and to frame.contentWindow[0]); the race (50
// starts, and 50 with the host page's main thread busy 200 ms at insertion); the cost against Q1's order (alternating);
// F framed by another site (what C's message carries); Q5's two cases (closed shadow root, light DOM) in this order.
import { ENGINES, emit, emitRun, load1, median, range, sleep } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';
import { hostPage, servedFile } from './fixture.mjs';
import { ATTACK } from './q5-framed-host.mjs';

/** What a forger posts: the shape of C's announcement, with clean verdicts (constants anyone can read from the file). */
const FORGED = { version: '1', verdicts: { C: { gates: {}, check: { clean: true } }, W: { started: 'yes', gates: {}, check: { clean: true } } } };
/** A forger's script: it records what it receives (and answers on a port), and posts FORGED to `target` after each of `delays` ms. */
const forger = (name, target, delays = [0]) => `window.FORGER = ${JSON.stringify(name)}; window.got = [];
addEventListener('message', (e) => { got.push({ data: typeof e.data === 'string' ? e.data : Object.keys(e.data || {}).join(','), ports: e.ports.length }); if (e.ports[0]) e.ports[0].onmessage = (m) => got.push({ onPort: Object.keys(m.data || {}).join(',') }); });
for (const d of ${JSON.stringify(delays)}) setTimeout(() => ${target}.postMessage(${JSON.stringify(FORGED)}, '*'), d);`;
const SILENT = `window.FORGER = 'silent widget'; window.got = []; addEventListener('message', (e) => got.push({ data: typeof e.data === 'string' ? e.data : Object.keys(e.data || {}).join(','), ports: e.ports.length }));`;
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

/** The host page with Q7's helpers: `sibling()` adds a frame of the host page that forges; `states(url)` reads frame.contentWindow[0] in each state. */
function host(F, auto = null) {
    return hostPage(F.cHash).replace('</script></body></html>', `
window.sibling = () => { const i = document.createElement('iframe'); i.srcdoc = ${JSON.stringify(page(`<script>${forger('sibling of the host page', 'parent', [0, 40, 80])}<\/script>`)).replaceAll('</', '<\\/')}; document.body.append(i); };
window.states = async (url) => {
  const S = {};
  const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-forms');
  const rd = () => { const r = {}; try { const x = f.contentWindow[0]; r.index = x === undefined ? 'undefined' : 'a window'; } catch (e) { r.index = 'throws ' + e.name; } try { const x = f.contentWindow.frames[0]; r.frames0 = x === undefined ? 'undefined' : 'a window'; } catch (e) { r.frames0 = 'throws ' + e.name; } return r; };
  const loaded = () => new Promise((r) => { f.addEventListener('load', r, { once: true }); setTimeout(r, 3000); });
  S.beforeInsertion = rd();
  const el = document.createElement('div'); const root = el.attachShadow({ mode: 'closed' }); root.append(f); document.body.append(el);
  S.insertedNoSrc = rd();
  let p = loaded(); f.src = url; S.srcSetBeforeLoad = rd(); await p; S.atLoad = rd();
  await new Promise((r) => setTimeout(r, 400)); S.afterStartUp = rd();
  p = loaded(); f.src = '/noframes.html'; await p; S.navigatedToNoFrames = rd();
  p = loaded(); f.src = 'about:blank'; await p; S.aboutBlank = rd();
  el.remove(); S.removed = rd();
  return S;
};
${auto ? `window.result = null;
window.start(${JSON.stringify(auto.url)}, ${JSON.stringify({ keep: true, timeout: 6000, first: true, ...auto.opts })}).then((r) => { window.result = r; });
window.report = () => { const r = window.result || window.last; return { loads: r.loads, decision: r.decision, firstMessages: r.firstMessages, portTo: r.portTo, acks: r.acks, end: r.end || 'not ended', ownLength: window.length }; };
addEventListener('message', (e) => { if (e.data === 'report?') e.source.postMessage({ report: window.report() }, '*'); });` : ''}
</script></body></html>`);
}

// E for Q5's rerun: what a framer puts in F's frame. Its frames[0] speaks first as C would, and hands A what it receives.
const EVIL_FIRST = page(`<iframe srcdoc="${`<script>
addEventListener('message', (e) => {
  if (e.data !== 'ws-port' || !e.ports[0]) return;
  const port = e.ports[0];
  top.postMessage({ evil: 'got the port' }, '*');
  port.onmessage = (m) => { top.postMessage({ evil: 'content', data: m.data }, '*'); if (m.data && m.data.cmd === 'content') port.postMessage({ ack: 'content' }); };
});
parent.parent.postMessage(${JSON.stringify(FORGED)}, '*');
<\/script>`.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`);

// F framed by another site: what arrives at that site's page
const OTHER = (fUrl) => page(`<script>
window.got = [];
const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-forms'); f.src = ${JSON.stringify(fUrl)};
addEventListener('message', (e) => { let fromC; try { fromC = e.source === f.contentWindow[0]; } catch (x) { fromC = 'throws ' + x.name; } got.push({ fromC, ports: e.ports.length, json: JSON.stringify(e.data) }); });
document.body.append(f);
<\/script>`);

const slim = (r) => ({ end: r.end, decision: r.decision, portTo: r.portTo, hello: r.hello, loads: r.loads, indexBeforeInsertion: r.indexBeforeInsertion, indexAtInsertion: r.indexAtInsertion, firstMessages: r.firstMessages, acks: r.acks && r.acks.map((a) => ({ ...a, C: undefined, W: undefined, phases: undefined })), timeline: r.timeline });

async function forgers(pg) {
    const out = [];
    for (const fr of pg.frames()) {
        const x = await fr.evaluate(() => (window.FORGER ? { name: window.FORGER, got: window.got } : null)).catch(() => null);
        if (x) out.push(x);
    }
    return out;
}

async function runEngine(name, starts, raceStarts) {
    const srv = await startServer();
    const L = srv.local;
    const F = servedFile({ c: { first: true } });
    const HELLO = servedFile();
    const OWN = servedFile({ c: { first: true }, fScripts: [forger('F itself', 'parent')] });
    const SECOND = servedFile({ c: { first: true }, extraFrames: [{ scripts: [forger('second frame of F (index 1)', 'parent.parent')] }] });
    const RELOAD = servedFile({ c: { first: true, reloadAfterPost: true } });
    const REPLACE = servedFile({ c: { first: true }, fScripts: ["setTimeout(() => { const c = document.querySelector('iframe'); const n = c.cloneNode(true); c.replaceWith(n); }, 600);"] });
    const r = (p, body, headers = HTML) => srv.route(p, { headers, body });
    r('/host7.html', host(F));
    r('/F.html', F.html); r('/Fhello.html', HELLO.html); r('/F-own.html', OWN.html); r('/F-second.html', SECOND.html); r('/F-reload.html', RELOAD.html); r('/F-replace.html', REPLACE.html);
    r('/noframes.html', page('<p>no frames</p>'));
    r('/spa-speaks.html', page('<div id="root">the app shell</div><iframe src="/widget-speaks.html"></iframe>'));
    r('/widget-speaks.html', page(`<script>${forger('SPA widget that speaks', 'parent.parent')}</script>`));
    r('/spa-silent.html', page('<div id="root">the app shell</div><iframe src="/widget-silent.html"></iframe>'));
    r('/widget-silent.html', page(`<script>${SILENT}</script>`));
    r('/host7-auto.html', host(F, { url: '/F.html', opts: {} }));
    r('/host7-q5.html', host(F, { url: '/F.html', opts: {} }));
    r('/host7-q5-light.html', host(F, { url: '/F.html', opts: { light: true } }));
    r('/evil.html', EVIL_FIRST);
    r('/attack.html', ATTACK);
    r('/framer.html', page(`<script>
const f = document.createElement('iframe'); f.src = new URLSearchParams(location.search).get('host'); document.body.append(f);
let n = 0; const t = setInterval(() => { try { f.contentWindow.postMessage(${JSON.stringify(FORGED)}, '*'); n++; } catch (e) {} if (n > 200) clearInterval(t); }, 5);
<\/script>`));
    r('/other.html', OTHER(`${L}/F.html`));

    const browser = await ENGINES[name].launch();
    emitRun('q7', name, browser);
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    const fresh = async () => { await pg.goto(`${L}/host7.html`); };
    const start = (u, o = {}) => pg.evaluate(([x, y]) => window.start(x, { first: true, keep: true, timeout: 4000, ...y }), [u, o]);

    // the positive control, and the states of frame.contentWindow[0]
    await fresh();
    emit('q7.case', { engine: name, case: 'correct file (positive control)', seen: slim(await start('/F.html')) });
    await fresh();
    emit('q7.states', { engine: name, states: await pg.evaluate(() => window.states('/F.html')) });

    // the forgeries
    // the sibling is added right after the element, while the host page's listener is in place; it forges at 0, 40 and 80 ms
    await fresh();
    const sib = await pg.evaluate(() => { const p = window.start('/F.html', { first: true, keep: true, timeout: 4000 }); window.sibling(); return p; });
    emit('q7.case', { engine: name, case: '(a) another frame of the host page forges (at 0, 40 and 80 ms after its load)', seen: slim(sib), forgers: await forgers(pg) });
    for (const [label, u] of [['(b) SPA fallback whose widget frame speaks', '/spa-speaks.html'], ['(b) SPA fallback whose widget frame is silent', '/spa-silent.html'], ['(c) F itself forges (a file with a script of its own)', '/F-own.html'], ['(e) a second frame inside F (index 1) forges', '/F-second.html']]) {
        await fresh();
        emit('q7.case', { engine: name, case: label, seen: slim(await start(u)), forgers: await forgers(pg) });
    }
    for (const [label, u, delay] of [['(f) C posts, then reloads itself', '/F-reload.html', 400], ['(f) C posts, then F replaces C\'s frame (at 600 ms)', '/F-replace.html', 1200]]) {
        for (const postTo of ['source', 'index']) {
            await fresh();
            emit('q7.case', { engine: name, case: `${label}; the host answers after ${delay} ms to ${postTo === 'index' ? 'frame.contentWindow[0]' : 'event.source'}`, seen: slim(await start(u, { answerDelay: delay, postTo, timeout: 4000 })) });
        }
    }
    {
        const p2 = await ctx.newPage();
        await p2.goto(`${srv.ip}/framer.html?host=${encodeURIComponent(`${L}/host7-auto.html`)}`);
        await sleep(2500);
        const h = p2.frames().find((f) => f.url().includes('/host7-auto'));
        emit('q7.case', { engine: name, case: '(d) a page that frames the host page forges (every 5 ms)', seen: h ? await h.evaluate(() => window.report()).catch((e) => String(e).slice(0, 100)) : 'no H' });
        await p2.close();
    }

    // F framed by another site: what C's message carries there
    {
        const p2 = await ctx.newPage();
        await p2.goto(`${srv.ip}/other.html`);
        await sleep(1500);
        emit('q7.other', { engine: name, got: await p2.evaluate(() => window.got) });
        await p2.close();
    }

    // Q5's two cases in this order
    for (const [shape, hostPath] of [['closed shadow root', '/host7-q5.html'], ['light DOM (positive control)', '/host7-q5-light.html']]) {
        const p2 = await ctx.newPage();
        await p2.goto(`${srv.ip}/attack.html?when=early&host=${encodeURIComponent(L + hostPath)}`);
        await sleep(4500);
        await p2.evaluate(() => window.ask()).catch(() => {});
        await sleep(300);
        const a = await p2.evaluate(() => ({ navigated: window.navigated, log: window.log })).catch((e) => ({ error: String(e).slice(0, 100) }));
        const h = p2.frames().find((f) => f.url().includes('/host7-q5'));
        emit('q7.q5', { engine: name, shape, attacker: a, host: h ? await h.evaluate(() => window.report()).catch((e) => String(e).slice(0, 100)) : 'no H' });
        await p2.close();
    }

    // the race: the listener exists before insertion, so a message before F's load is not missed; also with a busy host page
    for (const busy of [0, 200]) {
        await fresh();
        const rs = [];
        for (let k = 0; k < raceStarts; k++) rs.push(await pg.evaluate((b) => window.start('/F.html', { first: true, busy: b, timeout: 4000 }), busy));
        const ends = {};
        for (const x of rs) ends[x.end] = (ends[x.end] || 0) + 1;
        const before = rs.filter((x) => x.timeline.verdict != null && x.loads[0] && x.timeline.verdict < x.loads[0].t).length;
        emit('q7.race', { engine: name, busy, starts: rs.length, ends, verdictBeforeLoad: before, accepted: rs.filter((x) => x.decision === 'send').length, refusedBy: rs.filter((x) => x.decision && x.decision.refused).map((x) => x.decision.refused.join('+')), indexTrue: rs.filter((x) => x.firstMessages.some((m) => m.accepted)).length, insertToVerdict: rs.length ? { median: median(rs.map((x) => x.timeline.verdict ?? NaN).filter(Number.isFinite)), range: range(rs.map((x) => Math.round(x.timeline.verdict ?? 0))) } : null });
    }

    // the cost against Q1's order, alternating, one fresh element per start
    await fresh();
    const V = { "Q1's order (the host page posts the hello at F's load)": ['/Fhello.html', { expectHash: HELLO.cHash }], 'the view speaks first': ['/F.html', { first: true }] };
    const rows = Object.fromEntries(Object.keys(V).map((k) => [k, []]));
    const loads = [];
    for (const [u, o] of Object.values(V)) await pg.evaluate(([x, y]) => window.start(x, y), [u, o]);
    for (let k = 0; k < starts; k++) {
        const order = Object.keys(V);
        for (const v of k % 2 ? order.reverse() : order) {
            loads.push(load1());
            const [u, o] = V[v];
            rows[v].push(await pg.evaluate(([x, y]) => window.start(x, y), [u, o]));
            await sleep(100);
        }
    }
    for (const [v, rs] of Object.entries(rows)) {
        const ok = rs.filter((x) => x.end === 'content acknowledged');
        const col = (f) => { const xs = ok.map(f).filter((x) => typeof x === 'number'); return xs.length ? { median: +median(xs).toFixed(1), range: range(xs.map((x) => Math.round(x))) } : null; };
        emit('q7.cost', { engine: name, variant: v, runs: rs.length, acknowledged: ok.length, insertToLoad: col((x) => x.loads[0]?.t), insertToVerdict: col((x) => x.timeline.verdict), insertToContentAck: col((x) => x.timeline.content), load1: range(loads) });
    }
    await browser.close();
}

const args = process.argv.slice(2);
const starts = Number(args.find((a) => /^\d+$/.test(a)) ?? 24);
const raceStarts = Number(process.env.Q7_RACE_STARTS ?? 50);
for (const name of args.filter((a) => a in ENGINES)) {
    try { await runEngine(name, starts, raceStarts); } catch (e) { emit('q7.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
