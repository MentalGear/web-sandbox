// Runs the probes of research 27, one probe and engine per run (each probe runs all its parts unless parts are named),
// and writes each run's output to results/<probe>[-<parts>]-<engine>.txt. From the repository root:
//
//   bun docs/research/27_served_document_headerless/run.mjs                    # everything (about 15 minutes on a quiet machine)
//   bun docs/research/27_served_document_headerless/run.mjs q3 firefox         # one probe, one engine
//   bun docs/research/27_served_document_headerless/run.mjs q1 framesrc webkit # one part of a probe
//   WEB_SANDBOX_LOCK=/path/to/lock bun docs/research/27_served_document_headerless/run.mjs   # each run under flock(1)
//
// Results go to results/<set>/, the set named by WEB_SANDBOX_RESULTS_SET (default: today's date and the installed
// Playwright's version, e.g. 2026-11-15_pw-1.65.1); earlier sets stay beside it.
//
// On a shared machine set WEB_SANDBOX_LOCK: each run then waits for the lock on its own, so other users of the machine
// get a turn between runs. q6 measures timers: run it on a quiet machine (it records the load average with each case).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ALL = ['chromium', 'firefox', 'webkit'];
const PLAN = [
    ['q1', 'q1-meta-policy.mjs', ['inherit', 'framesrc', 'ignored'], ALL],
    ['q2', 'q2-wrong-way.mjs', [], ALL],
    ['q3', 'q3-outside-policy.mjs', [], ALL],
    ['q4', 'q4-inherited.mjs', ['secure', 'perms', 'coi', 'referrer'], ALL],
    ['q5', 'q5-hosting.mjs', ['headers', 'file', 'cache', 'sw'], ALL],
    ['q6', 'q6-thread.mjs', [], ['firefox', 'webkit']],
];
const args = process.argv.slice(2);
const onlyQ = args.filter((a) => PLAN.some(([q]) => q === a));
const onlyE = args.filter((a) => ALL.includes(a));
const lock = process.env.WEB_SANDBOX_LOCK;
const set = process.env.WEB_SANDBOX_RESULTS_SET ?? `${new Date().toISOString().slice(0, 10)}_pw-${JSON.parse(readFileSync(path.join(dir, '../../../node_modules/playwright/package.json'), 'utf8')).version}`;
const outDir = path.join(dir, 'results', set);
mkdirSync(outDir, { recursive: true });

for (const [q, file, known, engines] of PLAN) {
    if (onlyQ.length && !onlyQ.includes(q)) continue;
    const parts = args.filter((a) => known.includes(a));
    for (const engine of engines) {
        if (onlyE.length && !onlyE.includes(engine)) continue;
        const cmd = ['bun', path.join(dir, file), engine, ...parts];
        const full = lock ? ['flock', lock, 'timeout', '900', ...cmd] : cmd;
        console.error(`${q} ${parts.join(' ')} ${engine}`);
        const p = Bun.spawn(full, { stdout: 'pipe', stderr: 'pipe' });
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        await p.exited;
        writeFileSync(path.join(outDir, `${q}${parts.length ? '-' + parts.join('-') : ''}-${engine}.txt`), out + (err.trim() ? `\n# stderr\n${err}` : ''));
    }
}
