// Research 34 in a Chromium extension's own page: one unpacked MV3 extension per manifest variant of build-site.mjs,
// all loaded into one persistent context of the full Chromium build in new headless mode (the headless shell loads no
// extension). From the repository root, after build-site.mjs:
//
//   bun docs/research/34_non_http_host/probe-ext.mjs
//
// Per variant, the host page is chrome-extension://<id>/host.html. Last, an http host page frames each extension's F
// (web-accessible in the `war` variant only), and its reach probe aims at the extensions' resources.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { emit } from '../28_served_topology/lib.mjs';
import { libPagesAt, runHost } from './drive.mjs';
import { startStatic } from './server.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(dir, 'site');
const ids = JSON.parse(readFileSync(path.join(site, 'ext-ids.json'), 'utf8'));
const exts = Object.keys(ids).map((v) => path.join(site, `ext-${v}`)).join(',');
const srv = await startStatic(site);
const profile = mkdtempSync(path.join(tmpdir(), 'r34-ext-'));
const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${exts}`, `--load-extension=${exts}`],
});
const version = context.browser()?.version() ?? (await (await context.newPage()).evaluate(() => navigator.userAgent));
emit('r34e.run', { engine: 'chromium (full build, new headless)', version, date: new Date().toISOString(), ids });

// what another extension's resources look like to this one's view, web-accessible and not
const crossExtension = [
    { name: 'other-ext:war/secret.txt (web-accessible)', url: `chrome-extension://${ids.war}/war/secret.txt`, kind: 'txt' },
    { name: 'other-ext:secret.txt (not web-accessible)', url: `chrome-extension://${ids.war}/secret.txt`, kind: 'txt' },
];
for (const [variant, id] of Object.entries(ids)) {
    const base = `chrome-extension://${id}`;
    const page = await context.newPage();
    const own = [{ name: 'own:war/secret.txt', url: `${base}/war/secret.txt`, kind: 'txt' }];
    try {
        await runHost(page, 'r34e', `extension (${variant})`, { hostUrl: `${base}/host.html`, base, srv, extraTargets: variant === 'war' ? own : [...own, ...crossExtension], libPages: libPagesAt(base) });
    } catch (e) {
        emit('r34e.error', { variant, error: String(e).slice(0, 400) });
    }
    await page.close();
}

// an http host page that frames the extension's F
{
    const page = await context.newPage();
    const base = `${srv.local}/app`;
    const targets = [
        { name: 'ext:war/secret.txt (web-accessible)', url: `chrome-extension://${ids.war}/war/secret.txt`, kind: 'txt' },
        { name: 'ext:secret.txt (not web-accessible)', url: `chrome-extension://${ids.war}/secret.txt`, kind: 'txt' },
    ];
    const extraCases = [
        { label: "http host frames the war extension's F (web-accessible)", url: `chrome-extension://${ids.war}/F.html`, targets },
        { label: "http host frames the normal extension's F (not web-accessible)", url: `chrome-extension://${ids.normal}/F.html`, targets, timeout: 8000 },
    ];
    try {
        await runHost(page, 'r34e', 'http host in the extension profile', { hostUrl: `${base}/host.html`, base, srv, extraTargets: targets, extraCases });
    } catch (e) {
        emit('r34e.error', { variant: 'http host', error: String(e).slice(0, 400) });
    }
}
await context.close();
await srv.close();
rmSync(profile, { recursive: true, force: true });
process.exit(0);
