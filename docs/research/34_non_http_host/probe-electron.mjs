// Research 34 in an Electron app shell (electron/main.cjs): the host page on file:, on the app's own standard, secure
// scheme app:, and on http (the baseline), in one window with Electron's default webPreferences. Electron is installed
// in electron/ with its own package.json (`cd docs/research/34_non_http_host/electron && bun install && node
// node_modules/electron/install.js`); the container has no display, so the run goes under Xvfb. From the repository
// root, after build-site.mjs:
//
//   xvfb-run -a bun docs/research/34_non_http_host/probe-electron.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright';
import { emit } from '../28_served_topology/lib.mjs';
import { libPagesAt, runHost } from './drive.mjs';
import { startStatic } from './server.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(dir, 'site');
const srv = await startStatic(site);
const electronApp = await _electron.launch({
    executablePath: path.join(dir, 'electron/node_modules/electron/dist/electron'),
    args: ['--no-sandbox', path.join(dir, 'electron/main.cjs')],
    env: { ...process.env, R34_SITE: site, NODE_OPTIONS: '' },
});
const versions = await electronApp.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
emit('r34x.run', { engine: 'electron', version: `Electron ${versions.electron} (Chromium ${versions.chrome})`, date: new Date().toISOString() });
const page = await electronApp.firstWindow();

const fileBase = pathToFileURL(path.join(site, 'app')).href;
const KINDS = [
    { kind: 'electron file: host', base: fileBase, extraTargets: [{ name: 'own:../outside.txt', url: pathToFileURL(path.join(site, 'outside.txt')).href, kind: 'txt' }] },
    { kind: 'electron app: host', base: 'app://bundle', extraTargets: [{ name: 'file:secret.txt (another scheme)', url: `${fileBase}/secret.txt`, kind: 'txt' }] },
    { kind: 'electron http host', base: `${srv.local}/app`, extraTargets: [] },
];
for (const { kind, base, extraTargets } of KINDS) {
    try {
        await runHost(page, 'r34x', kind, { hostUrl: `${base}/host.html`, base, srv, extraTargets, libPages: libPagesAt(base) });
    } catch (e) {
        emit('r34x.error', { kind, error: String(e).slice(0, 400) });
    }
}
await electronApp.close();
await srv.close();
process.exit(0);
