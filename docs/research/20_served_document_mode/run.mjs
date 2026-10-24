// Runs the probes of research 20 one after another (never in parallel: q4 measures timers) and writes each one's output
// to results/. From the repository root:
//
//   bun docs/research/20_served_document_mode/run.mjs               # q1, q2, q3, q5 on the three engines, then q4 (both builds, 5 reps)
//   bun docs/research/20_served_document_mode/run.mjs q3 firefox    # one probe, one engine
//
// Each probe is also runnable on its own (see its header). The machine should be quiet: q4 waits while the 1-minute load
// average is above 6.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES, load1 } from './lib.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PROBES = {
    q1: 'q1-service-worker.mjs',
    q2: 'q2-coep.mjs',
    q3: 'q3-frame-ancestors.mjs',
    q4: 'q4-processes.mjs',
    q5: 'q5-side.mjs',
};
const args = process.argv.slice(2);
const only = args.filter((a) => a in PROBES);
const passthrough = args.filter((a) => !(a in PROBES));
const engines = passthrough.filter((a) => a in ENGINES);
mkdirSync(path.join(dir, 'results'), { recursive: true });

for (const key of only.length ? only : ['q1', 'q2', 'q3', 'q5', 'q4']) {
    const probeArgs = key === 'q4' ? passthrough.filter((a) => !(a in ENGINES)) : engines;
    console.error(`${key}: ${PROBES[key]} ${probeArgs.join(' ')} (load ${load1()})`);
    const p = Bun.spawn(['bun', path.join(dir, PROBES[key]), ...probeArgs], { stdout: 'pipe', stderr: 'inherit' });
    const out = await new Response(p.stdout).text();
    await p.exited;
    writeFileSync(path.join(dir, 'results', `${key}${engines.length ? '-' + engines.join('-') : ''}.txt`), out);
}
