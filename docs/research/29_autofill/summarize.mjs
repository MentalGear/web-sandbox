// Prints the compact view of research 29's raw results that the README's tables were read from: per case, form kind and
// variant, which seeded values script in the form's document read at each step (plain cases), or which reached the
// guest's worker and at which step (case e).
// Usage: bun summarize.mjs <results file> [<results file> ...]
import { readFileSync } from 'node:fs';

const short = (list) => (list.length ? list.join(',') : '-');

for (const file of process.argv.slice(2)) {
    console.log(`== ${file}`);
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const space = line.indexOf(' ');
        if (space < 0) continue;
        const tag = line.slice(0, space);
        const data = JSON.parse(line.slice(space + 1));
        if (tag === 'plain.run' || tag === 'lib.run') {
            console.log(`${tag} ${data.engine} ${data.version} ${data.origin} headless=${data.headless} enable=${short(data.enableFeatures ?? [])} disable=${short(data.disableFeatures ?? [])} allow=${data.allow ?? ''}`);
            continue;
        }
        if (tag === 'plain.case') {
            const marked = (step) => {
                const fields = data[step].fields;
                const star = (fields.match(/\*/g) ?? []).length;
                return `${short(data[step].leaked)}${star ? ` (${star}*)` : ''}`;
            };
            console.log([
                `${data.case}/${data.kind}/${data.variant}${data.allow ? `/allow=${data.allow}` : ''}`,
                `load=${marked('load')}`, `focus=${marked('focus')}`, `arrow=${marked('arrow')}`, `chosen=${marked('chosen')}`,
                `events=${data.events.withSeededValue}/${data.events.trustedInputOrChange}`,
            ].join('  '));
            continue;
        }
        if (tag === 'lib.case') {
            const steps = [];
            for (const [step, row] of Object.entries(data.byStep)) steps.push(`${step}=${row.withSeeded}/${row.events}${row.seeded.length ? `[${row.seeded.join(',')}]` : ''}`);
            const first = data.firstLeak ? `${data.firstLeak.step}:${data.firstLeak.type}:${data.firstLeak.target?.id}` : '-';
            console.log(`e/${data.kind}/${data.variant}  first=${first}  ${steps.join('  ')}  shown: ${data.shownAtEnd.slice(0, 100)}`);
        }
    }
}
