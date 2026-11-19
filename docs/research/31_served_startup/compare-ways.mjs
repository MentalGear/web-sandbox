// Compares Q4b's twelve ways (F and C with allow-forms) with research 28's static and guarded files (without it), cell
// by cell: per engine, case and policy, C's and its worker's origin and what of an origin's authority each reached, by
// research 28's rule (summarize.mjs's REACHED). Prints the cells that differ, and the cases one set has and the other not.
//
//   bun docs/research/31_served_startup/compare-ways.mjs [set]
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const set = process.argv[2] ?? '2026-11-18_pw-1.65.1';
const R28 = path.join(here, '../28_served_topology/results/2026-11-15_pw-1.65.1');
const REACHED = {
    cookieRead: (v) => /^reads host/.test(v), cookieWrite: (v) => v === 'written', localStorage: (v) => v === 'host value',
    sessionStorage: (v) => v === 'accessible', parentDocument: (v) => v === 'readable', topDocument: (v) => v === 'readable',
    openerDocument: (v) => v === 'readable', indexedDB: (v) => v === 'opened', indexedDBHost: (v) => v === 'lists hostdb',
    caches: (v) => /^has hostcache|^opened/.test(v), storageEstimate: (v) => v === 'answers', opfs: (v) => v === 'directory',
    serviceWorker: (v) => /^[1-9]\d* registrations/.test(v), locks: (v) => v === 'answers', permission: (v) => v === 'granted',
    fetch: (v) => /^read/.test(v), xhr: (v) => /^read/.test(v),
};
// the case's label without the flags that differ between the two sets
const key = (label) => label.replaceAll(' allow-forms', '');
function cells(file, tag) {
    const out = new Map();
    if (!existsSync(file)) return out;
    for (const text of readFileSync(file, 'utf8').split('\n')) {
        const m = /^(\S+) (\{.*\})$/.exec(text);
        if (!m || m[1] !== tag) continue;
        const line = JSON.parse(m[2]);
        if (!line.R) continue;
        for (const k of ['C', 'WC']) {
            const r = line.R[k];
            const reached = [];
            if (r && typeof r === 'object') for (const [n, test] of Object.entries(REACHED)) if (n in r && test(r[n])) reached.push(n);
            for (const [where, from] of Object.entries(line.broadcast ?? {})) if (from.includes(k)) reached.push(`broadcast->${where}`);
            for (const q of line.requests ?? []) if (q.q.endsWith(`=${k}`) && q.cookie) reached.push(`cookie:${q.cookie}`);
            out.set(`${line.connect} | ${key(line.case)} | ${k}`, r && typeof r === 'object' ? `${r.origin === 'null' ? 'opaque' : 'REAL'} ${reached.sort().join(' ')}` : String(r));
        }
    }
    return out;
}
for (const [mine, theirs] of [['q4w', 'q1s'], ['q4g', 'q1g']]) {
    for (const e of ['chromium', 'firefox', 'webkit']) {
        const a = cells(path.join(here, 'results', set, `${mine}-${e}.txt`), 'q4w');
        const b = cells(path.join(R28, `${theirs}-${e}.txt`), 'q1');
        const diff = [];
        for (const [k, v] of a) if (b.has(k) && b.get(k) !== v) diff.push(`${k}: research 28 "${b.get(k)}" -> now "${v}"`);
        const onlyA = [...a.keys()].filter((k) => !b.has(k));
        const onlyB = [...b.keys()].filter((k) => !a.has(k));
        const opaque = [...a.values()].every((v) => v.startsWith('opaque') || v === 'undefined');
        console.log(`${mine} vs research 28 ${theirs}, ${e}: ${a.size} cells, ${diff.length} differ; C and worker opaque in every cell: ${opaque}`);
        for (const d of diff) console.log(`   ${d}`);
        if (onlyA.length) console.log(`   ${onlyA.length} cells only here: ${onlyA.join("; ")}`);
        if (onlyB.length) console.log(`   ${onlyB.length} cells only in research 28`);
    }
}
