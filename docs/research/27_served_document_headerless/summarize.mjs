// Prints a compact view of the raw result lines in results/ (one line per document per case), the view the README's
// tables were written from. Reads only results/; runs no browser.
//
//   bun docs/research/27_served_document_headerless/summarize.mjs [file-prefix]
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const prefix = process.argv[2] ?? '';
const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.txt')).sort();

const viols = (v) => {
    if (!Array.isArray(v) || !v.length) return '-';
    const by = {};
    for (const x of v) (by[x.policy] ??= []).push(`${x.dir}${x.disp === 'report' ? '(report)' : ''}`);
    return Object.entries(by).map(([p, ds]) => `${p}:[${[...new Set(ds)].join(',')}]`).join(' ');
};
const doc = (d) => {
    if (!d || typeof d !== 'object') return String(d);
    const a = d.act ? Object.entries(d.act).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    const w = d.worker && typeof d.worker === 'object' ? ` | worker: eval=${d.worker.eval} fetch=${d.worker.fetch} canary=${d.worker.fetchCanary} viol=${viols(d.worker.viol)}${d.worker.perms ? ' perms=' + JSON.stringify(d.worker.perms) : ''} secure=${d.worker.secure}` : d.worker ? ` | worker: ${d.worker}` : '';
    return `${d.kind ?? ''} origin=${d.origin} ${a} viol=${viols(d.viol)}${w}`;
};

for (const f of files) {
    console.log(`== ${f}`);
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        const m = /^(\S+) (\{.*\})$/.exec(line);
        if (!m) continue;
        const o = JSON.parse(m[2]);
        if (m[1].endsWith('.run')) { console.log(`   ${o.engine} ${o.version} ${o.date} load ${o.load1}`); continue; }
        console.log(`-- ${o.engine} | ${o.case ?? ''}`);
        if (o.docs) for (const d of o.docs) console.log(`     ${doc(d)}`);
        if (o.reports) {
            const by = {};
            for (const r of o.reports) (by[r.from] ??= []).push(r.dir);
            console.log(`     reports: ${JSON.stringify(by)}  hostViolations: ${viols(o.hostViolations)}  loads: ${JSON.stringify(o.frameLoadEvents ?? '')}`);
        }
        const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !['engine', 'case', 'docs', 'reports', 'hostViolations', 'frameLoadEvents', 'console', 'part'].includes(k)));
        if (Object.keys(rest).length) console.log(`     ${JSON.stringify(rest).slice(0, 600)}`);
    }
}
