// Q5. A page that frames the host page: can it reach the frame of F (inside the element's closed shadow root) through
// window.frames, and navigate it, before or after F's first load? What does the host page see? The same for today's view
// shape (the wrapper as a srcdoc frame), for comparison.
//
//   bun docs/research/31_served_startup/q5-framed-host.mjs <engine>
//
// H (http://localhost:P/host5.html) starts one element at parse time, in the start-up order of fixture.mjs, with the
// served file (src) or with the same file's text as srcdoc (today's shape). A (http://127.0.0.1:P/attack.html, another
// site) frames H and, from its own script:
//   reach: reads H.length, H.frames[0] (F's window) and F.frames[0] (C's window);
//   early: polls every millisecond and, as soon as H.frames[0] exists, navigates it to E, a page of A's whose frames[0]
//          answers the hello as C would (the right hash, clean verdicts: both are constants anyone can read from the
//          file) and hands whatever content arrives to A;
//   late:  waits until H's start-up is over (2 s), then navigates F to E (and, in a third variant, C itself).
// H records every load event of its frame, where its hello went, the verdict and what it sent. Negative control: H sent
// with frame-ancestors 'self' (A cannot frame it). Positive control: the same frame outside the shadow root.
import { ENGINES, emit, emitRun, sleep } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';
import { hostPage, servedFile } from './fixture.mjs';

function hostWithStart(F, shape, light = false) {
    const page = hostPage(F.cHash);
    const opts = shape === 'srcdoc' ? `{ keep: true, light: ${light}, timeout: 6000, srcdoc: ${JSON.stringify(F.html).replaceAll('</', '<\\/')} }` : `{ keep: true, light: ${light}, timeout: 6000 }`;
    return page.replace('</script></body></html>', `
window.result = null;
window.start('/F.html', ${opts}).then((r) => { window.result = r; });
window.report = () => { const r = window.result || window.last; return { loads: r.loads, hello: r.hello, decision: r.decision, hashMatches: r.verdict ? r.verdict.hash === window.EXPECT_HASH : null, verdictFrom: r.verdict ? (r.verdict.from || 'C') : null, acks: r.acks, end: r.end || 'not ended', ownLength: window.length }; };
addEventListener('message', (e) => { if (e.data === 'report?') e.source.postMessage({ report: window.report() }, '*'); });
</script></body></html>`);
}

// E: what A puts in F's frame. Its frames[0] answers the hello as C would, and gives A what it receives.
const evil = (hash) => `<!doctype html><html><head><meta charset="utf-8"></head><body><iframe srcdoc="${`<script>
addEventListener('message', (e) => {
  if (e.data !== 'ws-hello' || !e.ports[0]) return;
  const port = e.ports[0];
  top.postMessage({ evil: 'got the hello and a port' }, '*');
  const clean = { clean: true };
  port.postMessage({ from: 'E', version: '1', hash: ${JSON.stringify(hash)}, C: { gates: {}, check: clean }, W: { started: 'yes', gates: {}, check: clean } });
  port.onmessage = (m) => { top.postMessage({ evil: 'content', data: m.data }, '*'); if (m.data && m.data.cmd === 'content') port.postMessage({ ack: 'content' }); };
});
<\/script>`.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></body></html>`;

export const ATTACK = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
const q = new URLSearchParams(location.search);
window.log = [];
const evilUrl = location.origin + '/evil.html';
const H = () => frames[0];
const reach = () => {
  const r = {};
  try { r.hostLength = H().length; } catch (e) { r.hostLength = 'throws ' + e.name; }
  try { r.fWindow = H().frames[0] ? 'reached' : 'undefined'; } catch (e) { r.fWindow = 'throws ' + e.name; }
  try { r.fLength = H().frames[0].length; } catch (e) { r.fLength = 'throws ' + e.name; }
  try { r.cWindow = H().frames[0].frames[0] ? 'reached' : 'undefined'; } catch (e) { r.cWindow = 'throws ' + e.name; }
  return r;
};
addEventListener('message', (e) => { if (e.data && (e.data.evil || e.data.report)) log.push(e.data); });
const f = document.createElement('iframe');
f.style.cssText = 'width:600px;height:400px';
f.src = q.get('host');
document.body.append(f);
window.navigated = null;
const go = (target) => { try { target.location = evilUrl; return 'navigated'; } catch (e) { return 'throws ' + e.name + ': ' + String(e.message).slice(0, 80); } };
if (q.get('when') === 'early') {
  const t0 = performance.now();
  const poll = setInterval(() => {
    let F; try { F = H() && H().frames[0]; } catch (e) { F = null; }
    if (F) { clearInterval(poll); window.navigated = { at: Math.round(performance.now() - t0), reachAtNavigation: reach(), result: go(F) }; }
    if (performance.now() - t0 > 4000) { clearInterval(poll); window.navigated = { result: 'never reached F', reach: reach() }; }
  }, 1);
} else if (q.get('when') === 'late' || q.get('when') === 'late-c') {
  setTimeout(() => { const r = reach(); let t; try { t = q.get('when') === 'late-c' ? H().frames[0].frames[0] : H().frames[0]; } catch (e) { t = null; } window.navigated = { reachAtNavigation: r, result: t ? go(t) : 'no target' }; }, 2000);
} else setTimeout(() => { window.navigated = { reach: reach(), result: 'not navigated (reach only)' }; }, 2000);
window.ask = () => H().postMessage('report?', '*');
</script></body></html>`;

async function runEngine(name) {
    const srv = await startServer();
    const F = servedFile();
    srv.route('/F.html', { headers: HTML, body: F.html });
    srv.route('/host5.html', { headers: HTML, body: hostWithStart(F, 'src') });
    srv.route('/host5-srcdoc.html', { headers: HTML, body: hostWithStart(F, 'srcdoc') });
    srv.route('/host5-light.html', { headers: HTML, body: hostWithStart(F, 'src', true) });
    srv.route('/host5-srcdoc-light.html', { headers: HTML, body: hostWithStart(F, 'srcdoc', true) });
    srv.route('/host5-fa.html', { headers: { ...HTML, 'content-security-policy': "frame-ancestors 'self'" }, body: hostWithStart(F, 'src') });
    srv.route('/evil.html', { headers: HTML, body: evil(F.cHash) });
    srv.route('/attack.html', { headers: HTML, body: ATTACK });
    const browser = await ENGINES[name].launch();
    emitRun('q5', name, browser);
    const ctx = await browser.newContext();
    for (const [shape, hostPath] of [['served file (src)', '/host5.html'], ["today's shape (srcdoc)", '/host5-srcdoc.html'], ["served file, H sends frame-ancestors 'self' (negative control)", '/host5-fa.html'], ['served file, frame in the light DOM (positive control)', '/host5-light.html'], ["today's shape, frame in the light DOM (positive control)", '/host5-srcdoc-light.html']]) {
        for (const when of ['reach', 'early', 'late', 'late-c']) {
            if (hostPath === '/host5-fa.html' && when !== 'reach' && when !== 'early') continue;
            const page = await ctx.newPage();
            srv.reset();
            await page.goto(`${srv.ip}/attack.html?when=${when}&host=${encodeURIComponent(srv.local + hostPath)}`);
            await sleep(when === 'early' ? 4500 : 4000);
            await page.evaluate(() => window.ask()).catch(() => {});
            await sleep(300);
            const a = await page.evaluate(() => ({ navigated: window.navigated, log: window.log })).catch((e) => ({ error: String(e).slice(0, 100) }));
            // H as seen from inside (Playwright reads H's frame directly): its own record
            const h = page.frames().find((f) => f.url().includes('/host5'));
            const hView = h ? await h.evaluate(() => window.report()).catch((e) => 'evaluate failed: ' + String(e).slice(0, 80)) : 'no H frame';
            const evilFrames = page.frames().filter((f) => f.url().includes('/evil.html')).length;
            emit('q5', { engine: name, shape, when, attacker: a, host: hView, framesAtEvil: evilFrames, fRequests: srv.requests.filter((r) => r.path === '/F.html').length });
            await page.close();
        }
    }
    await browser.close();
}

// run only as a script: Q7 imports ATTACK
if (import.meta.main) {
    for (const name of process.argv.slice(2).filter((a) => a in ENGINES)) {
        try { await runEngine(name); } catch (e) { emit('q5.error', { engine: name, error: String(e).slice(0, 400) }); }
    }
    process.exit(0);
}
