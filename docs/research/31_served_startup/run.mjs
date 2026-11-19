// Runs the probes of research 31, one probe and engine per run, and writes each run's output to
// results/<set>/<probe>-<engine>.txt. From the repository root:
//
//   bun docs/research/31_served_startup/run.mjs                       # everything
//   bun docs/research/31_served_startup/run.mjs q3 webkit             # one probe, one engine
//   WEB_SANDBOX_LOCK=/path/to/lock bun docs/research/31_served_startup/run.mjs   # each run under flock(1)
//
// Results go to results/<set>/, the set named by WEB_SANDBOX_RESULTS_SET (default: today's date and the installed
// Playwright's version). q1 measures time: run it on a quiet machine (it records the load average).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ALL = ['chromium', 'firefox', 'webkit'];
const PLAN = [
    ['q1', 'q1-order.mjs', []],
    ['q1b', 'q1-insecure.mjs', []],
    ['q2', 'q2-gates.mjs', []],
    ['q3', 'q3-policy.mjs', []],
    ['q3b', 'q3-report-sources.mjs', []],
    ['q4', 'q4-flags.mjs', []],
    ['q4w', 'q4-ways.mjs', ['static']],
    ['q4g', 'q4-ways.mjs', ['guarded']],
    ['q5', 'q5-framed-host.mjs', []],
    ['q6', 'q6-refused-canaries.mjs', []],
    ['q7', 'q7-view-first.mjs', []],
    ['q8a', 'q8-check-timing.mjs', ['A']],
    ['q8b', 'q8-check-timing.mjs', ['B']],
];
const args = process.argv.slice(2);
const onlyQ = args.filter((a) => PLAN.some(([q]) => q === a));
const onlyE = args.filter((a) => ALL.includes(a));
const lock = process.env.WEB_SANDBOX_LOCK;
const set = process.env.WEB_SANDBOX_RESULTS_SET ?? `${new Date().toISOString().slice(0, 10)}_pw-${JSON.parse(readFileSync(path.join(dir, '../../../node_modules/playwright/package.json'), 'utf8')).version}`;
const outDir = path.join(dir, 'results', set);
mkdirSync(outDir, { recursive: true });

for (const [q, file, fixed] of PLAN) {
    if (onlyQ.length && !onlyQ.includes(q)) continue;
    for (const engine of ALL) {
        if (onlyE.length && !onlyE.includes(engine)) continue;
        const cmd = ['bun', path.join(dir, file), engine, ...fixed];
        const full = lock ? ['flock', lock, 'timeout', '1500', ...cmd] : cmd;
        console.error(`${q} ${engine}`);
        const p = Bun.spawn(full, { stdout: 'pipe', stderr: 'pipe' });
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        await p.exited;
        writeFileSync(path.join(outDir, `${q}-${engine}.txt`), out + (err.trim() ? `\n# stderr\n${err}` : ''));
    }
}
