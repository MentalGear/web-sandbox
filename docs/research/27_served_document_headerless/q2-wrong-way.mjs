// Q2. The static file opened the wrong way, with no `sandbox` response header to protect it. Can the file protect itself
// by construction, with a first statement that reads its own origin and does nothing unless it is opaque?
//
//   bun docs/research/27_served_document_headerless/q2-wrong-way.mjs [chromium|firefox|webkit]
//
// /guarded.html is sent with Content-Type only. Its <head> starts with a <meta> policy that admits one script by hash,
// the guard, which records what it can see (origin, top, ancestorOrigins, frameElement, referrer, the URL, storage) and
// its verdict into window.G, and does nothing else: no message is posted, no listener added (an inert document).
// Playwright reads window.G from the frame from outside. Embedders:
//   L  = http://localhost:P      the file's own origin (the legitimate host page)
//   L2 = http://localhost:P2     same site, another origin (a second server)
//   I  = http://127.0.0.1:P      another site
// In each case where the embedder is not the file's own origin, the embedder then tries what a hostile page would:
// read the document, the location, the guard's globals, the frame count, the name, contentDocument, and post a message.
import { ENGINES, emit, emitRun, engineArgs, sha, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';

const GUARD = `window.G = (() => {
  const t = (f) => { try { return f(); } catch (e) { return 'throws ' + e.name; } };
  const g = { origin: String(self.origin), opaque: self.origin === 'null', top: window.top === window,
    ancestorOrigins: location.ancestorOrigins ? [...location.ancestorOrigins] : 'unsupported',
    frameElement: t(() => window.frameElement === null ? 'null' : 'element'), opener: t(() => window.opener ? 'present' : 'none'),
    referrer: document.referrer, href: location.href, storage: t(() => (localStorage.length, 'readable')), cookie: t(() => typeof document.cookie) };
  g.verdict = g.opaque ? 'run' : 'inert';
  return g;
})();`;
const GUARDED = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${sha(GUARD)}; base-uri 'none'"><meta charset="utf-8"><script>${GUARD}</script></head><body></body></html>`;

// What a hostile embedder tries against the document it embedded (w: its WindowProxy, el: the iframe or null).
const HOSTILE = `window.tryAll = (w, el) => {
  const t = (f) => { try { const v = f(); return v === undefined ? 'undefined' : JSON.stringify(v).slice(0, 80); } catch (e) { return 'throws ' + e.name; } };
  return { document: t(() => w.document.title), locationRead: t(() => w.location.href), guardGlobal: t(() => w.G), length: t(() => w.length),
    name: t(() => w.name), contentDocument: t(() => el ? (el.contentDocument === null ? null : 'a document') : 'n/a'),
    postMessage: t(() => { w.postMessage('hello', '*'); return 'sent (no listener)'; }) };
};`;

async function runEngine(name) {
    const srv = await startServer();
    const srv2 = await startServer();
    const L = srv.local, I = srv.ip, L2 = srv2.local;
    const target = `${L}/guarded.html`;
    for (const s of [srv, srv2]) {
        s.route('/guarded.html', { headers: HTML, body: GUARDED });
        s.route('/embed', (req, url) => {
            const attrs = url.searchParams.get('attrs') || '';
            return { headers: HTML, body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${HOSTILE}</script><iframe ${attrs} src="${target}"></iframe></body></html>` };
        });
        s.route('/opener', { headers: HTML, body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${HOSTILE}</script></body></html>` });
        s.route('/sbopener', { headers: HTML, body: `<!doctype html><html><head><meta charset="utf-8"></head><body><iframe sandbox="allow-scripts allow-popups" srcdoc="<script>${HOSTILE.replaceAll('"', '&quot;')}</script>"></iframe></body></html>` });
    }

    const browser = await ENGINES[name].launch();
    emitRun('q2', name, browser);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const guardIn = async (p) => {
        const f = p.frames().find((fr) => fr.url().includes('/guarded.html'));
        return f ? f.evaluate(() => window.G).catch((e) => `evaluate failed: ${String(e).slice(0, 120)}`) : 'no frame with the file';
    };

    // top-level navigation
    await page.goto(target);
    emit('q2', { engine: name, case: 'top-level navigation', guard: await page.evaluate(() => window.G) });

    // framed
    const framed = [
        ['framed by its own origin, sandbox="allow-scripts" (the legitimate case)', L, 'sandbox="allow-scripts"'],
        ['framed by its own origin, sandbox="allow-scripts", referrerpolicy="no-referrer"', L, 'sandbox="allow-scripts" referrerpolicy="no-referrer"'],
        ['framed by its own origin, no sandbox attribute', L, ''],
        ['framed by its own origin, sandbox="allow-scripts allow-same-origin"', L, 'sandbox="allow-scripts allow-same-origin"'],
        ['framed same-site cross-origin (another port), no sandbox attribute', L2, ''],
        ['framed cross-site, no sandbox attribute', I, ''],
        ['framed cross-site, sandbox="allow-scripts allow-same-origin"', I, 'sandbox="allow-scripts allow-same-origin"'],
        ['framed cross-site, sandbox="allow-scripts"', I, 'sandbox="allow-scripts"'],
        ['framed cross-site, sandbox="allow-scripts", referrerpolicy="no-referrer"', I, 'sandbox="allow-scripts" referrerpolicy="no-referrer"'],
    ];
    for (const [label, origin, attrs] of framed) {
        await page.goto(`${origin}/embed?attrs=${encodeURIComponent(attrs)}`);
        await sleep(700);
        const guard = await guardIn(page);
        const hostile = origin === L ? 'n/a (own origin)' : await page.evaluate(() => window.tryAll(frames[0], document.querySelector('iframe')));
        emit('q2', { engine: name, case: label, embedder: origin === L ? 'L' : origin === L2 ? 'L2' : 'I', guard, hostile });
    }

    // a popup opened by a cross-site page, and by a cross-site page's sandboxed frame (the popup inherits the sandbox)
    await page.goto(`${I}/opener`);
    const [pop] = await Promise.all([ctx.waitForEvent('page'), page.evaluate((u) => { window.w = window.open(u); }, target)]);
    await pop.waitForLoadState();
    await sleep(500);
    emit('q2', { engine: name, case: 'popup opened by a cross-site page (window.open)', guard: await pop.evaluate(() => window.G), hostile: await page.evaluate(() => window.tryAll(window.w, null)) });
    await pop.close();
    await page.goto(`${I}/sbopener`);
    await sleep(300);
    const sb = page.frames().find((f) => f !== page.mainFrame());
    const [pop2] = await Promise.all([ctx.waitForEvent('page'), sb.evaluate((u) => { window.w = window.open(u); }, target)]);
    await pop2.waitForLoadState();
    await sleep(500);
    emit('q2', { engine: name, case: 'popup opened by a cross-site page\'s frame sandbox="allow-scripts allow-popups"', guard: await pop2.evaluate(() => window.G), hostile: await sb.evaluate(() => window.tryAll(window.w, null)) });
    await pop2.close();

    await browser.close();
    await srv.close();
    await srv2.close();
}

for (const name of engineArgs()) {
    try { await runEngine(name); } catch (e) { emit('q2.error', { engine: name, error: String(e).slice(0, 400) }); }
}
