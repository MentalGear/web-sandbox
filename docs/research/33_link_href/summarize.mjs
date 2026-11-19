// Prints research 33's results compactly: per trial, or (`--table`) per configuration, layout and case, how many
// trials had a connection to the listed site in each phase, and what it was.
//
//   node docs/research/33_link_href/summarize.mjs [--table] <file.jsonl>…
//
// A connection is filed under the phase in whose window it was accepted. Its form: `tcp` (no bytes), `tls` (a
// ClientHello with the listed name, nothing after it), `GET /path [purpose]` (the request inside). The `click` column is
// the positive control: a trial whose click reached nothing means the recorder did not see that engine's traffic.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const table = args.includes('--table');
const files = args.filter((a) => !a.startsWith('--'));
const PHASES = ['before', 'load', 'render', 'scroll', 'hover', 'tab', 'focus', 'press', 'drag', 'touch', 'context', 'click', 'end'];

const form = (c) => {
    if (c.http && c.http.length) return c.http.map((h) => `${h.method} ${h.path}${h.purpose ? ` [${h.purpose}]` : ''}${h.ping ? ' [ping]' : ''}${h.phase !== c.phase ? ` (sent in ${h.phase})` : ''}`).join('+');
    return c.sni ? 'tls' : 'tcp';
};

const rows = [];
for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (line.startsWith('r33.run ')) { const r = JSON.parse(line.slice(8)); if (!table) console.log(`# ${r.config} ${r.version} ${r.headed ? 'headed' : 'headless'} via ${r.via} load ${r.load1}`); rows.push({ run: r }); continue; }
        if (line.startsWith('r33.error ')) { console.log(line.slice(0, 300)); continue; }
        if (!line.startsWith('r33 ')) continue;
        const r = JSON.parse(line.slice(4));
        rows.push(r);
        if (table) continue;
        const per = {};
        for (const c of r.listed) (per[c.phase] ??= []).push(`${c.host === 'own' ? '' : `${c.host} `}${form(c)}`);
        for (const b of r.bare) (per[b.phase] ??= []).push(`bare(${b.kinds.join(',')})`);
        const reached = (r.diag ?? []).map((d) => `${d[3]}:${d[0]}`);
        const missing = [];
        if (!reached.includes('hover:pointerover') && r.phases.some((p) => p[0] === 'hover')) missing.push('hover');
        if (r.notes?.tabFocused === false) missing.push('tab');
        if (!reached.includes('click:click')) missing.push('click');
        console.log(`${r.layout.padEnd(6)} ${r.case.padEnd(18)} t${r.trial} ${PHASES.filter((p) => per[p]).map((p) => `${p}: ${per[p].join(' ')}`).join(' | ') || 'nothing'}${r.pages.length ? ` pages ${r.pages.join(',')}` : ''} popups ${r.popups}${r.notes?.navs?.length ? ` navs ${r.notes.navs.map((n) => `${n[0]}@${n[2]}`).join(',')}` : ''}${missing.length ? ` NOT REACHED ${missing.join(',')}` : ''}`);
    }
}

if (table) {
    const groups = new Map();
    let run = null;
    for (const r of rows) {
        if (r.run) { run = r.run; continue; }
        const key = `${run.config}${run.headed ? ' headed' : ''}${run.real ? ' real' : ''}${run.persistent === false ? ' context' : ''}${run.hold && run.hold !== 1000 ? ` hold ${run.hold}` : ''} via ${run.via}${run.only ? ` only ${run.only}` : ''} | ${r.layout} | ${r.case}`;
        if (!groups.has(key)) groups.set(key, { n: 0, phases: {}, forms: {}, click: 0 });
        const g = groups.get(key);
        g.n++;
        const seen = new Set();
        for (const c of [...r.listed, ...r.bare.map((b) => ({ ...b, bare: true }))]) {
            const k = c.phase;
            const fm = c.bare ? 'bare' : form(c);
            (g.forms[k] ??= new Set()).add(fm);
            if (!seen.has(k)) { g.phases[k] = (g.phases[k] ?? 0) + 1; seen.add(k); }
        }
        if (r.listed.some((c) => c.phase === 'click' || c.phase === 'end')) g.click++;
    }
    for (const [key, g] of groups) {
        const before = PHASES.filter((p) => p !== 'click' && p !== 'end' && g.phases[p]).map((p) => `${p} ${g.phases[p]}/${g.n} (${[...g.forms[p]].join(', ')})`);
        console.log(`${key} | n ${g.n} | before the click: ${before.join('; ') || 'nothing'} | click control ${g.click}/${g.n}${g.forms.click ? ` (${[...g.forms.click].join(', ')})` : ''}`);
    }
}
