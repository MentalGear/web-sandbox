// Runs every probe of research 34, each under the machine's shared lock, and writes each run's output to
// results/<set>/<run>.txt (the set: WEB_SANDBOX_RESULTS_SET, default today's date and Playwright's version). From the
// repository root, after `bun run build:lib` and build-site.mjs:
//
//   WEB_SANDBOX_LOCK=/path/to/lock bun docs/research/34_non_http_host/run.mjs [run ...]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PLAN = [
    ...['chromium', 'firefox', 'webkit'].flatMap((e) => [[`http-${e}`, ['probe.mjs', e, 'http']], [`file-${e}`, ['probe.mjs', e, 'file']]]),
    ['file-chromium-full', ['probe.mjs', 'chromium-full', 'file']],
    ['file-chromium-allowfile', ['probe.mjs', 'chromium-allowfile', 'file']],
    ['file-firefox-fileorigin', ['probe.mjs', 'firefox-fileorigin', 'file']],
    ['extension-chromium', ['probe-ext.mjs']],
    ['extension-hash-load', ['probe-ext-load.mjs', 'hash']],
    ['electron', ['probe-electron.mjs'], ['xvfb-run', '-a']],
];
const only = process.argv.slice(2);
const lock = process.env.WEB_SANDBOX_LOCK;
const set = process.env.WEB_SANDBOX_RESULTS_SET ?? `${new Date().toISOString().slice(0, 10)}_pw-${JSON.parse(readFileSync(path.join(dir, '../../../node_modules/playwright/package.json'), 'utf8')).version}`;
const outDir = path.join(dir, 'results', set);
mkdirSync(outDir, { recursive: true });
for (const [name, [file, ...args], wrap = []] of PLAN) {
    if (only.length && !only.includes(name)) continue;
    const cmd = [...wrap, 'bun', path.join(dir, file), ...args];
    const full = lock ? ['flock', lock, 'timeout', '900', ...cmd] : cmd;
    console.error(name);
    const p = Bun.spawn(full, { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    await p.exited;
    writeFileSync(path.join(outDir, `${name}.txt`), out + (err.trim() ? `\n# stderr\n${err}` : ''));
}
