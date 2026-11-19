// Prints the Markdown tables of the README's Q3 from a results set: per header, what the check saw in C and in the
// worker on each engine, and the reports at the endpoint by document (F / C / W) with the guest's among them.
//
//   bun docs/research/31_served_startup/tables.mjs <set>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results', process.argv[2] ?? '2026-11-18_pw-1.65.1');
const ENGINES = ['chromium', 'firefox', 'webkit'];
const read = (e) => readFileSync(path.join(dir, `q3-${e}.txt`), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]).filter(([t]) => t.startsWith('q3.')).map(([t, j]) => [t, JSON.parse(j)]);
const data = Object.fromEntries(ENGINES.map((e) => [e, read(e)]));
const cases = data.chromium.filter(([t]) => t === 'q3.case').map(([, o]) => o);

const realm = (x) => {
    if (!x) return 'no answer';
    if (x.started && x.started !== 'yes') return `not started (${x.started})`;
    if (!x.check) return '?';
    if (x.check.clean) return 'clean';
    const why = [];
    if (x.check.foreign) why.push(`${x.check.foreign} foreign`);
    if (x.check.duplicates) why.push('twin 2');
    if (x.check.off && x.check.off.length) why.push(x.check.off.map((o) => o.split(':')[0]).join('+') + ' off');
    return `**seen** (${why.join(', ')})`;
};
const cell = (e, i) => {
    const o = data[e].find(([t, v]) => t === 'q3.case' && v.i === i)?.[1];
    if (!o) return '-';
    return o.end === 'no answer in 5000 ms' ? 'no answer (C never ran)' : `C ${realm(o.C)} · W ${realm(o.W)}`;
};
const reps = (e, i) => {
    const o = data[e].find(([t, v]) => t === 'q3.reports' && v.i === i)?.[1];
    if (!o) return '-';
    const by = { F: 0, C: 0, W: 0 };
    for (const r of o.reports) by[!r.doc ? 'F' : r.doc.startsWith('about') ? 'C' : r.doc.startsWith('blob') ? 'W' : 'F']++;
    // a guest report carries its marker, or (a frame or object load, whose path Chromium and Firefox drop) the guest's .invalid origin
    const g = o.reports.filter((r) => r.guestMarker || String(r.blocked).includes('leak.invalid')).map((r) => (r.guestMarker ? r.dir : `${r.dir} (origin only)`)).join(', ');
    return `${by.F}/${by.C}/${by.W}${g ? ` (guest: ${g})` : ''}`;
};
console.log('| # | Header on F | ' + ENGINES.join(' | ') + ' |');
console.log('| ---: | :--- | :--- | :--- | :--- |');
for (const o of cases) console.log(`| ${o.i} | ${o.case.replaceAll('|', '\\|')} | ${ENGINES.map((e) => cell(e, o.i)).join(' | ')} |`);
console.log('\n| # | Reports F/C/W ' + ENGINES.map((e) => `| ${e}`).join(' ') + ' |');
console.log('| ---: | :--- | :--- | :--- |');
for (const o of cases) console.log(`| ${o.i} | ${ENGINES.map((e) => reps(e, o.i)).join(' | ')} |`);
for (const e of ENGINES) console.log(e, JSON.stringify(data[e].find(([t]) => t === 'q3.reportingControl')?.[1]));
