// Prints what the README's Q8 states from a results set: the refusals of the fixture's check and of the content check
// (phase A), the events that made a fixture check not clean, the times, and the content check under headers (phase B).
//
//   bun docs/research/31_served_startup/tables-q8.mjs <set>
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results', process.argv[2] ?? '2026-11-19_pw-1.65.1');
const ENGINES = ['chromium', 'firefox', 'webkit'];
const read = (f) => (!existsSync(path.join(dir, f)) ? [] : readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.startsWith('q8.')).map((l) => [l.slice(0, l.indexOf(' ')), JSON.parse(l.slice(l.indexOf(' ') + 1))]));
const count = (xs) => { const o = {}; for (const x of xs) o[x] = (o[x] || 0) + 1; return o; };

for (const e of ENGINES) {
    const a = read(`q8a-${e}.txt`);
    console.log(`\n## ${e} (phase A)`);
    for (const [t, o] of a) if (t === 'q8.config' || t === 'q8.run' || t === 'q8.error') console.log(t, JSON.stringify(o));
    for (const [t, o] of a) if (t === 'q8.summary' && o.killed) console.log('load processes', JSON.stringify(o.killed));
    // the summary, from the starts (a file may hold several runs of the probe, one after another)
    const med = (xs) => { const v = [...xs].sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
    for (const load of ['idle', 'loaded']) for (const v of ['fixed', 'content']) {
        const rs = a.filter(([t, o]) => t === 'q8.start' && o.load === load && o.variant === v).map(([, o]) => o);
        if (!rs.length) continue;
        const c = rs.map((o) => o.checkMs).filter((x) => typeof x === 'number');
        const iv = rs.map((o) => o.insertToVerdict).filter((x) => typeof x === 'number');
        const l1 = rs.map((o) => o.load1);
        console.log(`${load} ${v}: starts ${rs.length}, refused ${rs.filter((o) => o.refused).length} ${JSON.stringify(count(rs.flatMap((o) => o.refused || [])))}; check ${med(c).toFixed(1)} (${Math.round(Math.min(...c))}-${Math.round(Math.max(...c))}); insertion ${med(iv).toFixed(1)} (${Math.round(Math.min(...iv))}-${Math.round(Math.max(...iv))}); load ${Math.min(...l1)}-${Math.max(...l1)}`);
    }
    const fixed = a.filter(([t, o]) => t === 'q8.start' && o.variant === 'fixed').map(([, o]) => o);
    // the condition of each not-clean realm, and the events that landed in the twin's window besides the twin itself
    for (const load of ['idle', 'loaded']) {
        const rs = fixed.filter((o) => o.load === load);
        const conds = [];
        const extraInTwin = [];
        for (const o of rs) {
            for (const realm of ['C', 'W']) {
                const x = o[realm];
                if (!x) { conds.push(`${realm}: no record`); continue; }
                const c = x.check || {};
                if (!c.clean) conds.push(`${realm}: ${[c.foreign ? 'foreign ' + c.foreign : '', c.duplicates ? 'twin raised ' + x.twin : '', (c.off || []).length ? 'off ' + c.off.join(',') : ''].filter(Boolean).join(' + ')}`);
                const inTwin = x.events.filter((ev) => ev[5] === 'twin');
                // the twin itself is a refused fetch(blob:) issued at twinFrom; every other event in the window is extra
                const twinOwn = inTwin.findIndex((ev) => ev[0] === 'connect-src' && ev[1] === 'blob');
                const extra = inTwin.filter((_, i) => i !== twinOwn);
                for (const ev of extra) extraInTwin.push(`${realm} ${ev[0]} ${ev[1]} at ${ev[4]} ms (twin from ${x.twinFrom})${o.refused ? ' REFUSED' : ''}`);
            }
        }
        console.log(`fixed ${load}: starts ${rs.length}, refused ${rs.filter((o) => o.refused).length}; conditions ${JSON.stringify(count(conds))}`);
        console.log(`   extra events in a twin window: ${extraInTwin.length}: ${JSON.stringify(count(extraInTwin.map((x) => x.replace(/ at \d+ ms \(twin from \d+\)/, ''))))}`);
        const refused = rs.filter((o) => o.refused).slice(0, 4);
        for (const o of refused) console.log(`   refused k=${o.k} ${JSON.stringify(o.refused)} load1=${o.load1} C: settled ${o.C?.allSettled} twin ${o.C?.twinFrom}-${o.C?.twinEnd} events ${JSON.stringify(o.C?.events.filter((ev) => ev[4] >= (o.C?.allSettled ?? 0)))} | W: twin ${o.W?.twinFrom}-${o.W?.twinEnd} events ${JSON.stringify(o.W?.events.filter((ev) => ev[4] >= (o.W?.allSettled ?? 0)))}`);
        // when the worker's events filed in C (Firefox) arrive, against C's twin window
        const late = rs.flatMap((o) => (o.C ? o.C.events.filter((ev) => ev[1] === 'blob' && ev[0] === 'script-src-elem').map((ev) => ev[4] - o.C.twinFrom) : []));
        if (late.length) console.log(`   worker import events filed in C, arrival minus C's twin start: n=${late.length}, min ${Math.min(...late)}, max ${Math.max(...late)}, inside the twin window ${late.filter((x) => x >= 0).length}`);
    }
    const content = a.filter(([t, o]) => t === 'q8.start' && o.variant === 'content').map(([, o]) => o);
    console.log(`content not clean: ${JSON.stringify(count(content.filter((o) => o.refused).map((o) => `${o.load} ${o.content?.why} ${o.content?.missing?.join(',')} ${o.content?.off?.join(',')} ${o.content?.dup?.join(',')}`)))}`);

    const b = read(`q8b-${e}.txt`);
    console.log(`\n## ${e} (phase B)`);
    for (const [t, o] of b) if (t === 'q8.headerSummary' || t === 'q8.error') console.log(JSON.stringify(o));
    // the <meta> event counts per canary with no header (what identifies each canary, and how many events it raises)
    const none = b.filter(([t, o]) => t === 'q8.header' && o.i === 0).map(([, o]) => o);
    console.log(`no header: dupFinal ${JSON.stringify(count(none.map((o) => (o.dupFinal || []).join(' '))))}; pairs present in ${none.filter((o) => Object.keys(o.pairs).length).length} starts: ${JSON.stringify(count(none.flatMap((o) => Object.keys(o.pairs))))}`);
    // per header: the largest gap between a load's <meta> event and its other event, per canary
    for (let i = 1; i < 8; i++) {
        const rs = b.filter(([t, o]) => t === 'q8.header' && o.i === i).map(([, o]) => o);
        if (!rs.length) continue;
        // per load: only the canaries named by their URL are one load each ('connect-src blob' and 'script-src eval' are
        // two loads each, C's and the worker's, which no event field tells apart)
        const gaps = {};
        let pairsN = 0, partnerAfterVerdict = 0, worstAfter = -Infinity;
        for (const o of rs) for (const [id, p] of Object.entries(o.pairs)) {
            if (!/ https?$/.test(id) && id !== 'worker-src data') continue;
            const m = Math.min(...p.meta);
            const other = p.other.length ? Math.min(...p.other) : p.meta.length > 1 ? [...p.meta].sort((x, y) => x - y)[1] : null;
            if (!Number.isFinite(m) || other == null) continue;
            pairsN++;
            const second = Math.max(m, other);
            if (o.verdict && second > o.verdict.ms) partnerAfterVerdict++;
            if (o.verdict) worstAfter = Math.max(worstAfter, second - o.verdict.ms);
            (gaps[id] ??= []).push(+(other - m).toFixed(1));
        }
        const all = Object.values(gaps).flat();
        const g = Object.entries(gaps).map(([id, xs]) => `${id} ${Math.min(...xs)}..${Math.max(...xs)}`).join('; ');
        console.log(`[${i}] ${rs[0].header} (${rs.length} starts): pairs ${pairsN}; |gap| max ${all.length ? Math.max(...all.map(Math.abs)) : '-'} ms; second event of a pair after the verdict: ${partnerAfterVerdict} (latest ${Number.isFinite(worstAfter) ? worstAfter.toFixed(1) : '-'} ms relative to the verdict)`);
        console.log(`    other-minus-meta per canary (ms): ${g}`);
    }
}

// phase L: under load, the content check with and without its admitted worker's 600 ms cut
for (const e of ENGINES) {
    const l = read(`q8l-${e}.txt`);
    if (!l.length) continue;
    console.log(`\n## ${e} (phase L)`);
    for (const [t, o] of l) if (t === 'q8.killed' || t === 'q8.error') console.log(t, JSON.stringify(o));
    const med = (xs) => { const v = [...xs].sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
    for (const v of ['content', 'content, no worker cut']) {
        const rs = l.filter(([t, o]) => t === 'q8.start' && o.variant === v).map(([, o]) => o);
        if (!rs.length) continue;
        const c = rs.map((o) => o.checkMs).filter((x) => typeof x === 'number');
        const l1 = rs.map((o) => o.load1);
        console.log(`${v}: starts ${rs.length}, refused ${rs.filter((o) => o.refused).length} ${JSON.stringify(count(rs.filter((o) => o.refused).map((o) => `${o.content?.why} ${(o.content?.off || []).join(',')}`)))}; check ${med(c).toFixed(1)} (${Math.round(Math.min(...c))}-${Math.round(Math.max(...c))}); load ${Math.min(...l1)}-${Math.max(...l1)}`);
    }
}
