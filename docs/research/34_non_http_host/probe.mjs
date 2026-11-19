// Research 34 on a browser: the host page on http (the baseline) and on file:, per engine. From the repository root,
// after build-site.mjs:
//
//   bun docs/research/34_non_http_host/probe.mjs <engine> <http|file>
//
// Engines: chromium (headless shell), chromium-full (new headless, the build the extension runs on), firefox, webkit,
// and two positive controls for file: reach: chromium-allowfile (--allow-file-access-from-files) and
// firefox-fileorigin (security.fileuri.strict_origin_policy off).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { emit, emitRun } from '../28_served_topology/lib.mjs';
import { libPagesAt, runHost } from './drive.mjs';
import { startStatic } from './server.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(dir, 'site');
const LAUNCH = {
    chromium: [chromium, {}],
    'chromium-full': [chromium, { channel: 'chromium' }],
    'chromium-allowfile': [chromium, { args: ['--allow-file-access-from-files'] }],
    firefox: [firefox, {}],
    'firefox-fileorigin': [firefox, { firefoxUserPrefs: { 'security.fileuri.strict_origin_policy': false } }],
    webkit: [webkit, {}],
};
const [engine, kind] = process.argv.slice(2);
if (!(engine in LAUNCH) || !['http', 'file'].includes(kind)) { console.error('usage: probe.mjs <engine> <http|file>'); process.exit(2); }

const srv = await startStatic(site);
const [type, options] = LAUNCH[engine];
const browser = await type.launch(options);
emitRun('r34', engine, browser);
const page = await (await browser.newContext()).newPage();
const base = kind === 'file' ? pathToFileURL(path.join(site, 'app')).href : `${srv.local}/app`;
const extraTargets = kind === 'file' ? [{ name: 'own:../outside.txt', url: pathToFileURL(path.join(site, 'outside.txt')).href, kind: 'txt' }] : [];
try {
    await runHost(page, 'r34', `${kind} host`, { hostUrl: `${base}/host.html`, base, srv, extraTargets, libPages: libPagesAt(base) });
} catch (e) {
    emit('r34.error', { engine, kind, error: String(e).slice(0, 400) });
}
emit('r34.requests', { engine, kind, requests: srv.requests.map((r) => `${r.path} origin=${r.origin} dest=${r.dest}`).slice(0, 80) });
await browser.close();
await srv.close();
process.exit(0);
