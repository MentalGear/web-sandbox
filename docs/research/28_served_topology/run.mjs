// Runs the probes of research 28, one probe, part and engine per run, and writes each run's output to
// results/<set>/<probe>[-<parts>]-<engine>.txt. From the repository root:
//
//   bun docs/research/28_served_topology/run.mjs                       # everything
//   bun docs/research/28_served_topology/run.mjs q1 firefox            # one probe, one engine
//   bun docs/research/28_served_topology/run.mjs q4a webkit            # Q1's cases with the file on another site
//   WEB_SANDBOX_LOCK=/path/to/lock bun docs/research/28_served_topology/run.mjs   # each run under flock(1)
//
// Results go to results/<set>/, the set named by WEB_SANDBOX_RESULTS_SET (default: today's date and the installed
// Playwright's version, e.g. 2026-11-15_pw-1.65.1); earlier sets stay beside it. q3 and q4b measure time: run them on a
// quiet machine (each records the load average with every case).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ALL = ['chromium', 'firefox', 'webkit'];
const PLAN = [
    ['q1', 'q1-trampoline.mjs', [], ALL],
    ['q4a', 'q1-trampoline.mjs', ['file-at-ip'], ALL],
    ['q2', 'q2-constant-policy.mjs', [], ALL],
    ['q3', 'q3-channel.mjs', [], ALL],
    ['q4p', 'q4-policy.mjs', [], ALL],
    ['q4b', 'q4-thread.mjs', [], [...ALL, 'chromium-full']],
    ['q1s', 'q1-trampoline.mjs', ['static'], ALL],
    ['q1g', 'q1-trampoline.mjs', ['guarded'], ALL],
    ['q7', 'q7-gates.mjs', [], ALL],
    ['q6', 'q6-spike.mjs', [], ALL],
];
const args = process.argv.slice(2);
const onlyQ = args.filter((a) => PLAN.some(([q]) => q === a));
const onlyE = args.filter((a) => [...ALL, 'chromium-full'].includes(a));
const lock = process.env.WEB_SANDBOX_LOCK;
const set = process.env.WEB_SANDBOX_RESULTS_SET ?? `${new Date().toISOString().slice(0, 10)}_pw-${JSON.parse(readFileSync(path.join(dir, '../../../node_modules/playwright/package.json'), 'utf8')).version}`;
const outDir = path.join(dir, 'results', set);
mkdirSync(outDir, { recursive: true });

for (const [q, file, fixed, engines] of PLAN) {
    if (onlyQ.length && !onlyQ.includes(q)) continue;
    for (const engine of engines) {
        if (onlyE.length && !onlyE.includes(engine)) continue;
        const cmd = ['bun', path.join(dir, file), engine, ...fixed];
        const full = lock ? ['flock', lock, 'timeout', '1200', ...cmd] : cmd;
        console.error(`${q} ${engine}`);
        const p = Bun.spawn(full, { stdout: 'pipe', stderr: 'pipe' });
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        await p.exited;
        writeFileSync(path.join(outDir, `${q}-${engine}.txt`), out + (err.trim() ? `\n# stderr\n${err}` : ''));
    }
}
