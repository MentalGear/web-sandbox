// Q1b. Can the view compute a digest of its own bootstrap (crypto.subtle) when the host page's URL is not potentially
// trustworthy? The design file as fixture.mjs builds it, framed by a host page at http://app.insecure.test (reached
// through the recording server's proxy, as research 27 Q4 did) and, as the control, at http://localhost. C reports
// isSecureContext and whether crypto.subtle exists, and the start-up order runs as in Q1 (C hashes its own text).
//
//   bun docs/research/31_served_startup/q1-insecure.mjs <engine>
import { ENGINES, emit, emitRun } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';
import { hostPage, servedFile } from './fixture.mjs';

async function runEngine(name) {
    const srv = await startServer();
    const F = servedFile();
    srv.route('/F.html', { headers: HTML, body: F.html });
    srv.route('/host.html', { headers: HTML, body: hostPage(F.cHash) });
    const browser = await ENGINES[name].launch({ proxy: { server: srv.ip, bypass: '<-loopback>' } });
    emitRun('q1b', name, browser);
    for (const origin of [`http://app.insecure.test:${srv.port}`, srv.local]) {
        const page = await (await browser.newContext()).newPage();
        const errors = [];
        page.on('console', (m) => { if (m.type() === 'error' && !/violates|Refused|blocked/i.test(m.text())) errors.push(m.text().slice(0, 160)); });
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
        await page.goto(`${origin}/host.html`);
        const r = await page.evaluate(() => window.start('/F.html', { keep: true, timeout: 4000 }));
        const c = page.frames().find((f) => f.url() === 'about:srcdoc');
        const inC = c ? await c.evaluate(() => ({ secure: self.isSecureContext, subtle: typeof (self.crypto && self.crypto.subtle), origin: String(self.origin) })).catch((e) => String(e).slice(0, 100)) : 'no C';
        const host = await page.evaluate(() => ({ secure: self.isSecureContext, subtle: typeof crypto.subtle }));
        emit('q1b', { engine: name, host: origin.includes('insecure') ? 'http://app.insecure.test' : 'http://localhost', hostPage: host, inC, end: r.end, decision: r.decision, errors: errors.slice(0, 4) });
        await page.context().close();
    }
    await browser.close();
}

for (const name of process.argv.slice(2).filter((a) => a in ENGINES)) {
    try { await runEngine(name); } catch (e) { emit('q1b.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
