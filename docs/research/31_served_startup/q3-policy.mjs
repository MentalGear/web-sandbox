// Q3. The policy check of I18 under response headers on F. In C and in the worker, before any content, one load of each
// kind the view makes for a guest (fixture.mjs, CHECK) while listening for securitypolicyviolation; a violation whose
// originalPolicy is not the file's <meta> text, a report disposition, an event twice, or a canary that did not do what
// the <meta> alone makes it do, means another policy is in force, and the host page sends nothing.
//
//   bun docs/research/31_served_startup/q3-policy.mjs <engine>
//
// For every header: what C and the worker each saw; every report that reached the endpoint, with its time against the
// verdict and its fields; and, where the check passed, what a guest could still make the browser report under that
// header (fixture.mjs, GUEST: each action carries a marker of its own). The reports are gathered again 65 s after the
// last case, for the Reporting API's delivery delay.
import { ENGINES, emit, emitRun, sleep } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';
import { STILL, GUARD, hostPage, metaPolicy, servedFile } from './fixture.mjs';
import { sha } from '../28_served_topology/lib.mjs';

const RO = 'content-security-policy-report-only';
const CSP = 'content-security-policy';

/** The cases: [label, (reportUri, endpointUrl, meta) => headers]. */
function cases(F) {
    const own = { 'img-src': 'blob:', 'style-src': `${sha(STILL)} blob:`, 'script-src': `${sha(GUARD)} ${F.cHash}`, 'connect-src': "'none'", 'worker-src': 'blob:', 'font-src': 'blob:', 'media-src': 'blob:' };
    const list = [
        ['none (control)', () => ({})],
        ["RO default-src 'self'; report-uri", (r) => ({ [RO]: `default-src 'self'; report-uri ${r}` })],
        ["RO default-src 'self' 'report-sample' (and script-src, style-src); report-uri", (r) => ({ [RO]: `default-src 'self' 'report-sample'; script-src 'self' 'report-sample'; style-src 'self' 'report-sample'; report-uri ${r}` })],
    ];
    for (const d of Object.keys(own)) list.push([`RO ${d} 'self' only`, (r) => ({ [RO]: `${d} 'self'; report-uri ${r}` })]);
    for (const [d, v] of Object.entries(own)) list.push([`RO ${d} with the <meta>'s own sources only (${d === 'script-src' || d === 'style-src' ? "+ 'report-sample'" : 'no sample'})`, (r) => ({ [RO]: `${d} ${v}${d === 'script-src' || d === 'style-src' ? " 'report-sample'" : ''}; report-uri ${r}` })]);
    list.push(
        ["RO base-uri 'none'", (r) => ({ [RO]: `base-uri 'none'; report-uri ${r}` })],
        ["RO frame-src 'none'; object-src 'none'; form-action 'none'; manifest-src 'none' (the <meta>'s own values)", (r) => ({ [RO]: `frame-src 'none'; object-src 'none'; form-action 'none'; manifest-src 'none'; report-uri ${r}` })],
        ["RO form-action 'self'", (r) => ({ [RO]: `form-action 'self'; report-uri ${r}` })],
        ["RO require-trusted-types-for 'script'", (r) => ({ [RO]: `require-trusted-types-for 'script'; report-uri ${r}` })],
        ["RO trusted-types 'none'", (r) => ({ [RO]: `trusted-types 'none'; report-uri ${r}` })],
        ["CSP require-trusted-types-for 'script' (enforced)", (r) => ({ [CSP]: `require-trusted-types-for 'script'; report-uri ${r}` })],
        ["CSP permissive: admits everything the file does (enforced)", (r) => ({ [CSP]: `default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; base-uri *; form-action *; report-uri ${r}` })],
        ["CSP worker-src 'none' (refuses the worker)", (r) => ({ [CSP]: `worker-src 'none'; report-uri ${r}` })],
        ["CSP typical site policy with 'unsafe-inline' (enforced)", (r) => ({ [CSP]: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; report-uri ${r}` })],
        ["CSP script-src 'self' (refuses C's bootstrap)", (r) => ({ [CSP]: `script-src 'self'; report-uri ${r}` })],
        ['CSP upgrade-insecure-requests', () => ({ [CSP]: 'upgrade-insecure-requests' })],
        ["CSP frame-ancestors 'self' (admits the host page)", (r) => ({ [CSP]: `frame-ancestors 'self'; report-uri ${r}` })],
        ['CSP sandbox allow-scripts allow-forms (header sandbox)', () => ({ [CSP]: 'sandbox allow-scripts allow-forms' })],
        ["CSP the <meta>'s exact text (enforced)", (r, e, meta) => ({ [CSP]: meta })],
        ["RO the <meta>'s exact text", (r, e, meta) => ({ [RO]: meta })],
        ["CSP the <meta>'s text + report-uri (enforced)", (r, e, meta) => ({ [CSP]: `${meta}; report-uri ${r}` })],
        ["RO the <meta>'s text + report-uri", (r, e, meta) => ({ [RO]: `${meta}; report-uri ${r}` })],
        ["RO default-src 'self'; report-uri, F framed with referrerpolicy=\"no-referrer\"", (r) => ({ [RO]: `default-src 'self'; report-uri ${r}` }), { referrerpolicy: 'no-referrer' }],
        ["Reporting-Endpoints + RO default-src 'self'; report-to", (r, e) => ({ 'reporting-endpoints': `ws="${e}"`, [RO]: `default-src 'self'; report-to ws` })],
        ["Reporting-Endpoints + RO default-src 'self'; report-uri; report-to", (r, e) => ({ 'reporting-endpoints': `ws="${e}"`, [RO]: `default-src 'self'; report-uri ${r}; report-to ws` })],
        ["Reporting-Endpoints + RO img-src blob: (the <meta>'s own); report-to", (r, e) => ({ 'reporting-endpoints': `ws="${e}"`, [RO]: `img-src blob:; report-to ws` })],
        ["Reporting-Endpoints + CSP require-trusted-types-for 'script'; report-to", (r, e) => ({ 'reporting-endpoints': `ws="${e}"`, [CSP]: `require-trusted-types-for 'script'; report-to ws` })],
    );
    return list;
}

/** One report, either format (report-uri's csp-report, or the Reporting API's array), reduced to its fields. */
function slim(rep, verdictAt) {
    let body = rep.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = { text: body.slice(0, 200) }; } }
    // report-uri: { "csp-report": {…} }; the Reporting API: an array of { type, url, body } (Chromium, Firefox), or one such object (WebKit)
    const api = (x) => ({ api: 'report-to', type: x.type, url: x.url, ...x.body });
    const items = Array.isArray(body) ? body.map(api) : body && body.type && body.body ? [api(body)] : [{ api: 'report-uri', ...((body && body['csp-report']) || body || {}) }];
    return items.map((b) => {
        const g = (...ks) => { for (const k of ks) if (b[k] != null) return String(b[k]); return undefined; };
        const text = JSON.stringify(b);
        return {
            dt: verdictAt ? rep.at - verdictAt : null, api: b.api,
            dir: g('effective-directive', 'effectiveDirective', 'violated-directive'), disp: g('disposition'),
            doc: g('document-uri', 'documentURL')?.slice(0, 60), blocked: g('blocked-uri', 'blockedURL')?.slice(0, 70),
            sample: g('script-sample', 'sample')?.slice(0, 60), source: g('source-file', 'sourceFile')?.slice(0, 60),
            referrer: g('referrer')?.slice(0, 60), guestMarker: text.includes('GUEST-SECRET'),
        };
    });
}

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local;
    const F = servedFile();
    srv.route('/host.html', { headers: HTML, body: hostPage(F.cHash) });
    const list = cases(F);
    list.forEach(([, h], i) => {
        const headers = h(`/__report?from=${i}`, `${L}/__report?from=${i}`, F.policy);
        srv.route(`/f${i}.html`, { headers: { ...HTML, ...headers }, body: F.html });
    });
    const browser = await ENGINES[name].launch();
    emitRun('q3', name, browser);
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${L}/host.html?from=a-host-page-query`);
    const verdictAt = {};
    for (let i = 0; i < list.length; i++) {
        const [label, h, hostOpts] = list[i];
        const r = await page.evaluate(([u, o]) => window.start(u, { ...o, keep: true, timeout: 5000 }), [`/f${i}.html`, hostOpts || {}]);
        verdictAt[i] = r.verdictEpoch ?? null;
        let guest = null;
        if (r.decision === 'send') guest = (await page.evaluate(() => window.cmd('guest', 2500))).find((m) => m && m.guest)?.guest ?? 'no answer';
        await sleep(1500);
        const v = r.verdict;
        const view = (x) => x && { gates: x.gates && Object.entries(x.gates).filter(([, s]) => String(s).startsWith('broken')).map(([k]) => k), check: x.check, loads: x.loads, events: x.events && x.events.map((e) => `${e.dir} ${e.disp} ${e.blocked} ${e.policy === '(the meta, exact)' ? 'META' : 'OTHER: ' + e.policy.slice(0, 60)}`) };
        emit('q3.case', {
            engine: name, i, case: label, headers: h('/__report?from=' + i, `${L}/__report?from=${i}`, '<meta text>'), end: r.end, decision: r.decision,
            C: v && view(v.C), W: v && { started: v.W.started, ...view(v.W) },
            guest: guest && typeof guest === 'object' ? { C: guest.C, Cevents: guest.events.map((e) => `${e.dir} ${e.disp} ${e.blocked} ${e.sample}`), W: guest.W && guest.W.guest, Wevents: guest.W && guest.W.events && guest.W.events.map((e) => `${e.dir} ${e.disp} ${e.blocked} ${e.sample}`) } : guest,
            reportsWithin1500ms: srv.reports.filter((x) => x.from === String(i)).flatMap((x) => slim(x, verdictAt[i])),
        });
        await page.goto(`${L}/host.html?from=a-host-page-query`);
    }
    // the Reporting API's positive control: a top-level page of the file's origin whose own report-only policy refuses its image
    srv.route('/rt-control.html', { headers: { ...HTML, 'reporting-endpoints': `ws="${L}/__report?from=rt-control"`, [RO]: "img-src 'none'; report-to ws" }, body: '<!doctype html><img src="/control.png">' });
    srv.route('/ru-control.html', { headers: { ...HTML, [RO]: "img-src 'none'; report-uri /__report?from=ru-control" }, body: '<!doctype html><img src="/control.png">' });
    const control = await page.context().newPage();
    await control.goto(`${L}/rt-control.html`);
    await control.goto(`${L}/ru-control.html`);
    await sleep(65000);
    emit('q3.reportingControl', { engine: name, reportTo: srv.reports.filter((x) => x.from === 'rt-control').length, reportUri: srv.reports.filter((x) => x.from === 'ru-control').length });
    for (let i = 0; i < list.length; i++) {
        const reps = srv.reports.filter((x) => x.from === String(i)).flatMap((x) => slim(x, verdictAt[i]));
        emit('q3.reports', { engine: name, i, case: list[i][0], total: reps.length, startup: reps.filter((x) => !x.guestMarker).length, guest: reps.filter((x) => x.guestMarker).length, byDoc: count(reps.map((x) => `${x.api} ${docKind(x.doc)}`)), reports: reps });
    }
    await browser.close();
}
const docKind = (d) => (!d ? 'none' : d.startsWith('about') ? 'C (about:srcdoc)' : d.startsWith('blob') ? 'W (blob:)' : d.includes('/f') ? 'F' : d);
const count = (xs) => { const o = {}; for (const x of xs) o[x] = (o[x] || 0) + 1; return o; };

for (const name of process.argv.slice(2).filter((a) => a in ENGINES)) {
    try { await runEngine(name); } catch (e) { emit('q3.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
