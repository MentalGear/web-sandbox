// Q8. Why Firefox's fixture check refused clean starts (Q7), and whether a check that attributes every event by what it
// carries, with no fixed wait and no window, has no such refusal.
//
//   bun docs/research/31_served_startup/q8-check-timing.mjs <engine> [A|B|L] [starts] [wait=30]
//
// A: on the clean file, the fixture's check (check-content.mjs, fixedScript: Q1's C with its window boundaries recorded)
//    and the content check (contentScript), alternating, `starts` each idle and `starts` each under CPU load (four busy
//    node processes, killed afterwards). Per start: the verdict, the condition that made it not clean, every event of C
//    and the worker with its arrival after the canaries' issue and the window it landed in. `wait` replaces the
//    fixture's two 30 ms waits (to show the mechanism if 30 ms does not reproduce it).
// L: under CPU load only, the content check (its admitted blob: worker's outcome cut at 600 ms, as in A) alternating with
//    the same check without that cut (`workerNoCut`), `starts` each.
// B: the content check under headers (none; the <meta>'s exact text enforced; six headers it should see), 50 starts each
//    idle and loaded: its verdict when the expected events are in, and every event of the next 300 ms (pairs per load).
import { spawn } from 'node:child_process';
import { ENGINES, emit, emitRun, load1, median, range, sleep } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';
import { hostPage, servedFile } from './fixture.mjs';
import { contentScript, fixedScript } from './check-content.mjs';

const RO = 'content-security-policy-report-only';
const CSP = 'content-security-policy';

/** CPU load: n busy processes; returns a stop function that kills them and confirms they are gone. */
function busy(n = 4) {
    const ps = Array.from({ length: n }, () => spawn('node', ['-e', 'for(;;){}'], { stdio: 'ignore' }));
    return async () => {
        for (const p of ps) p.kill('SIGKILL');
        await sleep(300);
        const alive = ps.filter((p) => { try { process.kill(p.pid, 0); return true; } catch { return false; } });
        return { started: ps.length, aliveAfterKill: alive.length };
    };
}

const HELPER = `
window.run8 = async (url, expectHash, lateMs) => {
  const r = await window.start(url, { keep: true, send: false, expectHash, timeout: 6000 });
  let late = null;
  if (lateMs) late = await new Promise((res) => { const p = window.lastPort; p.addEventListener('message', (m) => { if (m.data && m.data.late) res(m.data.late); }); setTimeout(() => res(null), lateMs); });
  for (const e of document.querySelectorAll('web-sandbox-probe')) e.remove();
  return { end: r.end, decision: r.decision, timeline: r.timeline, verdict: r.verdict, late };
};
</script></body></html>`;

/** The fixture check's events of one realm, each with its arrival after the canaries' issue and its window. */
function windows(realm) {
    const T = realm && realm.loads && realm.loads.ms;
    if (!T || T.t0 == null) return null;
    const win = (rel) => (rel < T.allSettled ? 'canaries' : rel < T.twinFrom ? 'wait' : rel <= T.twin ? 'twin' : 'after');
    const evs = (realm.events || []).map((e) => { const rel = e.t - Math.round(T.t0); return [e.dir, String(e.blocked).split(':')[0], e.disp, e.policy === '(the meta, exact)' ? 1 : 0, rel, win(rel)]; });
    return { allSettled: T.allSettled, twinFrom: T.twinFrom, twinEnd: T.twin, events: evs, check: realm.check, twin: realm.loads.twin, settle: Object.fromEntries(Object.entries(T).filter(([k]) => !['t0', 'allSettled', 'twinFrom', 'twin'].includes(k))) };
}

async function phaseA(name, page, srv, FX, FC, starts) {
    for (const load of ['idle', 'loaded']) {
        const stop = load === 'loaded' ? busy(4) : null;
        if (stop) await sleep(1000);
        const rows = { fixed: [], content: [] };
        for (let k = 0; k < starts; k++) {
            for (const v of k % 2 ? ['content', 'fixed'] : ['fixed', 'content']) {
                const l1 = load1();
                const r = await page.evaluate(([u, h]) => window.run8(u, h, 0), v === 'fixed' ? ['/Fx.html', FX.cHash] : ['/Fc.html', FC.cHash]);
                const d = r.verdict;
                const line = { engine: name, load, variant: v, k, load1: l1, end: r.end, refused: r.decision && r.decision.refused, insertToVerdict: r.timeline.verdict };
                if (v === 'fixed') Object.assign(line, { checkMs: d && d.phases ? d.phases.check - d.phases.gates : null, C: d && windows(d.C), W: d && windows(d.W) });
                else Object.assign(line, { checkMs: d && d.C.check.ms, content: d && d.C.check });
                emit('q8.start', line);
                rows[v].push(line);
            }
        }
        const killed = stop ? await stop() : null;
        for (const [v, rs] of Object.entries(rows)) {
            const t = rs.map((x) => x.checkMs).filter((x) => typeof x === 'number');
            const iv = rs.map((x) => x.insertToVerdict).filter((x) => typeof x === 'number');
            const why = {};
            for (const x of rs) for (const c of x.refused || []) why[c] = (why[c] || 0) + 1;
            emit('q8.summary', { engine: name, load, variant: v, starts: rs.length, refused: rs.filter((x) => x.refused).length, refusedBy: why, checkMs: t.length ? { median: +median(t).toFixed(1), range: range(t.map(Math.round)) } : null, insertToVerdict: iv.length ? { median: +median(iv).toFixed(1), range: range(iv.map(Math.round)) } : null, load1: range(rs.map((x) => x.load1)), killed });
        }
    }
}

async function phaseL(name, page, FC, FN, starts) {
    const stop = busy(4);
    await sleep(1000);
    const rows = { content: [], 'content, no worker cut': [] };
    for (let k = 0; k < starts; k++) {
        for (const v of k % 2 ? ['content, no worker cut', 'content'] : ['content', 'content, no worker cut']) {
            const l1 = load1();
            const r = await page.evaluate(([u, h]) => window.run8(u, h, 0), v === 'content' ? ['/Fc.html', FC.cHash] : ['/Fn.html', FN.cHash]);
            const line = { engine: name, load: 'loaded', variant: v, k, load1: l1, end: r.end, refused: r.decision && r.decision.refused, insertToVerdict: r.timeline.verdict, checkMs: r.verdict && r.verdict.C.check.ms, content: r.verdict && r.verdict.C.check };
            emit('q8.start', line);
            rows[v].push(line);
        }
    }
    emit('q8.killed', { engine: name, ...(await stop()) });
}

async function phaseB(name, page, FC, list, starts) {
    for (let i = 0; i < list.length; i++) {
        for (const load of ['idle', 'loaded']) {
            const stop = load === 'loaded' ? busy(4) : null;
            if (stop) await sleep(1000);
            const rs = [];
            for (let k = 0; k < starts; k++) {
                const l1 = load1();
                const r = await page.evaluate(([u, h]) => window.run8(u, h, 1500), [`/h${i}.html`, FC.cHash]);
                const c = r.verdict && r.verdict.C.check;
                const late = r.late;
                // per load (canary id): the <meta>'s events and the others, with their times; the gap between the first of each
                const per = {};
                for (const e of (late && late.events) || []) (per[e.id] ??= { meta: [], other: [] })[e.meta ? 'meta' : 'other'].push(e.dt);
                const pairs = Object.fromEntries(Object.entries(per).filter(([, p]) => p.other.length || p.meta.length > 1).map(([id, p]) => [id, p]));
                const line = { engine: name, i, header: list[i][0], load, k, load1: l1, end: r.end, verdict: c && { clean: c.clean, why: c.why, ms: c.ms, foreign: c.foreign, dup: c.dup, missing: c.missing.length, off: c.off }, lateForeign: late && late.lateForeign, dupFinal: late && late.dupFinal, pairs };
                emit('q8.header', line);
                rs.push(line);
            }
            const killed = stop ? await stop() : null;
            // the largest gap, per load, between its first <meta> event and the first other (or second) event, and how often a second policy's first event came after the verdict
            let maxGap = 0, afterVerdict = 0, seenAtVerdict = 0;
            for (const x of rs) {
                if (x.verdict && !x.verdict.clean && (x.verdict.foreign || x.verdict.dup.length)) seenAtVerdict++;
                let anyLateForeign = false;
                for (const p of Object.values(x.pairs)) {
                    const m = Math.min(...p.meta), o = p.other.length ? Math.min(...p.other) : p.meta.length > 1 ? [...p.meta].sort((a, b) => a - b)[1] : null;
                    if (m !== Infinity && o != null) maxGap = Math.max(maxGap, Math.abs(o - m));
                }
                if (x.lateForeign) anyLateForeign = true;
                if (anyLateForeign && x.verdict && x.verdict.clean) afterVerdict++;
            }
            emit('q8.headerSummary', { engine: name, i, header: list[i][0], load, starts: rs.length, notCleanAtVerdict: rs.filter((x) => x.verdict && !x.verdict.clean).length, whyNotClean: count(rs.filter((x) => x.verdict && !x.verdict.clean).map((x) => `${x.verdict.why}${x.verdict.foreign ? ' foreign' : ''}${x.verdict.dup.length ? ' dup ' + x.verdict.dup.join(',') : ''}${x.verdict.off.length ? ' off ' + x.verdict.off.join(',') : ''}`)), cleanButForeignLater: afterVerdict, maxGapMs: +maxGap.toFixed(1), verdictMs: { median: median(rs.map((x) => x.verdict ? x.verdict.ms : NaN).filter(Number.isFinite)) }, load1: range(rs.map((x) => x.load1)), killed });
        }
    }
}
const count = (xs) => { const o = {}; for (const x of xs) o[x] = (o[x] || 0) + 1; return o; };

async function runEngine(name, phase, starts, wait) {
    const srv = await startServer();
    const FX = servedFile({ script: fixedScript({ wait }) });
    const FC = servedFile({ script: contentScript() });
    srv.route('/host8.html', { headers: HTML, body: hostPage(FX.cHash).replace('</script></body></html>', HELPER) });
    srv.route('/Fx.html', { headers: HTML, body: FX.html });
    srv.route('/Fc.html', { headers: HTML, body: FC.html });
    const FN = servedFile({ script: contentScript({ workerNoCut: true }) });
    srv.route('/Fn.html', { headers: HTML, body: FN.html });
    const list = [
        ['none', () => ({})],
        ["CSP the <meta>'s exact text (enforced)", () => ({ [CSP]: FC.policy })],
        ['RO font-src blob:', () => ({ [RO]: 'font-src blob:' })],
        ['RO img-src blob:', () => ({ [RO]: 'img-src blob:' })],
        ['CSP font-src blob: (enforced)', () => ({ [CSP]: 'font-src blob:' })],
        ["CSP frame-src 'none' (enforced)", () => ({ [CSP]: "frame-src 'none'" })],
        ["RO default-src 'self' blob: 'unsafe-inline' 'unsafe-eval'", () => ({ [RO]: "default-src 'self' blob: 'unsafe-inline' 'unsafe-eval'" })],
        ["RO the <meta>'s exact text", () => ({ [RO]: FC.policy })],
    ];
    list.forEach(([, h], i) => srv.route(`/h${i}.html`, { headers: { ...HTML, ...h() }, body: FC.html }));
    const browser = await ENGINES[name].launch();
    emitRun('q8', name, browser);
    emit('q8.config', { engine: name, phase, starts, wait });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${srv.local}/host8.html`);
    for (const u of ['/Fx.html', '/Fc.html']) await page.evaluate(([x, h]) => window.run8(x, h, 0), [u, u === '/Fx.html' ? FX.cHash : FC.cHash]); // warm-up
    if (phase === 'A') await phaseA(name, page, srv, FX, FC, starts);
    else if (phase === 'L') await phaseL(name, page, FC, FN, starts);
    else await phaseB(name, page, FC, list, starts);
    await browser.close();
}

const args = process.argv.slice(2);
const phase = args.find((a) => a === 'A' || a === 'B' || a === 'L') ?? 'A';
const starts = Number(args.find((a) => /^\d+$/.test(a)) ?? (phase === 'A' ? 200 : 50));
const wait = Number((args.find((a) => a.startsWith('wait=')) ?? 'wait=30').slice(5));
for (const name of args.filter((a) => a in ENGINES)) {
    try { await runEngine(name, phase, starts, wait); } catch (e) { emit('q8.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
