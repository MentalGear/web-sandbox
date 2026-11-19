// Reads the .jsonl files of results/ and prints, per engine and variant, how many runs opened a tab and the figures
// the README quotes.
//   node docs/research/30_links_popup/summarize.mjs docs/research/30_links_popup/results/*.jsonl
import { readFileSync } from 'node:fs';

const rows = [];
const runs = [];
for (const file of process.argv.slice(2)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        const entry = JSON.parse(line);
        if (entry.kind === 'run') runs.push({ file, ...entry });
        else rows.push({ file, ...entry });
    }
}

for (const run of runs) console.log(`# ${run.file.split('/').pop()}: ${run.engine} ${run.version}, ${run.headed ? 'headed' : 'headless'}, ${run.date}`);

const groups = new Map();
for (const row of rows) {
    const key = `${row.file.split('/').pop().replace('.jsonl', '')} | ${row.engine ?? ''} | ${row.variant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
}

const list = (values) => values.join('/');
console.log('\nfile | engine | variant | runs | opened (hits>0) | tabs event agrees | per click: opens that landed | opens called | activation at request | sinceClick ms (min-max) | errors | isActive false at request (runs) | ... of which opened');
for (const [key, group] of groups) {
    const results = group.filter((r) => r.kind === 'result');
    const errors = group.filter((r) => r.kind === 'error').length;
    const opened = results.filter((r) => r.hits > 0).length;
    const agree = results.filter((r) => (r.hits > 0) === (r.tabs > 0)).length;
    // per click: how many of that click's opens landed (the hits are cumulative n values)
    const perClick = [];
    for (const r of results) {
        const landed = [];
        let seen = 0;
        for (const click of r.afterClick) {
            landed.push(click.hits.length - seen);
            seen = click.hits.length;
        }
        perClick.push(list(landed));
    }
    const calls = results.map((r) => r.opens.length);
    const active = results.map((r) => (r.request[0] ? (r.request[0].isActive ? 'A' : 'a') : '-'));
    const since = results.flatMap((r) => r.opens.map((o) => o.sinceClick)).filter((v) => v != null);
    const range = since.length ? `${Math.min(...since)}-${Math.max(...since)}` : '';
    // navigator.userActivation.isActive read false when the request reached the host, and whether the tab opened all the same
    const unseen = results.filter((r) => r.request[0] && !r.request[0].isActive);
    const unseenOpened = unseen.filter((r) => r.hits > 0).length;
    console.log(`${key} | ${results.length} | ${opened} of ${results.length} | ${agree} of ${results.length} | ${perClick.join(' ')} | ${calls.join(' ')} | ${active.join('')} | ${range} | ${errors} | ${unseen.length} | ${unseenOpened}`);
}
