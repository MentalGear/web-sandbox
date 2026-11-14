// Runs one probe of research 26 on one engine, under the machine's shared browser lock, and writes its output to
// results/<probe>-<engine>[-<part>].txt. From the repository root:
//
//   INTERP_DIR=… PLAYWRIGHT_BROWSERS_PATH=… bun docs/research/26_interpreter_logic_tier/run.mjs q2 webkit cpu
//
// Probes: q1 (policy), q2 (stopping; parts cpu, watchdog), q3 (memory), q4 (cost), q5 (flood), q6 (reach, boundary).
// The lock (/home/user/.cache/web-sandbox-e2e.lock, or WEB_SANDBOX_LOCK) is taken for one probe on one engine at a time.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES, loadavg } from './lib.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PROBES = { q1: 'q1-policy.mjs', q2: 'q2-stop.mjs', q3: 'q3-memory.mjs', q4: 'q4-cost.mjs', q5: 'q5-flood.mjs', q6: 'q6-reach.mjs' };
const [probe, engine, ...rest] = process.argv.slice(2);
if (!(probe in PROBES) || !(engine in ENGINES)) throw new Error('usage: run.mjs <q1..q6> <chromium|firefox|webkit> [part …]');
const lock = process.env.WEB_SANDBOX_LOCK ?? '/home/user/.cache/web-sandbox-e2e.lock';
mkdirSync(path.join(dir, 'results'), { recursive: true });
const name = [probe, engine, ...rest.filter((a) => !/^\d+$/.test(a))].join('-');
console.error(`${name}: waiting for the lock (load ${loadavg()})`);
const child = Bun.spawn(['flock', lock, 'timeout', '1200', 'bun', path.join(dir, PROBES[probe]), engine, ...rest], { stdout: 'pipe', stderr: 'inherit' });
const out = await new Response(child.stdout).text();
await child.exited;
writeFileSync(path.join(dir, 'results', `${name}.txt`), out);
console.error(`${name}: done (load ${loadavg()}), ${out.split('\n').filter(Boolean).length} lines`);
