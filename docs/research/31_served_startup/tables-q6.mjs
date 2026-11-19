// Prints the Markdown tables of the README's Q6 from a results set: per canary, what the <meta> alone raised and whether
// the positive control reached the server; per header, which canary saw it on each engine and what a guest's URL made
// the browser report; the cost.
//
//   bun docs/research/31_served_startup/tables-q6.mjs <set>
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANARIES } from './canaries.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results', process.argv[2] ?? '2026-11-19_pw-1.65.1');
const ENGINES = ['chromium', 'firefox', 'webkit'];
const read = (e) => (!existsSync(path.join(dir, `q6-${e}.txt`)) ? [] : readFileSync(path.join(dir, `q6-${e}.txt`), 'utf8').split('\n').filter((l) => l.startsWith('q6.')).map((l) => [l.slice(0, l.indexOf(' ')), JSON.parse(l.slice(l.indexOf(' ') + 1))]));
const data = Object.fromEntries(ENGINES.map((e) => [e, read(e)]));
const get = (e, tag, f = () => true) => data[e].filter(([t, o]) => t === tag && f(o)).map(([, o]) => o);

// 1. the baseline: per refused canary, the events under the <meta> alone (case 0) and the control's hit
const kinds = [];
for (const c of CANARIES) if (c.kind !== 'admitted') kinds.push(c);
console.log('| Canary (realm, directive) | ' + ENGINES.join(' | ') + ' |');
console.log('| :--- | :--- | :--- | :--- |');
const formKinds = ['form-submit', 'form-click'];
for (const c of [...kinds, { key: 'form-click', realm: 'C', dir: 'form-action', kind: 'refused' }]) {
    const cells = ENGINES.map((e) => {
        const base = get(e, 'q6.case', (o) => o.i === 0)[0];
        const ctl = get(e, 'q6.control')[0];
        if (!base || !ctl) return '-';
        const ids = c.kind === 'refused' ? ['http', 'https'].map((s) => `${c.key} ${s}`) : [`${c.realm} ${c.dir} data`, `${c.realm} ${c.dir} blob`, `${c.realm} ${c.dir} eval`];
        const parts = [];
        for (const id of ids) {
            const es = base.per[id];
            if (!es && c.kind !== 'refused') continue;
            const n = es ? es.length : 0;
            const meta = es ? es.every((x) => x.includes(' enforce META ')) : true;
            const hit = c.kind === 'refused' ? (ctl.hits.some((h) => h.includes(`${c.key}.canary.invalid`) && (id.endsWith('https') ? h.startsWith('CONNECT') : h.startsWith('GET'))) ? 'control hit' : 'control: no request') : '';
            parts.push(`${c.kind === 'refused' ? id.split(' ')[1] + ': ' : ''}${n} event${n === 1 ? '' : 's'}${n && !meta ? ' (not all the <meta>)' : ''}${hit ? ', ' + hit : ''}`);
        }
        const out = (base.outcomes || {})[c.kind === 'refused' ? `${c.key} http` : c.key] ?? ((base.W && base.W.out) || {})[c.kind === 'refused' ? `${c.key} http` : c.key];
        const form = formKinds.includes(c.key) ? Object.entries(base.forms || {}).filter(([k]) => k.startsWith(c.key)).map(([k, f]) => `${k.split(' ')[1]}: C ${f.alive ? 'stays' : 'gone (' + f.cUrl.split(' | ')[1] + ')'}`).join('; ') : '';
        return `${parts.join('; ') || 'no event'}${out ? ` · outcome: ${out}` : ''}${form ? ` · ${form}` : ''}`;
    });
    console.log(`| \`${c.key}\` (${c.realm}, ${c.dir}) | ${cells.join(' | ')} |`);
}

// 2. per header: seen by the admitted canaries, by a refused one, or unseen; and what a guest's URL made the browser report
// what a guest's URL made the browser do: R (a report at the endpoint) with the full URL or its origin; E (an event only)
const guestCell = (o) => {
    const carry = (b) => (b.includes('GUEST-SECRET') ? 'full URL' : b.includes('leak.invalid') ? 'origin' : 'scheme');
    const rep = [...new Set(o.reports.guest.map((r) => carry(r.blocked)))];
    if (rep.length) return `R ${rep.join(', ')}`;
    const ev = [...new Set(o.guest.foreign.map((x) => carry(x)))];
    return ev.length ? `E ${ev.join(', ')}` : '–';
};
// The verdict, read from `per` against the baseline (case 0) of the same engine. Q3's canaries (the admitted loads, the
// refused fetch(blob:) and eval) are the "admitted" set; every canary.invalid URL and the data: worker are refused
// canaries. (The probe's own `verdict` field files the data: worker with Q3's set; this reading does not.)
const isRefused = (id) => !/^[CW] /.test(id) || id.includes('worker-src data');
const isMetaOnly = (x) => x.includes(' enforce META ');
const WANT = { 'img-blob': 'loaded', 'style-blob': 'load', 'worker-blob': 'ran', 'fetch-blob': 'refused TypeError', eval: 'refused' };
const WANT_W = { 'w-fetch-blob': 'refused TypeError', 'w-eval': 'refused' };
function verdict(e, o) {
    const base = get(e, 'q6.case', (x) => x.i === 0)[0].per;
    const ids = new Set([...Object.keys(base), ...Object.keys(o.per)]);
    const refused = [];
    let admitted = false;
    for (const id of ids) {
        if (id.startsWith('form-') && !Object.keys(o.forms || {}).length) continue; // the forms ran only where the header names form-action
        const es = o.per[id] || [];
        const differs = es.length !== (base[id] || []).length || !es.every(isMetaOnly);
        if (!differs) continue;
        if (isRefused(id)) refused.push(id.replace(/^[CW] worker-src data$/, (m) => `${m[0] === 'W' ? 'w-' : ''}worker-data`));
        else admitted = true;
    }
    for (const [k, v] of Object.entries(WANT)) if ((o.outcomes || {})[k] !== v) admitted = true;
    for (const [k, v] of Object.entries(WANT_W)) if (!o.W || o.W.started !== 'yes' || o.W.out[k] !== v) admitted = true;
    return { admitted, refused: [...new Set(refused)] };
}
export { verdict };
const cases = get('chromium', 'q6.case');
console.log('\n| # | Header on F | Chromium | Firefox | WebKit |');
console.log('| ---: | :--- | :--- | :--- | :--- |');
for (const c0 of cases) {
    const cells = ENGINES.map((e) => {
        const o = get(e, 'q6.case', (x) => x.i === c0.i)[0];
        if (!o || !o.verdict) return o ? o.end : '-';
        const v = verdict(e, o);
        const kinds = [...new Set(v.refused.map((x) => x.split(' ')[0]))];
        const httpOnly = v.refused.some((x) => x.endsWith(' http')) && v.refused.every((x) => !x.endsWith(' https'));
        const by = v.admitted ? 'admitted' : kinds.length > 4 ? `refused (${kinds.length} kinds)` : kinds.length ? `refused: ${kinds.join(', ')}${httpOnly ? ' (http: only)' : ''}` : '**unseen**';
        return `${by} · ${guestCell(o)}`;
    });
    console.log(`| ${c0.i} | ${c0.case.replaceAll('|', '\\|').replaceAll('*', '\\*').replaceAll('<meta>', '`<meta>`')} | ${cells.join(' | ')} |`);
}

// 3. the cost
console.log('\n| Mode | ' + ENGINES.join(' | ') + ' |');
console.log('| :--- | ---: | ---: | ---: |');
for (const m of ['admitted', 'refused', 'both']) {
    console.log(`| ${m} | ${ENGINES.map((e) => { const o = get(e, 'q6.cost', (x) => x.mode === m)[0]; return o ? `${o.end.median} (${o.end.min}–${o.end.max}); last event max ${o.lastEvent.max}` : '-'; }).join(' | ')} |`);
}
for (const e of ENGINES) {
    const o = get(e, 'q6.cost', (x) => x.mode === 'both')[0];
    if (!o) continue;
    const worst = Object.entries(o.perCanary).sort((a, b) => b[1].max - a[1].max).slice(0, 4).map(([k, v]) => `${k} ${v.median}/${v.max}`).join(', ');
    console.log(`${e}: latest canaries (median/max ms) ${worst}; load ${o.load1}; event counts per start ${o.events.join(',')}`);
}
// 4. the reports of the canaries: what their fields carried
for (const e of ENGINES) {
    const all = get(e, 'q6.case').flatMap((o) => (o.reports ? o.reports.canary : []));
    const refs = [...new Set(all.map((r) => JSON.stringify(r.referrer)))];
    const docs = [...new Set(all.map((r) => r.doc))];
    const blocked = [...new Set(all.map((r) => String(r.blocked).replace(/\/\/[a-z-]+\.canary/, '//*.canary').split('?')[0]))];
    console.log(`${e}: canary reports ${all.length}; host query in any: ${all.some((r) => r.hostQuery)}; referrers ${refs.join(' ')}; documents ${docs.join(' ')}; blocked ${blocked.join(' ')}`);
}
