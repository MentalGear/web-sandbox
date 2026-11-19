// Q6. A refused canary per directive: does a load the <meta> itself refuses (a fixed library URL on a reserved name,
// canaries.mjs) raise exactly the <meta>'s own securitypolicyviolation under the <meta> alone, and a second event under
// an outside policy that the admitted canaries of Q3 miss? What does a guest's URL then still make the browser report?
//
//   bun docs/research/31_served_startup/q6-refused-canaries.mjs <engine> [starts]     # default 24 starts per cost mode
//
// The browser goes through the recording server as its proxy (as Q1b), so a canary that left the browser is a hit at
// the server: an http: URL as a proxied request, an https: URL as a CONNECT. The positive control is the same canaries in
// a file without the <meta>. F is framed as the design does (closed shadow root, sandbox="allow-scripts allow-forms",
// referrerpolicy="no-referrer") from a host page whose URL has a query. Phases per header case, each in a fresh element:
//   canaries: every canary at once (canaries.mjs, CANARIES; refused ones in http: and https:), 1000 ms;
//   click:    a form whose action is the http: (then the https:) canary URL, submitted by a real click from outside;
//   guest:    every refused kind again with a guest's URL (http://leak.invalid/GUEST-SECRET-<kind>, and https:), 800 ms.
// Then: the reports at the endpoint, the hits, and (baseline only) the side effects. Last, the cost: 3 modes alternating.
// Each case line's `verdict` is a first reading that files the data: worker with Q3's set; tables-q6.mjs reads the raw
// events (`per`) against the baseline and files it with the refused canaries, and the README states that reading.
import { ENGINES, emit, emitRun, load1, median, sleep } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';
import { STILL, GUARD } from './fixture.mjs';
import { sha } from '../28_served_topology/lib.mjs';
import { CANARIES, canaryUrl, guestUrl, q6File, q6Host } from './canaries.mjs';

const RO = 'content-security-policy-report-only';
const CSP = 'content-security-policy';
const SCHEMES = ['http', 'https'];

/** The directives Q3 found unseen, with the <meta>'s own sources for each. */
const UNSEEN = { 'font-src': 'blob:', 'media-src': 'blob:', 'worker-src': 'blob:', 'frame-src': "'none'", 'object-src': "'none'", 'form-action': "'none'", 'manifest-src': "'none'" };

/** The header cases: [label, (reportUri) => headers]. */
function cases(F) {
    const list = [['none (control)', () => ({})]];
    for (const [d, own] of Object.entries(UNSEEN)) {
        list.push(
            [`RO ${d} ${own} (the <meta>'s own)`, (r) => ({ [RO]: `${d} ${own}; report-uri ${r}` })],
            [`CSP ${d} ${own} (the <meta>'s own, enforced)`, (r) => ({ [CSP]: `${d} ${own}; report-uri ${r}` })],
            [`RO ${d} *`, (r) => ({ [RO]: `${d} *; report-uri ${r}` })],
            [`RO ${d} https: blob:`, (r) => ({ [RO]: `${d} https: blob:; report-uri ${r}` })],
            [`RO ${d} * blob: data:`, (r) => ({ [RO]: `${d} * blob: data:; report-uri ${r}` })],
            [`RO ${d} *.canary.invalid blob: (names the canaries' hosts)`, (r) => ({ [RO]: `${d} *.canary.invalid blob:; report-uri ${r}` })],
        );
    }
    list.push(
        ['RO default-src blob:', (r) => ({ [RO]: `default-src blob:; report-uri ${r}` })],
        ["RO default-src 'self' blob: 'unsafe-inline' 'unsafe-eval'", (r) => ({ [RO]: `default-src 'self' blob: 'unsafe-inline' 'unsafe-eval'; report-uri ${r}` })],
        ["RO default-src https: blob: 'unsafe-inline' 'unsafe-eval'", (r) => ({ [RO]: `default-src https: blob: 'unsafe-inline' 'unsafe-eval'; report-uri ${r}` })],
        ["RO default-src * blob: data: 'unsafe-inline' 'unsafe-eval'", (r) => ({ [RO]: `default-src * blob: data: 'unsafe-inline' 'unsafe-eval'; report-uri ${r}` })],
        ["CSP default-src * blob: data: 'unsafe-inline' 'unsafe-eval'; base-uri *; form-action * (enforced)", (r) => ({ [CSP]: `default-src * blob: data: 'unsafe-inline' 'unsafe-eval'; base-uri *; form-action *; report-uri ${r}` })],
        ['RO child-src blob:', (r) => ({ [RO]: `child-src blob:; report-uri ${r}` })],
        ['RO child-src *', (r) => ({ [RO]: `child-src *; report-uri ${r}` })],
        ['RO img-src blob: (control)', (r) => ({ [RO]: `img-src blob:; report-uri ${r}` })],
        [`RO style-src the <meta>'s own (control)`, (r) => ({ [RO]: `style-src ${sha(STILL)} blob:; report-uri ${r}` })],
        ["RO connect-src 'none' (control)", (r) => ({ [RO]: `connect-src 'none'; report-uri ${r}` })],
        [`RO script-src the <meta>'s own + 'report-sample' (control)`, (r) => ({ [RO]: `script-src ${sha(GUARD)} ${F.cHash} 'report-sample'; report-uri ${r}` })],
        ['RO img-src * (control)', (r) => ({ [RO]: `img-src *; report-uri ${r}` })],
        ['RO connect-src * (control)', (r) => ({ [RO]: `connect-src *; report-uri ${r}` })],
        ['CSP img-src * blob: (control, enforced)', (r) => ({ [CSP]: `img-src * blob:; report-uri ${r}` })],
    );
    return list;
}

/** The jobs of one run: refused kinds with `url(key, scheme)` in both schemes; the others with no URL. */
function jobs(realm, url, kinds = ['refused', 'refused-local', 'admitted']) {
    const out = [];
    for (const c of CANARIES) {
        if (c.realm !== realm || !kinds.includes(c.kind)) continue;
        if (c.kind === 'refused') for (const s of SCHEMES) out.push([c.key, url(c.key, s)]);
        else out.push([c.key]);
    }
    return out;
}

const norm = (p) => String(p).split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean).sort().join('; ');

/** Which canary (or guest load) an event belongs to: a canary.invalid host names it; a local load is named by its directive and scheme. */
function attribute(e) {
    const b = e.blocked || '';
    const m = /^(https?):\/\/([a-z-]+)\.canary\.invalid/.exec(b);
    if (m) return { group: 'refused', id: `${e.realm === 'W' && !m[2].startsWith('w-') ? 'W:' : ''}${m[2]} ${m[1]}` };
    if (b.includes('leak.invalid')) return { group: 'guest', id: b.includes('GUEST-SECRET') ? 'full URL' : 'origin only' };
    return { group: 'local', id: `${e.realm} ${e.dir} ${b.split(':')[0] || '(empty)'}` };
}

/** One event, reduced: its canary, directive, disposition, policy (META when the <meta>'s text), blocked URL, arrival. */
const slimEvent = (meta) => (e) => ({ ...attribute(e), realm: e.realm, dir: e.dir, viol: e.viol, disp: e.disp, policy: norm(e.policy) === norm(meta) ? 'META' : e.policy.slice(0, 90), blocked: e.blocked, dt: e.dt });

/** One report (report-uri), reduced to its fields; `library` is false when a field carries anything of the host page or a guest. */
function slimReport(rep) {
    const b = (rep.body && rep.body['csp-report']) || rep.body || {};
    const g = (k) => (b[k] == null ? undefined : String(b[k]));
    const fields = { dir: g('effective-directive') || g('violated-directive'), disp: g('disposition'), doc: g('document-uri')?.slice(0, 60), blocked: g('blocked-uri')?.slice(0, 80), referrer: g('referrer'), source: g('source-file')?.slice(0, 60), sample: g('script-sample')?.slice(0, 40), status: g('status-code') };
    const text = JSON.stringify(b);
    return { ...fields, guest: text.includes('leak.invalid'), hostQuery: text.includes('a-host-page-query') };
}

const hitsOf = (srv) => srv.requests.filter((q) => /canary\.invalid|leak\.invalid/.test(q.host || '')).map((q) => (q.path === 'CONNECT' ? `CONNECT ${q.host}` : `GET ${q.host}${q.path}`));

async function runEngine(name, starts) {
    const srv = await startServer();
    const L = srv.local;
    const F = q6File();
    const NOMETA = q6File({ meta: false });
    srv.route('/host6.html', { headers: HTML, body: q6Host() });
    srv.route('/nometa.html', { headers: HTML, body: NOMETA.html });
    const list = cases(F);
    list.forEach(([, h], i) => srv.route(`/f${i}.html`, { headers: { ...HTML, ...h(`/__report?from=${i}`) }, body: F.html }));
    const browser = await ENGINES[name].launch({ proxy: { server: srv.ip, bypass: '<-loopback>' } });
    emitRun('q6', name, browser);
    const page = await (await browser.newContext()).newPage();
    const consoleLines = [];
    page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 160)}`));
    await page.goto(`${L}/host6.html?from=a-host-page-query`);
    const cFrame = () => page.frames().find((f) => f.url() === 'about:srcdoc');
    const open = (u) => page.evaluate((x) => window.open6(x), u);
    const send = (cmd, ms) => page.evaluate(([c, t]) => window.send6(c, t), [cmd, ms ?? 6000]);
    const epoch = () => page.evaluate(() => performance.timeOrigin + performance.now());
    // a form canary in an element of its own: submitted by submit() or by a real click; the events come from C's stream,
    // since a form that is not stopped takes C away; `alive` is whether C still answers afterwards
    const formPhase = async (file, url, how) => {
        await open(file);
        consoleLines.length = 0;
        const before = await page.evaluate(() => window.state6());
        const t0 = await epoch();
        let did;
        if (how === 'click') {
            await send({ cmd: 'form-setup', url });
            try { await cFrame().click('#ws-go', { timeout: 3000 }); did = 'clicked'; } catch (e) { did = 'click failed: ' + String(e).slice(0, 80); }
            await sleep(800);
        } else {
            const r = await send({ cmd: 'run', jobs: [['form-submit', url]], wait: 800 }, 1300);
            did = r.error ? 'submit(), ' + r.error : 'submit(), replied';
        }
        const ping = await send({ cmd: 'collect', mark: 0, t0 }, 600);
        const events = (await page.evaluate(() => window.stream6())).map((e) => ({ ...e, dt: +(e.ep - t0).toFixed(1) }));
        return { did, alive: !ping.error, cUrl: page.frames().slice(1).map((f) => f.url().replace(/^http:\/\/localhost:\d+/, '')).join(' | '), before, after: await page.evaluate(() => window.state6()), events, console: consoleLines.filter((l) => /form|fram/i.test(l)).map((l) => l.slice(0, 130)) };
    };
    const noForm = (js) => js.filter(([k]) => k !== 'form-submit');

    // the positive control: the same canaries in a file without the <meta>; each form in an element of its own (it navigates C)
    srv.reset();
    const ready = await open('/nometa.html');
    const pc = await send({ cmd: 'run', jobs: noForm(jobs('C', canaryUrl)), wjobs: jobs('W', canaryUrl), wait: 1500 });
    const forms = {};
    for (const s of SCHEMES) for (const how of ['submit', 'click']) {
        const f = await formPhase('/nometa.html', canaryUrl(`form-${how}`, s), how);
        forms[`form-${how} ${s}`] = { did: f.did, alive: f.alive, cUrl: f.cUrl };
    }
    await sleep(500);
    emit('q6.control', { engine: name, ready, outcomes: pc.out, W: pc.W && { started: pc.W.started, out: pc.W.out }, forms, hits: hitsOf(srv) });

    // the header cases
    const baseline = {};
    const only = process.env.Q6_CASES ? process.env.Q6_CASES.split(',').map(Number) : null; // a subset, for a trial run
    for (let i = 0; i < list.length; i++) {
        if (only && !only.includes(i)) continue;
        const [label, h] = list[i];
        srv.reset();
        const r0 = await open(`/f${i}.html`);
        consoleLines.length = 0;
        if (r0.ready == null) { emit('q6.case', { engine: name, i, case: label, end: 'C never ready' }); continue; }
        const stateBefore = await page.evaluate(() => window.state6());
        const run = await send({ cmd: 'run', jobs: noForm(jobs('C', canaryUrl)), wjobs: jobs('W', canaryUrl), wait: 1000 });
        const stateAfter = await page.evaluate(() => window.state6());
        const runConsole = consoleLines.slice(0, 60);
        // the forms only where the header names form-action (it has no fallback) and in the baseline: a form takes C away on some engines
        const formCase = i === 0 || /form-action/.test(JSON.stringify(h('')));
        const formRuns = {};
        if (formCase) for (const s of SCHEMES) for (const how of ['submit', 'click']) formRuns[`form-${how} ${s}`] = await formPhase(`/f${i}.html`, canaryUrl(`form-${how}`, s), how);
        await open(`/f${i}.html`);
        const guest = await send({ cmd: 'run', jobs: noForm(jobs('C', guestUrl, ['refused'])), wjobs: jobs('W', guestUrl, ['refused']), wait: 800 });
        const guestForms = {};
        if (formCase) for (const s of SCHEMES) guestForms[s] = await formPhase(`/f${i}.html`, guestUrl('form-submit', s), 'submit');
        await sleep(1500);
        const se = slimEvent(F.policy);
        const events = [...(run.events || []), ...((run.W && run.W.events) || [])].map(se);
        for (const [id, fr] of Object.entries(formRuns)) for (const e of fr.events) events.push({ ...se(e), id: attribute(e).group === 'refused' ? attribute(e).id : `${id} (${attribute(e).id})` });
        const guestEvents = [...(guest.events || []), ...((guest.W && guest.W.events) || []), ...Object.values(guestForms).flatMap((g) => g.events)].map(se);
        // per canary: its events; the baseline (no header) gives what the <meta> alone raises
        const per = {};
        for (const e of events) (per[e.id] ??= []).push(e);
        if (i === 0) for (const [id, es] of Object.entries(per)) baseline[id] = es.length;
        // the forms' events come from C's stream, which a navigation of C can cut (Chromium): `forms` records whether C survived
        const isCanary = (id) => !id.startsWith('C ') && !id.startsWith('W ');
        const refusedIds = [...new Set([...Object.keys(baseline).filter(isCanary), ...Object.keys(per).filter(isCanary)])];
        const seenBy = refusedIds.filter((id) => { const es = per[id] || []; return es.length !== (baseline[id] ?? 0) || es.some((e) => e.policy !== 'META' || e.disp !== 'enforce'); });
        const localForeign = events.filter((e) => e.group === 'local' && (e.policy !== 'META' || e.disp !== 'enforce'));
        const off = [];
        const want = { 'img-blob': 'loaded', 'style-blob': 'load', 'worker-blob': 'ran', 'fetch-blob': 'refused TypeError', eval: 'refused' };
        for (const [k, v] of Object.entries(want)) if (run.out && run.out[k] !== v) off.push(`${k}: ${run.out && run.out[k]}`);
        if (!run.W || run.W.started !== 'yes') off.push(`worker: ${run.W && run.W.started}`);
        const admitted = localForeign.length > 0 || off.length > 0;
        const reports = srv.reports.filter((x) => x.from === String(i)).map(slimReport);
        const guestForeign = guestEvents.filter((e) => e.policy !== 'META' || e.disp !== 'enforce');
        emit('q6.case', {
            engine: name, i, case: label, headers: h(`/__report?from=${i}`),
            verdict: { admitted, admittedWhy: [...new Set(localForeign.map((e) => e.id))].concat(off), refused: seenBy, category: admitted ? 'admitted' : seenBy.length ? 'refused' : 'unseen' },
            per: Object.fromEntries(Object.entries(per).map(([id, es]) => [id, es.map((e) => `${e.realm} ${e.dir}/${e.viol} ${e.disp} ${e.policy === 'META' ? 'META' : 'OTHER'} ${e.blocked} +${e.dt}`)])),
            outcomes: run.out, W: run.W && { started: run.W.started, out: run.W.out },
            forms: Object.fromEntries(Object.entries(formRuns).map(([id, f]) => [id, { did: f.did, alive: f.alive, cUrl: f.cUrl, hostLoads: `${f.before.loads.length}->${f.after.loads.length}`, events: f.events.map((e) => { const x = se(e); return `${x.dir} ${x.disp} ${x.policy === 'META' ? 'META' : 'OTHER'} ${x.blocked} +${x.dt}`; }), console: f.console }])),
            guestForms: Object.fromEntries(Object.entries(guestForms).map(([id, f]) => [id, { did: f.did, alive: f.alive, cUrl: f.cUrl }])),
            guest: { foreign: guestForeign.map((e) => `${e.realm} ${e.dir} ${e.disp} ${e.blocked}`), all: guestEvents.length },
            reports: { canary: reports.filter((x) => !x.guest), guest: reports.filter((x) => x.guest) },
            hits: hitsOf(srv),
            side: i === 0 ? { stateBefore, stateAfter, inC: run.side, console: runConsole } : undefined,
        });
    }

    // the cost, on the baseline file: admitted canaries alone (Q3's kinds), refused alone, and both, alternating
    const MODES = {
        admitted: { jobs: jobs('C', canaryUrl, ['admitted', 'refused-local']), wjobs: jobs('W', canaryUrl, ['refused-local']) },
        refused: { jobs: noForm(jobs('C', canaryUrl, ['refused'])), wjobs: jobs('W', canaryUrl, ['refused']) },
        both: { jobs: noForm(jobs('C', canaryUrl)), wjobs: jobs('W', canaryUrl) },
    };
    const rows = Object.fromEntries(Object.keys(MODES).map((k) => [k, []]));
    const loads = [];
    for (const m of Object.keys(MODES)) { await open('/f0.html'); await send({ cmd: 'run', ...MODES[m], wait: 600 }); } // warm-up
    for (let k = 0; k < starts; k++) {
        const order = Object.keys(MODES);
        for (const m of k % 2 ? order.reverse() : order) {
            loads.push(load1());
            await open('/f0.html');
            const r = await send({ cmd: 'run', ...MODES[m], wait: 600 });
            const se = slimEvent(F.policy);
            const evs = [...(r.events || []), ...((r.W && r.W.events) || [])].map(se);
            const admittedSettle = Object.entries(r.settled || {}).filter(([k2]) => !/ https?$/.test(k2)).map(([, v]) => v);
            const wSettle = Object.entries((r.W && r.W.settled) || {}).filter(([k2]) => !/ https?$/.test(k2)).map(([, v]) => v);
            rows[m].push({ events: evs.map((e) => [e.id, e.dt]), admittedEnd: Math.max(0, ...admittedSettle, ...wSettle), lastEvent: Math.max(0, ...evs.map((e) => e.dt)), count: evs.length });
            await sleep(50);
        }
    }
    for (const [m, rs] of Object.entries(rows)) {
        const end = rs.map((r) => Math.max(r.admittedEnd, r.lastEvent));
        const byId = {};
        for (const r of rs) for (const [id, dt] of r.events) (byId[id] ??= []).push(dt);
        emit('q6.cost', {
            engine: name, mode: m, starts: rs.length, events: [...new Set(rs.map((r) => r.count))],
            end: { median: +median(end).toFixed(1), min: Math.min(...end), max: Math.max(...end) },
            lastEvent: { median: +median(rs.map((r) => r.lastEvent)).toFixed(1), max: Math.max(...rs.map((r) => r.lastEvent)) },
            admittedEnd: { median: +median(rs.map((r) => r.admittedEnd)).toFixed(1), max: Math.max(...rs.map((r) => r.admittedEnd)) },
            perCanary: Object.fromEntries(Object.entries(byId).map(([id, xs]) => [id, { n: xs.length, median: +median(xs).toFixed(1), max: Math.max(...xs) }])),
            load1: `${Math.min(...loads)}-${Math.max(...loads)}`,
        });
    }
    await browser.close();
}

const args = process.argv.slice(2);
const starts = Number(args.find((a) => /^\d+$/.test(a)) ?? 24);
for (const name of args.filter((a) => a in ENGINES)) {
    try { await runEngine(name, starts); } catch (e) { emit('q6.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
