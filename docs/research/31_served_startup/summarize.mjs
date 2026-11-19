// Prints the compact view the README's tables were read from.
//
//   bun docs/research/31_served_startup/summarize.mjs <results file>...
import { readFileSync } from 'node:fs';

function main() {
for (const file of process.argv.slice(2)) {
    console.log(`# ${file}`);
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const sp = line.indexOf(' ');
        const tag = line.slice(0, sp);
        let o;
        try { o = JSON.parse(line.slice(sp + 1)); } catch { continue; }
        if (tag === 'q3.case') {
            const ch = (x) => (!x ? 'no answer' : `${x.check?.clean ? 'clean' : 'SEEN'} foreign=${x.check?.foreign} dup=${x.check?.duplicates} off=[${(x.check?.off || []).join('; ')}] gates=[${(x.gates || []).join(',')}]`);
            console.log(`${o.i} ${o.case}\n   end=${o.end} decision=${JSON.stringify(o.decision)}\n   C: ${ch(o.C)}\n   W: ${o.W ? `started=${o.W.started} ` : ''}${ch(o.W)}`);
            if (o.guest && typeof o.guest === 'object') console.log(`   guest C events: ${(o.guest.Cevents || []).filter((e) => !/enforce/.test(e) || true).length} | W events: ${(o.guest.Wevents || []).length}`);
        } else if (tag === 'q3.reports') {
            console.log(`   [${o.i}] reports total=${o.total} startup=${o.startup} guest=${o.guest} ${JSON.stringify(o.byDoc)}`);
            const guest = o.reports.filter((r) => r.guestMarker).map((r) => `${r.dir} ${docKind(r.doc)} ${r.blocked}${r.sample ? ' sample=' + r.sample : ''}`);
            if (guest.length) console.log(`      guest: ${guest.join(' | ')}`);
            const refs = [...new Set(o.reports.map((r) => r.referrer).filter(Boolean))];
            if (refs.length) console.log(`      referrers: ${refs.join(' ')}`);
            const samples = [...new Set(o.reports.filter((r) => !r.guestMarker && r.sample).map((r) => r.sample.slice(0, 30)))];
            if (samples.length) console.log(`      start-up samples: ${samples.join(' | ')}`);
        } else if (tag === 'q4w' && o.R) {
            console.log(`[${o.connect}] ${o.case}`);
            for (const k of ['C', 'WC']) console.log(`    ${realm(o.R[k], k, o)}`);
            console.log(`    F: guard=${o.R.F?.guard} C frame ${o.R.F?.childFrame}; server saw: ${(o.requests ?? []).map((q) => `${q.q}${q.cookie ? ' {' + q.cookie + '}' : ''}`).join('; ') || '-'}`);
        } else if (tag === 'q5') {
            const a = o.attacker || {}, n = a.navigated || {}, r = n.reach || n.reachAtNavigation || {};
            const e = (a.log || []).filter((x) => x.evil).map((x) => x.evil).join(' + ');
            const h = typeof o.host === 'string' ? o.host : `loads ${o.host.loads.length}, verdict from ${o.host.verdictFrom}, ${o.host.end}`;
            console.log(`${o.shape} | ${o.when} | H.length ${r.hostLength}, F ${r.fWindow} | ${n.result}${n.at != null ? ' at ' + n.at + ' ms' : ''} | E: ${e || '-'} | host: ${h}`);
        } else if (tag === 'q2.mutant') {
            console.log(`${o.case} | ${o.end} | gates: ${o.gatesTripped.join(',') || '-'} | policy: ${o.policyTripped.join(',') || '-'}`);
        } else if (tag === 'q1.case') {
            const s = o.seen;
            console.log(`${o.case} | end=${s.end} | decision=${JSON.stringify(s.decision)} | hello=${s.hello} | loads=${JSON.stringify(s.loads.map((l) => l.length))} | hostViolations=${s.hostViolations.length} | fetch=${JSON.stringify(o.fetchedByHost)}${o.widget ? ' | widget got ' + JSON.stringify(o.widget) : ''}${o.intruderGot ? ' | intruder got ' + JSON.stringify(o.intruderGot) : ''}${s.verdict?.ignored?.length ? ' | C ignored ' + s.verdict.ignored : ''}`);
        } else if (tag.endsWith('.run') || tag === 'q1.cost' || tag.endsWith('.error')) console.log(line.slice(0, 600));
        else console.log(line.slice(0, 400));
    }
}
}
// research 28's rule for what a realm reached (its summarize.mjs), for the twelve ways of Q4b
const REACHED = {
    cookieRead: (v) => /^reads host/.test(v), cookieWrite: (v) => v === 'written', localStorage: (v) => v === 'host value',
    sessionStorage: (v) => v === 'accessible', parentDocument: (v) => v === 'readable', topDocument: (v) => v === 'readable',
    openerDocument: (v) => v === 'readable', indexedDB: (v) => v === 'opened', indexedDBHost: (v) => v === 'lists hostdb',
    caches: (v) => /^has hostcache|^opened/.test(v), storageEstimate: (v) => v === 'answers', opfs: (v) => v === 'directory',
    serviceWorker: (v) => /^[1-9]\d* registrations/.test(v), locks: (v) => v === 'answers', permission: (v) => v === 'granted',
    fetch: (v) => /^read/.test(v), xhr: (v) => /^read/.test(v),
};
function realm(r, kind, line) {
    if (!r || typeof r !== 'object') return `${kind}: ${JSON.stringify(r)}`;
    const reached = [];
    for (const [k, test] of Object.entries(REACHED)) if (k in r && test(r[k])) reached.push(k === 'caches' && r[k].startsWith('opened') ? 'caches(own)' : k);
    for (const [where, from] of Object.entries(line.broadcast ?? {})) if (from.includes(kind)) reached.push(`broadcast->${where}`);
    for (const q of line.requests ?? []) if (q.q.endsWith(`=${kind}`) && q.cookie) reached.push(`${q.q.split('=')[0]} sent cookie {${q.cookie}}`);
    return `${kind} ${r.origin === 'null' ? 'opaque' : 'REAL ' + r.origin}${r.secure ? '' : ' (not secure)'}: ${reached.length ? reached.join(' ') : '-'}`;
}
function docKind(d) { return !d ? 'none' : d.startsWith('about') ? 'C' : d.startsWith('blob') ? 'W' : d.includes('/f') ? 'F' : d; }
main();
