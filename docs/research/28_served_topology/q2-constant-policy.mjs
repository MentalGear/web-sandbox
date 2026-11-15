// Q2. A constant policy: can the served file's <meta> be one static text with no 'unsafe-inline' (F's script and C's
// srcdoc script admitted by hash, the worker under worker-src blob:, the library's one inline style by hash, every
// other source 'none' or blob:), with F opaque and not? And does an external script admitted by 'self', by the file's
// host, or by a hash with `integrity`, run when F's origin is opaque?
//
//   bun docs/research/28_served_topology/q2-constant-policy.mjs <engine>
//
// Part A, the constant policy: F (sent with Content-Type only) creates C, a srcdoc child with sandbox="allow-scripts",
// whose document is constant: its bootstrap (admitted by hash) and a second inline script that is not (a positive
// control: it must be refused). C's bootstrap tries each action its view needs, and some it must not get: the still
// stylesheet as a <style> element added by script (its hash is in the policy) and another <style> (not), a style
// attribute's declaration and a constructed stylesheet through the CSSOM, a blob: stylesheet <link>, a blob: and a data:
// image, `eval`, an inline handler, a blob: worker that tries `eval`. Variant `narrowed`: C's srcdoc also carries a <meta>
// of its own, `img-src 'none'` (does a per-build narrowing inside C intersect with F's constant policy?). Each with F framed
// sandboxed (opaque origin) and opened top-level (the file's own origin).
//
// Part B, external scripts: a page whose only script is <script src="/ext.js">, under four policies, framed sandboxed
// (opaque) and opened top-level.
//
// F's <head> starts with <base href="about:blank">, before the policy: C reports its URL and base URL (today's environment
// check expects about:srcdoc and about:blank in the view).
import { ENGINES, emit, emitRun, esc, sha, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';

const STILL = '#still { color: rgb(7, 8, 9) }';
const OTHER = '#other { color: rgb(1, 1, 1) }';
const WORKER = `self.onmessage = () => { let e; try { e = String((0, eval)('6*7')); } catch (x) { e = x.name; } postMessage({ origin: String(self.origin), eval: e }); };`;
const C_SCRIPT = `(() => {
  const R = window.RC = { ran: true, origin: String(self.origin), url: location.href, baseURI: document.baseURI, viol: [] };
  document.addEventListener('securitypolicyviolation', (e) => R.viol.push((e.effectiveDirective || e.violatedDirective) + ' ' + String(e.blockedURI).slice(0, 20)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const color = async (el) => { for (let i = 0; i < 150 && getComputedStyle(document.documentElement).color === ''; i++) await wait(20); const c = getComputedStyle(el).color; return c === '' ? 'unmeasured' : c; };
  const el = (id) => { const d = document.createElement('p'); d.id = id; d.textContent = id; document.body.append(d); return d; };
  (async () => {
    try { R.eval = String((0, eval)('6*7')); } catch (x) { R.eval = 'refused ' + x.name; }
    const h = el('handler'); h.setAttribute('onclick', 'window.handlerRan = true'); h.click(); R.inlineHandler = window.handlerRan ? 'ran' : 'refused';
    R.otherInlineScript = window.otherRan ? 'ran' : 'refused';
    const s1 = document.createElement('style'); s1.textContent = ${JSON.stringify(STILL)}; document.head.append(s1);
    const s2 = document.createElement('style'); s2.textContent = ${JSON.stringify(OTHER)}; document.head.append(s2);
    const still = el('still'), other = el('other'), decl = el('decl'), sheet = el('sheet'), linked = el('linked');
    decl.style.cssText = 'color: rgb(2, 3, 4)';
    try { const cs = new CSSStyleSheet(); cs.replaceSync('#sheet { color: rgb(3, 4, 5) }'); document.adoptedStyleSheets = [cs]; } catch (x) { R.constructed = x.name; }
    const css = URL.createObjectURL(new Blob(['#linked { color: rgb(5, 6, 7) }'], { type: 'text/css' }));
    await new Promise((res) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = css; l.onload = res; l.onerror = res; document.head.append(l); setTimeout(res, 2000); });
    R.stillStyleByHash = (await color(still)) === 'rgb(7, 8, 9)' ? 'applied' : 'refused';
    R.otherStyle = (await color(other)) === 'rgb(1, 1, 1)' ? 'applied' : 'refused';
    R.cssomDeclaration = (await color(decl)) === 'rgb(2, 3, 4)' ? 'applied' : 'refused';
    R.constructedSheet = (await color(sheet)) === 'rgb(3, 4, 5)' ? 'applied' : 'refused';
    R.blobStylesheet = (await color(linked)) === 'rgb(5, 6, 7)' ? 'applied' : 'refused';
    const img = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('refused'); i.src = src; setTimeout(() => res('no answer'), 2000); });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    R.blobImage = await img(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })));
    R.dataImage = await img('data:image/svg+xml,' + encodeURIComponent(svg));
    R.worker = await new Promise((res) => {
      try {
        const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: 'text/javascript' })));
        w.onmessage = (m) => res(m.data); w.onerror = () => res('error event (not started)'); w.postMessage(1);
        setTimeout(() => res('no answer'), 3000);
      } catch (x) { res('throws ' + x.name); }
    });
    await wait(200);
    R.done = true;
  })();
})();`;
const OTHER_SCRIPT = 'window.otherRan = true;';
const childHtml = (narrow) => `<!doctype html><html><head>${narrow ? `<meta http-equiv="Content-Security-Policy" content="${esc(narrow)}">` : ''}<meta charset="utf-8"></head><body><script>${C_SCRIPT}</script><script>${OTHER_SCRIPT}</script></body></html>`;
const fScript = (child) => `(() => { window.RF = { ran: true, origin: String(self.origin) }; const c = document.createElement('iframe'); c.setAttribute('sandbox', 'allow-scripts'); c.srcdoc = ${JSON.stringify(child).replaceAll('</', '<\\/')}; document.body.append(c); })();`;

/** The constant policy: no 'unsafe-inline'; every source a hash, blob: or 'none'. */
export function constantPolicy(fHash) {
    return `default-src 'none'; script-src ${fHash} ${sha(C_SCRIPT)}; script-src-attr 'none'; style-src ${sha(STILL)} blob:; img-src blob:; font-src blob:; media-src blob:; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'`;
}
function servedFile(narrow) {
    const script = fScript(childHtml(narrow));
    const policy = constantPolicy(sha(script));
    // the <base> precedes the policy, so base-uri 'none' does not refuse it and C (a srcdoc) inherits about:blank as its base,
    // as today's view inherits the wrapper's (the environment check's `base` row)
    return { policy, html: `<!doctype html><html><head><base href="about:blank"><meta http-equiv="Content-Security-Policy" content="${esc(policy)}"><meta charset="utf-8"></head><body><script>${script}</script></body></html>` };
}

const EXT = 'window.ext = "ran";';
const extPage = (policy, tag) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${esc(policy)}"><meta charset="utf-8"></head><body>${tag}</body></html>`;

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local;
    const plain = servedFile('');
    const narrowed = servedFile("img-src 'none'");
    srv.route('/F.html', { headers: HTML, body: plain.html });
    srv.route('/F-narrowed.html', { headers: HTML, body: narrowed.html });
    srv.route('/ext.js', { headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body: EXT });
    const integrity = sha(EXT).slice(1, -1);
    const EXTS = {
        "script-src 'self'": extPage("default-src 'none'; script-src 'self'", '<script src="/ext.js"></script>'),
        'script-src <the file\'s origin>': extPage(`default-src 'none'; script-src ${L}`, '<script src="/ext.js"></script>'),
        "script-src '<hash>', integrity, crossorigin (ACAO *)": extPage(`default-src 'none'; script-src ${sha(EXT)}`, `<script src="/ext.js" integrity="${integrity}" crossorigin="anonymous"></script>`),
        "script-src '<hash>', integrity, no crossorigin": extPage(`default-src 'none'; script-src ${sha(EXT)}`, `<script src="/ext.js" integrity="${integrity}"></script>`),
        "script-src '<hash>', no integrity": extPage(`default-src 'none'; script-src ${sha(EXT)}`, '<script src="/ext.js"></script>'),
    };
    let i = 0;
    for (const [k, v] of Object.entries(EXTS)) srv.route(`/ext${i++}.html`, { headers: HTML, body: v });
    srv.route('/embed', (req, url) => ({ headers: HTML, body: `<!doctype html><html><body><iframe sandbox="allow-scripts" src="${url.searchParams.get('target')}"></iframe></body></html>` }));

    const browser = await ENGINES[name].launch();
    emitRun('q2', name, browser);
    const page = await (await browser.newContext()).newPage();
    emit('q2.policy', { policy: plain.policy.replace(/'sha256-[^']+'/g, "'sha256-…'") });
    const frameOf = (path) => page.frames().find((f) => f.url().includes(path));
    const readC = async (fFrame) => {
        for (let k = 0; k < 50; k++) {
            const c = fFrame.childFrames()[0];
            const r = c ? await c.evaluate(() => window.RC).catch(() => null) : null;
            if (r && r.done) return r;
            if (k > 20 && !r) return r ?? 'C reported nothing (its bootstrap did not run)';
            await sleep(200);
        }
        return 'timeout';
    };
    for (const [variant, path] of [['constant', '/F.html'], ['narrowed in C: img-src \'none\'', '/F-narrowed.html']]) {
        for (const opened of ['framed sandbox="allow-scripts" (opaque)', 'top-level (the file\'s own origin)']) {
            if (opened.startsWith('framed')) await page.goto(`${L}/embed?target=${encodeURIComponent(path)}`);
            else await page.goto(`${L}${path}`);
            await sleep(400);
            const f = opened.startsWith('framed') ? frameOf(path) : page.mainFrame();
            const RF = await f.evaluate(() => window.RF).catch((e) => String(e).slice(0, 80));
            emit('q2.a', { engine: name, variant, opened, F: RF, C: await readC(f) });
        }
    }
    i = 0;
    for (const k of Object.keys(EXTS)) {
        const path = `/ext${i++}.html`;
        for (const opened of ['framed sandbox="allow-scripts" (opaque)', 'top-level']) {
            if (opened.startsWith('framed')) await page.goto(`${L}/embed?target=${encodeURIComponent(path)}`);
            else await page.goto(`${L}${path}`);
            await sleep(500);
            const f = opened.startsWith('framed') ? frameOf(path) : page.mainFrame();
            emit('q2.b', { engine: name, policy: k, opened, ext: await f.evaluate(() => window.ext ?? 'did not run').catch((e) => String(e).slice(0, 80)) });
        }
    }
    await browser.close();
    await srv.close();
}

for (const name of process.argv.slice(2).filter((a) => a in ENGINES)) {
    try { await runEngine(name); } catch (e) { emit('q2.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0); // the servers' keep-alive sockets must not hold the run open after an error
